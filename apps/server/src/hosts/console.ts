/**
 * Consoles (contracts CT-350 the session's `console` stream; whombat-hosts
 * docs/WHOMBAT.md §5; one-whombat-servers.md ONE-DH10, one-whombat-consoles.md ONE-DC01…). `hosts.createConsole` opened a
 * session on the hosts service for the person and gave them Whombat's own single-use token. The session's `console`
 * stream reaches it (`openConsoleStream`, called by the session's `open`): the session's person, then
 * `authorizeConsole`, then `opened` once the service's console is connected.
 *
 * `authorizeConsole` is the one rule: the person of the burrow that sees servers redeems the
 * ticket (same person, same session, within 30 s, once). `upstreamConsole` opens the service's console over the unix
 * socket with the service token, the same actor and the service's own subprotocols. Frames go both ways unchanged;
 * either side closing closes the other. A slow reader pauses the service's stream (1 MiB queued toward a session), and
 * a busy service holds back the session's credit.
 */
import { CONSOLE_MAX_MESSAGE_BYTES } from '@whombat/protocol';
import { encodeConsoleMessages } from '@whombat/protocol/console';
import type { StreamSpec } from '@whombat/protocol/session';
import { type RawData, WebSocket } from 'ws';
import { ApiError, forbidden } from '../lib/errors';
import { STREAM_RESET } from '../managed/ports';
import type { OpenedStream, StreamContext } from '../managed/resources';
import { BoundedCollabDecoder, CollabBudget } from '../managed/session/collab-decoder';
import { StreamReset } from '../managed/session/streams';
import type { PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { canManageServers, ONLY_YOU_CHANGE_SERVERS_TEXT } from './person';
import { type ConsoleTicket, HOSTS_TEXT, hostsFor } from './service';

/** The service's own console subprotocols (WHOMBAT.md §5). */
export const UPSTREAM_SUBPROTOCOL = 'rackoon.console.v1';
export const UPSTREAM_TOKEN_PREFIX = 'rackoon.token.';
/** Queued toward a session (waiting for its credit) before the service's stream is paused. */
const SESSION_HIGH_WATER = 1024 * 1024;
/** Waiting for the service's console to connect. */
const UPSTREAM_OPEN_MS = 10_000;

/** The words for a console that can't be opened again with this token (contracts `console_refused`). */
export const CONSOLE_REFUSED_TEXT =
  'This console link was used already or is too old. Open the console again.';

/**
 * Who may open this console (ONE-DH05, ONE-DC02): the burrow sees servers, the caller is the person, and
 * the ticket is theirs, for this session, unused and within its 30 seconds. Throws the refusal in plain words.
 */
export async function authorizeConsole(
  services: Services,
  burrowId: string,
  person: Pick<PrincipalRow, 'id' | 'kind'>,
  sessionId: string,
  token: string,
): Promise<ConsoleTicket> {
  const hosts = hostsFor(services);
  if (!hosts.present || !(await hosts.serves(burrowId)))
    throw new ApiError('unavailable', HOSTS_TEXT.absent, { details: { code: 'hosts_unavailable' } });
  if (!canManageServers(person)) throw forbidden(ONLY_YOU_CHANGE_SERVERS_TEXT);
  const ticket = hosts.redeemConsole(token, burrowId, person.id, sessionId);
  if (!ticket)
    throw new ApiError('forbidden', CONSOLE_REFUSED_TEXT, { details: { code: 'console_refused' } });
  return ticket;
}

/**
 * The service's console for a ticket, connecting (WHOMBAT.md §5: `ws://hosts/api/v1/console/{sid}` over the unix
 * socket, the service token and the ticket's actor, `rackoon.console.v1` + `rackoon.token.<t>`, no compression, no
 * Origin). Null when the service can't be reached at all (no socket configured, no token yet).
 */
export async function upstreamConsole(services: Services, ticket: ConsoleTicket): Promise<WebSocket | null> {
  const client = hostsFor(services).client;
  if (!client) return null;
  let headers: Record<string, string>;
  try {
    headers = await client.headers(ticket.actor);
    delete headers['Accept-Encoding'];
  } catch {
    return null;
  }
  return new WebSocket(
    `ws+unix://${client.socket}:/api/v1/console/${encodeURIComponent(ticket.hostsSessionId)}`,
    [UPSTREAM_SUBPROTOCOL, `${UPSTREAM_TOKEN_PREFIX}${ticket.hostsToken}`],
    {
      headers,
      perMessageDeflate: false,
      maxPayload: CONSOLE_MAX_MESSAGE_BYTES,
      handshakeTimeout: UPSTREAM_OPEN_MS,
    },
  );
}

/** The service's raw socket, to pause reading while the other side catches up. */
function rawSocket(ws: WebSocket): { pause(): void; resume(): void } | undefined {
  return (ws as unknown as { _socket?: { pause(): void; resume(): void } })._socket;
}

/* The session's console stream ------------------------------------------------------------------------------------ */

/** Raw bytes of a `ws` message (binary frames only; the console protocol has no text messages). */
function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Waits until the service's console is connected; refusals in the contract's words (`console_refused`, …). */
function connected(upstream: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const unavailable = () =>
      new ApiError('unavailable', HOSTS_TEXT.down, { details: { code: 'hosts_unavailable' } });
    upstream.once('open', () => resolve());
    upstream.once('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      reject(
        status === 403 || status === 401 || status === 409
          ? new ApiError('forbidden', 'The server turned this console down. Open it again.', {
              details: { code: 'console_refused' },
            })
          : unavailable(),
      );
    });
    upstream.once('error', () => reject(unavailable()));
    upstream.once('close', () => reject(unavailable()));
  });
}

/**
 * A `console` stream (contracts 0.80.1, CT-350): the session's person must be allowed the console
 * (`authorizeConsole`, ONE-DC02); `opened` follows once the service's console is connected (ONE-DC03). DATA both
 * ways carries the console's messages unchanged, each `[u32 len][message]`; credit paces both directions (ONE-DC04).
 * The service closing normally ENDs the stream, anything else RESETs it; the client's END or RESET closes the
 * service's console (ONE-DC05).
 */
export async function openConsoleStream(
  ctx: StreamContext,
  spec: Extract<StreamSpec, { kind: 'console' }>,
  person: Pick<PrincipalRow, 'id' | 'kind'>,
  burrowId: string,
): Promise<OpenedStream> {
  const { services, stream } = ctx;
  const ticket = await authorizeConsole(services, burrowId, person, spec.sessionId, spec.token);
  const upstream = await upstreamConsole(services, ticket);
  if (!upstream)
    throw new ApiError('unavailable', HOSTS_TEXT.down, { details: { code: 'hosts_unavailable' } });
  // Toward the client: messages wait here until `opened` was sent (`run`), then go out as its credit allows.
  const queue: Uint8Array[] = [];
  let queued = 0;
  let paused = false;
  let wake: (() => void) | null = null;
  // The client gave up while the service's console was connecting: no console is left behind.
  let ended = false;
  stream.onReset(() => {
    ended = true;
    upstream.terminate();
    wake?.();
  });
  let upstreamClosed: { code: number } | null = null;
  upstream.on('message', (data: RawData) => {
    if (ended) return;
    const message = bytesOf(data);
    if (message.length === 0) return;
    queue.push(message);
    queued += message.length;
    if (!paused && queued > SESSION_HIGH_WATER) {
      paused = true;
      rawSocket(upstream)?.pause();
    }
    wake?.();
  });
  upstream.on('close', (code) => {
    upstreamClosed = { code };
    wake?.();
  });
  upstream.on('error', () => {
    upstreamClosed ??= { code: 1011 };
    wake?.();
  });

  try {
    await connected(upstream);
  } catch (err) {
    upstream.terminate();
    throw err;
  }
  if (ended) {
    upstream.terminate();
    throw new ApiError('conflict', 'The console was closed while it connected.');
  }

  // From the client: each message to the service unchanged; credit only once the service's socket took it.
  const decoder = new BoundedCollabDecoder(ctx.collabBudget ?? new CollabBudget(), {
    max: CONSOLE_MAX_MESSAGE_BYTES,
    awareness: false,
  });
  stream.onData(async (bytes) => {
    if (ended) return;
    let messages: Uint8Array[];
    try {
      messages = decoder.push(bytes);
    } catch {
      throw new StreamReset(STREAM_RESET.protocolError, 'bad console framing');
    }
    for (const m of messages) if (upstream.readyState === WebSocket.OPEN) upstream.send(m, { binary: true });
    while (upstream.readyState === WebSocket.OPEN && upstream.bufferedAmount > SESSION_HIGH_WATER)
      await new Promise((r) => setTimeout(r, 20));
  });
  const closeUpstream = () => {
    decoder.fail();
    if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, 'closed');
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  };
  stream.onEnd(closeUpstream);
  stream.onReset(() => {
    ended = true;
    queue.length = 0;
    closeUpstream();
    wake?.();
  });

  return {
    meta: { kind: 'console', protocol: ticket.protocol },
    run: async () => {
      for (;;) {
        if (stream.resetCode !== null) return;
        const next = queue.shift();
        if (next) {
          queued -= next.length;
          if (paused && queued < SESSION_HIGH_WATER / 2) {
            paused = false;
            rawSocket(upstream)?.resume();
          }
          try {
            await stream.write(encodeConsoleMessages([next]));
          } catch (err) {
            if (err instanceof StreamReset) return;
            throw err;
          }
          continue;
        }
        const closed = upstreamClosed as { code: number } | null;
        if (closed) {
          // The hub said why in its `closed` control, already sent: a normal end ENDs, a broken socket RESETs.
          if (closed.code === 1000 || closed.code === 1001 || closed.code === 1005) await stream.end();
          else await stream.reset(STREAM_RESET.internal);
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    },
  };
}
