/**
 * The box's direct listener (hermes-engine.md HE-50, HE-51; docs/decisions/direct-connection.md; contracts 1.0.0
 * `@whombat/protocol/direct`, CT-1250): one port on the
 * interfaces the config names (the local network's cards and `tailscale0`; loopback in development). On it:
 *
 * - `DIRECT_PATH` takes a WebSocket (subprotocol `DIRECT_SUBPROTOCOL`): the client's text `hello`, the box's `welcome`,
 *   then binary only — the same Noise XX handshake and session frames as through the relay, handed to the session
 *   endpoint, which admits the client from its Noise static key (`SessionEndpoint.acceptDirect`).
 * - Every other GET is the page for browsers (`web.ts`), only over HTTPS (whombat-link.md LNK-10; DC-19): a plain-HTTP
 *   GET of a page gets one sentence naming the box's HTTPS addresses, no app code and so no software device key. The
 *   loopback page (development, tests) is a secure context in browsers and stays. A plain GET of `DIRECT_PATH` says
 *   which box this is.
 * - The first byte decides the protocol: a TLS ClientHello gets HTTPS with the Tailscale name's certificate (SNI), when
 *   there is one; anything else plain HTTP. One port, both.
 *
 * The same listener, made with `door`, is the box's **own address** (docs/decisions/own-address.md): it opens no port and
 * takes the relay door's `web` streams instead (`acceptDoor`), each a browser's TLS connection that ends here, with the
 * certificate for the box's own host only, HTTP/2 with HTTP/1.1 for the page's WebSocket; `:authority` or Host must be
 * that host (port 443 implied) and a WebSocket's Origin the address itself or none. Its limits are per visitor address
 * as the door saw it, without lockouts.
 *
 * Nothing here is authentication: the Noise session is, end to end. What this layer does is keep the listener to the
 * ways it is for (`network.ts`), keep everyone's use of it bounded (`limits.ts`), and refuse Host and Origin values
 * that aren't this box (DNS rebinding, other sites' pages).
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  createSecureServer as createHttp2Server,
  type Http2SecureServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
} from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, isIP, type Server as NetServer, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { type SecureContext, TLSSocket } from 'node:tls';
import {
  DIRECT_HEARTBEAT_MS,
  DIRECT_HELLO_TIMEOUT_MS,
  DIRECT_MAX_MESSAGE_BYTES,
  type Edition,
} from '@whombat/protocol';
import {
  DIRECT_CLOSE,
  DIRECT_PATH,
  DIRECT_PROTOCOL_VERSION,
  DIRECT_SUBPROTOCOL,
  type DirectHello,
  type DirectIdentity,
  DirectWelcome,
  parseDirectUpstream,
} from '@whombat/protocol/direct';
import type { ByteStream } from '@whombat/secure-channel';
import { nodeWebSocketByteStream } from '@whombat/secure-channel/node';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import type { Logger } from '../../services';
import { DirectGuard } from './limits';
import {
  arrival,
  type DirectArrival,
  type DirectInterfaceSpec,
  type InterfaceTable,
  isLoopbackAddress,
} from './network';
import { type DirectWeb, sendJson, sendText } from './web';

/** Everything the endpoint learns about a direct connection besides its bytes. */
export interface DirectMeta extends DirectArrival {
  /** HTTPS (the Tailscale name's certificate) or plain. */
  tls: boolean;
  /** The page that opened it (`Origin`), or null for a native client. */
  origin: string | null;
  /** Whether that page is a secure context (https, or loopback in development); null for a native client. */
  secureContext: boolean | null;
  hello: DirectHello;
}

/** The own address's side of a listener made for the relay's door (own-address.md). */
export interface DirectDoor {
  /**
   * The hosts a browser can open now (`<name>.whombat.app`): the box's current host and, for a while after a rename or
   * a move, the one it is leaving; each only while its certificate is served. Empty: every TLS handshake fails.
   */
  hosts(): readonly string[];
  /** The certificate for one of those hosts, or null while none is served. */
  context(host: string): SecureContext | null;
  /** Answers some paths before the page (the well-known files); true when it answered. */
  routes?(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  /** The page's Content-Security-Policy as a header, in place of the listener's own. */
  policy: string;
}

/** The own address's HTTP/2 limits (own-address.md). */
export const DOOR_HTTP2 = {
  maxConcurrentStreams: 100,
  maxHeaderListSize: 16 * 1024,
  /** Megabytes per session (Node's unit). */
  maxSessionMemory: 10,
  /** A TLS handshake and then the request's headers each within this. */
  handshakeTimeoutMs: 10_000,
  idleMs: 5 * 60_000,
} as const;

/** What became of a connection after its handshake: a session, a key this box refused, or a failed handshake. */
export type DirectOutcome = 'session' | 'refused' | 'failed';

export type DirectAdmit = 'ok' | 'full' | { draining: number };

export interface DirectListenerOptions {
  port: number;
  /** Bind addresses: `::` (every interface; `network.ts` decides per connection) or loopback ones. */
  hosts: readonly string[];
  interfaces: readonly DirectInterfaceSpec[];
  /** Names this box answers to besides its addresses (its Tailscale names, configured ones). */
  hostnames(): readonly string[];
  /**
   * Other pages that may open the WebSocket: the hosted web app (`managedAppOrigin`), which tries the box's `wss://`
   * Tailscale route before the relay (contracts `directRoutesFor`, `secureOnly`).
   */
  origins?: readonly string[] | (() => readonly string[]);
  /** The box's own PeerId (a plain GET of `DIRECT_PATH`). */
  appliancePeerId: string;
  /** Its edition and whether it is claimed, as the same GET says (`DirectIdentity`, CT-1301); read per request. */
  identity?: () => { edition: Edition; claimed?: boolean | undefined };
  /** Loopback names and origins count (development only). */
  development: boolean;
  /**
   * The box's HTTPS addresses for the page (its own address, its Tailscale name), named to a browser that came over
   * plain HTTP (LNK-10). Absent: no plain-HTTP page at all is said where to go.
   */
  httpsAddresses?: () => readonly string[];
  log: Logger;
  /** Whether a session may start now (capacity, drain). */
  admit(): DirectAdmit;
  /** The Noise handshake, admission and session over the stream; resolves once admission is decided. */
  onStream(stream: ByteStream, meta: DirectMeta): Promise<DirectOutcome>;
  /** The page for browsers; null when this box has no web build. */
  web?: DirectWeb | null;
  /**
   * The one POST this listener takes: a council's picture link (delegate/upload.ts), which answers it and says so;
   * anything else is refused as before.
   */
  posts?: (req: IncomingMessage, res: ServerResponse, path: string) => boolean;
  /** The certificate for a TLS server name (the Tailscale name), or null. */
  tls?: ((servername: string) => Promise<SecureContext | null>) | undefined;
  guard?: DirectGuard;
  /** Tests: the interface table instead of the host's. */
  interfaceTable?: () => InterfaceTable;
  /** Tests: shorter timers. */
  helloTimeoutMs?: number;
  heartbeatMs?: number;
  /** The own address: no port of its own, door streams only (`acceptDoor`). */
  door?: DirectDoor;
}

export interface DirectListenerStatus {
  port: number;
  listening: boolean;
  sockets: number;
  handshakes: number;
  sessions: number;
  stats: DirectGuard['stats'] & { sessions: number; refused: number; failed: number; badHellos: number };
}

const SNIFF_TIMEOUT_MS = 10_000;
/**
 * Sockets are accepted here and handed to the HTTP(S) server by hand, so that server's own no-delay default never
 * reaches them. With Nagle left on, a browser's first byte over HTTPS waited about 40 ms for an ACK the browser holds
 * back; with it off, a millisecond or two.
 */
const NET_OPTIONS = { pauseOnConnect: true, noDelay: true } as const;
/** The interface table is read at most this often (a syscall per connection otherwise). */
const TABLE_TTL_MS = 2_000;

/** `host:port`, `[v6]:port` → the host, lower case, no trailing dot. */
export function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracket) return bracket[1] ?? null;
  if (isIP(v) === 6) return v;
  const host = v.replace(/:\d+$/, '');
  return host.replace(/\.$/, '') || null;
}

/** The headers' copy of the listener's own policy, which the own address replaces with the page's. */
const LISTENER_POLICY = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

/**
 * What a browser that came over plain HTTP reads (LNK-10): the box's HTTPS addresses, or how to get one. Before the box
 * is claimed the apps can't reach it yet, so the steps are the ones on its own screen.
 */
export function httpsOnlyText(addresses: readonly string[], claimed?: boolean): string {
  if (addresses.length === 0)
    return claimed
      ? 'This Whombat opens only at a secure address. Turn on Whombat Link or Tailscale in the Whombat app to get one.'
      : 'This Whombat opens only at a secure address. To get one, follow the steps on this Whombat’s screen.';
  if (addresses.length === 1) return `This Whombat opens at ${addresses[0]}`;
  return `This Whombat opens at ${addresses.slice(0, -1).join(', ')} or ${addresses.at(-1)}`;
}

export class DirectListener {
  readonly guard: DirectGuard;
  private readonly servers: NetServer[] = [];
  private readonly http: Server;
  private readonly https: Server | null;
  private readonly h2: Http2SecureServer | null;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Set<WebSocket>();
  private table: { at: number; value: InterfaceTable } | null = null;
  private listening = false;
  private sessions = 0;
  private readonly counts = { sessions: 0, refused: 0, failed: 0, badHellos: 0 };

  constructor(private readonly options: DirectListenerOptions) {
    this.guard = options.guard ?? new DirectGuard();
    const onRequest = (req: IncomingMessage, res: ServerResponse) => this.request(req, res);
    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head);
    this.http = createHttpServer(
      { requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 },
      onRequest,
    );
    this.http.on('upgrade', onUpgrade);
    const tls = options.tls;
    this.https = tls
      ? createHttpsServer(
          {
            minVersion: 'TLSv1.2',
            requestTimeout: 30_000,
            headersTimeout: 10_000,
            keepAliveTimeout: 5_000,
            SNICallback: (servername, cb) => {
              tls(servername.toLowerCase().replace(/\.$/, ''))
                .catch(() => null)
                .then((context) => {
                  if (context) cb(null, context);
                  else cb(new Error('no certificate for that name'));
                });
            },
          },
          onRequest,
        )
      : null;
    this.https?.on('upgrade', onUpgrade);
    this.https?.on('tlsClientError', () => {});
    this.h2 = options.door ? this.doorServer(options.door, onRequest, onUpgrade) : null;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: DIRECT_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      handleProtocols: (protocols) => (protocols.has(DIRECT_SUBPROTOCOL) ? DIRECT_SUBPROTOCOL : false),
    });
  }

  get port(): number {
    return this.options.port;
  }

  /** The ports actually bound (tests use port 0). */
  boundPort(): number {
    const addr = this.servers[0]?.address();
    return typeof addr === 'object' && addr ? addr.port : this.options.port;
  }

  async listen(): Promise<void> {
    let port = this.options.port;
    for (const host of this.options.hosts) {
      const server = createNetServer(NET_OPTIONS, (socket) => this.connection(socket));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen({ port, host, ipv6Only: false }, () => {
            server.off('error', reject);
            resolve();
          });
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const noIpv6 = code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT';
        // `::1` on a host without IPv6: the others still serve.
        if (noIpv6 && this.options.hosts.length > 1) continue;
        // `::` on a host without IPv6: every IPv4 address instead.
        if (noIpv6 && host === '::') {
          const v4 = createNetServer(NET_OPTIONS, (socket) => this.connection(socket));
          await new Promise<void>((resolve, reject) => {
            v4.once('error', reject);
            v4.listen({ port, host: '0.0.0.0' }, () => resolve());
          }).catch(async (again) => {
            await this.close();
            throw again;
          });
          this.servers.push(v4);
          continue;
        }
        await this.close();
        throw err;
      }
      const addr = server.address();
      if (port === 0 && typeof addr === 'object' && addr) port = addr.port;
      this.servers.push(server);
    }
    this.listening = this.servers.length > 0;
  }

  async close(): Promise<void> {
    this.listening = false;
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const socket of this.doorSockets) socket.destroy();
    this.doorSockets.clear();
    await Promise.all(
      this.servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    this.wss.close();
  }

  status(): DirectListenerStatus {
    return {
      port: this.boundPort(),
      listening: this.listening,
      sockets: this.guard.openSockets,
      handshakes: this.guard.inFlightHandshakes,
      sessions: this.sessions,
      stats: { ...this.guard.stats, ...this.counts },
    };
  }

  private interfaces(): InterfaceTable | undefined {
    if (this.options.interfaceTable) return this.options.interfaceTable();
    const now = Date.now();
    if (!this.table || now - this.table.at > TABLE_TTL_MS)
      this.table = { at: now, value: networkInterfaces() };
    return this.table.value;
  }

  private arrivalOf(socket: {
    localAddress?: string | undefined;
    remoteAddress?: string | undefined;
  }): DirectArrival | null {
    if (this.options.door) {
      // The host the visitor's TLS handshake named (`acceptDoor`), while the box still answers there: a connection to
      // the host it left stops being served with its next request.
      const host = socket.localAddress;
      return host && socket.remoteAddress && this.options.door.hosts().includes(host)
        ? { network: 'door', iface: 'door', local: host, remote: socket.remoteAddress }
        : null;
    }
    return arrival(this.options.interfaces, socket.localAddress, socket.remoteAddress, this.interfaces());
  }

  /**
   * The own address's Host check (HTTP/2's `:authority`, HTTP/1.1's Host): exactly the host the connection arrived at
   * (its TLS name), or with port 443. The port the browser used is the door's, never this listener's.
   */
  private doorHost(req: IncomingMessage, host: string): boolean {
    const raw = req.headers[':authority'] ?? req.headers.host;
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
    return Boolean(value && (value === host || value === `${host}:443`));
  }

  /* The own address ---------------------------------------------------------------------------------------------- */

  /**
   * The own address's server: HTTP/2 with HTTP/1.1 (the page's WebSocket upgrades on it), fed only by `acceptDoor`. Its
   * timeouts and HTTP/2 limits bound what one visitor can hold.
   */
  private doorServer(
    door: DirectDoor,
    onRequest: (req: IncomingMessage, res: ServerResponse) => void,
    onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): Http2SecureServer {
    const server = createHttp2Server(
      {
        allowHTTP1: true,
        maxSessionMemory: DOOR_HTTP2.maxSessionMemory,
        settings: {
          maxConcurrentStreams: DOOR_HTTP2.maxConcurrentStreams,
          maxHeaderListSize: DOOR_HTTP2.maxHeaderListSize,
          enableConnectProtocol: false,
        },
      },
      (req: Http2ServerRequest, res: Http2ServerResponse) =>
        onRequest(req as unknown as IncomingMessage, this.doorAnswer(door, res)),
    );
    // HTTP/1.1 on the same server: the request's headers in time, then keep-alive as on the local network.
    Object.assign(server, {
      headersTimeout: DOOR_HTTP2.handshakeTimeoutMs,
      requestTimeout: 30_000,
      keepAliveTimeout: 5_000,
    });
    server.setTimeout(DOOR_HTTP2.idleMs);
    server.on('upgrade', onUpgrade);
    server.on('sessionError', () => {});
    return server;
  }

  /** Every answer on the own address carries the page's policy in place of the listener's own (`DIRECT_HEADERS`). */
  private doorAnswer(door: DirectDoor, res: Http2ServerResponse): ServerResponse {
    const out = res as unknown as ServerResponse;
    const writeHead = out.writeHead.bind(out) as (
      status: number,
      headers?: Record<string, string>,
    ) => unknown;
    (out as unknown as { writeHead: typeof writeHead }).writeHead = (status, headers) => {
      if (headers?.['content-security-policy'] === LISTENER_POLICY)
        headers = { ...headers, 'content-security-policy': door.policy };
      return writeHead(status, headers);
    };
    return out;
  }

  /**
   * One `web` door stream (a visitor's TLS connection, raw): counted against `src`, then TLS with the certificate of
   * the host it names (the current one or the one the box is leaving; any other name fails the handshake) and the
   * server. The TLS socket is made here rather than by the server, so it carries `src` as its peer address and the
   * host it arrived at as its local one; it is handed over as Node's own TLS server does.
   */
  acceptDoor(stream: Duplex, src: string): void {
    const door = this.options.door;
    if (!door?.hosts().length || !this.h2 || !this.guard.openSocket(src)) {
      stream.destroy();
      return;
    }
    let arrived: string | undefined;
    const tls = new TLSSocket(stream, {
      isServer: true,
      server: this.h2 as never,
      minVersion: 'TLSv1.2',
      ALPNProtocols: ['h2', 'http/1.1'],
      SNICallback: (name, cb) => {
        const host = name.toLowerCase().replace(/\.$/, '');
        const context = door.hosts().includes(host) ? door.context(host) : null;
        if (!context) {
          cb(new Error('no certificate for that name'));
          return;
        }
        arrived = host;
        cb(null, context);
      },
    } as ConstructorParameters<typeof TLSSocket>[1]);
    Object.defineProperty(tls, 'remoteAddress', { value: src });
    Object.defineProperty(tls, 'localAddress', { get: () => arrived });
    let open = true;
    const closed = () => {
      if (!open) return;
      open = false;
      this.doorSockets.delete(tls);
      this.guard.closeSocket(src);
    };
    this.doorSockets.add(tls);
    tls.once('close', closed);
    stream.once('close', () => tls.destroy());
    tls.on('error', () => tls.destroy());
    const handshake = setTimeout(() => tls.destroy(), DOOR_HTTP2.handshakeTimeoutMs);
    handshake.unref?.();
    tls.once('secure', () => {
      clearTimeout(handshake);
      if (tls.destroyed) return;
      // What Node's TLS server does before it hands a socket on: the HTTP/2 session waits for this flag to clear.
      (tls as unknown as { _releaseControl?: () => boolean })._releaseControl?.();
      (tls as unknown as { secureConnecting: boolean }).secureConnecting = false;
      this.h2?.emit('secureConnection', tls);
    });
  }

  private readonly doorSockets = new Set<TLSSocket>();

  /* Sockets ------------------------------------------------------------------------------------------------------ */

  private connection(socket: Socket): void {
    const where = this.arrivalOf(socket);
    if (!where || !this.guard.openSocket(where.remote)) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once('close', () => {
      this.sockets.delete(socket);
      this.guard.closeSocket(where.remote);
    });
    socket.on('error', () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), SNIFF_TIMEOUT_MS);
    timer.unref?.();
    socket.once('readable', () => {
      clearTimeout(timer);
      const first = socket.read(1) as Buffer | null;
      if (!first) {
        socket.destroy();
        return;
      }
      socket.unshift(first);
      // 0x16: a TLS handshake record.
      const server = first[0] === 0x16 ? this.https : this.http;
      if (!server) {
        socket.destroy();
        return;
      }
      server.emit('connection', socket);
      socket.resume();
    });
  }

  /* Host and Origin ---------------------------------------------------------------------------------------------- */

  /** The names and addresses this box answers to on a connection that arrived at `local`. */
  private knownHost(host: string | null, where: DirectArrival): boolean {
    if (!host || where.network === 'door') return false;
    if (isIP(host)) {
      if (host === where.local) return true;
      return this.options.development && isLoopbackAddress(host);
    }
    if (this.options.development && host === 'localhost') return true;
    return this.options.hostnames().some((n) => n.toLowerCase().replace(/\.$/, '') === host);
  }

  /**
   * A page of this box (any of its names, this port), the hosted app, a loopback page in development, or no page
   * (native).
   */
  private originAllowed(origin: string | null, where: DirectArrival): boolean {
    if (origin === null) return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    // The own address: its own page only, never the hosted app.
    if (where.network === 'door') return url.origin === `https://${where.local}`;
    const origins = this.options.origins;
    if ((typeof origins === 'function' ? origins() : origins)?.includes(url.origin)) return true;
    const host = hostOf(url.host);
    if (this.options.development && (host === 'localhost' || (host && isLoopbackAddress(host)))) return true;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (port !== this.boundPort()) return false;
    if (host && isIP(host)) return host === where.local || this.options.hostnames().includes(host);
    return this.knownHost(host, where);
  }

  /* HTTP --------------------------------------------------------------------------------------------------------- */

  private hostAllowed(req: IncomingMessage, where: DirectArrival | null): where is DirectArrival {
    if (!where) return false;
    if (where.network === 'door') return this.doorHost(req, where.local);
    return this.knownHost(hostOf(req.headers.host), where);
  }

  private request(req: IncomingMessage, res: ServerResponse): void {
    const where = this.arrivalOf(req.socket);
    if (!this.hostAllowed(req, where)) {
      sendText(res, 421, 'This address doesn’t belong to this Whombat.');
      return;
    }
    const raw = (req.url ?? '/').split('?')[0] ?? '/';
    let path: string;
    try {
      path = decodeURIComponent(raw);
    } catch {
      sendText(res, 400, 'Malformed path.');
      return;
    }
    if (this.options.door?.routes?.(req, res, path)) return;
    if (req.method === 'POST' && this.options.posts?.(req, res, path)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      sendText(res, 405, 'Only GET here.');
      return;
    }
    if (path === DIRECT_PATH) {
      // Which box this is, for a page about to pin it (the PeerId isn't secret: any handshake shows it), its edition and
      // whether it is claimed: the first screen of a community box nobody claimed is the claim (CT-1301, HE-S205).
      const known = this.options.identity?.();
      const identity: DirectIdentity = {
        v: DIRECT_PROTOCOL_VERSION,
        appliance: this.options.appliancePeerId,
        ...(known ? { edition: known.edition } : {}),
        ...(known?.claimed !== undefined ? { claimed: known.claimed } : {}),
      };
      sendJson(res, 200, identity);
      return;
    }
    if (!this.options.web) {
      sendText(res, 404, 'This Whombat has no web app to show here.');
      return;
    }
    // Pages only over HTTPS (LNK-10): a plain-HTTP visitor is told where the page is, and gets nothing else.
    if (!this.secure(req, where)) {
      sendText(
        res,
        200,
        httpsOnlyText(this.options.httpsAddresses?.() ?? [], this.options.identity?.().claimed),
      );
      return;
    }
    this.options.web.serve(req, res, path);
  }

  /** HTTPS, the own address, or loopback (a secure context in browsers): where a page may be served. */
  private secure(req: IncomingMessage, where: DirectArrival): boolean {
    if (where.network === 'door' || where.network === 'loopback') return true;
    return 'encrypted' in req.socket && (req.socket as { encrypted?: boolean }).encrypted === true;
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const where = this.arrivalOf(req.socket);
    const url = new URL(req.url ?? '/', 'http://direct.invalid');
    if (!this.hostAllowed(req, where)) {
      refuse(421, 'Misdirected Request');
      return;
    }
    if (url.pathname !== DIRECT_PATH) {
      refuse(404, 'Not Found');
      return;
    }
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim());
    if (!offered.includes(DIRECT_SUBPROTOCOL)) {
      refuse(400, 'Bad Request');
      return;
    }
    // The phone apps send an empty Origin, because React Native's WebSocket would otherwise send the socket's own: a
    // native client, as the relay reads it (docs/app/decisions/app-managed.md AP-28).
    const origin =
      typeof req.headers.origin === 'string' && req.headers.origin !== '' ? req.headers.origin : null;
    const verdict = this.guard.upgrade(where.remote);
    const tls =
      where.network === 'door' ||
      ('encrypted' in req.socket && (req.socket as { encrypted?: boolean }).encrypted === true);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (!this.originAllowed(origin, where)) {
        ws.close(DIRECT_CLOSE.forbidden, 'origin');
        return;
      }
      if (verdict !== 'ok') {
        ws.close(DIRECT_CLOSE.rateLimited, verdict);
        return;
      }
      const secureContext =
        origin === null
          ? null
          : origin.startsWith('https://') || (this.options.development && where.network === 'loopback');
      this.socket(ws, {
        ...where,
        tls,
        origin,
        secureContext,
      });
    });
  }

  /* WebSocket ---------------------------------------------------------------------------------------------------- */

  private socket(ws: WebSocket, meta: Omit<DirectMeta, 'hello'>): void {
    this.clients.add(ws);
    let alive = true;
    let missed = 0;
    const heartbeat = setInterval(() => {
      if (alive) missed = 0;
      else missed += 1;
      if (missed >= 2) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, this.options.heartbeatMs ?? DIRECT_HEARTBEAT_MS);
    heartbeat.unref?.();
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', () => {
      alive = true;
    });
    ws.once('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(ws);
    });
    ws.on('error', () => ws.terminate());
    const helloTimer = setTimeout(() => {
      this.counts.badHellos += 1;
      this.guard.failed(meta.remote);
      ws.close(DIRECT_CLOSE.badHello, 'hello timeout');
    }, this.options.helloTimeoutMs ?? DIRECT_HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    const onHello = (raw: WebSocket.RawData, isBinary: boolean) => {
      ws.off('message', onHello);
      clearTimeout(helloTimer);
      const parsed = isBinary ? null : parseDirectUpstream(raw.toString());
      if (!parsed?.ok) {
        this.counts.badHellos += 1;
        this.guard.failed(meta.remote);
        ws.close(DIRECT_CLOSE.badHello, isBinary ? 'binary before welcome' : parsed?.error.slice(0, 100));
        return;
      }
      const admit = this.options.admit();
      if (admit === 'full') {
        ws.close(DIRECT_CLOSE.rateLimited, 'busy');
        return;
      }
      if (admit !== 'ok') {
        ws.close(DIRECT_CLOSE.draining, JSON.stringify({ retryAfterMs: admit.draining }));
        return;
      }
      if (!this.guard.beginHandshake(meta.remote)) {
        ws.close(DIRECT_CLOSE.rateLimited, 'handshakes');
        return;
      }
      ws.send(
        JSON.stringify(
          DirectWelcome.parse({
            t: 'welcome',
            v: DIRECT_PROTOCOL_VERSION,
            heartbeatMs: this.options.heartbeatMs ?? DIRECT_HEARTBEAT_MS,
            maxMessage: DIRECT_MAX_MESSAGE_BYTES,
          }),
        ),
      );
      // Synchronously, so no binary message is missed: from here the socket is a byte stream.
      let stream: ByteStream;
      try {
        stream = nodeWebSocketByteStream(ws as never, { maxMessageBytes: DIRECT_MAX_MESSAGE_BYTES });
      } catch (err) {
        this.guard.endHandshake(meta.remote);
        this.options.log.warn({ err: String(err) }, 'direct: connection failed');
        ws.terminate();
        return;
      }
      void this.options
        .onStream(stream, { ...meta, hello: parsed.value })
        .catch(() => 'failed' as const)
        .then((outcome) => {
          this.guard.endHandshake(meta.remote);
          if (outcome === 'session') {
            this.counts.sessions += 1;
            this.sessions += 1;
            ws.once('close', () => {
              this.sessions -= 1;
            });
            return;
          }
          this.counts[outcome] += 1;
          this.guard.failed(meta.remote);
        });
    };
    ws.on('message', onHello);
  }
}
