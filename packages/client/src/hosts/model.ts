/**
 * Servers as the screens show them (one Whombat ONE-11…ONE-15; app docs/decisions/one-whombat-things.md AP-1300…):
 * a row of Home's Servers card and the servers page, a server's header, its five figures (mock 2), the busiest guests,
 * the tabs a server and a guest get, power actions with their words, the CPU temperature chart's choice of sensor, and
 * what a refusal says. Ported from Rackoon's `features/server`, `features/fleet` and `features/guest` and fed by the
 * contracts' `Host*` shapes. Pure: the web and Android draw these; times come in as arguments.
 */

import { type BrandMarkName, isBrandMark } from '@whombat/brand';
import {
  HOST_DESTRUCTIVE_ACTIONS,
  type HostAlert,
  type HostGuest,
  type HostGuestAction,
  type HostGuestState,
  type HostHint,
  type HostRemoteControl,
  type HostSensor,
  type HostSeries,
  type HostServer,
  type HostServerDetail,
  type HostServerStatus,
  hostOsMark,
  hostStatusLabels,
  thingHref,
} from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_MODEL_WORDS } from '../i18n/messages/connectionsHosts/servers';
import { lastValue, secondsAbove } from './chart';
import {
  DASH,
  formatDuration,
  formatGb,
  formatGbPair,
  formatMemPair,
  formatNum,
  formatPct,
  formatPct1,
  formatTemp,
  formatUptimeWords,
} from './format';
import {
  alertNoticeParts,
  hintNoticeParts,
  type ServerNoticeOptions,
  type ServerNoticeParts,
} from './notices';
import {
  type HostLevel,
  type HostTone,
  hostTone,
  sensorLevel,
  serverTone,
  WARM_SHARE,
  warmFrom,
} from './thresholds';

/**
 * The servers list's address before Connections took it in (Whombat connections-page.md CN-09; app AP-2523): it opens
 * Connections now, with Add a server (`?add=1`) and its sign-in fields; `?view=guests` is every guest of every server.
 */
export const SERVERS_HREF = '/things/servers';

/** Every guest of every server (`?view=guests` of the servers' address; the Servers group's “All guests”, CN-09). */
export const ALL_GUESTS_HREF = `${SERVERS_HREF}?view=guests`;

/** A server's page. */
export function serverHref(serverId: string): string {
  return thingHref('server', serverId);
}

/** “Proxmox VE 9.2.11” → “Proxmox VE 9.2” (a row's second line keeps two version parts). */
export function shortOs(os: string | null | undefined): string {
  if (!os) return '';
  return os.replace(/(\d+\.\d+)\.\d+(?:[-.\w]*)?/, '$1').replace(/^Debian GNU\/Linux/, 'Debian');
}

/** The status words (`statusNote` when the service gave one, “Running hot”; else the contracts' label). */
export function statusText(status: HostServerStatus, note?: string | null, locale?: string | null): string {
  if (note && status !== 'ok') return note.charAt(0).toUpperCase() + note.slice(1);
  return hostStatusLabels(locale)[status];
}

/**
 * A server's mark (marks.md AP-2204; contracts 0.90 CT-399): Proxmox's or Unraid's, else its Linux's (Debian, Ubuntu…),
 * or null when its system isn't known (the apps draw a server).
 */
export function serverMark(s: {
  platform: HostServer['platform'];
  /** os-release's name, or a server page's `{ name, version }`. */
  os: string | { name: string; version: string } | null | undefined;
}): BrandMarkName | null {
  const os = typeof s.os === 'object' && s.os ? `${s.os.name} ${s.os.version}` : s.os;
  const mark = hostOsMark({ platform: s.platform, os });
  return mark && isBrandMark(mark) ? mark : null;
}

/* Servers table ------------------------------------------------------------------------------------- */

export interface ServerRowView {
  id: string;
  name: string;
  href: string;
  status: HostServerStatus;
  tone: HostTone;
  /** “Running hot”, “Offline”: the row's accessible status. */
  statusLabel: string;
  /** “Proxmox VE 9.2 · Ryzen AI MAX+ PRO”. */
  subtitle: string;
  /** What it runs, as a mark (`serverMark`). */
  mark: BrandMarkName | null;
  cpuText: string;
  cpu24h: readonly (number | null)[];
  memoryText: string;
  memoryPct: number | null;
  tempText: string;
  tempTone: HostTone;
  /** “19 / 23”, “none”. */
  guestsText: string;
  guestsRunning: number;
  guestsTotal: number;
  offline: boolean;
}

export function serverRow(s: HostServer, locale?: string | null): ServerRowView {
  const running = s.guests.reduce((a, g) => a + g.running, 0);
  const total = s.guests.reduce((a, g) => a + g.total, 0);
  const offline = s.status === 'offline' || s.status === 'pending';
  const tempLevel = s.temperature ? sensorLevel(s.temperature.maxC, s.temperature.limitC) : null;
  return {
    id: s.id,
    name: s.name,
    href: serverHref(s.id),
    status: s.status,
    tone: serverTone(s.status),
    statusLabel: statusText(s.status, s.statusNote, locale),
    subtitle: [shortOs(s.os), s.cpu?.model].filter(Boolean).join(' · '),
    mark: serverMark(s),
    cpuText: offline ? DASH : formatPct(s.cpuPct),
    cpu24h: s.cpu24h,
    memoryText: offline
      ? DASH
      : formatGbPair(s.memory.usedGb ?? pctOf(s.memory.usedPct, s.memory.totalGb), s.memory.totalGb),
    memoryPct: offline ? null : s.memory.usedPct,
    tempText: offline ? DASH : formatTemp(s.temperature?.maxC),
    tempTone: offline ? 'mut' : hostTone(tempLevel),
    guestsText: total === 0 ? clientTree(locale, HOSTS_MODEL_WORDS).none : `${running} / ${total}`,
    guestsRunning: running,
    guestsTotal: total,
    offline,
  };
}

function pctOf(pct: number | null, total: number | null): number | null {
  return pct == null || total == null ? null : (pct / 100) * total;
}

/** Rows in the order Home shows them: problems first (bad, warn), then by name. */
export function serverRows(servers: readonly HostServer[], locale?: string | null): ServerRowView[] {
  const rank: Record<HostServerStatus, number> = { bad: 0, offline: 1, warn: 2, pending: 3, ok: 4 };
  return [...servers]
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name))
    .map((s) => serverRow(s, locale));
}

/** “5 online · 66 of 133 running” (Home's Servers card): machines and apps together, so no noun. */
export function fleetLine(servers: readonly HostServer[], locale?: string | null): string {
  const w = clientTree(locale, HOSTS_MODEL_WORDS).fleet;
  const online = servers.filter((s) => s.status !== 'offline' && s.status !== 'pending').length;
  const running = servers.reduce((a, s) => a + s.guests.reduce((b, g) => b + g.running, 0), 0);
  const total = servers.reduce((a, s) => a + s.guests.reduce((b, g) => b + g.total, 0), 0);
  const parts = [interpolate(w.online, { count: online })];
  if (online < servers.length) parts.push(interpolate(w.offline, { count: servers.length - online }));
  if (total) parts.push(interpolate(w.running, { running, total }));
  return parts.join(' · ');
}

/* A server's page ----------------------------------------------------------------------------------- */

/** A run of words in a fact line, some bold (“Proxmox VE **9.2.11**”). */
export interface FactPart {
  text: string;
  strong?: boolean;
}

export interface ServerHeaderView {
  name: string;
  status: HostServerStatus;
  tone: HostTone;
  badge: string;
  facts: FactPart[][];
}

export function serverHeader(d: HostServerDetail, name?: string, locale?: string | null): ServerHeaderView {
  const w = clientTree(locale, HOSTS_MODEL_WORDS);
  const s = d.server;
  const facts: FactPart[][] = [];
  if (s.os) facts.push([{ text: `${s.os.name} ` }, { text: s.os.version, strong: true }]);
  if (s.cpu) facts.push([{ text: `${s.cpu.model} · ` }, { text: w.threads(s.cpu.threads), strong: true }]);
  if (s.uptimeS != null && s.status !== 'offline')
    facts.push([{ text: w.header.up }, { text: formatUptimeWords(s.uptimeS, locale), strong: true }]);
  if (s.status === 'offline' && s.agent.lastSyncSAgo != null)
    facts.push([
      { text: w.header.lastHeard },
      {
        text: interpolate(w.header.ago, { duration: formatDuration(s.agent.lastSyncSAgo, locale) }),
        strong: true,
      },
    ]);
  return {
    name: name ?? s.name ?? s.id,
    status: s.status,
    tone: serverTone(s.status),
    badge: statusText(s.status, s.statusNote, locale),
    facts,
  };
}

/** One of the five figures under a server's header (mock 2). */
export interface KpiView {
  key: 'cpu' | 'memory' | 'hottest' | 'storage' | 'guests';
  label: string;
  value: string;
  /** After the value, smaller: “/ 118 GB”, “running”. */
  rest?: string;
  sub: string;
  tone?: HostTone;
}

/** Every guest a server's page lists (Proxmox VMs and containers, Docker, Incus, libvirt). */
export function detailGuests(d: HostServerDetail): HostGuest[] {
  const p = d.proxmox?.guests;
  const w = d.workloads;
  return [
    ...(p?.vm?.guests ?? []),
    ...(p?.container?.guests ?? []),
    ...(w?.docker?.guests ?? []),
    ...(w?.incus?.guests ?? []),
    ...(w?.libvirt?.guests ?? []),
  ];
}

/** Running and total guests of a server's page. */
export function guestTotals(d: HostServerDetail): { running: number; total: number } {
  const ws = [
    d.proxmox?.guests.vm,
    d.proxmox?.guests.container,
    d.workloads?.docker,
    d.workloads?.incus,
    d.workloads?.libvirt,
  ];
  let running = 0;
  let total = 0;
  for (const w of ws) {
    if (!w) continue;
    running += w.running;
    total += w.total;
  }
  return { running, total };
}

/** The sensor the server page charts: the CPU's when there is one, else the hottest. */
export function chartSensor(d: HostServerDetail): HostSensor | null {
  const cpu = d.sensors.find(
    (s) => s.group === 'cpu' || /cpu|package|tctl|tdie|core/i.test(`${s.id} ${s.label}`),
  );
  if (cpu) return cpu;
  return [...d.sensors].sort((a, b) => (b.nowC ?? -1) - (a.nowC ?? -1))[0] ?? null;
}

/** The chart's series key for a sensor (`temp_<id>_c`), or the hottest overall. */
export function sensorSeriesKey(sensor: HostSensor | null): string {
  return sensor ? `temp_${sensor.id}_c` : 'temp_max_c';
}

export interface TemperatureChartView {
  title: string;
  key: string;
  /** Where “warm” starts (the dashed line). */
  warm: number;
  limit: number | null;
  meta: string;
}

export function temperatureChart(
  d: HostServerDetail,
  rangeShort?: string,
  locale?: string | null,
): TemperatureChartView | null {
  if (!d.sensors.length) return null;
  const w = clientTree(locale, HOSTS_MODEL_WORDS).chart;
  const sensor = chartSensor(d);
  const isCpu =
    !!sensor &&
    (sensor.group === 'cpu' || /cpu|package|tctl|tdie|core/i.test(`${sensor.id} ${sensor.label}`));
  const warm = warmFrom(sensor?.limitC);
  return {
    title: isCpu ? w.cpu : interpolate(w.sensor, { sensor: sensor?.label ?? w.hottest }),
    key: sensorSeriesKey(sensor),
    warm,
    limit: sensor?.limitC ?? null,
    meta: interpolate(w.meta, { range: rangeShort ?? w.lastDay, warm }),
  };
}

/** The hottest sensor now. */
export function hottestSensor(d: HostServerDetail): HostSensor | null {
  return [...d.sensors].sort((a, b) => (b.nowC ?? -1) - (a.nowC ?? -1))[0] ?? null;
}

/** The five figures: CPU, Memory, Hottest, Storage, Guests (mock 2). */
export function serverKpis(d: HostServerDetail, history?: HostSeries, locale?: string | null): KpiView[] {
  const words = clientTree(locale, HOSTS_MODEL_WORDS);
  const w = words.kpi;
  const s = d.server;
  const live = d.live;
  const out: KpiView[] = [];
  out.push({
    key: 'cpu',
    label: w.cpu,
    value: formatPct(live?.cpuPct),
    sub: s.cpu ? words.threads(s.cpu.threads) : DASH,
  });
  const total = s.memory?.totalGb ?? null;
  out.push({
    key: 'memory',
    label: w.memory,
    value: formatNum(live?.memUsedGb, locale),
    rest: total != null ? `/ ${formatGb(total)}` : undefined,
    sub: live?.memPct != null ? interpolate(w.used, { pct: formatPct(live.memPct) }) : DASH,
  });
  const hot = hottestSensor(d);
  if (hot) {
    const level = sensorLevel(hot.nowC, hot.limitC);
    const key = sensorSeriesKey(hot);
    const warmS = level && level !== 'good' ? secondsAbove(history, key, (hot.limitC ?? 85) * WARM_SHARE) : 0;
    out.push({
      key: 'hottest',
      label: w.hottest,
      value: formatTemp(hot.nowC),
      sub:
        warmS > 0
          ? interpolate(w.warmFor, { duration: formatDuration(warmS, locale).replace(/ \d+ min$/, '') })
          : hot.label,
      tone: level === 'good' ? undefined : hostTone(level),
    });
  }
  const storage = storageTotals(d);
  if (storage) {
    out.push({
      key: 'storage',
      label: w.storage,
      value: formatGb(storage.usedGb),
      rest: `/ ${formatGb(storage.totalGb)}`,
      sub: storage.totalGb
        ? interpolate(w.used, { pct: formatPct((storage.usedGb / storage.totalGb) * 100) })
        : DASH,
    });
  }
  const g = guestTotals(d);
  if (g.total) {
    out.push({
      key: 'guests',
      label: w.guests,
      value: String(g.running),
      rest: w.running,
      sub: guestMix(d, locale),
    });
  }
  return out;
}

/** Storage used and in total: Proxmox's storages without duplicates (a shared one counts once), else the disks. */
export function storageTotals(d: HostServerDetail): { usedGb: number; totalGb: number } | null {
  const stores = d.proxmox?.storages ?? [];
  if (stores.length) {
    // The storages guests' disks live on (`images`, `rootdir`); ISO and backup stores don't count.
    const disks = stores.filter((s) => s.capacityGb > 0 && /images|rootdir/.test(s.content));
    const list = disks.length ? disks : stores;
    return {
      usedGb: list.reduce((a, s) => a + s.usedGb, 0),
      totalGb: list.reduce((a, s) => a + s.capacityGb, 0),
    };
  }
  const vols = d.health?.volumes ?? [];
  if (vols.length) {
    return {
      usedGb: vols.reduce((a, v) => a + v.usedGb, 0),
      totalGb: vols.reduce((a, v) => a + v.totalGb, 0),
    };
  }
  const disks = d.disks.filter((x) => x.capacityGb != null);
  if (!disks.length) return null;
  return {
    usedGb: disks.reduce((a, x) => a + (x.usedGb ?? 0), 0),
    totalGb: disks.reduce((a, x) => a + (x.capacityGb ?? 0), 0),
  };
}

/** “6 VMs · 13 CTs”, “14 containers · 2 VMs”: the running guests by kind. */
export function guestMix(d: HostServerDetail, locale?: string | null): string {
  const words = clientTree(locale, HOSTS_MODEL_WORDS);
  const m = words.mix;
  const p = d.proxmox?.guests;
  if (p) {
    const parts = [];
    if (p.vm) parts.push(m.vms(p.vm.running));
    if (p.container) parts.push(m.cts(p.container.running));
    return parts.join(' · ');
  }
  const running = detailGuests(d).filter((g) => g.state === 'running' || g.state === 'unhealthy');
  const ct = running.filter((g) => g.kind === 'container').length;
  const vm = running.filter((g) => g.kind === 'vm').length;
  return [ct ? m.containers(ct) : null, vm ? m.vms(vm) : null].filter(Boolean).join(' · ') || words.none;
}

/* Guests -------------------------------------------------------------------------------------------- */

/** “CT 140”, “VM 118”, “Docker”, “Incus VM”, “libvirt VM”. */
export function guestKindText(g: Pick<HostGuest, 'platform' | 'kind' | 'vmid'>): string {
  switch (g.platform) {
    case 'docker':
      return 'Docker';
    case 'incus':
      return g.kind === 'vm' ? 'Incus VM' : 'Incus CT';
    case 'libvirt':
      return 'libvirt VM';
    default:
      return `${g.kind === 'vm' ? 'VM' : 'CT'}${g.vmid != null ? ` ${g.vmid}` : ''}`;
  }
}

/**
 * What a guest row draws for its kind (less-is-more.md AP-1755): Docker's mark for a Docker container, the Linux
 * Containers mark for an Incus or a Proxmox container (LXC), a screen for any VM; `label` is the words for its tooltip
 * and screen readers (“Incus VM”, “Proxmox container 140”, “QEMU/KVM VM”), `id` Proxmox's number shown muted after the
 * name (it is how Proxmox people name a guest).
 */
export type GuestKindGlyph = 'docker' | 'lxc' | 'vm';

export interface GuestKindView {
  glyph: GuestKindGlyph;
  label: string;
  id: string | null;
}

export function guestKind(
  g: Pick<HostGuest, 'platform' | 'kind' | 'vmid'>,
  locale?: string | null,
): GuestKindView {
  const w = clientTree(locale, HOSTS_MODEL_WORDS).kind;
  const vm = g.kind === 'vm';
  const glyph: GuestKindGlyph = g.platform === 'docker' ? 'docker' : vm ? 'vm' : 'lxc';
  switch (g.platform) {
    case 'docker':
      return { glyph, label: w.docker, id: null };
    case 'incus':
      return { glyph, label: vm ? w.incusVm : w.incusContainer, id: null };
    case 'libvirt':
      return { glyph, label: w.libvirt, id: null };
    default: {
      const id = g.vmid != null ? String(g.vmid) : null;
      const label = id
        ? interpolate(vm ? w.proxmoxVmId : w.proxmoxContainerId, { id })
        : vm
          ? w.proxmoxVm
          : w.proxmoxContainer;
      return { glyph, label, id };
    }
  }
}

/**
 * Whether a search names a guest's kind (“docker”, “vm”, “incus vm”, “ct”, “lxc”), so the search finds kinds by name.
 * Every word of the search must be a whole kind word: half a word (“pro”, “con”) is still typing a name and would
 * otherwise list every Proxmox guest or every container.
 */
export function guestKindMatches(g: Pick<HostGuest, 'platform' | 'kind' | 'vmid'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const view = guestKind(g);
  const words = new Set(
    `${view.label} ${guestKindText(g)} ${view.glyph === 'lxc' ? 'lxc' : ''}`
      .toLowerCase()
      .split(/[\s/]+/)
      .filter(Boolean),
  );
  const asked = q.split(/[\s/]+/).filter(Boolean);
  return asked.every((w) => words.has(w));
}

/** A guest's state in words, in a locale (English when none is given). */
export function guestStateWords(locale?: string | null): Record<HostGuestState, string> {
  return { ...clientTree(locale, HOSTS_MODEL_WORDS).states };
}

export const GUEST_STATE_WORDS: Record<HostGuestState, string> = guestStateWords('en');

export function guestStateTone(state: HostGuestState): HostTone {
  return state === 'running' ? 'ok' : state === 'unhealthy' ? 'bad' : state === 'paused' ? 'warn' : 'mut';
}

/** What a guest row says after its numbers: a change waiting for a restart (warn), else its tags. */
export function guestNote(
  g: HostGuest,
  locale?: string | null,
): { text: string; tone: 'warn' } | { tags: string[] } {
  if (g.pendingChanges && g.pendingChanges > 0) {
    const w = clientTree(locale, HOSTS_MODEL_WORDS).pending;
    return {
      // libvirt keeps a running VM as it is until it's started again (incus-unraid-wq.md AP-1652).
      text: g.platform === 'libvirt' ? w.nextStart(g.pendingChanges) : w.restart(g.pendingChanges),
      tone: 'warn',
    };
  }
  return { tags: g.tags ?? [] };
}

export interface GuestRowView {
  id: string;
  name: string;
  kindText: string;
  /** The kind as a mark with its words (AP-1755). */
  kind: GuestKindView;
  state: HostGuestState;
  stateText: string;
  stateTone: HostTone;
  cpuText: string;
  cpuPct: number | null;
  memoryText: string;
  uptimeText: string;
  note: ReturnType<typeof guestNote>;
}

export function guestRow(g: HostGuest): GuestRowView {
  return guestRowFor(g);
}

/** {@link guestRow} in a locale (English when none is given); `guestRow` stays one-argument so it can be mapped. */
export function guestRowFor(g: HostGuest, locale?: string | null): GuestRowView {
  const on = g.state === 'running' || g.state === 'unhealthy';
  return {
    id: g.id,
    name: g.name,
    kindText: guestKindText(g),
    kind: guestKind(g, locale),
    state: g.state,
    stateText: guestStateWords(locale)[g.state],
    stateTone: guestStateTone(g.state),
    cpuText: on ? formatPct1(g.cpuPct) : DASH,
    cpuPct: on ? g.cpuPct : null,
    memoryText: on ? formatMemPair(g.memoryUsedMb, g.memoryLimitMb) : DASH,
    uptimeText: on && g.uptimeS != null ? formatDuration(g.uptimeS, locale) : DASH,
    note: guestNote(g, locale),
  };
}

/** The busiest running guests, by CPU. */
export function busiestGuests(guests: readonly HostGuest[], n = 4): HostGuest[] {
  return [...guests]
    .filter((g) => g.state === 'running' || g.state === 'unhealthy')
    .sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0) || a.name.localeCompare(b.name))
    .slice(0, n);
}

export type GuestFilter = 'all' | 'running' | 'stopped' | 'unhealthy';

/**
 * Guests matching a filter and a search (name, id, tags, addresses, or the kind by its words: “docker”, “vm”; the
 * kind is an icon in the row, AP-1755), busiest first, stopped after.
 */
export function filterGuests(guests: readonly HostGuest[], state: GuestFilter, q: string): HostGuest[] {
  const needle = q.trim().toLowerCase();
  return [...guests]
    .filter((g) => state === 'all' || g.state === state || (state === 'running' && g.state === 'unhealthy'))
    .filter(
      (g) =>
        !needle ||
        [g.name, g.id, String(g.vmid ?? ''), g.image, ...(g.tags ?? []), ...(g.addresses ?? [])].some((v) =>
          v.toLowerCase().includes(needle),
        ) ||
        guestKindMatches(g, needle),
    )
    .sort((a, b) => {
      const ra = a.state === 'stopped' ? 1 : 0;
      const rb = b.state === 'stopped' ? 1 : 0;
      return ra - rb || (b.cpuPct ?? 0) - (a.cpuPct ?? 0) || a.name.localeCompare(b.name);
    });
}

/* Tabs ---------------------------------------------------------------------------------------------- */

export type ServerTab = 'summary' | 'guests' | 'storage' | 'sensors' | 'backups' | 'system';

/** A server's tabs' names, in a locale (English when none is given). */
export function serverTabWords(locale?: string | null): Record<ServerTab, string> {
  return { ...clientTree(locale, HOSTS_MODEL_WORDS).serverTabs };
}

export const SERVER_TAB_WORDS: Record<ServerTab, string> = serverTabWords('en');

/** A server's tabs (mock 2: Summary · Guests · Storage · Sensors · Backups · System); every server gets all six. */
export const SERVER_TABS: readonly ServerTab[] = [
  'summary',
  'guests',
  'storage',
  'sensors',
  'backups',
  'system',
];

export function parseServerTab(v: unknown): ServerTab {
  return typeof v === 'string' && (SERVER_TABS as readonly string[]).includes(v)
    ? (v as ServerTab)
    : 'summary';
}

export type GuestTab =
  | 'summary'
  | 'hardware'
  | 'options'
  | 'cloudinit'
  | 'snapshots'
  | 'backups'
  | 'firewall'
  | 'replication'
  | 'tasks';

/** A guest's tabs' names, in a locale (English when none is given). */
export function guestTabWords(locale?: string | null): Record<GuestTab, string> {
  const { resources: _resources, ...words } = clientTree(locale, HOSTS_MODEL_WORDS).guestTabs;
  return words;
}

export const GUEST_TAB_WORDS: Record<GuestTab, string> = guestTabWords('en');

/** A tab's word for this guest: a container's Hardware is its Resources (Proxmox's word, Rackoon's `tabs.ts`). */
export function guestTabWord(tab: GuestTab, kind: HostGuest['kind'], locale?: string | null): string {
  const w = clientTree(locale, HOSTS_MODEL_WORDS).guestTabs;
  return tab === 'hardware' && kind === 'container' ? w.resources : w[tab];
}

/** Proxmox VE and Incus guests can be changed from Whombat. */
export function manageablePlatform(g: Pick<HostGuest, 'platform'>): boolean {
  return g.platform === 'pve' || g.platform === 'incus';
}

/**
 * The guest page's tabs: the platform decides what exists, the server's switches what is listed. Configuration tabs
 * need Manage; Cloud-Init only for VMs that have a cloud-init drive; Replication only in a cluster (AP-1418).
 */
export function guestTabs(
  g: Pick<HostGuest, 'platform' | 'kind'>,
  rc: HostRemoteControl | undefined,
  opts: { manageable?: boolean; cloudInit?: boolean; cluster?: boolean } = {},
): GuestTab[] {
  const manage = (opts.manageable ?? !!rc?.manage) && manageablePlatform(g);
  const tabs: GuestTab[] = ['summary'];
  // Incus's own keys (`limits.*`, devices) are left to Whombat in a chat (AP-1319); its snapshots are here.
  if (manage && g.platform === 'pve') tabs.push('hardware', 'options');
  if (manage && g.platform === 'pve' && g.kind === 'vm' && opts.cloudInit) tabs.push('cloudinit');
  if (g.platform !== 'docker' && rc?.power) tabs.push('snapshots');
  if (manage && g.platform === 'pve') {
    tabs.push('backups', 'firewall');
    if (opts.cluster) tabs.push('replication');
    tabs.push('tasks');
  }
  return tabs;
}

export function parseGuestTab(v: unknown, allowed: readonly GuestTab[]): GuestTab {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as GuestTab) : 'summary';
}

/* Power --------------------------------------------------------------------------------------------- */

export interface PowerActionView {
  action: HostGuestAction;
  label: string;
  /** Asks first (a stop, a restart). */
  confirm: boolean;
  /** What the confirmation says. */
  question?: string;
  serious?: boolean;
}

/** What may be done to a guest's power now, in the order the menu lists them. */
export function powerActions(
  g: Pick<HostGuest, 'state' | 'platform' | 'kind' | 'name'>,
  locale?: string | null,
): PowerActionView[] {
  const w = clientTree(locale, HOSTS_MODEL_WORDS).power;
  const on = g.state === 'running' || g.state === 'unhealthy';
  const name = g.name;
  if (g.state === 'paused')
    return [
      { action: 'resume', label: w.resume, confirm: false },
      {
        action: 'stop',
        label: w.stop,
        confirm: true,
        question: interpolate(w.stopNow, { name }),
        serious: true,
      },
    ];
  if (!on) return [{ action: 'start', label: w.start, confirm: false }];
  if (g.platform === 'docker')
    return [
      { action: 'restart', label: w.restart, confirm: true, question: interpolate(w.restartAsk, { name }) },
      {
        action: 'stop',
        label: w.stop,
        confirm: true,
        question: interpolate(w.stopAsk, { name }),
        serious: true,
      },
    ];
  const list: PowerActionView[] = [
    { action: 'shutdown', label: w.shutdown, confirm: true, question: interpolate(w.shutdownAsk, { name }) },
    { action: 'reboot', label: w.restart, confirm: true, question: interpolate(w.restartAsk, { name }) },
  ];
  if (g.kind === 'vm' && g.platform !== 'incus')
    list.push({ action: 'pause', label: w.pause, confirm: false });
  list.push({
    action: 'force_stop',
    label: w.forceStop,
    confirm: true,
    question: interpolate(w.forceStopAsk, { name }),
    serious: true,
  });
  return list;
}

export function isDestructiveAction(a: HostGuestAction): boolean {
  return (HOST_DESTRUCTIVE_ACTIONS as readonly string[]).includes(a);
}

/** The toast after an action was accepted (“Restarting arnica-prod-nest-01.”). */
export function actionAcceptedText(
  action: HostGuestAction,
  name: string,
  noop?: boolean,
  locale?: string | null,
): string {
  const w = clientTree(locale, HOSTS_MODEL_WORDS).accepted;
  if (noop) return interpolate(w.noop, { name });
  const said: Partial<Record<HostGuestAction, string>> = {
    start: w.start,
    shutdown: w.shutdown,
    reboot: w.reboot,
    restart: w.restart,
    stop: w.stop,
    force_stop: w.force_stop,
    pause: w.pause,
    resume: w.resume,
    snapshot_create: w.snapshot_create,
    snapshot_restore: w.snapshot_restore,
    snapshot_delete: w.snapshot_delete,
  };
  return interpolate(said[action] ?? w.other, { name });
}

/* Watch --------------------------------------------------------------------------------------------- */

export interface WatchRowView extends Partial<ServerNoticeParts> {
  id: string;
  tone: HostTone;
  title: string;
  detail: string;
  section?: string | null;
  alert?: HostAlert;
}

/**
 * A server's open alerts, then its hints (a tab's notices), each with its check, kind, item, Ignore and quiet
 * (quiet-notices.md AP-4810, AP-4811); the quiet ones last.
 */
export function serverWatch(
  alerts: readonly HostAlert[],
  hints: readonly HostHint[],
  serverId: string,
  opts: ServerNoticeOptions = {},
): WatchRowView[] {
  const rows: WatchRowView[] = [];
  for (const a of alerts) {
    if (a.serverId !== serverId || a.state !== 'open') continue;
    rows.push({
      id: a.id,
      tone: a.severity === 'critical' ? 'bad' : 'warn',
      title: a.title,
      detail: a.detail,
      section: a.section,
      alert: a,
      ...alertNoticeParts(a, opts),
    });
  }
  for (const h of hints) {
    if (h.serverId !== serverId) continue;
    rows.push({
      id: `${h.kind}:${h.entity}`,
      tone: h.severity === 'warning' ? 'warn' : 'mut',
      title: h.title,
      detail: h.detail,
      section: h.section,
      ...hintNoticeParts(h, opts),
    });
  }
  return [...rows.filter((r) => !r.quiet), ...rows.filter((r) => r.quiet)];
}

/** The level's tone, exported for screens that colour a figure. */
export function levelTone(level: HostLevel | null): HostTone {
  return hostTone(level);
}

/** A metric's latest value from a history. */
export function latest(series: HostSeries | undefined, key: string): number | null {
  return lastValue(series?.series[key]);
}
