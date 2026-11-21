/**
 * The hosts service's API over its unix socket (docs/decisions/one-whombat.md ONE-11; one-whombat-servers.md ONE-DH01…).
 * One HTTP/1.1 request per call on `WHOMBAT_HOSTS_SOCKET`, with the service token from `WHOMBAT_HOSTS_TOKEN_FILE` as
 * the bearer and the person (or Whombat) the call is for in `X-Whombat-Actor` / `X-Whombat-Role` /
 * `X-Whombat-Client-IP`, so the hosts service's audit log names them and its per-person limits key on them.
 *
 * Problems (`application/problem+json`) become `HostsError` with the service's code; a socket that isn't there, refuses,
 * or doesn't answer in time becomes `HostsUnavailable`. The token is read lazily and again when the service refused it
 * (it writes the file on its first start, possibly after Whombat started).
 */
import { readFile, stat } from 'node:fs/promises';
import { type ClientRequest, request as httpRequest, type IncomingMessage } from 'node:http';
import { openUnixHttp, readUnixHttpBody, requestUnixHttp, UnixHttpError } from '@whombat/node-io/http';

/** Who a call is for (ONE-DH03): their principal id and display name, the hosts role Whombat gives the call. */
export interface HostsActor {
  id: string;
  name: string;
  role?: HostsRole;
  clientIp?: string | null;
}

export type HostsRole = 'viewer' | 'operator' | 'admin';

/** The base of the hosts service's data routes. */
export const HOSTS_API = '/api/v1';
/** A JSON answer is cut off (and refused) beyond this. */
export const HOSTS_MAX_BODY = 16 * 1024 * 1024;
/** Default per-call deadline. */
export const HOSTS_TIMEOUT_MS = 15_000;

/** The hosts service answered with a problem (RFC 9457) or another error status. */
export class HostsError extends Error {
  constructor(
    readonly status: number,
    /** The service's machine-readable code (`agent_offline`, `digest_mismatch`, …); `http_<status>` without one. */
    readonly code: string,
    /** Its sentence for people, when it gave one. */
    readonly detail: string | null,
    readonly fieldErrors: Readonly<Record<string, string>> | null = null,
    /** Why it can't, when the service names it (`no_docker`, `nfs_off`, `agent_too_old`, …). */
    readonly reason: string | null = null,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'HostsError';
  }
}

/** The hosts service isn't reachable: no socket, refused, no token, or no answer in time. */
export class HostsUnavailable extends Error {
  constructor(
    readonly reason: 'not_configured' | 'not_running' | 'no_token' | 'timeout' | 'broken',
    message: string,
  ) {
    super(message);
    this.name = 'HostsUnavailable';
  }
}

export interface HostsRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** An absolute path on the service (`/api/v1/fleet`, `/healthz`). */
  path: string;
  query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  body?: unknown;
  actor?: HostsActor | null;
  timeoutMs?: number;
  /** Extra request headers (`Last-Event-ID`). */
  headers?: Readonly<Record<string, string>>;
  /** A streamed answer (`open`): how long the socket may stay quiet once the head arrived (none when omitted). */
  idleTimeoutMs?: number;
}

/** A request whose body is streamed (`upload`): exactly `size` bytes of `contentType`. */
export interface HostsUpload {
  path: string;
  body: AsyncIterable<Uint8Array>;
  size: number;
  contentType: string;
  actor?: HostsActor | null;
  /** The whole exchange's deadline (default 10 minutes). */
  timeoutMs?: number;
}

/** How long an upload may take by default (a hub backup is at most 1 GiB on a local socket). */
export const HOSTS_UPLOAD_TIMEOUT_MS = 10 * 60_000;
/** An upload's answer is read up to this (a short JSON or problem). */
const UPLOAD_ANSWER_MAX = 64 * 1024;

export interface HostsResponse {
  status: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

export interface HostsClientOptions {
  socket: string;
  tokenFile: string | null;
  timeoutMs?: number;
}

/** Characters a header value may not carry (controls but tab), and the separator of `X-Whombat-Actor`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f|]/g;

/**
 * A header value from text: no controls or `|`, at most `maxBytes` UTF-8 bytes (whole characters), sent as its UTF-8
 * bytes (Node writes a string of code points ≤ 0xFF byte for byte, so the hosts service reads the UTF-8 it was given;
 * ONE-DH04). The service takes ids of 1–128 and names of at most 128 bytes.
 */
export function headerText(text: string, maxBytes = 120): string {
  let out = '';
  let bytes = 0;
  for (const ch of text.normalize('NFC').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return Buffer.from(out, 'utf8').toString('latin1');
}

/** The actor headers of a call (ONE-DH03, ONE-DH04). */
export function actorHeaders(actor: HostsActor | null | undefined): Record<string, string> {
  if (!actor) return {};
  const headers: Record<string, string> = {
    'X-Whombat-Actor': `${actor.id.replace(/[^A-Za-z0-9._:@-]/g, '_').slice(0, 128) || 'whombat'}|${headerText(actor.name) || 'Someone'}`,
  };
  if (actor.role) headers['X-Whombat-Role'] = actor.role;
  if (actor.clientIp && /^[0-9a-fA-F:.]{2,45}$/.test(actor.clientIp))
    headers['X-Whombat-Client-IP'] = actor.clientIp;
  return headers;
}

/** `path?query` with the empty values left out. */
export function withQuery(path: string, query: HostsRequest['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

/** A path segment from an id (`pve:101` stays readable; `/` and the rest are escaped). */
export function seg(id: string): string {
  return encodeURIComponent(id).replace(/%3A/gi, ':');
}

/** Where a platform's storage pools are on the service (IU-S16): libvirt's under `/libvirt`, Incus's under `/incus`. */
export const poolsOf = (serverId: string, platform?: string | null) =>
  `${HOSTS_API}/servers/${seg(serverId)}/${platform === 'libvirt' ? 'libvirt' : 'incus'}/pools`;

/** Where a platform's networks are (their leases). */
export const networksOf = (serverId: string, platform?: string | null) =>
  `${HOSTS_API}/servers/${seg(serverId)}/${platform === 'libvirt' ? 'libvirt' : 'incus'}/networks`;

/** Parses a problem body; falls back to the status. */
export function problemOf(status: number, body: Buffer): HostsError {
  let code = `http_${status}`;
  let detail: string | null = null;
  let fields: Record<string, string> | null = null;
  let reason: string | null = null;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      reason?: unknown;
      code?: unknown;
      detail?: unknown;
      title?: unknown;
      field_errors?: unknown;
    };
    if (typeof parsed.code === 'string' && parsed.code) code = parsed.code;
    if (typeof parsed.reason === 'string' && /^[a-z_]{1,40}$/.test(parsed.reason)) reason = parsed.reason;
    if (typeof parsed.detail === 'string' && parsed.detail) detail = parsed.detail.slice(0, 500);
    else if (typeof parsed.title === 'string' && parsed.title) detail = parsed.title.slice(0, 200);
    if (parsed.field_errors && typeof parsed.field_errors === 'object') {
      fields = {};
      for (const [k, v] of Object.entries(parsed.field_errors as Record<string, unknown>).slice(0, 50))
        if (typeof v === 'string') fields[k.slice(0, 128)] = v.slice(0, 300);
    }
  } catch {
    const text = body.toString('utf8').trim();
    if (text) detail = text.slice(0, 300);
  }
  return new HostsError(status, code, detail, fields, reason);
}

export class HostsClient {
  readonly socket: string;
  readonly tokenFile: string | null;
  readonly #timeout: number;
  #token: { value: string; mtimeMs: number } | null = null;

  constructor(options: HostsClientOptions) {
    this.socket = options.socket;
    this.tokenFile = options.tokenFile;
    this.#timeout = options.timeoutMs ?? HOSTS_TIMEOUT_MS;
  }

  /** The service token (read again when the file changed, or when `fresh`). */
  async token(fresh = false): Promise<string> {
    if (!this.tokenFile) throw new HostsUnavailable('no_token', 'No service token file is set.');
    try {
      const st = await stat(this.tokenFile);
      if (!fresh && this.#token && this.#token.mtimeMs === st.mtimeMs) return this.#token.value;
      const value = (await readFile(this.tokenFile, 'utf8')).trim();
      if (!value) throw new HostsUnavailable('no_token', 'The service token file is empty.');
      this.#token = { value, mtimeMs: st.mtimeMs };
      return value;
    } catch (err) {
      if (err instanceof HostsUnavailable) throw err;
      throw new HostsUnavailable('no_token', 'The hosts service hasn’t written its token yet.');
    }
  }

  /** The headers every call carries. */
  async headers(actor: HostsActor | null | undefined, fresh = false): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.token(fresh)}`,
      'Accept-Encoding': 'identity',
      ...actorHeaders(actor),
    };
  }

  /** One request; any status. Retries once with the token read again when the service answers 401. */
  async send(req: HostsRequest): Promise<HostsResponse> {
    const first = await this.#send(req, false);
    if (first.status !== 401 || !this.tokenFile) return first;
    return this.#send(req, true);
  }

  /** A JSON answer; a non-2xx status throws `HostsError`. 204 answers null. */
  async json<T>(req: HostsRequest): Promise<T> {
    const res = await this.send(req);
    if (res.status < 200 || res.status >= 300) throw problemOf(res.status, res.body);
    if (res.status === 204 || res.body.length === 0) return null as T;
    try {
      return JSON.parse(res.body.toString('utf8')) as T;
    } catch {
      throw new HostsUnavailable('broken', 'The hosts service answered something that isn’t JSON.');
    }
  }

  /** `GET /healthz`: true when it answers `ok`. */
  async healthy(timeoutMs = 3_000): Promise<{ ok: boolean; reason: string | null }> {
    const res = await this.send({ path: '/healthz', timeoutMs });
    const text = res.body.toString('utf8').trim();
    return res.status === 200
      ? { ok: true, reason: null }
      : { ok: false, reason: text.slice(0, 200) || null };
  }

  /**
   * A streaming GET (`/api/v1/events`): resolves with the response once its head arrived; the caller reads and destroys
   * it. A non-2xx answer throws `HostsError`.
   */
  async open(req: HostsRequest): Promise<{ res: IncomingMessage; request: ClientRequest }> {
    const headers = { ...(await this.headers(req.actor)), ...(req.headers ?? {}) };
    let stream: Awaited<ReturnType<typeof openUnixHttp>>;
    try {
      stream = await openUnixHttp({
        socketPath: this.socket,
        path: withQuery(req.path, req.query),
        method: req.method ?? 'GET',
        headers,
        deadlineMs: req.timeoutMs ?? this.#timeout,
        deadlineUntil: 'headers',
        ...(req.idleTimeoutMs ? { idleTimeoutMs: req.idleTimeoutMs } : {}),
      });
    } catch (err) {
      throw unavailable(err);
    }
    const status = stream.res.statusCode ?? 0;
    if (status >= 200 && status < 300) return stream;
    let body: Buffer;
    try {
      body = await readUnixHttpBody(stream.res, 64 * 1024);
    } catch (err) {
      throw unavailable(err);
    }
    throw problemOf(status, body);
  }

  /**
   * A POST whose body is streamed from `body` (`POST /hub/restore`, BF-14): exactly `size` bytes, the token read fresh
   * first (a streamed body can't be sent twice). Resolves with the answer, any status; when the service answers before
   * it read everything (a refusal), the rest isn't sent and its answer counts.
   */
  async upload(req: HostsUpload): Promise<HostsResponse> {
    const headers: Record<string, string> = {
      ...(await this.headers(req.actor, true)),
      'Content-Type': req.contentType,
      'Content-Length': String(req.size),
    };
    const deadline = req.timeoutMs ?? HOSTS_UPLOAD_TIMEOUT_MS;
    return new Promise<HostsResponse>((resolve, reject) => {
      let answered = false;
      let settled = false;
      const r = httpRequest({
        socketPath: this.socket,
        path: req.path,
        method: 'POST',
        headers,
        agent: false,
      });
      const timer = setTimeout(() => r.destroy(new UnixHttpError('timeout')), deadline);
      const settle = (err: unknown, res?: HostsResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (res) resolve(res);
        else reject(unavailable(err));
      };
      r.on('error', (err) => {
        if (!answered) settle(err);
      });
      // Once the head arrived, reading its body settles (it knows a cut-off answer from a whole one).
      r.on('close', () => {
        if (!answered) settle(new UnixHttpError('incomplete'));
      });
      r.on('response', (res) => {
        answered = true;
        readUnixHttpBody(res, UPLOAD_ANSWER_MAX).then(
          (body) => settle(null, { status: res.statusCode ?? 0, headers: res.headers, body }),
          (err) => settle(err),
        );
      });
      const drained = () =>
        new Promise<void>((done) => {
          const go = () => {
            r.off('drain', go);
            r.off('close', go);
            done();
          };
          r.once('drain', go);
          r.once('close', go);
        });
      void (async () => {
        let sent = 0;
        try {
          for await (const chunk of req.body) {
            if (answered || r.destroyed) return;
            sent += chunk.length;
            if (sent > req.size) throw new Error('the upload is longer than announced');
            if (!r.write(chunk)) await drained();
          }
          if (sent !== req.size) throw new Error('the upload is shorter than announced');
          if (!answered && !r.destroyed) r.end();
        } catch (err) {
          // A refusal that came before the body was read wins over the broken write.
          if (!answered) r.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  }

  async #send(req: HostsRequest, fresh: boolean): Promise<HostsResponse> {
    const headers: Record<string, string> = {
      ...(await this.headers(req.actor, fresh)),
      ...(req.headers ?? {}),
    };
    let payload: Buffer | null = null;
    if (req.body !== undefined) {
      payload = Buffer.from(JSON.stringify(req.body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    try {
      return await requestUnixHttp({
        socketPath: this.socket,
        path: withQuery(req.path, req.query),
        method: req.method ?? 'GET',
        headers,
        body: payload ?? undefined,
        deadlineMs: req.timeoutMs ?? this.#timeout,
        maxResponseBytes: HOSTS_MAX_BODY,
      });
    } catch (err) {
      throw unavailable(err);
    }
  }
}

/** A socket error as `HostsUnavailable`. */
function unavailable(err: unknown): HostsUnavailable {
  if (err instanceof HostsUnavailable) return err;
  if (err instanceof UnixHttpError) {
    if (err.kind === 'timeout')
      return new HostsUnavailable('timeout', 'The hosts service didn’t answer in time.');
    if (err.kind === 'too_large')
      return new HostsUnavailable('broken', 'The hosts service answered too much.');
    if (err.kind === 'incomplete')
      return new HostsUnavailable('broken', 'The hosts service closed the answer.');
  }
  const code = (err as { code?: unknown }).code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES')
    return new HostsUnavailable('not_running', 'The hosts service isn’t running.');
  return new HostsUnavailable('broken', 'The connection to the hosts service broke.');
}
