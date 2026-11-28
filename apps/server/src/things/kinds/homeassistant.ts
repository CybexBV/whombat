/**
 * Home Assistant's page and tile (connection-pages.md CP-02, CP-07, CP-12, CP-16; connection-pages-server.md CP-S10…):
 * how Home Assistant itself runs — its version and installation, integrations and their state, Repairs, the log's errors
 * and warnings, the recorder's database, its backups, updates waiting, entities that don't answer and, on Home Assistant
 * OS, the Supervisor's CPU, memory, disk and add-ons. Read over its WebSocket API with the connection's own sign-in
 * (`ha-socket.ts`), one socket per read, kept 30 seconds.
 *
 * Its Summary is in slots (docs/service-pages.md, docs/decisions/service-slots.md): Live is the house's Controls
 * (`home/ha-controls.ts`, kept 4 seconds, the page asked again every 10); Inventory its areas, devices, automations and
 * integrations; the Shelf its cameras; the Trend how often its automations ran this week (the logbook, kept 10 minutes);
 * People who is home (`home/ha-house.ts`, kept 10 seconds); then the machine's card with its version and database. Below
 * them what doesn't load, Home now, Weather, Rooms, Energy today and the backups. The machine's figures come from what
 * it runs on (`runs-on.ts`, CP-08), else the Supervisor's. The builders below are pure.
 */
import type {
  ThingGalleryItem,
  ThingImage,
  ThingLine,
  ThingPageAction,
  ThingPageBar,
  ThingPageItem,
  ThingPagePanel,
  ThingPageRow,
  ThingPageTab,
} from '@whombat/core';
import { haProtection } from '../../backup-trust/protection';
import type { CatalogConnectionRow } from '../../connections/types';
import { startOfLocalDay } from '../../home/time';
import type { ConnectionGlance } from '../../home/types';
import type { Services } from '../../services';
import { diskNotice, diskNow, diskTone, type MachineNow } from '../machine';
import { DB_MB_KEY, LOG_ERR_KEY, LOG_ERR_TOP_KEY, POINTS_KEEP_MS, readPoints } from '../points';
import type { KindCheck, KindNotice, NoticeNature } from '../quiet/types';
import type { MachineFigures } from '../runs-on';
import { forecastFull, mbPerDay, type PageRange, perDay, type RawPoint, trendOf } from '../series';
import {
  bytes,
  cap,
  clip,
  countWords,
  dateOf,
  domainName,
  line,
  list,
  num,
  pct,
  plural,
  rec,
  sizeTextBytes,
  span,
  str,
  thousands,
  when,
} from '../words';
import { type HaCommands, type HaResult, openHomeAssistant } from './ha-socket';
import { CONTROLS_REFRESH_S, controlsCtx, haControlsPart } from './home/ha-controls';
import {
  type HaHouseRead,
  type HaPerson,
  haHousePart,
  housePanels,
  personNow,
  sinceWords,
} from './home/ha-house';
import { itemLines, lineId, statusOf, subjectName } from './home/lines';
import type { ThingControlsPanel } from './home/shapes';
import {
  cachedRead,
  KIND_DEADLINE_MS,
  type Latest,
  latestRead,
  problemOf,
  ReadProblem,
  withDeadline,
} from './read';
import type { KindSeen } from './registry';
import {
  addedNote,
  countByDay,
  countLine,
  dayKey,
  type InventoryPanel,
  inventory,
  lastDays,
  liveControls,
  type PeoplePanel,
  people as peoplePanel,
  type ShelfPanel,
  shelf,
  slotPanels,
  type TrendPanel,
  trend,
} from './slots';
import type { KindCtx, KindView } from './types';

/* The read ------------------------------------------------------------------------------------------------------------ */

export interface HaEntry {
  id: string;
  domain: string;
  title: string;
  state: string;
  reason: string | null;
}

export interface HaRepair {
  id: string;
  domain: string;
  severity: 'critical' | 'error' | 'warning';
  title: string;
}

export interface HaLogEntry {
  /** The logger (`homeassistant.components.knx.climate`). */
  name: string;
  message: string;
  level: string;
  at: Date | null;
  first: Date | null;
  count: number;
}

export interface HaBackup {
  id: string;
  name: string;
  at: Date | null;
  sizeBytes: number | null;
  automatic: boolean;
  /** Kept on Home Assistant's own disk (`backup.local`, `hassio.local`; every backup before 2025.1). */
  local: boolean;
  /** The other places it went (`cloud.cloud`, `hassio.nas_backups`): copies off Home Assistant's machine. */
  elsewhere?: string[];
}

export interface HaAddon {
  slug: string;
  name: string;
  state: string;
  version: string | null;
  updateAvailable: boolean;
  cpuPct: number | null;
  memoryBytes: number | null;
}

export interface HaSupervisor {
  cpuPct: number | null;
  memoryUsedBytes: number | null;
  memoryLimitBytes: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  osVersion: string | null;
  addons: HaAddon[];
}

/** One read of Home Assistant: `null` parts couldn't be read (not an administrator, an older version). */
export interface HaSnapshot {
  readAt: Date;
  version: string | null;
  /** “Container”, “OS”, “Supervised”, “Core”. */
  installation: string | null;
  recoveryMode: boolean;
  startedAt: Date | null;
  /** Its account isn't an administrator: the integrations, Repairs and the log can't be read. */
  notAdmin: boolean;
  entries: HaEntry[] | null;
  repairs: HaRepair[] | null;
  log: HaLogEntry[] | null;
  database: { engine: string; version: string | null; sizeBytes: number | null } | null;
  backups: HaBackup[] | null;
  counts: { updates: number; unavailable: number; entities: number } | null;
  supervisor: HaSupervisor | null;
}

/** Updates waiting, entities that don't answer, all entities: one template, three counts. */
export const HA_COUNTS_TEMPLATE =
  "{{ states.update | selectattr('state', 'eq', 'on') | list | count }}|{{ states | selectattr('state', 'eq', 'unavailable') | list | count }}|{{ states | list | count }}";

const ok = (r: HaResult): unknown => (r.success ? r.result : null);
const unauthorized = (r: HaResult) => !r.success && r.code === 'unauthorized';

/** The system health's info by domain, from its `initial` event and its `update`s. */
export function healthInfo(events: readonly unknown[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const e of events) {
    const ev = rec(e);
    if (ev.type === 'initial')
      for (const [domain, v] of Object.entries(rec(ev.data))) out[domain] = { ...rec(rec(v).info) };
    else if (ev.type === 'update' && typeof ev.domain === 'string' && typeof ev.key === 'string') {
      out[ev.domain] ??= {};
      (out[ev.domain] as Record<string, unknown>)[ev.key] = ev.success === false ? null : ev.data;
    }
  }
  return out;
}

/** The system health's keys the read uses, by domain. */
const HEALTH_KEYS: Record<string, readonly string[]> = {
  homeassistant: ['installation_type', 'version'],
  recorder: ['database_engine', 'database_version', 'estimated_db_size', 'current_recorder_run'],
};

/**
 * When the system health has said all the read uses (CP-S23): its `initial` without any of those keys pending, then
 * their `update`s, or its `finish`. The rest are reachability checks (the cloud's, HACS's) that can take longer than the
 * read waits: John's Home Assistant sends its `initial` after 0.3 s and no `finish` within 5 s, so every read waited 5 s.
 */
export function healthDone(): (event: unknown) => boolean {
  let waiting: Set<string> | null = null;
  return (event) => {
    const ev = rec(event);
    if (ev.type === 'finish') return true;
    if (ev.type === 'initial') {
      const data = rec(ev.data);
      waiting = new Set();
      for (const [domain, keys] of Object.entries(HEALTH_KEYS))
        for (const key of keys)
          if (rec(rec(rec(data[domain]).info)[key]).type === 'pending') waiting.add(`${domain}.${key}`);
    } else if (ev.type === 'update' && waiting) waiting.delete(`${ev.domain}.${ev.key}`);
    return waiting?.size === 0;
  };
}

/** The recorder's database in words: “MariaDB”, “SQLite”, “PostgreSQL”. */
export function databaseName(engine: string, version: string | null): string {
  const e = engine.toLowerCase();
  if (e === 'sqlite') return 'SQLite';
  if (e === 'postgresql') return 'PostgreSQL';
  if (e === 'mysql') return Number(version?.split('.')[0]) >= 10 ? 'MariaDB' : 'MySQL';
  return cap(engine);
}

/** “10.11” from “10.11.6-MariaDB”. */
export function shortVersion(version: string | null): string | null {
  const m = version ? /^(\d+)(?:\.(\d+))?/.exec(version) : null;
  return m ? (m[2] !== undefined ? `${m[1]}.${m[2]}` : (m[1] as string)) : null;
}

function entriesOf(raw: unknown): HaEntry[] {
  return list(raw)
    .map(rec)
    .filter((e) => e.source !== 'ignore' && (e.disabled_by === null || e.disabled_by === undefined))
    .map((e) => ({
      id: str(e.entry_id) ?? `${str(e.domain)}:${str(e.title)}`,
      domain: str(e.domain) ?? 'unknown',
      title: str(e.title) ?? '',
      state: str(e.state) ?? 'not_loaded',
      reason: str(e.reason),
    }));
}

function logOf(raw: unknown): HaLogEntry[] {
  return list(raw)
    .map(rec)
    .map((e) => ({
      name: str(e.name) ?? '',
      message: (
        list(e.message).find((m): m is string => typeof m === 'string') ??
        str(e.message) ??
        ''
      ).trim(),
      level: (str(e.level) ?? 'ERROR').toUpperCase(),
      at: dateOf(e.timestamp),
      first: dateOf(e.first_occurred) ?? dateOf(e.timestamp),
      count: Math.max(1, num(e.count) ?? 1),
    }))
    .filter((e) => e.message);
}

function backupsOf(raw: unknown): HaBackup[] {
  return list(rec(raw).backups)
    .map(rec)
    .map((b) => {
      const agentIds = Object.keys(rec(b.agents));
      const agents = Object.values(rec(b.agents)).map((a) => num(rec(a).size));
      const agentSize = agents.filter((n): n is number => n !== null);
      // 2025.1 and later: per storage, in bytes; before that one `size` in MB.
      const sizeBytes = agentSize.length
        ? Math.max(...agentSize)
        : num(b.size) !== null
          ? (num(b.size) as number) * 1e6
          : null;
      return {
        id: str(b.backup_id) ?? str(b.slug) ?? str(b.name) ?? 'backup',
        name: str(b.name) ?? 'Backup',
        at: dateOf(b.date),
        sizeBytes,
        automatic: b.with_automatic_settings === true,
        local: agentIds.length === 0 || agentIds.some((a) => a.endsWith('.local')),
        elsewhere: agentIds.filter((a) => !a.endsWith('.local')),
      };
    });
}

function countsOf(events: readonly unknown[]): HaSnapshot['counts'] {
  const result = events.map((e) => rec(e).result).find((r) => r !== undefined);
  const text = typeof result === 'number' ? String(result) : typeof result === 'string' ? result : null;
  const parts = text?.split('|').map((p) => Number(p.trim()));
  if (parts?.length !== 3 || parts.some((p) => !Number.isFinite(p))) return null;
  return { updates: parts[0] as number, unavailable: parts[1] as number, entities: parts[2] as number };
}

async function supervisorOf(ha: HaCommands): Promise<HaSupervisor | null> {
  const api = (endpoint: string) => ha.call('supervisor/api', { endpoint, method: 'get' });
  const [core, host, os, addons] = await Promise.all([
    api('/core/stats'),
    api('/host/info'),
    api('/os/info'),
    api('/addons'),
  ]);
  if (!core.success && !host.success) return null;
  const c = rec(ok(core));
  const h = rec(ok(host));
  const started = list(rec(ok(addons)).addons)
    .map(rec)
    .slice(0, 40);
  const stats = await Promise.all(
    started.map((a) =>
      a.state === 'started' && typeof a.slug === 'string'
        ? api(`/addons/${encodeURIComponent(a.slug)}/stats`)
        : Promise.resolve(null),
    ),
  );
  return {
    cpuPct: num(c.cpu_percent),
    memoryUsedBytes: num(c.memory_usage),
    memoryLimitBytes: num(c.memory_limit),
    diskUsedGb: num(h.disk_used),
    diskTotalGb: num(h.disk_total),
    osVersion: str(rec(ok(os)).version),
    addons: started.map((a, i) => {
      const s = rec(stats[i] ? ok(stats[i] as HaResult) : null);
      return {
        slug: str(a.slug) ?? `addon-${i}`,
        name: str(a.name) ?? str(a.slug) ?? 'Add-on',
        state: str(a.state) ?? 'unknown',
        version: str(a.version),
        updateAvailable: a.update_available === true,
        cpuPct: num(s.cpu_percent),
        memoryBytes: num(s.memory_usage),
      };
    }),
  };
}

/** Reads Home Assistant over a signed-in socket (every command at once; what fails is left out). */
export async function readHomeAssistant(ha: HaCommands, now: Date): Promise<HaSnapshot> {
  const [config, health, entries, repairs, log, backup, counts] = await Promise.all([
    ha.call('get_config'),
    ha.collect('system_health/info', {}, healthDone(), 5_000),
    ha.call('config_entries/get'),
    ha.call('repairs/list_issues'),
    ha.call('system_log/list'),
    ha.call('backup/info'),
    ha.collect(
      'render_template',
      { template: HA_COUNTS_TEMPLATE, timeout: 3 },
      (e) => 'result' in rec(e) || 'error' in rec(e),
      5_000,
    ),
  ]);
  if (!config.success && unauthorized(config))
    throw new ReadProblem('Home Assistant refused Whombat’s sign-in.', true);
  const cfg = rec(ok(config));
  const info = healthInfo(health.events);
  const core = info.homeassistant ?? {};
  const recorder = info.recorder ?? {};
  const installation = str(core.installation_type)?.replace(/^Home Assistant\s+/i, '') ?? null;
  const engine = str(recorder.database_engine);
  const dbVersion = str(recorder.database_version);
  const dbSize = str(recorder.estimated_db_size);
  const issues = list(rec(ok(repairs)).issues)
    .map(rec)
    .filter((i) => i.ignored !== true && !i.dismissed_version);
  // Repairs' titles in Home Assistant's own words (English), else the domain's name.
  const domains = [
    ...new Set(issues.map((i) => str(i.issue_domain) ?? str(i.domain)).filter((d): d is string => !!d)),
  ];
  const translations = domains.length
    ? rec(
        rec(
          ok(
            await ha.call('frontend/get_translations', {
              language: 'en',
              category: 'issues',
              integration: domains,
            }),
          ),
        ).resources,
      )
    : {};
  const isOs = 'hassio' in info || /^(OS|Supervised)$/i.test(installation ?? '');
  return {
    readAt: now,
    version: str(cfg.version) ?? str(core.version) ?? ha.haVersion,
    installation,
    recoveryMode: cfg.recovery_mode === true || cfg.safe_mode === true,
    startedAt: dateOf(recorder.current_recorder_run),
    notAdmin: unauthorized(entries) || unauthorized(log),
    entries: entries.success ? entriesOf(entries.result) : null,
    repairs: repairs.success
      ? issues.map((i) => {
          const domain = str(i.issue_domain) ?? str(i.domain) ?? 'homeassistant';
          const key = str(i.translation_key) ?? str(i.issue_id) ?? '';
          let title = str(translations[`component.${domain}.issues.${key}.title`]);
          for (const [k, v] of Object.entries(rec(i.translation_placeholders)))
            if (title && typeof v === 'string') title = title.replaceAll(`{${k}}`, v);
          const severity = i.severity === 'critical' || i.severity === 'error' ? i.severity : 'warning';
          return {
            id: str(i.issue_id) ?? key,
            domain,
            severity,
            title: title ?? `${domainName(domain)} needs a repair`,
          };
        })
      : null,
    log: log.success ? logOf(log.result) : null,
    database: engine
      ? {
          engine: databaseName(engine, dbVersion),
          version: shortVersion(dbVersion),
          sizeBytes: dbSize ? sizeTextBytes(dbSize) : null,
        }
      : null,
    backups: backup.success ? backupsOf(backup.result) : null,
    counts: counts.result.success ? countsOf(counts.events) : null,
    supervisor: isOs ? await supervisorOf(ha).catch(() => null) : null,
  };
}

/** One read of Home Assistant over a new socket, within its deadline. */
function loadHomeAssistant(services: Services, row: CatalogConnectionRow, now: Date) {
  return async (): Promise<HaSnapshot> => {
    const work = (async () => {
      const ha = await openHomeAssistant(services, row, KIND_DEADLINE_MS);
      try {
        return await readHomeAssistant(ha, now);
      } finally {
        ha.close();
      }
    })();
    try {
      return await withDeadline(work, KIND_DEADLINE_MS, 'Home Assistant didn’t answer in time.');
    } catch (err) {
      throw problemOf(err, 'Home Assistant');
    }
  };
}

/** Home Assistant's read, kept 30 seconds per connection (the page and the health pass share it). */
export function homeAssistantSnapshot(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
): Promise<HaSnapshot> {
  return cachedRead(services, `homeassistant:${row.id}`, row, loadHomeAssistant(services, row, now));
}

/** Home Assistant's read for its page: the last one when a new one is slow (page-speed.md PS-01). */
export function homeAssistantLatest(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
): Promise<Latest<HaSnapshot>> {
  return latestRead(services, `homeassistant:${row.id}`, row, loadHomeAssistant(services, row, now));
}

/* What it means ------------------------------------------------------------------------------------------------------- */

const NOT_LOADING = new Set(['setup_error', 'setup_retry', 'migration_error', 'not_loaded', 'failed_unload']);

const STATE_WORDS: Record<string, { text: string; dot: 'ok' | 'warn' | 'bad' | 'off' }> = {
  loaded: { text: 'Loaded', dot: 'ok' },
  setup_retry: { text: 'Retrying', dot: 'warn' },
  setup_error: { text: 'Failed', dot: 'bad' },
  migration_error: { text: 'Failed to update', dot: 'bad' },
  not_loaded: { text: 'Not loaded', dot: 'off' },
  failed_unload: { text: 'Stuck', dot: 'warn' },
  setup_in_progress: { text: 'Starting', dot: 'off' },
  unload_in_progress: { text: 'Stopping', dot: 'off' },
};

const stateWords = (state: string) => STATE_WORDS[state] ?? { text: domainName(state), dot: 'off' as const };

export function notLoading(s: HaSnapshot): HaEntry[] {
  return (s.entries ?? []).filter((e) => NOT_LOADING.has(e.state));
}

/** The integrations' figure: loaded of all (disabled and ignored ones left out). */
export function integrationCounts(s: HaSnapshot): { loaded: number; total: number } | null {
  if (!s.entries) return null;
  return { loaded: s.entries.filter((e) => e.state === 'loaded').length, total: s.entries.length };
}

/** A logger's integration: `homeassistant.components.knx.climate` → `knx`. */
export function loggerDomain(name: string): string {
  const m = /(?:^|\.)(?:components|custom_components)\.([a-z0-9_]+)/.exec(name);
  return m?.[1] ?? name.split('.')[0] ?? name;
}

/**
 * Errors in the log that still come in today: how many times since Home Assistant started (its log keeps one running
 * count per error), most from which integration, since when.
 */
export function errorsToday(
  s: HaSnapshot,
  now: Date,
  timeZone: string,
): { count: number; top: string | null; since: Date | null } | null {
  if (!s.log) return null;
  const start = startOfLocalDay(now, timeZone).getTime();
  const today = s.log.filter(
    (e) => (e.level === 'ERROR' || e.level === 'CRITICAL') && e.at && e.at.getTime() >= start,
  );
  const by = new Map<string, number>();
  for (const e of today) by.set(loggerDomain(e.name), (by.get(loggerDomain(e.name)) ?? 0) + e.count);
  const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const firsts = today.map((e) => Math.max(e.first?.getTime() ?? start, start));
  return {
    count: today.reduce((n, e) => n + e.count, 0),
    top,
    since: firsts.length ? new Date(Math.min(...firsts)) : null,
  };
}

/**
 * Errors in the log since Home Assistant started (DS-11): every error's running count, all sources, and the noisiest
 * integration's; null when the log couldn't be read.
 */
export function logErrors(s: HaSnapshot): { count: number; top: string | null; topCount: number } | null {
  if (!s.log) return null;
  const by = new Map<string, number>();
  let count = 0;
  for (const e of s.log) {
    if (e.level !== 'ERROR' && e.level !== 'CRITICAL') continue;
    count += e.count;
    const d = loggerDomain(e.name);
    by.set(d, (by.get(d) ?? 0) + e.count);
  }
  const [top, topCount] = [...by.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { count, top, topCount };
}

/**
 * Home Assistant's tile (CP-16): “Home Assistant 2026.10.2”, Integrations, Log errors, Updates waiting; the dot and the
 * reason from Worth a look's lines that aren't heads-ups (QN-02), by default those the health pass can tell.
 */
export function homeAssistantGlance(
  s: HaSnapshot,
  timeZone: string,
  notices: readonly KindNotice[] = haSeenNotices(s, timeZone),
): Omit<ConnectionGlance, 'status'> & {
  status: 'ok' | 'warn' | 'bad';
} {
  const ints = integrationCounts(s);
  const broken = notLoading(s).length;
  const errors = errorsToday(s, s.readAt, timeZone);
  const facts: ConnectionGlance['facts'] = [];
  if (ints)
    facts.push({
      label: 'Integrations',
      value: `${ints.loaded} of ${ints.total}`,
      ...(broken ? { note: `${broken} not loading` } : {}),
    });
  // Home Assistant's log keeps one running count per error since it started: “since restart”, not “today” (CP-S22).
  if (errors?.count)
    facts.push({ label: 'Log errors', value: thousands(errors.count), note: 'since restart' });
  if (s.counts?.updates)
    facts.push({ label: 'Updates', value: thousands(s.counts.updates), note: 'waiting' });
  return {
    ...statusOf(notices),
    line: s.version ? `Home Assistant ${s.version}` : 'Home Assistant',
    facts,
  };
}

/* The page ------------------------------------------------------------------------------------------------------------ */

/** What the health pass kept (DS-11), over the last 30 days, and the noisiest source's name. */
export interface HaPoints {
  logErr: RawPoint[];
  logErrTop: RawPoint[];
  /** The noisiest source of `logErrTop` (an integration's domain). */
  logTop: string | null;
  dbMb: RawPoint[];
  diskPct: RawPoint[];
  diskGb: RawPoint[];
}

export const NO_POINTS: HaPoints = {
  logErr: [],
  logErrTop: [],
  logTop: null,
  dbMb: [],
  diskPct: [],
  diskGb: [],
};

/** How the page is read: when, in which zone, over which range, with what the health pass kept. */
export interface HaCtx {
  now: Date;
  timeZone: string;
  openUrl: string | null;
  range: PageRange;
  points: HaPoints;
}

/** The machine as the Summary shows it: what it runs on, else the Supervisor's figures (no lines over time). */
export function haMachine(m: MachineFigures | null, sup: HaSupervisor | null): MachineNow | null {
  if (m) return m;
  if (!sup) return null;
  return {
    cpuPct: sup.cpuPct,
    cores: null,
    memoryUsedGb: sup.memoryUsedBytes != null ? sup.memoryUsedBytes / 1024 ** 3 : null,
    memoryTotalGb: sup.memoryLimitBytes ? sup.memoryLimitBytes / 1024 ** 3 : null,
    diskUsedGb: sup.diskUsedGb,
    diskTotalGb: sup.diskTotalGb,
    series: null,
  };
}

/**
 * Home Assistant's own backups on its disk: how many, their size, the size of all but the newest (“old backups”), the
 * oldest.
 */
export function localBackups(
  s: HaSnapshot,
): { count: number; bytes: number; oldBytes: number; oldest: Date | null } | null {
  if (!s.backups) return null;
  const local = s.backups
    .filter((b) => b.local)
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const times = local.map((b) => b.at?.getTime() ?? 0).filter((t) => t > 0);
  const size = (bs: HaBackup[]) => bs.reduce((n, b) => n + (b.sizeBytes ?? 0), 0);
  return {
    count: local.length,
    bytes: size(local),
    oldBytes: size(local.slice(1)),
    oldest: times.length ? new Date(Math.min(...times)) : null,
  };
}

/** When the disk is full at this pace (30 days of `disk_pct`). */
function diskFull(ctx: HaCtx): Date | null {
  return forecastFull(ctx.points.diskPct, 100, ctx.now);
}

/** The database's growth a day (`db_mb` over up to 30 days, at least a day of it). */
function dbPerDay(ctx: HaCtx): string | null {
  const mb = mbPerDay(trendOf(ctx.points.dbMb, ctx.now));
  return mb === null ? null : perDay(mb);
}

/* The Summary in slots (docs/decisions/service-slots.md) ---------------------------------------------------------- */

const WEEK_MS = 7 * 86_400_000;

/** How many of these moments are in the last 7 days; null when none is known (a Home Assistant without the dates). */
export function addedThisWeek(added: readonly (Date | null)[], now: Date): number | null {
  if (!added.some((d) => d !== null)) return null;
  return added.filter((d) => d && d.getTime() <= now.getTime() && now.getTime() - d.getTime() < WEEK_MS)
    .length;
}

/** The house's parts beside the read of how it runs: the Controls, the house read, a camera's snapshot. */
export interface HaParts {
  controls: ThingControlsPanel | null;
  house: HaHouseRead | null;
  camera: (entityId: string, alt: string) => ThingImage | undefined;
}

export const NO_PARTS: HaParts = { controls: null, house: null, camera: () => undefined };

/** How many automation runs fall on today. */
function runsToday(runs: readonly Date[], now: Date, timeZone: string): number {
  const today = dayKey(now, timeZone);
  return runs.filter((r) => dayKey(r, timeZone) === today).length;
}

/** Questions for the “In Home Assistant” card. */
export function haInventoryQuestions(s: HaSnapshot): string[] {
  const out: string[] = [];
  if (notLoading(s).length) out.push('Why aren’t some integrations loading?');
  if ((s.counts?.unavailable ?? 0) > 0) out.push('Which devices and sensors aren’t answering?');
  out.push('Which integrations are filling the log?', 'What ran most in Home Assistant today?');
  return out.slice(0, 3);
}

/** Questions for the Controls card. */
export function haControlsQuestions(): string[] {
  return [
    'Which lights or switches are on right now?',
    'Are any doors or windows open?',
    'What changed in the house lately?',
  ];
}

/** Questions for the Backups card. */
export function haBackupQuestions(s: HaSnapshot): string[] {
  const out: string[] = [];
  if ((localBackups(s)?.oldBytes ?? 0) >= 1e9) out.push('Which old Home Assistant backups can I remove?');
  out.push('When did Home Assistant last back up?', 'How much space do Home Assistant backups take?');
  return out.slice(0, 3);
}

/** One calm sentence for the head while Home Assistant has no active problem. */
export function haVerdict(s: HaSnapshot, house: HaHouseRead | null): string {
  if (s.recoveryMode) return 'Home Assistant started in recovery mode.';
  const failed = notLoading(s).filter((e) => e.state !== 'setup_retry').length;
  if (failed > 0)
    return clip(
      `${plural(failed, 'integration')} ${failed === 1 ? 'isn’t' : 'aren’t'} loading in Home Assistant.`,
      200,
    );
  const parts: string[] = [];
  const ints = integrationCounts(s);
  if (ints && ints.total > 0) {
    const retrying = notLoading(s).length;
    parts.push(
      retrying
        ? `${thousands(ints.loaded)} of ${thousands(ints.total)} integrations are loaded`
        : `all ${thousands(ints.total)} integrations are loaded`,
    );
  }
  const people = house?.house?.people ?? [];
  if (people.length > 0) {
    const home = people.filter((p) => p.state === 'home').length;
    parts.push(home === 0 ? 'nobody is home' : home === 1 ? '1 person is home' : `${home} people are home`);
  } else if (house?.house?.automationCount) {
    parts.push(`${plural(house.house.automationCount, 'automation')} ready`);
  }
  return clip(
    parts.length ? `Home Assistant is fine: ${parts.join(' and ')}.` : 'Home Assistant is running fine.',
    200,
  );
}

/**
 * Inventory, “In Home Assistant”: its areas and devices with what came in this week, its automations with how often
 * they ran today, its integrations with how many don't load. Each line opens its page in Home Assistant.
 */
export function haInventory(s: HaSnapshot, house: HaHouseRead | null, ctx: HaCtx): InventoryPanel | null {
  const items: ThingPageItem[] = [];
  const link = (path: string) => (ctx.openUrl ? { url: `${ctx.openUrl}${path}` } : {});
  const layout = house?.layout;
  if (layout) {
    items.push(
      countLine({
        id: 'areas',
        title: 'Areas',
        icon: 'door',
        value: thousands(layout.areas.size),
        ...(addedNote(addedThisWeek(layout.added.areas, ctx.now)) ?? {}),
        ...link('/config/areas/dashboard'),
      }),
      countLine({
        id: 'devices',
        title: 'Devices',
        icon: 'device',
        value: thousands(layout.added.devices.length),
        ...(addedNote(addedThisWeek(layout.added.devices, ctx.now)) ?? {}),
        ...link('/config/devices/dashboard'),
      }),
    );
  }
  const h = house?.house;
  if (h) {
    const today = house?.runs ? runsToday(house.runs, ctx.now, ctx.timeZone) : null;
    items.push(
      countLine({
        id: 'automations',
        title: 'Automations',
        icon: 'clock',
        value: thousands(h.automationCount),
        ...(today === null || !h.automationCount
          ? {}
          : { note: today ? `Ran ${plural(today, 'time')} today` : 'None ran today' }),
        ...link('/config/automation/dashboard'),
      }),
    );
  }
  const ints = integrationCounts(s);
  if (ints) {
    const broken = notLoading(s).length;
    items.push(
      countLine({
        id: 'integrations',
        title: 'Integrations',
        icon: 'plug',
        value: thousands(ints.total),
        note: broken ? `${broken} not loading` : 'All loaded',
        noteTone: broken ? 'warn' : 'ok',
        ...link('/config/integrations/dashboard'),
      }),
    );
  }
  return items.length
    ? inventory({
        id: 'inventory',
        title: 'In Home Assistant',
        ask: { questions: haInventoryQuestions(s) },
        items,
      })
    : null;
}

/** The Controls as Live draws them: the builder gives the slot's place and width. */
function controlsOf({ kind: _kind, place: _place, ...own }: ThingControlsPanel) {
  return own;
}

const CAMERA_NOW: Record<string, string> = { recording: 'Recording', streaming: 'Streaming' };

/** The Shelf: a snapshot of every camera Home Assistant has, as wide pictures; left out without cameras. */
export function haCameras(house: HaHouseRead | null, parts: Pick<HaParts, 'camera'>): ShelfPanel | null {
  const cameras = house?.house?.cameras ?? [];
  if (!cameras.length) return null;
  return shelf({
    id: 'cameras',
    title: 'Cameras',
    meta: plural(cameras.length, 'camera'),
    shape: 'wide',
    items: cameras.map((c): ThingGalleryItem => {
      const image = parts.camera(c.id, clip(`Snapshot of ${c.name}`, 120));
      const now = CAMERA_NOW[c.state];
      return {
        id: c.id.slice(0, 200),
        title: clip(c.name, 120),
        ...(image ? { image } : {}),
        ...(now ? { sub: now } : {}),
      };
    }),
  });
}

/**
 * The Trend: how often the automations ran each day of the last 7, today last, from Home Assistant's logbook. No change
 * on the week before: Home Assistant keeps 10 days of history unless told otherwise.
 */
export function haWeek(runs: readonly Date[], now: Date, timeZone: string): TrendPanel {
  const days = lastDays(now, timeZone);
  const values = countByDay(runs, days.keys, timeZone);
  const total = values.reduce((n, v) => n + v, 0);
  return trend({
    id: 'automations-week',
    title: 'This week',
    meta: 'Automations run per day',
    days,
    values,
    label: 'Runs',
    figure: { value: thousands(total), rest: total === 1 ? 'automation run' : 'automation runs' },
  });
}

/** People: who is home, then who is out and where (a zone's name), with since when. No bars: home or not is no amount. */
export function whoIsHome(people: readonly HaPerson[], now: Date, timeZone: string): PeoplePanel | null {
  const sorted = [...people].sort((a, b) => Number(b.state === 'home') - Number(a.state === 'home'));
  const home = sorted.filter((p) => p.state === 'home').length;
  const panel = peoplePanel({
    id: 'people',
    title: 'Who’s home',
    meta: home ? `${home} of ${people.length} home` : 'Nobody home',
    items: sorted.map((p) => {
      const t = sinceWords(p.since, now, timeZone);
      return {
        name: p.name,
        n: p.state === 'home' ? 1 : 0,
        value: personNow(p.state),
        ...(t ? { note: `since ${t}` } : {}),
      };
    }),
  });
  return panel ? { ...panel, items: panel.items.map((i) => ({ ...i, pct: null })) } : null;
}

/** Home Assistant's own lines in “The machine”: its version and how it is installed, and its database's size. */
export function haMachineLines(s: HaSnapshot, ctx: HaCtx): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version)
    out.push({
      id: 'ha-version',
      label: 'Home Assistant',
      value: clip(s.version, 40),
      pct: null,
      ...(s.installation ? { sub: clip(s.installation, 120) } : {}),
    });
  const db = s.database;
  if (db) {
    const growth = dbPerDay(ctx);
    out.push({
      id: 'ha-database',
      label: 'Database',
      note: clip([db.engine, db.version].filter(Boolean).join(' '), 80),
      value: db.sizeBytes !== null ? bytes(db.sizeBytes) : db.engine,
      pct: null,
      ...(growth ? { sub: `Grows ${growth.replace(/^\+ /, '')}` } : {}),
    });
  }
  return out;
}

/** The kind's own panels below the slots: what doesn't load first, then the house's (Home now, Weather, Rooms, Energy) and its backups. */
function haMore(
  s: HaSnapshot,
  m: MachineFigures | null,
  house: HaHouseRead | null,
  ctx: HaCtx,
  peopleShown: boolean,
): ThingPagePanel[] {
  const panels: ThingPagePanel[] = [];
  const broken = notLoading(s);
  if (broken.length)
    panels.push({
      kind: 'list',
      id: 'not-loading',
      place: 'main',
      title: 'Integrations not loading',
      meta: `${broken.length} of ${s.entries?.length ?? broken.length}`,
      link: { kind: 'tab', label: 'All integrations', tab: 'integrations' },
      items: notLoadingItems(broken),
    });
  if (house) panels.push(...housePanels(house, ctx.now, ctx.timeZone, { people: !peopleShown }));
  const machine = haMachine(m, s.supervisor);
  const disk = diskNow(machine);
  const backups = summaryBackups(s, m, disk ? diskTone((disk.used / disk.total) * 100) : undefined);
  if (backups.length || s.backups !== null)
    panels.push({
      kind: 'list',
      id: 'backups',
      place: 'main',
      title: 'Backups',
      ask: { questions: haBackupQuestions(s) },
      link: { kind: 'tab', label: 'All backups', tab: 'backups' },
      items: backups,
      empty: 'No backups yet.',
    });
  return panels;
}

/**
 * The Summary in slots: the Controls live beside what Home Assistant has, the cameras across, then this week's
 * automation runs and who is home beside the machine; below them what doesn't load, the house and the backups.
 */
export function haSlots(
  s: HaSnapshot,
  m: MachineFigures | null,
  ctx: HaCtx,
  parts: HaParts,
): Pick<KindView, 'panels' | 'slots'> {
  const { house, controls } = parts;
  const h = house?.house ?? null;
  const who = h?.people.length ? whoIsHome(h.people, ctx.now, ctx.timeZone) : null;
  const out = slotPanels({
    live: controls
      ? liveControls({ ...controlsOf(controls), ask: { questions: haControlsQuestions() } })
      : null,
    inventory: haInventory(s, house, ctx),
    shelf: haCameras(house, parts),
    trend: h?.automationCount && house?.runs ? haWeek(house.runs, ctx.now, ctx.timeZone) : null,
    people: who,
    more: haMore(s, m, house, ctx, !!who),
    machine: haMachineLines(s, ctx),
  });
  // Home Assistant OS on a machine Whombat doesn't know: the Supervisor's figures make the card.
  const own = m ? null : haMachine(null, s.supervisor);
  if (!own) return out;
  return {
    ...out,
    slots: {
      machine: out.slots?.machine ?? [],
      own: { figures: own, name: `Home Assistant ${s.installation ?? 'OS'}` },
    },
  };
}

/** The newest backup Whombat knows of: Home Assistant's own or the machine's (Proxmox). */
function newestBackup(s: HaSnapshot, m: MachineFigures | null): Date | null {
  const times = [
    ...(s.backups ?? []).map((b) => b.at?.getTime() ?? 0),
    m?.lastBackup ? new Date(m.lastBackup.at).getTime() : 0,
  ].filter((t) => t > 0);
  return times.length ? new Date(Math.max(...times)) : null;
}

/** Every check Home Assistant raises (What Whombat watches, QN-15); its disk is the machine's `machine.disk`. */
export const HOME_ASSISTANT_CHECKS: readonly KindCheck[] = [
  {
    check: 'homeassistant.recovery',
    name: 'Starting in recovery mode',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  {
    check: 'homeassistant.integration',
    name: 'Integrations not loading',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  { check: 'homeassistant.repair', name: 'Repairs', nature: 'problem', perItem: true, startsOn: false },
  {
    check: 'homeassistant.log_flood',
    name: 'An integration filling the log',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  { check: 'homeassistant.backup', name: 'Backups', nature: 'problem', perItem: false, startsOn: true },
  { check: 'homeassistant.updates', name: 'Updates', nature: 'fyi', perItem: false, startsOn: false },
  {
    check: 'homeassistant.unavailable',
    name: 'Devices and sensors not answering',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

/** Backups older than this are worth a look. */
const BACKUP_DAYS = 7;

/**
 * An integration not loading (QN-04): retrying is a heads-up (mostly a device that is off: a TV, a phone), failed is a
 * problem, the rest a problem in amber.
 */
function integrationLine(e: HaEntry): { tone: KindNotice['tone']; nature: NoticeNature } {
  if (e.state === 'setup_retry') return { tone: 'info', nature: 'fyi' };
  return { tone: stateWords(e.state).dot === 'bad' ? 'bad' : 'warn', nature: 'problem' };
}

const TONE_RANK = { info: 0, warn: 1, bad: 2 } as const;

/** Which lines the health pass leaves to others or can't tell without the machine (`haSeenNotices`). */
interface HaLinesFor {
  /** The health pass: no disk line (the machine's disk is the pass's own), no backup line it can't be sure of. */
  seen?: boolean;
}

/**
 * “Worth a look” (CP-07; quiet-notices.md QN-01…QN-04, QN-S25): what is wrong first, each with its way out — one line
 * per integration not loading and per repair, the log's flood per integration until Home Assistant restarts, its other
 * errors, updates and devices not answering heads-ups.
 */
export function haNotices(
  s: HaSnapshot,
  m: MachineFigures | null,
  ctx: HaCtx,
  { seen = false }: HaLinesFor = {},
): KindNotice[] {
  const out: KindNotice[] = [];
  if (s.recoveryMode)
    out.push({
      id: 'recovery',
      tone: 'bad',
      icon: 'power',
      title: 'Home Assistant started in recovery mode',
      detail: 'Its configuration has a problem, so it started with the basics only.',
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: 'Why did Home Assistant start in recovery mode, and how do I fix it?',
      },
      nature: 'problem',
      check: 'homeassistant.recovery',
      ignore: { lifts: 'fixed', words: 'Until it starts normally.' },
      badge: 'Started in recovery mode',
    });
  const broken = notLoading(s)
    .slice()
    .sort(
      (a, b) =>
        TONE_RANK[integrationLine(b).tone] - TONE_RANK[integrationLine(a).tone] ||
        a.title.localeCompare(b.title),
    );
  const entrySubject = (e: HaEntry) => ({
    id: `entry:${e.id}`.slice(0, 160),
    name: subjectName(e.title || domainName(e.domain)),
  });
  out.push(
    ...itemLines(
      broken,
      (e) => entrySubject(e).id,
      (e) => {
        const { tone, nature } = integrationLine(e);
        const name = e.title || domainName(e.domain);
        const title = clip(nature === 'fyi' ? `${name} is retrying` : `${name} isn’t loading`, 120);
        return {
          id: lineId('integration', e.id),
          tone,
          icon: 'plug',
          title,
          detail: clip(
            [
              e.title && e.title !== domainName(e.domain) ? domainName(e.domain) : null,
              stateWords(e.state).text,
              e.reason,
            ]
              .filter((x): x is string => !!x)
              .join(' · '),
            200,
          ),
          ...(nature === 'problem'
            ? {
                link: {
                  kind: 'ask' as const,
                  label: 'Look into it',
                  question: clip(`Why is ${name} not loading in Home Assistant?`, 300),
                },
              }
            : {}),
          nature,
          check: 'homeassistant.integration',
          subject: entrySubject(e),
          ignore: { lifts: 'fixed', words: 'Until it loads.' },
          ...(nature === 'problem' ? { confirm: 2 as const } : {}),
          ...(title.length > 40 ? { badge: 'An integration isn’t loading' } : {}),
        };
      },
      (more, subject, episode) => {
        const worst = more.map(integrationLine).sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone])[0];
        const problem = worst?.nature === 'problem';
        return {
          id: 'integration-more',
          tone: worst?.tone ?? 'info',
          icon: 'plug',
          title: `${plural(more.length, 'more integration')} not loading`,
          detail: clip(
            more
              .map((e) => `${e.title || domainName(e.domain)} ${stateWords(e.state).text.toLowerCase()}`)
              .join(' · '),
            200,
          ),
          ...(problem
            ? {
                link: {
                  kind: 'ask' as const,
                  label: 'Look into it',
                  question: `Why are ${countWords(more.length)} more integrations not loading in Home Assistant?`,
                },
              }
            : {}),
          nature: problem ? 'problem' : 'fyi',
          check: 'homeassistant.integration',
          subject,
          ignore: { lifts: 'newer', words: 'Until the list changes.' },
          episode,
          ...(problem ? { confirm: 2 as const, badge: 'Integrations aren’t loading' } : {}),
        };
      },
    ),
  );
  const repairs = (s.repairs ?? [])
    .slice()
    .sort((a, b) => (a.severity === 'warning' ? 1 : 0) - (b.severity === 'warning' ? 1 : 0));
  // Home Assistant's issues are unique per domain and id.
  const repairSubject = (r: HaRepair) => ({
    id: `repair:${r.domain}/${r.id}`.slice(0, 160),
    name: subjectName(r.title),
  });
  out.push(
    ...itemLines(
      repairs,
      (r) => repairSubject(r).id,
      (r) => {
        const title = clip(r.title, 120);
        return {
          id: lineId('repair', `${r.domain}-${r.id}`),
          tone: r.severity === 'warning' ? 'warn' : 'bad',
          icon: 'warn',
          title,
          detail: `A repair for ${domainName(r.domain)}`,
          link: {
            kind: 'ask',
            label: 'Look into it',
            question: clip(`What does Home Assistant’s repair “${r.title}” mean, and how do I fix it?`, 300),
          },
          nature: 'problem',
          check: 'homeassistant.repair',
          subject: repairSubject(r),
          ignore: { lifts: 'fixed', words: 'Until it’s repaired.' },
          ...(title.length > 40 ? { badge: 'A repair is waiting' } : {}),
        };
      },
      (more, subject, episode) => ({
        id: 'repair-more',
        tone: more.some((r) => r.severity !== 'warning') ? 'bad' : 'warn',
        icon: 'warn',
        title: `${plural(more.length, 'more repair')} waiting`,
        detail: clip(more.map((r) => r.title).join(' · '), 200),
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: 'Which repairs does Home Assistant have waiting, and how do I fix them?',
        },
        nature: 'problem',
        check: 'homeassistant.repair',
        subject,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
        episode,
        badge: 'Repairs are waiting',
      }),
    ),
  );
  if (!seen) {
    const machine = haMachine(m, s.supervisor);
    const backups = localBackups(s);
    const disk = diskNotice(machine, diskFull(ctx), {
      now: ctx.now,
      timeZone: ctx.timeZone,
      ...(m?.kind === 'guest' ? { where: m.label } : {}),
      ...(backups && backups.oldBytes >= 1e9
        ? { detail: `${bytes(backups.oldBytes)} of it is old backups` }
        : {}),
      question: 'Home Assistant’s disk is filling up. What takes the space, and what can go?',
    });
    // The machine's own check (QN-S25): what `machine.ts` says it is wins.
    if (disk) out.push(disk);
  }
  const errors = errorsToday(s, ctx.now, ctx.timeZone);
  const all = logErrors(s);
  const restart = s.startedAt?.toISOString() ?? '';
  // Every Home Assistant has errors in its log, so their count alone is no line (the Logs tab has them); one
  // integration that fills it is.
  if (errors && errors.count > 0) {
    const share = all?.count ? all.topCount / all.count : 0;
    if (all?.top && share >= 0.5 && all.count >= 100)
      out.push({
        id: 'log',
        tone: 'warn',
        icon: 'log',
        title: `${domainName(all.top)} fills the log`,
        detail: `${pct(share * 100)} of ${thousands(all.count)} errors, still coming in`,
        link: { kind: 'tab', label: 'Show them', tab: 'logs' },
        nature: 'problem',
        check: 'homeassistant.log_flood',
        subject: { id: `integration:${all.top}`.slice(0, 160), name: subjectName(domainName(all.top)) },
        ignore: { lifts: 'newer', words: 'Until Home Assistant restarts.' },
        episode: restart,
      });
  }
  const newest = newestBackup(s, m);
  const backupsKnown = s.backups !== null || !!m?.lastBackup;
  const old = !newest || ctx.now.getTime() - newest.getTime() > BACKUP_DAYS * 86_400_000;
  // Without the machine the health pass can't tell whether it has a newer backup: it says nothing then.
  if (backupsKnown && old && !seen)
    out.push({
      id: 'backup',
      tone: 'warn',
      icon: 'backup',
      title: newest ? 'No backup in the last 7 days' : 'No backup yet',
      detail: newest
        ? `The last one is from ${when(newest, ctx.now, ctx.timeZone)}.`
        : 'Neither Home Assistant nor its machine has one.',
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: 'How do I get Home Assistant backed up every day?',
      },
      nature: 'problem',
      check: 'homeassistant.backup',
      ignore: { lifts: 'fixed', words: 'Until the next backup.' },
    });
  if (s.counts && s.counts.updates > 0)
    out.push({
      id: 'updates',
      tone: 'info',
      icon: 'update',
      title: `${plural(s.counts.updates, 'update')} waiting`,
      detail: 'Home Assistant lists them under Settings → Updates.',
      ...(ctx.openUrl
        ? { link: { kind: 'url' as const, label: 'Open', url: `${ctx.openUrl}/config/updates` } }
        : {}),
      nature: 'fyi',
      check: 'homeassistant.updates',
      // Only a count is read: another one (or one fewer) is a new line.
      ignore: { lifts: 'newer', words: 'Until the updates change.' },
      episode: String(s.counts.updates),
    });
  if (s.counts && s.counts.unavailable > 0)
    out.push({
      id: 'unavailable',
      tone: 'info',
      icon: 'device',
      title: `${plural(s.counts.unavailable, 'device or sensor', 'devices and sensors')} not answering`,
      detail: 'Home Assistant shows them as unavailable.',
      nature: 'fyi',
      check: 'homeassistant.unavailable',
      ignore: { lifts: 'fixed', words: 'Until they all answer.' },
    });
  return out.slice(0, 30);
}

/** The lines the health pass can tell from Home Assistant alone (no machine, no disk line). */
export function haSeenNotices(s: HaSnapshot, timeZone: string, openUrl: string | null = null): KindNotice[] {
  return haNotices(
    s,
    null,
    { now: s.readAt, timeZone, openUrl, range: '24h', points: NO_POINTS },
    { seen: true },
  );
}

/**
 * The checks the health pass couldn't read (QN-S25): the parts Home Assistant didn't give (not an administrator, an
 * older version), and backups unless its own newest is recent (the machine may have a newer one).
 */
export function haSkipped(s: HaSnapshot): string[] {
  const out: string[] = [];
  if (!s.entries) out.push('homeassistant.integration');
  if (!s.repairs) out.push('homeassistant.repair');
  if (!s.log) out.push('homeassistant.log_flood');
  if (!s.counts) out.push('homeassistant.updates', 'homeassistant.unavailable');
  const own = newestBackup(s, null);
  if (!own || s.readAt.getTime() - own.getTime() > BACKUP_DAYS * 86_400_000) out.push('homeassistant.backup');
  return out;
}

const stateCell = (state: string) => {
  const w = stateWords(state);
  return { text: w.text, dot: w.dot };
};

function integrationRows(entries: readonly HaEntry[]): ThingPageRow[] {
  const rank = (e: HaEntry) => (NOT_LOADING.has(e.state) ? 0 : 1);
  return entries
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.domain.localeCompare(b.domain) || a.title.localeCompare(b.title))
    .slice(0, 300)
    .map((e) => ({
      id: e.id.slice(0, 200),
      cells: {
        integration: { text: clip(domainName(e.domain), 200) },
        name: { text: clip(e.title, 200) },
        state: { ...stateCell(e.state), ...(e.reason ? { note: clip(e.reason, 80) } : {}) },
      },
    }));
}

const INTEGRATION_COLUMNS = [
  { key: 'integration', label: 'Integration' },
  { key: 'name', label: 'Name' },
  { key: 'state', label: 'State' },
];

const DOT_TONE = { ok: 'ok', warn: 'warn', bad: 'bad', off: 'info' } as const;

/** Integrations not loading as lines (DS-10, `ha.png`): “Shelly · Pool pump”, “Retrying · cannot reach 10.100.0.87”. */
export function notLoadingItems(entries: readonly HaEntry[]): ThingPageItem[] {
  return entries.slice(0, 100).map((e) => {
    const name = domainName(e.domain);
    const w = stateWords(e.state);
    return {
      id: e.id.slice(0, 200),
      title: clip(e.title && e.title !== name ? `${name} · ${e.title}` : name, 160),
      detail: clip([w.text, e.reason].filter(Boolean).join(' · '), 300),
      tone: DOT_TONE[w.dot],
      icon: 'plug' as const,
    };
  });
}

function logItems(s: HaSnapshot, now: Date, timeZone: string): ThingPageItem[] {
  return (s.log ?? [])
    .slice()
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
    .slice(0, 100)
    .map((e, i) => ({
      id: `log-${i}`,
      title: clip(e.message.split('\n')[0] ?? e.message, 160),
      detail: clip(
        [domainName(loggerDomain(e.name)), e.first ? `first ${when(e.first, now, timeZone)}` : null]
          .filter(Boolean)
          .join(' · '),
        300,
      ),
      ...(e.at ? { at: e.at.toISOString() } : {}),
      tone:
        e.level === 'WARNING' ? ('warn' as const) : e.level === 'INFO' ? ('info' as const) : ('bad' as const),
      icon: 'log' as const,
      ...(e.count > 1 ? { right: `×${e.count}` } : {}),
    }));
}

/** Home Assistant's own backups and the machine's, newest first. */
export function backupItems(s: HaSnapshot, m: MachineFigures | null, limit: number): ThingPageItem[] {
  const items: (ThingPageItem & { t: number })[] = [];
  if (m?.lastBackup) {
    const good = /^(ok|success|done)$/i.test(m.lastBackup.result);
    items.push({
      id: 'machine',
      // A guest's own backups are Proxmox's (its backup job's); a server's are named by the server.
      title: m.kind === 'guest' ? 'Whole machine, by Proxmox' : `Whole ${m.label}`,
      detail:
        m.backupJob === true
          ? 'Made by a Proxmox backup job'
          : m.backupJob === false
            ? 'Made by hand: no backup job covers it'
            : `Of ${m.name}`,
      at: new Date(m.lastBackup.at).toISOString(),
      tone: good ? 'ok' : 'bad',
      icon: 'backup',
      t: new Date(m.lastBackup.at).getTime(),
    });
  }
  for (const b of s.backups ?? [])
    items.push({
      id: `ha-${b.id}`.slice(0, 200),
      title: clip(b.name, 160),
      detail: b.automatic ? 'Home Assistant’s automatic backup' : 'Made in Home Assistant',
      ...(b.at ? { at: b.at.toISOString() } : {}),
      tone: 'ok',
      icon: 'backup',
      ...(b.sizeBytes !== null ? { right: bytes(b.sizeBytes) } : {}),
      t: b.at?.getTime() ?? 0,
    });
  return items
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map(({ t: _t, ...item }) => item);
}

const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' });

/**
 * The Summary's Backups (`ha.png`): the machine's and the newest of Home Assistant's own; with three or more on its own
 * disk one line for all of them instead (“8.7 GB of Home Assistant backups on its own disk”, “23 backups, the oldest
 * from March”), amber while the disk is filling up.
 */
export function summaryBackups(
  s: HaSnapshot,
  m: MachineFigures | null,
  diskTone?: 'warn' | 'bad',
): ThingPageItem[] {
  const local = localBackups(s);
  if (!local || local.count < 3) return backupItems(s, m, 5);
  const items = backupItems(s, m, 2);
  items.push({
    id: 'local',
    title: `${bytes(local.bytes)} of Home Assistant backups on its own disk`,
    detail: `${local.count} backups${local.oldest ? `, the oldest from ${MONTH.format(local.oldest)}` : ''}`,
    tone: diskTone ? 'warn' : 'info',
    icon: 'disk',
  });
  return items;
}

function addonRows(sup: HaSupervisor): ThingPageRow[] {
  return sup.addons.slice(0, 300).map((a) => ({
    id: a.slug.slice(0, 200),
    cells: {
      name: { text: clip(a.name, 200) },
      state: {
        text: a.state === 'started' ? 'Running' : a.state === 'error' ? 'Failed' : cap(a.state),
        dot:
          a.state === 'started' ? ('ok' as const) : a.state === 'error' ? ('bad' as const) : ('off' as const),
      },
      cpu: { text: a.cpuPct !== null ? pct(a.cpuPct) : '', mono: true },
      memory: { text: a.memoryBytes !== null ? bytes(a.memoryBytes) : '', mono: true },
      version: {
        text: a.version ?? '',
        mono: true,
        ...(a.updateAvailable ? { note: 'update', tone: 'warn' as const } : {}),
      },
    },
  }));
}

/** The head's facts: “Home Assistant **2026.10.2** · Container”, “Restarted **23 h** ago”. */
export function haFacts(s: HaSnapshot, now: Date): ThingLine[] {
  const facts: ThingLine[] = [];
  if (s.version)
    facts.push(line(`Home Assistant **${s.version}**${s.installation ? ` · ${s.installation}` : ''}`));
  if (s.startedAt) facts.push(line(`Restarted **${span(now.getTime() - s.startedAt.getTime())}** ago`));
  return facts;
}

export const HA_RESTART: Omit<ThingPageAction, 'allowed' | 'reason'> = {
  id: 'restart',
  label: 'Restart',
  icon: 'restart',
  confirm: {
    title: 'Restart Home Assistant?',
    body: 'Home Assistant stops for about a minute and starts again. Automations don’t run while it restarts.',
    button: 'Restart',
  },
};

/** The restart the person may run (CP-12); refused on Look only. */
export function haActions(row: Pick<CatalogConnectionRow, 'access' | 'label'>): ThingPageAction[] {
  return [
    row.access === 'read'
      ? {
          ...HA_RESTART,
          allowed: false,
          reason:
            `${row.label} is set to Look only, so Whombat changes nothing there. Set it to Manage in Settings first.`.slice(
              0,
              200,
            ),
        }
      : { ...HA_RESTART, allowed: true },
  ];
}

/** The page's own part when the read worked: its Summary in slots, Worth a look, the tabs and the head's facts. */
export function haView(
  s: HaSnapshot,
  m: MachineFigures | null,
  ctx: HaCtx,
  parts: HaParts = NO_PARTS,
): Pick<
  KindView,
  | 'kpis'
  | 'charts'
  | 'machine'
  | 'notices'
  | 'panels'
  | 'slots'
  | 'tabs'
  | 'facts'
  | 'status'
  | 'problem'
  | 'verdict'
> {
  const tabs: ThingPageTab[] = [];
  if (s.entries)
    tabs.push({
      key: 'integrations',
      label: 'Integrations',
      count: s.entries.length,
      panels: [
        {
          kind: 'table',
          id: 'integrations',
          title: 'Integrations',
          meta: `${integrationCounts(s)?.loaded ?? 0} of ${s.entries.length} loaded`,
          columns: INTEGRATION_COLUMNS,
          rows: integrationRows(s.entries),
          empty: 'No integrations.',
        },
      ],
    });
  if (s.log)
    tabs.push({
      key: 'logs',
      label: 'Logs',
      panels: [
        {
          kind: 'list',
          id: 'log',
          title: 'Errors and warnings',
          meta: 'Home Assistant’s log since it started',
          items: logItems(s, ctx.now, ctx.timeZone),
          empty: 'Nothing in the log.',
        },
      ],
    });
  if (s.backups !== null || m?.lastBackup)
    tabs.push({
      key: 'backups',
      label: 'Backups',
      panels: [
        {
          kind: 'list',
          id: 'backups-all',
          title: 'Backups',
          items: backupItems(s, m, 100),
          empty: 'No backups yet.',
        },
      ],
    });
  if (s.supervisor?.addons.length)
    tabs.push({
      key: 'addons',
      label: 'Add-ons',
      count: s.supervisor.addons.length,
      panels: [
        {
          kind: 'table',
          id: 'addons',
          title: 'Add-ons',
          columns: [
            { key: 'name', label: 'Add-on' },
            { key: 'state', label: 'State' },
            { key: 'cpu', label: 'CPU', numeric: true },
            { key: 'memory', label: 'Memory', numeric: true },
            { key: 'version', label: 'Version' },
          ],
          rows: addonRows(s.supervisor),
        },
      ],
    });
  return {
    // In slots its counts are in “In Home Assistant” and the machine is a card after the rows.
    kpis: [],
    charts: [],
    machine: 'after',
    notices: haNotices(s, m, ctx),
    ...haSlots(s, m, ctx, parts),
    tabs,
    facts: haFacts(s, ctx.now),
    verdict: haVerdict(s, parts.house),
    ...(s.notAdmin
      ? {
          problem:
            'Whombat’s Home Assistant account isn’t an administrator, so it can’t read the integrations and the log.',
        }
      : {}),
  };
}

/** What the health pass kept for this connection over the last 30 days. */
export async function haPoints(
  services: Services,
  row: CatalogConnectionRow,
  ctx: KindCtx,
): Promise<HaPoints> {
  const points = await readPoints(
    services.db,
    row.id,
    [LOG_ERR_KEY, LOG_ERR_TOP_KEY, DB_MB_KEY],
    ctx.now,
    POINTS_KEEP_MS,
  );
  const glance = row.glance as ConnectionGlance | null;
  return {
    logErr: points.get(LOG_ERR_KEY) ?? [],
    logErrTop: points.get(LOG_ERR_TOP_KEY) ?? [],
    logTop: glance?.logTop ?? null,
    dbMb: points.get(DB_MB_KEY) ?? [],
    diskPct: ctx.disk.pct,
    diskGb: ctx.disk.gb,
  };
}

/**
 * Home Assistant's page part (`things/page.ts` adds the generic rest): its Summary in slots with the Controls live, the
 * page asked again every 10 seconds while they or Home now show (SD-09). A controls or house read that failed leaves
 * their panels out and says why when nothing else did.
 */
export async function homeAssistantPage(ctx: KindCtx): Promise<KindView> {
  const [controls, house] = await Promise.all([
    haControlsPart(ctx).catch(() => null),
    haHousePart(ctx).catch(() => null),
  ]);
  const parts: HaParts = {
    controls: controls?.panel ?? null,
    house: house?.read ?? null,
    camera: controlsCtx(ctx).cameraImage,
  };
  const view = await homeAssistantRuns(ctx, parts);
  const live = !!controls?.panel || view.panels.some((p) => p.id === 'home-now');
  return {
    ...view,
    ...(live ? { refreshS: CONTROLS_REFRESH_S } : {}),
    ...(view.refreshing || controls?.refreshing || house?.refreshing ? { refreshing: true } : {}),
    ...(!view.problem && (controls?.problem ?? house?.problem)
      ? { problem: controls?.problem ?? house?.problem }
      : {}),
  };
}

/** How Home Assistant runs (CP-07) with the house's parts: its slots, Worth a look and tabs. */
async function homeAssistantRuns(ctx: KindCtx, parts: HaParts): Promise<KindView> {
  const openUrl = (ctx.row.fields.url ?? ctx.row.baseUrl).replace(/\/+$/, '');
  const base: KindView = {
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    open: { label: 'Open Home Assistant', url: openUrl },
    actions: haActions(ctx.row),
    readAt: null,
    suggestions: ['Database size', 'Errors per hour', 'Memory over the week'],
  };
  const points = await haPoints(ctx.services, ctx.row, ctx).catch(() => NO_POINTS);
  const hctx: HaCtx = { now: ctx.now, timeZone: ctx.timeZone, openUrl, range: ctx.range, points };
  const m = ctx.machine?.figures ?? null;
  const read = await homeAssistantLatest(ctx.services, ctx.row, ctx.now);
  if (read.ok) {
    const s = read.value;
    return { ...base, ...haView(s, m, hctx, parts), readAt: s.readAt, refreshing: read.refreshing };
  }
  // Home Assistant didn't answer: the house's parts that did, and the machine's card, still say how it is.
  const s = emptySnapshot(ctx.now);
  return {
    ...base,
    kpis: [],
    charts: [],
    machine: 'after',
    ...haSlots(s, m, hctx, parts),
    problem: problemOf(read.error, 'Home Assistant').message,
    refreshing: read.refreshing,
  };
}

/** A read with nothing in it. */
export function emptySnapshot(now: Date): HaSnapshot {
  return {
    readAt: now,
    version: null,
    installation: null,
    recoveryMode: false,
    startedAt: null,
    notAdmin: false,
    entries: null,
    repairs: null,
    log: null,
    database: null,
    backups: null,
    counts: null,
    supervisor: null,
  };
}

/** Home Assistant's points (DS-11): errors since the restart, the noisiest source's, the database in MB. */
export function haSeenPoints(s: HaSnapshot): {
  points: Record<string, number | null>;
  logTop: string | null;
} {
  const errors = logErrors(s);
  const points: Record<string, number | null> = {};
  if (errors) {
    points[LOG_ERR_KEY] = errors.count;
    if (errors.top) points[LOG_ERR_TOP_KEY] = errors.topCount;
  }
  if (s.database?.sizeBytes != null) points[DB_MB_KEY] = Math.round(s.database.sizeBytes / 1e4) / 100;
  return { points, logTop: errors?.top ?? null };
}

/**
 * The health pass's look (CP-16, QN-S25): version, integrations loaded, errors today, updates; the points; Worth a
 * look's lines it can tell from Home Assistant alone (the disk is the machine's, `machine` below), what it couldn't read.
 */
export async function homeAssistantSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const s = await homeAssistantSnapshot(services, row, now);
  const { points, logTop } = haSeenPoints(s);
  const notices = haSeenNotices(s, timeZone, (row.fields.url ?? row.baseUrl).replace(/\/+$/, ''));
  return {
    glance: { ...homeAssistantGlance(s, timeZone, notices), ...(logTop ? { logTop } : {}) },
    points,
    notices,
    skipped: haSkipped(s),
    machine: (m) => haMachine(m, s.supervisor),
    protection: haProtection(s.backups?.map((b) => ({ at: b.at, elsewhere: b.elsewhere ?? [] })) ?? null),
  };
}
