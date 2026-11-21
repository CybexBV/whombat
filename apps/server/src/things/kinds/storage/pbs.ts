/**
 * Proxmox Backup Server's page (service-dashboards.md SD-50, SD-S17): how full the datastores are and when they are full
 * (PBS's own `estimated-full-date`, else the line through its usage history), each guest's last backup (red after 2
 * days), the jobs — garbage collection, verify, prune, sync — with their last result and next run, and the tasks that
 * failed in 7 days. Read with the token (Audit is enough) under `/api2/json`: `/status/datastore-usage`, per datastore
 * its namespaces and groups (and its snapshots, kept 5 minutes, for sizes and verification), `/admin/verify`,
 * `/admin/prune`, `/admin/sync`, `/admin/gc` and `/nodes/localhost/tasks?errors=1`. Guests are named by the Proxmox
 * servers Whombat watches (“web · VM 105”), else “VM 105”.
 *
 * Buttons (SD-07): **Run verify** on a verify job (`POST /admin/verify/{id}/run`, Datastore.Verify) and **Run cleanup**
 * on a datastore's garbage collection (`POST /admin/datastore/{store}/gc`, Datastore.Modify), both confirmed and
 * recorded. Never prunes or deletes (SD-02).
 */
import type { ThingLine, ThingPageItem, ThingPageKpi, ThingPagePanel, ThingPageRow } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { toHostGuest } from '../../../hosts/map';
import { badRequest } from '../../../lib/errors';
import type { Services } from '../../../services';
import { shortHash } from '../../quiet/items';
import type { KindCheck } from '../../quiet/types';
import { hostsServing, machineHref } from '../../runs-on';
import { forecastFull, fullWords, type RawPoint } from '../../series';
import { bytes, clip, line, list, num, pct, plural, rec, span, str, thousands, when } from '../../words';
import { actAs } from '../act';
import { untilWords } from '../fusebox-pool';
import { cachedRead, KIND_DEADLINE_MS, latestRead, problemOf, withDeadline } from '../read';
import type { KindAction, KindModule } from '../registry';
import {
  countByDay,
  countLine,
  inventory,
  lastDays,
  liveList,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import { fixed, fullness, itemLines, type KindNotice, lookInto, newer, UNTIL } from './lines';
import { signedSize } from './nas';
import { ifPresent, optional, readJson } from './net';
import {
  ago,
  type ButtonCtx,
  button,
  cardOf,
  fullTone,
  seenOf,
  serviceUrl,
  statusOf,
  unreadView,
  usedKpi,
  usedOf,
  worstFirst,
} from './shared';

const NAME = 'Proxmox Backup Server';
const API = '/api2/json';
const DAY = 86_400_000;
/** A guest's last backup is late after 2 days (SD-50). */
export const LATE_DAYS = 2;
/** A group without a backup for 30 days is taken for a removed guest: listed, but no longer late (SD-S17). */
export const RETIRED_DAYS = 30;
/** Datastores, namespaces per datastore, guests and failed tasks read and shown. */
const STORES_MAX = 8;
const NS_MAX = 8;
const GUESTS_MAX = 60;
const TASKS_MAX = 50;
/** Snapshots are the heaviest read: kept 5 minutes. */
const SNAPSHOTS_CACHE_MS = 5 * 60_000;
/** A group's snapshot times kept for backups per day: two weeks of hourly backups. */
const TIMES_MAX = 400;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface PbsStore {
  name: string;
  total: number | null;
  used: number | null;
  /** What PBS couldn't do with it (“datastore is in maintenance mode”, not mounted). */
  error: string | null;
  /** When PBS expects it full (its own estimate), when that is ahead. */
  fullAt: Date | null;
  /** Its usage over the last month as fractions (PBS's RRD), for a forecast when PBS gives none. */
  history: RawPoint[];
  backend: string | null;
  /** Away on purpose (QN-S4x): a removable datastore that isn't plugged in, or one in maintenance mode. */
  away: 'unplugged' | 'maintenance' | null;
}

export type GroupType = 'vm' | 'ct' | 'host';

export interface PbsGroup {
  store: string;
  ns: string;
  type: GroupType;
  id: string;
  last: Date | null;
  count: number;
  /** Of the newest snapshot, when the snapshots could be read. */
  size: number | null;
  verified: 'ok' | 'failed' | null;
  /** Snapshots of this group whose verification failed. */
  damaged: number;
  /** Its oldest snapshot kept, when the snapshots could be read (a guest that moved began its new group then). */
  first: Date | null;
  /** The usual time between its backups, in seconds (`rhythmOf`), when the snapshots could be read. */
  rhythmS: number | null;
  /** When its kept snapshots were made (seconds, newest first, at most `TIMES_MAX`): backups per day. */
  times?: number[];
}

export type JobKind = 'gc' | 'verify' | 'prune' | 'sync';

export interface PbsJob {
  kind: JobKind;
  id: string;
  store: string;
  /** `OK`, an error, or null when it never ran. */
  lastState: string | null;
  lastEnd: Date | null;
  nextRun: Date | null;
  remote: string | null;
}

export interface PbsTask {
  upid: string;
  type: string;
  workerId: string | null;
  start: Date;
  status: string;
}

export interface PbsSnapshot {
  readAt: Date;
  version: string | null;
  stores: PbsStore[];
  groups: PbsGroup[];
  /** Null when the jobs couldn't be read (the token may not see them). */
  jobs: PbsJob[] | null;
  /** Failed tasks of the last 7 days; null when they couldn't be read. */
  tasks: PbsTask[] | null;
  /** The snapshots were read: sizes and verification are known. */
  snapshotsRead: boolean;
  /** Every datastore was listed (not past `STORES_MAX`). */
  storesComplete: boolean;
  /** Every datastore's guests were read: none unavailable, failed or past `NS_MAX` namespaces. */
  groupsComplete: boolean;
  /** The failed tasks filled the read (`TASKS_MAX`): older ones weren't seen. */
  tasksCapped: boolean;
}

/** PBS answers `{ data: … }`. */
export const dataOf = (body: unknown) => rec(body).data;

const epoch = (v: unknown): Date | null => {
  const n = num(v);
  return n !== null && n > 0 ? new Date(n * 1000) : null;
};

/** `/status/datastore-usage`. */
export function parseUsage(body: unknown, now: Date): PbsStore[] {
  return list(dataOf(body))
    .slice(0, STORES_MAX)
    .flatMap((raw) => {
      const d = rec(raw);
      const name = str(d.store);
      if (!name) return [];
      const full = epoch(d['estimated-full-date']);
      const start = num(d['history-start']);
      const delta = num(d['history-delta']);
      const history: RawPoint[] =
        start !== null && delta !== null && delta > 0
          ? list(d.history)
              .slice(-800)
              .map((v, i) => ({ at: new Date((start + i * delta) * 1000), value: num(v) }))
          : [];
      const mount = str(d['mount-status']);
      const error = str(d.error) ?? (mount === 'notmounted' ? 'Not mounted' : null);
      const maintenance = str(d['maintenance-mode']) ?? str(rec(d['maintenance-mode']).type);
      return [
        {
          name: clip(name, 60),
          total: num(d.total),
          used: num(d.used),
          error,
          // “An estimate in the past means that usage is declining or not changing.”
          fullAt: full && full > now && full.getTime() - now.getTime() <= 365 * DAY ? full : null,
          history,
          backend: str(d['backend-type']),
          away:
            error && mount === 'notmounted'
              ? ('unplugged' as const)
              : error && (maintenance || /maintenance/i.test(error))
                ? ('maintenance' as const)
                : null,
        },
      ];
    });
}

/** `/admin/datastore/{store}/namespace`: the namespaces, the root (“”) first. */
export function parseNamespaces(body: unknown): string[] {
  const out = list(dataOf(body))
    .map((x) => str(rec(x).ns) ?? '')
    .filter((ns, i, all) => all.indexOf(ns) === i);
  return ['', ...out.filter((ns) => ns !== '')].slice(0, NS_MAX);
}

const TYPES = new Set<GroupType>(['vm', 'ct', 'host']);

/** `/admin/datastore/{store}/groups`. */
export function parseGroups(body: unknown, store: string, ns: string): PbsGroup[] {
  return list(dataOf(body)).flatMap((raw) => {
    const g = rec(raw);
    const type = str(g['backup-type']) as GroupType | null;
    const id = str(g['backup-id']);
    if (!type || !TYPES.has(type) || !id) return [];
    return [
      {
        store,
        ns,
        type,
        id: clip(id, 80),
        last: epoch(g['last-backup']),
        count: num(g['backup-count']) ?? 0,
        size: null,
        verified: null,
        damaged: 0,
        first: null,
        rhythmS: null,
      },
    ];
  });
}

/** The gaps between a group's newest snapshots that make its rhythm: pruning thins out the older ones. */
const RHYTHM_GAPS = 3;

/**
 * A group's rhythm (QN-S4x): the median gap between its newest snapshots, in seconds (the shorter of two), or null with
 * fewer than two.
 */
export function rhythmOf(times: readonly number[]): number | null {
  const t = [...new Set(times)].sort((a, b) => b - a).slice(0, RHYTHM_GAPS + 1);
  if (t.length < 2) return null;
  const gaps = t
    .slice(1)
    .map((x, i) => (t[i] as number) - x)
    .sort((a, b) => a - b);
  return gaps[Math.floor((gaps.length - 1) / 2)] ?? null;
}

export interface SnapshotsOf {
  time: number;
  size: number | null;
  verified: 'ok' | 'failed' | null;
  damaged: number;
  first: number;
  rhythmS: number | null;
  /** When each was made, newest first (at most `TIMES_MAX`). */
  times: number[];
}

/**
 * Per group (`type/id`), from `/admin/datastore/{store}/snapshots`: the newest one's size and verification, damage, the
 * oldest one kept and the rhythm.
 */
export function parseSnapshots(body: unknown): Map<string, SnapshotsOf> {
  const out = new Map<string, SnapshotsOf>();
  const times = new Map<string, number[]>();
  for (const raw of list(dataOf(body))) {
    const s = rec(raw);
    const key = `${str(s['backup-type'])}/${str(s['backup-id'])}`;
    const time = num(s['backup-time']) ?? 0;
    const state = str(rec(s.verification).state);
    const verified = state === 'ok' || state === 'failed' ? state : null;
    const was = out.get(key);
    const damaged = (was?.damaged ?? 0) + (verified === 'failed' ? 1 : 0);
    const first = Math.min(was?.first ?? time, time);
    if (time > 0) times.set(key, [...(times.get(key) ?? []), time]);
    if (!was || time > was.time)
      out.set(key, { time, size: num(s.size), verified, damaged, first, rhythmS: null, times: [] });
    else Object.assign(was, { damaged, first });
  }
  for (const [key, t] of times) {
    const o = out.get(key);
    if (!o) continue;
    o.rhythmS = rhythmOf(t);
    o.times = [...new Set(t)].sort((a, b) => b - a).slice(0, TIMES_MAX);
  }
  return out;
}

/** `/admin/verify`, `/admin/prune`, `/admin/sync`, `/admin/gc`. */
export function parseJobs(body: unknown, kind: JobKind): PbsJob[] {
  return list(dataOf(body)).flatMap((raw) => {
    const j = rec(raw);
    const store = str(j.store);
    const id = kind === 'gc' ? store : str(j.id);
    if (!store || !id || j.disable === true) return [];
    return [
      {
        kind,
        id: clip(id, 60),
        store: clip(store, 60),
        lastState: str(j['last-run-state']),
        lastEnd: epoch(j['last-run-endtime']),
        nextRun: epoch(j['next-run']),
        remote: str(j.remote) ?? null,
      },
    ];
  });
}

/** `/nodes/localhost/tasks?errors=1`: tasks that didn't end OK. */
export function parseTasks(body: unknown): PbsTask[] {
  return list(dataOf(body))
    .slice(0, TASKS_MAX)
    .flatMap((raw) => {
      const t = rec(raw);
      const upid = str(t.upid);
      const start = epoch(t.starttime);
      const status = str(t.status);
      if (!upid || !start || !status || status === 'OK') return [];
      return [
        {
          upid: upid.slice(0, 200),
          type: str(t.worker_type) ?? 'task',
          workerId: str(t.worker_id),
          start,
          status: clip(status, 200),
        },
      ];
    });
}

const enc = encodeURIComponent;

async function readStore(
  services: Services,
  row: CatalogConnectionRow,
  store: string,
): Promise<{ groups: PbsGroup[]; snapshotsRead: boolean; complete: boolean }> {
  const get = (path: string, query?: Record<string, string>) =>
    readJson(services, row, NAME, { path: `${API}${path}`, ...(query ? { query } : {}) });
  const nsBody = await optional(get(`/admin/datastore/${enc(store)}/namespace`));
  const spaces = nsBody ? parseNamespaces(nsBody) : [''];
  const capped = !!nsBody && new Set(list(dataOf(nsBody)).map((x) => str(rec(x).ns) ?? '')).size > NS_MAX;
  const per = await Promise.all(
    spaces.map(async (ns) => {
      const q = ns ? { ns } : undefined;
      const [groups, snaps] = await Promise.all([
        get(`/admin/datastore/${enc(store)}/groups`, q).then((b) => parseGroups(b, store, ns)),
        optional(
          cachedRead(
            services,
            `pbs-snapshots:${row.id}:${store}:${ns}`,
            row,
            async () => parseSnapshots(await get(`/admin/datastore/${enc(store)}/snapshots`, q)),
            SNAPSHOTS_CACHE_MS,
          ),
        ),
      ]);
      return {
        snapshotsRead: snaps !== null,
        groups: groups.map((g) => {
          const s = snaps?.get(`${g.type}/${g.id}`);
          return s
            ? {
                ...g,
                size: s.size,
                verified: s.verified,
                damaged: s.damaged,
                first: s.first > 0 ? new Date(s.first * 1000) : null,
                rhythmS: s.rhythmS,
                times: s.times,
              }
            : g;
        }),
      };
    }),
  );
  return {
    groups: per.flatMap((p) => p.groups),
    snapshotsRead: per.every((p) => p.snapshotsRead),
    complete: !capped,
  };
}

export async function readPbs(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<PbsSnapshot> {
  const get = (path: string, query?: Record<string, string>) =>
    readJson(services, row, NAME, { path: `${API}${path}`, ...(query ? { query } : {}) });
  const jobs = async (path: string, kind: JobKind) => parseJobs(await get(path), kind);
  const [version, usage, verify, prune, sync, gc, tasks] = await Promise.all([
    optional(get('/version')),
    get('/status/datastore-usage'),
    optional(jobs('/admin/verify', 'verify')),
    optional(jobs('/admin/prune', 'prune')),
    optional(jobs('/admin/sync', 'sync')),
    // `/admin/gc` came with PBS 3.4; older ones say nothing of a cleanup's last run.
    optional(ifPresent(jobs('/admin/gc', 'gc'))),
    optional(
      get('/nodes/localhost/tasks', {
        errors: '1',
        since: String(Math.floor((now.getTime() - 7 * DAY) / 1000)),
        limit: String(TASKS_MAX),
      }).then((b) => ({ list: parseTasks(b), capped: list(dataOf(b)).length >= TASKS_MAX })),
    ),
  ]);
  const stores = parseUsage(usage, now);
  const perStore = await Promise.all(
    stores.filter((s) => !s.error).map((s) => optional(readStore(services, row, s.name))),
  );
  const read = perStore.filter((p): p is NonNullable<typeof p> => p !== null);
  const known = [verify, prune, sync].some((x) => x !== null);
  const storesComplete = list(dataOf(usage)).length <= STORES_MAX;
  return {
    readAt: now,
    version: str(rec(dataOf(version)).release) ?? str(rec(dataOf(version)).version),
    stores,
    groups: read.flatMap((p) => p.groups),
    jobs: known || gc ? [...(gc ?? []), ...(verify ?? []), ...(prune ?? []), ...(sync ?? [])] : null,
    tasks: tasks?.list ?? null,
    snapshotsRead: read.length > 0 && read.every((p) => p.snapshotsRead),
    storesComplete,
    groupsComplete: storesComplete && stores.every((st) => !st.error) && perStore.every((p) => p?.complete),
    tasksCapped: tasks?.capped ?? false,
  };
}

function load(services: Services, row: CatalogConnectionRow, now: Date) {
  return async () => {
    try {
      return await withDeadline(
        readPbs(services, row, now),
        KIND_DEADLINE_MS,
        `${NAME} didn’t answer in time.`,
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

export function pbsLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `pbs:${row.id}`, row, load(services, row, now));
}

export function pbsSnapshot(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return cachedRead(services, `pbs:${row.id}`, row, load(services, row, now));
}

/* Guests' names (the Proxmox servers Whombat watches) --------------------------------------------------------------- */

export interface GuestName {
  name: string;
  href: string;
}

const NAMES_TTL_MS = 10 * 60_000;
const namesCache = new WeakMap<object, { at: number; value: Promise<Map<string, GuestName>> }>();

/** Proxmox guests by `vm/105`, `ct/131`: their names and pages; a vmid on two servers is left unnamed. */
export async function pveGuestNames(services: Services, burrowId: string): Promise<Map<string, GuestName>> {
  const hosts = await hostsServing(services, burrowId).catch(() => null);
  if (!hosts) return new Map();
  const hit = namesCache.get(hosts);
  if (hit && Date.now() - hit.at < NAMES_TTL_MS) return hit.value;
  const value = (async () => {
    const out = new Map<string, GuestName>();
    const twice = new Set<string>();
    const fleet = await hosts.fleetRaw();
    const servers = list(fleet.servers)
      .map((s) => str(rec(s).id))
      .filter((id): id is string => !!id)
      .slice(0, 20);
    const all = await Promise.all(
      servers.map(async (serverId) =>
        (await hosts.guestsRaw(serverId).catch(() => [])).map((g) => toHostGuest(g, serverId)),
      ),
    );
    for (const g of all.flat()) {
      if (g.platform !== 'pve' || typeof g.vmid !== 'number') continue;
      const key = `${g.kind === 'vm' ? 'vm' : 'ct'}/${g.vmid}`;
      if (out.has(key)) twice.add(key);
      if (g.name) out.set(key, { name: clip(g.name, 60), href: machineHref(g.serverId, g.id) });
    }
    for (const k of twice) out.delete(k);
    return out;
  })();
  namesCache.set(hosts, { at: Date.now(), value });
  value.catch(() => namesCache.delete(hosts));
  return value;
}

/* Words -------------------------------------------------------------------------------------------------------------- */

/** “VM 105”, “CT 131”, “Host nas”. */
export function groupLabel(g: Pick<PbsGroup, 'type' | 'id'>): string {
  return g.type === 'vm' ? `VM ${g.id}` : g.type === 'ct' ? `CT ${g.id}` : `Host ${g.id}`;
}

/** A guest as people name it: “web” with “VM 105” beside it, else “VM 105”. */
function guestName(g: PbsGroup, names: ReadonlyMap<string, GuestName>): string {
  const named = g.type !== 'host' ? names.get(`${g.type}/${g.id}`) : undefined;
  return named ? named.name : groupLabel(g);
}

const JOB_NAME: Record<JobKind, string> = {
  gc: 'Garbage collection',
  verify: 'Verify',
  prune: 'Prune',
  sync: 'Sync',
};

/** A task in words: “Backup of VM 105”, “Verify on store1”. */
export function taskWords(t: Pick<PbsTask, 'type' | 'workerId'>): string {
  const w = t.workerId ?? '';
  const store = w.split(':')[0] ?? '';
  switch (t.type) {
    case 'backup': {
      // `store:vm/105` (or `store:ns/…/vm/105`).
      const m = /(vm|ct|host)\/([^/]+)$/.exec(w);
      return m ? `Backup of ${groupLabel({ type: m[1] as GroupType, id: m[2] as string })}` : 'A backup';
    }
    case 'verify':
    case 'verificationjob':
      return store ? `Verify on ${store}` : 'A verify';
    case 'garbage_collection':
      return store ? `Garbage collection on ${store}` : 'Garbage collection';
    case 'prune':
    case 'prunejob':
      return store ? `Prune on ${store}` : 'A prune';
    case 'sync':
    case 'syncjob':
      return store ? `Sync to ${store}` : 'A sync';
    case 'reader':
      return 'A restore';
    default:
      return clip(t.type.replace(/[_-]+/g, ' '), 60).replace(/^./, (c) => c.toUpperCase());
  }
}

/** “Full in about 5 months” → “full in about 5 months” (a month's name keeps its capital). */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** PBS's own status line without its “TASK ERROR:” prefix. */
const statusWords = (s: string) =>
  clip(s.replace(/^(TASK\s+)?ERROR:\s*/i, ''), 200) || 'It ended with an error.';

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface PbsInput {
  snapshot: PbsSnapshot;
  now: Date;
  timeZone: string;
  url: string;
  names: ReadonlyMap<string, GuestName>;
  /** Who looks: Run verify and Run cleanup are allowed or say why not. */
  buttons: ButtonCtx;
}

/** When a datastore is full: PBS's estimate, else the line through its usage history. */
export function storeFull(s: PbsStore, now: Date): Date | null {
  return s.fullAt ?? forecastFull(s.history, 1, now);
}

/**
 * How long a guest may go without a backup (QN-04, QN-S4x): its own rhythm and half again (a weekly guest isn't late on
 * day 3), at least `LATE_DAYS`.
 */
export function lateAfterMs(g: Pick<PbsGroup, 'rhythmS'>): number {
  return Math.max(LATE_DAYS * DAY, g.rhythmS ? g.rhythmS * 1500 : 0);
}

/** A guest without a backup this long is taken for a removed one: `RETIRED_DAYS`, or twice its late mark. */
export function retiredAfterMs(g: Pick<PbsGroup, 'rhythmS'>): number {
  return Math.max(RETIRED_DAYS * DAY, 2 * lateAfterMs(g));
}

/** Where a guest's backups stand: fine, late, removed (`retired`), or left behind by a guest that moved. */
export type Standing = 'ok' | 'late' | 'retired' | 'moved';

const ageMs = (g: PbsGroup, now: Date) =>
  g.last ? now.getTime() - g.last.getTime() : Number.POSITIVE_INFINITY;

/**
 * The groups a guest left behind when it moved to another datastore or namespace (QN-S4x): an older group of the same
 * `type/id` whose last backup is from before the newest group's first one kept. Without that first one, two groups
 * of one id stay apart (two clusters may both have a VM 100).
 */
export function movedGroups(groups: readonly PbsGroup[]): Set<PbsGroup> {
  const by = new Map<string, PbsGroup[]>();
  for (const g of groups) by.set(`${g.type}/${g.id}`, [...(by.get(`${g.type}/${g.id}`) ?? []), g]);
  const out = new Set<PbsGroup>();
  for (const same of by.values()) {
    if (same.length < 2) continue;
    const [newest, ...older] = [...same].sort((a, b) => (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0));
    const began = newest?.first?.getTime();
    if (began === undefined) continue;
    for (const g of older) if (!g.last || g.last.getTime() <= began + DAY) out.add(g);
  }
  return out;
}

/**
 * Every group's standing. A guest that is still being tried (a failed backup of it among `tasks`) isn't removed: it stays
 * late however long ago its last backup was (QN-S4x).
 */
export function standings(
  groups: readonly PbsGroup[],
  now: Date,
  tasks: readonly PbsTask[] = [],
): Map<PbsGroup, Standing> {
  const moved = movedGroups(groups);
  const tried = new Set(
    tasks.flatMap((t) => {
      const x = taskGuest(t);
      return x ? [`${x.store}|${x.ns}|${x.type}|${x.id}`] : [];
    }),
  );
  return new Map(
    groups.map((g) => {
      const age = ageMs(g, now);
      const stillTried = tried.has(`${g.store}|${g.ns}|${g.type}|${g.id}`);
      const standing: Standing = moved.has(g)
        ? 'moved'
        : age > retiredAfterMs(g) && !stillTried
          ? 'retired'
          : age > lateAfterMs(g)
            ? 'late'
            : 'ok';
      return [g, standing];
    }),
  );
}

/** The guests that count, oldest backup first; removed ones and those left behind after them, newest first. */
export function guestsInOrder(
  groups: readonly PbsGroup[],
  now: Date,
  tasks: readonly PbsTask[] = [],
): PbsGroup[] {
  const st = standings(groups, now, tasks);
  const counted = (g: PbsGroup) => st.get(g) === 'ok' || st.get(g) === 'late';
  const t = (g: PbsGroup) => g.last?.getTime() ?? 0;
  const active = groups.filter(counted).sort((a, b) => t(a) - t(b));
  const rest = groups.filter((g) => !counted(g)).sort((a, b) => t(b) - t(a));
  return [...active, ...rest];
}

/** A guest that counts: backed up lately, or late (not removed, not left behind). */
const counted = (st: Standing | undefined) => st === 'ok' || st === 'late';

const failedJob = (j: PbsJob) => !!j.lastState && j.lastState !== 'OK' && !/^WARNINGS?/i.test(j.lastState);
const failedTask = (t: PbsTask) => !/^WARNINGS?/i.test(t.status);

function figures(input: PbsInput): ThingPageKpi[] {
  const { snapshot: s, now, names } = input;
  const out: ThingPageKpi[] = [];
  const sized = s.stores.filter((x) => x.total !== null && x.used !== null && (x.total ?? 0) > 0);
  if (sized.length) {
    const total = sized.reduce((a, x) => a + (x.total ?? 0), 0);
    const used = sized.reduce((a, x) => a + (x.used ?? 0), 0);
    const fulls = sized.map((x) => storeFull(x, now)).filter((d): d is Date => d !== null);
    const first = fulls.sort((a, b) => a.getTime() - b.getTime())[0];
    out.push(
      usedKpi(
        'used',
        'Used',
        used,
        total,
        `${usedOf(used, total)}${first ? ` · ${lowerFirst(fullWords(first, now, input.timeZone))}` : ''}`,
      ),
    );
  }
  const standing = standings(s.groups, now, s.tasks ?? []);
  const active = guestsInOrder(s.groups, now, s.tasks ?? []).filter((g) => counted(standing.get(g)));
  const oldest = active[0];
  if (oldest?.last) {
    const late = standing.get(oldest) === 'late';
    out.push({
      key: 'oldest',
      label: 'Oldest backup',
      value: span(now.getTime() - oldest.last.getTime()),
      rest: 'ago',
      sub: clip(guestName(oldest, names), 80),
      ...(late ? { tone: 'bad' as const } : {}),
    });
  } else if (s.stores.length)
    out.push({ key: 'oldest', label: 'Oldest backup', value: 'None', sub: 'No backups yet' });
  if (s.tasks) {
    const n = s.tasks.filter(failedTask).length;
    out.push({
      key: 'failed',
      label: 'Failed',
      value: thousands(n),
      sub: n ? 'tasks in 7 days' : 'Nothing in 7 days',
      ...(n ? { tone: 'warn' as const } : {}),
    });
  }
  if (s.jobs) {
    const verify = s.jobs.filter((j) => j.kind === 'verify');
    const damaged = s.groups.reduce((a, g) => a + g.damaged, 0);
    const failed = verify.filter(failedJob);
    const last = verify
      .map((j) => j.lastEnd)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (failed.length || damaged)
      out.push({
        key: 'verified',
        label: 'Verified',
        value: damaged ? 'Damage found' : 'Failed',
        sub: damaged
          ? `${plural(damaged, 'backup')} failed`
          : failed[0]?.lastEnd
            ? ago(failed[0].lastEnd, now)
            : 'Last run',
        tone: 'bad',
      });
    else if (last) out.push({ key: 'verified', label: 'Verified', value: 'OK', sub: ago(last, now) });
    else
      out.push({
        key: 'verified',
        label: 'Verified',
        value: verify.length ? 'Not yet' : 'No job',
        sub: verify.length ? 'Never ran' : 'No verify job set up',
      });
  }
  return out;
}

/** A line's id on the page, short enough (a hash of the key past 120 characters). */
const lineId = (prefix: string, key: string) =>
  `${prefix}-${key}`.length <= 120 ? `${prefix}-${key}` : `${prefix}-${shortHash([key])}`;

/** A guest group as a line's subject (QN-03): `guest:<store>/<ns>/<type>/<id>`, the long part hashed past 160. */
export function guestSubject(g: PbsGroup, names: ReadonlyMap<string, GuestName>) {
  const full = `guest:${g.store}/${g.ns}/${g.type}/${g.id}`;
  return {
    id: full.length <= 160 ? full : `guest:${shortHash([g.store, g.ns])}/${g.type}/${g.id}`,
    name: clip(guestName(g, names), 80),
  };
}

/** A backup task's guest: `store:vm/105`, `store:ns/lab/vm/900`. */
function taskGuest(t: PbsTask): { store: string; ns: string; type: GroupType; id: string } | null {
  if (t.type !== 'backup' || !t.workerId) return null;
  const [store, ...rest] = t.workerId.split(':');
  const parts = rest.join(':').split('/');
  const id = parts.pop();
  const type = parts.pop() as GroupType | undefined;
  if (!store || !id || !type || !TYPES.has(type)) return null;
  const ns: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] === 'ns') ns.push(parts[i + 1] as string);
  return { store, ns: ns.join('/'), type, id };
}

const TASK_JOB: Record<string, JobKind> = {
  garbage_collection: 'gc',
  verificationjob: 'verify',
  prunejob: 'prune',
  syncjob: 'sync',
};

/**
 * A failed task another line already tells, or that a later run made good (QN-04, QN-S4x): a backup of a guest backed up
 * since, or late (its late line says it); a job's task when the job's own last run is newer (its job line, or fine).
 */
function taskCovered(t: PbsTask, s: PbsSnapshot, standing: ReadonlyMap<PbsGroup, Standing>): boolean {
  const guest = taskGuest(t);
  if (guest) {
    const g = s.groups.find(
      (x) => x.store === guest.store && x.ns === guest.ns && x.type === guest.type && x.id === guest.id,
    );
    if (!g) return false;
    return (!!g.last && g.last >= t.start) || standing.get(g) !== 'ok';
  }
  const kind = TASK_JOB[t.type];
  if (!kind) return false;
  const w = t.workerId ?? '';
  const job = (s.jobs ?? []).find(
    (j) => j.kind === kind && (kind === 'gc' ? w === j.store : w.split(':').includes(j.id)),
  );
  return !!job?.lastEnd && job.lastEnd.getTime() >= t.start.getTime();
}

/** The newest failed backup task of a guest, for its late line. */
function lastTry(g: PbsGroup, tasks: readonly PbsTask[]): PbsTask | undefined {
  return tasks
    .filter((t) => {
      const x = taskGuest(t);
      return x && x.store === g.store && x.ns === g.ns && x.type === g.type && x.id === g.id;
    })
    .sort((a, b) => b.start.getTime() - a.start.getTime())[0];
}

function notices(input: PbsInput): KindNotice[] {
  const { snapshot: s, now, timeZone, names, url } = input;
  const out: KindNotice[] = [];
  for (const st of s.stores) {
    const subject = { id: `store:${st.name}`, name: clip(st.name, 80) };
    if (st.error) {
      out.push({
        id: `store-${st.name}`.slice(0, 120),
        icon: 'database',
        detail: clip(st.error, 200),
        check: 'pbs.store_unavailable',
        subject,
        ignore: fixed(UNTIL.back),
        ...(st.away
          ? {
              // Unplugged or in maintenance on purpose: worth knowing, nothing to fix.
              tone: 'info' as const,
              nature: 'fyi' as const,
              title: clip(
                st.away === 'unplugged'
                  ? `Datastore ${st.name} isn’t plugged in`
                  : `Datastore ${st.name} is in maintenance mode`,
                120,
              ),
            }
          : {
              tone: 'bad' as const,
              nature: 'problem' as const,
              title: clip(`Datastore ${st.name} can’t be used`, 120),
              link: lookInto(`Why can’t ${NAME} use datastore ${st.name}?`),
            }),
      });
      continue;
    }
    if (st.total && st.used !== null) {
      const p = (st.used / st.total) * 100;
      const full = storeFull(st, now);
      const soon = full && full.getTime() - now.getTime() <= 30 * DAY ? full : null;
      const f = fullness(p, st.total - st.used);
      if (f)
        out.push({
          id: `full-${st.name}`.slice(0, 120),
          ...f,
          icon: 'disk',
          title: clip(
            soon
              ? `Datastore ${st.name} is ${lowerFirst(fullWords(soon, now, timeZone))}`
              : `Datastore ${st.name} is ${pct(p)} full`,
            120,
          ),
          detail: `${usedOf(st.used, st.total)} used.`,
          check: 'pbs.store_full',
          subject,
          ignore: fixed(UNTIL.fuller),
          ...(f.nature === 'problem'
            ? {
                link: lookInto(
                  `Datastore ${st.name} on ${NAME} is ${pct(p)} full. What takes the space, and do the prune and garbage collection jobs keep up?`,
                ),
              }
            : {}),
        });
      else if (soon)
        // A forecast while there is room: a heads-up until it is nearly full (QN-04).
        out.push({
          id: `full-soon-${st.name}`.slice(0, 120),
          tone: 'info',
          nature: 'fyi',
          icon: 'disk',
          title: clip(`Datastore ${st.name} is ${lowerFirst(fullWords(soon, now, timeZone))}`, 120),
          detail: `${usedOf(st.used, st.total)} used.`,
          check: 'pbs.store_full_soon',
          subject,
          ignore: fixed('Until it’s nearly full.'),
        });
    }
  }
  const failed = (s.tasks ?? []).filter(failedTask);
  const standing = standings(s.groups, now, failed);
  const ordered = guestsInOrder(s.groups, now, failed);
  const late = ordered.filter((g) => standing.get(g) === 'late');
  out.push(
    ...itemLines(
      late,
      (g) => {
        const who = guestName(g, names);
        const since = span(now.getTime() - (g.last as Date).getTime());
        const tried = lastTry(g, failed);
        const title = clip(`No backup of ${who} for ${since}`, 120);
        return {
          id: lineId('late', `${g.store}-${g.ns}-${g.type}-${g.id}`),
          tone: 'bad',
          icon: 'backup',
          title,
          ...(title.length > 40 ? { badge: `No backup for ${since}` } : {}),
          detail: clip(
            `The last one was ${when(g.last as Date, now, timeZone)}, on ${g.store}.${
              tried ? ` The last try failed: ${statusWords(tried.status)}` : ''
            }`,
            200,
          ),
          link: lookInto(
            `${NAME} has no backup of ${who} (${groupLabel(g)}) for ${since}. Why, and how do we fix it?`,
          ),
          nature: 'problem',
          check: 'pbs.backup_late',
          subject: guestSubject(g, names),
          // A new backup is a new episode: a late one after it is news again.
          ignore: newer(UNTIL.nextBackup),
          episode: (g.last as Date).toISOString(),
        };
      },
      (g) => guestSubject(g, names).id,
      (rest) => ({
        id: 'late-more',
        tone: 'bad',
        icon: 'backup',
        title: `${plural(rest.length, 'more guest')} without a recent backup`,
        link: lookInto(`${plural(rest.length, 'more guest')} on ${NAME} have no recent backup. Why?`),
        nature: 'problem',
        check: 'pbs.backup_late',
      }),
    ),
  );
  const damaged = s.groups.filter((g) => g.damaged > 0).sort((a, b) => b.damaged - a.damaged);
  out.push(
    ...itemLines(
      damaged,
      (g) => ({
        id: lineId('damaged', `${g.store}-${g.ns}-${g.type}-${g.id}`),
        tone: 'bad',
        icon: 'backup',
        title: clip(`${plural(g.damaged, 'backup')} of ${guestName(g, names)} failed verification`, 120),
        detail: 'A damaged backup can’t be restored.',
        link: { kind: 'url', label: 'Open it', url },
        nature: 'problem',
        check: 'pbs.verify_failed',
        subject: guestSubject(g, names),
        // More damaged backups is worse: the band is how many.
        band: g.damaged,
        ignore: fixed('Until another backup fails verification.'),
      }),
      (g) => guestSubject(g, names).id,
      (rest) => ({
        id: 'damaged-more',
        tone: 'bad',
        icon: 'backup',
        title: `Backups of ${plural(rest.length, 'more guest')} failed verification`,
        link: { kind: 'url', label: 'Open it', url },
        nature: 'problem',
        check: 'pbs.verify_failed',
        band: rest.reduce((a, g) => a + g.damaged, 0),
      }),
    ),
  );
  const jobs = (s.jobs ?? []).filter(failedJob).sort((a, b) => JOB_ORDER[a.kind] - JOB_ORDER[b.kind]);
  const jobName = (j: PbsJob) =>
    j.kind === 'gc' ? `Garbage collection on ${j.store}` : `${JOB_NAME[j.kind]} job ${j.id}`;
  out.push(
    ...itemLines(
      jobs,
      (j) => ({
        id: clip(`job-${j.kind}-${j.id}`, 120),
        tone: j.kind === 'verify' ? 'bad' : 'warn',
        icon: j.kind === 'gc' ? 'disk' : 'backup',
        title: clip(`${jobName(j)} failed`, 120),
        detail: clip(
          `${statusWords(j.lastState ?? '')}${j.lastEnd ? ` · ${when(j.lastEnd, now, timeZone)}` : ''}`,
          200,
        ),
        link: lookInto(`Why did ${jobName(j).toLowerCase()} fail on ${NAME}?`),
        nature: 'problem',
        check: 'pbs.job_failed',
        subject: { id: `job:${j.kind}/${j.id}`, name: clip(jobName(j), 80) },
        ignore: newer(UNTIL.nextRun),
        ...(j.lastEnd ? { episode: j.lastEnd.toISOString() } : {}),
      }),
      (j) => `job:${j.kind}/${j.id}`,
      (rest) => ({
        id: 'job-more',
        tone: rest.some((j) => j.kind === 'verify') ? 'bad' : 'warn',
        icon: 'backup',
        title: `${plural(rest.length, 'more job')} failed`,
        link: lookInto(`Why did ${plural(rest.length, 'job')} fail on ${NAME}?`),
        nature: 'problem',
        check: 'pbs.job_failed',
      }),
    ),
  );
  // One line per worker whose newest failure nothing else tells (QN-04: no duplicates of the lines above).
  const byWorker = new Map<string, PbsTask[]>();
  for (const t of [...failed].sort((a, b) => b.start.getTime() - a.start.getTime())) {
    const key = `${t.type}/${t.workerId ?? ''}`;
    byWorker.set(key, [...(byWorker.get(key) ?? []), t]);
  }
  const open = [...byWorker.entries()].filter(([, ts]) => !taskCovered(ts[0] as PbsTask, s, standing));
  const restore = (t: PbsTask) => t.type === 'reader';
  out.push(
    ...itemLines(
      open.sort(([, a], [, b]) => Number(restore(a[0] as PbsTask)) - Number(restore(b[0] as PbsTask))),
      ([key, ts]) => {
        const t = ts[0] as PbsTask;
        const what = taskWords(t);
        return {
          id: lineId('task', key.toLowerCase().replace(/[^a-z0-9/:_-]+/g, '-')),
          icon: 'warn',
          title: clip(`${what} failed${ts.length > 1 ? ` ${ts.length} times` : ''}`, 120),
          detail: clip(`${statusWords(t.status)} · ${when(t.start, now, timeZone)}`, 200),
          link: { kind: 'url', label: 'Show tasks', url },
          // A restore someone started is theirs to see, not something wrong with the backups.
          ...(restore(t)
            ? { tone: 'info' as const, nature: 'fyi' as const }
            : { tone: 'warn' as const, nature: 'problem' as const }),
          check: 'pbs.task_failed',
          subject: { id: clip(`task:${key}`, 160), name: clip(what, 80) },
          ignore: newer('Until it fails again.'),
          episode: t.upid,
        };
      },
      ([key]) => `task:${key}`,
      (rest) => ({
        id: 'task-more',
        tone: 'warn',
        icon: 'warn',
        title: `${plural(rest.length, 'more kind')} of task failed`,
        link: { kind: 'url', label: 'Show tasks', url },
        nature: 'problem',
        check: 'pbs.task_failed',
      }),
    ),
  );
  const retired = ordered.filter((g) => g.last && standing.get(g) === 'retired');
  out.push(
    ...itemLines(
      retired,
      (g) => ({
        id: lineId('retired', `${g.store}-${g.ns}-${g.type}-${g.id}`),
        tone: 'info',
        icon: 'backup',
        title: clip(
          `${guestName(g, names)} was last backed up ${span(now.getTime() - (g.last as Date).getTime())} ago`,
          120,
        ),
        detail: 'Removed guests keep their backups until they’re pruned.',
        nature: 'fyi',
        check: 'pbs.retired',
        subject: guestSubject(g, names),
        ignore: fixed('Until it’s backed up or pruned.'),
      }),
      (g) => guestSubject(g, names).id,
      (rest) => ({
        id: 'retired-more',
        tone: 'info',
        icon: 'backup',
        title: `${plural(rest.length, 'more guest')} last backed up long ago`,
        detail: 'Removed guests keep their backups until they’re pruned.',
        nature: 'fyi',
        check: 'pbs.retired',
      }),
    ),
  );
  return worstFirst(out);
}

/** Every check Proxmox Backup Server's lines can raise (QN-15). */
export const PBS_CHECKS: readonly KindCheck[] = [
  {
    check: 'pbs.store_unavailable',
    name: 'Datastores that can’t be used',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'pbs.store_full',
    name: 'Datastores filling up',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'pbs.store_full_soon',
    name: 'Datastores full within a month',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'pbs.backup_late',
    name: 'Guests without a recent backup',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'pbs.verify_failed',
    name: 'Backups failing verification',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  { check: 'pbs.job_failed', name: 'Jobs failing', nature: 'problem', perItem: true, startsOn: true },
  {
    check: 'pbs.task_failed',
    name: 'Other tasks failing',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'pbs.retired',
    name: 'Old guests still in the backups',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
];

/** The checks this read couldn't see whole (QN-11): an Ignore of their lines doesn't end now. */
export function pbsSkipped(s: PbsSnapshot): string[] {
  const out: string[] = [];
  if (!s.storesComplete) out.push('pbs.store_unavailable', 'pbs.store_full', 'pbs.store_full_soon');
  if (!s.groupsComplete) out.push('pbs.backup_late', 'pbs.retired');
  if (!s.groupsComplete || !s.snapshotsRead) out.push('pbs.verify_failed');
  if (!s.jobs) out.push('pbs.job_failed');
  if (!s.tasks || s.tasksCapped) out.push('pbs.task_failed');
  return out;
}

/** What a datastore gained over the last 7 days, in GB, from PBS's own usage history; null without a week of it. */
export function storeWeekGb(st: PbsStore, now: Date): number | null {
  if (!st.total) return null;
  const known = st.history.filter((p) => p.value !== null);
  const last = known[known.length - 1];
  const from = now.getTime() - 7 * DAY;
  // The reading nearest to a week ago, within a day of it.
  const then = known
    .filter((p) => Math.abs(p.at.getTime() - from) <= DAY)
    .sort((a, b) => Math.abs(a.at.getTime() - from) - Math.abs(b.at.getTime() - from))[0];
  if (!last || !then || last === then) return null;
  return (((last.value as number) - (then.value as number)) * st.total) / 1e9;
}

/** “+120 GB this week”, “No change this week”. */
const weekWords = (gb: number) =>
  Math.abs(gb) < 0.05 ? 'No change this week' : `${signedSize(gb)} this week`;

/** Backups made over the last 7 days, from the kept snapshots' times. */
function backupsThisWeek(groups: readonly PbsGroup[], now: Date): number {
  const from = (now.getTime() - 7 * DAY) / 1000;
  return groups.reduce((a, g) => a + (g.times ?? []).filter((t) => t > from).length, 0);
}

/**
 * Inventory “What it keeps”: each datastore, how full and what it gained this week (from PBS's own usage history), the
 * guests (late ones in red) and the backups kept with those made this week.
 */
function keptLines(input: PbsInput): ThingPageItem[] {
  const { snapshot: s, now, timeZone, url, names } = input;
  const out: ThingPageItem[] = s.stores.map((st) => {
    const id = `store-${st.name}`;
    if (st.error || !st.total || st.used === null) {
      const away =
        st.away === 'unplugged' ? 'Not plugged in' : st.away === 'maintenance' ? 'In maintenance' : null;
      return countLine({
        id,
        title: st.name,
        icon: 'disk',
        detail: away ?? (st.error ? st.error : 'Not read'),
        ...(st.error && !st.away ? { tone: 'bad' as const } : {}),
        value: away ? 'Away' : st.error ? 'Unavailable' : '—',
        url,
      });
    }
    const p = (st.used / st.total) * 100;
    const tone = fullTone(p);
    const full = storeFull(st, now);
    const week = storeWeekGb(st, now);
    return countLine({
      id,
      title: st.name,
      icon: 'disk',
      // Short: the figure says how full; the line says when it's full, else how much of how much.
      detail: [
        full ? fullWords(full, now, timeZone) : usedOf(st.used, st.total),
        st.backend === 's3' ? 'S3' : null,
      ]
        .filter(Boolean)
        .join(' · '),
      ...(tone ? { tone } : {}),
      value: pct(p),
      ...(week !== null ? { note: weekWords(week) } : {}),
      ...(tone ? { noteTone: tone } : {}),
      url,
    });
  });
  const failed = (s.tasks ?? []).filter(failedTask);
  const standing = standings(s.groups, now, failed);
  const active = guestsInOrder(s.groups, now, failed).filter((g) => counted(standing.get(g)));
  if (active.length) {
    const late = active.filter((g) => standing.get(g) === 'late').length;
    const oldest = active[0];
    out.push(
      countLine({
        id: 'guests',
        title: 'Guests',
        icon: 'device',
        ...(oldest?.last
          ? { detail: `Oldest backup ${ago(oldest.last, now)} · ${guestName(oldest, names)}` }
          : {}),
        ...(late ? { tone: 'bad' as const } : {}),
        value: thousands(active.length),
        note: late ? `${late} late` : 'All backed up',
        noteTone: late ? 'bad' : 'ok',
      }),
    );
    const kept = active.reduce((a, g) => a + g.count, 0);
    const made = s.snapshotsRead ? backupsThisWeek(active, now) : null;
    out.push(
      countLine({
        id: 'backups',
        title: 'Backups',
        icon: 'backup',
        detail: 'Kept on all datastores',
        value: thousands(kept),
        ...(made !== null ? { note: made ? `+${thousands(made)} this week` : 'None this week' } : {}),
        ...(made ? { noteTone: 'ok' as const } : made === 0 ? { noteTone: 'warn' as const } : {}),
      }),
    );
  }
  return out;
}

/**
 * Trend “Backups this week”: the backups made each day, from the kept snapshots' times of every guest read. The change
 * on the week before only when every guest keeps more than two weeks (pruning to a week would make it look empty).
 */
function backupsWeek(input: PbsInput): TrendPanel | null {
  const { snapshot: s, now, timeZone } = input;
  if (!s.snapshotsRead || !s.groups.length) return null;
  const days = lastDays(now, timeZone, 14);
  const moments = s.groups.flatMap((g) => (g.times ?? []).map((t) => new Date(t * 1000)));
  const per = countByDay(moments, days.keys, timeZone);
  const week = per.slice(-7);
  const total = week.reduce((a, b) => a + b, 0);
  const before = per.slice(0, 7).reduce((a, b) => a + b, 0);
  const from = now.getTime() - 14 * DAY;
  const reachesBack = s.groups.every((g) => g.first !== null && g.first.getTime() <= from);
  const thin = s.groups.some((g) => g.first && g.first.getTime() > now.getTime() - 7 * DAY);
  return trend({
    id: 'week',
    title: 'Backups this week',
    // Pruning keeps fewer than a week of some: the bars count what is kept.
    meta: thin ? 'Only what’s kept' : 'Made per day',
    days: { at: days.at.slice(-7), labels: days.labels.slice(-7) },
    values: week,
    label: 'Backups',
    color: 'green',
    figure: { value: thousands(total), rest: total === 1 ? 'backup this week' : 'backups this week' },
    change: reachesBack ? weekChange(total, before) : null,
  });
}

function guestRows(input: PbsInput): ThingPageRow[] {
  const { snapshot: s, now, names } = input;
  const many = new Set(s.groups.map((g) => g.store)).size > 1;
  const failed = (s.tasks ?? []).filter(failedTask);
  const standing = standings(s.groups, now, failed);
  return guestsInOrder(s.groups, now, failed)
    .slice(0, GUESTS_MAX)
    .map((g) => {
      const named = g.type !== 'host' ? names.get(`${g.type}/${g.id}`) : undefined;
      const retired = !counted(standing.get(g));
      const late = standing.get(g) === 'late';
      const where = [many ? g.store : null, g.ns || null].filter(Boolean).join(' · ');
      const note = [named ? groupLabel(g) : null, where || null].filter(Boolean).join(' · ');
      return {
        id: clip(`${g.store}:${g.ns}:${g.type}/${g.id}`, 200),
        cells: {
          guest: {
            text: named?.name ?? groupLabel(g),
            ...(note ? { note: clip(note, 80) } : {}),
            ...(named ? { href: named.href } : {}),
            ...(retired ? { tone: 'muted' as const } : {}),
          },
          last: g.last
            ? {
                text: ago(g.last, now),
                dot: late ? ('bad' as const) : retired ? ('off' as const) : ('ok' as const),
                ...(late ? { tone: 'bad' as const } : retired ? { tone: 'muted' as const } : {}),
              }
            : { text: 'Never', tone: 'muted' as const },
          size: g.size !== null ? { text: bytes(g.size), mono: true } : { text: '—', tone: 'muted' as const },
          count: { text: thousands(g.count), mono: true },
          verified:
            g.damaged > 0
              ? { text: 'Damaged', dot: 'bad' as const, tone: 'bad' as const }
              : g.verified === 'ok'
                ? { text: 'OK', dot: 'ok' as const }
                : { text: '—', tone: 'muted' as const },
        },
      };
    });
}

/** A job's last run: “OK · 2 days ago”, “Failed · 3 h ago”, “Never ran”. */
function lastRun(j: PbsJob, now: Date) {
  if (!j.lastState && !j.lastEnd) return { text: 'Never ran', tone: 'muted' as const };
  const failed = failedJob(j);
  const warned = !!j.lastState && /^WARNINGS?/i.test(j.lastState);
  const word = failed ? 'Failed' : warned ? 'Warnings' : 'OK';
  return {
    text: j.lastEnd ? `${word} · ${ago(j.lastEnd, now)}` : word,
    dot: failed ? ('bad' as const) : warned ? ('warn' as const) : ('ok' as const),
    ...(failed ? { note: clip(statusWords(j.lastState ?? ''), 80) } : {}),
  };
}

const JOB_ORDER: Record<JobKind, number> = { verify: 0, gc: 1, prune: 2, sync: 3 };

/**
 * The jobs, verify first: PBS's own list, and a cleanup row for a datastore without a garbage collection job (PBS before
 * 3.4 lists none, yet runs one when asked).
 */
export function jobsShown(s: PbsSnapshot): PbsJob[] {
  if (!s.jobs) return [];
  const cleaned = new Set(s.jobs.filter((j) => j.kind === 'gc').map((j) => j.store));
  const extra: PbsJob[] = s.stores
    .filter((st) => !st.error && !cleaned.has(st.name))
    .map((st) => ({
      kind: 'gc',
      id: st.name,
      store: st.name,
      lastState: null,
      lastEnd: null,
      nextRun: null,
      remote: null,
    }));
  return [...s.jobs, ...extra].sort(
    (a, b) =>
      JOB_ORDER[a.kind] - JOB_ORDER[b.kind] || a.store.localeCompare(b.store) || a.id.localeCompare(b.id),
  );
}

/** Run verify on a verify job, Run cleanup on a datastore's garbage collection; both asked first. */
function jobButton(j: PbsJob, ctx: ButtonCtx) {
  if (j.kind === 'verify')
    return button(ctx, {
      action: 'verify',
      target: j.id,
      label: 'Run verify',
      icon: 'check',
      confirm: {
        title: clip(`Run verify job ${j.id} now?`, 80),
        body: 'Proxmox Backup Server reads the backups it covers to make sure they can be restored. On a big datastore that takes hours.',
        button: 'Run verify',
      },
    });
  if (j.kind === 'gc')
    return button(ctx, {
      action: 'cleanup',
      target: j.store,
      label: 'Run cleanup',
      icon: 'clean',
      confirm: {
        title: clip(`Clean up ${j.store} now?`, 80),
        body: 'Garbage collection frees the space that pruned backups left behind. It reads the whole datastore and takes a while; backups keep working.',
        button: 'Run cleanup',
      },
    });
  return null;
}

/** A job's name on its line: “Verify · tank”, “Garbage collection · offsite”, “Sync from pbs-home”. */
const jobTitle = (j: PbsJob) =>
  j.kind === 'sync' && j.remote ? `Sync from ${clip(j.remote, 60)}` : `${JOB_NAME[j.kind]} · ${j.store}`;

/** Live “Jobs”: each job with its last run and next, failed ones red, with Run verify and Run cleanup. */
function jobItems(input: PbsInput): ThingPageItem[] {
  const { snapshot: s, now, timeZone } = input;
  return jobsShown(s)
    .slice(0, 40)
    .map((j) => {
      const action = jobButton(j, input.buttons);
      // PBS's own error is in Worth a look: the line keeps to when and what's next.
      const last: { text: string; dot?: string } = lastRun(j, now);
      const next = j.nextRun ? `next ${untilWords(j.nextRun, now, timeZone)}` : null;
      return {
        id: clip(`${j.kind}:${j.id}`, 200),
        title: clip(jobTitle(j), 160),
        detail: clip([last.text, next].filter(Boolean).join(' · '), 300),
        icon: 'backup' as const,
        ...(last.dot === 'bad'
          ? { tone: 'bad' as const }
          : last.dot === 'warn'
            ? { tone: 'warn' as const }
            : {}),
        ...(action ? { actions: [action] } : {}),
      };
    });
}

/** Live's line: what failed, else the next job to run. */
function jobsMeta(input: PbsInput): string | undefined {
  const { snapshot: s, now, timeZone } = input;
  const jobs = jobsShown(s);
  const failed = jobs.filter(failedJob).length;
  if (failed) return `${failed} failed last time`;
  const next = jobs
    .filter((j): j is PbsJob & { nextRun: Date } => !!j.nextRun && j.nextRun > now)
    .sort((a, b) => a.nextRun.getTime() - b.nextRun.getTime())[0];
  return next
    ? `Next: ${lowerFirst(JOB_NAME[next.kind])} ${untilWords(next.nextRun, now, timeZone)}`
    : undefined;
}

function failedItems(input: PbsInput): ThingPageItem[] {
  const { snapshot: s } = input;
  return (s.tasks ?? [])
    .filter(failedTask)
    .slice(0, 10)
    .map((t) => ({
      id: t.upid,
      title: taskWords(t),
      detail: statusWords(t.status),
      at: t.start.toISOString(),
      tone: 'bad' as const,
      icon: 'backup' as const,
    }));
}

/**
 * The page's Proxmox Backup Server part (SD-50), in slots: Live “Jobs” with their buttons, Inventory “What it keeps”
 * (datastores, guests, backups), the Trend of backups made per day; each guest's last backup and what failed below. Its
 * machine is the one Whombat watches it on, else only its version (PBS's own figures need more than Audit). Pure.
 */
export function pbsView(input: PbsInput): KindView {
  const { snapshot: s, now, url } = input;
  const standing = standings(s.groups, now, (s.tasks ?? []).filter(failedTask));
  const active = s.groups.filter((g) => counted(standing.get(g)));
  const late = active.filter((g) => standing.get(g) === 'late').length;
  const more: ThingPagePanel[] = [];
  if (s.groups.length)
    more.push({
      kind: 'table',
      id: 'guests',
      title: 'Guests',
      meta: `${plural(active.length, 'guest')} · oldest backup first`,
      columns: [
        { key: 'guest', label: 'Guest' },
        { key: 'last', label: 'Last backup' },
        { key: 'size', label: 'Size', numeric: true },
        { key: 'count', label: 'Backups', numeric: true },
        { key: 'verified', label: 'Verified' },
      ],
      rows: guestRows(input),
    });
  const failed = failedItems(input);
  if (failed.length)
    more.push({
      kind: 'list',
      id: 'failed',
      title: 'Failed in 7 days',
      link: { kind: 'url', label: 'Open it', url },
      items: failed,
    });
  const jobs = jobItems(input);
  const kept = keptLines(input);
  const meta = jobsMeta(input);
  const slotted = slotPanels({
    // The ids stay the ones the desk's widgets name.
    live: jobs.length
      ? liveList({ id: 'jobs', title: 'Jobs', ...(meta ? { meta } : {}), items: jobs })
      : null,
    inventory: kept.length
      ? inventory({
          id: 'datastores',
          title: 'What it keeps',
          meta: plural(s.stores.length, 'datastore'),
          items: kept,
        })
      : null,
    trend: backupsWeek(input),
    more,
    machine: s.version
      ? [{ id: 'pbs-version', label: 'Proxmox Backup Server', value: clip(s.version, 40), pct: null }]
      : [],
  });

  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`Proxmox Backup Server **${s.version}**`));
  if (active.length) facts.push(line(`**${plural(active.length, 'guest')}** backed up`));
  const shown = notices(input);
  return {
    ...slotted,
    kpis: [],
    charts: [],
    notices: shown,
    tabs: [],
    facts,
    // The calm words count only guests backed up in time (a late one quietened still isn't).
    status: statusOf(
      shown,
      !active.length
        ? 'Backups running'
        : late
          ? `${active.length - late} of ${plural(active.length, 'guest')} backed up`
          : `All ${plural(active.length, 'guest')} backed up`,
    ),
    open: { label: 'Open Proxmox Backup Server', url },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Biggest backups', 'Backups per day', 'Machines not in a backup plan'],
  };
}

/* The page ----------------------------------------------------------------------------------------------------------- */

export async function pbsPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = serviceUrl(row);
  const [read, names] = await Promise.all([
    pbsLatest(services, row, now),
    pveGuestNames(services, ctx.burrowId).catch(() => new Map<string, GuestName>()),
  ]);
  if (!read.ok) return unreadView(NAME, url, problemOf(read.error, NAME).message, read.refreshing);
  const view = pbsView({ snapshot: read.value, now, timeZone: ctx.timeZone, url, names, buttons: ctx });
  return { ...view, refreshing: read.refreshing };
}

/* Buttons (SD-07) ---------------------------------------------------------------------------------------------------- */

/** Run verify: one verify job now, as it is set up in PBS. */
export const runVerify: KindAction = async ({ services, row, now }, { target }) => {
  const s = await pbsSnapshot(services, row, now);
  const job = (s.jobs ?? []).find((j) => j.kind === 'verify' && j.id === target);
  if (!job) throw badRequest('Choose one of the verify jobs on the page.');
  await actAs(services, row, NAME, { method: 'POST', path: `${API}/admin/verify/${enc(job.id)}/run` });
  return {
    message: `Verify job ${job.id} started. It reads every backup it covers, which can take a while.`,
    title: clip(`Started verify job ${job.id} on ${job.store}`, 200),
  };
};

/** Run cleanup: garbage collection on one datastore now (frees the space pruned backups left). */
export const runCleanup: KindAction = async ({ services, row, now }, { target }) => {
  const s = await pbsSnapshot(services, row, now);
  const store = s.stores.find((x) => x.name === target && !x.error);
  if (!store) throw badRequest('Choose one of the datastores on the page.');
  await actAs(services, row, NAME, { method: 'POST', path: `${API}/admin/datastore/${enc(store.name)}/gc` });
  return {
    message: `Cleanup of ${store.name} started. Space comes free as it goes.`,
    title: clip(`Started garbage collection on ${store.name}`, 200),
  };
};

export const PBS_KIND: KindModule = {
  page: pbsPage,
  prefetch: (services, row, now) => pbsLatest(services, row, now),
  async seen(services, row, now, timeZone) {
    const [s, names] = await Promise.all([
      pbsSnapshot(services, row, now),
      // The same names as the page, so the card's reason and the desk say “web” too.
      row.burrowId
        ? pveGuestNames(services, row.burrowId).catch(() => new Map<string, GuestName>())
        : new Map<string, GuestName>(),
    ]);
    const input = { snapshot: s, now, timeZone, url: serviceUrl(row), names, buttons: { row } };
    const view = pbsView(input);
    // The card keeps its figures: the page has none of its own in slots.
    return seenOf(
      cardOf(
        { kpis: figures(input), notices: view.notices },
        ['oldest', 'failed'],
        s.version ? `Backups · Proxmox Backup Server ${s.version}` : 'Backups',
      ),
      view.notices as KindNotice[],
      pbsSkipped(s),
    );
  },
  actions: { verify: runVerify, cleanup: runCleanup },
  checks: PBS_CHECKS,
};
