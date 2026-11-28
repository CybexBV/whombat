/**
 * TrueNAS's page (service-dashboards.md SD-51, SD-S17): its pools — health, how full, the last scrub — the disks and
 * their temperatures, the apps, the snapshot, replication and cloud tasks' last results, and TrueNAS's own alerts in
 * its words. Read over its JSON-RPC socket (TrueNAS 25.04 and later; REST is gone in 26) in one session: `system.info`,
 * `alert.list`, `pool.query`, `disk.query`, `disk.temperatures`, `app.query`, `update.status` (25.10; else
 * `update.check_available`, kept an hour), `replication.query`, `pool.snapshottask.query`, `cloudsync.query`,
 * `cloud_backup.query` — the last four with `select`, so stored credentials never come along. SMART reaches the page
 * only through `alert.list` (25.10 has no other read).
 *
 * Buttons (SD-07): **Scrub** a pool (`pool.scrub.run` now), **Start** and **Stop** an app, **Dismiss** a non-critical
 * alert (everyday, SD-08). Never `app.upgrade` or `update.run` (SD-02).
 */

import type {
  JsonValue,
  ThingGalleryItem,
  ThingLine,
  ThingPageBar,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageRow,
} from '@whombat/core';
import { truenasProtection } from '../../../backup-trust/protection';
import type { CatalogConnectionRow } from '../../../connections/types';
import { badRequest } from '../../../lib/errors';
import type { Services } from '../../../services';
import type { KindCheck, NoticeNature } from '../../quiet/types';
import type { RawPoint } from '../../series';
import {
  bytes,
  clip,
  dateOf,
  line,
  list,
  num,
  pct,
  plural,
  rec,
  span,
  str,
  thousands,
  when,
} from '../../words';
import { cachedRead, KIND_DEADLINE_MS, latestRead, withDeadline } from '../read';
import type { KindAction, KindModule } from '../registry';
import { countLine, inventory, liveRows, slotPanels } from '../slots';
import type { KindCtx, KindView } from '../types';
import { fixed, fullness, itemLines, type KindNotice, lookInto, newer, UNTIL, worstOf } from './lines';
import { disksLine, readSpace, spaceWeek, usedPoint } from './nas';
import {
  ago,
  type ButtonCtx,
  button,
  cardOf,
  celsius,
  daysBetween,
  fullTone,
  seenOf,
  serviceUrl,
  statusOf,
  tempTone,
  unreadView,
  usedKpi,
  usedOf,
  worstFirst,
} from './shared';
import {
  missingMethod,
  resultOf,
  TRUENAS,
  type TrueNasCall,
  truenasAct,
  truenasCalls,
  truenasProblem,
} from './truenas-socket';

const NAME = TRUENAS;
/** A scrub older than this is worth a look (SD-51: 5 weeks). */
export const SCRUB_DAYS = 35;
/** 25.04's update check asks iXsystems: kept an hour. */
const UPDATE_CACHE_MS = 60 * 60_000;
const DISKS_MAX = 60;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export type AlertLevel = 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL' | 'ALERT' | 'EMERGENCY';

export interface TnAlert {
  uuid: string;
  level: AlertLevel;
  text: string;
  at: Date | null;
  /** TrueNAS's alert class (`VolumeStatus`, `SMART`) and its key within the class: together the alert's identity. */
  klass: string | null;
  key: string | null;
}

export interface TnPool {
  name: string;
  status: string;
  healthy: boolean;
  detail: string | null;
  size: number | null;
  allocated: number | null;
  scan: {
    kind: string;
    state: string;
    end: Date | null;
    percent: number | null;
    errors: number;
    /** While it runs: about how long is left, in seconds. */
    leftS?: number | null;
  } | null;
  disks: string[];
  /** Its data vdevs' layout (`RAIDZ1`, `MIRROR`). */
  layout?: string | null;
}

export interface TnDisk {
  /** The kernel's name (`sda`): it can change across reboots, so lines key on `serial` when there is one. */
  name: string;
  serial: string | null;
  model: string | null;
  size: number | null;
  ssd: boolean;
}

export interface TnApp {
  name: string;
  state: string;
  /** A new app version or only newer images. */
  update: boolean;
  /** A new app version (`upgrade_available`), not only newer images: only these make a line (QN-S4x). */
  upgrade: boolean;
  version: string | null;
}

export interface TnTask {
  id: string;
  kind: 'snapshot' | 'replication' | 'cloudsync' | 'cloudbackup';
  name: string;
  /** `ok`, `failed`, `aborted` (someone stopped it), `running`, or null when it never ran. */
  result: 'ok' | 'failed' | 'aborted' | 'running' | null;
  at: Date | null;
  error: string | null;
  /** How far a cloud sync or backup that runs is (`job.progress.percent`). */
  percent?: number | null;
}

export interface TrueNasSnapshot {
  readAt: Date;
  version: string | null;
  hostname: string | null;
  uptimeS: number | null;
  /** The processor's name and threads, the memory in bytes and whether it is ECC (`system.info`). */
  cpu?: { model: string | null; cores: number | null } | null;
  memory?: { bytes: number; ecc: boolean } | null;
  alerts: TnAlert[] | null;
  pools: TnPool[];
  disks: TnDisk[];
  temps: Map<string, number>;
  apps: TnApp[] | null;
  update: { available: boolean; version: string | null } | null;
  tasks: TnTask[];
  /** The methods that didn't answer (not those this TrueNAS hasn't got): their checks are skipped (QN-11). */
  unread: string[];
}

/** TrueNAS's dates: `{ "$date": ms }`, epoch seconds or milliseconds, or ISO text. */
export function tnDate(v: unknown): Date | null {
  const d = rec(v).$date;
  if (typeof d === 'number' && Number.isFinite(d)) return new Date(d);
  return dateOf(v);
}

const LEVELS: AlertLevel[] = ['INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'];

/** An alert's words without TrueNAS's HTML (`<a href=…>`, `<br>`), in one line. */
export function plainText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `alert.list`: the ones not dismissed, worst first. */
export function parseAlerts(result: unknown): TnAlert[] {
  return list(result)
    .flatMap((raw) => {
      const a = rec(raw);
      const uuid = str(a.uuid) ?? str(a.id);
      const level = str(a.level)?.toUpperCase() as AlertLevel | undefined;
      const text = plainText(str(a.formatted) ?? str(a.text) ?? '');
      if (!uuid || a.dismissed === true || !text) return [];
      return [
        {
          uuid: uuid.slice(0, 200),
          level: level && LEVELS.includes(level) ? level : 'WARNING',
          text,
          at: tnDate(a.datetime),
          klass: str(a.klass)?.slice(0, 80) ?? null,
          key: str(a.key)?.slice(0, 80) ?? null,
        },
      ];
    })
    .sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level));
}

/** The disks of a pool's topology (`data`, `cache`, `log`, `spare`, `special`, `dedup`). */
function topologyDisks(topology: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    for (const raw of list(v)) {
      const x = rec(raw);
      const disk = str(x.disk);
      if (disk) out.push(disk);
      walk(x.children);
    }
  };
  for (const part of Object.values(rec(topology))) walk(part);
  return [...new Set(out)];
}

/** `pool.query`. */
export function parsePools(result: unknown): TnPool[] {
  return list(result).flatMap((raw) => {
    const p = rec(raw);
    const name = str(p.name);
    if (!name) return [];
    const scan = rec(p.scan);
    return [
      {
        name: clip(name, 60),
        status: str(p.status) ?? 'UNKNOWN',
        healthy: p.healthy === true,
        detail: str(p.status_detail),
        size: num(p.size),
        allocated: num(p.allocated),
        scan: str(scan.function)
          ? {
              kind: str(scan.function) as string,
              state: str(scan.state) ?? '',
              end: tnDate(scan.end_time),
              percent: num(scan.percentage),
              errors: num(scan.errors) ?? 0,
              leftS: num(scan.total_secs_left),
            }
          : null,
        disks: topologyDisks(p.topology),
        layout: str(rec(list(rec(p.topology).data)[0]).type),
      },
    ];
  });
}

/** `disk.query`. */
export function parseDisks(result: unknown): TnDisk[] {
  return list(result).flatMap((raw) => {
    const d = rec(raw);
    const name = str(d.name);
    if (!name) return [];
    return [
      {
        name,
        serial: str(d.serial)?.slice(0, 80) ?? null,
        model: str(d.model),
        size: num(d.size),
        ssd: str(d.type) === 'SSD' || name.startsWith('nvme'),
      },
    ];
  });
}

/** `disk.temperatures`: `{ "sda": 34 }` (or `{ "sda": { temp: 34 } }` with its thresholds). */
export function parseTemps(result: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, v] of Object.entries(rec(result))) {
    const t = num(v) ?? num(rec(v).temp);
    if (t !== null) out.set(name, t);
  }
  return out;
}

/** `app.query`. */
export function parseApps(result: unknown): TnApp[] {
  return list(result).flatMap((raw) => {
    const a = rec(raw);
    const name = str(a.name) ?? str(a.id);
    if (!name) return [];
    return [
      {
        name: clip(name, 60),
        state: (str(a.state) ?? 'UNKNOWN').toUpperCase(),
        update: a.upgrade_available === true || a.image_updates_available === true,
        upgrade: a.upgrade_available === true,
        version: str(a.human_version) ?? str(a.version),
      },
    ];
  });
}

/** `update.status` (25.10) or `update.check_available` (25.04). */
export function parseUpdate(status: unknown, available: unknown): TrueNasSnapshot['update'] {
  const s = rec(rec(status).status);
  if (Object.keys(rec(status)).length) {
    const next = rec(s.new_version);
    const version = str(next.version);
    return { available: !!version, version };
  }
  const a = rec(available);
  if (!str(a.status)) return null;
  return { available: a.status === 'AVAILABLE', version: str(a.version) };
}

const STATE_RESULT: Record<string, TnTask['result']> = {
  SUCCESS: 'ok',
  FINISHED: 'ok',
  FAILED: 'failed',
  ERROR: 'failed',
  ABORTED: 'aborted',
  RUNNING: 'running',
};

/** Snapshot and replication tasks (`state`), cloud sync and backup tasks (`job`). */
export function parseTasks(kind: TnTask['kind'], result: unknown): TnTask[] {
  return list(result).flatMap((raw) => {
    const t = rec(raw);
    const id = num(t.id) ?? str(t.id);
    if (id === null || t.enabled === false) return [];
    const name =
      kind === 'snapshot'
        ? str(t.dataset)
        : kind === 'replication'
          ? str(t.name)
          : (str(t.description) ?? str(t.path));
    const state = rec(t.state);
    const job = rec(t.job);
    const raw_ = str(state.state) ?? str(job.state);
    return [
      {
        id: `${kind}-${id}`,
        kind,
        name: clip(name ?? `Task ${id}`, 80),
        result: raw_ ? (STATE_RESULT[raw_.toUpperCase()] ?? null) : null,
        at: tnDate(state.datetime) ?? tnDate(job.time_finished),
        error: str(state.error) ?? str(job.error),
        percent: num(rec(job.progress).percent),
      },
    ];
  });
}

const sel = (fields: string[]): JsonValue => [[], { select: fields }];

/** The methods of one page read, in order. */
export const READ_CALLS: readonly TrueNasCall[] = [
  { method: 'system.info' },
  { method: 'alert.list' },
  { method: 'pool.query' },
  { method: 'disk.query', params: sel(['name', 'serial', 'model', 'size', 'type']) },
  { method: 'disk.temperatures' },
  {
    method: 'app.query',
    params: sel([
      'name',
      'id',
      'state',
      'upgrade_available',
      'image_updates_available',
      'human_version',
      'version',
    ]),
  },
  { method: 'update.status' },
  { method: 'replication.query', params: sel(['id', 'name', 'enabled', 'state']) },
  { method: 'pool.snapshottask.query', params: sel(['id', 'dataset', 'enabled', 'state']) },
  { method: 'cloudsync.query', params: sel(['id', 'description', 'path', 'enabled', 'job']) },
  { method: 'cloud_backup.query', params: sel(['id', 'description', 'path', 'enabled', 'job']) },
];

export async function readTrueNas(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<TrueNasSnapshot> {
  const replies = await truenasCalls(services, row, READ_CALLS, { deadlineMs: KIND_DEADLINE_MS });
  const r = (method: string) => replies[READ_CALLS.findIndex((c) => c.method === method)];
  const info = rec(resultOf(r('system.info')));
  // 25.04 has no `update.status`: its own check, kept an hour.
  const older = missingMethod(r('update.status'))
    ? await cachedRead(
        services,
        `truenas-update:${row.id}`,
        row,
        async () =>
          resultOf(
            (
              await truenasCalls(services, row, [{ method: 'update.check_available' }], {
                deadlineMs: KIND_DEADLINE_MS,
              })
            )[0],
          ),
        UPDATE_CACHE_MS,
      ).catch(() => null)
    : null;
  const apps = r('app.query');
  return {
    readAt: now,
    version: str(info.version)?.replace(/^TrueNAS-(SCALE-)?/i, '') ?? null,
    hostname: str(info.hostname),
    uptimeS: num(info.uptime_seconds),
    cpu: str(info.model) || num(info.cores) ? { model: str(info.model), cores: num(info.cores) } : null,
    memory: num(info.physmem) ? { bytes: num(info.physmem) as number, ecc: info.ecc_memory === true } : null,
    alerts: r('alert.list')?.ok ? parseAlerts(resultOf(r('alert.list'))) : null,
    pools: parsePools(resultOf(r('pool.query'))),
    disks: parseDisks(resultOf(r('disk.query'))),
    temps: parseTemps(resultOf(r('disk.temperatures'))),
    apps: apps?.ok ? parseApps(apps.result) : null,
    update: parseUpdate(resultOf(r('update.status')), older),
    tasks: [
      ...parseTasks('snapshot', resultOf(r('pool.snapshottask.query'))),
      ...parseTasks('replication', resultOf(r('replication.query'))),
      ...parseTasks('cloudsync', resultOf(r('cloudsync.query'))),
      ...parseTasks('cloudbackup', resultOf(r('cloud_backup.query'))),
    ],
    unread: READ_CALLS.map((c) => c.method).filter((m) => {
      const reply = r(m);
      if (reply?.ok || missingMethod(reply)) return false;
      // 25.04's own update check stands in for `update.status`.
      return !(m === 'update.status' && older !== null);
    }),
  };
}

function load(services: Services, row: CatalogConnectionRow, now: Date) {
  return async () => {
    try {
      return await withDeadline(
        readTrueNas(services, row, now),
        KIND_DEADLINE_MS + 2_000,
        `${NAME} didn’t answer in time.`,
      );
    } catch (err) {
      throw truenasProblem(err);
    }
  };
}

export function truenasLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `truenas:${row.id}`, row, load(services, row, now));
}

export function truenasSnapshot(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return cachedRead(services, `truenas:${row.id}`, row, load(services, row, now));
}

/* Words -------------------------------------------------------------------------------------------------------------- */

const SERIOUS = new Set<AlertLevel>(['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']);
/** Alerts TrueNAS lets anyone dismiss; critical ones stay until fixed (SD-51). */
const UNDISMISSABLE = new Set<AlertLevel>(['CRITICAL', 'ALERT', 'EMERGENCY']);

/** “Degraded”, “Online”: a pool's state as a word. */
const stateWord = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : 'Unknown');

const scrubbing = (p: TnPool) => p.scan?.state === 'SCANNING';

const TASK_NAME: Record<TnTask['kind'], string> = {
  snapshot: 'Snapshots',
  replication: 'Replication',
  cloudsync: 'Cloud sync',
  cloudbackup: 'Cloud backup',
};

/** “Snapshots of tank/docs”, “Replication to-backup”. */
export function taskTitle(t: TnTask): string {
  return t.kind === 'snapshot' ? `Snapshots of ${t.name}` : `${TASK_NAME[t.kind]} ${t.name}`;
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface TrueNasInput {
  snapshot: TrueNasSnapshot;
  now: Date;
  timeZone: string;
  url: string;
  buttons: ButtonCtx;
  /** Whombat's readings of the used space, the last 15 days. */
  space?: readonly RawPoint[];
}

/** Used and in all over every pool, in bytes; null without sizes. */
export function truenasSpace(s: TrueNasSnapshot): { used: number; total: number } | null {
  const sized = s.pools.filter((p) => p.size && p.allocated !== null);
  if (!sized.length) return null;
  return {
    used: sized.reduce((a, p) => a + (p.allocated ?? 0), 0),
    total: sized.reduce((a, p) => a + (p.size ?? 0), 0),
  };
}

/** The card's figures (Pools, Used, Alerts, Apps): the page has none in slots. */
export function truenasFigures(s: TrueNasSnapshot): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  if (s.pools.length) {
    const healthy = s.pools.filter((p) => p.healthy).length;
    out.push({
      key: 'pools',
      label: 'Pools',
      value: healthy === s.pools.length ? `${healthy} healthy` : `${healthy} of ${s.pools.length}`,
      ...(healthy === s.pools.length
        ? { sub: plural(s.disks.length, 'disk') }
        : { sub: 'healthy', tone: 'bad' as const }),
    });
    const sized = s.pools.filter((p) => p.size && p.allocated !== null);
    const total = sized.reduce((a, p) => a + (p.size ?? 0), 0);
    const used = sized.reduce((a, p) => a + (p.allocated ?? 0), 0);
    if (total > 0) out.push(usedKpi('used', 'Used', used, total));
  }
  if (s.alerts) {
    const serious = s.alerts.filter((a) => SERIOUS.has(a.level)).length;
    const warnings = s.alerts.filter((a) => a.level === 'WARNING').length;
    const parts = [
      serious ? `${serious} serious` : null,
      warnings ? plural(warnings, 'warning') : null,
    ].filter(Boolean);
    out.push({
      key: 'alerts',
      label: 'Alerts',
      value: thousands(s.alerts.length),
      sub: parts.length ? parts.join(' · ') : s.alerts.length ? 'Notes only' : 'None',
      ...(serious ? { tone: 'bad' as const } : warnings ? { tone: 'warn' as const } : {}),
    });
  }
  if (s.apps?.length) {
    const running = s.apps.filter((a) => a.state === 'RUNNING').length;
    const crashed = s.apps.filter((a) => a.state === 'CRASHED').length;
    const stopped = s.apps.filter((a) => a.state === 'STOPPED').length;
    const updates = s.apps.filter((a) => a.update).length;
    const parts = [
      crashed ? `${crashed} crashed` : null,
      stopped ? `${stopped} stopped` : null,
      updates ? plural(updates, 'update') : null,
    ].filter(Boolean);
    out.push({
      key: 'apps',
      label: 'Apps',
      value: `${running} running`,
      sub: parts.length ? parts.join(' · ') : `of ${s.apps.length}`,
      ...(crashed ? { tone: 'warn' as const } : {}),
    });
  }
  return out;
}

function dismissButton(ctx: ButtonCtx, a: TnAlert) {
  return button(ctx, { action: 'dismiss', target: a.uuid, label: 'Clear in TrueNAS', icon: 'close' });
}

/* Worth a look (quiet-notices.md QN-01…QN-04, QN-S4x) ------------------------------------------------------------------ */

/** Every check TrueNAS's page can raise (QN-15). */
export const TRUENAS_CHECKS: readonly KindCheck[] = [
  {
    check: 'truenas.pool',
    name: 'Storage that isn’t working properly',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'truenas.scrub_errors',
    name: 'Damage found in a data check',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'truenas.scrub_overdue',
    name: 'Storage not checked for damage in 5 weeks',
    nature: 'you',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'truenas.pool_full',
    name: 'Storage filling up',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  { check: 'truenas.alert', name: 'TrueNAS’s own alerts', nature: 'problem', perItem: true, startsOn: false },
  {
    check: 'truenas.task',
    name: 'Snapshot, replication and cloud tasks that don’t finish',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  { check: 'truenas.disk_temp', name: 'Disks running hot', nature: 'you', perItem: true, startsOn: false },
  {
    check: 'truenas.app_crashed',
    name: 'Apps that crashed',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  { check: 'truenas.update', name: 'TrueNAS updates', nature: 'fyi', perItem: false, startsOn: false },
  { check: 'truenas.app_update', name: 'App updates', nature: 'fyi', perItem: true, startsOn: false },
];

/** The checks a method's answer feeds: when it didn't answer, an Ignore of them doesn't end (QN-11). */
const CHECKS_OF: Record<string, readonly string[]> = {
  'pool.query': ['truenas.pool', 'truenas.scrub_errors', 'truenas.scrub_overdue', 'truenas.pool_full'],
  'alert.list': ['truenas.alert'],
  'disk.query': ['truenas.disk_temp'],
  'disk.temperatures': ['truenas.disk_temp'],
  'app.query': ['truenas.app_crashed', 'truenas.app_update'],
  'update.status': ['truenas.update'],
  'replication.query': ['truenas.task'],
  'pool.snapshottask.query': ['truenas.task'],
  'cloudsync.query': ['truenas.task'],
  'cloud_backup.query': ['truenas.task'],
};

/** The checks this read couldn't see (QN-11, QN-S4x). */
export function truenasSkipped(s: TrueNasSnapshot): string[] {
  const out = new Set(s.unread.flatMap((m) => CHECKS_OF[m] ?? []));
  if (!s.alerts) out.add('truenas.alert');
  if (!s.apps) for (const c of CHECKS_OF['app.query'] ?? []) out.add(c);
  if (!s.update) out.add('truenas.update');
  return [...out];
}

/**
 * TrueNAS's own alerts of what Whombat already says in its own line (QN-04: duplicates go): the pool's state, how
 * full it is, a paused scrub; a disk's temperature when the temperatures were read.
 */
const SHOWN_CLASSES = new Set([
  'VolumeStatus',
  'ZpoolCapacityWarning',
  'ZpoolCapacityCritical',
  'ScrubPaused',
]);
const TEMP_CLASS = /temperature/i;

/** SMART and a disk's temperature: only a person can replace a disk or fix the airflow. */
const DISK_CLASS = /smart|temperature|disk/i;
/** Updates (not a failed one) are heads-ups. */
const UPDATE_CLASS = /update/i;

/** A badge for the head and the card when the title is too long for them (≤40). */
const badgeIf = (title: string, badge: string) => (title.length > 40 ? { badge: clip(badge, 40) } : {});

/** The last finished scan of a pool, a scrub or a resilver: both read every block (QN-04: a resilver isn't “never”). */
const lastScan = (p: TnPool) => (p.scan?.state === 'FINISHED' && p.scan.end ? p.scan.end : null);

function poolLines(input: TrueNasInput, p: TnPool): KindNotice[] {
  const { now, url } = input;
  const out: KindNotice[] = [];
  const subject = { id: `pool:${p.name}`, name: clip(p.name, 80) };
  if (!p.healthy) {
    const word = stateWord(p.status).toLowerCase();
    const title = clip(
      word === 'online' ? `Storage “${p.name}” isn’t working properly` : `Storage “${p.name}” is ${word}`,
      120,
    );
    out.push({
      id: `pool-${p.name}`,
      tone: 'bad',
      icon: 'disk',
      title,
      ...(p.detail ? { detail: clip(p.detail, 200) } : {}),
      link: { kind: 'url', label: 'Open TrueNAS', url: `${url}/ui/storage` },
      nature: 'problem',
      check: 'truenas.pool',
      subject,
      ignore: fixed(UNTIL.healthy),
      episode: p.status.toLowerCase(),
      ...badgeIf(title, `${p.name} isn’t working properly`),
    });
  }
  if (p.scan?.kind === 'SCRUB' && p.scan.state === 'FINISHED' && p.scan.errors > 0) {
    const title = clip(`The last data check of “${p.name}” found ${plural(p.scan.errors, 'error')}`, 120);
    out.push({
      id: `scrub-errors-${p.name}`,
      tone: 'bad',
      icon: 'disk',
      title,
      link: lookInto(
        `What did the last data check (scrub) of pool ${p.name} find on TrueNAS, and is any data damaged?`,
      ),
      nature: 'problem',
      check: 'truenas.scrub_errors',
      subject,
      ignore: newer('Until the next data check.'),
      ...(p.scan.end ? { episode: p.scan.end.toISOString() } : {}),
      ...badgeIf(title, `${p.name} has damaged data`),
    });
  }
  if (!scrubbing(p)) {
    // A pool with no finished scan is new (TrueNAS keeps the last scan with the pool): its first data check comes on
    // TrueNAS's own schedule, and there is nothing to do until then, so it makes no line.
    const last = lastScan(p);
    if (last && daysBetween(last, now) > SCRUB_DAYS) {
      const title = clip(
        `“${p.name}” hasn’t had its data check in ${span(now.getTime() - last.getTime())}`,
        120,
      );
      out.push({
        id: `scrub-${p.name}`,
        tone: 'warn',
        icon: 'clock',
        title,
        detail: 'TrueNAS normally checks all data for damage every 5 weeks and repairs what it can.',
        action: scrubButton(input.buttons, p),
        nature: 'you',
        check: 'truenas.scrub_overdue',
        subject,
        ignore: fixed('Until the next data check.'),
        episode: last.toISOString(),
        ...badgeIf(title, `${p.name} needs a data check`),
      });
    }
  }
  if (p.size && p.allocated !== null) {
    const pc = (p.allocated / p.size) * 100;
    const full = fullness(pc, p.size - p.allocated);
    if (full) {
      const title = clip(`“${p.name}” is ${Math.round(pc)} % full`, 120);
      out.push({
        id: `full-${p.name}`,
        ...full,
        icon: 'disk',
        title,
        detail: `${usedOf(p.allocated, p.size)} used. TrueNAS gets slow when it’s nearly full.`,
        ...(full.nature === 'problem'
          ? { link: lookInto(`What is taking the space on pool ${p.name} on TrueNAS?`) }
          : {}),
        check: 'truenas.pool_full',
        subject,
        ignore: fixed(UNTIL.fuller),
        ...badgeIf(title, `${p.name} is ${Math.round(pc)} % full`),
      });
    }
  }
  return out;
}

/** An alert's nature (QN-01): notes are heads-ups, a disk's SMART or temperature only you, updates heads-ups. */
function alertNature(a: TnAlert): NoticeNature {
  if (a.level === 'INFO' || a.level === 'NOTICE') return 'fyi';
  const klass = a.klass ?? '';
  if (UPDATE_CLASS.test(klass) && !/fail/i.test(klass)) return 'fyi';
  if (DISK_CLASS.test(klass)) return 'you';
  return 'problem';
}

/** “NTPHealthCheck” → “NTP health check”. */
export function classWords(klass: string): string {
  return klass
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .map((w, i) => (i > 0 && /^[A-Z][a-z]/.test(w) ? w.toLowerCase() : w))
    .join(' ');
}

/** The words of an alert's key: `["/dev/sdb"]` → “/dev/sdb”; none for TrueNAS's `null`. */
function keyWords(key: string | null): string | null {
  if (!key || key === 'null') return null;
  try {
    const v: unknown = JSON.parse(key);
    const parts = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' || typeof x === 'number');
    return parts.length ? parts.join(', ') : null;
  } catch {
    return key;
  }
}

/**
 * An alert's subject: TrueNAS's own identity of it, its class and key (“SMART · /dev/sdb”), so Ignore and Stop watching
 * are about that one, also when it comes back with a new uuid; without a class, the alert itself (QN-S4x).
 */
export function alertSubject(a: TnAlert, words: string): NonNullable<KindNotice['subject']> {
  if (!a.klass) return { id: clip(`alert:${a.uuid}`, 160), name: clip(words, 80) };
  const key = keyWords(a.key);
  return {
    id: clip(`alert:${a.klass}${key ? `/${key}` : ''}`, 160),
    name: clip(`${classWords(a.klass)}${key ? ` · ${key}` : ''}`, 80),
  };
}

/**
 * Whombat's own title for a TrueNAS alert of a common class: TrueNAS writes for admins (“Device: /dev/sdb [SAT], 8
 * Currently unreadable (pending) sectors.”), so its words go in the detail; null for a class not listed here.
 */
const ALERT_TITLES: readonly [RegExp, string][] = [
  [/temperature/i, 'A disk is running hot'],
  [/smart|disk/i, 'A disk reports a problem'],
  [/scrub/i, 'A data check had a problem'],
  [/ntp|clock/i, 'The clock is wrong'],
  [/zpool|volume|pool/i, 'Storage isn’t working properly'],
  [/certificate/i, 'A certificate is about to run out'],
  [/replication/i, 'Copying to another place failed'],
  [/cloudsync|cloud/i, 'A cloud copy failed'],
  [/snapshot/i, 'Automatic snapshots had a problem'],
  [/update/i, 'TrueNAS has an update'],
];

export function alertTitle(a: Pick<TnAlert, 'klass' | 'level'>): string {
  const own = a.klass ? ALERT_TITLES.find(([re]) => re.test(a.klass as string))?.[1] : undefined;
  if (own) return own;
  return SERIOUS.has(a.level)
    ? 'TrueNAS reports a problem'
    : a.level === 'WARNING'
      ? 'TrueNAS has a warning'
      : 'TrueNAS has a note';
}

function alertLine(input: TrueNasInput, a: TnAlert): KindNotice {
  const { now, timeZone, url } = input;
  const tone = SERIOUS.has(a.level) ? 'bad' : a.level === 'WARNING' ? 'warn' : 'info';
  const nature = alertNature(a);
  const [first] = a.text.split(/(?<=\.)\s+/);
  const title = alertTitle(a);
  const said = plainText(a.text);
  const link =
    nature === 'problem'
      ? lookInto(`TrueNAS says: “${clip(a.text, 200)}” What is wrong, and how do I fix it?`)
      : nature === 'you' && DISK_CLASS.test(a.klass ?? '')
        ? { kind: 'url' as const, label: 'Open disks', url: `${url}/ui/storage/disks` }
        : undefined;
  return {
    id: clip(`alert-${a.uuid}`, 120),
    tone,
    icon: /disk|smart|pool|scrub|zfs/i.test(a.text) ? 'disk' : /update/i.test(a.text) ? 'update' : 'warn',
    title,
    detail: clip(a.at ? `${said} · ${when(a.at, now, timeZone)}` : said, 200),
    ...(link ? { link } : {}),
    ...(UNDISMISSABLE.has(a.level) ? {} : { action: dismissButton(input.buttons, a) }),
    nature,
    check: 'truenas.alert',
    subject: alertSubject(a, first ?? a.text),
    ignore: fixed('Until TrueNAS clears it.'),
    ...badgeIf(
      title,
      SERIOUS.has(a.level)
        ? 'A serious TrueNAS alert'
        : tone === 'warn'
          ? 'A TrueNAS warning'
          : 'A TrueNAS note',
    ),
  };
}

function taskLine(input: TrueNasInput, t: TnTask): KindNotice {
  const { now, timeZone, url } = input;
  const aborted = t.result === 'aborted';
  const title = clip(`${taskTitle(t)} ${aborted ? 'was stopped' : 'failed'}`, 120);
  const detail = [t.error ? plainText(t.error) : null, t.at ? when(t.at, now, timeZone) : null]
    .filter(Boolean)
    .join(' · ');
  return {
    id: clip(`task-${t.id}`, 120),
    // Someone stopping a task isn't a failure (QN-04): a heads-up.
    tone: aborted ? 'info' : 'warn',
    icon: 'backup',
    title,
    ...(detail ? { detail: clip(detail, 200) } : {}),
    link: { kind: 'url', label: 'Open TrueNAS', url: `${url}/ui/data-protection` },
    nature: aborted ? 'fyi' : 'problem',
    check: 'truenas.task',
    subject: { id: clip(`task:${t.id}`, 160), name: clip(taskTitle(t), 80) },
    ignore: newer(UNTIL.nextRun),
    ...(t.at ? { episode: t.at.toISOString() } : {}),
    ...badgeIf(
      title,
      aborted
        ? `A ${TASK_NAME[t.kind].toLowerCase()} task stopped`
        : `A ${TASK_NAME[t.kind].toLowerCase()} task failed`,
    ),
  };
}

/** A disk's subject: its serial when TrueNAS gave one (the kernel's name can change across reboots), else its name. */
export const diskSubject = (d: TnDisk) => ({
  id: clip(`disk:${d.serial ?? d.name}`, 160),
  name: clip(`Disk ${d.name}`, 80),
});

function hotLine(input: TrueNasInput, d: TnDisk, t: number, tone: 'warn' | 'bad'): KindNotice {
  const title = clip(`Disk ${d.name} is at ${celsius(t)}`, 120);
  return {
    id: `hot-${d.name}`,
    tone,
    icon: 'disk',
    title,
    detail: 'Disks wear faster when they run hot. Check the airflow and the fans.',
    // Warm is a heads-up; hot is only you: the airflow and the fans (QN-S4x).
    ...(tone === 'bad'
      ? { link: { kind: 'url' as const, label: 'Open disks', url: `${input.url}/ui/storage/disks` } }
      : {}),
    nature: tone === 'bad' ? 'you' : 'fyi',
    check: 'truenas.disk_temp',
    subject: diskSubject(d),
    ignore: fixed(UNTIL.cooler),
    confirm: 2,
  };
}

function crashedLine(input: TrueNasInput, a: TnApp): KindNotice {
  const start = appButton(input.buttons, a);
  return {
    id: clip(`crashed-${a.name}`, 120),
    tone: 'warn',
    icon: 'power',
    title: clip(`App ${a.name} has crashed`, 120),
    link: lookInto(`Why does the app ${a.name} crash on TrueNAS?`),
    ...(start ? { action: start } : {}),
    nature: 'problem',
    check: 'truenas.app_crashed',
    subject: { id: clip(`app:${a.name}`, 160), name: clip(a.name, 80) },
    ignore: fixed(UNTIL.running),
    // Crash-looping apps flip between crashed and starting from one pass to the next (QN-04).
    confirm: 2,
    ...badgeIf(`App ${a.name} has crashed`, `${a.name} crashed`),
  };
}

function appUpdateLine(input: TrueNasInput, a: TnApp): KindNotice {
  return {
    id: clip(`app-update-${a.name}`, 120),
    tone: 'info',
    icon: 'update',
    title: clip(`${a.name} has an update`, 120),
    ...(a.version ? { detail: clip(`It runs ${a.version}.`, 200) } : {}),
    link: { kind: 'url', label: 'Open apps', url: `${input.url}/ui/apps/installed` },
    nature: 'fyi',
    check: 'truenas.app_update',
    subject: { id: clip(`app:${a.name}`, 160), name: clip(a.name, 80) },
    ignore: fixed('Until it’s updated.'),
    ...(a.version ? { episode: a.version } : {}),
  };
}

/** The rest of a list past eight lines as one (QN-03): its own words, the worst tone and nature among them. */
function restOf(
  lines: KindNotice[],
  check: string,
  id: string,
  title: (n: number) => string,
  icon: KindNotice['icon'],
): KindNotice[] {
  return itemLines(
    lines,
    (l) => l,
    (l) => l.subject?.id ?? l.id,
    (rest) => ({ id, ...worstOf(rest), icon, title: clip(title(rest.length), 120), check }),
  );
}

function notices(input: TrueNasInput): KindNotice[] {
  const { snapshot: s, url } = input;
  const out: KindNotice[] = [];
  for (const p of s.pools) out.push(...poolLines(input, p));
  const alerts = (s.alerts ?? []).filter(
    (a) =>
      !(a.klass && SHOWN_CLASSES.has(a.klass)) && !(a.klass && TEMP_CLASS.test(a.klass) && s.temps.size > 0),
  );
  out.push(
    ...restOf(
      worstFirst(alerts.map((a) => alertLine(input, a))),
      'truenas.alert',
      'alert-more',
      (n) => `${plural(n, 'more TrueNAS alert')}`,
      'warn',
    ),
  );
  out.push(
    ...restOf(
      worstFirst(
        s.tasks.filter((t) => t.result === 'failed' || t.result === 'aborted').map((t) => taskLine(input, t)),
      ),
      'truenas.task',
      'task-more',
      (n) => `${plural(n, 'more task')} didn’t finish`,
      'backup',
    ),
  );
  const hot = s.disks.flatMap((d) => {
    const t = s.temps.get(d.name);
    const tone = t !== undefined ? tempTone(t, d.ssd) : undefined;
    return t !== undefined && tone ? [hotLine(input, d, t, tone)] : [];
  });
  out.push(
    ...restOf(
      worstFirst(hot),
      'truenas.disk_temp',
      'hot-more',
      (n) => `${plural(n, 'more disk')} run warm`,
      'disk',
    ),
  );
  out.push(
    ...restOf(
      (s.apps ?? []).filter((x) => x.state === 'CRASHED').map((a) => crashedLine(input, a)),
      'truenas.app_crashed',
      'crashed-more',
      (n) => `${plural(n, 'more app')} crashed`,
      'power',
    ),
  );
  if (s.update?.available)
    out.push({
      id: 'update',
      tone: 'info',
      icon: 'update',
      title: 'TrueNAS has an update',
      detail: s.update.version
        ? `Version ${s.update.version}${s.version ? `; this one runs ${s.version}` : ''}. Install it in TrueNAS.`
        : 'Install it in TrueNAS.',
      link: { kind: 'url', label: 'Open updates', url: `${url}/ui/system/update` },
      nature: 'fyi',
      check: 'truenas.update',
      ignore: newer(UNTIL.version),
      episode: s.update.version ?? 'unknown',
    });
  // Only a new app version makes a line; newer images alone are too frequent to be worth one (QN-S4x).
  out.push(
    ...restOf(
      (s.apps ?? []).filter((a) => a.upgrade).map((a) => appUpdateLine(input, a)),
      'truenas.app_update',
      'app-update-more',
      (n) => `${plural(n, 'more app')} ${n === 1 ? 'has an update' : 'have updates'}`,
      'update',
    ),
  );
  return worstFirst(out);
}

/** Scrub: now, whatever TrueNAS's own schedule says; asked first. Not while one runs. */
function scrubButton(ctx: ButtonCtx, p: TnPool) {
  return button(ctx, {
    action: 'scrub',
    target: p.name,
    label: 'Check now',
    icon: 'check',
    confirm: {
      title: clip(`Check ${p.name} for damage now?`, 80),
      body: 'TrueNAS reads all its data and repairs what it can. It takes hours on a big pool and slows it down meanwhile.',
      button: 'Check now',
    },
  });
}

/** Start a stopped or crashed app; Stop a running one, asked first. */
function appButton(ctx: ButtonCtx, a: TnApp) {
  if (a.state === 'RUNNING')
    return button(ctx, {
      action: 'stop',
      target: a.name,
      label: 'Stop',
      icon: 'stop',
      tone: 'danger',
      confirm: {
        title: clip(`Stop ${a.name}?`, 80),
        body: 'The app stops until someone starts it again. Anyone using it loses it meanwhile.',
        button: 'Stop',
      },
    });
  if (a.state === 'STOPPED' || a.state === 'CRASHED')
    return button(ctx, { action: 'start', target: a.name, label: 'Start', icon: 'play' });
  return null;
}

/** “RAIDZ1”, “Mirror”, “Stripe”. */
const layoutWords = (l: string) => (/^raidz/i.test(l) ? l.toUpperCase() : stateWord(l));

/**
 * Inventory “Storage”: each pool with how full it is and what is free, its layout, its disks and its last check (a pool
 * that isn't healthy red), with Check now; then the disks, and the snapshot and copy tasks.
 */
function storageLines(input: TrueNasInput): ThingPageItem[] {
  const { snapshot: s, now, url } = input;
  const out: ThingPageItem[] = s.pools.map((p) => {
    const pc = p.size && p.allocated !== null ? (p.allocated / p.size) * 100 : null;
    const full = pc !== null ? fullTone(pc) : undefined;
    const last = lastScan(p);
    const old = !scrubbing(p) && !!last && daysBetween(last, now) > SCRUB_DAYS;
    // Short: the line has little room. A check that runs or is overdue says so instead of the disks.
    const third = scrubbing(p)
      ? 'Checking now'
      : old && last
        ? `checked ${ago(last, now)}`
        : p.disks.length
          ? plural(p.disks.length, 'disk')
          : null;
    return countLine({
      id: `pool-${p.name}`,
      title: p.name,
      icon: 'disk',
      detail: [p.healthy ? null : stateWord(p.status), p.layout ? layoutWords(p.layout) : null, third]
        .filter(Boolean)
        .join(' · '),
      ...(!p.healthy
        ? { tone: 'bad' as const }
        : full
          ? { tone: full }
          : old
            ? { tone: 'warn' as const }
            : {}),
      value: pc !== null ? pct(pc) : '—',
      ...(p.size && p.allocated !== null ? { note: `${bytes(Math.max(0, p.size - p.allocated))} free` } : {}),
      ...(full ? { noteTone: full } : {}),
      ...(scrubbing(p) ? {} : { actions: [scrubButton(input.buttons, p)] }),
      url: `${url}/ui/storage`,
    });
  });
  if (s.disks.length)
    out.push(
      disksLine(
        s.disks.map((d) => {
          const t = s.temps.get(d.name) ?? null;
          // TrueNAS tells a disk's health only in its alerts: Worth a look says it.
          return { health: 'ok' as const, tempC: t, warm: t !== null ? tempTone(t, d.ssd) : undefined };
        }),
        `${url}/ui/storage/disks`,
      ),
    );
  if (s.tasks.length) {
    const failed = s.tasks.filter((t) => t.result === 'failed').length;
    const stopped = s.tasks.filter((t) => t.result === 'aborted').length;
    out.push(
      countLine({
        id: 'tasks',
        title: 'Snapshots and copies',
        icon: 'backup',
        ...(failed ? { tone: 'bad' as const } : stopped ? { tone: 'warn' as const } : {}),
        value: thousands(s.tasks.length),
        note: failed ? `${failed} failed` : stopped ? `${stopped} stopped` : 'All OK',
        noteTone: failed ? 'bad' : stopped ? 'warn' : 'ok',
        url: `${url}/ui/data-protection`,
      }),
    );
  }
  return out;
}

function diskRows(input: TrueNasInput): ThingPageRow[] {
  const { snapshot: s } = input;
  const poolOf = new Map<string, string>();
  for (const p of s.pools) for (const d of p.disks) poolOf.set(d, p.name);
  const inPool = (d: TnDisk) => (poolOf.has(d.name) ? 0 : 1);
  return [...s.disks]
    .sort(
      (a, b) =>
        inPool(a) - inPool(b) ||
        (poolOf.get(a.name) ?? '').localeCompare(poolOf.get(b.name) ?? '') ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    )
    .slice(0, DISKS_MAX)
    .map((d) => {
      const t = s.temps.get(d.name);
      const tone = t !== undefined ? tempTone(t, d.ssd) : undefined;
      return {
        id: d.name,
        cells: {
          disk: { text: d.name, mono: true, ...(d.model ? { note: clip(d.model, 80) } : {}) },
          pool: poolOf.has(d.name)
            ? { text: poolOf.get(d.name) as string }
            : { text: 'Not in a pool', tone: 'muted' as const },
          size: d.size ? { text: bytes(d.size), mono: true } : { text: '—', tone: 'muted' as const },
          temp:
            t !== undefined
              ? { text: celsius(t), mono: true, ...(tone ? { tone } : {}) }
              : { text: '—', tone: 'muted' as const },
        },
      };
    });
}

const APP_STATE: Record<string, string> = {
  RUNNING: 'Running',
  STOPPED: 'Stopped',
  CRASHED: 'Crashed',
  DEPLOYING: 'Starting',
  STOPPING: 'Stopping',
};
/** Live's rows at most, beside Storage: the rest are in TrueNAS (Open apps). */
const LIVE_MAX = 5;

/** “1.42.2.10156” from TrueNAS's “1.42.2.10156_1.2.9” (the app's version, then the chart's). */
const appVersion = (v: string) => (v.split('_')[0] ?? v).replace(/^v(?=\d)/i, '');

/** The work running now: a scrub or a rebuild with its bar, a cloud sync or a replication. */
function workRows(input: TrueNasInput): ThingGalleryItem[] {
  const { snapshot: s, url } = input;
  const pools = s.pools.filter(scrubbing).map((p): ThingGalleryItem => {
    const rebuild = p.scan?.kind === 'RESILVER';
    const percent = p.scan?.percent ?? null;
    const left = p.scan?.leftS ?? null;
    return {
      id: clip(`work-pool-${p.name}`, 200),
      title: clip(rebuild ? `Rebuilding ${p.name}` : `Checking ${p.name} for damage`, 120),
      sub: rebuild ? 'After a disk was replaced' : 'A scrub reads every block',
      ...(rebuild ? { badge: { text: 'Rebuilding', tone: 'warn' as const } } : {}),
      ...(percent !== null
        ? { progress: Math.min(1, Math.max(0, percent / 100)), note: `${Math.floor(percent)} %` }
        : { note: 'Running now' }),
      ...(left !== null && left > 0 ? { noteEnd: `about ${span(left * 1000)} left` } : {}),
      url: `${url}/ui/storage`,
    };
  });
  const tasks = s.tasks
    .filter((t) => t.result === 'running')
    .map((t): ThingGalleryItem => {
      const percent = t.percent ?? null;
      return {
        id: clip(`work-${t.id}`, 200),
        title: clip(taskTitle(t), 120),
        sub: t.kind === 'snapshot' ? 'Taking snapshots' : 'Copying to another place',
        ...(percent !== null
          ? { progress: Math.min(1, Math.max(0, percent / 100)), note: `${Math.floor(percent)} %` }
          : {}),
        noteEnd: 'Running now',
        url: `${url}/ui/data-protection`,
      };
    });
  return [...pools, ...tasks];
}

/** The apps, crashed first, then stopped, then those with an update, then running; Start or Stop on each. */
function appItems(input: TrueNasInput): ThingGalleryItem[] {
  const { url } = input;
  const order = (a: TnApp) => (a.state === 'CRASHED' ? 0 : a.state !== 'RUNNING' ? 1 : a.update ? 2 : 3);
  return [...(input.snapshot.apps ?? [])]
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map((a): ThingGalleryItem => {
      const action = appButton(input.buttons, a);
      // Running says nothing: only another state, the version and a waiting update are told.
      const sub = [
        a.state !== 'RUNNING' && a.state !== 'CRASHED' ? (APP_STATE[a.state] ?? stateWord(a.state)) : null,
        a.version ? appVersion(a.version) : null,
        a.update ? 'Update waiting' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        id: clip(`app-${a.name}`, 200),
        title: clip(a.name, 120),
        ...(sub ? { sub: clip(sub, 120) } : {}),
        ...(a.state === 'CRASHED' ? { badge: { text: 'Crashed', tone: 'bad' as const } } : {}),
        ...(a.state === 'STOPPED' ? { muted: true } : {}),
        ...(action ? { actions: [action] } : {}),
        url: `${url}/ui/apps/installed`,
      };
    });
}

/** Live's line: the work running, then how many apps run and what is wrong. */
function liveMeta(s: TrueNasSnapshot, work: number): string | undefined {
  const apps = s.apps ?? [];
  const running = apps.filter((a) => a.state === 'RUNNING').length;
  const crashed = apps.filter((a) => a.state === 'CRASHED').length;
  const stopped = apps.filter((a) => a.state === 'STOPPED').length;
  const parts = [
    work ? `${plural(work, 'job')} running` : null,
    apps.length ? `${running} of ${plural(apps.length, 'app')} running` : null,
    crashed ? `${crashed} crashed` : null,
    stopped ? `${stopped} stopped` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** TrueNAS's own lines in the machine card: its version and whether a newer one is out, how long it has been up. */
function machineLines(s: TrueNasSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version)
    out.push({
      id: 'truenas',
      label: 'TrueNAS',
      value: clip(s.version, 40),
      pct: null,
      ...(s.update
        ? s.update.available
          ? { sub: clip(`${s.update.version ?? 'A new version'} is out`, 120), subTone: 'warn' as const }
          : { sub: 'Up to date', subTone: 'ok' as const }
        : {}),
    });
  // What it is built from: TrueNAS's own figures for how busy need a call Whombat doesn't make yet.
  if (s.cpu?.model)
    out.push({
      id: 'processor',
      label: 'Processor',
      value: clip(s.cpu.model, 40),
      pct: null,
      ...(s.cpu.cores ? { sub: `${s.cpu.cores} threads` } : {}),
    });
  if (s.memory)
    out.push({
      id: 'memory',
      label: 'Memory',
      value: `${Math.round(s.memory.bytes / 1024 ** 3)} GB`,
      pct: null,
      sub: s.memory.ecc ? 'ECC' : 'Not ECC',
    });
  if (s.uptimeS !== null) out.push({ id: 'up', label: 'Up', value: span(s.uptimeS * 1000), pct: null });
  return out;
}

function taskItems(input: TrueNasInput): ThingPageItem[] {
  const { snapshot: s, now } = input;
  const order = (t: TnTask) =>
    t.result === 'failed' ? 0 : t.result === 'running' ? 1 : t.result === 'aborted' ? 2 : 3;
  return [...s.tasks]
    .sort((a, b) => order(a) - order(b))
    .slice(0, 30)
    .map((t) => ({
      id: t.id,
      title: clip(taskTitle(t), 160),
      detail:
        t.result === 'failed'
          ? clip(`Failed${t.at ? ` ${ago(t.at, now)}` : ''}${t.error ? ` · ${plainText(t.error)}` : ''}`, 300)
          : t.result === 'running'
            ? 'Running now'
            : t.result === 'aborted'
              ? clip(`Stopped${t.at ? ` ${ago(t.at, now)}` : ''}`, 300)
              : t.at
                ? `OK · ${ago(t.at, now)}`
                : 'Not run yet',
      tone:
        t.result === 'failed' ? ('bad' as const) : t.result === 'ok' ? ('ok' as const) : ('info' as const),
      icon: 'backup' as const,
    }));
}

/** Questions for the Storage card. */
export function truenasStorageQuestions(s: TrueNasSnapshot): string[] {
  const out: string[] = [];
  if (s.pools.some((p) => !p.healthy)) out.push('Why isn’t my storage pool healthy?');
  if (s.tasks.some((t) => t.result === 'failed')) out.push('Why did a snapshot or copy task fail?');
  out.push('What is taking the most space on TrueNAS?', 'When was each pool last checked for damage?');
  return out.slice(0, 3);
}

/** Questions for the Apps card. */
export function truenasAppQuestions(s: TrueNasSnapshot): string[] {
  const out: string[] = [];
  const crashed = (s.apps ?? []).find((a) => a.state === 'CRASHED');
  if (crashed) out.push(clip(`Why did ${crashed.name} crash on TrueNAS?`, 200));
  out.push('Which TrueNAS apps have updates waiting?', 'Which apps use the most memory?');
  return out.slice(0, 3);
}

/** Questions for the Disks card. */
export function truenasDiskQuestions(s: TrueNasSnapshot): string[] {
  const out: string[] = [];
  const warm = s.disks.some((d) => {
    const t = s.temps.get(d.name);
    return t !== undefined && !!tempTone(t, d.ssd);
  });
  if (warm) out.push('Why are my TrueNAS disks running warm?');
  out.push('Are all my TrueNAS disks healthy?', 'Which disk is running hottest?');
  return out.slice(0, 3);
}

/** One calm sentence for the head while TrueNAS has no active problem. */
export function truenasVerdict(s: TrueNasSnapshot): string {
  const unhealthy = s.pools.filter((p) => !p.healthy);
  if (unhealthy.length === 1) {
    const p = unhealthy[0] as TnPool;
    return clip(`Pool ${p.name} is ${stateWord(p.status).toLowerCase()}.`, 200);
  }
  if (unhealthy.length > 1) return clip(`${unhealthy.length} of ${s.pools.length} pools need a look.`, 200);
  const crashed = (s.apps ?? []).filter((a) => a.state === 'CRASHED').length;
  if (crashed > 0) return clip(`${plural(crashed, 'app')} crashed on TrueNAS.`, 200);
  const active = s.pools.find(scrubbing);
  const space = truenasSpace(s);
  if (s.pools.length > 0) {
    const lead =
      s.pools.length === 1
        ? `Pool ${s.pools[0]?.name} is healthy`
        : `All ${s.pools.length} pools are healthy`;
    if (active) {
      const doing = active.scan?.kind === 'RESILVER' ? 'rebuilding' : 'being checked';
      return clip(`${lead} and ${active.name} is ${doing}.`, 200);
    }
    if (space) return clip(`${lead}, with ${bytes(Math.max(0, space.total - space.used))} free.`, 200);
    return clip(`${lead}.`, 200);
  }
  if (s.apps?.length) {
    const running = s.apps.filter((a) => a.state === 'RUNNING').length;
    return clip(`TrueNAS is fine: ${running} of ${plural(s.apps.length, 'app')} running.`, 200);
  }
  return 'TrueNAS is running fine.';
}

/**
 * The page's TrueNAS part (SD-51), in slots: Live (the work running now with its bar, then the apps, crashed first, with
 * Start or Stop), Inventory “Storage” (each pool with Check now, the disks, the snapshot and copy tasks), the Trend of
 * space added a day from Whombat's readings, TrueNAS's lines in the machine card; the tasks and the disks below. Pure.
 */
export function truenasView(input: TrueNasInput): KindView {
  const { snapshot: s, url } = input;
  const more: ThingPagePanel[] = [];
  const tasks = taskItems(input);
  if (tasks.length)
    more.push({
      kind: 'list',
      id: 'tasks',
      title: 'Snapshots and copies',
      link: { kind: 'url', label: 'Open TrueNAS', url: `${url}/ui/data-protection` },
      items: tasks,
    });
  if (s.disks.length)
    more.push({
      kind: 'table',
      id: 'disks',
      title: 'Disks',
      meta: plural(s.disks.length, 'disk'),
      ask: { questions: truenasDiskQuestions(s) },
      columns: [
        { key: 'disk', label: 'Disk' },
        { key: 'pool', label: 'Pool' },
        { key: 'size', label: 'Size', numeric: true },
        { key: 'temp', label: 'Temperature', numeric: true },
      ],
      rows: diskRows(input),
    });
  const work = workRows(input);
  const apps = appItems(input);
  const live = [...work, ...apps];
  const meta = liveMeta(s, work.length);
  const lines = storageLines(input);
  const space = truenasSpace(s);
  const slotted = slotPanels({
    // The ids stay the ones the desk's widgets name.
    live: live.length
      ? liveRows({
          id: 'apps',
          title: work.length && !apps.length ? 'Running now' : 'Apps',
          ...(meta ? { meta } : {}),
          ask: { questions: truenasAppQuestions(s) },
          shape: 'square',
          items: live.slice(0, LIVE_MAX),
          ...(live.length > LIVE_MAX ? { total: live.length } : {}),
          ...(apps.length
            ? { link: { kind: 'url' as const, label: 'Open apps', url: `${url}/ui/apps/installed` } }
            : {}),
        })
      : null,
    inventory: lines.length
      ? inventory({
          id: 'pools',
          title: 'Storage',
          ...(space ? { meta: usedOf(space.used, space.total) } : {}),
          ask: { questions: truenasStorageQuestions(s) },
          items: lines,
        })
      : null,
    trend: spaceWeek({
      points: input.space ?? [],
      now: input.now,
      timeZone: input.timeZone,
      freeBytes: space ? space.total - space.used : null,
      what: s.pools.length > 1 ? 'All pools' : 'Added per day',
    }),
    more,
    machine: machineLines(s),
  });

  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`TrueNAS **${s.version}**`));
  if (s.hostname) facts.push(line(`**${clip(s.hostname, 60)}**`));
  const shown = notices(input);
  const healthy = s.pools.filter((p) => p.healthy).length;
  return {
    ...slotted,
    kpis: [],
    charts: [],
    notices: shown,
    tabs: [],
    facts,
    status: statusOf(shown, s.pools.length ? `${plural(healthy, 'pool')} healthy` : 'Running fine'),
    open: { label: 'Open TrueNAS', url },
    actions: [],
    readAt: s.readAt,
    verdict: truenasVerdict(s),
    // A scrub or a copy moves its bar: the page asks again sooner.
    ...(work.length ? { refreshS: 30 } : {}),
    suggestions: ['Biggest datasets', 'Snapshots per dataset', 'Disk temperatures this week'],
  };
}

/* The page ----------------------------------------------------------------------------------------------------------- */

export async function truenasPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = serviceUrl(row);
  const [read, space] = await Promise.all([
    truenasLatest(services, row, now),
    readSpace(services, row.id, now),
  ]);
  if (!read.ok) return unreadView(NAME, url, truenasProblem(read.error).message, read.refreshing);
  const view = truenasView({ snapshot: read.value, now, timeZone: ctx.timeZone, url, buttons: ctx, space });
  return { ...view, refreshing: read.refreshing };
}

/* Buttons (SD-07, SD-08) --------------------------------------------------------------------------------------------- */

/** Scrub: `pool.scrub.run [pool, 0]` (threshold 0: now, not only when the last one is 35 days old). */
export const scrubPool: KindAction = async ({ services, row, now }, { target }) => {
  const s = await truenasSnapshot(services, row, now);
  const pool = s.pools.find((p) => p.name === target);
  if (!pool) throw badRequest('Choose one of the pools on the page.');
  if (scrubbing(pool)) throw badRequest(`${pool.name} is being scrubbed already.`);
  await truenasAct(services, row, { method: 'pool.scrub.run', params: [pool.name, 0] }, 'start the scrub');
  return {
    message: `Scrubbing ${pool.name}. It takes a while; the page shows how far it is.`,
    title: clip(`Started a scrub of ${pool.name}`, 200),
  };
};

function appAction(start: boolean): KindAction {
  return async ({ services, row, now }, { target }) => {
    const s = await truenasSnapshot(services, row, now);
    const app = (s.apps ?? []).find((a) => a.name === target);
    if (!app) throw badRequest('Choose one of the apps on the page.');
    await truenasAct(
      services,
      row,
      { method: start ? 'app.start' : 'app.stop', params: [app.name] },
      start ? 'start it' : 'stop it',
    );
    return start
      ? { message: `Starting ${app.name}.`, title: clip(`Started ${app.name} on TrueNAS`, 200) }
      : { message: `Stopping ${app.name}.`, title: clip(`Stopped ${app.name} on TrueNAS`, 200) };
  };
}

export const startApp = appAction(true);
export const stopApp = appAction(false);

/** Dismiss: a non-critical alert leaves the list until it happens again; everyday. */
export const dismissAlert: KindAction = async ({ services, row, now }, { target }) => {
  const s = await truenasSnapshot(services, row, now);
  const alert = (s.alerts ?? []).find((a) => a.uuid === target);
  if (!alert) throw badRequest('That alert isn’t there any more.');
  if (UNDISMISSABLE.has(alert.level)) throw badRequest('A critical alert stays until it is fixed.');
  await truenasAct(services, row, { method: 'alert.dismiss', params: [alert.uuid] }, 'dismiss it');
  return {
    message: 'Dismissed.',
    title: clip(`Dismissed a TrueNAS alert: ${alert.text}`, 200),
    everyday: true,
  };
};

export const TRUENAS_KIND: KindModule = {
  page: truenasPage,
  prefetch: (services, row, now) => truenasLatest(services, row, now),
  async seen(services, row, now, timeZone) {
    const s = await truenasSnapshot(services, row, now);
    const view = truenasView({ snapshot: s, now, timeZone, url: serviceUrl(row), buttons: { row } });
    // The card keeps its figures: the page has none of its own in slots.
    return {
      ...seenOf(
        cardOf(
          { kpis: truenasFigures(s), notices: view.notices },
          ['pools', 'alerts'],
          s.version ? `NAS · TrueNAS ${s.version}` : 'NAS',
        ),
        view.notices as KindNotice[],
        truenasSkipped(s),
      ),
      points: usedPoint(truenasSpace(s)?.used),
      tracked: { version: s.version ?? null },
      // A task list that didn't answer says nothing about its backups.
      protection: truenasProtection(
        ['replication.query', 'cloudsync.query', 'pool.snapshottask.query'].some((m) => s.unread.includes(m))
          ? null
          : s.tasks,
      ),
    };
  },
  actions: { scrub: scrubPool, start: startApp, stop: stopApp, dismiss: dismissAlert },
  checks: TRUENAS_CHECKS,
};
