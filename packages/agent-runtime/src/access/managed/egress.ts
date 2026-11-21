/**
 * A managed task's only way out of its network namespace (docs/decisions/managed-sandbox.md MSB-06, MSB-07):
 * three unix sockets in a runner-owned directory, bridged into the sandbox by its init (`shim.mjs`) as
 * loopback ports inside the task's own network namespace.
 *
 * - `proxy.sock` — an HTTP proxy: `CONNECT host:port` tunnels and absolute-form `http://` requests. The proxy
 *   resolves names itself, checks **every** address a name resolves to (a name with any non-public address is
 *   refused: no DNS-rebinding mix), and connects to the address it checked — never to a name, so the check and
 *   the connection can't disagree. Redirects are the client's: each hop is a new request, checked again.
 * - `dns.sock` — the sandbox resolver's upstream: a line protocol (`A name` / `AAAA name` → one JSON line).
 *   Only names the policy allows are resolved, and only public addresses are answered, so the resolver is no
 *   exfiltration channel in allowlist mode and never hands out a private address.
 * - `mcp.sock` — the Whombat MCP endpoint, and nothing else of the server: requests under the MCP path only,
 *   forwarded to the server's origin.
 *
 * Destinations: the policy's host patterns (the provider's endpoints and GitHub, or any public host with the
 * agent's web key), on the allowed ports; never loopback, private, link-local, CGNAT, unique-local, metadata,
 * multicast or reserved addresses — IPv4 and IPv6, including IPv4 embedded in IPv6 — unless an explicit grant
 * names a customer-network block (never loopback or metadata).
 */
import { lookup } from 'node:dns/promises';
import { chmod, mkdir, rm } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createNetServer, isIP, connect as netConnect, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  addressBytes,
  type Cidr,
  classifyAddress,
  HOSTNAME,
  hostMatches,
  inCidr,
  localName,
  parseCidr,
} from './addresses';

export interface EgressGrant {
  /** A customer-network block, e.g. `10.20.0.0/16` or `fd12:3456::/48`. */
  cidr: string;
  /** Ports allowed there (default: the policy's ports). */
  ports?: readonly number[];
}

export interface EgressPolicy {
  /** Host patterns (`api.anthropic.com`, `*.githubusercontent.com`), or `public`: any public host (web key). */
  allow: readonly string[] | 'public';
  /** Ports a task may connect to (default 443 and 80). */
  ports?: readonly number[];
  /** Explicit, scoped grants to non-public destinations (MSB-08). Empty by default. */
  grants?: readonly EgressGrant[];
}

export type EgressVerdict = { ok: true; address: string; family: 4 | 6 } | { ok: false; reason: string };

export interface EgressEvent {
  kind: 'connect' | 'http' | 'dns' | 'mcp';
  host: string;
  port?: number;
  allowed: boolean;
  reason?: string;
  address?: string;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export interface EgressOptions {
  /** Runner-owned directory for the sockets (created 0700). */
  dir: string;
  policy: EgressPolicy;
  /** The Whombat MCP endpoint (`http://127.0.0.1:4400/mcp`): only paths under its path are forwarded. */
  mcp?: string;
  resolve?: Resolver;
  onEvent?: (event: EgressEvent) => void;
  /** Concurrent tunnels / requests (default 64). */
  maxConnections?: number;
  /** A tunnel with no traffic for this long is closed (default 10 minutes). */
  idleMs?: number;
  /**
   * Where a checked destination is really dialled (tests only: a public test address mapped to a local
   * server). The policy has already decided by then.
   */
  dial?: (address: string, port: number) => { host: string; port: number };
}

export interface EgressService {
  proxySocket: string;
  dnsSocket: string;
  mcpSocket: string | null;
  events: readonly EgressEvent[];
  /** Decide a destination the way the proxy does (tests, logs). */
  check(host: string, port: number): Promise<EgressVerdict>;
  /**
   * Replaces the policy for every connection and name asked from now on (a person's pod, hermes-native.md HN-W15: the
   * grants of the person's live turns). A tunnel already open stays as it was decided.
   */
  setPolicy(policy: EgressPolicy): void;
  close(): Promise<void>;
}

const DEFAULT_PORTS = [443, 80];
/** Classes a grant may open (never loopback, metadata, unspecified, multicast or reserved space). */
const GRANTABLE = new Set(['private', 'cgnat', 'unique_local', 'link_local']);

const defaultResolve: Resolver = async (host) => lookup(host, { all: true, verbatim: true });

/** The policy's verdict on one destination (no connection made). */
export async function checkDestination(
  rawHost: string,
  port: number,
  policy: EgressPolicy,
  resolve: Resolver = defaultResolve,
): Promise<EgressVerdict> {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
  const grants = (policy.grants ?? [])
    .map((g) => ({ cidr: parseCidr(g.cidr), ports: g.ports }))
    .filter((g): g is { cidr: Cidr; ports: readonly number[] | undefined } => g.cidr !== null);
  const ports = policy.ports ?? DEFAULT_PORTS;
  const granted = (address: string) => {
    const bytes = addressBytes(address);
    if (!bytes) return false;
    return grants.some((g) => inCidr(bytes, g.cidr) && (g.ports ?? ports).includes(port));
  };
  const admissible = (address: string): string | null => {
    const c = classifyAddress(address);
    if (c.class === 'public') return null;
    if (GRANTABLE.has(c.class) && granted(address)) return null;
    return `${address} is ${c.class.replace('_', '-')}${c.embedded ? ` (carries ${c.embedded})` : ''}`;
  };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: `bad port ${port}` };
  if (isIP(host)) {
    const why = admissible(host);
    if (why) return { ok: false, reason: why };
    // A literal address is reachable only in public mode, or through a grant.
    if (policy.allow !== 'public' && !granted(host))
      return { ok: false, reason: `${host} is not an allowed host` };
    if (!ports.includes(port) && !granted(host)) return { ok: false, reason: `port ${port} is not allowed` };
    return { ok: true, address: host, family: isIP(host) as 4 | 6 };
  }
  if (!HOSTNAME.test(host)) return { ok: false, reason: 'not a host name' };
  if (localName(host)) return { ok: false, reason: `${host} is a local name` };
  if (policy.allow !== 'public' && !policy.allow.some((p) => hostMatches(host, p)))
    return { ok: false, reason: `${host} is not an allowed host` };
  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    return { ok: false, reason: `${host} does not resolve (${(err as NodeJS.ErrnoException).code ?? err})` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} does not resolve` };
  // Every address must be admissible: a name that also points somewhere private is refused outright.
  for (const a of addresses) {
    const why = admissible(a.address);
    if (why) return { ok: false, reason: `${host} resolves to ${why}` };
  }
  const first = addresses[0] as { address: string; family: number };
  if (!ports.includes(port) && !granted(first.address))
    return { ok: false, reason: `port ${port} is not allowed` };
  return { ok: true, address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** A narrow allowance for one endpoint a turn must reach beyond its policy (`endpointAllowance`). */
export interface EgressAllowance {
  /** The endpoint's host name (none for a literal address, or a local name the URL no longer uses). */
  allow: string[];
  /** Each address it resolves to, on its port only. */
  grants: EgressGrant[];
  /**
   * The URL to use: `url` itself, or — for a local name (`ollama.lan`, `nas`), which the proxy never resolves — the
   * same URL at the address it resolved to (http only: an https name would no longer match its certificate).
   */
  url: string;
}

/** What an allowance may open: public space, and what a grant may (never loopback, metadata or special space). */
const REACHABLE = new Set(['public', ...GRANTABLE]);

/**
 * One endpoint a turn may reach for its model (hermes-engine.md HE-32, HE-S52): a model on the person's network, or an
 * organisation key's own OpenAI-compatible service — its host on its port, and each address `url`'s host resolved to
 * at the turn's start, on that port only. Never this host's loopback or the metadata service; null when nothing is
 * left (or the URL isn't `http(s)`).
 */
export async function endpointAllowance(
  url: string,
  resolve: Resolver = defaultResolve,
): Promise<EgressAllowance | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const literal = isIP(host) !== 0;
  const local = !literal && localName(host);
  if (local && u.protocol !== 'http:') return null;
  const addresses = (
    literal ? [host] : (await resolve(host).catch(() => [] as { address: string }[])).map((a) => a.address)
  ).filter((a) => REACHABLE.has(classifyAddress(a).class));
  const first = addresses[0];
  if (first === undefined) return null;
  const grants = (local ? [first] : addresses).map((a) => ({
    cidr: `${a}/${isIP(a) === 6 ? 128 : 32}`,
    ports: [port],
  }));
  if (!local) return { allow: literal ? [] : [host], grants, url };
  const at = new URL(url);
  at.hostname = isIP(first) === 6 ? `[${first}]` : first;
  return { allow: [], grants, url: at.toString() };
}

/** `policy` with an allowance added (a policy open to every public host keeps that). */
export function withAllowance(policy: EgressPolicy, allowance: EgressAllowance | null): EgressPolicy {
  if (!allowance) return policy;
  return {
    ...policy,
    allow: policy.allow === 'public' ? 'public' : [...policy.allow, ...allowance.allow],
    grants: [...(policy.grants ?? []), ...allowance.grants],
  };
}

/**
 * Several policies as one (a person's pod, hermes-native.md HN-W15): what any of them allows — any public host when one
 * does, else every host pattern; every grant; the ports of each (the default ones for a policy naming none).
 */
export function joinPolicies(policies: readonly EgressPolicy[]): EgressPolicy {
  const [first, ...rest] = policies;
  if (!first) return { allow: [] };
  if (!rest.length) return first;
  const allow = policies.some((p) => p.allow === 'public')
    ? 'public'
    : [...new Set(policies.flatMap((p) => p.allow as readonly string[]))];
  const named = policies.some((p) => p.ports !== undefined);
  const ports = named ? [...new Set(policies.flatMap((p) => p.ports ?? DEFAULT_PORTS))] : undefined;
  const grants = policies.flatMap((p) => p.grants ?? []);
  return { allow, ...(ports ? { ports } : {}), ...(grants.length ? { grants } : {}) };
}

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!m) return null;
  return { host: (m[1] as string).replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : defaultPort };
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

function forwardHeaders(req: IncomingMessage, host: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out.host = host;
  return out;
}

async function listen(server: Server | ReturnType<typeof createNetServer>, path: string): Promise<void> {
  await rm(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
}

export async function startEgress(options: EgressOptions): Promise<EgressService> {
  await mkdir(options.dir, { recursive: true, mode: 0o700 });
  await chmod(options.dir, 0o700);
  const resolve = options.resolve ?? defaultResolve;
  const events: EgressEvent[] = [];
  const note = (event: EgressEvent) => {
    if (events.length < 1000) events.push(event);
    options.onEvent?.(event);
  };
  const maxConnections = options.maxConnections ?? 64;
  const idleMs = options.idleMs ?? 600_000;
  const open = new Set<Socket>();
  const track = (socket: Socket) => {
    open.add(socket);
    socket.setTimeout(idleMs, () => socket.destroy());
    socket.once('close', () => open.delete(socket));
  };
  let policy = options.policy;
  const check = (host: string, port: number) => checkDestination(host, port, policy, resolve);

  // The proxy: CONNECT tunnels and absolute-form http:// requests.
  const proxy = createHttpServer();
  proxy.on('connection', (socket: Socket) => {
    if (open.size >= maxConnections) {
      socket.destroy();
      return;
    }
    track(socket);
  });
  proxy.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = splitHostPort(req.url ?? '', 443);
    const refuse = (status: number, reason: string, host = req.url ?? '', port?: number) => {
      note({ kind: 'connect', host, ...(port ? { port } : {}), allowed: false, reason });
      // The client may have hung up while the destination was checked: a refusal it never reads isn't an error.
      client.once('error', () => client.destroy());
      if (client.destroyed || !client.writable) return;
      client.end(
        `HTTP/1.1 ${status} Forbidden\r\ncontent-type: text/plain\r\nx-whombat-egress: ${encodeURIComponent(reason)}\r\n\r\n${reason}\n`,
      );
    };
    if (!target) return refuse(400, 'bad CONNECT target');
    void check(target.host, target.port).then((verdict) => {
      if (!verdict.ok) return refuse(403, verdict.reason, target.host, target.port);
      const to = options.dial?.(verdict.address, target.port) ?? { host: verdict.address, port: target.port };
      const upstream = netConnect({ host: to.host, port: to.port });
      track(upstream);
      upstream.once('connect', () => {
        note({
          kind: 'connect',
          host: target.host,
          port: target.port,
          allowed: true,
          address: verdict.address,
        });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once('error', () => client.destroy());
      client.once('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    });
  });
  proxy.on('request', (req: IncomingMessage, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Absolute http:// URLs only (https goes through CONNECT).\n');
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end('Absolute http:// URLs only (https goes through CONNECT).\n');
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    void check(host, port).then((verdict) => {
      if (!verdict.ok) {
        note({ kind: 'http', host, port, allowed: false, reason: verdict.reason });
        res.writeHead(403, {
          'content-type': 'text/plain',
          'x-whombat-egress': encodeURIComponent(verdict.reason),
        });
        res.end(`${verdict.reason}\n`);
        return;
      }
      note({ kind: 'http', host, port, allowed: true, address: verdict.address });
      // Never follows a redirect: a 3xx goes back to the client, whose next request is checked on its own.
      const to = options.dial?.(verdict.address, port) ?? { host: verdict.address, port };
      const upstream = httpRequest(
        {
          host: to.host,
          port: to.port,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers: forwardHeaders(req, url.host),
          setHost: false,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`upstream error: ${err.message}\n`);
      });
      req.pipe(upstream);
    });
  });

  // The resolver's upstream: `A name` / `AAAA name` per connection, one JSON line back.
  const dns = createNetServer((socket) => {
    track(socket);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 600) return socket.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const [type, rawName] = buf.slice(0, nl).trim().split(/\s+/);
      const name = (rawName ?? '').toLowerCase().replace(/\.$/, '');
      const answer = (body: object) => socket.end(`${JSON.stringify(body)}\n`);
      if ((type !== 'A' && type !== 'AAAA') || !name) return answer({ rcode: 'refused', addresses: [] });
      void (async () => {
        if (!HOSTNAME.test(name) || localName(name)) {
          note({ kind: 'dns', host: name, allowed: false, reason: 'local name' });
          return answer({ rcode: 'nxdomain', addresses: [] });
        }
        const allow = policy.allow;
        if (allow !== 'public' && !allow.some((p) => hostMatches(name, p))) {
          note({ kind: 'dns', host: name, allowed: false, reason: 'not an allowed host' });
          return answer({ rcode: 'refused', addresses: [] });
        }
        let found: { address: string; family: number }[] = [];
        try {
          found = await resolve(name);
        } catch {
          return answer({ rcode: 'nxdomain', addresses: [] });
        }
        const family = type === 'A' ? 4 : 6;
        // Only public addresses are ever answered (a grant opens connections, not the resolver).
        const addresses = found
          .filter((a) => a.family === family && classifyAddress(a.address).class === 'public')
          .map((a) => a.address);
        note({ kind: 'dns', host: name, allowed: true });
        answer({ rcode: 'ok', addresses });
      })();
    });
  });

  // The Whombat MCP endpoint only.
  let mcpServer: Server | null = null;
  if (options.mcp) {
    const target = new URL(options.mcp);
    const prefix = target.pathname.replace(/\/+$/, '') || '/mcp';
    mcpServer = createHttpServer((req, res) => {
      const path = req.url ?? '/';
      const pathname = path.split('?')[0] ?? '';
      if (!(pathname === prefix || pathname.startsWith(`${prefix}/`))) {
        note({ kind: 'mcp', host: target.host, allowed: false, reason: `path ${pathname}` });
        res
          .writeHead(403, { 'content-type': 'text/plain' })
          .end('Only the Whombat MCP endpoint is reachable.\n');
        return;
      }
      const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
        {
          protocol: target.protocol,
          host: target.hostname.replace(/^\[|\]$/g, ''),
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          method: req.method,
          path,
          headers: forwardHeaders(req, target.host),
          setHost: false,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`upstream error: ${err.message}\n`);
      });
      req.pipe(upstream);
    });
    mcpServer.on('connection', track);
  }

  const proxySocket = join(options.dir, 'proxy.sock');
  const dnsSocket = join(options.dir, 'dns.sock');
  const mcpSocket = mcpServer ? join(options.dir, 'mcp.sock') : null;
  await listen(proxy, proxySocket);
  await listen(dns, dnsSocket);
  if (mcpServer && mcpSocket) await listen(mcpServer, mcpSocket);

  let closing: Promise<void> | null = null;
  return {
    proxySocket,
    dnsSocket,
    mcpSocket,
    events,
    check,
    setPolicy(next) {
      policy = next;
    },
    close() {
      closing ??= (async () => {
        for (const s of open) s.destroy();
        await Promise.all(
          [proxy, dns, mcpServer]
            .filter((s): s is NonNullable<typeof s> => s !== null)
            .map((s) => new Promise<void>((r) => s.close(() => r()))),
        );
        await rm(options.dir, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}
