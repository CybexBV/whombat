/**
 * What a connection runs on (connection-pages.md CP-08; connection-pages-server.md CP-S04…CP-S06): a server Whombat
 * watches, or one of its guests. A person's choice comes first (`catalog_connections.runs_on`: nothing Whombat watches,
 * or a server or guest); otherwise Whombat finds it by the connection's address in an index of the servers' and their
 * running guests' addresses — a server's address and those of its network cards, a guest's `addresses`, and for Proxmox
 * guests (the hosts service lists them without addresses) the configured `ip=` of their `net<n>` and `ipconfig<n>`
 * lines — kept 10 minutes, the last one
 * serving while a new one is built (page-speed.md PS-03). A guest matches before its server. Reads that fail are skipped: an index with less in it, never an error on the page.
 *
 * The machine's figures for a page (`readMachine`): a guest's CPU, memory and disk (the Proxmox configuration's disk size
 * for the total), a server's from the fleet, and their metrics over the page's range (dashboards.md DS-10), kept 30
 * seconds per machine and range, the last ones serving while new ones are slow (PS-03).
 */
import { BlockList, isIP } from 'node:net';
import { catalogEntry, type HostGuest, type HostServer, type ThingRunsOn, thingHref } from '@whombat/core';
import type { CatalogConnectionRow } from '../connections/types';
import type { StoredRunsOn } from '../db/schema/index';
import { HOSTS_API, seg } from '../hosts/client';
import { arr, obj, toHostBackupJob, toHostGuest, toHostServer } from '../hosts/map';
import { type HostsService, hostsFor, WHOMBAT_ACTOR } from '../hosts/service';
import type { Services } from '../services';
import { resolveHost } from '../vault/net';
import { backupRhythm } from './backup-rhythm';
import { PAGE_WAIT_MS } from './kinds/read';
import type { PageRange } from './series';
import { list, num, rec, str } from './words';

/** How long the address index is kept. */
export const RUNS_ON_TTL_MS = 10 * 60_000;
/** Proxmox guest configurations read for one index (the rest wait for the next). */
const CONFIG_READS_MAX = 60;

/** A server or guest and the addresses it answers on. */
export interface Machine {
  serverId: string;
  guestId: string | null;
  /** “pve-02 · CT 131”, “pve-02”. */
  name: string;
  addresses: string[];
  /** A server's own hostname as its agent reports it (“BlackBox”), when known (sidebar.md SB-09). */
  hostname?: string;
}

export interface AddressIndex {
  machines: Machine[];
  /** Server ids in the fleet's order. */
  servers: string[];
}

/** The addresses in a Proxmox guest's configuration: `ip=` of `net<n>` (containers) and `ipconfig<n>` (VMs). */
export function configAddresses(values: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!/^(net|ipconfig)\d+$/.test(key) || typeof value !== 'string') continue;
    for (const part of value.split(',')) {
      const m = /^(ip6?)=(.+)$/.exec(part.trim());
      const ip = m?.[2]?.split('/')[0]?.trim();
      if (ip && isIP(ip)) out.push(ip);
    }
  }
  return out;
}

/** Addresses that never tell one machine from another: loopback and link-local. */
const NOT_THE_MACHINE = new BlockList();
NOT_THE_MACHINE.addSubnet('127.0.0.0', 8, 'ipv4');
NOT_THE_MACHINE.addSubnet('169.254.0.0', 16, 'ipv4');
NOT_THE_MACHINE.addAddress('::1', 'ipv6');
NOT_THE_MACHINE.addSubnet('fe80::', 10, 'ipv6');

/**
 * The addresses of a server's network cards (its detail's `network`, CIDR cut), without loopback and link-local ones:
 * a server with two cards answers on both, while its agent reports one as the server's address.
 */
export function nicAddresses(network: unknown): string[] {
  const out: string[] = [];
  for (const nic of arr(network))
    for (const a of arr(obj(nic).addresses)) {
      const ip = typeof a === 'string' ? normal(a.split('/')[0] ?? '') : '';
      const family = isIP(ip);
      if (family && !NOT_THE_MACHINE.check(ip, family === 4 ? 'ipv4' : 'ipv6')) out.push(ip);
    }
  return out;
}

/**
 * A guest as a person names it beside its server: its own name (“homeassistant”); Proxmox's number (“CT 131”) only for
 * one without a name, since the numbers mean nothing to most people.
 */
export function guestLabel(g: Pick<HostGuest, 'platform' | 'kind' | 'vmid' | 'name' | 'id'>): string {
  if (g.name) return g.name;
  if (g.platform === 'pve' && typeof g.vmid === 'number') return `${g.kind === 'vm' ? 'VM' : 'CT'} ${g.vmid}`;
  return g.id;
}

/** A guest with its server, as a line says where something runs: “homeassistant (pve-02)”. */
export function guestOnServer(serverId: string, label: string): string {
  return `${label} (${serverId})`;
}

/** The page of a server or of one of its guests (`?guest=` on the server's page). */
export function machineHref(serverId: string, guestId: string | null): string {
  const server = thingHref('server', serverId);
  return guestId ? `${server}?guest=${encodeURIComponent(guestId)}` : server;
}

/** An address as compared: lower case, without brackets or a zone. */
function normal(address: string): string {
  return address
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
}

/** The machine answering on one of `addresses`: a guest before its server. */
export function matchMachine(index: AddressIndex, addresses: readonly string[]): Machine | null {
  const wanted = new Set(addresses.map(normal));
  const hits = index.machines.filter((m) => m.addresses.some((a) => wanted.has(normal(a))));
  return hits.find((m) => m.guestId !== null) ?? hits[0] ?? null;
}

/** A host name as compared: lower case, its first label (`BlackBox.local` → `blackbox`). */
function bareName(name: string): string {
  return name.trim().toLowerCase().split('.')[0] ?? '';
}

/**
 * The server called `name` (its hostname, else its id; case and a domain ignored), when exactly one is (SB-09): a
 * service that names its own machine finds it when its address isn't the one the server reports.
 */
export function matchServerName(index: AddressIndex, name: string): Machine | null {
  const raw = name.trim().replace(/^\[|\]$/g, '');
  if (!raw || isIP(raw)) return null;
  const wanted = bareName(raw);
  if (!wanted) return null;
  const servers = index.machines.filter((m) => m.guestId === null);
  const hits = servers.filter((m) => bareName(m.hostname ?? m.serverId) === wanted);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** Builds the index from the hosts service (reads that fail are left out). */
export async function buildAddressIndex(hosts: HostsService): Promise<AddressIndex> {
  const fleet = await hosts.fleetRaw();
  const servers = arr(fleet.servers)
    .map((s) => str(obj(s).id))
    .filter((id): id is string => !!id);
  let configBudget = CONFIG_READS_MAX;
  const perServer = await Promise.all(
    servers.map(async (serverId): Promise<{ machines: Machine[]; nics: string[] }> => {
      const out: Machine[] = [];
      const detail = await hosts
        .call<unknown>({ path: `${HOSTS_API}/servers/${seg(serverId)}`, actor: WHOMBAT_ACTOR })
        .catch(() => null);
      const address = str(obj(obj(detail).server).address);
      const hostname = str(obj(obj(detail).server).hostname);
      out.push({
        serverId,
        guestId: null,
        name: serverId,
        addresses: address ? [address] : [],
        ...(hostname ? { hostname } : {}),
      });
      const nics = nicAddresses(obj(detail).network);
      const guests = (await hosts.guestsRaw(serverId).catch(() => [])).map((g) => toHostGuest(g, serverId));
      for (const g of guests) {
        if (g.state !== 'running') continue;
        let addresses = (g.addresses ?? []).map((a) => a.split('/')[0] ?? a).filter((a) => isIP(normal(a)));
        if (!addresses.length && g.platform === 'pve' && configBudget > 0) {
          configBudget--;
          const config = await hosts
            .call<unknown>({
              path: `${HOSTS_API}/servers/${seg(serverId)}/guests/${seg(g.id)}/config`,
              actor: { ...WHOMBAT_ACTOR, role: 'operator' },
            })
            .catch(() => null);
          addresses = configAddresses(rec(rec(config).values));
        }
        if (addresses.length)
          out.push({ serverId, guestId: g.id, name: guestOnServer(serverId, guestLabel(g)), addresses });
      }
      return { machines: out, nics };
    }),
  );
  // A card's address that more than one server has (Docker's 172.17.0.1, libvirt's 192.168.122.1) is nobody's.
  const servedBy = new Map<string, number>();
  for (const s of perServer) for (const a of new Set(s.nics)) servedBy.set(a, (servedBy.get(a) ?? 0) + 1);
  for (const { machines, nics } of perServer) {
    const server = machines[0];
    if (server)
      server.addresses = [...new Set([...server.addresses, ...nics.filter((a) => servedBy.get(a) === 1)])];
  }
  return { machines: perServer.flatMap((s) => s.machines), servers };
}

interface CachedIndex {
  at: number;
  value: Promise<AddressIndex>;
  settled: AddressIndex | null;
}

const indexes = new WeakMap<HostsService, CachedIndex>();

/** The hosts service, when it watches this burrow's servers; null otherwise. */
export async function hostsServing(services: Services, burrowId: string): Promise<HostsService | null> {
  const hosts = hostsFor(services);
  if (!hosts.present) return null;
  return (await hosts.serves(burrowId).catch(() => false)) ? hosts : null;
}

/**
 * The address index (cached 10 minutes). Past that the last one serves while a new one is built (page-speed.md PS-03):
 * only the first build is waited for. A failed build isn't kept; the last one then serves until the next try.
 */
export function addressIndex(hosts: HostsService, now = Date.now()): Promise<AddressIndex> {
  const hit = indexes.get(hosts);
  if (hit && now - hit.at <= RUNS_ON_TTL_MS) return hit.settled ? Promise.resolve(hit.settled) : hit.value;
  const last = hit?.settled ?? null;
  const entry: CachedIndex = { at: now, value: buildAddressIndex(hosts), settled: last };
  indexes.set(hosts, entry);
  entry.value.then(
    (v) => {
      entry.settled = v;
    },
    () => {
      if (indexes.get(hosts) === entry && !last) indexes.delete(hosts);
    },
  );
  return last ? Promise.resolve(last) : entry.value;
}

/** The index when it is built already (Home doesn't wait for it); starts a build when there is none. */
export function addressIndexIfReady(hosts: HostsService): AddressIndex | null {
  const hit = indexes.get(hosts);
  if (!hit || Date.now() - hit.at > RUNS_ON_TTL_MS) {
    addressIndex(hosts).catch(() => undefined);
    return hit?.settled ?? null;
  }
  return hit.settled;
}

/** The host a connection talks to, when a person typed its address (a fixed public API has none to match). */
export function connectionHostname(
  row: Pick<CatalogConnectionRow, 'catalogId' | 'baseUrl' | 'fields'>,
): string | null {
  const entry = catalogEntry(row.catalogId);
  const typed = row.fields?.url ?? (entry?.fields.some((f) => f.id === 'url') ? row.baseUrl : null);
  if (!typed && entry?.baseUrl && !entry.baseUrl.includes('{')) return null;
  try {
    return normal(new URL(typed ?? row.baseUrl).hostname) || null;
  } catch {
    return null;
  }
}

/** The addresses a connection reaches: its IP, or what its host name resolves to now. */
export async function connectionAddresses(
  services: Services,
  row: Pick<CatalogConnectionRow, 'catalogId' | 'baseUrl' | 'fields'>,
): Promise<string[]> {
  const host = connectionHostname(row);
  if (!host) return [];
  if (isIP(host)) return [host];
  return resolveHost(services, `https://${host}/`);
}

/** Where a connection runs, and how Whombat knows. */
export interface ResolvedMachine {
  runsOn: ThingRunsOn;
  serverId: string;
  guestId: string | null;
}

/**
 * What a connection runs on for a page: the person's choice, else found by its address; null when it runs on nothing
 * Whombat watches here (or this burrow doesn't see servers).
 */
export async function resolveRunsOn(
  services: Services,
  burrowId: string,
  row: Pick<CatalogConnectionRow, 'catalogId' | 'baseUrl' | 'fields' | 'runsOn'>,
): Promise<ResolvedMachine | null> {
  const stored = row.runsOn as StoredRunsOn | null;
  if (stored?.mode === 'none') return null;
  const hosts = await hostsServing(services, burrowId);
  if (!hosts) return null;
  if (stored?.mode === 'chosen') {
    const index = await addressIndex(hosts).catch(() => null);
    const known = index?.machines.find((m) => m.serverId === stored.serverId && m.guestId === stored.guestId);
    const name = known?.name ?? (await chosenName(hosts, stored.serverId, stored.guestId));
    return {
      serverId: stored.serverId,
      guestId: stored.guestId,
      runsOn: {
        serverId: stored.serverId,
        guestId: stored.guestId,
        name: name.slice(0, 120),
        href: machineHref(stored.serverId, stored.guestId),
        how: 'chosen',
      },
    };
  }
  const [index, addresses] = await Promise.all([
    addressIndex(hosts),
    connectionAddresses(services, row).catch(() => []),
  ]);
  const found = addresses.length ? matchMachine(index, addresses) : null;
  if (!found) return null;
  return {
    serverId: found.serverId,
    guestId: found.guestId,
    runsOn: {
      serverId: found.serverId,
      guestId: found.guestId,
      name: found.name.slice(0, 120),
      href: machineHref(found.serverId, found.guestId),
      how: 'address',
    },
  };
}

/** A chosen machine's name when the index doesn't list it (a stopped guest): from its guest list, else its ids. */
async function chosenName(hosts: HostsService, serverId: string, guestId: string | null): Promise<string> {
  if (!guestId) return serverId;
  const raw = (await hosts.guestsRaw(serverId).catch(() => [])).find((g) => obj(g).id === guestId);
  return guestOnServer(serverId, raw ? guestLabel(toHostGuest(raw, serverId)) : guestId);
}

/** Whether a server, or a guest of it, is one Whombat watches (a choice must name one). */
export async function machineExists(
  hosts: HostsService,
  serverId: string,
  guestId: string | null,
): Promise<boolean> {
  const fleet = await hosts.fleetRaw();
  if (!arr(fleet.servers).some((s) => obj(s).id === serverId)) return false;
  if (!guestId) return true;
  return (await hosts.guestsRaw(serverId)).some((g) => obj(g).id === guestId);
}

/* The machine's figures ---------------------------------------------------------------------------------------------- */

/** What a page shows of the machine a connection runs on. */
export interface MachineFigures {
  kind: 'guest' | 'server';
  name: string;
  /** The guest's name (“homeassistant”) or the server's id. */
  label: string;
  cpuPct: number | null;
  cores: number | null;
  memoryUsedGb: number | null;
  memoryTotalGb: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  uptimeS: number | null;
  lastBackup: { at: string; result: string } | null;
  /** A Proxmox backup job covers it (null: unknown). */
  backupJob: boolean | null;
  /** Longest normal gap of its most frequent known backup job. */
  backupRhythmMs?: number | null;
  /** CPU (%) and memory (GB) over the page's range, oldest first, on the metrics' timestamps. */
  series: { timestamps: string[]; cpu: (number | null)[]; memoryGb: (number | null)[] } | null;
}

const GIB = 1024 ** 3;

/** The metrics as CPU % and memory GB (`mem_mb`, or `mem_pct` of `totalGb`). */
export function metricSeries(raw: unknown, totalGb: number | null): MachineFigures['series'] {
  const m = rec(raw);
  const timestamps = list(m.timestamps)
    .map((t) => (typeof t === 'string' ? t : typeof t === 'number' ? new Date(t * 1000).toISOString() : null))
    .filter((t): t is string => !!t);
  if (timestamps.length < 2) return null;
  const s = rec(m.series);
  const values = (k: string) => list(s[k]).map((v) => num(v));
  const cpu = values('cpu_pct');
  // Guests' series is `mem_mb` (the hosts service's guest metrics); older names kept for servers and other platforms.
  const usedMb =
    ['mem_mb', 'mem_used_mb', 'memory_used_mb'].map(values).find((v) => v.some((x) => x !== null)) ?? [];
  const memPct = values('mem_pct');
  const memoryGb = usedMb.length
    ? usedMb.map((v) => (v === null ? null : v / 1024))
    : memPct.map((v) => (v === null || totalGb === null ? null : (v * totalGb) / 100));
  if (!cpu.length && !memoryGb.length) return null;
  const fit = (v: (number | null)[]) => timestamps.map((_, i) => v[i] ?? null);
  return { timestamps, cpu: fit(cpu), memoryGb: fit(memoryGb) };
}

/** A guest's figures: the list item, the configuration's first disk (Proxmox), its metrics. */
export function guestFigures(
  guest: HostGuest,
  serverId: string,
  config: unknown,
  metrics: unknown,
): MachineFigures {
  const disk = list(rec(config).disks)[0];
  const sizeBytes = num(rec(disk).size_bytes) ?? num(rec(disk).sizeBytes);
  const memoryTotalGb = guest.memoryLimitMb !== null ? guest.memoryLimitMb / 1024 : null;
  return {
    kind: 'guest',
    name: guestOnServer(serverId, guestLabel(guest)),
    label: guestLabel(guest),
    cpuPct: guest.cpuPct,
    cores: guest.vcpu ?? null,
    memoryUsedGb: guest.memoryUsedMb !== null ? guest.memoryUsedMb / 1024 : null,
    memoryTotalGb,
    // The hosts service counts a guest's used disk in GB (10⁹ bytes) and Proxmox sizes disks in GiB: both in GiB, so
    // “30 / 40 GB” reads as Proxmox shows the 40G disk (76 %, not 32.5 of 40 = 81 %).
    diskUsedGb: guest.diskUsedGb != null ? (guest.diskUsedGb * 1e9) / GIB : null,
    diskTotalGb: sizeBytes ? sizeBytes / GIB : null,
    uptimeS: guest.uptimeS,
    lastBackup: guest.lastBackup ?? null,
    backupJob: guest.backupJob ?? null,
    series: metricSeries(metrics, memoryTotalGb),
  };
}

/** A server's figures from its fleet card and its metrics. */
export function serverFigures(server: HostServer, metrics: unknown): MachineFigures {
  return {
    kind: 'server',
    name: server.name,
    label: server.name,
    cpuPct: server.cpuPct,
    cores: server.cpu?.threads || server.cpu?.cores || null,
    memoryUsedGb: server.memory.usedGb ?? null,
    memoryTotalGb: server.memory.totalGb ?? null,
    diskUsedGb: typeof server.storage.usedTb === 'number' ? server.storage.usedTb * 1000 : null,
    diskTotalGb: typeof server.storage.capacityTb === 'number' ? server.storage.capacityTb * 1000 : null,
    uptimeS: null,
    lastBackup: null,
    backupJob: null,
    series: metricSeries(metrics, server.memory.totalGb ?? null),
  };
}

interface CachedMachine {
  at: number;
  value: Promise<MachineFigures | null>;
  /** What the read gave, once it did. */
  settled?: { figures: MachineFigures | null };
}

const machineReads = new WeakMap<Services, Map<string, CachedMachine>>();

/** How long a machine's read is kept per range (a page's 30 s, CP-04). */
export const MACHINE_CACHE_MS = 30_000;
/** How long a machine's last figures serve while new ones are read (page-speed.md PS-03). */
const MACHINE_KEEP_MS = 15 * 60_000;

/**
 * Reads the figures of the machine a connection runs on (null when it can't be read now), with its CPU and memory over
 * `range` (none without one: the health pass wants the figures only). Kept 30 seconds per machine and range; past that,
 * a new read is waited for up to `PAGE_WAIT_MS` and else the last figures serve (PS-03).
 */
export function readMachine(
  services: Services,
  at: Pick<ResolvedMachine, 'serverId' | 'guestId'> & { runsOn: Pick<ThingRunsOn, 'name'> },
  range: PageRange | null = '24h',
): Promise<MachineFigures | null> {
  let cache = machineReads.get(services);
  if (!cache) {
    cache = new Map();
    machineReads.set(services, cache);
  }
  const key = `${at.serverId}|${at.guestId ?? ''}|${range ?? ''}|${at.runsOn.name}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at <= MACHINE_CACHE_MS) return hit.value;
  for (const [k, v] of cache) if (now - v.at > MACHINE_KEEP_MS) cache.delete(k);
  const entry: CachedMachine = { at: now, value: loadMachine(services, at, range) };
  cache.set(key, entry);
  void entry.value.then((figures) => {
    entry.settled = { figures };
  });
  const last = hit?.settled;
  if (!last) return entry.value;
  return Promise.race([
    entry.value,
    new Promise<MachineFigures | null>((resolve) => {
      setTimeout(() => resolve(last.figures), PAGE_WAIT_MS).unref?.();
    }),
  ]);
}

async function loadMachine(
  services: Services,
  at: Pick<ResolvedMachine, 'serverId' | 'guestId'> & { runsOn: Pick<ThingRunsOn, 'name'> },
  range: PageRange | null,
): Promise<MachineFigures | null> {
  const hosts = hostsFor(services);
  const S = `${HOSTS_API}/servers/${seg(at.serverId)}`;
  const metricsOf = (path: string, series: string) =>
    range
      ? hosts.call<unknown>({ path, query: { range, series }, actor: WHOMBAT_ACTOR }).catch(() => null)
      : Promise.resolve(null);
  try {
    if (at.guestId) {
      const raw = (await hosts.guestsRaw(at.serverId)).find((g) => obj(g).id === at.guestId);
      if (!raw) return null;
      const guest = toHostGuest(raw, at.serverId);
      const G = `${S}/guests/${seg(at.guestId)}`;
      const [config, metrics, jobs] = await Promise.all([
        guest.platform === 'pve'
          ? hosts
              .call<unknown>({ path: `${G}/config`, actor: { ...WHOMBAT_ACTOR, role: 'operator' } })
              .catch(() => null)
          : Promise.resolve(null),
        metricsOf(`${G}/metrics`, 'cpu_pct,mem_mb'),
        guest.platform === 'pve' && guest.backupJob
          ? hosts
              .call<unknown>({ path: `${S}/backup-jobs`, actor: { ...WHOMBAT_ACTOR, role: 'operator' } })
              .catch(() => null)
          : null,
      ]);
      return {
        ...guestFigures(guest, at.serverId, config, metrics),
        name: at.runsOn.name,
        backupRhythmMs: backupRhythm(arr(obj(jobs).items).map(toHostBackupJob), guest),
      };
    }
    const fleet = await hosts.fleetRaw();
    const card = arr(fleet.servers).find((s) => obj(s).id === at.serverId);
    if (!card) return null;
    const metrics = await metricsOf(`${S}/metrics`, 'cpu_pct,mem_pct');
    return serverFigures(toHostServer(card, arr(fleet.alerts)), metrics);
  } catch {
    return null;
  }
}
