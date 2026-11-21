/**
 * `createManagedConnector` — how a managed session gets a connection (MA-05…MA-08, AP-12):
 *
 *   1. a short-lived admission ticket from control (`tickets`), never put in a URL;
 *   2. a relay WebSocket (`wss://relay…/v1/connect`, subprotocol `whombat-relay.v1`): the ticket travels in the
 *      first message (`hello`), the relay answers `welcome`, then `ready` once the appliance joined; after
 *      that only binary messages flow and the relay forwards them unmodified;
 *   3. the Noise XX initiator of `@whombat/secure-channel` over those bytes, pinned to the appliance identity
 *      from the claim card / enrollment — nothing is sent before the pin is checked;
 *   4. session frames (MA-08) as the secure connection's messages.
 *
 * Step 3 uses `@whombat/secure-channel` (contracts 0.3) through the `secure` port, step 4 `@whombat/protocol`'s
 * frame codec; this module never implements cryptography. The relay dial follows `@whombat/protocol/relay`.
 */

import type { Frame } from '@whombat/protocol/frame';
import {
  parseRelayDownstream,
  RELAY_CLOSE,
  RELAY_SUBPROTOCOL,
  type RelayHello,
} from '@whombat/protocol/relay';
import type { DisconnectReason } from './types';
import {
  ConnectError,
  type ConnectRequest,
  encodeFrame,
  frameReader,
  type SessionConnector,
  type WireConnection,
} from './wire';

/* Ports -------------------------------------------------------------------------------------------------- */

export interface Ticket {
  ticket: string;
  /** `wss://…/v1/connect` of the assigned relay worker. */
  relayUrl: string;
}

/**
 * Control issues a ticket for this appliance; throws `TicketDeniedError` when it won't for this person, and
 * `ApplianceRefusedError` when it won't for this Whombat (AP-693). Anything else is “offline”, and retried.
 */
export type TicketSource = (request: {
  channel: 'app' | 'enroll';
  class: 'interactive' | 'bulk';
  /** Giving up a connection also cancels its admission request. Never sent to control in the body. */
  signal?: AbortSignal;
}) => Promise<Ticket>;

/** Control said no (signed out, not a member, org suspended). Terminal until someone signs in again. */
export class TicketDeniedError extends Error {
  override name = 'TicketDeniedError';
}

/**
 * Control admits no connection to this Whombat for this organization (`tickets.client` → 404, AP-693), and the
 * directory said how it stands: retired (for good), unlisted (retried: not yet, or not any more) or gone (unlisted for
 * too long). `reason` is the session's.
 */
export class ApplianceRefusedError extends Error {
  override name = 'ApplianceRefusedError';
  constructor(
    readonly reason: 'appliance_retired' | 'appliance_unlisted' | 'appliance_gone',
    message: string,
  ) {
    super(message);
  }
}

/** What a ticket source's failure means for the session: control's refusals by name, anything else “offline”. */
export function ticketConnectError(error: unknown): ConnectError {
  if (error instanceof TicketDeniedError) return new ConnectError('ticket_denied', error.message);
  if (error instanceof ApplianceRefusedError) return new ConnectError(error.reason, error.message);
  return new ConnectError('offline', 'Couldn’t reach Whombat.');
}

/** The subset of the WHATWG WebSocket the relay dial uses (browser, React Native, Node `ws`). */
export interface RelaySocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  // biome-ignore lint/suspicious/noExplicitAny: event shapes differ between browser, RN and ws
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: event shapes differ between browser, RN and ws
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
}

export type RelaySocketFactory = (url: string, protocol: string) => RelaySocket;

/** What `@whombat/secure-channel`'s `openInitiator` returns (structural). */
export interface SecureConnectionLike {
  readonly remotePeerId: string;
  readonly rekeyRequired: boolean;
  close(): Promise<void>;
  abort(reason?: Error): void;
}

/** The library's `ByteStream` (structural): what `webSocketByteStream` and `secureByteStream` return. */
export interface ByteStreamLike {
  read(): Promise<Uint8Array | null>;
  write(chunk: Uint8Array): boolean;
  drained(): Promise<void>;
  close(): Promise<void>;
  abort(reason: Error): void;
}

/** The secure-channel functions the connector needs (from `@whombat/secure-channel`, contracts 0.3). */
export interface SecureChannelPort<Identity> {
  /** Wrap an OPEN relay socket (after `ready`) as the library's byte stream. Called synchronously. */
  byteStream(socket: RelaySocket, options: { maxMessageBytes: number }): ByteStreamLike;
  openInitiator(options: {
    stream: ByteStreamLike;
    identity: Identity;
    expectedAppliancePeerId?: string;
    expectedApplianceFingerprint?: string;
  }): Promise<SecureConnectionLike>;
  /** The plaintext byte stream of an established connection (chunked into Noise records underneath). */
  secureByteStream(connection: SecureConnectionLike): ByteStreamLike;
}

export interface ManagedConnectorOptions<Identity> {
  tickets: TicketSource;
  secure: SecureChannelPort<Identity>;
  /** This endpoint's key (browser: non-extractable WebCrypto key from IndexedDB; mobile: secure store). */
  identity: () => Promise<Identity>;
  /** The appliance identity to pin: full PeerId (preferred) or the claim card fingerprint. */
  appliance: { peerId: string } | { fingerprint: string };
  /** `app` for enrolled endpoints, `enroll` for claim, pairing and recovery. */
  channel: 'app' | 'enroll';
  socket?: RelaySocketFactory;
  /** Admission, including a directory lookup after a refusal, must finish within this. Default 15 s. */
  ticketTimeoutMs?: number;
  /** Relay `hello` → `ready` must complete within this. Default 15 s. */
  dialTimeoutMs?: number;
  /** The Noise handshake after `ready` must complete within this (open-speed.md AP-4402). Default 15 s. */
  handshakeTimeoutMs?: number;
}

/* Relay protocol v1 (outer, MA-05) ------------------------------------------------------------------------ */

export { RELAY_SUBPROTOCOL };

/** Close codes (MA-05) → why, and whether to retry. */
export function relayCloseReason(code: number): { reason: DisconnectReason; detail: string } {
  switch (code) {
    case RELAY_CLOSE.badTicket:
    case RELAY_CLOSE.replayedTicket:
      // Expired or replayed ticket: a fresh ticket fixes it.
      return { reason: 'lost', detail: 'admission ticket refused' };
    case RELAY_CLOSE.forbidden:
      return { reason: 'ticket_denied', detail: 'this origin or role may not connect' };
    case RELAY_CLOSE.applianceOffline:
    case RELAY_CLOSE.applianceDidNotJoin:
      return { reason: 'appliance_offline', detail: 'the appliance is not connected' };
    case RELAY_CLOSE.rateLimited:
    case RELAY_CLOSE.draining:
      return { reason: 'busy', detail: 'the relay is busy' };
    case RELAY_CLOSE.slowConsumer:
      return { reason: 'lost', detail: 'too slow' };
    default:
      return { reason: 'lost', detail: `closed (${code})` };
  }
}

/**
 * Opens the relay WebSocket, authenticates with the ticket in the first message and resolves with `wrap(socket)`
 * called synchronously on `ready` (so no binary message can be missed).
 */
export function dialRelay<T>(
  socketFactory: RelaySocketFactory,
  request: {
    url: string;
    ticket: string;
    class: 'interactive' | 'bulk';
    timeoutMs: number;
    signal: AbortSignal;
  },
  wrap: (socket: RelaySocket, welcome: { maxMessage: number; heartbeatMs: number }) => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Given up before the dial (the other attempt of a race won while the ticket came): no socket at all.
    if (request.signal.aborted) {
      reject(new ConnectError('closed'));
      return;
    }
    let socket: RelaySocket;
    try {
      socket = socketFactory(request.url, RELAY_SUBPROTOCOL);
    } catch (error) {
      reject(new ConnectError('offline', String(error)));
      return;
    }
    socket.binaryType = 'arraybuffer';
    let welcome: { maxMessage: number; heartbeatMs: number } | null = null;
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
    };
    const fail = (error: ConnectError) => {
      if (done) return;
      done = true;
      cleanup();
      try {
        socket.close(1000);
      } catch {
        // gone
      }
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new ConnectError('offline', 'The relay did not answer.')),
      request.timeoutMs,
    );
    const onAbort = () => fail(new ConnectError('closed'));
    request.signal.addEventListener('abort', onAbort, { once: true });
    const onOpen = () => {
      const hello: RelayHello = { t: 'hello', v: 1, ticket: request.ticket, class: request.class };
      socket.send(JSON.stringify(hello));
    };
    const onMessage = (event: { data: unknown }) => {
      if (typeof event.data !== 'string') {
        fail(new ConnectError('lost', 'binary data before ready'));
        return;
      }
      const parsed = parseRelayDownstream(event.data);
      if (!parsed.ok) {
        fail(new ConnectError('lost', `bad relay message: ${parsed.error}`));
        return;
      }
      const m = parsed.value;
      if (m.t === 'welcome') {
        welcome = { maxMessage: m.maxMessage, heartbeatMs: m.heartbeatMs };
        return;
      }
      if (m.t === 'ready' && welcome) {
        done = true;
        cleanup();
        resolve(wrap(socket, welcome));
        return;
      }
      fail(new ConnectError('lost', `unexpected relay message ${m.t}`));
    };
    const onClose = (event: { code?: number; reason?: string }) => {
      const code = event.code ?? 1006;
      const mapped = relayCloseReason(code);
      let retryAfterMs: number | undefined;
      try {
        const parsed = event.reason ? (JSON.parse(event.reason) as { retryAfterMs?: number }) : null;
        if (typeof parsed?.retryAfterMs === 'number') retryAfterMs = parsed.retryAfterMs;
      } catch {
        // plain-text reason
      }
      fail(
        new ConnectError(code === 1006 && !welcome ? 'offline' : mapped.reason, mapped.detail, retryAfterMs),
      );
    };
    const onError = () => {
      // The close event follows with the code.
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
  });
}

/* The connector ------------------------------------------------------------------------------------------ */

export function createManagedConnector<Identity>(
  options: ManagedConnectorOptions<Identity>,
): SessionConnector {
  const socketFactory: RelaySocketFactory =
    options.socket ??
    ((url, protocol) => {
      const Ctor = (globalThis as { WebSocket?: new (u: string, p: string) => RelaySocket }).WebSocket;
      if (!Ctor) throw new Error('No WebSocket implementation');
      return new Ctor(url, protocol);
    });

  return {
    async connect(request: ConnectRequest): Promise<WireConnection> {
      const ticket = await admissionTicket(options, request);
      const identity = await options.identity();
      let socketRef: RelaySocket | null = null;
      const stream = await dialRelay(
        socketFactory,
        {
          url: ticket.relayUrl,
          ticket: ticket.ticket,
          class: request.class,
          timeoutMs: options.dialTimeoutMs ?? 15_000,
          signal: request.signal,
        },
        (socket, welcome) => {
          socketRef = socket;
          return options.secure.byteStream(socket, { maxMessageBytes: welcome.maxMessage });
        },
      );
      let secure: SecureConnectionLike;
      try {
        secure = await secureHandshake(options, identity, stream, request.signal);
      } catch (error) {
        (socketRef as RelaySocket | null)?.close(1000);
        throw error;
      }
      return secureWire(secure, options.secure.secureByteStream(secure), () => socketRef);
    },
  };
}

/** A silent HTTP request must not outlive an attempt, even when a ticket source ignores cancellation. */
function admissionTicket(
  options: Pick<ManagedConnectorOptions<unknown>, 'tickets' | 'channel' | 'ticketTimeoutMs'>,
  request: ConnectRequest,
): Promise<Ticket> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new ConnectError('closed'));
      return;
    }
    const controller = new AbortController();
    let done = false;
    const finish = (complete: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = () =>
      finish(() => {
        controller.abort();
        reject(new ConnectError('closed'));
      });
    const timer = setTimeout(
      () =>
        finish(() => {
          controller.abort();
          reject(new ConnectError('offline', 'Whombat’s service did not answer.'));
        }),
      options.ticketTimeoutMs ?? 15_000,
    );
    request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      options.tickets({ channel: options.channel, class: request.class, signal: controller.signal }).then(
        (ticket) => finish(() => resolve(ticket)),
        (error: unknown) => finish(() => reject(ticketConnectError(error))),
      );
    } catch (error) {
      finish(() => reject(ticketConnectError(error)));
    }
  });
}

/**
 * The Noise XX initiator over a dialled byte stream, pinned to the appliance (MA-07): resolves with the secure
 * connection, or throws a `ConnectError` — `identity_mismatch` when something else answered (`PEER_MISMATCH`), `lost`
 * for a failed or stuck handshake (AP-4402), `closed` when given up.
 */
export async function secureHandshake<Identity>(
  options: Pick<ManagedConnectorOptions<Identity>, 'secure' | 'appliance' | 'handshakeTimeoutMs'>,
  identity: Identity,
  stream: ByteStreamLike,
  signal: AbortSignal,
): Promise<SecureConnectionLike> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const handshake = options.secure.openInitiator({
      stream,
      identity,
      ...('peerId' in options.appliance
        ? { expectedAppliancePeerId: options.appliance.peerId }
        : { expectedApplianceFingerprint: options.appliance.fingerprint }),
    });
    // A handshake on a stuck path, or one given up (a race won meanwhile), ends here rather than when the far end drops
    // the socket minutes later (AP-4402); closing the socket ends the library's read too.
    return await new Promise<SecureConnectionLike>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new ConnectError('lost', 'The secure handshake took too long.')),
        options.handshakeTimeoutMs ?? 15_000,
      );
      onAbort = () => reject(new ConnectError('closed'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      handshake.then(resolve, reject);
    });
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'PEER_MISMATCH')
      throw new ConnectError('identity_mismatch', 'This isn’t the appliance on the claim card.');
    throw new ConnectError(
      'lost',
      `The secure handshake failed (${code ?? (error as Error)?.message ?? 'unknown'}).`,
    );
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Session frames over a secure connection's byte stream: `[u32 len][u8 type][u32 stream][payload]` (CT-05),
 * written through the plaintext stream (the library chunks it into Noise records) and re-framed with the
 * protocol's `FrameDecoder` on the way in.
 */
export function secureWire(
  connection: SecureConnectionLike,
  bytes: ByteStreamLike,
  socket: () => (RelaySocket & { lastCloseCode?: number }) | null = () => null,
  closeReason: (code: number) => DisconnectReason = (code) => relayCloseReason(code).reason,
): WireConnection {
  const frameListeners: ((f: Frame) => void)[] = [];
  const closeListeners: ((i: { reason: DisconnectReason; detail?: string }) => void)[] = [];
  const read = frameReader();
  let closed = false;
  let sent = 0;
  let congested = false;

  const end = (reason: DisconnectReason, detail?: string) => {
    if (closed) return;
    closed = true;
    for (const l of closeListeners) l({ reason, ...(detail ? { detail } : {}) });
  };

  void (async () => {
    try {
      for (;;) {
        const chunk = await bytes.read();
        if (chunk === null) return end('lost', 'closed by the appliance');
        let frames: Frame[];
        try {
          frames = read(chunk);
        } catch {
          connection.abort(new Error('bad frame'));
          return end('lost', 'malformed frame');
        }
        for (const f of frames) for (const l of frameListeners) l(f);
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'REKEY_REQUIRED') return end('rekey');
      const code = socket()?.lastCloseCode;
      end(code ? closeReason(code) : 'lost');
    }
  })();

  return {
    send(frame) {
      if (closed) throw new Error('closed');
      if (connection.rekeyRequired) {
        end('rekey');
        throw new Error('rekey required');
      }
      const encoded = encodeFrame(frame);
      sent += encoded.byteLength;
      try {
        congested = !bytes.write(encoded);
      } catch (error) {
        end((error as { code?: string }).code === 'REKEY_REQUIRED' ? 'rekey' : 'lost');
        throw error;
      }
    },
    onFrame(listener) {
      frameListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      void connection.close().catch(() => connection.abort());
    },
    bytesSent: () => sent,
    congested: () => congested,
    drained: async () => {
      if (!congested || closed) return;
      await bytes.drained();
      congested = false;
    },
  };
}
