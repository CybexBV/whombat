/**
 * Found on your network (`connections.discover`, docs/decisions/connections-setup.md CS-14): a scan of the home network
 * for the catalog's self-hosted services, devices and servers (computers that answer SSH, `found-servers.ts`), for the
 * burrow's managers.
 *
 * - **Where.** With the local network open (local-network.md LN-01): the private IPv4 networks of this Whombat's own
 *   interfaces (as they are up to a /22, else the /22 around its address, desk-found.md DF-13; container bridges left
 *   out), the /24 of every
 *   connection's host on a private IPv4 address (names resolved once), the home network list's IPv4 networks of at most
 *   1 024 addresses, and the networks asked for. With it closed: the home network list's networks on their listed
 *   ports only. Never this Whombat's own addresses, never an address outside the private ranges (LN-02).
 * - **How.** A TCP connect to each discovery port (the union of the catalog's targets) on each address, 256 at a time,
 *   400 ms each (a /22 in under a minute, DF-14); then, on each open port, the probes of every entry whose targets name
 *   that port (`finder.ts`, 3 s each, unauthenticated, the certificate read, never enforced on the home network).
 * - **When.** One scan per burrow at a time, in memory (lost on restart). A call during a scan answers it; a call after
 *   a scan younger than 10 minutes answers that one, unless it asks to `rescan` or names a network it didn't look in.
 *   What a scan found stays until the next one finishes. The call never waits for the scan: the app polls. The
 *   automatic scans (`found-scans.ts`, DF-02) start the same scan as the burrow (`scanBurrow`) and wait for it.
 * - **Already connected** (CS-52). A found service names the caller's connections of the same entry on its host (any
 *   port), or of an entry no scan finds (Custom API, Custom MCP) on its host and port; the app leaves those out.
 * - **Hidden** (CS-53). A manager hides a found service for the whole burrow (`connections.hideFound`, a signed
 *   `connection.found_hidden`); it stays hidden across scans and restarts until someone shows it again.
 */
import { connect } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  CATALOG_CONNECTABLE,
  type CatalogEntry,
  type ConnectionDiscovery,
  catalogEntry,
  classifyAddress,
  type DiscoverConnectionsBody,
  type DiscoveredService,
  discoveredUrl,
  FOUND_SERVER_ID,
  formatIpv4,
  foundServerUrl,
  type HideFoundServiceBody,
  type PresentedCertificate,
  parseCidr,
  parseIp,
  vaultNetworkProblem,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { connectionFoundHidden } from '../db/schema/index';
import { MODBUS_DISCOVERY_PORT, modbusUrl, probeModbusAt } from '../devices/discover';
import { DEVICE_CATALOG_ID } from '../devices/store';
import { forbidden } from '../lib/errors';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { vaultNetOf } from '../vault/net';
import { listedNetworks, localNetworkOpen } from '../vault/store';
import { setFoundHidden } from './commands';
import { connectionFieldError } from './errors';
import { type DiscoveryNet, discoveryNetOf, HostProbes } from './finder';
import {
  knownServers,
  probeSshAt,
  readSshBanner,
  SSH_DISCOVERY_PORT,
  serversAt,
  withoutDoubleServers,
} from './found-servers';
import { type ConnectionViewer, visibleConnections } from './store';

/** The entries a scan looks for. */
const FINDABLE: readonly CatalogEntry[] = CATALOG_CONNECTABLE.filter((e) => e.discovery);
const FINDABLE_IDS: ReadonlySet<string> = new Set(FINDABLE.map((e) => e.id));

/**
 * Every port some entry is found on (CS-14), Modbus TCP's for devices (one-whombat-devices.md ONE-DD14) and SSH's for
 * servers (connect-in-chat.md).
 */
export const DISCOVERY_PORTS: readonly number[] = [
  ...new Set([
    ...FINDABLE.flatMap((e) => e.discovery?.targets.map((t) => t.port) ?? []),
    MODBUS_DISCOVERY_PORT,
    SSH_DISCOVERY_PORT,
  ]),
].sort((a, b) => a - b);

/** What can be found: the catalog's findable entries, a device (`device`, over Modbus) and a server (over SSH). */
const FOUND_IDS: ReadonlySet<string> = new Set([...FINDABLE_IDS, DEVICE_CATALOG_ID, FOUND_SERVER_ID]);

const CONNECT_TIMEOUT_MS = 400;
/**
 * Connects at once (DF-14, DF-S01): a /22 with every discovery port is ~23 500 of them, most to addresses where nothing
 * answers (400 ms each), so 256 finish one in under 40 s; the addresses go one after another (~11 at a time), so the
 * network sees a few neighbours asked for at once, not hundreds.
 */
const CONCURRENCY = 256;
/** A scan this recent is answered instead of starting another. */
const FRESH_MS = 10 * 60_000;
/** The widest network looked in: a /22 (1 024 addresses). */
const WIDEST_PREFIX = 22;
const RESOLVE_TIMEOUT_MS = 1_500;
/** Networks people asked for, kept for the next scans. */
const ASKED_MAX = 8;
const NETWORKS_MAX = 64;
const FOUND_MAX = 200;
const CONNECTION_IDS_MAX = 30;

/** Interfaces that are this machine's own plumbing, not the home network: container and VM bridges (LN-02). */
const VIRTUAL_INTERFACE = /^(lo|incusbr|lxdbr|docker|br-|virbr|veth|cni|flannel|cali|kube|podman)/i;

/** A service a scan found: the entry, where, what its probes read. */
export interface Found {
  catalogId: string;
  host: string;
  port: number;
  url: string;
  version: string | null;
  certificate: PresentedCertificate | null;
}

interface Scan {
  startedAt: Date;
  finishedAt: Date | null;
  networks: string[];
  /** The networks asked for when it started. */
  asked: string[];
  done: number;
  total: number;
  found: Found[];
  /** Started or taken over by the automatic scans (DF-02): the screen shows the first one's progress (DF-07). */
  automatic: boolean;
}

interface BurrowScans {
  running: Scan | null;
  last: Scan | null;
  /** Networks people asked to look in, the newest first. */
  asked: string[];
  task: Promise<void> | null;
}

interface Registry {
  burrows: Map<string, BurrowScans>;
  /** Connection host names and the addresses they resolved to (the networks to look in; who is connected where). */
  names: Map<string, string[]>;
  abort: AbortController;
}

const registries = new WeakMap<Services, Registry>();

function registryOf(services: Services): Registry {
  let reg = registries.get(services);
  if (!reg) {
    reg = { burrows: new Map(), names: new Map(), abort: new AbortController() };
    registries.set(services, reg);
  }
  return reg;
}

function burrowOf(reg: Registry, burrowId: string): BurrowScans {
  let b = reg.burrows.get(burrowId);
  if (!b) {
    b = { running: null, last: null, asked: [], task: null };
    reg.burrows.set(burrowId, b);
  }
  return b;
}

/** Stops every scan (shutdown) and waits for them. */
export async function closeDiscovery(services: Services): Promise<void> {
  const reg = registries.get(services);
  if (!reg) return;
  reg.abort.abort();
  await Promise.allSettled([...reg.burrows.values()].map((b) => b.task));
}

/* Networks ------------------------------------------------------------------------------------------- */

/** A listed network if it is IPv4, canonical, with its prefix. */
function listedV4(cidr: string): { cidr: string; prefix: number } | null {
  const parsed = parseCidr(cidr);
  return parsed?.family === 4 ? { cidr: parsed.cidr, prefix: parsed.prefix } : null;
}

/** The /24 around a private IPv4 address, or null. */
function slash24(address: string): string | null {
  const ip = parseIp(address);
  if (ip?.family !== 4 || classifyAddress(ip) !== 'private') return null;
  return parseCidr(`${address}/24`)?.cidr ?? null;
}

/** A field error on the `i`th network asked for. */
function networkError(i: number, message: string) {
  return connectionFieldError({ [`networks.${i}`]: message }, message);
}

/**
 * The networks asked for (`body.networks`), canonical, each with where it was in the body: private IPv4, at most
 * 1 024 addresses (`validation_failed` otherwise).
 */
export function askedNetworks(texts: readonly string[]): { cidr: string; index: number }[] {
  const out: { cidr: string; index: number }[] = [];
  texts.forEach((text, i) => {
    const fail = (message: string) => networkError(i, message);
    const parsed = parseCidr(text);
    if (!parsed) throw fail('That isn’t a network. Write it like 192.168.1.0/24.');
    if (parsed.family !== 4) throw fail('Write an IPv4 network, like 192.168.1.0/24.');
    if (parsed.prefix < WIDEST_PREFIX)
      throw fail('That network is too wide to look in. Use a /22 or a narrower one.');
    if (vaultNetworkProblem(parsed.cidr, [80]) !== null)
      throw fail('Whombat looks only in private networks, like 192.168.1.0/24.');
    if (!out.some((n) => n.cidr === parsed.cidr)) out.push({ cidr: parsed.cidr, index: i });
  });
  return out;
}

/** Every address of this machine (never scanned). */
function ownAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): Set<string> {
  const own = new Set<string>();
  for (const list of Object.values(interfaces))
    for (const i of list ?? []) {
      const ip = parseIp(i.address.replace(/%.*$/, ''));
      if (ip) own.add(ip.family === 4 ? formatIpv4(ip.bytes) : i.address);
    }
  return own;
}

/**
 * The private IPv4 networks this machine is on (DF-13, amends CS-14): each as it is up to a /22, else the /22 around
 * the address (1 024 addresses, the widest a scan looks in); bridges and loopback left out.
 */
export function interfaceNetworks(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const i of list ?? []) {
      if (i.internal || i.family !== 'IPv4' || !i.cidr) continue;
      const own = parseCidr(i.cidr);
      const ip = parseIp(i.address);
      if (!own || !ip || classifyAddress(ip) !== 'private') continue;
      const cidr = parseCidr(`${i.address}/${Math.max(own.prefix, WIDEST_PREFIX)}`)?.cidr;
      if (cidr && !out.includes(cidr)) out.push(cidr);
    }
  }
  return out;
}

/** Whether network `inner` lies inside `outer` (both IPv4 CIDRs). */
function within(inner: string, outer: string): boolean {
  const a = parseCidr(inner);
  const b = parseCidr(outer);
  if (!a || !b || a.family !== 4 || b.family !== 4 || a.prefix < b.prefix) return false;
  return parseCidr(`${formatIpv4(a.bytes)}/${b.prefix}`)?.cidr === b.cidr;
}

/** The addresses to try in a network: every host address (not the network's own nor its broadcast address). */
function* hostsOf(cidr: string): Generator<string> {
  const n = parseCidr(cidr);
  if (n?.family !== 4) return;
  const base =
    ((n.bytes[0] ?? 0) << 24) | ((n.bytes[1] ?? 0) << 16) | ((n.bytes[2] ?? 0) << 8) | (n.bytes[3] ?? 0);
  const size = 2 ** (32 - n.prefix);
  const [first, last] = size > 2 ? [1, size - 2] : [0, size - 1];
  for (let i = first; i <= last; i++) {
    const v = (base + i) >>> 0;
    yield `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
  }
}

/** A host name's addresses, resolved once per scan, bounded so a dead resolver can't hold the call. */
async function resolveName(services: Services, name: string): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), RESOLVE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      vaultNetOf(services)
        .resolve(name)
        .then((found) => found.map((a) => a.address))
        .catch(() => []),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Endpoint {
  id: string;
  catalogId: string;
  host: string;
  port: number;
}

/** The host and port of an http(s) URL (the scheme's port when none is given), or null. */
function hostPort(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    const fallback =
      u.protocol === 'https:'
        ? 443
        : u.protocol === 'http:'
          ? 80
          : u.protocol === 'ssh:'
            ? SSH_DISCOVERY_PORT
            : 0;
    const port = Number(u.port || fallback);
    return port ? { host: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port } : null;
  } catch {
    return null;
  }
}

/** Where each connection calls: host and port of its base URL. */
function endpointsOf(rows: readonly { id: string; catalogId: string; baseUrl: string }[]): Endpoint[] {
  const out: Endpoint[] = [];
  for (const r of rows) {
    // A base URL that doesn't parse calls nowhere.
    const at = hostPort(r.baseUrl);
    if (at) out.push({ id: r.id, catalogId: r.catalogId, ...at });
  }
  return out;
}

/** Resolves the names among the hosts not resolved yet (`fresh`: all of them again). */
async function resolveNames(
  services: Services,
  reg: Registry,
  hosts: readonly string[],
  fresh: boolean,
): Promise<void> {
  const names = [...new Set(hosts.filter((h) => !parseIp(h) && (fresh || !reg.names.has(h))))];
  const found = await Promise.all(names.map((n) => resolveName(services, n)));
  names.forEach((n, i) => {
    reg.names.set(n, found[i] ?? []);
  });
}

interface Plan {
  networks: { cidr: string; ports: number[] }[];
}

/** Where this scan looks (CS-14), and on which ports. */
async function planScan(
  services: Services,
  viewer: ConnectionViewer | null,
  reg: Registry,
  asked: readonly string[],
): Promise<Plan> {
  const [lan, listed, rows] = await Promise.all([
    localNetworkOpen(services),
    listedNetworks(services.db),
    viewer ? visibleConnections(services.db, viewer) : Promise.resolve([]),
  ]);
  const endpoints = endpointsOf(rows);
  await resolveNames(
    services,
    reg,
    endpoints.map((e) => e.host),
    true,
  );
  const networks: Plan['networks'] = [];
  const add = (cidr: string | null | undefined, ports: readonly number[]) => {
    if (!cidr || ports.length === 0) return;
    const known = networks.find((n) => n.cidr === cidr);
    if (known) known.ports = [...new Set([...known.ports, ...ports])].sort((a, b) => a - b);
    else if (networks.length < NETWORKS_MAX) networks.push({ cidr, ports: [...ports] });
  };
  const home = listed
    .map((n) => ({ net: listedV4(n.cidr), ports: n.ports.filter((p) => DISCOVERY_PORTS.includes(p)) }))
    .filter((n): n is { net: { cidr: string; prefix: number }; ports: number[] } => n.net !== null);
  if (lan) {
    for (const cidr of interfaceNetworks(discoveryNetOf(services).interfaces())) add(cidr, DISCOVERY_PORTS);
    for (const e of endpoints)
      for (const address of parseIp(e.host) ? [e.host] : (reg.names.get(e.host) ?? []))
        add(slash24(address), DISCOVERY_PORTS);
    for (const n of home) if (n.net.prefix >= WIDEST_PREFIX) add(n.net.cidr, DISCOVERY_PORTS);
    for (const cidr of asked) add(cidr, DISCOVERY_PORTS);
  } else {
    // The local network closed (LN-03): the list's networks on their listed ports, and asked networks inside them.
    for (const n of home) if (n.net.prefix >= WIDEST_PREFIX) add(n.net.cidr, n.ports);
    for (const cidr of asked) for (const n of home) if (within(cidr, n.net.cidr)) add(cidr, n.ports);
  }
  return { networks };
}

/* The scan ------------------------------------------------------------------------------------------- */

/** Whether something accepts a TCP connection at `address`:`port` within 400 ms. */
function portOpen(net: DiscoveryNet, address: string, port: number): Promise<boolean> {
  const target = net.dial ? net.dial(address, port) : { address, port };
  if (!target) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: target.address, port: target.port });
    const finish = (open: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Every entry found on an open port: each entry whose targets name the port, each of its schemes there in turn. */
async function probePort(probes: HostProbes, scan: Scan, address: string, port: number): Promise<void> {
  await Promise.all(
    FINDABLE.map(async (entry) => {
      for (const target of entry.discovery?.targets ?? []) {
        if (target.port !== port) continue;
        const url = discoveredUrl(target.scheme, address, port);
        const r = await probes.entryAt(entry, url);
        if (!r.matched) continue;
        const known = scan.found.some(
          (f) => f.catalogId === entry.id && f.host === address && f.port === port,
        );
        if (!known && scan.found.length < FOUND_MAX)
          scan.found.push({
            catalogId: entry.id,
            host: address,
            port,
            url,
            version: r.version,
            certificate: r.certificate,
          });
        return;
      }
    }),
  );
}

/** A Modbus TCP device on an open 502 (ONE-DD14): found as a `device` Whombat can learn. */
async function probeModbus(net: DiscoveryNet, scan: Scan, address: string, port: number): Promise<void> {
  const target = net.dial ? net.dial(address, port) : { address, port };
  if (!target) return;
  const found = await probeModbusAt(target.address, target.port);
  if (!found || scan.found.length >= FOUND_MAX) return;
  if (scan.found.some((f) => f.catalogId === DEVICE_CATALOG_ID && f.host === address && f.port === port))
    return;
  scan.found.push({
    catalogId: DEVICE_CATALOG_ID,
    host: address,
    port,
    url: modbusUrl(address, port),
    version: found.version,
    certificate: null,
  });
}

/** A computer that answers SSH on an open 22 (connect-in-chat.md): found as a server to add, its system named. */
async function probeSsh(net: DiscoveryNet, scan: Scan, address: string, port: number): Promise<void> {
  const line = await probeSshAt(net, address, port);
  const banner = line === null ? null : readSshBanner(line);
  if (!banner || scan.found.length >= FOUND_MAX) return;
  if (scan.found.some((f) => f.catalogId === FOUND_SERVER_ID && f.host === address && f.port === port))
    return;
  scan.found.push({
    catalogId: FOUND_SERVER_ID,
    host: address,
    port,
    url: foundServerUrl(address, port),
    version: banner.system,
    certificate: null,
  });
}

async function runScan(
  services: Services,
  reg: Registry,
  b: BurrowScans,
  scan: Scan,
  units: readonly { address: string; ports: readonly number[] }[],
): Promise<void> {
  const net = discoveryNetOf(services);
  const pairs = units.flatMap((u) => u.ports.map((port) => ({ address: u.address, port })));
  const hosts = new Map<string, HostProbes>();
  let next = 0;
  const worker = async () => {
    while (!reg.abort.signal.aborted) {
      const pair = pairs[next++];
      if (!pair) return;
      try {
        if (pair.port === MODBUS_DISCOVERY_PORT) {
          if (await portOpen(net, pair.address, pair.port))
            await probeModbus(net, scan, pair.address, pair.port);
        } else if (pair.port === SSH_DISCOVERY_PORT) {
          if (await portOpen(net, pair.address, pair.port))
            await probeSsh(net, scan, pair.address, pair.port);
        } else if (await portOpen(net, pair.address, pair.port)) {
          let probes = hosts.get(pair.address);
          if (!probes) {
            probes = new HostProbes(services);
            hosts.set(pair.address, probes);
          }
          await probePort(probes, scan, pair.address, pair.port);
        }
      } catch (err) {
        services.log.warn({ err: String(err) }, 'connections discover: a probe failed');
      }
      scan.done++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, worker));
  } finally {
    scan.finishedAt = services.clock();
    scan.done = scan.total;
    b.last = scan;
    b.running = null;
    b.task = null;
  }
}

/** Starts a scan of the plan (synchronously marks it running: no second one starts meanwhile). */
function startScan(
  services: Services,
  reg: Registry,
  b: BurrowScans,
  plan: Plan,
  asked: readonly string[],
): void {
  const own = ownAddresses(discoveryNetOf(services).interfaces());
  const ports = new Map<string, Set<number>>();
  for (const n of plan.networks)
    for (const address of hostsOf(n.cidr)) {
      const ip = parseIp(address);
      if (!ip || classifyAddress(ip) !== 'private' || own.has(address)) continue;
      let set = ports.get(address);
      if (!set) {
        set = new Set();
        ports.set(address, set);
      }
      for (const p of n.ports) set.add(p);
    }
  const units = [...ports].map(([address, set]) => ({ address, ports: [...set].sort((x, y) => x - y) }));
  const scan: Scan = {
    startedAt: services.clock(),
    finishedAt: null,
    networks: plan.networks.map((n) => n.cidr),
    asked: [...asked],
    done: 0,
    total: units.reduce((sum, u) => sum + u.ports.length, 0),
    found: [],
    automatic: false,
  };
  b.running = scan;
  b.task = runScan(services, reg, b, scan, units).catch((err: unknown) => {
    services.log.warn({ err: String(err) }, 'connections discover: the scan failed');
  });
}

/* The answer ----------------------------------------------------------------------------------------- */

/** One found service's identity: entry, host and port (CS-D26). */
function foundKey(f: { catalogId: string; host: string; port: number }): string {
  return `${f.catalogId} ${f.host} ${f.port}`;
}

/** Numeric order of IPv4 addresses. */
export function addressKey(address: string): number {
  const ip = parseIp(address);
  if (ip?.family !== 4) return Number.MAX_SAFE_INTEGER;
  return ip.bytes.reduce((n, b) => n * 256 + b, 0);
}

/** What the running scan found so far, with what the last one found that it hasn't yet (CS-14). */
function foundWhileRunning(running: Scan, last: Scan | null): Found[] {
  const found = [...running.found];
  for (const f of last?.found ?? [])
    if (!found.some((g) => g.catalogId === f.catalogId && g.host === f.host && g.port === f.port))
      found.push(f);
  return withoutDoubleServers(found);
}

/** Whether a found service is connected for a viewer (CS-52) or hidden for the burrow (CS-53), read once. */
interface FoundFor {
  /** The viewer's connections of the same entry on its host (any port), or of a custom one on its host and port. */
  connectedAt(f: Found): string[];
  hidden(f: Found): boolean;
  /** The Whombat's servers at a found server's host, or an entry's best added as a server (connect-in-chat.md). */
  serversAt(f: Found): string[];
}

async function foundFor(services: Services, viewer: ConnectionViewer, reg: Registry): Promise<FoundFor> {
  const [rows, servers] = await Promise.all([
    visibleConnections(services.db, viewer),
    knownServers(services),
  ]);
  const endpoints = endpointsOf(rows);
  await resolveNames(
    services,
    reg,
    endpoints.map((e) => e.host),
    false,
  );
  const hidden = new Set(
    (
      await services.db
        .select({
          catalogId: connectionFoundHidden.catalogId,
          host: connectionFoundHidden.host,
          port: connectionFoundHidden.port,
        })
        .from(connectionFoundHidden)
        .where(eq(connectionFoundHidden.burrowId, viewer.burrowId))
    ).map(foundKey),
  );
  return {
    connectedAt: (f) =>
      endpoints
        .filter(
          (e) =>
            (e.catalogId === f.catalogId || (!FINDABLE_IDS.has(e.catalogId) && e.port === f.port)) &&
            (e.host === f.host || (!parseIp(e.host) && reg.names.get(e.host)?.includes(f.host))),
        )
        .map((e) => e.id)
        .slice(0, CONNECTION_IDS_MAX),
    hidden: (f) => hidden.has(foundKey(f)),
    serversAt: (f) => serversAt(f, servers).slice(0, CONNECTION_IDS_MAX),
  };
}

async function answer(
  services: Services,
  viewer: ConnectionViewer,
  reg: Registry,
  b: BurrowScans,
): Promise<ConnectionDiscovery> {
  // Read the state before anything waits: the scan goes on meanwhile.
  const running = b.running;
  const scan = running ?? b.last;
  if (!scan)
    return { state: 'idle', progress: null, startedAt: null, finishedAt: null, networks: [], found: [] };
  // While a scan runs, what the last one found stays (CS-14) next to what this one found so far.
  const found = running ? foundWhileRunning(running, b.last) : withoutDoubleServers(scan.found);
  const progress = running ? { done: Math.min(running.done, running.total), total: running.total } : null;
  const order = new Map(FINDABLE.map((e, i) => [e.id, i]));
  found.sort(
    (x, y) =>
      addressKey(x.host) - addressKey(y.host) ||
      x.port - y.port ||
      (order.get(x.catalogId) ?? 0) - (order.get(y.catalogId) ?? 0),
  );
  // Already connected (CS-52) and hidden (CS-53).
  const seen = await foundFor(services, viewer, reg);
  const list: DiscoveredService[] = found.slice(0, FOUND_MAX).map((f) => ({
    catalogId: f.catalogId,
    url: f.url,
    host: f.host,
    version: f.version,
    certificate: f.certificate,
    connectionIds: seen.connectedAt(f),
    hidden: seen.hidden(f),
    serverIds: seen.serversAt(f),
  }));
  return {
    state: running ? 'scanning' : 'done',
    progress,
    startedAt: iso(scan.startedAt),
    finishedAt: running || !scan.finishedAt ? null : iso(scan.finishedAt),
    networks: scan.networks.slice(0, NETWORKS_MAX),
    found: list,
  };
}

/**
 * Starts a scan for the burrow as `viewer` plans it, unless one runs (never two at once) or, without `force`, the last
 * finished less than 10 minutes ago. Plans with the networks asked for so far.
 */
async function ensureScan(
  services: Services,
  viewer: ConnectionViewer | null,
  reg: Registry,
  b: BurrowScans,
  force: boolean,
): Promise<void> {
  if (b.running || reg.abort.signal.aborted) return;
  const last = b.last;
  const stale = !last?.finishedAt || services.clock().getTime() - last.finishedAt.getTime() >= FRESH_MS;
  if (!force && !stale) return;
  const plan = await planScan(services, viewer, reg, b.asked);
  // Another call may have started one while this one planned: never two at once.
  if (!b.running && !reg.abort.signal.aborted) startScan(services, reg, b, plan, b.asked);
}

/**
 * `connections.discover` (CS-14): starts a scan when there is none, the last is older than 10 minutes, `rescan` is set
 * or a network asked for wasn't looked in; answers the running or last scan right away. Managers only.
 */
export async function discoverConnections(
  services: Services,
  viewer: ConnectionViewer,
  body: z.output<typeof DiscoverConnectionsBody>,
): Promise<ConnectionDiscovery> {
  const networks = askedNetworks(body.networks);
  if (networks.length > 0 && !(await localNetworkOpen(services))) {
    // The local network closed (LN-03): only networks inside the home network list (CS-D25).
    const listed = (await listedNetworks(services.db)).map((n) => n.cidr);
    for (const n of networks)
      if (!listed.some((outer) => within(n.cidr, outer)))
        throw networkError(
          n.index,
          'With the local network closed, Whombat looks only in the home network list. Add this network there first.',
        );
  }
  const asked = networks.map((n) => n.cidr);
  const reg = registryOf(services);
  const b = burrowOf(reg, viewer.burrowId);
  if (!b.running && !reg.abort.signal.aborted) {
    b.asked = [...asked, ...b.asked.filter((n) => !asked.includes(n))].slice(0, ASKED_MAX);
    const unseen = asked.some((n) => !b.last?.asked.includes(n));
    await ensureScan(services, viewer, reg, b, body.rescan || unseen);
  }
  return answer(services, viewer, reg, b);
}

/* The burrow's own scans (desk-found.md DF-02, DF-03) -------------------------------------------------- */

/**
 * A scan as the burrow (DF-02): the running one, else the last when it finished less than 10 minutes ago, else a new
 * one planned as `viewer` (the person DF-03 names: their connections' networks count). Marks it `automatic`, waits for
 * it and answers the scan that holds the result, or null when none ran or the shutdown cut it short.
 */
export async function scanBurrow(services: Services, viewer: ConnectionViewer): Promise<FinishedScan | null> {
  const reg = registryOf(services);
  const b = burrowOf(reg, viewer.burrowId);
  await ensureScan(services, viewer, reg, b, false);
  const running = b.running;
  if (running) {
    running.automatic = true;
    await b.task;
  }
  // A scan cut short by the shutdown isn't a result.
  if (reg.abort.signal.aborted) return null;
  const last = b.last;
  return last?.finishedAt ? { finishedAt: last.finishedAt, found: withoutDoubleServers(last.found) } : null;
}

/** The registry's key of the box's own scans, made before there is a burrow (never a burrow id: those are `brw_…`). */
const BOX_SCANS = '(box)';

/**
 * A scan as the box itself, for a Whombat with no burrow or person yet (right after its claim, a bring back looking for
 * its backups on the network): the networks of its own interfaces and the home network list, no connections. The
 * running one, else the last when it finished less than 10 minutes ago, else a new one; waits for it. Null when none
 * ran or the shutdown cut it short.
 */
export async function scanAsBox(services: Services): Promise<FinishedScan | null> {
  const reg = registryOf(services);
  const b = burrowOf(reg, BOX_SCANS);
  await ensureScan(services, null, reg, b, false);
  if (b.task) await b.task;
  if (reg.abort.signal.aborted) return null;
  const last = b.last;
  return last?.finishedAt ? { finishedAt: last.finishedAt, found: withoutDoubleServers(last.found) } : null;
}

/** What the box's own scans hold now (`burrowFound` for `scanAsBox`'s). */
export function boxFound(services: Services): BurrowFound {
  return burrowFound(services, BOX_SCANS);
}

/**
 * Tests only: the burrow's last scan as if it had just finished with `found` (the welcome and the assistant's message
 * read it). Refused outside `NODE_ENV=test`.
 */
export function finishScanForTests(services: Services, burrowId: string, found: Found[], at: Date): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('Finishing a scan by hand is for tests only.');
  const b = burrowOf(registryOf(services), burrowId);
  b.last = {
    startedAt: at,
    finishedAt: at,
    networks: [],
    asked: [],
    done: 0,
    total: 0,
    found,
    automatic: true,
  };
}

/** A finished scan's result. */
export interface FinishedScan {
  finishedAt: Date;
  found: Found[];
}

/** What the burrow's scans hold now, for the screen (DF-03, DF-07): read from memory, never waits. */
export interface BurrowFound {
  /** The scan running now: whether it is the automatic scans', how far it is, what it found so far (with the last's). */
  running: { automatic: boolean; done: number; total: number; found: Found[] } | null;
  /** The last finished scan. */
  last: FinishedScan | null;
}

export function burrowFound(services: Services, burrowId: string): BurrowFound {
  const b = registries.get(services)?.burrows.get(burrowId);
  const running = b?.running ?? null;
  const last = b?.last?.finishedAt
    ? { finishedAt: b.last.finishedAt, found: withoutDoubleServers(b.last.found) }
    : null;
  return {
    running: running
      ? {
          automatic: running.automatic,
          done: Math.min(running.done, running.total),
          total: running.total,
          found: foundWhileRunning(running, b?.last ?? null),
        }
      : null,
    last,
  };
}

/**
 * Which found services are new for a viewer (DF-03): not connected for them (CS-52) and not hidden for the burrow
 * (CS-53). Reads their connections and the hidden list once; the test it answers is pure.
 */
export async function newFoundTest(
  services: Services,
  viewer: ConnectionViewer,
): Promise<(f: Found) => boolean> {
  const seen = await foundFor(services, viewer, registryOf(services));
  return (f) =>
    FOUND_IDS.has(f.catalogId) &&
    seen.connectedAt(f).length === 0 &&
    seen.serversAt(f).length === 0 &&
    !seen.hidden(f);
}

/**
 * `connections.hideFound` (CS-53): hides the entry at the url's host and port from Found on your network, or shows it
 * again, for the whole burrow; answers the running or last scan without starting one. Managers only.
 */
export async function hideFoundService(
  services: Services,
  viewer: ConnectionViewer,
  body: z.output<typeof HideFoundServiceBody>,
): Promise<ConnectionDiscovery> {
  const server = body.catalogId === FOUND_SERVER_ID;
  const entry = server
    ? { id: FOUND_SERVER_ID, name: 'Server' }
    : (FINDABLE.find((e) => e.id === body.catalogId) ??
      (body.catalogId === DEVICE_CATALOG_ID ? catalogEntry(DEVICE_CATALOG_ID) : null));
  if (!entry || !FOUND_IDS.has(entry.id))
    throw connectionFieldError({ catalogId: 'Whombat doesn’t look for that on your network.' });
  const at = hostPort(body.url);
  const ip = at ? parseIp(at.host) : null;
  if (!at || ip?.family !== 4 || classifyAddress(ip) !== 'private')
    throw connectionFieldError({ url: 'That isn’t an address on your network.' });
  const done = await services.pipeline.commit(
    setFoundHidden,
    {
      catalogId: entry.id,
      name: entry.name,
      url: server
        ? foundServerUrl(at.host, at.port)
        : entry.id === DEVICE_CATALOG_ID
          ? modbusUrl(at.host, at.port)
          : discoveredUrl(body.url.startsWith('https:') ? 'https' : 'http', at.host, at.port),
      host: at.host,
      port: at.port,
      hidden: body.hidden,
    },
    { burrowId: viewer.burrowId, actorId: viewer.principal.id },
  );
  // Only a person hides a found service: anything but ok means it wasn't one.
  if (done.status !== 'ok') throw forbidden('Only you can hide a found service.');
  const reg = registryOf(services);
  return answer(services, viewer, reg, burrowOf(reg, viewer.burrowId));
}
