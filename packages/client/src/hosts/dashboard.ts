/**
 * A server's Summary as dashboard panels (Whombat dashboards.md DS-01…DS-09, DS-15, DS-16; app dashboards-client.md
 * AP-2000…): the same `ThingPagePanel`s a connection's page is made of, built here from the hosts data the app already
 * reads (`hosts.getServer`, `hosts.serverMetrics` for the page's range, the busiest guests' `hosts.guestMetrics`), so the
 * web and the phone draw a server's Summary with the renderer they draw a connection's with (DS-02). Every server kind
 * gets one: plain Linux, Docker hosts, Proxmox VE, Unraid, Incus and QEMU/KVM — figures with a small line of the range,
 * chart cards with their average and peak, the busiest guests, Worth a look, storage with its forecast, and the kind's
 * own (Unraid's array and pools, Proxmox's backups and cluster). The Summary shows; the tabs do: every action the old
 * Summary had is a link to the tab that has it. Pure; times come in as arguments.
 */
import {
  HOST_CONTROL_LEVEL_WORDS,
  HOST_SERIES_RANGES,
  type HostControlLevel,
  type HostGuest,
  type HostHint,
  type HostSensor,
  type HostSeries,
  type HostSeriesRange,
  type HostServerDetail,
  type HostServerStatus,
  type HostUnraidDetail,
  type HostUnraidDisk,
  type HostVolume,
  type ThingLine,
  type ThingNoticeIcon,
  type ThingPageBar,
  type ThingPageCell,
  type ThingPageItem,
  type ThingPageKpi,
  type ThingPageLink,
  type ThingPageNotice,
  type ThingPagePanel,
  type ThingTone,
  thingHref,
} from '@whombat/core/domain';
import { lastValue, type SeriesValues, tempScale } from './chart';
import {
  cut,
  dashboardNumber,
  diskRateWords,
  FORECAST_DATE_DAYS,
  formatDayMonth,
  movedGb,
  NBSP,
  rateWords,
  seriesStats,
  sizePair,
  sizeWords,
  volumeForecast,
  withUnit,
} from './dashboard-words';
import {
  DASH,
  formatAgo,
  formatDuration,
  formatIn,
  formatMemPair,
  formatPct,
  formatPct1,
  formatRelativeDay,
  formatTemp,
  plural,
} from './format';
import { type HintFix, hintFixes } from './hints';
import { INCUS_SERVER_TAB_WORDS, INCUS_SERVER_TABS } from './incus';
import { incusFacts } from './incus-mobile';
import { isLibvirtServer, LIBVIRT_KIND_WORD, LIBVIRT_SERVER_TAB_WORDS, LIBVIRT_SERVER_TABS } from './libvirt';
import { libvirtFacts } from './libvirt-mobile';
import { isMacServer, MAC_SERVER_TAB_WORDS, MAC_SERVER_TABS, macFacts, macSystemLine } from './macos';
import {
  busiestGuests,
  detailGuests,
  hottestSensor,
  SERVER_TAB_WORDS,
  SERVER_TABS,
  statusText,
  storageTotals,
} from './model';
import {
  alertCounts,
  alertNoticeParts,
  hintCounts,
  hintNoticeParts,
  type ServerNoticeOptions,
  serverNoticeOptions,
} from './notices';
import { splitTemporary } from './temporary';
import { diskUsedLevel, type HostTone, hostTone, sensorLevel, serverTone } from './thresholds';
import { memoryFullWords, processorWords, spaceWords } from './tiles';
import {
  notificationTitle,
  parityState,
  parityView,
  UNRAID_POOL_FULL_PCT,
  UNRAID_TAB_WORDS,
  UNRAID_TABS,
  type UnraidHintFix,
  unraidArrayView,
  unraidDiskName,
  unraidHintFixes,
  unraidPageUrl,
  unraidTempTone,
} from './unraid';
import { unraidFacts } from './unraid-mobile';
import { isRebootHint, isUpdatesHint, UPDATES_WORDS } from './updates';
import { type RunningCounts, serverVerdict, type Verdict } from './verdict';

export { type PlacedChart, type PlacedPanels, placePanels, thingSeriesToken } from '../home/thingPage';
export {
  dashboardNumber,
  diskRateWords,
  formatDayMonth,
  peakWhen,
  rateWords,
  type SeriesStats,
  seriesStats,
  sizePair,
  sizeWords,
  type VolumeForecast,
  volumeForecast,
} from './dashboard-words';

type Panel = ThingPagePanel;
type ChartPanel = Extract<ThingPagePanel, { kind: 'chart' }>;
type ChartSeries = ChartPanel['series'][number];

/* Ranges (DS-03, DS-16) ------------------------------------------------------------------------------------- */

/** The ranges a server's Summary offers, shortest first: the hosts service keeps 90 days. */
export const SERVER_DASHBOARD_RANGES: readonly HostSeriesRange[] = HOST_SERIES_RANGES;

/** The phone's: 90 days left out (dashboards brief, stream M). */
export const SERVER_DASHBOARD_PHONE_RANGES: readonly HostSeriesRange[] = ['1h', '6h', '24h', '7d', '30d'];

/** The range without `?range=` in the address. */
export const SERVER_DASHBOARD_DEFAULT_RANGE: HostSeriesRange = '24h';

/** The range picker's words (the mock: “1h · 6h · 24h · 7d · 30d · 90d”). */
export const DASHBOARD_RANGE_WORDS: Record<HostSeriesRange, string> = {
  '1h': '1h',
  '6h': '6h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
};

/** A table's column of small lines, named for the range (“24 h”). */
const RANGE_COLUMN: Record<HostSeriesRange, string> = {
  '1h': '1 h',
  '6h': '6 h',
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
  '90d': '90 d',
};

/** What stands before a server's range picker (DS-16): its figures follow the live hosts events. */
export const SERVER_DASHBOARD_LIVE_WORDS = 'Live · every 10 s';

/** How often a server's Summary reads its history again (DS-16). */
export const SERVER_DASHBOARD_REFRESH_MS = 60_000;

/** The range an address asks for (`?range=7d`), if offered; else 24 hours. */
export function parseDashboardRange(
  v: unknown,
  ranges: readonly HostSeriesRange[] = SERVER_DASHBOARD_RANGES,
): HostSeriesRange {
  return typeof v === 'string' && (ranges as readonly string[]).includes(v)
    ? (v as HostSeriesRange)
    : ranges.includes(SERVER_DASHBOARD_DEFAULT_RANGE)
      ? SERVER_DASHBOARD_DEFAULT_RANGE
      : (ranges[0] ?? SERVER_DASHBOARD_DEFAULT_RANGE);
}

/* Kinds, tabs and links ------------------------------------------------------------------------------------- */

/** Which Summary a server gets: the hub's page kind, a Docker host, or a plain Linux one. */
export type ServerDashboardKind = 'proxmox' | 'unraid' | 'incus' | 'libvirt' | 'docker' | 'linux' | 'macos';

type KindDetail = Pick<
  HostServerDetail,
  'server' | 'proxmox' | 'unraid' | 'incus' | 'libvirt' | 'workloads'
> &
  Partial<Pick<HostServerDetail, 'macos'>>;

export function serverDashboardKind(d: KindDetail): ServerDashboardKind {
  const p: string = d.server.platform;
  // A Mac (macos-servers.md): its own tabs, whatever runs on it.
  if (isMacServer(d)) return 'macos';
  if (p === 'unraid' || d.unraid) return 'unraid';
  if (p === 'proxmox' || d.proxmox) return 'proxmox';
  if (p === 'incus') return 'incus';
  if (isLibvirtServer(d)) return 'libvirt';
  if ((d.workloads?.docker?.total ?? 0) > 0) return 'docker';
  return 'linux';
}

/** The tabs a server of this kind has (the web's; the Summary links only to these). */
export function serverDashboardTabs(kind: ServerDashboardKind): readonly string[] {
  return kind === 'unraid'
    ? UNRAID_TABS
    : kind === 'incus'
      ? INCUS_SERVER_TABS
      : kind === 'libvirt'
        ? LIBVIRT_SERVER_TABS
        : kind === 'macos'
          ? MAC_SERVER_TABS
          : SERVER_TABS;
}

/**
 * What runs on a server, in the word its tab, lists and figures use: a Docker host's (and Unraid's) are apps, a
 * Proxmox, Incus or QEMU/KVM server's machines (the word list: never “guests”).
 */
export function guestsWord(kind: ServerDashboardKind): 'Apps' | 'Machines' {
  return kind === 'docker' || kind === 'unraid' ? 'Apps' : 'Machines';
}

function tabWord(kind: ServerDashboardKind, tab: string): string {
  if (tab === 'guests') return guestsWord(kind);
  const words: Record<string, string> =
    kind === 'unraid'
      ? UNRAID_TAB_WORDS
      : kind === 'incus'
        ? INCUS_SERVER_TAB_WORDS
        : kind === 'libvirt'
          ? LIBVIRT_SERVER_TAB_WORDS
          : kind === 'macos'
            ? MAC_SERVER_TAB_WORDS
            : SERVER_TAB_WORDS;
  return words[tab] ?? tab;
}

/** A server's page with search parameters (`/things/server%3Apve-02?tab=storage`). */
function serverPage(serverId: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return `${thingHref('server', serverId)}${q ? `?${q}` : ''}`;
}

/** A server's tab as an app path (the web's `?tab=`). */
export function serverTabHref(serverId: string, tab: string): string {
  return serverPage(serverId, tab === 'summary' ? {} : { tab });
}

/** A guest's page over its server's (`?guest=pve:131`), optionally on one of its tabs (`gtab`). */
export function serverGuestHref(serverId: string, guestId: string, gtab?: string): string {
  return serverPage(serverId, gtab ? { guest: guestId, gtab } : { guest: guestId });
}

/** A guest's console (`?console=pve:131`), or the server's own shell (`host`). */
export function serverConsoleHref(serverId: string, target: string): string {
  return serverPage(serverId, { console: target });
}

/* What to read ---------------------------------------------------------------------------------------------- */

/** At most this many `vol_pct:*` series (storages, pools, file systems). */
export const DASHBOARD_VOLUME_SERIES = 8;

/** How many guests the busiest table lists. */
export const DASHBOARD_GUESTS = 5;

const BASE_SERIES = [
  'cpu_pct',
  'mem_pct',
  'load1',
  'swap_pct',
  'net_rx_mbps',
  'net_tx_mbps',
  'disk_read_mbs',
  'disk_write_mbs',
] as const;

/** The series key of a sensor (`temp_cpu_package_c`). */
function tempKey(s: Pick<HostSensor, 'id'>): string {
  return `temp_${s.id}_c`;
}

/**
 * The volumes' used-space series (`vol_pct:<entity>`, up to 8): the host's pools and file systems shown, Proxmox's
 * storages. Read for 30 days for the forecasts (DS-08), whatever the page's range.
 */
export function serverDashboardVolumeSeries(detail: HostServerDetail): string[] {
  const vols = new Set<string>();
  for (const s of detail.proxmox?.storages ?? []) if (s.capacityGb > 0) vols.add(`storage:${s.id}`);
  for (const v of shownVolumes(detail)) vols.add(v.entity);
  return [...vols].slice(0, DASHBOARD_VOLUME_SERIES).map((e) => `vol_pct:${e}`);
}

/** The range the volumes' forecasts read (DS-08: the last 30 days). */
export const DASHBOARD_FORECAST_RANGE: HostSeriesRange = '30d';

/**
 * The series a Summary asks `hosts.serverMetrics` for over the page's range (DS-06): CPU, memory, load, swap, network,
 * disk I/O, every sensor, and the volumes' (`serverDashboardVolumeSeries`, a forecast's fallback without the 30-day
 * read).
 */
export function serverDashboardSeries(detail: HostServerDetail): string[] {
  return [...BASE_SERIES, ...detail.sensors.map(tempKey), ...serverDashboardVolumeSeries(detail)];
}

/** The guests the busiest table lists (their own history is read for its small lines). */
export function dashboardGuests(detail: HostServerDetail, n = DASHBOARD_GUESTS): HostGuest[] {
  const kind = serverDashboardKind(detail);
  // Temporary machines (CI jobs, sandboxes) are never the busiest a person sees.
  const all = splitTemporary(detailGuests(detail)).kept;
  if (kind === 'libvirt') return vmRows(all.filter((g) => g.platform === 'libvirt')).slice(0, n);
  return busiestGuests(kind === 'unraid' ? all.filter((g) => g.platform === 'docker') : all, n);
}

/** VMs as a QEMU/KVM server lists them: running first (busiest first), then the rest by name. */
function vmRows(vms: readonly HostGuest[]): HostGuest[] {
  const on = (g: HostGuest) => g.state === 'running' || g.state === 'unhealthy';
  return [...vms].sort(
    (a, b) =>
      Number(on(b)) - Number(on(a)) || (b.cpuPct ?? 0) - (a.cpuPct ?? 0) || a.name.localeCompare(b.name),
  );
}

/* The head (DS-01) ------------------------------------------------------------------------------------------ */

export interface ServerDashboardHead {
  kind: ServerDashboardKind;
  /** The name a person gave it (“The Titan”), else its id. */
  name: string;
  /** Its id (“the-titan”) when it goes by a name, said quietly under it; null when the name is the id. */
  idLine: string | null;
  status: HostServerStatus;
  tone: HostTone;
  /** The one status badge: “1 to look at”, “Array started”, “Running fine”, “Offline”. */
  badge: string;
  /**
   * What only someone who runs the server needs, for the page's one “Technical details” fold: its system and platform
   * versions, processor, memory, address, when Whombat's helper last checked in, what Whombat may do there.
   */
  details: ServerDetailRow[];
}

/** One line of Technical details: “Processor · Ryzen 7 5700G, 8 cores / 16 threads”. */
export interface ServerDetailRow {
  label: string;
  value: string;
  /** An address or a version, in the mono face. */
  mono?: boolean;
}

/** What Whombat may do on it, from the switches (SI-06): Full control, Restart and consoles, Watch only. */
export function serverControlLevel(rc: HostServerDetail['server']['remoteControl']): HostControlLevel {
  if (rc.manage && rc.hostShell && rc.hostPower) return 'full';
  if (rc.console && rc.power) return 'operate';
  return 'watch';
}

/**
 * What needs a look on a server (Whombat quiet-notices.md QN-14, QN-23; AP-4812): its open alerts that ask for
 * attention (not acknowledged, muted, suppressed or quiet), and its warnings that aren't heads-ups or quiet.
 */
export function lookCount(d: Pick<HostServerDetail, 'alerts' | 'hints' | 'server'>): number {
  const alerts = (d.alerts ?? []).filter(alertCounts).length;
  const hints = d.hints.filter((h) => h.serverId === d.server.id && hintCounts(h)).length;
  return alerts + hints;
}

/**
 * The head of a server's page (DS-01): its name and one badge; everything else it knows about itself (versions, the
 * processor, memory, the address, when Whombat's helper last checked in, what Whombat may do there) is Technical
 * details, folded, so the page opens with what a person needs.
 */
export function serverDashboardHead(
  detail: HostServerDetail,
  opts: { name?: string } = {},
): ServerDashboardHead {
  const s = detail.server;
  const kind = serverDashboardKind(detail);
  const offline = s.status === 'offline' || s.status === 'pending';
  const n = lookCount(detail);
  const u = detail.unraid;
  let badge = statusText(s.status, offline ? null : s.statusNote);
  let tone = serverTone(s.status);
  // The condition word its Overview card and the Inbox say (“Disk array failed”); a count only when there is none.
  if (!offline && n > 0 && s.status !== 'ok' && !s.statusNote?.trim()) badge = `${n} to look at`;
  else if (!offline && u && s.status === 'ok') {
    const a = unraidArrayView(u.array);
    badge = `Array ${a.stateText.toLowerCase().replace(/…$/, '')}`;
    tone = a.tone;
  }
  const details: ServerDetailRow[] = [];
  const row = (label: string, value: string | null | undefined, mono = false) => {
    if (value) details.push({ label, value: cut(value, 200), ...(mono ? { mono } : {}) });
  };
  if (kind === 'unraid' && u) row('System', `Unraid ${u.version}`);
  else if (kind === 'macos' && detail.macos?.version) row('System', macSystemLine(detail.macos));
  else if (s.os) row('System', `${s.os.name.replace(/^Debian GNU\/Linux/, 'Debian')} ${s.os.version}`);
  if (kind === 'incus' && detail.incus) row('Platform', `Incus ${detail.incus.version}`);
  if (kind === 'libvirt') row('Platform', LIBVIRT_KIND_WORD);
  if (kind === 'docker') row('Platform', 'Docker');
  row('Kernel', s.os?.kernel, true);
  if (s.cpu)
    row('Processor', `${s.cpu.model}, ${plural(s.cpu.cores, 'core')} / ${plural(s.cpu.threads, 'thread')}`);
  if (s.memory) row('Memory', `${sizeWords(s.memory.totalGb)}${s.memory.type ? ` ${s.memory.type}` : ''}`);
  if (s.uptimeS != null && !offline) row('Up', formatDuration(s.uptimeS));
  row('Address', s.address, true);
  const ago = s.agent.lastSyncSAgo;
  row(
    'Whombat’s helper',
    [
      ago == null ? null : `${offline ? 'Last checked in' : 'Checked in'} ${formatAgo(ago)}`,
      s.agent.version ? `version ${s.agent.version}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  row('What Whombat may do', HOST_CONTROL_LEVEL_WORDS[serverControlLevel(s.remoteControl)].title);
  if (!offline) row('Figures', SERVER_DASHBOARD_LIVE_WORDS.replace(' · ', ', '));
  const name = opts.name ?? s.name ?? s.id;
  const idLine = name.toLowerCase() === s.id.toLowerCase() ? null : s.id;
  return { kind, name, idLine, status: s.status, tone, badge, details };
}

/* The Summary ----------------------------------------------------------------------------------------------- */

export interface ServerDashboardInput {
  detail: HostServerDetail;
  /** `hosts.serverMetrics` for `range` and `serverDashboardSeries`; null or absent while it loads. */
  series?: HostSeries | null;
  /** The busiest guests' own history (`hosts.guestMetrics`, `cpu_pct`), by guest id (`dashboardGuests`). */
  guests?: Readonly<Record<string, HostSeries | null | undefined>> | null;
  /**
   * The volumes' last 30 days (`hosts.serverMetrics` with `range: 30d` and `serverDashboardVolumeSeries`) for the
   * storage forecasts; without it the range's points are used (a day or more of them).
   */
  volumes?: HostSeries | null;
  range: HostSeriesRange;
  /** The person's time zone (times in words). */
  timeZone?: string;
  /** Now in ms; default the detail's `asOf`. */
  now?: number;
  /**
   * Where the waiting-updates hint's way out goes when Whombat installs updates (`hosts.package_updates`; Whombat
   * server-updates.md SWU-13): the web's System tab or the phone's Updates screen. Without it the hint opens System.
   */
  updates?: 'web' | 'phone' | null;
  /**
   * May the viewer quiet the server's lines (Whombat quiet-notices.md QN-10, QN-23; AP-4810): the runtime has
   * `things.quiet` and `things.watch` says `mayChange`. Its lines then get Ignore's words, so the ⋯ menu shows.
   */
  quiet?: boolean;
  /** The server's name in the verdict (the fleet's); absent: its id. */
  name?: string;
  /** The assistant's name: a problem's button asks it by name (“Ask Neo”). */
  assistant?: string;
}

interface Ctx {
  d: HostServerDetail;
  kind: ServerDashboardKind;
  serverId: string;
  range: HostSeriesRange;
  tz: string | undefined;
  now: number;
  /** The history, once read. */
  series: HostSeries | null;
  volumes: HostSeries | null;
  guestSeries: Readonly<Record<string, HostSeries | null | undefined>>;
  tabs: readonly string[];
  /** Every guest, temporary machines included (what the server's memory and network carry). */
  guests: HostGuest[];
  /** Its own machines and apps: the temporary ones (CI jobs, sandboxes) left out of lists and counts. */
  kept: HostGuest[];
  offline: boolean;
  /** The ask button's words. */
  ask: string;
  updates: 'web' | 'phone' | null;
  /** What the lines' quiet parts need (AP-4810). */
  lines: ServerNoticeOptions;
}

/** A server's Summary, its Technical details and its verdict, built once from the same lines. */
export interface ServerDashboardView {
  /** The Summary's panels, in the order a phone stacks them. */
  panels: ThingPagePanel[];
  /** What only someone who runs it needs (its storage and pools, the platform's own facts, the cluster), folded. */
  details: ThingPagePanel[];
  /** The sentence at the top: is it all right, and does it need the person (Worth a look's lines). */
  verdict: Verdict;
}

function context(input: ServerDashboardInput): Ctx {
  const d = input.detail;
  const kind = serverDashboardKind(d);
  const guests = detailGuests(d);
  return {
    d,
    kind,
    serverId: d.server.id,
    range: input.range,
    tz: input.timeZone,
    now: input.now ?? Date.parse(d.asOf),
    series: input.series ?? null,
    volumes: input.volumes ?? null,
    guestSeries: input.guests ?? {},
    tabs: serverDashboardTabs(kind),
    guests,
    kept: splitTemporary(guests).kept,
    offline: d.server.status === 'offline' || d.server.status === 'pending',
    updates: input.updates ?? null,
    ask: input.assistant?.trim() ? cut(`Ask ${input.assistant.trim()}`, 30) : 'Ask about it',
    lines: serverNoticeOptions(d, guests, {
      quiet: !!input.quiet,
      now: input.now ?? Date.parse(d.asOf),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    }),
  };
}

/**
 * A server's Summary (DS-09) as panels with their places, in the order a phone stacks them: the banner (only while
 * something is wrong right now), the figures in words, Worth a look when it has something, the chart cards, the main
 * column (Unraid's array, the busiest machines or apps), the side column (Proxmox's backups, Unraid's VMs). Its storage,
 * pools, the platform's own facts and the cluster are Technical details (`details`), folded under it. While the history
 * loads the chart cards are there without lines, so nothing moves when it comes; once read, a chart without any point
 * (no disks with I/O, no sensors) is left out and the row closes up.
 */
export function serverDashboardView(input: ServerDashboardInput): ServerDashboardView {
  const c = context(input);
  const { d, kind } = c;
  const out: Panel[] = [];
  const banner = bannerPanel(c);
  if (banner) out.push(banner.panel);
  const figures = figuresPanel(c);
  const charts = chartPanels(c);
  out.push(openFrom(c, figures, charts));
  const look = lookPanel(c, banner?.alertId ?? null);
  if (look.items.length) out.push(look);
  out.push(...charts);

  const main: Panel[] = [];
  const side: Panel[] = [];
  const details: Panel[] = [];
  if (kind === 'unraid' && d.unraid) main.push(arrayPanel(c, d.unraid));
  const busy = guestsPanel(c);
  if (busy) main.push(busy);
  if (!look.items.length) side.push(look);
  if (kind === 'proxmox') {
    const b = backupsPanel(c);
    if (b) side.push(b);
  }
  if (kind === 'unraid') {
    const vms = vmsPanel(c);
    if (vms) side.push(vms);
  }
  const storage = storagePanel(c, true);
  if (storage) details.push(storage);
  const pools = poolsPanel(c);
  if (pools) details.push(pools);
  const facts = kindFactsPanel(c);
  if (facts) details.push(facts);
  const cluster = kind === 'proxmox' ? clusterPanel(c) : null;
  if (cluster) details.push(cluster);
  const lines = [...(banner?.panel.kind === 'notices' ? banner.panel.items : []), ...look.items];
  const verdict = verdictOf(c, input.name, lines);
  // Technical details stack in one column, each card as wide as the fold.
  return {
    panels: [...out, ...main, ...side],
    details: details.map((p) => ({ ...p, place: 'main' as const })),
    verdict,
  };
}

/**
 * The verdict alone, for a page's head on any tab (no history needed): from the banner and Worth a look's lines, as
 * the Summary's.
 */
export function serverPageVerdict(
  detail: HostServerDetail,
  opts: { name?: string; now?: number } = {},
): Verdict {
  const c = context({
    detail,
    range: SERVER_DASHBOARD_DEFAULT_RANGE,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const banner = bannerPanel(c);
  const look = lookPanel(c, banner?.alertId ?? null);
  return verdictOf(c, opts.name, [
    ...(banner?.panel.kind === 'notices' ? banner.panel.items : []),
    ...look.items,
  ]);
}

function verdictOf(c: Ctx, name: string | undefined, lines: ThingPageNotice[]): Verdict {
  const s = c.d.server;
  return serverVerdict({
    name: name ?? s.name ?? s.id,
    status: s.status,
    statusNote: s.statusNote ?? null,
    lines,
    running: runningCounts(c),
    lastHeard: s.agent.lastSyncSAgo == null ? null : formatAgo(s.agent.lastSyncSAgo),
  });
}

/** A server's Summary panels (`serverDashboardView` without its details and verdict). */
export function serverDashboard(input: ServerDashboardInput): ThingPagePanel[] {
  return serverDashboardView(input).panels;
}

type Workload = { running: number; total: number; guests?: readonly HostGuest[] } | null | undefined;

/**
 * What runs on it in the verdict: Docker containers as apps, every other guest as a machine, the temporary ones left
 * out. The hub's counts are read where its lists are shorter than them.
 */
function runningCounts(c: Ctx): RunningCounts {
  const on = (g: HostGuest) => g.state === 'running' || g.state === 'unhealthy';
  const temporary = splitTemporary(c.guests).temporary;
  const tally = (workloads: Workload[], listed: (g: HostGuest) => boolean) => {
    const list = c.guests.filter(listed);
    const hub = { running: 0, total: 0 };
    for (const w of workloads) {
      if (!w) continue;
      hub.running += w.running;
      hub.total += w.total;
    }
    const temp = temporary.filter(listed);
    if (hub.total > list.length)
      return {
        running: Math.max(0, hub.running - temp.filter(on).length),
        total: Math.max(0, hub.total - temp.length),
      };
    const kept = list.filter((g) => !temp.includes(g));
    return { running: kept.filter(on).length, total: kept.length };
  };
  const p = c.d.proxmox?.guests;
  const w = c.d.workloads;
  return {
    apps: tally([w?.docker], (g) => g.platform === 'docker'),
    machines: tally([p?.vm, p?.container, w?.incus, w?.libvirt], (g) => g.platform !== 'docker'),
  };
}

/* Values ---------------------------------------------------------------------------------------------------- */

function vals(c: Ctx, key: string): (number | null)[] {
  return (c.series?.series[key] ?? []).slice(-600);
}

function hasData(c: Ctx, key: string): boolean {
  return vals(c, key).some((v) => v != null && Number.isFinite(v));
}

/** A small line: at most 120 points, one decimal. */
function spark(values: SeriesValues | undefined): (number | null)[] {
  return (values ?? [])
    .slice(-120)
    .map((v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10));
}

/** A share for a meter or bar, 0…1 with three decimals. */
function clamp01(v: number): number {
  return Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
}

function tone(t: HostTone | null | undefined): ThingTone | undefined {
  return t === 'warn' || t === 'bad' ? t : undefined;
}

/** CPU: amber from 80 %, red from 95 % (the phone's tiles). */
function cpuTone(p: number | null | undefined): ThingTone | undefined {
  return p == null ? undefined : p >= 95 ? 'bad' : p >= 80 ? 'warn' : undefined;
}

/** Memory: amber from 85 %, red from 95 %. */
function memTone(p: number | null | undefined): ThingTone | undefined {
  return p == null ? undefined : p >= 95 ? 'bad' : p >= 85 ? 'warn' : undefined;
}

function sensorTone(s: Pick<HostSensor, 'nowC' | 'limitC'>): ThingTone | undefined {
  const l = sensorLevel(s.nowC, s.limitC);
  return l === 'serious' ? 'bad' : l === 'warning' ? 'warn' : undefined;
}

/** A panel's key from any id (`cpu_package` stays, `Disk.1` → `disk_1`). */
function key(s: string): string {
  const k = s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[^a-z]+/, '');
  return (k || 'x').slice(0, 40);
}

/** A tab's way there in the word list's words: “See …”, never “Open System”. */
const SEE_TAB: Record<string, string> = {
  system: 'See details',
  sensors: 'See temperatures',
  array: 'See disks',
  guests: 'See them',
  screen: 'See the screen',
};

function tabLink(c: Ctx, tab: string, label?: string): ThingPageLink | undefined {
  const t = c.kind === 'unraid' && (tab === 'storage' || tab === 'disks') ? 'array' : tab;
  if (!c.tabs.includes(t) || t === 'summary') return undefined;
  const words = label ?? SEE_TAB[t] ?? `See ${tabWord(c.kind, t).toLowerCase()}`;
  return { kind: 'tab', label: cut(words, 30), tab: t };
}

/** A problem's button: it asks the assistant by name, with the line's question ready to send. */
function askLink(c: Ctx, title: string): ThingPageLink {
  return {
    kind: 'ask',
    label: c.ask,
    question: cut(`${title.replace(/[.!]+$/, '')}. Can you look into it?`, 300),
  };
}

/** A link's words, or shorter ones when a guest's name makes them too long for a button. */
function label(words: string, short: string): string {
  return words.length <= 30 ? words : short;
}

/* The banner (DS-01) ---------------------------------------------------------------------------------------- */

/**
 * The hub's banner: what is wrong right now, as a notice across the page. It is about one alert (its id since 0.122,
 * CT-1068; an older hub's matched by title, then severity and section) and carries that alert's check, kind and
 * Ignore, so its ⋯ menu quiets the alert; a quiet alert has no banner (QN-14: it is greyed in Worth a look instead).
 */
function bannerPanel(c: Ctx): { panel: Panel; alertId: string | null } | null {
  const b = c.d.banner;
  if (!b) return null;
  const open = (c.d.alerts ?? []).filter((a) => a.state === 'open');
  const alert =
    (b.alertId ? open.find((a) => a.id === b.alertId) : undefined) ??
    open.find((a) => a.title === b.title) ??
    open.find((a) => a.severity === b.severity && (a.section ?? null) === (b.section ?? null)) ??
    null;
  const parts = alert ? alertNoticeParts(alert, c.lines) : null;
  if (parts?.quiet) return null;
  const tone = b.severity === 'critical' ? 'bad' : 'warn';
  const link = alertLink(c, parts?.nature ?? 'problem', b.title, b.section);
  const item: ThingPageNotice = {
    id: 'banner',
    tone,
    icon: noticeIcon(alert?.rule ?? b.rule ?? '', b.section, tone),
    title: cut(b.title, 120),
    ...(b.detail ? { detail: cut(b.detail, 200) } : {}),
    ...(link ? { link } : {}),
    ...(parts ?? {}),
  };
  return {
    panel: { kind: 'notices', id: 'banner', place: 'top', title: 'Right now', items: [item] },
    alertId: alert?.id ?? null,
  };
}

/**
 * An alert's link by its kind (QN-02, QN-S49): a problem asks the assistant (“Look into it”); an only-you line or a
 * heads-up leads to its tab where there is one, and never asks.
 */
function alertLink(
  c: Ctx,
  nature: ThingPageNotice['nature'],
  title: string,
  section: string | null | undefined,
): ThingPageLink | undefined {
  if (nature === 'problem') return askLink(c, title);
  const tab = (section ?? '').replace(/^#/, '');
  return (tab && tabLink(c, tab)) || undefined;
}

/* Figures in words (DS-07) ------------------------------------------------------------------------------------ */

/**
 * At most four tiles in words (“Processor · Quiet”, “Memory · Plenty free”, “Storage · Filling up”, “Temperature ·
 * 71 °C”), each with one plain line of its figures under it and a meter of segments, the same words as the server's
 * card on Overview (`serverTiles`). Temperature is always its figure, so it can't contradict the status pill; a server
 * that isn't working shows the bare figures, never a reassuring word. A tile is amber at most: red is only for what
 * isn't working. The raw figures are the charts each tile opens; what runs on it is the verdict's.
 */
function figuresPanel(c: Ctx): Extract<Panel, { kind: 'kpis' }> {
  const items: ThingPageKpi[] = [processorTile(c), memoryTile(c)];
  const space = c.kind === 'unraid' && c.d.unraid ? arrayTile(c.d.unraid, inWords(c)) : spaceTile(c);
  if (space) items.push(space);
  const temp = temperatureTile(c);
  if (temp) items.push(temp);
  return {
    kind: 'kpis',
    id: 'figures',
    place: 'top',
    items: items.map((k) => (k.tone === 'bad' ? { ...k, tone: 'warn' } : k)),
  };
}

/** Whether the figures say how it is in words: not while the server isn't working (`tilesInWords`). */
function inWords(c: Ctx): boolean {
  return c.d.server.status !== 'bad';
}

/**
 * Which charts a tile opens, first come first served (Whombat connections-page.md CN-05, contracts 0.94 CT-449): the
 * chart cards are drawn only inside the tiles' card, one tile at a time. The processor opens the network's and the
 * disks' traffic beside its own; temperature the sensors' (Unraid's disks'). Space leads to its tab (Storage, Array).
 */
const FIGURE_CHARTS: Record<string, readonly string[]> = {
  cpu: ['cpu', 'network', 'disk_io'],
  memory: ['memory'],
  hottest: ['temperatures', 'disk_temperatures'],
};

const FIGURE_TABS: Record<string, string> = {
  storage: 'storage',
};

function openFrom(c: Ctx, figures: Extract<Panel, { kind: 'kpis' }>, charts: readonly Panel[]): Panel {
  const left = new Set(charts.map((p) => p.id));
  const items = figures.items.map((k): ThingPageKpi => {
    const ids = (FIGURE_CHARTS[k.key] ?? []).filter((id) => left.has(id));
    for (const id of ids) left.delete(id);
    if (ids.length) return { ...k, charts: ids.slice(0, 3) };
    const tab = FIGURE_TABS[k.key];
    const link = tab ? tabLink(c, tab, `See ${k.label.toLowerCase()}`) : undefined;
    return link ? { ...k, link } : k;
  });
  return { ...figures, items };
}

function processorTile(c: Ctx): ThingPageKpi {
  const live = c.offline ? null : c.d.live;
  const p = live?.cpuPct ?? null;
  const t = cpuTone(p);
  const words = inWords(c);
  return {
    key: 'cpu',
    label: 'Processor',
    value: p == null ? DASH : words ? processorWords(p) : formatPct(p),
    ...(p != null && words ? { sub: `${formatPct(p)} in use` } : {}),
    ...(t ? { tone: t } : {}),
    ...(p != null ? { meter: clamp01(p / 100) } : {}),
    spark: spark(vals(c, 'cpu_pct')),
    color: 'blue',
  };
}

function memoryTile(c: Ctx): ThingPageKpi {
  const live = c.offline ? null : c.d.live;
  const total = c.d.server.memory?.totalGb ?? null;
  const used = live?.memUsedGb ?? null;
  const pct = live?.memPct ?? (used != null && total ? (used / total) * 100 : null);
  const t = memTone(pct);
  const free = used != null && total != null ? Math.max(0, total - used) : null;
  const words = inWords(c);
  const inUse =
    used != null && total != null
      ? `${sizePair(used, total)} in use${pct != null && words ? ` (${formatPct(pct)})` : ''}`
      : null;
  const sub = [words && free != null ? `${sizeWords(free)} free` : null, inUse].filter(Boolean).join(' · ');
  return {
    key: 'memory',
    label: 'Memory',
    value: pct == null ? DASH : words ? memoryFullWords(pct) : formatPct(pct),
    ...(sub ? { sub } : {}),
    ...(t ? { tone: t } : {}),
    ...(pct != null ? { meter: clamp01(pct / 100) } : {}),
    spark: spark(vals(c, 'mem_pct')),
    color: 'violet',
  };
}

function spaceTile(c: Ctx): ThingPageKpi | null {
  const st = storageTotals(c.d);
  if (!st?.totalGb) return null;
  const pct = (st.usedGb / st.totalGb) * 100;
  const soon = soonestForecast(c);
  const t = tone(hostTone(diskUsedLevel(pct)));
  const words = inWords(c);
  return {
    key: 'storage',
    label: 'Storage',
    value: words ? spaceWords(pct) : formatPct(pct),
    sub: cut(
      words
        ? `${soon ?? `${formatPct(100 - pct)} free`} · ${formatPct(pct)} in use`
        : sizePair(st.usedGb, st.totalGb),
      80,
    ),
    ...(t ? { tone: t } : {}),
    meter: clamp01(pct / 100),
    color: 'blue',
  };
}

/** The soonest “Full …” of the volumes shown and Proxmox's storages, when one is filling up. */
function soonestForecast(c: Ctx): string | null {
  let best: { days: number; words: string } | null = null;
  const entities: [string, number | null | undefined][] = [
    ...(c.d.proxmox?.storages ?? [])
      .filter((s) => s.capacityGb > 0)
      .map((s): [string, null] => [`storage:${s.id}`, null]),
    ...shownVolumes(c.d).map((v): [string, number | null | undefined] => [v.entity, v.fullInDays]),
  ];
  for (const [entity, days] of entities) {
    const f = forecastOf(c, entity, days);
    if (f.fullInDays != null && f.words && (!best || f.fullInDays < best.days))
      best = { days: f.fullInDays, words: f.words };
  }
  return best?.words ?? null;
}

/** Unraid's space is its array's, with what is wrong with it first (stopped, parity missing or broken). */
function arrayTile(u: HostUnraidDetail, words: boolean): ThingPageKpi {
  const a = u.array;
  const view = unraidArrayView(a);
  const total = a.sizeBytes / 1e9;
  const used = a.usedBytes / 1e9;
  const pct = total ? (used / total) * 100 : null;
  const parity = parityState(a);
  const bad = view.tone === 'bad' || parity === 'broken';
  const t: ThingTone | undefined = bad
    ? 'bad'
    : view.tone === 'warn' || parity === 'none'
      ? 'warn'
      : tone(hostTone(diskUsedLevel(pct)));
  const sub =
    a.state !== 'started'
      ? view.stateText
      : parity === 'broken'
        ? 'Parity isn’t valid'
        : parity === 'none'
          ? 'No parity disk'
          : pct != null
            ? `${formatPct(100 - pct)} free`
            : null;
  // Space that nothing protects isn't “plenty free”: the tile says what is wrong first.
  const value =
    a.state !== 'started'
      ? 'Stopped'
      : bad
        ? 'At risk'
        : parity === 'none'
          ? 'Not protected'
          : pct != null
            ? words
              ? spaceWords(pct)
              : formatPct(pct)
            : DASH;
  return {
    key: 'storage',
    label: 'Storage',
    value,
    ...(sub ? { sub: cut(sub, 80) } : {}),
    ...(t ? { tone: t } : {}),
    ...(pct != null ? { meter: clamp01(pct / 100) } : {}),
    color: 'blue',
  };
}

function temperatureTile(c: Ctx): ThingPageKpi | null {
  const hot = hottestSensor(c.d);
  if (!hot) return null;
  const level = c.offline ? null : sensorLevel(hot.nowC, hot.limitC);
  const t = c.offline ? undefined : sensorTone(hot);
  return {
    key: 'hottest',
    label: 'Temperature',
    value: level == null ? DASH : formatTemp(hot.nowC),
    ...(level != null ? { sub: cut(hot.label, 80) } : {}),
    ...(t ? { tone: t } : {}),
    ...(level != null && hot.nowC != null && hot.limitC ? { meter: clamp01(hot.nowC / hot.limitC) } : {}),
    spark: spark(vals(c, tempKey(hot))),
    color: 'amber',
  };
}

/** “NVMe”, “SSD”, “HDD”: what a pool's disks are. */
function mediaWord(disks: readonly HostUnraidDisk[]): string {
  if (disks.length && disks.every((d) => (d.device ?? '').startsWith('nvme'))) return 'NVMe';
  if (disks.length && disks.every((d) => d.rotational === false)) return 'SSD';
  if (disks.length && disks.every((d) => d.rotational === true)) return 'HDD';
  return '';
}

/** “NVMe mirror”, “SSD pool”, “btrfs pool”. */
function poolNote(p: HostUnraidDetail['pools'][number]): string {
  const media = mediaWord(p.disks);
  const layout = p.profile && p.profile !== 'single' ? p.profile.replace(/^raid1$/, 'mirror') : 'pool';
  return [media || p.fsType.replace(/^luks:/, ''), layout].filter(Boolean).join(' ');
}

/* Chart cards (DS-06) --------------------------------------------------------------------------------------- */

function chartBase(c: Ctx, id: string, title: string, span: 1 | 2 | 3): Omit<ChartPanel, 'series'> {
  return {
    kind: 'chart',
    id,
    place: 'chart',
    span,
    title,
    timestamps: (c.series?.timestamps ?? []).slice(-600),
  };
}

/** “Avg **14 %**” and “Peak **63 %** Sun 03:10” over the range (DS-06, DS-15). */
function avgPeak(c: Ctx, k: string, unit: string, peakWord = 'Peak'): ThingLine[] {
  const st = seriesStats(vals(c, k), c.series?.timestamps, {
    timeZone: c.tz,
    now: c.now,
    summary: c.series?.summary?.[k] ?? null,
  });
  if (st.avg == null || st.peak == null) return [];
  return [
    [{ text: 'Avg ' }, { text: withUnit(st.avg, unit), strong: true }],
    [
      { text: `${peakWord} ` },
      { text: withUnit(st.peak, unit), strong: true },
      ...(st.peakWhen ? [{ text: ` ${st.peakWhen}` }] : []),
    ],
  ];
}

function line(
  c: Ctx,
  k: string,
  o: Omit<ChartSeries, 'key' | 'values'> & { seriesKey?: string },
): ChartSeries {
  const { seriesKey, ...rest } = o;
  const values = vals(c, seriesKey ?? k);
  return { key: key(k), values, ...rest };
}

function chartPanels(c: Ctx): Panel[] {
  const loaded = c.series != null;
  const keep = (k: string) => !loaded || hasData(c, k);
  const cpu = (span: 1 | 2 | 3) => cpuChart(c, span);
  const mem = (span: 1 | 2 | 3) => memoryChart(c, span);
  const temps = c.kind === 'unraid' ? diskTempChart(c) : null;
  const tempCard = temps ?? tempChart(c, chartSensors(c, c.d.sensors), 'Temperatures');
  const net = keep('net_rx_mbps') || keep('net_tx_mbps');
  const disk = keep('disk_read_mbs') || keep('disk_write_mbs');
  if (c.kind === 'unraid') {
    // The mock's one row: CPU · Memory · Disk temperatures (else Network).
    if (tempCard) return [cpu(1), mem(1), tempCard];
    return net ? [cpu(1), mem(1), networkChart(c, 1)] : [cpu(1), mem(2)];
  }
  const row1: Panel[] = [cpu(1), mem(1)];
  const row2: Panel[] = [];
  if (tempCard) {
    row1.push(tempCard);
    if (net && disk) row2.push(networkChart(c, 2), diskChart(c, 1));
    else if (net) row2.push(networkChart(c, 3));
    else if (disk) row2.push(diskChart(c, 3));
  } else if (net) {
    row1.push(networkChart(c, 1));
    if (disk) row2.push(diskChart(c, 3));
  } else if (disk) row1.push(diskChart(c, 1));
  else row1.splice(1, 1, mem(2));
  return [...row1, ...row2];
}

function cpuChart(c: Ctx, span: 1 | 2 | 3): ChartPanel {
  const live = c.offline ? null : c.d.live;
  const threads = c.d.server.cpu?.threads;
  const values = vals(c, 'cpu_pct');
  const foot: NonNullable<ChartPanel['foot']> = [];
  if (live?.cpuUserPct != null) foot.push({ label: 'User', value: formatPct1(live.cpuUserPct) });
  if (live?.cpuSystemPct != null) foot.push({ label: 'System', value: formatPct1(live.cpuSystemPct) });
  if (live?.cpuIowaitPct != null) foot.push({ label: 'I/O wait', value: formatPct1(live.cpuIowaitPct) });
  const load = live?.loadAvg?.[0] ?? lastValue(vals(c, 'load1'));
  if (load != null) foot.push({ label: 'Load', value: dashboardNumber(load) });
  const t = cpuTone(live?.cpuPct);
  const stats = avgPeak(c, 'cpu_pct', '%');
  return {
    ...chartBase(c, 'cpu', 'CPU', span),
    series: [
      line(c, 'cpu_pct', {
        label: 'CPU',
        unit: '%',
        color: 'blue',
        fill: true,
        latest: formatPct(lastValue(values) ?? live?.cpuPct),
      }),
    ],
    figure: {
      value: formatPct(live?.cpuPct ?? lastValue(values)),
      ...(threads ? { rest: `of ${plural(threads, 'thread')}` } : {}),
      ...(t ? { tone: t } : {}),
    },
    ...(stats.length ? { stats } : {}),
    ...(foot.length ? { foot: foot.slice(0, 4) } : {}),
    axis: { min: 0, max: 100, unit: '%' },
  };
}

function memoryChart(c: Ctx, span: 1 | 2 | 3): ChartPanel {
  const live = c.offline ? null : c.d.live;
  const total = c.d.server.memory?.totalGb ?? null;
  const values = vals(c, 'mem_pct');
  const foot: NonNullable<ChartPanel['foot']> = [];
  const running = c.guests.filter(
    (g) => (g.state === 'running' || g.state === 'unhealthy') && g.memoryUsedMb,
  );
  if (running.length)
    foot.push({
      label: 'Guests',
      value: sizeWords(running.reduce((a, g) => a + (g.memoryUsedMb ?? 0), 0) / 1024),
    });
  else if (live?.memUsedGb != null) foot.push({ label: 'Used', value: sizeWords(live.memUsedGb) });
  if (live?.zfsArcGb) foot.push({ label: 'ZFS ARC', value: sizeWords(live.zfsArcGb) });
  else if (live?.memCacheGb) foot.push({ label: 'Cache', value: sizeWords(live.memCacheGb) });
  if (live?.memFreeGb != null) foot.push({ label: 'Free', value: sizeWords(live.memFreeGb) });
  if (live?.swapTotalGb)
    foot.push({
      label: 'Swap',
      value: sizePair(live.swapUsedGb ?? 0, live.swapTotalGb, '/'),
      ...((live.swapUsedGb ?? 0) / live.swapTotalGb >= 0.5 ? { tone: 'warn' as const } : {}),
    });
  const t = memTone(live?.memPct);
  const stats = avgPeak(c, 'mem_pct', '%');
  return {
    ...chartBase(c, 'memory', 'Memory', span),
    series: [
      line(c, 'mem_pct', {
        label: 'Memory',
        unit: '%',
        color: 'violet',
        fill: true,
        latest: formatPct(lastValue(values) ?? live?.memPct),
      }),
    ],
    figure: {
      value: formatPct(live?.memPct ?? lastValue(values)),
      ...(live?.memUsedGb != null && total != null
        ? { rest: `${sizePair(live.memUsedGb, total)}` }
        : total != null
          ? { rest: `of ${sizeWords(total)}` }
          : {}),
      ...(t ? { tone: t } : {}),
    },
    ...(stats.length ? { stats } : {}),
    ...(foot.length ? { foot: foot.slice(0, 4) } : {}),
    axis: { min: 0, max: 100, unit: '%' },
  };
}

/** The sensors a temperature card draws: hottest first, up to four, with points once the history is read. */
function chartSensors(c: Ctx, sensors: readonly HostSensor[]): HostSensor[] {
  return [...sensors]
    .filter((s) => c.series == null || hasData(c, tempKey(s)))
    .sort((a, b) => (b.nowC ?? -1) - (a.nowC ?? -1))
    .slice(0, 4);
}

const TEMP_COLORS = ['amber', 'blue', 'green', 'violet'] as const;

/** Temperatures (DS-06): amber for the hottest, then blue, green, violet; a dashed line at its limit. */
function tempChart(
  c: Ctx,
  sensors: readonly HostSensor[],
  title: string,
  id = 'temperatures',
): ChartPanel | null {
  const hot = sensors[0];
  if (!hot) return null;
  const limit = hot.limitC ?? 85;
  const all = sensors.flatMap((s) => vals(c, tempKey(s)));
  const scale = tempScale(all, limit);
  const t = c.offline ? undefined : sensorTone(hot);
  const stats = avgPeak(c, tempKey(hot), '°C');
  return {
    ...chartBase(c, id, title, 1),
    series: sensors.map((s, i) =>
      line(c, tempKey(s), {
        label: cut(s.label, 40),
        unit: '°C',
        color: TEMP_COLORS[i] ?? 'grey',
        latest: formatTemp(lastValue(vals(c, tempKey(s))) ?? s.nowC),
      }),
    ),
    figure: {
      value: c.offline ? DASH : formatTemp(hot.nowC),
      rest: cut(hot.label, 60),
      ...(t ? { tone: t } : {}),
    },
    ...(stats.length ? { stats } : {}),
    foot: sensors.slice(0, 3).map((s) => {
      const st = c.offline ? undefined : sensorTone(s);
      return {
        label: cut(s.label, 30),
        value:
          s.limitC != null
            ? `${s.nowC == null ? DASH : Math.round(s.nowC)} / ${formatTemp(s.limitC)}`
            : formatTemp(s.nowC),
        ...(st ? { tone: st } : {}),
      };
    }),
    line: { value: limit, label: `${formatTemp(limit)} limit` },
    axis: { min: scale.min, max: scale.max, unit: '°' },
  };
}

const DISK_SENSOR_GROUPS = new Set(['hdd', 'ssd', 'nvme', 'disk']);

/** Unraid's Disk temperatures (the mock): the disks' sensors, the hottest disk now, how many are spun down. */
function diskTempChart(c: Ctx): ChartPanel | null {
  const u = c.d.unraid;
  const sensors = chartSensors(
    c,
    c.d.sensors.filter(
      (s) => DISK_SENSOR_GROUPS.has(s.group ?? '') || /^(hdd|ssd|nvme|disk)/i.test(`${s.id} ${s.label}`),
    ),
  );
  const chart = tempChart(c, sensors, 'Disk temperatures', 'disk_temperatures');
  if (!chart || !u) return chart;
  const disks = [...u.array.disks, ...u.pools.flatMap((p) => p.disks)].filter(
    (d) => d.device && d.status !== 'empty',
  );
  const hot = [...disks].filter((d) => d.tempC != null).sort((a, b) => (b.tempC ?? 0) - (a.tempC ?? 0))[0];
  const spun = disks.filter((d) => d.spunDown).length;
  const limit = disks.some((d) => d.rotational !== false) ? 55 : 70;
  const t = hot ? tone(unraidTempTone(hot)) : undefined;
  const { foot: _foot, ...rest } = chart;
  return {
    ...rest,
    ...(hot
      ? {
          figure: {
            value: formatTemp(hot.tempC),
            rest: `hottest, ${unraidDiskName(hot.name).toLowerCase()}`,
            ...(t ? { tone: t } : {}),
          },
        }
      : {}),
    stats: [
      [{ text: 'Limit ' }, { text: formatTemp(limit), strong: true }],
      ...(spun ? [[{ text: `${plural(spun, 'disk')} spun down` }]] : []),
    ],
    line: { value: limit, label: `${formatTemp(limit)} limit` },
  };
}

function networkChart(c: Ctx, span: 1 | 2 | 3): ChartPanel {
  const rx = vals(c, 'net_rx_mbps');
  const tx = vals(c, 'net_tx_mbps');
  const st = seriesStats(rx, c.series?.timestamps, {
    timeZone: c.tz,
    now: c.now,
    summary: c.series?.summary?.net_rx_mbps ?? null,
  });
  const step = c.series?.stepSeconds ?? 0;
  const inGb = movedGb(rx, step);
  const outGb = movedGb(tx, step);
  const stats: ThingLine[] = [];
  if (st.peak != null)
    stats.push([
      { text: 'Peak in ' },
      { text: rateWords(st.peak), strong: true },
      ...(st.peakWhen ? [{ text: ` ${st.peakWhen}` }] : []),
    ]);
  if (inGb != null || outGb != null)
    stats.push([
      { text: 'Total ' },
      { text: sizeWords(inGb ?? 0), strong: true },
      { text: ' in · ' },
      { text: sizeWords(outGb ?? 0), strong: true },
      { text: ' out' },
    ]);
  return {
    ...chartBase(c, 'network', 'Network', span),
    series: [
      line(c, 'net_rx_mbps', { label: 'In', unit: 'Mb/s', color: 'green', latest: rateWords(lastValue(rx)) }),
      line(c, 'net_tx_mbps', {
        label: 'Out',
        unit: 'Mb/s',
        color: 'orange',
        latest: rateWords(lastValue(tx)),
      }),
    ],
    ...(stats.length ? { stats } : {}),
    axis: { min: 0 },
  };
}

function diskChart(c: Ctx, span: 1 | 2 | 3): ChartPanel {
  const rd = vals(c, 'disk_read_mbs');
  const wr = vals(c, 'disk_write_mbs');
  const opts = (k: string) => ({ timeZone: c.tz, now: c.now, summary: c.series?.summary?.[k] ?? null });
  const r = seriesStats(rd, c.series?.timestamps, opts('disk_read_mbs'));
  const w = seriesStats(wr, c.series?.timestamps, opts('disk_write_mbs'));
  const top = (w.peak ?? -1) > (r.peak ?? -1) ? { ...w, word: 'write' } : { ...r, word: 'read' };
  const step = c.series?.stepSeconds ?? 0;
  const read = movedGb(rd, step, false);
  const written = movedGb(wr, step, false);
  const stats: ThingLine[] = [];
  if (top.peak != null)
    stats.push([
      { text: `Peak ${top.word} ` },
      { text: diskRateWords(top.peak), strong: true },
      ...(top.peakWhen ? [{ text: ` ${top.peakWhen}` }] : []),
    ]);
  if (read != null || written != null)
    stats.push([
      { text: 'Total ' },
      { text: sizeWords(read ?? 0), strong: true },
      { text: ' read · ' },
      { text: sizeWords(written ?? 0), strong: true },
      { text: ' written' },
    ]);
  return {
    ...chartBase(c, 'disk_io', 'Disk I/O', span),
    series: [
      line(c, 'disk_read_mbs', {
        label: 'Read',
        unit: 'MB/s',
        color: 'blue',
        latest: diskRateWords(lastValue(rd)),
      }),
      line(c, 'disk_write_mbs', {
        label: 'Write',
        unit: 'MB/s',
        color: 'violet',
        latest: diskRateWords(lastValue(wr)),
      }),
    ],
    ...(stats.length ? { stats } : {}),
    axis: { min: 0 },
  };
}

/* Worth a look (DS-05, DS-09) -------------------------------------------------------------------------------- */

/** A notice's icon from what it is about (a hint's kind, an alert's rule, a section). */
function noticeIcon(
  what: string,
  section: string | null | undefined,
  t: 'bad' | 'warn' | 'info',
): ThingNoticeIcon {
  const s = `${what} ${section ?? ''}`.toLowerCase();
  if (/backup/.test(s)) return 'backup';
  if (/snapshot/.test(s)) return 'clock';
  if (/update|plugin|outdated|upgrade/.test(s)) return 'update';
  if (/disk|storage|pool|array|parity|volume|smart|wear|zfs|raid|space|full|fs\b|filesystem|scrub/.test(s))
    return 'disk';
  if (/network|nic|link|interface|dns|ping/.test(s)) return 'network';
  if (/ups|battery/.test(s)) return 'battery';
  if (/power|reboot|restart/.test(s)) return 'power';
  if (/time|clock|ntp|chrony/.test(s)) return 'clock';
  if (/cert|tls|key/.test(s)) return 'key';
  if (/log|journal|service|unit/.test(s)) return 'log';
  if (/guest|container|vm\b|agent/.test(s)) return 'device';
  return t === 'info' ? 'info' : 'warn';
}

function fixLink(c: Ctx, f: HintFix | UnraidHintFix): ThingPageLink | undefined {
  const name = (id: string) => c.guests.find((g) => g.id === id)?.name ?? '';
  switch (f.kind) {
    case 'tab':
      // A fix that only opens a tab says where it goes in the page's words (“See storage”), not “Open Storage”.
      return tabLink(c, f.tab, /^Open /.test(f.label) ? undefined : f.label);
    case 'guest':
      return {
        kind: 'href',
        label: label(f.label, 'gtab' in f && f.gtab === 'snapshots' ? 'See snapshots' : 'See it'),
        href: serverGuestHref(c.serverId, f.guestId, 'gtab' in f ? f.gtab : undefined),
      };
    case 'backup':
      return {
        kind: 'href',
        label: label(f.label, 'Back it up'),
        href: serverGuestHref(c.serverId, f.guestId, 'backups'),
      };
    case 'update_container':
      return {
        kind: 'href',
        label: label(`Update ${name(f.guestId)}`, 'Update it'),
        href: serverGuestHref(c.serverId, f.guestId),
      };
    case 'start_array':
    case 'check_parity':
      return tabLink(c, 'array');
    case 'update_plugins':
      return tabLink(c, 'plugins');
    case 'archive':
      return tabLink(c, 'system');
    case 'link':
      return { kind: 'url', label: label(f.label, 'See it'), url: f.href };
  }
}

function hintLink(c: Ctx, h: HostHint): ThingPageLink | undefined {
  // Waiting updates install from the System tab, or the phone's Updates screen (SWU-13); Unraid has its own (SWU-01).
  // On the phone the restart hint opens Updates too, where Restart now is (AP-2887); the web's opens System as before.
  if (c.updates && c.kind !== 'unraid') {
    if (c.updates === 'web' && isUpdatesHint(h)) return tabLink(c, 'system', UPDATES_WORDS.wayOut.web);
    if (c.updates === 'phone' && (isUpdatesHint(h) || isRebootHint(h)))
      return { kind: 'href', label: UPDATES_WORDS.wayOut.phone, href: serverTabHref(c.serverId, 'updates') };
  }
  const fixes: (HintFix | UnraidHintFix)[] =
    c.kind === 'unraid'
      ? unraidHintFixes(h, {
          guests: c.guests,
          updateUrl: unraidPageUrl(c.d, 'Tools/Update'),
          canManage: false,
        })
      : hintFixes(h, c.guests);
  // Several machines: the tab that lists them all, where one machine's button would name (and open) the first only.
  const machines = fixes.filter((f) => f.kind === 'guest' || f.kind === 'backup');
  if (machines.length > 1) {
    const backups =
      h.kind === 'incus.no_snapshots' ||
      machines.some((f) => f.kind === 'backup' || ('gtab' in f && f.gtab === 'backups'));
    const all = (backups ? tabLink(c, 'backups', 'See them') : undefined) ?? tabLink(c, 'guests', 'See them');
    if (all) return all;
  }
  for (const f of fixes) {
    const link = fixLink(c, f);
    if (link) return link;
  }
  if (h.kind === 'unraid.notification') return tabLink(c, 'system');
  // A Mac's agent in an unsafe folder is answered on its System tab (where its install command is); its other own
  // lines (Screen Sharing, its password, Whombat Helper) on its Screen tab.
  if (c.kind === 'macos' && h.kind === 'macos.agent_folder') return tabLink(c, 'system');
  if (c.kind === 'macos' && h.kind.startsWith('macos.')) return tabLink(c, 'screen');
  // A hint about one guest (its id or name as the entity): that guest, on the tab that fixes it.
  const g = c.guests.find((x) => x.id === h.entity || x.name === h.entity);
  if (g) {
    const gtab = /backup/.test(h.kind) ? 'backups' : /snapshot/.test(h.kind) ? 'snapshots' : undefined;
    return {
      kind: 'href',
      label: label(gtab === 'backups' ? `Back up ${g.name}` : `See ${g.name}`, 'See it'),
      href: serverGuestHref(c.serverId, g.id, gtab),
    };
  }
  const section = (h.section ?? '').replace(/^#/, '');
  return (section && tabLink(c, section)) || undefined;
}

/**
 * Where a line goes in Worth a look (Whombat quiet-notices.md QN-14; AP-4811): what asks for a look by its tone (serious
 * first), then heads-ups, then the quiet lines greyed at the bottom.
 */
function lineRank(n: Pick<ThingPageNotice, 'quiet' | 'nature' | 'tone'>): number {
  if (n.quiet) return 4;
  if (n.nature === 'fyi') return 3;
  return n.tone === 'bad' ? 0 : n.tone === 'warn' ? 1 : 2;
}

/**
 * Alerts first (serious first), then hints (warnings first), each with its check, kind, item and Ignore (QN-01…QN-03,
 * QN-10); heads-ups after what asks for a look, quiet lines last; the banner's alert is not said twice. Links follow the
 * kind: only problems ask (QN-S49).
 */
function lookPanel(c: Ctx, bannerAlert: string | null): Extract<Panel, { kind: 'notices' }> {
  const items: ThingPageNotice[] = [];
  const alerts = (c.d.alerts ?? [])
    .filter((a) => a.state === 'open' && a.id !== bannerAlert)
    .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
  for (const a of alerts) {
    const t = a.severity === 'critical' ? 'bad' : 'warn';
    const parts = alertNoticeParts(a, c.lines);
    const link = parts.quiet ? undefined : alertLink(c, parts.nature, a.title, a.section);
    items.push({
      id: cut(`alert-${a.id}`, 120),
      tone: t,
      icon: noticeIcon(a.rule, a.section, t),
      title: cut(a.title, 120),
      ...(a.detail ? { detail: cut(a.detail, 200) } : {}),
      ...(link ? { link } : {}),
      ...parts,
    });
  }
  const hints = c.d.hints
    .filter((h) => h.serverId === c.serverId)
    .sort((a, b) => Number(b.severity === 'warning') - Number(a.severity === 'warning'));
  for (const h of hints) {
    const t = h.severity === 'warning' ? 'warn' : 'info';
    const parts = hintNoticeParts(h, c.lines);
    // A problem without a way to fix it asks the assistant with its own question (QN-S49).
    const link = parts.quiet
      ? undefined
      : (hintLink(c, h) ?? (parts.nature === 'problem' ? askLink(c, h.title) : undefined));
    items.push({
      id: cut(`hint-${h.kind}-${h.entity}`, 120),
      tone: t,
      icon: noticeIcon(h.kind, h.section, t),
      title: cut(h.title, 120),
      ...(h.detail ? { detail: cut(h.detail, 200) } : {}),
      ...(link ? { link } : {}),
      ...parts,
    });
  }
  // Unraid's notes the hints don't carry (its notices; the hub hints alerts and warnings): one line to System.
  const u = c.d.unraid;
  if (c.kind === 'unraid' && u) {
    const hinted = new Set(hints.filter((h) => h.kind === 'unraid.notification').map((h) => h.entity));
    const rest = u.notifications.filter((n) => !hinted.has(n.id));
    const newest = rest[0];
    if (newest) {
      const link = tabLink(c, 'system');
      items.push({
        id: 'unraid-notes',
        tone: 'info',
        icon: 'info',
        title: `${plural(rest.length, 'note')} from Unraid`,
        detail: cut(notificationTitle(newest), 200),
        ...(link ? { link } : {}),
        nature: 'fyi',
      });
    }
  }
  // Stable: alerts before hints within a rank, as the hosts service orders them.
  const ranked = items.map((n, i) => ({ n, i })).sort((a, b) => lineRank(a.n) - lineRank(b.n) || a.i - b.i);
  return {
    kind: 'notices',
    id: 'look',
    place: 'side',
    title: 'Worth a look',
    items: ranked.map((x) => x.n).slice(0, 30),
    empty: 'Nothing needs a look.',
  };
}

/* The busiest machines or apps (DS-09) ------------------------------------------------------------------------- */

/**
 * What a row says under its name: app or machine where a server has both, a Docker app's group, This Whombat, a change
 * waiting for a restart. Never a number or a type code (“CT 131”): a machine is its name.
 */
function guestNoteWords(g: HostGuest, mixed: boolean): string {
  const docker = g.platform === 'docker';
  const kindWords = mixed ? (docker ? 'App' : 'Machine') : docker ? (g.tags?.[0] ?? '') : '';
  const pending =
    g.pendingChanges && g.pendingChanges > 0
      ? g.platform === 'libvirt'
        ? `${plural(g.pendingChanges, 'change')} at the next start`
        : `restart to apply ${plural(g.pendingChanges, 'change')}`
      : null;
  return cut([kindWords, g.self ? 'This Whombat' : null, pending].filter(Boolean).join(' · '), 80);
}

/**
 * The busiest machines or apps (the temporary ones left out), each name opening its page; the row's console and
 * buttons are on that page, so a long name keeps its room.
 */
function guestsPanel(c: Ctx): Panel | null {
  const on = (g: HostGuest) => g.state === 'running' || g.state === 'unhealthy';
  const list = c.kind === 'unraid' ? c.kept.filter((g) => g.platform === 'docker') : c.kept;
  if (!list.length) return null;
  const rows = dashboardGuests(c.d);
  const running = list.filter(on).length;
  const word = guestsWord(c.kind).toLowerCase();
  const mixed = list.some((g) => g.platform === 'docker') && list.some((g) => g.platform !== 'docker');
  const link = tabLink(c, 'guests', 'See all');
  return {
    kind: 'table',
    id: 'guests',
    place: 'main',
    // A QEMU/KVM server's few machines are all listed, running first.
    title: c.kind === 'libvirt' ? 'Machines' : `Busiest ${word}`,
    meta: `${running} of ${list.length} running`,
    ...(link ? { link } : {}),
    columns: [
      { key: 'guest', label: 'Name' },
      { key: 'cpu', label: 'CPU', numeric: true },
      { key: 'memory', label: 'Memory', numeric: true },
      { key: 'trend', label: RANGE_COLUMN[c.range] },
    ],
    rows: rows.map((g) => {
      const live = on(g);
      const note = guestNoteWords(g, mixed);
      const history = c.guestSeries[g.id]?.series.cpu_pct;
      const cells: Record<string, ThingPageCell> = {
        guest: {
          text: cut(g.name, 200),
          mono: true,
          ...(note ? { note } : {}),
          href: serverGuestHref(c.serverId, g.id),
          ...(g.state === 'unhealthy'
            ? { dot: 'bad' as const }
            : g.state === 'paused'
              ? { dot: 'warn' as const }
              : !live
                ? { dot: 'off' as const }
                : {}),
        },
        cpu: live
          ? {
              text: formatPct1(g.cpuPct),
              ...(g.cpuPct != null ? { meter: clamp01(g.cpuPct / 100) } : {}),
            }
          : { text: DASH, tone: 'muted' },
        memory: live
          ? { text: formatMemPair(g.memoryUsedMb, g.memoryLimitMb) }
          : { text: DASH, tone: 'muted' },
        trend: history?.some((v) => v != null)
          ? { text: '', spark: spark(history) }
          : { text: DASH, tone: 'muted' },
      };
      return { id: g.id, cells };
    }),
    empty: `None of its ${plural(list.length, word.replace(/s$/, ''))} is running.`,
  };
}

/* Unraid: the array, pools and VMs ----------------------------------------------------------------------------- */

function arrayPanel(c: Ctx, u: HostUnraidDetail): Panel {
  const a = u.array;
  const p = parityView(a, c.now);
  const items: ThingPageBar[] = [];
  for (const d of a.disks) {
    if (d.slot !== 'parity' && d.slot !== 'data') continue;
    if (d.status === 'empty' && !d.device) continue;
    const name = unraidDiskName(d.name);
    const temp = d.spunDown ? 'spun down' : d.tempC != null ? formatTemp(d.tempC) : null;
    const note = cut([d.model, temp].filter(Boolean).join(' · '), 80);
    const broken = d.status !== 'ok';
    const statusWords: Record<string, string> = {
      disabled: 'disabled',
      emulated: 'emulated',
      missing: 'missing',
      new: 'new',
      invalid: 'invalid',
      wrong: 'wrong disk',
      empty: 'no disk',
    };
    if (d.slot === 'parity') {
      items.push({
        id: d.name,
        label: name,
        mono: true,
        ...(note ? { note } : {}),
        value: broken ? (statusWords[d.status] ?? d.status) : 'valid',
        pct: null,
        ...(broken ? { tone: 'bad' as const } : {}),
      });
      continue;
    }
    const size = d.sizeBytes / 1e9;
    const used = d.usedBytes != null ? d.usedBytes / 1e9 : null;
    const pct = used != null && size ? (used / size) * 100 : null;
    const level = tone(hostTone(diskUsedLevel(pct)));
    const f = forecastOf(c, `fs:/mnt/${d.name}`, null);
    const sub = broken
      ? cut(`${(statusWords[d.status] ?? d.status).replace(/^./, (x) => x.toUpperCase())}: open Array`, 120)
      : d.errors
        ? `${plural(d.errors, 'read error')}`
        : (f.words ?? (level && pct != null ? `${formatPct(pct)} full` : undefined));
    items.push({
      id: d.name,
      label: name,
      mono: true,
      ...(note ? { note } : {}),
      value: sizePair(used, size),
      pct: pct == null ? null : clamp01(pct / 100),
      ...(broken ? { tone: 'bad' as const } : level ? { tone: level } : {}),
      ...(sub ? { sub } : {}),
      ...(broken
        ? { subTone: 'bad' as const }
        : d.errors
          ? { subTone: 'warn' as const }
          : level
            ? { subTone: level }
            : {}),
    });
  }
  const last = a.parity.last ?? a.parity.history[0] ?? null;
  const meta =
    p.running || p.paused
      ? `${p.title} · ${p.detail}`
      : parityState(a) === 'ok' && last
        ? `Parity checked ${formatDayMonth(Date.parse(last.at), c.tz)} · ${last.errors ? plural(last.errors, 'error') : 'no errors'}`
        : p.title;
  const link = tabLink(c, 'array', 'See disks');
  return {
    kind: 'bars',
    id: 'array',
    place: 'main',
    title: 'Array',
    meta: cut(meta, 120),
    ...(link ? { link } : {}),
    items: items.slice(0, 40),
    empty: 'No disks in the array.',
  };
}

function vmsPanel(c: Ctx): Panel | null {
  const u = c.d.unraid;
  const vms = vmRows(c.kept.filter((g) => g.platform === 'libvirt'));
  if (!vms.length && !u?.vms.enabled) return null;
  const items: ThingPageItem[] = vms.slice(0, 8).map((g) => {
    const live = g.state === 'running' || g.state === 'unhealthy';
    const mem = g.memoryLimitMb ? sizeWords(g.memoryLimitMb / 1024) : null;
    return {
      id: g.id,
      title: cut(g.name, 160),
      detail: cut([g.image || 'VM', mem].filter(Boolean).join(' · '), 300),
      tone: g.state === 'unhealthy' ? 'bad' : g.state === 'paused' ? 'warn' : live ? 'ok' : 'info',
      right: live ? formatPct(g.cpuPct) : g.state === 'paused' ? 'Paused' : 'Stopped',
    };
  });
  const link = tabLink(c, 'guests', 'See all');
  return {
    kind: 'list',
    id: 'vms',
    place: 'side',
    title: 'Virtual machines',
    ...(link ? { link } : {}),
    items,
    empty: 'No virtual machines yet.',
  };
}

/* Storage and pools (DS-08) --------------------------------------------------------------------------------- */

/** A volume's forecast: the hub's own, else the range's `vol_pct:<entity>` points. */
function forecastOf(c: Ctx, entity: string, fullInDays: number | null | undefined) {
  const v = (c.d.health?.volumes ?? []).find((x) => x.entity === entity);
  const k = `vol_pct:${entity}`;
  const src = c.volumes?.series[k]?.some((x) => x != null) ? c.volumes : c.series;
  return volumeForecast({
    values: src?.series[k] ?? [],
    timestamps: src?.timestamps,
    fullInDays: fullInDays ?? v?.fullInDays ?? null,
    now: c.now,
    timeZone: c.tz,
  });
}

function forecastBar(
  c: Ctx,
  entity: string,
  fullInDays?: number | null,
): Pick<ThingPageBar, 'sub' | 'subTone'> {
  const f = forecastOf(c, entity, fullInDays);
  if (!f.words) return {};
  return {
    sub: f.words,
    ...(f.fullInDays != null && f.fullInDays < FORECAST_DATE_DAYS ? { subTone: 'warn' as const } : {}),
  };
}

const STORAGE_TYPE_WORDS: Record<string, string> = {
  lvmthin: 'LVM-thin',
  lvm: 'LVM',
  zfspool: 'ZFS',
  zfs: 'ZFS over iSCSI',
  dir: 'folder',
  nfs: 'NFS',
  cifs: 'SMB',
  pbs: 'Proxmox Backup Server',
  btrfs: 'Btrfs',
  cephfs: 'CephFS',
  rbd: 'Ceph',
  iscsi: 'iSCSI',
  glusterfs: 'GlusterFS',
};

/** The host's own volumes worth showing: pools, then file systems by size; read-only and tiny ones left out. */
function shownVolumes(d: HostServerDetail): HostVolume[] {
  return (d.health?.volumes ?? [])
    .filter((v) => v.totalGb >= 1 && !v.readOnly && (v.kind !== 'storage' || !d.proxmox))
    .sort((a, b) => Number(b.kind === 'pool') - Number(a.kind === 'pool') || b.totalGb - a.totalGb)
    .slice(0, 6);
}

/** Storage as bars (the mock's whole-width card on Proxmox; a host's file systems and pools elsewhere). */
function storagePanel(c: Ctx, inMain: boolean): Panel | null {
  if (c.kind === 'unraid') return null;
  const items: ThingPageBar[] = [];
  const totals = { used: 0, total: 0 };
  const proxmox = c.d.proxmox?.storages.filter((s) => s.capacityGb > 0) ?? [];
  if (c.kind === 'proxmox' && proxmox.length) {
    for (const s of proxmox) {
      const pct = (s.usedGb / s.capacityGb) * 100;
      const level = tone(hostTone(diskUsedLevel(pct)));
      const backups = /^backup$/.test(s.content.replace(/\s/g, ''));
      totals.used += s.usedGb;
      totals.total += s.capacityGb;
      items.push({
        id: `storage-${s.id}`,
        label: cut(s.id, 80),
        mono: true,
        note: cut(
          [STORAGE_TYPE_WORDS[s.type] ?? s.type, backups ? 'backups' : null].filter(Boolean).join(' · '),
          80,
        ),
        value: sizePair(s.usedGb, s.capacityGb),
        pct: clamp01(pct / 100),
        ...(level ? { tone: level } : {}),
        ...forecastBar(c, `storage:${s.id}`),
      });
    }
  } else {
    const incusPools = new Set((c.d.incus?.pools ?? []).map((p) => p.name));
    for (const v of shownVolumes(c.d)) {
      const name = v.kind === 'pool' ? v.label.replace(/^Pool /, '') : v.label;
      if (c.kind === 'incus' && v.kind === 'pool' && incusPools.has(name)) continue;
      const level = tone(hostTone(diskUsedLevel(v.usedPct)));
      const broken = !!v.error || (v.health != null && !/^online$/i.test(v.health) && v.kind === 'pool');
      const note = [
        v.kind === 'pool' ? v.layout : v.fsType,
        broken && v.health ? v.health.toLowerCase() : null,
      ]
        .filter(Boolean)
        .join(' · ');
      totals.used += v.usedGb;
      totals.total += v.totalGb;
      items.push({
        id: `vol-${v.entity}`,
        label: cut(name, 80),
        mono: true,
        ...(note ? { note: cut(note, 80) } : {}),
        value: sizePair(v.usedGb, v.totalGb),
        pct: clamp01(v.usedPct / 100),
        ...(broken ? { tone: 'bad' as const } : level ? { tone: level } : {}),
        ...forecastBar(c, v.entity, v.fullInDays),
      });
    }
  }
  if (!items.length) return null;
  const pair = totals.total ? sizePair(totals.used, totals.total) : null;
  const link = tabLink(c, 'storage', 'See storage');
  return {
    kind: 'bars',
    id: 'storage',
    place: inMain ? 'main' : 'bottom',
    title: 'Storage',
    ...(pair
      ? { meta: c.kind === 'proxmox' ? `${plural(items.length, 'storage')} · ${pair}` : `${pair} used` }
      : {}),
    ...(link ? { link } : {}),
    items,
    columns: inMain ? 1 : Math.min(3, items.length),
  };
}

/** Pools beside the rest: Unraid's, Incus's, libvirt's storage pools (or Unraid's VM folders). */
function poolsPanel(c: Ctx): Panel | null {
  const items: ThingPageBar[] = [];
  let title = 'Pools';
  let link: ThingPageLink | undefined;
  if (c.kind === 'unraid' && c.d.unraid) {
    for (const p of c.d.unraid.pools) {
      const used = p.usedBytes / 1e9;
      const size = p.sizeBytes / 1e9;
      const pct = size ? (used / size) * 100 : null;
      const level: ThingTone | undefined =
        pct == null ? undefined : pct >= UNRAID_POOL_FULL_PCT ? 'bad' : pct >= 80 ? 'warn' : undefined;
      items.push({
        id: `pool-${p.name}`,
        label: cut(p.name, 80),
        mono: true,
        note: cut(poolNote(p), 80),
        value: sizePair(used, size),
        pct: pct == null ? null : clamp01(pct / 100),
        ...(level ? { tone: level } : {}),
        ...forecastBar(c, `fs:/mnt/${p.name}`),
      });
    }
    link = tabLink(c, 'array', 'See disks');
  } else if (c.kind === 'incus' && c.d.incus) {
    for (const p of c.d.incus.pools) {
      const pct = p.usedBytes != null && p.totalBytes ? (p.usedBytes / p.totalBytes) * 100 : null;
      const level: ThingTone | undefined =
        pct == null ? undefined : pct >= 95 ? 'bad' : pct >= 85 ? 'warn' : undefined;
      const bad = !!p.status && !/^created$/i.test(p.status);
      items.push({
        id: `pool-${p.name}`,
        label: cut(p.name, 80),
        mono: true,
        note: cut(`${p.driver} · ${plural(p.volumes, 'volume')}`, 80),
        value:
          p.usedBytes != null && p.totalBytes != null
            ? sizePair(p.usedBytes / 1e9, p.totalBytes / 1e9)
            : DASH,
        pct: pct == null ? null : clamp01(pct / 100),
        ...(bad
          ? { tone: 'bad' as const, sub: cut(p.status, 120), subTone: 'bad' as const }
          : level
            ? { tone: level }
            : {}),
        ...(bad ? {} : forecastBar(c, `pool:${p.name}`)),
      });
    }
    link = tabLink(c, 'storage', 'See storage');
  } else if (c.kind === 'libvirt' && c.d.libvirt) {
    title = 'Storage pools';
    for (const p of c.d.libvirt.pools) {
      const pct = p.totalBytes > 0 ? (p.usedBytes / p.totalBytes) * 100 : null;
      const level: ThingTone | undefined =
        pct == null ? undefined : pct >= 95 ? 'bad' : pct >= 85 ? 'warn' : undefined;
      items.push({
        id: `pool-${p.name}`,
        label: cut(p.name, 80),
        mono: true,
        note: cut(`${p.type} · ${plural(p.volumes, 'volume')}`, 80),
        ...(p.totalBytes > 0 ? { value: sizePair(p.usedBytes / 1e9, p.totalBytes / 1e9) } : {}),
        pct: p.active && pct != null ? clamp01(pct / 100) : null,
        ...(!p.active
          ? { tone: 'warn' as const, sub: 'Not active', subTone: 'warn' as const }
          : level
            ? { tone: level }
            : {}),
        ...(p.active && p.path ? forecastBar(c, `fs:${p.path}`) : {}),
      });
    }
    if (!c.d.libvirt.pools.length && c.d.libvirt.folders) {
      title = 'VM folders';
      const f = c.d.libvirt.folders;
      if (f.domains)
        items.push({ id: 'folder-domains', label: 'VM disks', note: cut(f.domains, 80), pct: null });
      if (f.isos) items.push({ id: 'folder-isos', label: 'ISO images', note: cut(f.isos, 80), pct: null });
    }
    link = tabLink(c, 'storage', 'See storage');
  }
  if (!items.length) return null;
  return {
    kind: 'bars',
    id: 'pools',
    place: 'side',
    title,
    ...(link ? { link } : {}),
    items: items.slice(0, 40),
  };
}

/* Proxmox: backups and the cluster ---------------------------------------------------------------------------- */

function backupsPanel(c: Ctx): Panel | null {
  const b = c.d.proxmox?.backups;
  const link = tabLink(c, 'backups', 'See backups');
  const items: ThingPageItem[] = [];
  const job = b?.lastJob;
  if (job) {
    const all = job.guestsOk === job.guestsTotal;
    const failed = job.result !== 'ok' && job.guestsOk === 0;
    items.push({
      id: 'last-job',
      title: cut(`${job.guestsOk} of ${plural(job.guestsTotal, 'machine')} backed up`, 160),
      detail: cut(
        [
          formatRelativeDay(Date.parse(job.at), c.now, c.tz),
          `${dashboardNumber(job.durationMin)}${NBSP}min`,
          job.warnings ? plural(job.warnings, 'warning') : null,
        ]
          .filter(Boolean)
          .join(' · '),
        300,
      ),
      at: job.at,
      tone: failed ? 'bad' : all && !job.warnings && job.result === 'ok' ? 'ok' : 'warn',
      icon: 'backup',
      ...(b?.nextRun ? { right: cut(`next ${formatIn((Date.parse(b.nextRun) - c.now) / 1000)}`, 40) } : {}),
    });
  } else if (b?.nextRun) {
    items.push({
      id: 'next-run',
      title: 'No backup has run yet',
      detail: `The first one runs ${formatRelativeDay(Date.parse(b.nextRun), c.now, c.tz)}`,
      tone: 'info',
      icon: 'backup',
    });
  }
  return {
    kind: 'list',
    id: 'backups',
    place: 'side',
    title: 'Backups',
    ...(link ? { link } : {}),
    items,
    empty: 'No backup plan covers this server yet.',
  };
}

function clusterPanel(c: Ctx): Panel | null {
  const cl = c.d.proxmox?.cluster;
  if (!cl || cl.nodes.length < 2) return null;
  const items: ThingPageItem[] = cl.nodes.map((n) => {
    const online = n.status === 'online';
    return {
      id: `node-${n.name}`,
      title: cut(n.name, 160),
      detail: cut(
        online
          ? [
              n.cpuPct != null ? `CPU ${formatPct(n.cpuPct)}` : null,
              n.memPct != null ? `memory ${formatPct(n.memPct)}` : null,
              plural(n.vms, 'VM'),
              plural(n.containers, 'container'),
            ]
              .filter(Boolean)
              .join(' · ')
          : 'Offline',
        300,
      ),
      tone: online ? 'ok' : 'bad',
      ...(n.thisNode ? { right: 'This one' } : n.agent === 'not_enrolled' ? { right: 'Not added' } : {}),
    };
  });
  return {
    kind: 'list',
    id: 'cluster',
    place: 'side',
    title: 'Cluster',
    meta: cut(
      `${cl.name} · ${cl.quorate ? `quorate, ${cl.votes.have} of ${cl.votes.expected} votes` : 'not quorate'}`,
      120,
    ),
    items,
  };
}

/* The kind's own facts ----------------------------------------------------------------------------------------- */

function kindFactsPanel(c: Ctx): Panel | null {
  let title: string;
  let facts: { label: string; value: string }[];
  if (c.kind === 'unraid' && c.d.unraid) {
    title = 'Unraid';
    facts = unraidFacts(c.d.unraid);
  } else if (c.kind === 'incus' && c.d.incus) {
    title = 'Incus';
    facts = incusFacts(c.d.incus);
  } else if (c.kind === 'libvirt' && c.d.libvirt) {
    title = LIBVIRT_KIND_WORD;
    facts = libvirtFacts(c.d.libvirt);
  } else if (c.kind === 'macos' && c.d.macos) {
    title = 'This Mac';
    facts = macFacts(c.d.macos);
  } else return null;
  return {
    kind: 'facts',
    id: 'kind_facts',
    place: 'side',
    title,
    items: facts.slice(0, 24).map((f) => ({ label: cut(f.label, 40), value: cut(f.value, 200) })),
  };
}
