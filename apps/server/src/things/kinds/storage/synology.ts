/**
 * Synology DSM's page (service-dashboards.md SD-52, SD-S17): storage pools and volumes with how full they are and their
 * state, the disks with their health and temperature, Hyper Backup's tasks with their last result, DSM's own update
 * and Security Advisor's findings. DSM's Web API is undocumented: the APIs this DSM has are asked first
 * (`SYNO.API.Info query`), then `SYNO.DSM.Info getinfo`, `SYNO.Storage.CGI.Storage load_info`, `SYNO.Backup.Task list`
 * (and `status` for a task the list says nothing of), `SYNO.Core.SecurityScan.Status system_get` and
 * `SYNO.Core.Upgrade.Server check` (kept an hour); whatever doesn't answer is left out. Package updates have no read
 * worth trusting: left out (SD-S17). Signed in as the connection's user (its session, `_sid`). Read only.
 */
import { synologyProtection } from '../../../backup-trust/protection';
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPageBar,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageRow,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { KindCheck } from '../../quiet/types';
import type { RawPoint } from '../../series';
import { bytes, clip, dateOf, line, list, num, pct, plural, rec, span, str, when } from '../../words';
import { untilWords } from '../fusebox-pool';
import { cachedRead, KIND_DEADLINE_MS, latestRead, problemOf, ReadProblem, withDeadline } from '../read';
import type { KindModule } from '../registry';
import { countLine, inventory, liveRows, slotPanels } from '../slots';
import type { KindCtx, KindView } from '../types';
import { fixed, fullness, type KindNotice, lookInto, newer, UNTIL } from './lines';
import { disksLine, readSpace, spaceWeek, usedPoint } from './nas';
import { optional, readJson } from './net';
import {
  ago,
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

const NAME = 'Synology';
/** A backup older than this is worth a look (SD-52: 2 days). */
export const BACKUP_LATE_DAYS = 2;
const UPDATE_CACHE_MS = 60 * 60_000;
const TASKS_MAX = 12;
const STATUS_READS_MAX = 6;

const APIS = {
  info: { api: 'SYNO.DSM.Info', method: 'getinfo', version: 2 },
  storage: { api: 'SYNO.Storage.CGI.Storage', method: 'load_info', version: 1 },
  backup: { api: 'SYNO.Backup.Task', method: 'list', version: 1 },
  backupStatus: { api: 'SYNO.Backup.Task', method: 'status', version: 1 },
  security: { api: 'SYNO.Core.SecurityScan.Status', method: 'system_get', version: 1 },
  upgrade: { api: 'SYNO.Core.Upgrade.Server', method: 'check', version: 2 },
} as const;

/* Reading ------------------------------------------------------------------------------------------------------------ */

/** DSM answered `success: false` (HTTP 200): 105 means the user may not, 101–104 the API isn't there. */
export class SynoError extends Error {
  constructor(readonly code: number | null) {
    super(`DSM error ${code ?? '?'}`);
  }
}

export interface SynoApi {
  path: string;
  version: number;
}

/** `SYNO.API.Info query`: each API's path and the version to ask (the preferred one, at most its max). */
export function parseApiInfo(body: unknown, wanted: Record<string, number>): Map<string, SynoApi> {
  const data = rec(rec(body).data);
  const out = new Map<string, SynoApi>();
  for (const [api, prefer] of Object.entries(wanted)) {
    const a = rec(data[api]);
    const path = str(a.path);
    const max = num(a.maxVersion);
    const min = num(a.minVersion) ?? 1;
    if (!path || max === null || !/^[A-Za-z0-9_./-]+\.cgi$/.test(path)) continue;
    out.set(api, { path, version: Math.max(min, Math.min(prefer, max)) });
  }
  return out;
}

/** An answer's `data`, or a `SynoError`. */
export function synoData(body: unknown): unknown {
  const b = rec(body);
  if (b.success === true) return b.data ?? {};
  throw new SynoError(num(rec(b.error).code));
}

export type Health = 'ok' | 'warn' | 'bad' | 'busy';

/** A pool's, volume's or disk's state as a tone: “normal” fine, “degrade”/“crashed” bad, the rest a warning or work. */
export function healthOf(status: string | null): Health {
  const s = (status ?? '').toLowerCase();
  if (!s || s === 'normal' || s === 'initialized' || s === 'healthy') return 'ok';
  if (/crash|fail|degrad|abnormal|damage|broken|missing/.test(s)) return 'bad';
  if (/repair|expand|migrat|background|check|scrub|build|resync|optimi|parity|convert|deploy/.test(s))
    return 'busy';
  return 'warn';
}

/** A state as a word: `degrade` → “Degraded”, `normal` → “Healthy”. */
export function healthWord(status: string | null): string {
  const s = (status ?? '').toLowerCase().replace(/_/g, ' ');
  if (!s || s === 'normal' || s === 'healthy') return 'Healthy';
  if (s === 'degrade') return 'Degraded';
  if (s === 'crashed') return 'Crashed';
  return clip(s.charAt(0).toUpperCase() + s.slice(1), 30);
}

export interface SynoVolume {
  id: string;
  label: string;
  /** Its pool's label (“Storage Pool 1”). */
  pool: string | null;
  /** Its pool's id (`reuse_1`), to let a volume's state give way to its pool's (QN-S46). */
  poolId: string | null;
  fs: string | null;
  status: string | null;
  total: number | null;
  used: number | null;
}

export interface SynoPool {
  id: string;
  label: string;
  raid: string | null;
  status: string | null;
  total: number | null;
  used: number | null;
}

export interface SynoDisk {
  /** The slot (`sata1`): a new disk in it keeps the id. */
  id: string;
  /** The serial when DSM gives one that tells the disks apart; the line's subject (QN-S42). */
  serial: string | null;
  label: string;
  model: string | null;
  status: string | null;
  temp: number | null;
  size: number | null;
  ssd: boolean;
}

/** `load_info`: pools, volumes and disks (DSM's sizes are texts of bytes). */
export function parseStorage(data: unknown): { pools: SynoPool[]; volumes: SynoVolume[]; disks: SynoDisk[] } {
  const d = rec(data);
  const pools = list(d.storagePools).flatMap((raw) => {
    const p = rec(raw);
    const id = str(p.id) ?? str(p.pool_path);
    if (!id) return [];
    const n = num(p.num_id);
    return [
      {
        id,
        label: n !== null ? `Storage Pool ${n}` : clip(id, 40),
        raid: str(p.device_type) ?? str(p.raidType),
        status: str(p.status) ?? str(p.summary_status),
        total: num(rec(p.size).total),
        used: num(rec(p.size).used),
      },
    ];
  });
  const poolLabel = new Map(pools.map((p) => [p.id, p.label]));
  const volumes = list(d.volumes).flatMap((raw) => {
    const v = rec(raw);
    const id = str(v.id) ?? str(v.vol_path);
    if (!id) return [];
    const n = num(v.num_id) ?? num(/(\d+)$/.exec(str(v.vol_path) ?? '')?.[1]);
    const desc = str(v.description) ?? str(v.vol_desc);
    const pool = str(v.pool_path);
    return [
      {
        id,
        label: clip(`${n !== null ? `Volume ${n}` : id}${desc ? ` · ${desc}` : ''}`, 80),
        pool: pool ? (poolLabel.get(pool) ?? pool) : null,
        poolId: pool,
        fs: str(v.fs_type),
        status: str(v.status) ?? str(v.summary_status),
        total: num(rec(v.size).total),
        used: num(rec(v.size).used),
      },
    ];
  });
  const disks = list(d.disks).flatMap((raw) => {
    const k = rec(raw);
    const id = str(k.id) ?? str(k.device);
    if (!id) return [];
    const smart = str(k.smart_status);
    const status = str(k.overview_status) ?? str(k.status);
    // The worse of the disk's own state and its SMART verdict.
    const worse = [status, smart].sort((a, b) => rankOf(healthOf(b)) - rankOf(healthOf(a)))[0] ?? null;
    return [
      {
        id,
        serial: str(k.serial),
        label: clip(str(k.longName) ?? str(k.name) ?? id, 40),
        model: [str(k.vendor), str(k.model)].filter(Boolean).join(' ') || null,
        status: worse,
        temp: num(k.temp),
        size: num(k.size_total),
        ssd: k.isSsd === true || /ssd|nvme|m\.2/i.test(str(k.diskType) ?? ''),
      },
    ];
  });
  // A serial counts only when it tells the disks apart (recorded answers hide them as “x”).
  const serials = disks.map((k) => k.serial);
  for (const k of disks)
    if (!k.serial || k.serial.length < 4 || serials.filter((x) => x === k.serial).length > 1) k.serial = null;
  return { pools, volumes, disks };
}

const rankOf = (h: Health) => ({ ok: 0, busy: 1, warn: 2, bad: 3 })[h];

export type BackupResult = 'ok' | 'failed' | 'partial' | 'cancelled' | 'running' | 'never' | 'other';

export interface SynoBackup {
  id: string;
  name: string;
  result: BackupResult;
  last: Date | null;
  next: Date | null;
  /** Where it backs up to, from its type (`cloud:image`): `cloud`, `local`, `remote`. */
  target?: string | null;
}

/** “2026/10/21 03:00” in DSM's (the burrow's) zone, or an epoch, or ISO text. */
export function synoTime(v: unknown, timeZone: string): Date | null {
  const s = str(v);
  const m = s ? /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s) : null;
  if (!m) return typeof v === 'number' ? dateOf(v) : s && /\d{4}-\d{2}-\d{2}T/.test(s) ? dateOf(s) : null;
  const wall = Date.UTC(
    +(m[1] as string),
    +(m[2] as string) - 1,
    +(m[3] as string),
    +(m[4] as string),
    +(m[5] as string),
    +(m[6] ?? 0),
  );
  // The zone's offset at that wall time: how far its clock is ahead of UTC.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(wall));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return new Date(wall - (asUtc - wall));
}

/** A Hyper Backup result as a kind. */
export function backupResult(v: string | null, status: string | null): BackupResult {
  const s = (status ?? '').toLowerCase();
  if (/backingup|backup|running|waiting|preparing/.test(s) && s !== 'none') return 'running';
  const r = (v ?? '').toLowerCase();
  if (!r || r === 'none') return 'never';
  if (r === 'done' || r === 'success' || r === 'succeeded') return 'ok';
  if (/fail|error/.test(r)) return 'failed';
  if (/cancel/.test(r)) return 'cancelled';
  if (/partial|suspend|skip/.test(r)) return 'partial';
  return 'other';
}

/** `SYNO.Backup.Task list` (with `additional`), merged with a task's `status` answer when there is one. */
export function parseBackups(
  data: unknown,
  statuses: ReadonlyMap<string, unknown>,
  timeZone: string,
): SynoBackup[] {
  return list(rec(data).task_list)
    .slice(0, TASKS_MAX)
    .flatMap((raw) => {
      const t = rec(raw);
      const id = num(t.task_id) ?? str(t.task_id);
      if (id === null) return [];
      const st = rec(statuses.get(String(id)));
      const pick = (k: string) => t[k] ?? st[k] ?? rec(t.additional)[k];
      return [
        {
          id: String(id),
          name: clip(str(t.name) ?? `Task ${id}`, 80),
          result: backupResult(str(pick('last_bkp_result')), str(t.status) ?? str(st.status)),
          last: synoTime(pick('last_bkp_time') ?? pick('last_bkp_end_time'), timeZone),
          next: synoTime(pick('next_bkp_time'), timeZone),
          target: str(t.type)?.split(':')[0]?.toLowerCase() ?? null,
        },
      ];
    });
}

/** `SYNO.Core.SecurityScan.Status system_get`: findings by how serious, and when it last looked. */
export function parseSecurity(data: unknown): { risks: number; warnings: number; at: Date | null } | null {
  const d = rec(data);
  const items = rec(d.items);
  if (!Object.keys(items).length && !str(d.sysStatus)) return null;
  let risks = 0;
  let warnings = 0;
  for (const v of Object.values(items)) {
    const fail = rec(rec(v).fail);
    risks += (num(fail.danger) ?? 0) + (num(fail.risk) ?? 0);
    warnings += num(fail.warning) ?? 0;
  }
  return { risks, warnings, at: dateOf(num(d.lastScanTime) ?? d.lastScanTime) };
}

/** `SYNO.Core.Upgrade.Server check`: `update.available` (DSM 7) or `available` at the top. */
export function parseUpgrade(data: unknown): { available: boolean; version: string | null } | null {
  const d = rec(data);
  const u = Object.keys(rec(d.update)).length ? rec(d.update) : d;
  if (typeof u.available !== 'boolean') return null;
  const details = rec(u.version_details);
  const built = [
    str(details.os_name),
    str(details.major) && `${details.major}.${details.minor}${details.micro ? `.${details.micro}` : ''}`,
  ]
    .filter(Boolean)
    .join(' ');
  return { available: u.available, version: str(u.version) ?? (built || null) };
}

export interface SynologySnapshot {
  readAt: Date;
  model: string | null;
  version: string | null;
  temperature: number | null;
  uptimeS: number | null;
  /** Its memory in MB (`ram`). */
  ramMb?: number | null;
  /** Null when DSM wouldn't say (a user that isn't an administrator, 105). */
  storage: { pools: SynoPool[]; volumes: SynoVolume[]; disks: SynoDisk[] } | null;
  storageRefused: boolean;
  /** Null when Hyper Backup isn't installed. */
  backups: SynoBackup[] | null;
  /** More tasks than were read, or than had their own status read: an Ignore of a backup line doesn't end now. */
  backupsCapped: boolean;
  security: ReturnType<typeof parseSecurity>;
  update: ReturnType<typeof parseUpgrade>;
}

export async function readSynology(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<SynologySnapshot> {
  const wanted: Record<string, number> = {};
  for (const a of Object.values(APIS)) wanted[a.api] = Math.max(wanted[a.api] ?? 0, a.version);
  const info = parseApiInfo(
    await readJson(services, row, NAME, {
      path: '/webapi/query.cgi',
      query: { api: 'SYNO.API.Info', version: '1', method: 'query', query: Object.keys(wanted).join(',') },
    }),
    wanted,
  );
  const call = async (which: keyof typeof APIS, params: Record<string, string> = {}) => {
    const { api, method } = APIS[which];
    const at = info.get(api);
    if (!at) return null;
    return synoData(
      await readJson(services, row, NAME, {
        path: `/webapi/${at.path}`,
        query: { api, version: String(at.version), method, ...params },
      }),
    );
  };
  const refused = (err: unknown) => err instanceof SynoError && err.code === 105;
  const [dsm, storage, backups, security, update] = await Promise.all([
    optional(call('info')),
    call('storage').catch((err) => (refused(err) ? ('refused' as const) : null)),
    optional(
      call('backup', {
        additional: JSON.stringify([
          'last_bkp_time',
          'next_bkp_time',
          'last_bkp_result',
          'is_modified',
          'last_bkp_progress',
        ]),
      }),
    ),
    optional(call('security')),
    optional(cachedRead(services, `synology-update:${row.id}`, row, () => call('upgrade'), UPDATE_CACHE_MS)),
  ]);
  if (dsm === null && (storage === null || storage === 'refused') && backups === null)
    throw new ReadProblem('Synology answered, but none of what Whombat reads.');
  // Tasks the list says nothing of: their own status (a few).
  const statuses = new Map<string, unknown>();
  let backupsCapped = false;
  if (backups) {
    const tasks = list(rec(backups).task_list).map((t) => rec(t));
    const bare = tasks.filter((t) => !str(t.last_bkp_result) && !str(rec(t.additional).last_bkp_result));
    backupsCapped = tasks.length > TASKS_MAX || bare.length > STATUS_READS_MAX;
    await Promise.all(
      bare.slice(0, STATUS_READS_MAX).map(async (t) => {
        const id = String(num(t.task_id) ?? str(t.task_id) ?? '');
        if (!id) return;
        const st = await optional(call('backupStatus', { task_id: id }));
        if (st) statuses.set(id, st);
      }),
    );
  }
  const d = rec(dsm);
  return {
    readAt: now,
    model: str(d.model),
    version: str(d.version_string)?.replace(/^DSM\s*/i, '') ?? null,
    temperature: num(d.temperature),
    uptimeS: num(d.uptime),
    ramMb: num(d.ram),
    storage: storage && storage !== 'refused' ? parseStorage(storage) : null,
    storageRefused: storage === 'refused',
    backups: backups ? parseBackups(backups, statuses, timeZone) : null,
    backupsCapped,
    security: security ? parseSecurity(security) : null,
    update: update ? parseUpgrade(update) : null,
  };
}

function load(services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) {
  return async () => {
    try {
      return await withDeadline(
        readSynology(services, row, now, timeZone),
        KIND_DEADLINE_MS,
        `${NAME} didn’t answer in time.`,
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

export function synologyLatest(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
  timeZone = 'UTC',
) {
  return latestRead(services, `synology:${row.id}`, row, load(services, row, now, timeZone));
}

export function synologySnapshot(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
  timeZone = 'UTC',
) {
  return cachedRead(services, `synology:${row.id}`, row, load(services, row, now, timeZone));
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface SynologyInput {
  snapshot: SynologySnapshot;
  now: Date;
  timeZone: string;
  url: string;
  /** Whombat's readings of the used space, the last 15 days. */
  space?: readonly RawPoint[];
}

/** Used and in all over every volume, in bytes; null without sizes. */
export function synologySpace(s: SynologySnapshot): { used: number; total: number } | null {
  const sized = (s.storage?.volumes ?? []).filter((v) => v.total && v.used !== null);
  if (!sized.length) return null;
  return {
    used: sized.reduce((a, v) => a + (v.used ?? 0), 0),
    total: sized.reduce((a, v) => a + (v.total ?? 0), 0),
  };
}

const HEALTH_DOT = { ok: 'ok', busy: 'warn', warn: 'warn', bad: 'bad' } as const;
const RESULT_WORD: Record<BackupResult, string> = {
  ok: 'OK',
  failed: 'Failed',
  partial: 'Partly done',
  cancelled: 'Cancelled',
  running: 'Running',
  never: 'Never ran',
  other: 'Unknown',
};

/** The task whose backup is newest (the card's Last backup). */
function newestBackup(bs: readonly SynoBackup[]): SynoBackup | null {
  return (
    [...bs]
      .filter((b) => b.last)
      .sort((a, b) => (b.last as Date).getTime() - (a.last as Date).getTime())[0] ?? null
  );
}

/** A planned run may queue behind another this long before the task is late. */
const LATE_GRACE_MS = 6 * 3600_000;
/** Longer than any schedule Hyper Backup offers (monthly): late whatever the schedule says (QN-S43). */
export const BACKUP_LATE_ANY_DAYS = 32;

/**
 * How late a task is, by its own schedule (QN-04, QN-S43): `late` when the run DSM planned has passed without a backup
 * (a weekly task isn't late on day 3), or none for 32 days; `unscheduled` when it has no next run and none for 2 days
 * (a heads-up: nobody planned one); else null. A running task is never late.
 */
export function lateness(b: SynoBackup, now: Date): 'late' | 'unscheduled' | null {
  if (b.result === 'running' || !b.last) return null;
  const days = daysBetween(b.last, now);
  if (days > BACKUP_LATE_ANY_DAYS) return 'late';
  if (b.next) return b.next > b.last && b.next.getTime() < now.getTime() - LATE_GRACE_MS ? 'late' : null;
  return days > BACKUP_LATE_DAYS ? 'unscheduled' : null;
}

const lateBackup = (b: SynoBackup, now: Date) => lateness(b, now) === 'late';

function figures(input: SynologyInput): ThingPageKpi[] {
  const { snapshot: s, now } = input;
  const out: ThingPageKpi[] = [];
  const st = s.storage;
  if (st?.volumes.length) {
    const healthy = st.volumes.filter((v) => healthOf(v.status) === 'ok').length;
    const bad = st.volumes.some((v) => healthOf(v.status) === 'bad');
    out.push({
      key: 'volumes',
      label: 'Volumes',
      value: healthy === st.volumes.length ? `${healthy} healthy` : `${healthy} of ${st.volumes.length}`,
      sub: healthy === st.volumes.length ? plural(st.pools.length, 'storage pool') : 'healthy',
      ...(healthy < st.volumes.length ? { tone: bad ? ('bad' as const) : ('warn' as const) } : {}),
    });
    const sized = st.volumes.filter((v) => v.total && v.used !== null);
    const total = sized.reduce((a, v) => a + (v.total ?? 0), 0);
    const used = sized.reduce((a, v) => a + (v.used ?? 0), 0);
    if (total > 0) out.push(usedKpi('used', 'Used', used, total));
  }
  if (st?.disks.length) {
    const healthy = st.disks.filter((d) => healthOf(d.status) === 'ok').length;
    const bad = st.disks.some((d) => healthOf(d.status) === 'bad');
    out.push({
      key: 'disks',
      label: 'Disks',
      value: healthy === st.disks.length ? `${healthy} healthy` : `${healthy} of ${st.disks.length}`,
      ...(healthy < st.disks.length
        ? { sub: 'healthy', tone: bad ? ('bad' as const) : ('warn' as const) }
        : {}),
    });
  }
  if (s.backups) {
    const newest = newestBackup(s.backups);
    const failed = s.backups.some((b) => b.result === 'failed');
    if (newest?.last)
      out.push({
        key: 'backup',
        label: 'Last backup',
        value: RESULT_WORD[newest.result],
        sub: `${ago(newest.last, now)} · ${newest.name}`.slice(0, 80),
        ...(failed || newest.result === 'failed'
          ? { tone: 'bad' as const }
          : lateBackup(newest, now) || newest.result === 'partial'
            ? { tone: 'warn' as const }
            : {}),
      });
    else
      out.push({
        key: 'backup',
        label: 'Last backup',
        value: s.backups.length ? 'Not yet' : 'None',
        sub: s.backups.length ? 'No task has run' : 'No Hyper Backup task',
      });
  }
  return out;
}

/** Every check Synology's page can raise (What Whombat watches, QN-15). */
export const SYNOLOGY_CHECKS: readonly KindCheck[] = [
  {
    check: 'synology.storage',
    name: 'Storage pools and volumes that aren’t healthy',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'synology.volume_full',
    name: 'Volumes filling up',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  { check: 'synology.disk', name: 'Disks that need replacing', nature: 'you', perItem: true, startsOn: true },
  { check: 'synology.disk_temp', name: 'Disks running hot', nature: 'you', perItem: true, startsOn: false },
  {
    check: 'synology.backup_failed',
    name: 'Hyper Backup tasks failing',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'synology.backup_late',
    name: 'Hyper Backup tasks running late',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'synology.backup_partial',
    name: 'Hyper Backup tasks only partly done',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'synology.security',
    name: 'Security Advisor findings',
    nature: 'you',
    perItem: false,
    startsOn: false,
  },
  { check: 'synology.update', name: 'DSM updates', nature: 'fyi', perItem: false, startsOn: false },
  {
    check: 'synology.storage_refused',
    name: 'Storage shown to administrators only',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

const STORAGE_CHECKS = ['synology.storage', 'synology.volume_full', 'synology.disk', 'synology.disk_temp'];
const BACKUP_CHECKS = ['synology.backup_failed', 'synology.backup_late', 'synology.backup_partial'];

/** The checks this read couldn't see (QN-11): their Ignore doesn't end now. */
export function synologySkipped(s: SynologySnapshot): string[] {
  const out: string[] = [];
  if (!s.storage) out.push(...STORAGE_CHECKS);
  if (!s.storage && !s.storageRefused) out.push('synology.storage_refused');
  if (!s.backups || s.backupsCapped) out.push(...BACKUP_CHECKS);
  if (!s.security) out.push('synology.security');
  if (!s.update) out.push('synology.update');
  return out;
}

/** A short badge when the title is too long for the head (at most 40). */
const badged = (title: string, badge: string) => (title.length > 40 ? { badge: clip(badge, 40) } : {});

/** A disk as a line's subject: its serial when DSM tells them apart, else its slot (QN-S42). */
const diskSubject = (d: SynoDisk) => ({
  id: clip(d.serial ? `disk:${d.serial}` : `disk:${d.id}`, 160),
  name: clip(d.label, 80),
});

const toneOf = (h: Health) => (h === 'bad' ? ('bad' as const) : ('warn' as const));
const stateOf = (status: string | null) => clip((status ?? 'unknown').toLowerCase(), 60);

function notices(input: SynologyInput): KindNotice[] {
  const { snapshot: s, now, timeZone, url } = input;
  const out: KindNotice[] = [];
  const manager = { kind: 'url' as const, label: 'Open Storage Manager', url };
  if (s.storageRefused)
    out.push({
      id: 'storage-refused',
      tone: 'info',
      icon: 'key',
      title: 'DSM shows storage to administrators only',
      detail: 'Add Whombat’s user to the administrators group to see pools, volumes and disks here.',
      nature: 'fyi',
      check: 'synology.storage_refused',
      ignore: fixed('Until DSM shows storage.'),
    });
  const st = s.storage;
  const poolHealth = new Map((st?.pools ?? []).map((p) => [p.id, healthOf(p.status)]));
  const perPool = new Map<string, SynoVolume[]>();
  for (const v of st?.volumes ?? [])
    if (v.poolId) perPool.set(v.poolId, [...(perPool.get(v.poolId) ?? []), v]);
  // A volume's state gives way to its pool's when the pool holds only it and is as bad (QN-S46): one line, not two.
  const givesWay = (v: SynoVolume) => {
    const pool = v.poolId ? poolHealth.get(v.poolId) : undefined;
    const h = healthOf(v.status);
    return (
      !!pool &&
      (pool === 'bad' || pool === 'warn') &&
      (perPool.get(v.poolId as string)?.length ?? 0) === 1 &&
      rankOf(pool) >= rankOf(h)
    );
  };
  for (const p of st?.pools ?? []) {
    const h = healthOf(p.status);
    if (h !== 'bad' && h !== 'warn') continue;
    const title = clip(`${p.label} is ${healthWord(p.status).toLowerCase()}`, 120);
    const merged = (perPool.get(p.id) ?? []).filter((v) => healthOf(v.status) !== 'ok' && givesWay(v));
    out.push({
      id: `pool-${p.id}`.slice(0, 120),
      tone: toneOf(h),
      icon: 'disk',
      title,
      ...(merged.length
        ? {
            detail: clip(
              `${merged[0]?.label} on it is ${healthWord(merged[0]?.status ?? null).toLowerCase()}.`,
              200,
            ),
          }
        : {}),
      link: manager,
      nature: 'problem',
      check: 'synology.storage',
      subject: { id: clip(`pool:${p.id}`, 160), name: clip(p.label, 80) },
      ignore: fixed(UNTIL.healthy),
      episode: stateOf(p.status),
      ...badged(title, `${p.label} is ${healthWord(p.status).toLowerCase()}`),
    });
  }
  for (const v of st?.volumes ?? []) {
    const h = healthOf(v.status);
    const volume = { id: clip(`volume:${v.id}`, 160), name: clip(v.label, 80) };
    if ((h === 'bad' || h === 'warn') && !givesWay(v)) {
      const title = clip(`${v.label} is ${healthWord(v.status).toLowerCase()}`, 120);
      out.push({
        id: `volume-${v.id}`.slice(0, 120),
        tone: toneOf(h),
        icon: 'disk',
        title,
        link: manager,
        nature: 'problem',
        check: 'synology.storage',
        subject: volume,
        ignore: fixed(UNTIL.healthy),
        episode: stateOf(v.status),
        ...badged(title, `A volume is ${healthWord(v.status).toLowerCase()}`),
      });
    }
    if (v.total && v.used !== null) {
      const p = (v.used / v.total) * 100;
      const full = fullness(p, v.total - v.used);
      if (full) {
        const title = clip(`${v.label} is ${Math.round(p)} % full`, 120);
        out.push({
          id: `full-${v.id}`.slice(0, 120),
          icon: 'disk',
          title,
          detail: `${usedOf(v.used, v.total)} used.`,
          ...(full.nature === 'problem'
            ? { link: lookInto(`What is taking the space on ${v.label} of the Synology?`) }
            : {}),
          ...full,
          check: 'synology.volume_full',
          subject: volume,
          ignore: fixed(UNTIL.fuller),
          ...badged(title, `A volume is ${Math.round(p)} % full`),
        });
      }
    }
  }
  for (const d of st?.disks ?? []) {
    const h = healthOf(d.status);
    const disk = diskSubject(d);
    if (h === 'bad' || h === 'warn')
      out.push({
        id: `disk-${d.id}`.slice(0, 120),
        tone: toneOf(h),
        icon: 'disk',
        title: clip(`${d.label} says ${healthWord(d.status).toLowerCase()}`, 120),
        ...(d.model ? { detail: clip(d.model, 200) } : {}),
        link: manager,
        nature: 'you',
        check: 'synology.disk',
        subject: disk,
        ignore: fixed(UNTIL.replaced),
        episode: stateOf(d.status),
      });
    const tone = d.temp !== null ? tempTone(d.temp, d.ssd) : undefined;
    if (d.temp !== null && tone)
      out.push({
        id: `hot-${d.id}`.slice(0, 120),
        tone,
        icon: 'disk',
        title: clip(`${d.label} is at ${celsius(d.temp)}`, 120),
        detail: 'Disks wear faster when they run hot. Check the airflow and the fans.',
        // Warm is worth knowing; only hot needs someone at the box (QN-04).
        nature: tone === 'bad' ? 'you' : 'fyi',
        check: 'synology.disk_temp',
        subject: disk,
        ignore: fixed(UNTIL.cooler),
        confirm: 2,
      });
  }
  for (const b of s.backups ?? []) {
    const task = { id: clip(`task:${b.id}`, 160), name: clip(b.name, 80) };
    // One backup run is one episode: the next run ends an Ignore (QN-11).
    const run = b.last ? b.last.toISOString() : 'never';
    const late = lateness(b, now);
    if (b.result === 'failed') {
      const title = clip(`Hyper Backup ${b.name} failed`, 120);
      out.push({
        id: `backup-${b.id}`.slice(0, 120),
        tone: 'bad',
        icon: 'backup',
        title,
        ...(b.last ? { detail: `Last tried ${when(b.last, now, timeZone)}.` } : {}),
        link: { kind: 'url', label: 'Open Hyper Backup', url },
        nature: 'problem',
        check: 'synology.backup_failed',
        subject: task,
        ignore: newer(UNTIL.nextBackup),
        episode: run,
        ...badged(title, 'A backup failed'),
      });
    } else if (late && b.last) {
      const gone = span(now.getTime() - b.last.getTime());
      const title = clip(
        late === 'late'
          ? `Hyper Backup ${b.name} hasn’t run for ${gone}`
          : `Hyper Backup ${b.name} has no schedule and last ran ${gone} ago`,
        120,
      );
      out.push({
        id: `late-${b.id}`.slice(0, 120),
        tone: late === 'late' ? 'warn' : 'info',
        icon: 'backup',
        title,
        ...(b.next ? { detail: `Next run ${untilWords(b.next, now, timeZone)}.` } : {}),
        ...(late === 'late'
          ? {
              link: lookInto(
                `Why hasn’t Hyper Backup ${b.name} on the Synology run since ${when(b.last, now, timeZone)}?`,
              ),
            }
          : {}),
        nature: late === 'late' ? 'problem' : 'fyi',
        check: 'synology.backup_late',
        subject: task,
        ignore: newer(UNTIL.nextBackup),
        episode: run,
        ...badged(title, `Backup ${gone} late`),
      });
    } else if (b.result === 'partial' || b.result === 'cancelled') {
      // Someone cancelling a run isn't a problem (QN-04): a heads-up.
      const cancelled = b.result === 'cancelled';
      const title = clip(
        `Hyper Backup ${b.name} ${cancelled ? 'was cancelled' : 'was only partly done'}`,
        120,
      );
      out.push({
        id: `partial-${b.id}`.slice(0, 120),
        tone: cancelled ? 'info' : 'warn',
        icon: 'backup',
        title,
        ...(cancelled
          ? { link: { kind: 'url' as const, label: 'Open Hyper Backup', url } }
          : { link: lookInto(`Why was Hyper Backup ${b.name} on the Synology only partly done?`) }),
        nature: cancelled ? 'fyi' : 'problem',
        check: 'synology.backup_partial',
        subject: task,
        ignore: newer(UNTIL.nextBackup),
        episode: run,
        ...badged(title, cancelled ? 'A backup was cancelled' : 'A backup was partly done'),
      });
    }
  }
  if (s.security && (s.security.risks || s.security.warnings)) {
    const risks = s.security.risks > 0;
    out.push({
      id: 'security',
      tone: risks ? 'warn' : 'info',
      icon: 'shield',
      title: risks
        ? `Security Advisor found ${plural(s.security.risks, 'risk')}`
        : `Security Advisor has ${plural(s.security.warnings, 'suggestion')}`,
      ...(s.security.at ? { detail: `It last looked ${when(s.security.at, now, timeZone)}.` } : {}),
      link: { kind: 'url', label: 'Open Security Advisor', url },
      // A risk is a person's choice (an SSH port, the admin account); suggestions are information (QN-04).
      nature: risks ? 'you' : 'fyi',
      check: 'synology.security',
      ignore: fixed('Until it finds more.'),
      // More findings end an Ignore; the daily rescan doesn't (QN-S44).
      band: risks ? s.security.risks : s.security.warnings,
    });
  }
  if (s.update?.available)
    out.push({
      id: 'update',
      tone: 'info',
      icon: 'update',
      title: 'DSM has an update',
      detail: s.update.version
        ? `${s.update.version.startsWith('DSM') ? '' : 'DSM '}${s.update.version}${s.version ? `; this one runs DSM ${s.version}` : ''}. Install it in DSM.`
        : 'Install it in DSM.',
      link: { kind: 'url', label: 'Open DSM', url },
      nature: 'fyi',
      check: 'synology.update',
      ignore: newer(UNTIL.version),
      episode: clip(s.update.version ?? 'unknown', 60),
    });
  return worstFirst(out);
}

/**
 * Inventory “Storage”: each volume with how full it is and what is free, its pool's RAID and state in its words (a pool
 * that is degraded makes its volumes red); a pool without a volume is a line of its own; then the disks.
 */
function storageLines(input: SynologyInput): ThingPageItem[] {
  const { snapshot: s, url } = input;
  const st = s.storage;
  if (!st) return [];
  const pools = new Map(st.pools.map((p) => [p.id, p]));
  const line = (
    id: string,
    title: string,
    parts: (string | null)[],
    status: string | null,
    total: number | null,
    used: number | null,
  ): ThingPageItem => {
    const h = healthOf(status);
    const p = total && used !== null ? (used / total) * 100 : null;
    const full = p !== null ? fullTone(p) : undefined;
    const tone = h === 'bad' ? 'bad' : h === 'warn' ? 'warn' : full;
    return countLine({
      id,
      title,
      icon: 'disk',
      detail: [...parts, healthWord(status)].filter(Boolean).join(' · '),
      ...(tone ? { tone } : {}),
      value: p !== null ? pct(p) : '—',
      ...(total && used !== null ? { note: `${bytes(Math.max(0, total - used))} free` } : {}),
      ...(full ? { noteTone: full } : {}),
      url,
    });
  };
  const out: ThingPageItem[] = st.volumes.map((v) => {
    const pool = v.poolId ? pools.get(v.poolId) : undefined;
    // A pool's trouble is its volumes' trouble: the worse of the two states.
    const status =
      pool && rankOf(healthOf(pool.status)) > rankOf(healthOf(v.status)) ? pool.status : v.status;
    return line(
      `volume-${v.id}`,
      v.label,
      [pool?.raid ? raidWords(pool.raid) : null, v.fs ? fsWords(v.fs) : null],
      status,
      v.total,
      v.used,
    );
  });
  const used = new Set(st.volumes.map((v) => v.poolId));
  for (const p of st.pools.filter((x) => !used.has(x.id)))
    out.push(line(`pool-${p.id}`, p.label, [p.raid ? raidWords(p.raid) : null], p.status, p.total, p.used));
  if (st.disks.length)
    out.push(
      disksLine(
        st.disks.map((d) => {
          const h = healthOf(d.status);
          return {
            health: h === 'bad' ? 'bad' : h === 'ok' ? 'ok' : 'warn',
            tempC: d.temp,
            warm: d.temp !== null ? tempTone(d.temp, d.ssd) : undefined,
          };
        }),
        url,
        'is failing',
      ),
    );
  return out;
}

const TARGET_WORDS: Record<string, string> = {
  cloud: 'To the cloud',
  local: 'To a local folder or USB disk',
  remote: 'To another NAS',
};

/** A task's tag: what is wrong with it, or that it never ran. */
function backupBadge(b: SynoBackup, now: Date): ThingGalleryItem['badge'] | undefined {
  if (b.result === 'failed') return { text: 'Failed', tone: 'bad' };
  if (b.result === 'running') return undefined;
  if (lateBackup(b, now)) return { text: 'Late', tone: 'warn' };
  if (b.result === 'partial') return { text: 'Partly done', tone: 'warn' };
  if (b.result === 'cancelled') return { text: 'Cancelled', tone: 'warn' };
  return undefined;
}

/**
 * Live “Hyper Backup”: the storage work running now (a scrub, a repair, an expansion) first, then each task with its
 * last result and its next run, what is wrong as its tag. DSM gives no progress Whombat can trust: no bars.
 */
function liveItems(input: SynologyInput): ThingGalleryItem[] {
  const { snapshot: s, now, timeZone, url } = input;
  const work: ThingGalleryItem[] = [
    ...(s.storage?.pools ?? []).map((p) => ({ id: `pool-${p.id}`, label: p.label, status: p.status })),
    ...(s.storage?.volumes ?? []).map((v) => ({ id: `volume-${v.id}`, label: v.label, status: v.status })),
  ]
    .filter((x) => healthOf(x.status) === 'busy')
    .map((x) => ({
      id: clip(`work-${x.id}`, 200),
      title: clip(x.label, 120),
      sub: clip(`${healthWord(x.status)} now`, 120),
      noteEnd: 'Working now',
      url,
    }));
  const tasks = (s.backups ?? []).map((b): ThingGalleryItem => {
    const badge = backupBadge(b, now);
    const target = b.target ? TARGET_WORDS[b.target] : undefined;
    const running = b.result === 'running';
    return {
      id: clip(`task-${b.id}`, 200),
      title: clip(b.name, 120),
      ...(target ? { sub: target } : {}),
      ...(badge ? { badge } : {}),
      ...(running
        ? { note: 'Backing up now' }
        : b.last
          ? { note: clip(`${b.result === 'ok' ? 'Backed up' : 'Ran'} ${ago(b.last, now)}`, 80) }
          : { note: RESULT_WORD[b.result] }),
      ...(b.next && !running ? { noteEnd: clip(`Next ${untilWords(b.next, now, timeZone)}`, 60) } : {}),
      url,
    };
  });
  return [...work, ...tasks];
}

/** Live's line: “Backing up now”, else how many tasks and when the newest ran. */
function liveMeta(s: SynologySnapshot, now: Date): string | undefined {
  const tasks = s.backups ?? [];
  if (tasks.some((b) => b.result === 'running')) return 'Backing up now';
  if (!tasks.length) return undefined;
  const newest = newestBackup(tasks);
  return [plural(tasks.length, 'task'), newest?.last ? `last ran ${ago(newest.last, now)}` : null]
    .filter(Boolean)
    .join(' · ');
}

/** DSM's own lines in the machine card: its version and whether one is out, how warm, Security Advisor, how long up. */
function machineLines(s: SynologySnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version)
    out.push({
      id: 'dsm',
      label: 'DSM',
      value: clip(s.version, 40),
      pct: null,
      ...(s.update
        ? s.update.available
          ? { sub: clip(`${s.update.version ?? 'An update'} is out`, 120), subTone: 'warn' as const }
          : { sub: 'Up to date', subTone: 'ok' as const }
        : {}),
    });
  if (s.temperature !== null)
    out.push({ id: 'temperature', label: 'Temperature', value: celsius(s.temperature), pct: null });
  if (s.security) {
    const n = s.security.risks;
    out.push({
      id: 'security',
      label: 'Security Advisor',
      value: n ? plural(n, 'risk') : 'No risks',
      pct: null,
      ...(n ? { tone: 'warn' as const } : {}),
    });
  }
  if (s.ramMb)
    out.push({ id: 'memory', label: 'Memory', value: `${Math.round(s.ramMb / 1024)} GB`, pct: null });
  if (s.uptimeS !== null) out.push({ id: 'up', label: 'Up', value: span(s.uptimeS * 1000), pct: null });
  return out;
}

/** “SHR”, “RAID 5”, “Basic”. */
export function raidWords(raid: string): string {
  const r = raid.toLowerCase();
  if (r.startsWith('shr')) return r.includes('2') ? 'SHR-2' : 'SHR';
  const m = /raid_?(\d+)/.exec(r);
  if (m) return `RAID ${m[1]}`;
  if (r === 'basic' || r === 'single') return 'Basic';
  if (r === 'jbod') return 'JBOD';
  return clip(raid, 30);
}

const fsWords = (fs: string) =>
  fs.toLowerCase() === 'btrfs' ? 'Btrfs' : fs.toLowerCase() === 'ext4' ? 'ext4' : fs;

function diskRows(input: SynologyInput): ThingPageRow[] {
  return (input.snapshot.storage?.disks ?? []).map((d) => {
    const h = healthOf(d.status);
    const tone = d.temp !== null ? tempTone(d.temp, d.ssd) : undefined;
    return {
      id: d.id,
      cells: {
        disk: { text: d.label, ...(d.model ? { note: clip(d.model, 80) } : {}) },
        health: {
          text: healthWord(d.status),
          dot: HEALTH_DOT[h],
          ...(h === 'bad' ? { tone: 'bad' as const } : {}),
        },
        size: d.size ? { text: bytes(d.size), mono: true } : { text: '—', tone: 'muted' as const },
        temp:
          d.temp !== null
            ? { text: celsius(d.temp), mono: true, ...(tone ? { tone } : {}) }
            : { text: '—', tone: 'muted' as const },
      },
    };
  });
}

/** Questions for the Storage card. */
export function synologyStorageQuestions(s: SynologySnapshot): string[] {
  const out: string[] = [];
  const unhealthy =
    (s.storage?.pools ?? []).some((p) => healthOf(p.status) !== 'ok') ||
    (s.storage?.volumes ?? []).some((v) => healthOf(v.status) !== 'ok');
  if (unhealthy) out.push('Why isn’t my Synology storage healthy?');
  out.push('Which shared folders take the most space?', 'How fast is my Synology filling up?');
  return out.slice(0, 3);
}

/** Questions for the Hyper Backup card. */
export function synologyBackupQuestions(s: SynologySnapshot, now: Date): string[] {
  const out: string[] = [];
  const bad = (s.backups ?? []).find((b) => b.result === 'failed' || lateBackup(b, now));
  if (bad) out.push(clip(`Why did Hyper Backup ${bad.name} have a problem?`, 200));
  out.push('When did my last Hyper Backup finish?', 'What is backed up by Hyper Backup?');
  return out.slice(0, 3);
}

/** Questions for the Disks card. */
export function synologyDiskQuestions(s: SynologySnapshot): string[] {
  const out: string[] = [];
  if ((s.storage?.disks ?? []).some((d) => healthOf(d.status) !== 'ok'))
    out.push('Which Synology drive needs attention?');
  out.push('Are all my Synology drives healthy?', 'How warm are the drives running?');
  return out.slice(0, 3);
}

/** One calm sentence for the head while Synology has no active problem. */
export function synologyVerdict(s: SynologySnapshot, now: Date): string {
  const pools = s.storage?.pools ?? [];
  const vols = s.storage?.volumes ?? [];
  const badPool = pools.find((p) => healthOf(p.status) === 'bad' || healthOf(p.status) === 'warn');
  if (badPool) return clip(`${badPool.label} is ${healthWord(badPool.status).toLowerCase()}.`, 200);
  const badVol = vols.find((v) => healthOf(v.status) === 'bad' || healthOf(v.status) === 'warn');
  if (badVol) return clip(`${badVol.label} is ${healthWord(badVol.status).toLowerCase()}.`, 200);
  const failed = (s.backups ?? []).filter((b) => b.result === 'failed').length;
  if (failed > 0) return clip(`${plural(failed, 'Hyper Backup task')} failed.`, 200);
  const late = (s.backups ?? []).filter((b) => lateBackup(b, now)).length;
  if (late > 0)
    return clip(`${plural(late, 'Hyper Backup task')} ${late === 1 ? 'is' : 'are'} running late.`, 200);
  const space = synologySpace(s);
  const backingUp = (s.backups ?? []).some((b) => b.result === 'running');
  const lead =
    vols.length === 1
      ? `${vols[0]?.label} is healthy`
      : vols.length > 1
        ? `All ${vols.length} volumes are healthy`
        : pools.length === 1
          ? `${pools[0]?.label} is healthy`
          : pools.length > 1
            ? `All ${pools.length} storage pools are healthy`
            : null;
  if (lead) {
    if (backingUp) return clip(`${lead} and a backup is running now.`, 200);
    if (space) return clip(`${lead}, with ${bytes(Math.max(0, space.total - space.used))} free.`, 200);
    return clip(`${lead}.`, 200);
  }
  if (backingUp) return 'Synology is fine: a backup is running now.';
  if (s.backups?.length) return 'Synology is fine: backups are up to date.';
  return 'Synology is running fine.';
}

/**
 * The page's Synology part (SD-52), in slots: Live “Hyper Backup” (storage work running now, then each task), Inventory
 * “Storage” (each volume, then the disks), the Trend of space added a day from Whombat's readings, DSM's lines in the
 * machine card, the disks below. Pure.
 */
export function synologyView(input: SynologyInput): KindView {
  const { snapshot: s, url } = input;
  const more: ThingPagePanel[] = [];
  const disks = diskRows(input);
  if (disks.length)
    more.push({
      kind: 'table',
      id: 'disks',
      title: 'Disks',
      meta: plural(disks.length, 'disk'),
      ask: { questions: synologyDiskQuestions(s) },
      columns: [
        { key: 'disk', label: 'Disk' },
        { key: 'health', label: 'Health' },
        { key: 'size', label: 'Size', numeric: true },
        { key: 'temp', label: 'Temperature', numeric: true },
      ],
      rows: disks,
    });
  const live = liveItems(input);
  const meta = liveMeta(s, input.now);
  const lines = storageLines(input);
  const space = synologySpace(s);
  const slotted = slotPanels({
    // The ids stay the ones the desk's widgets name.
    live: live.length
      ? liveRows({
          id: 'backups',
          title: 'Hyper Backup',
          ...(meta ? { meta } : {}),
          ask: { questions: synologyBackupQuestions(s, input.now) },
          shape: 'square',
          items: live,
          empty: 'No backup task is set up in Hyper Backup.',
        })
      : null,
    inventory: lines.length
      ? inventory({
          id: 'storage',
          title: 'Storage',
          ...(space ? { meta: usedOf(space.used, space.total) } : {}),
          ask: { questions: synologyStorageQuestions(s) },
          items: lines,
        })
      : null,
    trend: spaceWeek({
      points: input.space ?? [],
      now: input.now,
      timeZone: input.timeZone,
      freeBytes: space ? space.total - space.used : null,
      what: (s.storage?.volumes.length ?? 0) > 1 ? 'All volumes' : 'Added per day',
    }),
    more,
    machine: machineLines(s),
  });

  const facts: ThingLine[] = [];
  if (s.model || s.version)
    facts.push(
      line(
        [s.model ? `**${s.model}**` : null, s.version ? `DSM **${s.version}**` : null]
          .filter(Boolean)
          .join(' · '),
      ),
    );
  if (s.uptimeS !== null) facts.push(line(`Up **${span(s.uptimeS * 1000)}**`));
  const shown = notices(input);
  const vols = s.storage?.volumes ?? [];
  return {
    ...slotted,
    kpis: [],
    charts: [],
    notices: shown,
    tabs: [],
    facts,
    status: statusOf(shown, vols.length ? `${plural(vols.length, 'volume')} healthy` : 'Running fine'),
    open: { label: 'Open DSM', url },
    actions: [],
    readAt: s.readAt,
    verdict: synologyVerdict(s, input.now),
    suggestions: ['Biggest shared folders', 'Hyper Backup history', 'Disk temperatures this week'],
  };
}

/* The page ----------------------------------------------------------------------------------------------------------- */

export async function synologyPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = serviceUrl(row);
  const [read, space] = await Promise.all([
    synologyLatest(services, row, now, ctx.timeZone),
    readSpace(services, row.id, now),
  ]);
  if (!read.ok) return unreadView('DSM', url, problemOf(read.error, NAME).message, read.refreshing);
  return {
    ...synologyView({ snapshot: read.value, now, timeZone: ctx.timeZone, url, space }),
    refreshing: read.refreshing,
  };
}

export const SYNOLOGY_KIND: KindModule = {
  page: synologyPage,
  // Hyper Backup's times are in the box's zone: the read takes the burrow's.
  prefetch: (services, row, now, timeZone) => synologyLatest(services, row, now, timeZone),
  async seen(services, row, now, timeZone) {
    const s = await synologySnapshot(services, row, now, timeZone);
    const input = { snapshot: s, now, timeZone, url: serviceUrl(row) };
    const view = synologyView(input);
    // The card keeps its figures: the page has none of its own in slots.
    return {
      ...seenOf(
        cardOf(
          { kpis: figures(input), notices: view.notices },
          ['volumes', 'backup'],
          s.version ? `NAS · DSM ${s.version}` : 'NAS',
        ),
        view.notices,
        synologySkipped(s),
      ),
      points: usedPoint(synologySpace(s)?.used),
      protection: synologyProtection(s.backups),
    };
  },
  checks: SYNOLOGY_CHECKS,
};
