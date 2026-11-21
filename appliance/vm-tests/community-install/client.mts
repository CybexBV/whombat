/**
 * The community install test's client (IN-430, NX-445): the real `@whombat/client` of a Whombat checkout (`WHOMBAT_APP`),
 * driven from this machine against a community box over its direct port — the box's own page's ways in, nothing
 * re-implemented. The checkout must be as new as the box: a box refuses a client from before the claim's proof round
 * (`claim_update_app`). Run with the checkout's tsx
 * (it resolves the client's own imports):
 *
 *   $WHOMBAT_APP/node_modules/.bin/tsx vm-tests/community-install/client.mts <command> [flags]
 *
 *   identity --url http://H:P                         GET /v1/direct: the box's DirectIdentity (edition, claimed)
 *   claim --url … --letters ABCD --key FILE            the local claim (enroll.claim.local.*): a new endpoint key in FILE,
 *                                                     the first owner made; then the app channel opens with that key
 *                                                     (--same-device: the key already in FILE, as one device trying again)
 *   status --url … --key FILE                          appliance.status and host.tailscale as the owner
 *   tailscale-on --url … --key FILE --login-server U   host.tailscale.on with the owner's own login server
 *   tailscale --url … --key FILE                       host.tailscale (the state, the login link)
 *   tailscale-off --url … --key FILE                   host.tailscale.off with a sign-out (leaves the tailnet)
 *
 * `--proxy http://H:P` sends every connection through an HTTP CONNECT proxy (the second Tailscale client's outbound
 * proxy, to reach the box over the tailnet). `--connect H:P` dials H:P for every connection whatever `--url` names (QEMU's
 * port forward): the box answers only for its own addresses, so `--url` is the address its screen shows. Prints one
 * JSON object per command on stdout.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { parseArgs } from 'node:util';

const app = process.env.WHOMBAT_APP;
if (!app) throw new Error('WHOMBAT_APP: a Whombat checkout (or a whombat-app one ≥ 1.1) with its node_modules');
const session = await import(`${app}/packages/client/src/session/index.ts`);
const { secureChannelPort } = await import(`${app}/packages/client/src/session/secure-channel.ts`);
const { runLocalClaim } = await import(`${app}/packages/client/src/managed/community.ts`);
// The secure channel's own sources in Whombat; a whombat-app checkout has its vendored release's build.
const sc = await import(
  existsSync(`${app}/packages/secure-channel/package.json`)
    ? `${app}/packages/secure-channel/src/index.ts`
    : `${app}/node_modules/@whombat/secure-channel/dist/index.js`
);
// `ws` (the harness's) takes an agent, so a socket can go through the proxy; Node's own WebSocket can't.
const WS = (await import(new URL('../../harness/node_modules/ws/index.js', import.meta.url).href)).default;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    letters: { type: 'string' },
    key: { type: 'string' },
    'login-server': { type: 'string' },
    proxy: { type: 'string' },
    connect: { type: 'string' },
    'same-device': { type: 'boolean', default: false },
    name: { type: 'string', default: 'Test Owner' },
    email: { type: 'string', default: 'owner@example.test' },
  },
});
const command = positionals[0];
const base = (values.url ?? '').replace(/\/$/, '');
if (!base) throw new Error('--url http://host:port (the box’s direct port)');
const proxy = values.proxy ? new URL(values.proxy) : null;

/** An http.Agent that tunnels every connection through the HTTP CONNECT proxy. */
function tunnelAgent(p: URL): http.Agent {
  const agent = new http.Agent({ keepAlive: false });
  // biome-ignore lint/suspicious/noExplicitAny: Node's createConnection callback form
  (agent as any).createConnection = (o: { host: string; port: number }, cb: (e: Error | null, s?: unknown) => void) => {
    const req = http.request({ host: p.hostname, port: Number(p.port), method: 'CONNECT', path: `${o.host}:${o.port}` });
    req.on('connect', (res, socket) => (res.statusCode === 200 ? cb(null, socket) : cb(new Error(`proxy ${res.statusCode}`))));
    req.on('error', (e) => cb(e));
    req.end();
  };
  return agent;
}
/** An http.Agent that dials one fixed address (the URL's host stays in the request: the box checks it). */
function fixedAgent(hostPort: string): http.Agent {
  const [host, port] = hostPort.split(':');
  const agent = new http.Agent({ keepAlive: false });
  // biome-ignore lint/suspicious/noExplicitAny: Node's createConnection
  (agent as any).createConnection = (_o: unknown, cb: (e: Error | null, s?: unknown) => void) => {
    const s = net.connect(Number(port), host);
    s.once('connect', () => cb(null, s));
    s.once('error', (e) => cb(e));
  };
  return agent;
}
const agent = proxy ? tunnelAgent(proxy) : values.connect ? fixedAgent(values.connect) : undefined;

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${path}`, { agent, timeout: 20_000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function directIdentity(): Promise<{ v: number; appliance: string; edition?: string; claimed?: boolean }> {
  const r = await get('/v1/direct');
  if (r.status !== 200) throw new Error(`GET /v1/direct: ${r.status} ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body);
}

function open(identity: unknown, peerId: string, expect: 'app' | 'any') {
  const socketUrl = `${base.replace(/^http/, 'ws')}/v1/direct`;
  const connector = session.createDirectConnector({
    routes: () => [{ way: 'lan', socket: socketUrl, web: `${base}/` }],
    secure: secureChannelPort(),
    identity: async () => identity,
    appliance: { peerId },
    socket: (u: string, p: string) => (agent ? new WS(u, p, { agent }) : new WS(u, p)),
    dialTimeoutMs: 15_000,
    handshakeTimeoutMs: 30_000,
  });
  const s = session.createSecureSession({ connector, client: { build: 'whombat-community-install-test', platform: 'cli' }, expect });
  return s;
}

function whenOpen(s: { state(): { status: string; info?: unknown; reason?: string }; onState(f: (x: { status: string; info?: unknown; reason?: string; detail?: string }) => void): () => void; connect(): void }, ms = 60_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`not open after ${ms} ms: ${JSON.stringify(s.state())}`)), ms);
    const off = s.onState((st) => {
      if (st.status === 'open') {
        clearTimeout(t);
        off();
        resolve(st.info as Record<string, unknown>);
      } else if (st.status === 'closed') {
        clearTimeout(t);
        off();
        reject(new Error(`closed: ${st.reason} ${st.detail ?? ''}`));
      }
    });
    s.connect();
  });
}

function loadKey() {
  if (!values.key) throw new Error('--key FILE');
  return sc.deserializeIdentity(new Uint8Array(readFileSync(values.key)));
}

const out = (o: unknown) => console.log(JSON.stringify(o));
const started = Date.now();
const id = await directIdentity();
switch (command) {
  case 'identity':
    out({ identity: id, ms: Date.now() - started });
    break;
  case 'claim': {
    if (!values.letters || !values.key) throw new Error('claim needs --letters and --key');
    // One device trying again keeps its key: the box counts a device's tries by it.
    const again = values['same-device'] && existsSync(values.key);
    const identity = again ? loadKey() : await sc.generateIdentity();
    if (!again) writeFileSync(values.key, sc.serializeIdentity(identity), { mode: 0o600 });
    const s = open(identity, id.appliance, 'any');
    const info = await whenOpen(s);
    const enrolled = await runLocalClaim({
      session: s,
      letters: values.letters,
      appliancePeerId: id.appliance,
      clientPeerId: identity.peerId,
      account: { name: values.name ?? 'Test Owner', email: values.email ?? 'owner@example.test' },
      endpoint: { label: 'Install test', platform: 'cli' },
    });
    s.close();
    const app = open(identity, id.appliance, 'app');
    const appInfo = await whenOpen(app);
    const status = await session.sessionOps.applianceStatus(app);
    app.close();
    out({
      before: { channel: info.channel, edition: info.edition },
      enrolled: { account: (enrolled as { account?: unknown }).account, endpointId: (enrolled as { endpointId?: unknown }).endpointId },
      after: { channel: appInfo.channel, edition: appInfo.edition, account: appInfo.account },
      claimedNow: (await directIdentity()).claimed,
      status,
      ms: Date.now() - started,
    });
    break;
  }
  case 'status':
  case 'tailscale':
  case 'tailscale-off':
  case 'tailscale-on': {
    const s = open(loadKey(), id.appliance, 'app');
    const info = await whenOpen(s);
    let r: unknown;
    if (command === 'status') r = { status: await session.sessionOps.applianceStatus(s), tailscale: await session.sessionOps.hostTailscale(s) };
    else if (command === 'tailscale') r = await session.sessionOps.hostTailscale(s);
    else if (command === 'tailscale-off') r = await session.sessionOps.hostTailscaleOff(s, { signOut: true });
    else r = await session.sessionOps.hostTailscaleOn(s, { loginServer: values['login-server'] ?? null });
    s.close();
    out({ identity: id, channel: info.channel, edition: info.edition, via: proxy ? 'proxy' : 'direct', result: r, ms: Date.now() - started });
    break;
  }
  default:
    throw new Error(`unknown command ${command}`);
}
process.exit(0);
