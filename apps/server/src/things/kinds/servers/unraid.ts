/**
 * Unraid's page. When Whombat watches the server the connection reaches, the page is that server from what Whombat
 * already knows (`watched.ts`), with no call to Unraid but the health pass's small one. Otherwise it reads Unraid's
 * GraphQL API as the connection (`POST /graphql`, `x-api-key`, a Viewer key is enough; queries only read): the array
 * with its disks and pools and the server's own name (the health pass reads this one every 5 minutes, also to find the
 * server Whombat watches by its name, and keeps the array's used space as a point for Space used), then its
 * Docker containers and VMs, then its shares, unread notifications, a parity check and its own processor and memory.
 * Three small queries, kept 30 seconds, so a field an older Unraid lacks costs only its own part. Read only.
 */

import type { ThingGalleryItem, ThingLine, ThingPageBar, ThingPageItem } from '@whombat/core';
import { externalEffect } from '../../../commit/scope';
import { signedConnectionFetch } from '../../../connections/http';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { MachineNow } from '../../machine';
import { shortHash } from '../../quiet/items';
import type { KindCheck } from '../../quiet/types';
import type { RawPoint } from '../../series';
import { clip, dateOf, line, list, num, plural, rec, span, str, thousands } from '../../words';
import { cachedRead, KIND_DEADLINE_MS, latestRead, problemOf, ReadProblem, withDeadline } from '../read';
import type { KindModule, KindSeen } from '../registry';
import { countLine, inventory, slotPanels } from '../slots';
import { fixed, fullness, itemLines, type KindNotice, lookInto, newer, UNTIL } from '../storage/lines';
import { disksLine, readSpace, spaceWeek, usedPoint } from '../storage/nas';
import {
  cardOf,
  seenOf,
  serviceUrl,
  statusOf,
  tempTone,
  unreadView,
  usedOf,
  worstFirst,
} from '../storage/shared';
import type { KindCtx, KindView } from '../types';
import { type GuestNow, guestCountLine, guestsLive, isOn } from './guests';
import { drawsServer, parityRow, readWatched, storageLine, watchedServerId, watchedView } from './watched';

const NAME = 'Unraid';
const KB = 1024;
const GIB = 1024 ** 3;

/* Reading ------------------------------------------------------------------------------------------------------------ */

/** What the health pass reads too: the array, its disks and pools, and the server's own name. */
export const ARRAY_QUERY =
  '{ info { os { hostname uptime } } array { state capacity { kilobytes { free used total } } parities { name status temp numErrors } disks { name status temp numErrors fsSize fsFree } caches { name status temp numErrors fsSize fsFree } } }';
/** Its Docker containers and VMs (each is left out when its service is off). */
export const GUESTS_QUERY =
  '{ docker { containers { id names state status } } vms { domains { id name state } } }';
/** The rest of the page: shares, unread notifications, the parity check, its processor and memory, its version. */
export const MORE_QUERY =
  '{ shares { name } notifications { overview { unread { warning alert total } } } array { parityCheckStatus { date status progress errors running paused } } metrics { cpu { percentTotal } memory { total used } } info { versions { core { unraid } } } }';

/** Runs one GraphQL query as the connection; the answer's `data`, or a `ReadProblem`. */
export async function unraidQuery(
  services: Services,
  row: CatalogConnectionRow,
  query: string,
): Promise<Record<string, unknown>> {
  const url = `${row.baseUrl.replace(/\/+$/, '')}/graphql`;
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method: 'POST',
            url,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
          },
          { maxBytes: 1024 * 1024, deadlineMs: KIND_DEADLINE_MS },
        ),
      { idempotent: true },
    );
  } catch (err) {
    throw problemOf(err, NAME);
  }
  if (res.status === 401 || res.status === 403)
    throw new ReadProblem('Unraid refused Whombat’s sign-in.', res.status === 401);
  if (res.status >= 400) throw new ReadProblem('Unraid answered with an error.');
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new ReadProblem('Unraid answered with something Whombat can’t read.');
  }
  // GraphQL answers its errors with 200: a part that failed is null beside the rest, a query it refused has no data.
  const data = rec(body).data;
  if (data && typeof data === 'object') return rec(data);
  const message = str(rec(list(rec(body).errors)[0]).message) ?? '';
  if (/forbidden|unauthori[sz]ed/i.test(message)) throw new ReadProblem('Unraid’s key may not read this.');
  throw new ReadProblem('Unraid answered with an error.');
}

/** The hostname in Unraid's answer (`{ data: { info: { os: { hostname } } } }`), or null. */
export function unraidHostnameOf(answer: unknown): string | null {
  return hostnameIn(rec(rec(answer).data));
}

const hostnameIn = (data: Record<string, unknown>): string | null => {
  const name = rec(rec(rec(data.info).os)).hostname;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null;
};

export interface UnraidDisk {
  name: string;
  /** Unraid's own word: `DISK_OK`, `DISK_DSBL`, `DISK_NP` (an empty slot). */
  status: string;
  tempC: number | null;
  errors: number;
  sizeBytes: number | null;
  freeBytes: number | null;
}

export interface UnraidArray {
  /** `STARTED`, `STOPPED`, … */
  state: string;
  usedBytes: number | null;
  totalBytes: number | null;
  freeBytes: number | null;
  parities: UnraidDisk[];
  disks: UnraidDisk[];
  /** Pools (cache disks that carry a file system). */
  pools: UnraidDisk[];
  hostname: string | null;
  /** When it started, from `info.os.uptime` (a boot time, or seconds). */
  upSince: Date | null;
}

export interface UnraidMore {
  shares: number | null;
  unread: { alert: number; warning: number } | null;
  parity: {
    status: string;
    running: boolean;
    paused: boolean;
    progress: number | null;
    errors: number;
    date: string | null;
  } | null;
  machine: { cpuPct: number | null; memUsed: number | null; memTotal: number | null } | null;
  version: string | null;
}

export interface UnraidSnapshot {
  readAt: Date;
  array: UnraidArray;
  /** Null when they couldn't be read. */
  guests: GuestNow[] | null;
  more: UnraidMore | null;
}

function diskOf(raw: unknown): UnraidDisk | null {
  const d = rec(raw);
  const name = str(d.name);
  if (!name) return null;
  const size = num(d.fsSize);
  const free = num(d.fsFree);
  return {
    name,
    status: str(d.status) ?? 'DISK_OK',
    tempC: num(d.temp),
    errors: Math.max(0, num(d.numErrors) ?? 0),
    sizeBytes: size !== null ? size * KB : null,
    freeBytes: free !== null ? free * KB : null,
  };
}

const disks = (v: unknown) =>
  list(v)
    .map(diskOf)
    .filter((d): d is UnraidDisk => !!d);

/** `ARRAY_QUERY`'s data. Sizes are kilobytes in Unraid's answer. */
export function parseArray(data: Record<string, unknown>, now: Date): UnraidArray {
  const a = rec(data.array);
  const kb = rec(rec(a.capacity).kilobytes);
  const size = (k: string) => {
    const v = num(kb[k]);
    return v !== null ? v * KB : null;
  };
  const up = rec(rec(data.info).os).uptime;
  const upNum = num(up);
  const since = upNum !== null ? new Date(now.getTime() - upNum * 1000) : dateOf(up);
  return {
    state: str(a.state) ?? 'UNKNOWN',
    usedBytes: size('used'),
    totalBytes: size('total'),
    freeBytes: size('free'),
    parities: disks(a.parities),
    disks: disks(a.disks),
    pools: disks(a.caches).filter((d) => (d.sizeBytes ?? 0) > 0),
    hostname: hostnameIn(data),
    upSince: since && since.getTime() <= now.getTime() ? since : null,
  };
}

const CONTAINER_STATES: Record<string, GuestNow['state']> = { RUNNING: 'running', PAUSED: 'paused' };
const VM_STATES: Record<string, GuestNow['state']> = {
  RUNNING: 'running',
  IDLE: 'running',
  PAUSED: 'paused',
  PMSUSPENDED: 'paused',
};

/** `GUESTS_QUERY`'s data: containers (`names` start with “/”) and VMs. */
export function parseGuests(data: Record<string, unknown>): GuestNow[] {
  const out: GuestNow[] = [];
  for (const c of list(rec(data.docker).containers).map(rec)) {
    const id = str(c.id);
    const name = str(list(c.names).find((n) => typeof n === 'string'))?.replace(/^\//, '');
    if (!id || !name) continue;
    const status = str(c.status) ?? '';
    const state = CONTAINER_STATES[str(c.state) ?? ''] ?? 'stopped';
    out.push({
      id: `docker:${id}`,
      name,
      kind: 'container',
      state: state === 'running' && /\(unhealthy\)/i.test(status) ? 'unhealthy' : state,
      cpuPct: null,
      memUsedBytes: null,
      memLimitBytes: null,
      uptimeS: null,
      ...(state === 'running' && /^Up /.test(status)
        ? { detail: clip(status.replace(/\s*\((?:un)?healthy\)|\s*\(health: starting\)/i, ''), 60) }
        : {}),
    });
  }
  for (const v of list(rec(data.vms).domains).map(rec)) {
    const id = str(v.id);
    const name = str(v.name);
    if (!id || !name) continue;
    out.push({
      id: `vm:${id}`,
      name,
      kind: 'vm',
      state: VM_STATES[str(v.state) ?? ''] ?? 'stopped',
      cpuPct: null,
      memUsedBytes: null,
      memLimitBytes: null,
      uptimeS: null,
    });
  }
  return out;
}

/** `MORE_QUERY`'s data; a part it doesn't have is null. */
export function parseMore(data: Record<string, unknown>): UnraidMore {
  const unread = rec(rec(rec(data.notifications).overview).unread);
  const p = rec(rec(data.array).parityCheckStatus);
  const m = rec(data.metrics);
  const cpu = num(rec(m.cpu).percentTotal);
  const mem = rec(m.memory);
  return {
    shares: Array.isArray(data.shares) ? data.shares.length : null,
    unread:
      num(unread.alert) !== null || num(unread.warning) !== null
        ? { alert: num(unread.alert) ?? 0, warning: num(unread.warning) ?? 0 }
        : null,
    parity: str(p.status)
      ? {
          status: str(p.status) as string,
          running: p.running === true,
          paused: p.paused === true,
          progress: num(p.progress),
          errors: Math.max(0, num(p.errors) ?? 0),
          date: str(p.date),
        }
      : null,
    machine:
      cpu !== null || num(mem.total) !== null
        ? { cpuPct: cpu, memUsed: num(mem.used), memTotal: num(mem.total) }
        : null,
    version: str(rec(rec(rec(data.info).versions).core).unraid),
  };
}

function load(services: Services, row: CatalogConnectionRow, now: Date) {
  return async (): Promise<UnraidSnapshot> => {
    try {
      return await withDeadline(
        (async () => {
          const [array, guests, more] = await Promise.all([
            readArray(services, row, now),
            unraidQuery(services, row, GUESTS_QUERY).then(parseGuests, () => null),
            unraidQuery(services, row, MORE_QUERY).then(parseMore, () => null),
          ]);
          return { readAt: now, array, guests, more };
        })(),
        KIND_DEADLINE_MS,
        `${NAME} didn’t answer in time.`,
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

/** The array, kept 30 seconds: the page and the health pass share it. */
function readArray(services: Services, row: CatalogConnectionRow, now: Date): Promise<UnraidArray> {
  return cachedRead(services, `unraid-array:${row.id}`, row, async () =>
    parseArray(await unraidQuery(services, row, ARRAY_QUERY), now),
  );
}

/** Unraid's hostname as the connection reads it; a refusal or an error is a `ReadProblem`. */
export async function unraidHostname(services: Services, row: CatalogConnectionRow): Promise<string | null> {
  return (await readArray(services, row, services.clock())).hostname;
}

/* Checks and lines --------------------------------------------------------------------------------------------------- */

export const UNRAID_CHECKS: readonly KindCheck[] = [
  {
    check: 'unraid.array_stopped',
    name: 'The array stopping',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  {
    check: 'unraid.disk',
    name: 'Disks disabled, missing or with errors',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'unraid.parity_errors',
    name: 'Parity checks that find errors',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  {
    check: 'unraid.array_full',
    name: 'The array filling up',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  // Unraid's own catch-all: its plugin and update notices too.
  {
    check: 'unraid.notifications',
    name: 'Unraid’s own warnings',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

const DISK_WORDS: Readonly<Record<string, [string, 'warn' | 'bad']>> = {
  DISK_DSBL: ['is disabled', 'bad'],
  DISK_NP_DSBL: ['is disabled', 'bad'],
  DISK_NP_MISSING: ['is missing', 'bad'],
  DISK_INVALID: ['is invalid', 'bad'],
  DISK_WRONG: ['is the wrong disk', 'bad'],
  DISK_DSBL_NEW: ['is new and not in the array yet', 'warn'],
  DISK_NEW: ['is new and not in the array yet', 'warn'],
};

/** A disk's problem in words and tone, or null when it is fine (an empty slot is fine). */
export function diskProblem(d: UnraidDisk): { words: string; tone: 'warn' | 'bad' } | null {
  const known = DISK_WORDS[d.status];
  if (known) return { words: known[0], tone: known[1] };
  if (d.errors > 0) return { words: `has ${plural(d.errors, 'read error')}`, tone: 'warn' };
  return null;
}

export interface UnraidInput {
  snapshot: UnraidSnapshot;
  url: string;
  now: Date;
  timeZone: string;
  /** Whombat's own readings of the array's used space. */
  space?: readonly RawPoint[];
}

export function unraidNotices(input: UnraidInput): KindNotice[] {
  const { snapshot: s, url } = input;
  const a = s.array;
  const out: KindNotice[] = [];
  if (a.state !== 'STARTED')
    out.push({
      id: 'array-stopped',
      tone: 'bad',
      icon: 'disk',
      title: a.state === 'STOPPED' ? 'The array is stopped' : 'The array can’t start',
      detail: 'Shares, Docker and VMs are offline until it starts. Start it in Unraid’s Main tab.',
      link: lookInto('Unraid’s array isn’t started. Why, and what should I do?'),
      nature: 'problem',
      check: 'unraid.array_stopped',
      ignore: fixed(UNTIL.running),
      badge: 'Array stopped',
    });
  const problems = [...a.parities, ...a.disks, ...a.pools]
    .map((d) => ({ d, p: diskProblem(d) }))
    .filter((x): x is { d: UnraidDisk; p: NonNullable<ReturnType<typeof diskProblem>> } => x.p !== null)
    .sort((x, y) => (x.p.tone === y.p.tone ? x.d.name.localeCompare(y.d.name) : x.p.tone === 'bad' ? -1 : 1));
  out.push(
    ...itemLines(
      problems,
      ({ d, p }) => ({
        id: clip(`disk-${d.name}`, 120),
        tone: p.tone,
        icon: 'disk',
        title: clip(`${d.name} ${p.words}`, 120),
        detail:
          p.tone === 'bad'
            ? 'Its data comes from parity until it is replaced: one more failing disk loses data.'
            : 'Look at its SMART report in Unraid before it gets worse.',
        link: lookInto(`Unraid’s ${d.name} ${p.words}. What should I do?`),
        nature: 'problem',
        check: 'unraid.disk',
        subject: { id: clip(`disk:${d.name}`, 160), name: clip(d.name, 80) },
        ignore: fixed(p.tone === 'bad' ? UNTIL.replaced : UNTIL.healthy),
        badge: clip(`${d.name} ${p.words}`, 40),
      }),
      ({ d }) => d.name,
      (rest) => ({
        id: 'disk-more',
        tone: 'bad',
        icon: 'disk',
        title: `${plural(rest.length, 'more disk')} need a look`,
        nature: 'problem',
        check: 'unraid.disk',
      }),
    ),
  );
  const parity = s.more?.parity;
  if (parity && !parity.running && parity.status === 'COMPLETED' && parity.errors > 0)
    out.push({
      id: 'parity-errors',
      tone: 'warn',
      icon: 'disk',
      title: `The last parity check found ${plural(parity.errors, 'error')}`,
      detail: 'Parity may not match the data. Look at the disks, then run a correcting check.',
      link: lookInto(`Unraid’s last parity check found ${parity.errors} errors. What should I do?`),
      nature: 'problem',
      check: 'unraid.parity_errors',
      ...(parity.date ? { episode: parity.date } : {}),
      ignore: newer(UNTIL.nextRun),
    });
  if (a.state === 'STARTED' && a.usedBytes !== null && a.totalBytes) {
    const p = (a.usedBytes / a.totalBytes) * 100;
    const f = fullness(p, a.freeBytes);
    if (f)
      out.push({
        id: 'array-full',
        tone: f.tone,
        icon: 'disk',
        title: `The array is ${Math.round(p)} % full`,
        detail: `${usedOf(a.usedBytes, a.totalBytes)} used. Add a disk or free space before it fills.`,
        ...(f.nature === 'problem' ? { link: lookInto('What takes the space on my Unraid array?') } : {}),
        nature: f.nature,
        check: 'unraid.array_full',
        band: f.band,
        ignore: fixed(UNTIL.fuller),
        badge: `Array ${Math.round(p)} % full`,
      });
  }
  const unread = s.more?.unread;
  const n = unread ? unread.alert + unread.warning : 0;
  if (unread && n > 0)
    out.push({
      id: 'notifications',
      tone: 'info',
      icon: 'info',
      title: n === 1 ? 'Unraid has an unread warning' : `Unraid has ${n} unread warnings`,
      detail: 'Open Unraid to read them.',
      link: { kind: 'url', label: 'Open Unraid', url },
      nature: 'fyi',
      check: 'unraid.notifications',
      episode: shortHash([String(unread.alert), String(unread.warning)]),
      ignore: newer('Until a new one comes.'),
    });
  return worstFirst(out);
}

/** What this read couldn't check. */
export function unraidSkipped(s: UnraidSnapshot): string[] {
  return s.more ? [] : ['unraid.parity_errors', 'unraid.notifications'];
}

/* View --------------------------------------------------------------------------------------------------------------- */

/** Rows before the guests: a parity check or a rebuild that runs. */
function workRows(s: UnraidSnapshot): ThingGalleryItem[] {
  const p = s.more?.parity;
  if (!p || !(p.running || p.paused)) return [];
  return [parityRow({ action: 'check', pct: p.progress, etaS: null, errors: p.errors, paused: p.paused })];
}

const tempWarm = (d: UnraidDisk) => (d.tempC !== null ? tempTone(d.tempC) : undefined);

/** In Unraid (Inventory): the array, its pools, the disks, containers, VMs, shares, unread warnings. */
export function unraidInventory(input: UnraidInput) {
  const { snapshot: s, url } = input;
  const a = s.array;
  const items: ThingPageItem[] = [];
  const data = a.disks.filter((d) => d.status !== 'DISK_NP');
  if (a.state !== 'STARTED')
    items.push(
      countLine({
        id: 'array',
        title: 'Array',
        icon: 'disk',
        tone: 'bad',
        value: 'Stopped',
        detail: 'Shares, Docker and VMs wait for it',
        url,
      }),
    );
  else if (a.usedBytes !== null && a.totalBytes)
    items.push(
      storageLine({
        id: 'array',
        title: 'Array',
        used: a.usedBytes,
        total: a.totalBytes,
        note: plural(data.length, 'disk'),
      }),
    );
  for (const p of [...a.pools]
    .filter((d) => d.sizeBytes && d.freeBytes !== null)
    .sort((x, y) => (x.freeBytes ?? 0) / (x.sizeBytes ?? 1) - (y.freeBytes ?? 0) / (y.sizeBytes ?? 1))
    .slice(0, 2)) {
    const total = p.sizeBytes as number;
    items.push(
      storageLine({
        id: `pool-${p.name}`,
        title: p.name,
        used: total - (p.freeBytes ?? 0),
        total,
        note: 'pool',
      }),
    );
  }
  const all = [...a.parities, ...data, ...a.pools];
  if (all.length)
    items.push(
      disksLine(
        all.map((d) => {
          const p = diskProblem(d);
          return { health: p ? p.tone : 'ok', tempC: d.tempC, warm: tempWarm(d) };
        }),
        url,
      ),
    );
  const guests = s.guests ?? [];
  for (const l of [guestCountLine(guests, 'container', url), guestCountLine(guests, 'vm', url)])
    if (l) items.push(l);
  if (s.more?.shares)
    items.push(
      countLine({ id: 'shares', title: 'Shares', icon: 'network', value: thousands(s.more.shares), url }),
    );
  return items.length ? inventory({ id: 'inventory', title: 'In Unraid', items }) : null;
}

/** Unraid's own figures make “The machine” (no link: Whombat doesn't watch it). */
export function unraidNow(s: UnraidSnapshot): { figures: MachineNow; name: string } | null {
  const m = s.more?.machine;
  if (!m) return null;
  return {
    name: s.array.hostname ?? NAME,
    figures: {
      cpuPct: m.cpuPct,
      cores: null,
      memoryUsedGb: m.memUsed !== null ? m.memUsed / GIB : null,
      memoryTotalGb: m.memTotal ? m.memTotal / GIB : null,
      diskUsedGb: null,
      diskTotalGb: null,
      series: null,
    },
  };
}

export function unraidMachineLines(s: UnraidSnapshot, now: Date): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.more?.version)
    out.push({ id: 'unraid-version', label: 'Unraid', value: clip(s.more.version, 40), pct: null });
  if (s.array.upSince)
    out.push({ id: 'up', label: 'Up', value: span(now.getTime() - s.array.upSince.getTime()), pct: null });
  return out;
}

export function unraidVerdict(s: UnraidSnapshot): string {
  const guests = s.guests ?? [];
  const running = guests.filter(isOn).length;
  return guests.length
    ? `Unraid is fine: the array is started and ${running} of ${guests.length} containers and VMs run.`
    : 'Unraid is fine: the array is started.';
}

/** The page's part when Whombat reads Unraid itself; pure. */
export function unraidView(input: UnraidInput): KindView {
  const { snapshot: s, url, now } = input;
  const a = s.array;
  const slotted = slotPanels({
    live: guestsLive(s.guests ?? [], { lead: workRows(s) }),
    inventory: unraidInventory(input),
    trend: spaceWeek({
      points: input.space ?? [],
      now,
      timeZone: input.timeZone,
      freeBytes: a.freeBytes,
      what: 'The array',
    }),
    machine: unraidMachineLines(s, now),
  });
  const own = unraidNow(s);
  const notices = unraidNotices(input);
  const facts: ThingLine[] = [];
  if (s.more?.version) facts.push(line(`Unraid **${s.more.version}**`));
  if (a.hostname) facts.push(line(`**${clip(a.hostname, 60)}**`));
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices,
    panels: slotted.panels,
    slots: { machine: slotted.slots?.machine ?? [], ...(own ? { own } : {}) },
    tabs: [],
    facts,
    status: statusOf(notices, a.state === 'STARTED' ? 'Array started' : 'Array stopped'),
    open: { label: 'Open Unraid', url },
    actions: [],
    readAt: s.readAt,
    suggestions: ['What takes the most space', 'Disk temperatures', 'Containers that restarted'],
    verdict: unraidVerdict(s),
  };
}

/* Page and seen ------------------------------------------------------------------------------------------------------ */

export function unraidLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `unraid:${row.id}`, row, load(services, row, now));
}

export async function unraidPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = serviceUrl(row);
  const [serverId, space] = await Promise.all([
    watchedServerId(services, ctx.burrowId, row),
    readSpace(services, row.id, now),
  ]);
  if (serverId) {
    const w = await readWatched(services, row, serverId, now);
    if (w.ok)
      return {
        ...watchedView({
          server: w.value,
          now,
          timeZone: ctx.timeZone,
          linked: drawsServer(ctx, serverId),
          space,
        }),
        open: { label: 'Open Unraid', url },
        refreshing: w.refreshing,
      };
  }
  const got = await unraidLatest(services, row, now);
  if (!got.ok) return unreadView(NAME, url, problemOf(got.error, NAME).message, got.refreshing);
  return {
    ...unraidView({ snapshot: got.value, url, now, timeZone: ctx.timeZone, space }),
    refreshing: got.refreshing,
  };
}

/**
 * The health pass: the array query only (it also names the server, to find the one Whombat watches), its used space as
 * a point; Worth a look only when Whombat doesn't watch the server, whose page raises those itself.
 */
export async function unraidSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<KindSeen> {
  const a = await readArray(services, row, now);
  const hostname = a.hostname ? { hostname: a.hostname } : {};
  const points = a.state === 'STARTED' ? usedPoint(a.usedBytes) : {};
  const serverId = await watchedServerId(
    services,
    row.burrowId,
    { ...row, glance: { ...(row.glance ?? {}), ...hostname } },
    { wait: false },
  );
  if (serverId)
    return {
      ...seenOf({ facts: [], line: clip(`Part of ${serverId}`, 80), ...hostname }),
      points,
      skipped: UNRAID_CHECKS.map((c) => c.check),
    };
  const s: UnraidSnapshot = { readAt: now, array: a, guests: null, more: null };
  const notices = unraidNotices({ snapshot: s, url: serviceUrl(row), now, timeZone: 'UTC' });
  const used = a.usedBytes !== null && a.totalBytes ? (a.usedBytes / a.totalBytes) * 100 : null;
  return {
    ...seenOf(
      {
        ...cardOf(
          {
            kpis: used !== null ? [{ key: 'array', label: 'Array', value: `${Math.round(used)} %` }] : [],
            notices,
          },
          ['array'],
          a.state === 'STARTED' ? 'Array started' : 'Array stopped',
        ),
        ...hostname,
      },
      notices,
      unraidSkipped(s),
    ),
    points,
  };
}

export const UNRAID_KIND: KindModule = {
  page: unraidPage,
  seen: unraidSeen,
  checks: UNRAID_CHECKS,
};
