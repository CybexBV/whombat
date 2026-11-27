/**
 * Overview's servers on one page (docs/decisions/overview-one-page.md): one row a server with the same five cells —
 * Processor over 24 hours, Memory, Storage, Temperature, Running — in the order a person reads trouble (worst first, a
 * server that runs on another under it), the section's summary line and the processor's small 24 hour line. The figures
 * come from `serverFigures` and the words from the tiles' bands, so the server's page and Overview say the same. Pure:
 * the web draws rows (or cards on a narrow page), the phone cards; `now` and the time zone come in as arguments.
 */
import type { MarkLike } from '@whombat/brand';
import { HOST_STATUS_LABELS, type HostServer, type HostServerStatus } from '@whombat/core/domain';
import { type StatusLevel, serverStatusLevel } from '../home/statusLevel';
import { OVERVIEW_WORDS } from '../home/tabs';
import { readingTime } from '../home/time';
import { clientTranslator } from '../i18n/catalog';
import { DASH, formatAgoIso, formatPct, formatTemp, formatUptimeShort } from './format';
import { ALL_GUESTS_HREF, serverHref, serverRow } from './model';
import type { HostTone } from './thresholds';
import {
  figureHref,
  memoryFullWords,
  processorWords,
  serverFigures,
  serverOsLine,
  serverTiles,
  spaceWords,
  tileTone,
} from './tiles';

const NBSP = ' ';

/** A reading older than this says its time under the server's name (“Read 12 min ago”); a fresher one stays quiet. */
export const STALE_READING_MS = 5 * 60_000;

/** At most this many dots under Running; the rest are “+N”. */
export const RUNNING_DOTS_MAX = 60;

/** Where “Everything running” in the Servers heading leads: every machine and app of every server. */
export const EVERYTHING_RUNNING_HREF = ALL_GUESTS_HREF;

/** A cell's tone: amber at most, red is the pill's for what isn't working. */
export type OverviewCellTone = 'ok' | 'warn';

interface CellBase {
  /** The column's name (“Processor · 24 h”), also the cell's label on a narrow card. */
  label: string;
  /** Where the figure leads: the server's page with its chart open, or its Storage or machines tab. */
  href: string;
  /** The cell as a screen reader says it. */
  spoken: string;
  tone: OverviewCellTone;
}

export interface OverviewCpuCell extends CellBase {
  /** “10 %”, “—” when not known. */
  value: string;
  /** “Quiet”; null for a server that isn't working (its bare figure) or offline. */
  word: string | null;
  /** “avg 7 %” from the 24 hour readings; null without. */
  avg: string | null;
  /** The last 24 hours' readings, oldest first (missing ones left out); empty with fewer than two. */
  points: number[];
}

export interface OverviewAmountCell extends CellBase {
  /** “64 %”, “—”. */
  value: string;
  /** “Getting full”; null for a server that isn't working or offline. */
  word: string | null;
  /** “76 of 118 GB”, “0.9 of 2 TB”; empty when the total isn't known or the server is offline. */
  sub: string;
  /** The block bar's share, 0…1; null when not known (an unlit bar). */
  share: number | null;
}

export interface OverviewTempCell extends CellBase {
  /** “75 °C”; “–” without a sensor; “—” offline. */
  value: string;
  /** “limit 85 °C”, “No sensor”; may be empty. */
  sub: string;
  /** The block bar's share of the limit, 0…1; null without a sensor (no bar). */
  share: number | null;
  /** The server has no temperature sensor: the figure is muted and there is no bar. */
  noSensor: boolean;
}

export interface OverviewRunningDots {
  /** Amber dots, drawn first. */
  unwell: number;
  /** Filled dots. */
  running: number;
  /** Hollow dots. */
  stopped: number;
  /** How many weren't drawn (“+12”); 0 when all were. */
  more: number;
}

export interface OverviewRunningCell extends CellBase {
  /** “19 of 22”; empty when nothing is on it. */
  count: string;
  /** “machines”, “apps”, “2 unwell”, or “Nothing running”. */
  word: string;
  /** Nothing runs on it: no count and no dots, the word alone. */
  nothing: boolean;
  dots: OverviewRunningDots;
}

export interface OverviewServerPill {
  /** The pill's word: “Disk array failed”, “Running warm”, “Offline”, “Waiting for its first report”. */
  word: string;
  /** `bad` and `warn` in their colour, `mut` grey (offline, waiting). */
  tone: HostTone;
}

export interface OverviewServerRow {
  id: string;
  name: string;
  href: string;
  mark: MarkLike | null;
  status: HostServerStatus;
  /** Its status level, for the pill's mark (`LevelPill`). */
  level: StatusLevel;
  /** It runs on the server in the row before it (or one of that one's): set in with an elbow line. */
  child: boolean;
  /** The parent's id when it is a child row; else null. */
  parentId: string | null;
  /** One of its machines is this Whombat: the “This Whombat” tag. */
  thisWhombat: boolean;
  /** Offline or still waiting for its first report: the figures are dimmed dashes and `seen` says when it last was. */
  offline: boolean;
  /** Its status is bad: the tinted row with the red edge, and bare figures without words. */
  notWorking: boolean;
  /** Null when it runs fine (healthy is quiet); else the pill. */
  pill: OverviewServerPill | null;
  /** Its status in words for a screen reader when there is no pill: “Running fine”, else the pill's word. */
  statusWord: string;
  /** “Proxmox VE 9.2 · up 23 d”; a child's “Ubuntu 24.04 · on pve-02”. */
  osLine: string;
  /** “Read 12 min ago” when its reading is older than `STALE_READING_MS`, “Reading time unknown” without a time; else null. */
  stale: string | null;
  /** When its own report was taken (`lastSeen`); null when not known. */
  readAt: string | null;
  /** The row's tooltip: “Read at 13:53 on 23 Sept”, or “Reading time unknown”. */
  readTitle: string;
  /** “Last seen 2 d ago” for an offline server; else null. */
  seen: string | null;
  cpu: OverviewCpuCell;
  memory: OverviewAmountCell;
  storage: OverviewAmountCell;
  temp: OverviewTempCell;
  running: OverviewRunningCell;
  /** The row's accessible name: name, status, every known figure, what runs, uptime, when it was read. */
  label: string;
}

/** The order servers sort by: what isn't working first, running fine last. */
export const SERVER_STATUS_RANK: Record<HostServerStatus, number> = {
  bad: 0,
  offline: 1,
  warn: 2,
  pending: 3,
  ok: 4,
};

const byRank = (a: HostServer, b: HostServer) =>
  SERVER_STATUS_RANK[a.status] - SERVER_STATUS_RANK[b.status] || a.name.localeCompare(b.name);

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const toCellTone = (t: HostTone): OverviewCellTone => (tileTone(t) === 'warn' ? 'warn' : 'ok');
const spokenText = (s: string) => s.replaceAll(NBSP, ' ');

/** The word for what runs on a server: apps when it only runs Docker, else machines (never “guests”). */
export function serverGuestWord(s: Pick<HostServer, 'guests'>): 'machines' | 'apps' {
  return s.guests.length > 0 && s.guests.every((g) => g.platform === 'docker') ? 'apps' : 'machines';
}

/**
 * The servers in Overview's order: top-level servers worst first, then by name; a server that runs on another in the
 * list follows it directly (its siblings worst first too). A server whose parent isn't in the list is top-level.
 */
export function overviewServerOrder(
  servers: readonly HostServer[],
): { server: HostServer; parent: HostServer | null }[] {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const parentOf = (s: HostServer): HostServer | null => {
    const p = s.parent ? byId.get(s.parent) : undefined;
    return p && p.id !== s.id ? p : null;
  };
  const children = new Map<string, HostServer[]>();
  for (const s of servers) {
    const p = parentOf(s);
    if (p) children.set(p.id, [...(children.get(p.id) ?? []), s]);
  }
  const out: { server: HostServer; parent: HostServer | null }[] = [];
  const placed = new Set<string>();
  const place = (s: HostServer, parent: HostServer | null) => {
    if (placed.has(s.id)) return;
    placed.add(s.id);
    out.push({ server: s, parent });
    for (const c of [...(children.get(s.id) ?? [])].sort(byRank)) place(c, s);
  };
  for (const s of [...servers].filter((s) => !parentOf(s)).sort(byRank)) place(s, null);
  // Servers that are each other's parents have no top: they stand on their own rather than vanish.
  for (const s of [...servers].filter((s) => !placed.has(s.id)).sort(byRank)) place(s, null);
  return out;
}

/** The running cell's dots: unwell first, then running, then stopped, at most `RUNNING_DOTS_MAX` in all. */
export function runningDots(
  running: number,
  total: number,
  unhealthy: number,
  max = RUNNING_DOTS_MAX,
): OverviewRunningDots {
  const t = Math.max(0, total);
  const r = Math.min(Math.max(0, running), t);
  const u = Math.min(Math.max(0, unhealthy), r);
  const unwell = Math.min(u, max);
  const run = Math.min(r - u, max - unwell);
  const stopped = Math.min(t - r, max - unwell - run);
  return { unwell, running: run, stopped, more: t - unwell - run - stopped };
}

/** One server's row; `parent` is the server it runs on when the row sits under it. */
export function overviewServerRow(
  s: HostServer,
  now: number,
  timeZone: string,
  parent: Pick<HostServer, 'id' | 'name'> | null = null,
): OverviewServerRow {
  const r = serverRow(s);
  const offline = r.offline;
  const notWorking = s.status === 'bad';
  const words = !notWorking && !offline;
  const f = serverFigures(s);
  const [cpuTile, memTile, diskTile, tempTile] = serverTiles(s);
  const home = serverHref(s.id);
  const col = OVERVIEW_WORDS.columns;

  const pill: OverviewServerPill | null = offline
    ? { word: r.statusLabel, tone: 'mut' }
    : r.tone === 'ok'
      ? null
      : { word: r.statusLabel, tone: r.tone };
  const statusWord = pill?.word ?? HOST_STATUS_LABELS.ok;

  // Processor
  const cpuValue = offline ? DASH : formatPct(f.cpu);
  const cpuWord = words && f.cpu != null ? processorWords(f.cpu) : null;
  const avg = !offline && f.avg != null ? `avg ${formatPct(f.avg)}` : null;
  const points = offline ? [] : s.cpu24h.filter(finite).map((v) => Math.max(0, v));
  const cpu: OverviewCpuCell = {
    label: col.cpu,
    href: cpuTile?.href ?? figureHref(s.id, 'chart=cpu'),
    value: cpuValue,
    word: cpuWord,
    avg,
    points: points.length >= 2 ? points : [],
    tone: offline ? 'ok' : toCellTone(cpuTile?.tone ?? 'ok'),
    spoken: spokenText(
      cpuValue === DASH
        ? 'Processor not known'
        : [
            `Processor ${cpuValue}`,
            cpuWord?.toLowerCase(),
            avg ? `24 hour average ${formatPct(f.avg)}` : null,
          ]
            .filter(Boolean)
            .join(', '),
    ),
  };

  const amount = (
    label: string,
    name: string,
    pct: number | null,
    sub: string,
    wordOf: (pct: number) => string,
    tile: { href: string; tone: HostTone } | undefined,
    search: string,
  ): OverviewAmountCell => {
    const known = !offline && pct != null;
    const value = known ? formatPct(pct) : DASH;
    const word = words && known ? wordOf(pct) : null;
    const shown = offline ? '' : sub;
    return {
      label,
      href: tile?.href ?? figureHref(s.id, search),
      value,
      word,
      sub: shown,
      share: known ? clamp01(pct / 100) : null,
      tone: known ? toCellTone(tile?.tone ?? 'ok') : 'ok',
      spoken: spokenText(
        known
          ? [`${name} ${value}`, word?.toLowerCase(), shown ? `${shown} in use` : null]
              .filter(Boolean)
              .join(', ')
          : `${name} not known`,
      ),
    };
  };
  const memory = amount(
    col.memory,
    'Memory',
    f.memPct,
    f.memAmount,
    memoryFullWords,
    memTile,
    'chart=memory',
  );
  const storage = amount(
    col.storage,
    'Storage',
    f.diskPct,
    f.diskAmount,
    spaceWords,
    diskTile,
    'tab=storage',
  );

  // Temperature
  const tempHref = tempTile?.href ?? figureHref(s.id, 'chart=hottest');
  const limitText = f.limit != null ? `limit ${formatTemp(f.limit)}` : '';
  const temp: OverviewTempCell = offline
    ? {
        label: col.temp,
        href: tempHref,
        value: DASH,
        sub: '',
        share: null,
        noSensor: false,
        tone: 'ok',
        spoken: 'Temperature not known',
      }
    : s.temperature == null || f.maxC == null
      ? {
          label: col.temp,
          href: tempHref,
          value: OVERVIEW_WORDS.noSensorValue,
          sub: OVERVIEW_WORDS.noSensor,
          share: null,
          noSensor: true,
          tone: 'ok',
          spoken: 'Temperature, no sensor',
        }
      : {
          label: col.temp,
          href: tempHref,
          value: formatTemp(f.maxC),
          sub: limitText,
          share: clamp01(f.maxC / (f.limit ?? 100)),
          noSensor: false,
          tone: toCellTone(tempTile?.tone ?? 'ok'),
          spoken: spokenText(
            [`Temperature ${formatTemp(f.maxC)}`, 'the hottest sensor', limitText || null]
              .filter(Boolean)
              .join(', '),
          ),
        };

  // Running
  const unhealthy = s.guests.reduce((a, g) => a + (g.unhealthy ?? 0), 0);
  const kind = serverGuestWord(s);
  const total = r.guestsTotal;
  const dots = runningDots(r.guestsRunning, total, unhealthy);
  const unwell = Math.min(unhealthy, r.guestsRunning);
  const nothing = total === 0;
  const running: OverviewRunningCell = {
    label: col.running,
    href: `${home}?tab=guests`,
    count: nothing ? '' : `${r.guestsRunning} of ${total}`,
    word: nothing ? OVERVIEW_WORDS.nothingRunning : unwell > 0 ? `${unwell} unwell` : kind,
    nothing,
    dots,
    tone: unwell > 0 ? 'warn' : 'ok',
    spoken: nothing
      ? 'Nothing running'
      : [`${r.guestsRunning} of ${total} ${kind} running`, unwell > 0 ? `${unwell} unwell` : null]
          .filter(Boolean)
          .join(', '),
  };

  // When it was read
  const read = readingTime(s.lastSeen, now, timeZone);
  const at = s.lastSeen ? Date.parse(s.lastSeen) : Number.NaN;
  const seen = offline && s.lastSeen ? `Last seen ${formatAgoIso(s.lastSeen, now)}` : null;
  const stale = seen
    ? null
    : !read.known
      ? s.status === 'pending'
        ? null
        : read.text
      : now - at > STALE_READING_MS
        ? read.text
        : null;

  // A child names its parent where its uptime was: what runs where matters more on Overview than for how long.
  const osLine = parent
    ? [serverOsLine({ ...s, uptimeS: null }), `on ${parent.name}`].filter(Boolean).join(' · ')
    : serverOsLine(s);

  const label = spokenText(
    [
      r.name,
      statusWord.toLowerCase(),
      parent ? `on ${parent.name}` : null,
      ...(offline ? [] : [cpu.spoken, memory.spoken, storage.spoken, temp.spoken]),
      running.spoken,
      !offline && s.uptimeS != null ? `up ${formatUptimeShort(s.uptimeS)}` : null,
      seen?.toLowerCase() ?? (s.status === 'pending' ? null : read.exact.toLowerCase()),
    ]
      .filter(Boolean)
      .join(', '),
  );

  return {
    id: s.id,
    name: r.name,
    href: home,
    mark: r.mark,
    status: s.status,
    level: serverStatusLevel(s.status),
    child: parent != null,
    parentId: parent?.id ?? null,
    thisWhombat: s.hostsThisWhombat === true,
    offline,
    notWorking,
    pill,
    statusWord,
    osLine,
    stale,
    readAt: s.lastSeen ?? null,
    readTitle: read.exact,
    seen,
    cpu,
    memory,
    storage,
    temp,
    running,
    label,
  };
}

/** Overview's server rows in their order (`overviewServerOrder`). */
export function overviewServerRows(
  servers: readonly HostServer[],
  now: number,
  timeZone: string,
): OverviewServerRow[] {
  return overviewServerOrder(servers).map(({ server, parent }) =>
    overviewServerRow(server, now, timeZone, parent),
  );
}

/**
 * The Servers heading's line: “5 running · 1 not working · 112 of 139 machines and apps running”, “All running · …”.
 * A server that needs a look still runs; offline and waiting ones are counted apart. The noun follows what the servers
 * run: machines, apps (Docker only), or both. Empty without servers.
 */
export function overviewServersLine(servers: readonly HostServer[], locale?: string | null): string {
  if (!servers.length) return '';
  const tr = clientTranslator(locale);
  const count = (...st: HostServerStatus[]) => servers.filter((s) => st.includes(s.status)).length;
  const up = count('ok', 'warn');
  const parts: string[] = [];
  if (up === servers.length) parts.push(tr.t('hosts.overview.allRunning'));
  else {
    if (up) parts.push(tr.t('hosts.overview.running', { count: up }));
    if (count('bad')) parts.push(tr.t('hosts.overview.notWorking', { count: count('bad') }));
    if (count('offline')) parts.push(tr.t('hosts.overview.offline', { count: count('offline') }));
    if (count('pending')) parts.push(tr.t('hosts.overview.waiting', { count: count('pending') }));
  }
  let running = 0;
  let total = 0;
  let machines = false;
  let apps = false;
  for (const s of servers)
    for (const g of s.guests) {
      running += g.running;
      total += g.total;
      if (g.total > 0) {
        if (g.platform === 'docker') apps = true;
        else machines = true;
      }
    }
  if (total) {
    const noun = tr.t(
      machines && apps
        ? 'hosts.overview.noun.both'
        : apps
          ? 'hosts.overview.noun.apps'
          : 'hosts.overview.noun.machines',
    );
    parts.push(tr.t('hosts.overview.guestsRunning', { running, total, noun }));
  }
  return parts.join(' · ');
}

/**
 * The processor's 24 hour line as SVG path data in a `width` × `height` box (y down): `line` the readings, `area` the
 * wash under them. The scale's top is the higher of the highest reading and 20 %, with 10 % room above, so a quiet day
 * stays low; 1 px margin top and bottom. Null with fewer than two readings.
 */
export function sparklinePaths(
  points: readonly number[],
  width: number,
  height: number,
): { line: string; area: string } | null {
  const ps = points.filter(Number.isFinite).map((p) => Math.max(0, p));
  if (ps.length < 2 || !(width > 0) || !(height > 0)) return null;
  const max = Math.max(...ps, 20) * 1.1;
  const n = (v: number) => String(Number(v.toFixed(1)));
  const line = ps
    .map((p, i) => {
      const x = (i / (ps.length - 1)) * width;
      const y = height - (p / max) * (height - 2) - 1;
      return `${i ? 'L' : 'M'}${n(x)} ${n(y)}`;
    })
    .join('');
  return { line, area: `${line}L${n(width)} ${n(height)}L0 ${n(height)}Z` };
}
