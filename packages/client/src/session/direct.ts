/**
 * The direct connection (Whombat hermes-engine.md HE-50; contracts CT-1250…CT-1252, secure-channel SC-12;
 * hermes-engine-app.md AP-5302): the same Noise session as through the relay, on a WebSocket straight to the box —
 * its address on the local network or its Tailscale name.
 *
 *   1. a WebSocket to a route the box reported (`DirectRoute.socket`, `ws://<address>:<port>/v1/direct` or
 *      `wss://<name>:<port>/v1/direct`), subprotocol `whombat-direct.v1`; the client sends `DirectHello`, the box
 *      answers `DirectWelcome`, then only binary messages pass — no ticket, no control;
 *   2. the Noise XX initiator pinned to the box's PeerId (`secureHandshake`): the box admits from the key the handshake
 *      proves (enrolled → `app`, unknown → enrollment, revoked → `revoked`);
 *   3. session frames, as through the relay (`secureWire`).
 *
 * `createDirectConnector` dials the box's routes in order (the one that worked last first), each a moment after the one
 * before rather than after it gave up, uses the first the box answers on, and fails as `offline` when none answers;
 * another box answering at a remembered address is just a route that didn't work (SC-12), never the identity stop.
 * `createRoutedConnector` gives it a head start over the relay: the relay starts beside it after a second, or at once
 * when every route failed, and the first to open is used (docs/app/decisions/open-speed.md).
 */
import {
  DIRECT_CLOSE,
  DIRECT_SUBPROTOCOL,
  type DirectHello,
  parseDirectDownstream,
} from '@whombat/protocol/direct';
import type { DirectRoute } from '@whombat/protocol/session';
import {
  type ByteStreamLike,
  type RelaySocket,
  type RelaySocketFactory,
  relayCloseReason,
  type SecureChannelPort,
  type SecureConnectionLike,
  secureHandshake,
  secureWire,
} from './connector';
import type { DisconnectReason } from './types';
import { ConnectError, type ConnectRequest, type SessionConnector, type WireConnection } from './wire';

export interface DirectConnectorOptions<Identity> {
  /** The routes to try, best first; read on every connection (the box's last `welcome.direct`, `directRoutesFor`). */
  routes: () => readonly DirectRoute[];
  secure: SecureChannelPort<Identity>;
  /** This endpoint's key. */
  identity: () => Promise<Identity>;
  /** The box's identity to pin (full PeerId). */
  appliance: { peerId: string };
  socket?: RelaySocketFactory;
  /**
   * One route's socket open and `hello` → `welcome`. Default 3 s: a box on the same network answers at once, and an
   * address on a network the device has left never does.
   */
  dialTimeoutMs?: number;
  /**
   * The next route is dialed this long after the one before when that one hasn't answered yet (at once when it failed).
   * Default 250 ms: a box on the same network answers well within it, so a working first route opens no other socket,
   * and a silent one doesn't hold up the routes after it for its whole timeout.
   */
  staggerMs?: number;
  /** The Noise handshake after the welcome. Default 10 s. */
  handshakeTimeoutMs?: number;
  /** The route that opened (the next connection tries it first). */
  onRoute?: (route: DirectRoute) => void;
}

/** Why a direct dial ended before the welcome: the next route, then the relay, are tried whatever it was. */
function dialFailure(code: number): ConnectError {
  if (code === DIRECT_CLOSE.rateLimited || code === DIRECT_CLOSE.draining)
    return new ConnectError('busy', 'The Whombat is busy.');
  if (code === DIRECT_CLOSE.forbidden)
    return new ConnectError('offline', 'The Whombat doesn’t take this connection here.');
  return new ConnectError('offline', `The Whombat didn’t answer here (${code}).`);
}

/** After the welcome, close codes mean what the relay's do, except that nothing here is the relay's refusal. */
function directCloseReason(code: number): DisconnectReason {
  if (code === DIRECT_CLOSE.forbidden || code === DIRECT_CLOSE.badHello) return 'lost';
  return relayCloseReason(code).reason;
}

/** Opens the direct socket, says hello and resolves with `wrap(socket)` on the box's welcome (synchronously). */
export function dialDirect<T>(
  socketFactory: RelaySocketFactory,
  request: { url: string; class: 'interactive' | 'bulk'; timeoutMs: number; signal: AbortSignal },
  wrap: (socket: RelaySocket, welcome: { maxMessage: number; heartbeatMs: number }) => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new ConnectError('closed'));
      return;
    }
    let socket: RelaySocket;
    try {
      socket = socketFactory(request.url, DIRECT_SUBPROTOCOL);
    } catch (error) {
      reject(new ConnectError('offline', String(error)));
      return;
    }
    socket.binaryType = 'arraybuffer';
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
      () => fail(new ConnectError('offline', 'The Whombat didn’t answer here.')),
      request.timeoutMs,
    );
    const onAbort = () => fail(new ConnectError('closed'));
    request.signal.addEventListener('abort', onAbort, { once: true });
    const onOpen = () => {
      const hello: DirectHello = { t: 'hello', v: 1, class: request.class };
      socket.send(JSON.stringify(hello));
    };
    const onMessage = (event: { data: unknown }) => {
      if (typeof event.data !== 'string') {
        fail(new ConnectError('offline', 'binary data before the welcome'));
        return;
      }
      const parsed = parseDirectDownstream(event.data);
      if (!parsed.ok) {
        fail(new ConnectError('offline', `bad welcome: ${parsed.error}`));
        return;
      }
      done = true;
      cleanup();
      resolve(wrap(socket, { maxMessage: parsed.value.maxMessage, heartbeatMs: parsed.value.heartbeatMs }));
    };
    const onClose = (event: { code?: number }) => fail(dialFailure(event.code ?? 1006));
    const onError = () => {
      // The close event follows with the code.
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
  });
}

function defaultSocket(url: string, protocol: string): RelaySocket {
  const Ctor = (globalThis as { WebSocket?: new (u: string, p: string) => RelaySocket }).WebSocket;
  if (!Ctor) throw new Error('No WebSocket implementation');
  return new Ctor(url, protocol);
}

/** A route the box welcomed on: its byte stream, ready for the Noise handshake. */
interface Answered {
  route: DirectRoute;
  socket: RelaySocket;
  stream: ByteStreamLike;
}

/** A connector that reaches the box directly, on the first of its routes that answers (the one that worked last first). */
export function createDirectConnector<Identity>(options: DirectConnectorOptions<Identity>): SessionConnector {
  const socketFactory = options.socket ?? defaultSocket;
  const staggerMs = options.staggerMs ?? 250;
  let last: string | null = null;

  /**
   * Dials `routes` in order, each `staggerMs` after the one before or as soon as that one failed, and resolves with the
   * first the box welcomes on; the others are given up. Rejects with the last failure once every route failed.
   */
  function dialFirst(routes: readonly DirectRoute[], request: ConnectRequest): Promise<Answered> {
    return new Promise<Answered>((resolve, reject) => {
      if (request.signal.aborted) {
        reject(new ConnectError('closed'));
        return;
      }
      const tries: AbortController[] = [];
      let next = 0;
      let failed = 0;
      let settled = false;
      let failure = new ConnectError('offline', 'The Whombat didn’t answer.');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
        done();
      };
      const onAbort = () =>
        settle(() => {
          for (const t of tries) t.abort();
          reject(new ConnectError('closed'));
        });
      const start = () => {
        clearTimeout(timer);
        const route = routes[next];
        if (settled || !route) return;
        next += 1;
        const attempt = new AbortController();
        tries.push(attempt);
        dialDirect(
          socketFactory,
          {
            url: route.socket,
            class: request.class,
            timeoutMs: options.dialTimeoutMs ?? 3000,
            signal: attempt.signal,
          },
          (socket, welcome) => ({
            route,
            socket,
            stream: options.secure.byteStream(socket, { maxMessageBytes: welcome.maxMessage }),
          }),
        ).then(
          (answered) => {
            if (settled) {
              answered.socket.close(1000);
              return;
            }
            settle(() => {
              for (const t of tries) if (t !== attempt) t.abort();
              resolve(answered);
            });
          },
          (error: unknown) => {
            if (settled) return;
            failed += 1;
            if (error instanceof ConnectError && error.reason !== 'closed') failure = error;
            if (failed === routes.length) settle(() => reject(failure));
            else start();
          },
        );
        if (next < routes.length) timer = setTimeout(start, staggerMs);
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      start();
    });
  }

  async function handshake(answered: Answered, identity: Identity, request: ConnectRequest) {
    let secure: SecureConnectionLike;
    try {
      secure = await secureHandshake(
        {
          secure: options.secure,
          appliance: options.appliance,
          handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
        },
        identity,
        answered.stream,
        request.signal,
      );
    } catch (error) {
      answered.socket.close(1000);
      // Another box at an address this one had (SC-12): this route doesn't lead to it now.
      if (error instanceof ConnectError && error.reason === 'identity_mismatch')
        throw new ConnectError('offline', 'Another Whombat answered at this address.');
      throw error;
    }
    return secureWire(
      secure,
      options.secure.secureByteStream(secure),
      () => answered.socket,
      directCloseReason,
    );
  }

  return {
    async connect(request: ConnectRequest): Promise<WireConnection> {
      const all = options.routes();
      if (!all.length) throw new ConnectError('offline', 'No way to reach the Whombat directly.');
      let routes = [...all].sort((a, b) => Number(b.socket === last) - Number(a.socket === last));
      const identity = await options.identity();
      // A route whose handshake failed (another box answered there) is dropped and the rest are dialed again.
      for (;;) {
        const answered = await dialFirst(routes, request);
        routes = routes.filter((r) => r !== answered.route);
        try {
          const wire = await handshake(answered, identity, request);
          last = answered.route.socket;
          options.onRoute?.(answered.route);
          return wire;
        } catch (error) {
          if (!(error instanceof ConnectError) || error.reason === 'closed' || !routes.length) throw error;
        }
      }
    },
  };
}

export interface RoutedConnectorOptions {
  /** The box directly (its local network and Tailscale); null where there is no way to try. */
  direct: SessionConnector | null;
  /** Through the relay; null where there is none (the box's own page, development). */
  relay: SessionConnector | null;
  /**
   * The relay starts beside the direct ways when they haven't opened after this long (at once when they all failed).
   * Default 1 s: the box on the same network opens in a few hundred milliseconds, and a phone away from it shouldn't
   * wait for every address it can't reach.
   */
  relayAfterMs?: number;
  /**
   * After the direct ways failed, or the relay opened first, the relay is used without trying them again for this long.
   * Default 60 s.
   */
  directPauseMs?: number;
  now?: () => number;
  /** Which way the last connection went (for the connection strip and diagnostics). */
  onWay?: (way: 'direct' | 'relay') => void;
}

/**
 * Direct first, with a head start over the relay. A direct failure is never the session's ending by itself — the relay
 * is tried — except for answers only the box gives (revoked, not enrolled, too old), which the relay would give too.
 * While the direct ways don't open they are left alone for `directPauseMs`, so each reconnect doesn't wait for them
 * first.
 */
export function createRoutedConnector(options: RoutedConnectorOptions): SessionConnector {
  const now = options.now ?? Date.now;
  const pauseMs = options.directPauseMs ?? 60_000;
  const relayAfterMs = options.relayAfterMs ?? 1000;
  let directPausedAt: number | null = null;

  /** Direct and the relay, the relay `relayAfterMs` later: the first to open is used, the other given up. */
  function race(
    direct: SessionConnector,
    relay: SessionConnector,
    request: ConnectRequest,
  ): Promise<WireConnection> {
    return new Promise<WireConnection>((resolve, reject) => {
      if (request.signal.aborted) {
        reject(new ConnectError('closed'));
        return;
      }
      const directTry = new AbortController();
      const relayTry = new AbortController();
      let settled = false;
      let directFailed = false;
      let relayStarted = false;
      let relayFailure: unknown = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
        done();
      };
      const onAbort = () =>
        settle(() => {
          directTry.abort();
          relayTry.abort();
          reject(new ConnectError('closed'));
        });
      const startRelay = () => {
        clearTimeout(timer);
        if (settled || relayStarted) return;
        relayStarted = true;
        relay.connect({ class: request.class, signal: relayTry.signal }).then(
          (wire) => {
            if (settled) {
              wire.close('closed');
              return;
            }
            // The direct ways hadn't opened: they don't hold up the next connections either.
            directPausedAt = now();
            settle(() => {
              directTry.abort();
              options.onWay?.('relay');
              resolve(wire);
            });
          },
          (error: unknown) => {
            if (settled) return;
            relayFailure = error;
            if (directFailed) settle(() => reject(error));
          },
        );
      };
      direct.connect({ class: request.class, signal: directTry.signal }).then(
        (wire) => {
          if (settled) {
            wire.close('closed');
            return;
          }
          directPausedAt = null;
          settle(() => {
            relayTry.abort();
            options.onWay?.('direct');
            resolve(wire);
          });
        },
        (error: unknown) => {
          if (settled) return;
          if (!(error instanceof ConnectError)) {
            settle(() => {
              relayTry.abort();
              reject(error);
            });
            return;
          }
          directFailed = true;
          directPausedAt = now();
          if (relayFailure) settle(() => reject(relayFailure));
          else startRelay();
        },
      );
      timer = setTimeout(startRelay, relayAfterMs);
      request.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  return {
    async connect(request: ConnectRequest): Promise<WireConnection> {
      const { direct, relay } = options;
      const tryDirect = direct && (!relay || directPausedAt === null || now() - directPausedAt >= pauseMs);
      if (direct && tryDirect && relay) return race(direct, relay, request);
      if (direct && tryDirect) {
        const wire = await direct.connect(request);
        options.onWay?.('direct');
        return wire;
      }
      if (!relay) throw new ConnectError('offline', 'No way to reach the Whombat.');
      const wire = await relay.connect(request);
      options.onWay?.('relay');
      return wire;
    },
  };
}
