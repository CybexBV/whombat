/**
 * A turn through the burrow's AI gateway on the runner (Whombat docs/decisions/ai-gateway.md AIG-07, AIG-08, AIG-10).
 *
 * - `gatewayRouteOf`: whether a dispatch goes through the gateway (`DispatchContext.gateway`, set by the server at claim
 *   while the switch of the agent's provider is on), and refuses one this runner can't send there — never runs it on a
 *   sign-in instead (AIG-12: no fallback).
 * - `GatewayForwarder`: the CLI runs in the task sandbox, whose network namespace has only loopback;
 *   its model requests go to `127.0.0.1:47104`, which the sandbox's init bridges to this forwarder's unix socket (stage 1
 *   only, `SandboxGateway`). The forwarder passes requests under `/ai-gateway/` to the server's relay (`ALL
 *   /ai-gateway/:provider/*`) and nothing else: everything else of the server answers 404 from here. Both directions
 *   stream — the request body as the CLI sends it, the response (an SSE stream of a model call) chunk by chunk, no
 *   buffering, no deadline — and the CLI's `Authorization` / `x-api-key` (the dispatch's agent token) go through
 *   unchanged: the relay checks it and puts the gateway's own key in its place, which never reaches the runner.
 */
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { SANDBOX_GATEWAY_ORIGIN } from '@whombat/agent-runtime';
import {
  AI_GATEWAY_RELAY_PREFIX,
  aiGatewayRelayPath,
  type DispatchContext,
  GatewayDispatchContext,
} from '@whombat/core';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

/** The relay's paths: the forwarder passes these, and only these, to the server (AIG-08). */
export const GATEWAY_PATH_PREFIX = `${AI_GATEWAY_RELAY_PREFIX}/`;
/** A forwarded connection with no traffic for this long is closed (the relay's own idle limit is 10 minutes). */
export const GATEWAY_IDLE_MS = 15 * 60_000;
/** A unix socket's path has at most 107 bytes. */
const SOCKET_PATH_MAX = 100;

/** What a gateway turn's agent says when this runner can't send it there (it never runs on a sign-in instead). */
export function gatewayUnusableText(name: string | null): string {
  return `My turns go through ${name || 'the AI gateway'}, but this Whombat couldn’t send this one there, so I didn’t start. Ask me again in a moment.`;
}

/**
 * The route of a dispatch (AIG-07): null — the agent's own sign-in, as before; `ok` — through the gateway; `refusal` — the server asked for the gateway in a way this runner
 * doesn't understand (another version, another provider than the agent's, an id that isn't one), so the turn doesn't
 * start: running it on a sign-in instead would be the fallback AIG-12 rules out.
 */
export function gatewayRouteOf(
  ctx: DispatchContext,
): { ok: true; gateway: GatewayDispatchContext } | { ok: false; refusal: string } | null {
  const raw: unknown = ctx.gateway;
  if (raw === undefined || raw === null) return null;
  // Read again here (contracts first): its connection id names a folder on this runner's disk (`con_…`, no `.` or `/`;
  // `gatewayHomePath` checks it once more).
  const parsed = GatewayDispatchContext.safeParse(raw);
  if (parsed.success && parsed.data.provider === ctx.agent.runtime.provider)
    return { ok: true, gateway: parsed.data };
  const name = (raw as { name?: unknown }).name;
  return { ok: false, refusal: gatewayUnusableText(typeof name === 'string' ? name.trim() || null : null) };
}

/**
 * Where a gateway turn's CLI sends its model requests (AIG-08, AIG-10): the sandbox's bridge to the turn's forwarder;
 * Claude Code's Anthropic base URL, Codex's Responses base URL (`…/v1`).
 */
export function gatewayBaseUrl(provider: 'claude' | 'codex'): string {
  return `${SANDBOX_GATEWAY_ORIGIN}${aiGatewayRelayPath(provider)}${provider === 'codex' ? '/v1' : ''}`;
}

/**
 * The path the forwarder passes on for a request line's target, or null to refuse it: an origin-form target under
 * `/ai-gateway/` that stays there once its dot segments are resolved, without encoded separators or dots (an
 * absolute-form or `//host` target, `/ai-gateway/../internal/…`, `%2e%2e`, `%2f`, `\` all refused).
 */
export function gatewayPath(target: string): string | null {
  if (!target.startsWith(GATEWAY_PATH_PREFIX) || target.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(target, 'http://gateway.invalid');
  } catch {
    return null;
  }
  if (url.host !== 'gateway.invalid' || !url.pathname.startsWith(GATEWAY_PATH_PREFIX)) return null;
  if (/%(2e|2f|5c)/i.test(url.pathname)) return null;
  return `${url.pathname}${url.search}`;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Headers without the hop-by-hop ones (those `Connection` names too); `host` replaced when given. */
export function endToEndHeaders(headers: IncomingHttpHeaders, host?: string): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(k) || named.has(k) || (host && k === 'host')) continue;
    out[key] = value;
  }
  if (host) out.host = host;
  return out;
}

/** An error the CLI can read: Anthropic's shape, whose `error.message` OpenAI clients read too. */
function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

export interface GatewayForwarderDeps {
  /** The server's origin (the runner's `serverUrl`): the relay is under `/ai-gateway/` there. */
  serverUrl: string;
  /** The runner's private temp root: the forwarder's socket goes in a folder of its own there (0700). */
  tmpRoot: string;
  log: Log;
  /** A connection with no traffic for this long is closed (default `GATEWAY_IDLE_MS`). */
  idleMs?: number;
  /**
   * A person's pod (hermes-native.md HN-W08): Hermes holds a placeholder key, and the forwarder puts in the agent token
   * of the pod's newest live turn through the gateway, in the header the client used (none live: refused).
   */
  authToken?: () => string | null;
}

/** The headers to send on for a pod's request: the client's key header(s) carrying `token` instead (HN-W08). */
export function withAgentToken(headers: OutgoingHttpHeaders, token: string): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  let keyed = false;
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (k === 'authorization') {
      out[key] = `Bearer ${token}`;
      keyed = true;
    } else if (k === 'x-api-key') {
      out[key] = token;
      keyed = true;
    } else out[key] = value;
  }
  if (!keyed) out.authorization = `Bearer ${token}`;
  return out;
}

export class GatewayForwarder {
  /** The socket the sandbox's init bridges to `127.0.0.1:47104` (`SandboxTask.gateway`). */
  readonly socket: string;
  readonly #deps: GatewayForwarderDeps;
  readonly #dispatchId: string;
  readonly #origin: URL;
  /** What `close` removes: the forwarder's own folder, and a short folder for a socket path that would be too long. */
  readonly #remove: string[];
  readonly #sockets = new Set<Socket>();
  #server: Server | null = null;
  #closing: Promise<void> | null = null;

  private constructor(deps: GatewayForwarderDeps, dispatchId: string, socket: string, remove: string[]) {
    this.#deps = deps;
    this.#dispatchId = dispatchId;
    this.#origin = new URL(deps.serverUrl);
    this.socket = socket;
    this.#remove = remove;
  }

  /** Starts the turn's forwarder; throws when it can't listen (what was made by then is removed). */
  static async open(deps: GatewayForwarderDeps, dispatchId: string): Promise<GatewayForwarder> {
    await mkdir(deps.tmpRoot, { recursive: true, mode: 0o700 });
    const safe = dispatchId.replace(/[^A-Za-z0-9_-]/g, '_');
    let dir = join(realpathSync(deps.tmpRoot), 'aig', safe);
    const remove = [dir];
    // A path longer than a unix socket allows (a long temp root): a private folder of its own under /tmp instead. The
    // sandbox's init connects to the path itself, so a link wouldn't do.
    if (Buffer.byteLength(join(dir, 'gateway.sock')) > SOCKET_PATH_MAX) {
      dir = await mkdtemp(join('/tmp', 'wbai-'));
      remove.splice(0, 1, dir);
    } else {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await chmod(dir, 0o700);
    const forwarder = new GatewayForwarder(deps, dispatchId, join(dir, 'gateway.sock'), remove);
    try {
      await forwarder.#listen();
    } catch (err) {
      await forwarder.close();
      throw err;
    }
    return forwarder;
  }

  async #listen(): Promise<void> {
    const server = createServer((req, res) => this.#forward(req, res));
    // No deadline for a request: a model call streams for as long as it takes; idle connections are closed below.
    server.requestTimeout = 0;
    server.on('connection', (socket: Socket) => {
      this.#sockets.add(socket);
      socket.setTimeout(this.#deps.idleMs ?? GATEWAY_IDLE_MS, () => socket.destroy());
      socket.once('close', () => this.#sockets.delete(socket));
    });
    server.on('clientError', (_err, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    await chmod(this.socket, 0o600);
  }

  #forward(req: IncomingMessage, res: ServerResponse): void {
    const path = gatewayPath(req.url ?? '');
    if (!path) {
      this.#deps.log('debug', `ai gateway: refused ${req.method} ${(req.url ?? '').slice(0, 200)}`, {
        dispatchId: this.#dispatchId,
      });
      req.resume();
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(errorBody('not_found_error', 'Only the AI gateway is reachable here.'));
      return;
    }
    const origin = this.#origin;
    const https = origin.protocol === 'https:';
    // The CLI's `Authorization` / `x-api-key` (the agent token) as it sent them: the relay decides. A pod's: the
    // newest live turn's token in their place (HN-W08).
    let headers = endToEndHeaders(req.headers, origin.host);
    if (this.#deps.authToken) {
      const token = this.#deps.authToken();
      if (!token) {
        req.resume();
        res
          .writeHead(503, { 'content-type': 'application/json' })
          .end(errorBody('api_error', 'No turn through the AI gateway is running now.'));
        return;
      }
      headers = withAgentToken(headers, token);
    }
    const upstream = (https ? httpsRequest : httpRequest)({
      protocol: origin.protocol,
      host: origin.hostname.replace(/^\[|\]$/g, ''),
      port: origin.port || (https ? 443 : 80),
      method: req.method,
      path,
      headers,
      setHost: false,
    });
    upstream.setTimeout(this.#deps.idleMs ?? GATEWAY_IDLE_MS, () =>
      upstream.destroy(new Error('the AI gateway stopped answering')),
    );
    upstream.on('response', (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, endToEndHeaders(up.headers));
      // The status and headers go out now, the body as each chunk arrives (an SSE stream stays one).
      res.flushHeaders();
      up.on('error', () => res.destroy());
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      this.#deps.log('warn', `ai gateway: the server didn’t answer (${err.message})`, {
        dispatchId: this.#dispatchId,
      });
      res
        .writeHead(502, { 'content-type': 'application/json' })
        .end(errorBody('api_error', `Whombat couldn’t reach the AI gateway (${err.message}).`));
    });
    // The CLI hung up (a cancelled turn): the model call stops too.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  /** The turn is over (cancel and failure too): connections dropped, the socket and its folder removed. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      for (const s of this.#sockets) s.destroy();
      await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
      for (const d of this.#remove) await rm(d, { recursive: true, force: true }).catch(() => {});
    })();
    return this.#closing;
  }
}
