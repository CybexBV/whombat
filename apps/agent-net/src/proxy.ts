/**
 * The commands' proxy (docs/decisions/one-person.md OP-07, OP-S106): the commands' network namespace has only loopback,
 * and `127.0.0.1:3128` there leads to this proxy's unix socket (`proxy.sock`). It takes `CONNECT host:port` tunnels and
 * absolute-form `http://` requests, resolves names itself (IPv4), and connects only to an address the wall allows
 * (`rules.ts`: the public space on every TCP port but 25, never this host, the home networks and the local network as
 * the person allowed, production servers only once a person said yes, the agent's own services on 20000–20099). It
 * connects to the address it checked, never to a name, so the check and the connection can't disagree. A tunnel to a
 * production server lasts only as long as the opening that let it through: once that is gone, the tunnel is cut.
 */
import { lookup } from 'node:dns/promises';
import { chmod, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { isIP, connect as netConnect, type Socket } from 'node:net';
import { decide as decideAddress, type HostFacts, inAny, type WallPolicy } from './rules';

/** Where the commands' proxy-aware tools reach the proxy inside their network namespace. */
export const PROXY_PORT = 3128;

export type Verdict = { ok: true; address: string } | { ok: false; reason: string };

export type Resolve4 = (host: string) => Promise<string[]>;

const defaultResolve4: Resolve4 = async (host) =>
  (await lookup(host, { all: true, family: 4 })).map((a) => a.address);

/** The proxy's decision on a destination: the first of its IPv4 addresses the wall allows. */
export async function decide(
  host: string,
  port: number,
  policy: WallPolicy,
  facts: HostFacts,
  resolve4: Resolve4 = defaultResolve4,
): Promise<Verdict> {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: `bad port ${port}` };
  if (isIP(name) === 6) return { ok: false, reason: 'IPv6 isn’t reachable from here' };
  let addresses: string[];
  try {
    addresses = isIP(name) === 4 ? [name] : name === 'localhost' ? ['127.0.0.1'] : await resolve4(name);
  } catch {
    return { ok: false, reason: `${name} doesn’t resolve` };
  }
  let reason = `${name} doesn’t resolve`;
  for (const address of addresses) {
    const v = decideAddress(address, port, policy, facts);
    if (v.ok) return { ok: true, address };
    reason = addresses.length > 1 ? `${name}:${port} is outside what the agent may reach` : v.reason;
  }
  return { ok: false, reason };
}

function splitAuthority(authority: string, fallback: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!m) return null;
  return { host: m[1] as string, port: m[2] ? Number(m[2]) : fallback };
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

export interface ProxyOptions {
  /** The unix socket the commands' network namespace is bridged to. */
  path: string;
  /** Its mode (0660 on the appliance: the runner's group reaches it). */
  mode?: number;
  /** The policy now (asked for every connection: openings come and go); null: nothing goes through yet. */
  policy: () => WallPolicy | null;
  /** This host's addresses and the deny list now. */
  facts: () => HostFacts;
  resolve4?: Resolve4;
  /** A refused destination (logs). */
  onRefused?: (host: string, port: number, reason: string) => void;
  /** Where a checked destination is really dialled (tests). */
  dial?: (address: string, port: number) => { host: string; port: number };
  /** How often the tunnels to production servers are checked against their openings (default a second). */
  recheckMs?: number;
}

export interface Proxy {
  readonly path: string;
  /** Checks the tunnels to production servers now (after a new policy): one whose opening is gone is cut. */
  recheck(): void;
  close(): Promise<void>;
}

const RECHECK_MS = 1_000;

export async function startProxy(o: ProxyOptions): Promise<Proxy> {
  const dial = o.dial ?? ((host: string, port: number) => ({ host, port }));
  // Every open tunnel, so closing the proxy can cut them all (a tunnel isn't the http server's connection any more, so
  // closing the server alone would wait on it). Those to a production server are rechecked: only an opening let them
  // through.
  const tunnels = new Set<{ address: string; port: number; production: boolean; cut: () => void }>();
  const recheck = () => {
    const policy = o.policy();
    for (const t of tunnels)
      if (t.production && (!policy || !decideAddress(t.address, t.port, policy, o.facts()).ok)) {
        o.onRefused?.(t.address, t.port, 'its opening is gone');
        t.cut();
      }
  };
  const rechecking = setInterval(recheck, o.recheckMs ?? RECHECK_MS);
  rechecking.unref();
  const verdict = async (host: string, port: number) => {
    const policy = o.policy();
    const v: Verdict = policy
      ? await decide(host, port, policy, o.facts(), o.resolve4)
      : { ok: false, reason: 'the agent’s network isn’t set up yet; try again in a moment' };
    if (!v.ok) o.onRefused?.(host, port, v.reason);
    return v;
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end('Only absolute http:// requests go through this proxy.\n');
        return;
      }
      if (url.protocol !== 'http:') {
        res.writeHead(400).end('Use CONNECT for https.\n');
        return;
      }
      const port = url.port ? Number(url.port) : 80;
      const v = await verdict(url.hostname, port);
      if (!v.ok) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end(`${v.reason}\n`);
        return;
      }
      const target = dial(v.address, port);
      const headers: Record<string, string | string[]> = {};
      for (const [k, val] of Object.entries(req.headers))
        if (val !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) headers[k] = val;
      headers.host = url.host;
      const upstream = httpRequest(
        {
          host: target.host,
          port: target.port,
          method: req.method,
          path: url.pathname + url.search,
          headers,
        },
        (up: IncomingMessage) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      req.pipe(upstream);
    })();
  });
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => {});
    void (async () => {
      const where = splitAuthority(req.url ?? '', 443);
      if (!where) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const v = await verdict(where.host, where.port);
      // The client went away while the wall was deciding: dialling now would leave an upstream nobody closes.
      if (client.destroyed) return;
      if (!v.ok) {
        client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${v.reason}\n`);
        return;
      }
      const target = dial(v.address, where.port);
      const upstream = netConnect(target.port, target.host);
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      const done = () => {
        tunnels.delete(tunnel);
        client.destroy();
        upstream.destroy();
      };
      const policy = o.policy();
      const production = policy !== null && inAny(v.address, policy.production);
      const tunnel = { address: v.address, port: where.port, production, cut: done };
      tunnels.add(tunnel);
      upstream.on('error', () => {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        done();
      });
      upstream.on('close', done);
      client.on('close', done);
    })();
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await rm(o.path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(o.path, o.mode ?? 0o600);
  return {
    path: o.path,
    recheck,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(rechecking);
        for (const t of tunnels) t.cut();
        server.close(() => resolve());
        server.closeAllConnections?.();
        void rm(o.path, { force: true }).catch(() => {});
      }),
  };
}
