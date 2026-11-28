/**
 * UniFi Network's page and tile (connection-pages.md CP-02, CP-16; connection-pages-server.md CP-S14): how the network
 * equipment runs. Its Summary is in slots (docs/decisions/service-slots.md): the network now (the internet line, what
 * is connected, the devices online), what is on the network (access points, switches, the gateway, updates waiting),
 * about how much came down the line per day from the speed the health pass stores, and the machine card (the one it
 * runs on, else the gateway's own). Who is online is UniFi's own business: only the number of clients, never a list.
 * Read through its official API (`/v1/…`) with the connection's key; a device's firmware comes from its details when
 * the list lacks it (kept 10 minutes).
 */
import type {
  ThingLine,
  ThingPageBar,
  ThingPageItem,
  ThingPagePanel,
  ThingPageRow,
  ThingPageTab,
} from '@whombat/core';
import type { TrackedFacts } from '../../changes/diff';
import type { CatalogConnectionRow } from '../../connections/types';
import { EXPOSURE_NEW } from '../../exposure/check';
import type { ConnectionGlance } from '../../home/types';
import type { Services } from '../../services';
import { CLIENTS_KEY, GW_CPU_KEY, GW_MEM_KEY, readPoints } from '../points';
import { shortHash, someNames } from '../quiet/items';
import type { KindCheck, KindNotice } from '../quiet/types';
import {
  avgPeakLines,
  drawable,
  lastValue,
  onRange,
  type PageRange,
  RANGE_MS,
  type RawPoint,
  seriesStats,
  statsOf,
} from '../series';
import { clip, figure, figure1, line, list, num, pct, plural, rec, span, str, thousands } from '../words';
import { itemLines, lineId, statusOf, subjectName } from './home/lines';
import { cachedRead, getJson, KIND_DEADLINE_MS, latestRead, problemOf, withDeadline } from './read';
import type { KindSeen } from './registry';
import {
  countLine,
  dayKey,
  daysWith,
  type InventoryPanel,
  inventory,
  type LivePanel,
  lastDays,
  liveList,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from './slots';
import type { ChartPanel, KindCtx, KindView } from './types';

export const WAN_RX_KEY = 'wan_rx_mbps';
export const WAN_TX_KEY = 'wan_tx_mbps';

const NAME = 'UniFi';
const DETAILS_MAX = 60;
const DEVICES_MAX = 200;

export interface UnifiDevice {
  id: string;
  name: string;
  model: string;
  state: string;
  ip: string | null;
  accessPoint: boolean;
  /** A switch's ports (a gateway with ports has it too). */
  switching: boolean;
  gateway: boolean;
  firmware: string | null;
  updatable: boolean;
}

export interface UnifiGateway {
  id: string;
  name: string;
  cpuPct: number | null;
  memoryPct: number | null;
  uptimeS: number | null;
  rxMbps: number | null;
  txMbps: number | null;
}

export interface UnifiSnapshot {
  readAt: Date;
  version: string | null;
  devices: UnifiDevice[];
  clients: number | null;
  gateway: UnifiGateway | null;
  /** The list held as many devices as asked for: there may be more (QN-S21, an unread part never lifts an Ignore). */
  devicesCapped?: boolean;
  /** Some devices' details weren't read, so their firmware updates may be missing. */
  firmwareUnread?: boolean;
}

const GATEWAY_MODEL = /^(UDM|UCG|UXG|UDR|UDW|USG|EFG|UX\b|UCK-G2)/i;

function featureList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((f): f is string => typeof f === 'string');
  return Object.keys(rec(v));
}

/** A device of the list (with its details when they came). */
export function unifiDevice(raw: unknown, details: unknown = null): UnifiDevice {
  const d = rec(raw);
  const x = rec(details);
  const features = [...featureList(d.features), ...featureList(x.features)];
  const model = str(d.model) ?? str(x.model) ?? '';
  return {
    id: str(d.id) ?? '',
    name: str(d.name) ?? str(x.name) ?? (model || 'Device'),
    model,
    state: (str(d.state) ?? str(x.state) ?? 'UNKNOWN').toUpperCase(),
    ip: str(d.ipAddress) ?? str(x.ipAddress),
    accessPoint: features.includes('accessPoint'),
    switching: features.includes('switching'),
    gateway: features.includes('gateway') || GATEWAY_MODEL.test(model),
    firmware: str(d.firmwareVersion) ?? str(x.firmwareVersion),
    updatable: d.firmwareUpdatable === true || x.firmwareUpdatable === true,
  };
}

/** The gateway's latest statistics (rates in Mbit/s). */
export function unifiGateway(device: UnifiDevice, stats: unknown): UnifiGateway {
  const s = rec(stats);
  const uplink = rec(s.uplink);
  const rate = (v: unknown) => (num(v) !== null ? (num(v) as number) / 1e6 : null);
  return {
    id: device.id,
    name: device.name,
    cpuPct: num(s.cpuUtilizationPct),
    memoryPct: num(s.memoryUtilizationPct),
    uptimeS: num(s.uptimeSec),
    rxMbps: rate(uplink.rxRateBps),
    txMbps: rate(uplink.txRateBps),
  };
}

/** Reads UniFi Network: its version, the first site's devices and clients' count, the gateway's statistics. */
export async function readUnifi(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<UnifiSnapshot> {
  const get = (path: string, query?: Record<string, string>) => getJson(services, row, NAME, path, query);
  const [info, sites] = await Promise.all([get('/v1/info').catch(() => null), get('/v1/sites')]);
  const site = str(rec(list(rec(sites).data)[0]).id);
  if (!site)
    return {
      readAt: now,
      version: str(rec(info).applicationVersion),
      devices: [],
      clients: null,
      gateway: null,
    };
  const S = `/v1/sites/${encodeURIComponent(site)}`;
  const [devicesDoc, clientsDoc] = await Promise.all([
    get(`${S}/devices`, { limit: String(DEVICES_MAX) }),
    get(`${S}/clients`, { limit: '1' }).catch(() => null),
  ]);
  const raw = list(rec(devicesDoc).data);
  // Firmware: the list may lack it; a device's details have it (kept 10 minutes).
  let budget = DETAILS_MAX;
  const devices = await Promise.all(
    raw.map(async (d) => {
      const first = unifiDevice(d);
      if (first.firmware || !first.id || budget-- <= 0) return first;
      const details = await cachedRead(
        services,
        `unifi-device:${row.id}:${first.id}`,
        row,
        () => get(`${S}/devices/${encodeURIComponent(first.id)}`),
        10 * 60_000,
      ).catch(() => null);
      return unifiDevice(d, details);
    }),
  );
  const gw = devices.find((d) => d.gateway);
  const stats = gw
    ? await get(`${S}/devices/${encodeURIComponent(gw.id)}/statistics/latest`).catch(() => null)
    : null;
  return {
    readAt: now,
    version: str(rec(info).applicationVersion),
    devices,
    clients: num(rec(clientsDoc).totalCount),
    gateway: gw ? unifiGateway(gw, stats) : null,
    ...(raw.length >= DEVICES_MAX ? { devicesCapped: true } : {}),
    ...(budget < 0 ? { firmwareUnread: true } : {}),
  };
}

/** One read of UniFi within its deadline. */
function loadUnifi(services: Services, row: CatalogConnectionRow, now: Date) {
  return async (): Promise<UnifiSnapshot> => {
    try {
      return await withDeadline(
        readUnifi(services, row, now),
        KIND_DEADLINE_MS,
        'UniFi didn’t answer in time.',
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

/** UniFi's read, kept 30 seconds per connection. */
export function unifiSnapshot(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return cachedRead(services, `unifi:${row.id}`, row, loadUnifi(services, row, now));
}

/** UniFi's read for its page: the last one when a new one is slow (page-speed.md PS-01). */
export function unifiLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `unifi:${row.id}`, row, loadUnifi(services, row, now));
}

/* What it means ------------------------------------------------------------------------------------------------------- */

const online = (d: UnifiDevice) => d.state === 'ONLINE';
const offline = (d: UnifiDevice) => d.state === 'OFFLINE' || d.state === 'CONNECTION_INTERRUPTED';

/**
 * The tile (CP-16): the internet line, access points online, clients; the dot and the reason from Worth a look's lines
 * that aren't heads-ups (quiet-notices.md QN-02; the health pass works them out again with what is ignored).
 */
export function unifiGlanceOf(
  s: UnifiSnapshot,
  notices: readonly KindNotice[] = unifiNotices(s),
): Omit<ConnectionGlance, 'status'> & { status: 'ok' | 'warn' | 'bad' } {
  const facts: ConnectionGlance['facts'] = [];
  const g = s.gateway;
  if (g?.rxMbps != null && g.txMbps != null)
    facts.push({
      label: 'Internet',
      value: `${Math.round(g.rxMbps)} / ${Math.round(g.txMbps)}`,
      unit: 'Mb/s',
    });
  const aps = s.devices.filter((d) => d.accessPoint);
  if (aps.length)
    facts.push({
      label: 'Access points',
      value: `${aps.filter(online).length} of ${aps.length}`,
      note: 'online',
    });
  if (s.clients !== null) facts.push({ label: 'Clients', value: String(s.clients) });
  return {
    ...statusOf(notices),
    line: s.devices.length
      ? plural(s.devices.length, 'device')
      : s.clients !== null
        ? plural(s.clients, 'client')
        : 'UniFi',
    facts,
  };
}

/** A gateway busier than this (CPU %) is worth a look. */
export const BUSY_PCT = 80;
/** A busy gateway is an average over this window, not one reading (QN-04). */
export const BUSY_WINDOW_MS = 30 * 60_000;
/** Readings within the window (the health pass keeps one every 5 minutes) for a busy gateway to count as lasting. */
export const BUSY_READINGS = 4;

/** The gateway's CPU over the last half hour: its average and how many readings it is of (the current one included). */
export interface GatewayCpu {
  avg: number | null;
  readings: number;
}

/** The gateway's CPU over `BUSY_WINDOW_MS` from the points the health pass kept and the reading of now. */
export function gatewayCpuOf(points: readonly RawPoint[], current: number | null, now: Date): GatewayCpu {
  const from = now.getTime() - BUSY_WINDOW_MS;
  const xs = points
    .filter((p) => p.value !== null && Number.isFinite(p.value) && p.at.getTime() >= from && p.at <= now)
    .map((p) => p.value as number);
  if (current !== null) xs.push(current);
  return { avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, readings: xs.length };
}

/** The gateway's CPU points over the busy window (empty when they can't be read: `null`). */
export async function gatewayCpuPoints(
  services: Services,
  connectionId: string,
  now: Date,
): Promise<RawPoint[] | null> {
  return readPoints(services.db, connectionId, [GW_CPU_KEY], now, BUSY_WINDOW_MS)
    .then((m) => m.get(GW_CPU_KEY) ?? [])
    .catch(() => null);
}

/** Every check UniFi Network raises (What Whombat watches, QN-15). */
export const UNIFI_CHECKS: readonly KindCheck[] = [
  {
    check: 'unifi.gateway_offline',
    name: 'The gateway going offline',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  {
    check: 'unifi.device_offline',
    name: 'Access points and switches going offline',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  { check: 'unifi.gateway_busy', name: 'A busy gateway', nature: 'problem', perItem: false, startsOn: false },
  { check: 'unifi.firmware', name: 'Firmware updates', nature: 'fyi', perItem: false, startsOn: false },
  // Something new is open to the internet: a new opening in its settings (internet-exposure.md).
  EXPOSURE_NEW,
];

const BACK_ONLINE = { lifts: 'fixed', words: 'Until it’s back online.' } as const;
const deviceSubject = (d: UnifiDevice) => ({
  id: `device:${d.id || d.name}`.slice(0, 160),
  name: subjectName(d.name),
});

/**
 * Worth a look (QN-01…QN-04): the gateway offline; one line per other device offline (Ignore until it's back online),
 * both only after two passes in a row (a firmware update's reboot); the gateway busy, a problem when its CPU averaged
 * 80 % over the last half hour, a heads-up for a peak; a firmware update per device, a heads-up until the next one.
 */
export function unifiNotices(s: UnifiSnapshot, cpu?: GatewayCpu): KindNotice[] {
  const out: KindNotice[] = [];
  const down = s.devices.filter(offline);
  const gw = down.find((d) => d.gateway);
  if (gw)
    out.push({
      id: 'gateway-offline',
      tone: 'bad',
      icon: 'network',
      title: clip(`The gateway ${gw.name} is offline`, 120),
      detail: 'The whole network may be without internet.',
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: clip(`Why is the UniFi gateway ${gw.name} offline?`, 300),
      },
      nature: 'problem',
      check: 'unifi.gateway_offline',
      ignore: BACK_ONLINE,
      confirm: 2,
      badge: 'The gateway is offline',
    });
  const others = down.filter((d) => !d.gateway).sort((a, b) => a.name.localeCompare(b.name));
  out.push(
    ...itemLines(
      others,
      (d) => deviceSubject(d).id,
      (d) => {
        const title = clip(`${d.name} is offline`, 120);
        return {
          id: lineId('offline', d.id || d.name),
          tone: 'warn',
          icon: 'network',
          title,
          // The model and address are in the Devices table; the line says what happened, its state only when it says
          // more than the title's “is offline” (“Connection lost”).
          ...(d.state !== 'OFFLINE' && STATE_WORDS[d.state] ? { detail: STATE_WORDS[d.state] } : {}),
          link: {
            kind: 'ask',
            label: 'Look into it',
            question: clip(`Why is ${d.name} offline in UniFi?`, 300),
          },
          nature: 'problem',
          check: 'unifi.device_offline',
          subject: deviceSubject(d),
          ignore: BACK_ONLINE,
          confirm: 2,
          ...(title.length > 40
            ? { badge: d.accessPoint ? 'An access point is offline' : 'A device is offline' }
            : {}),
        };
      },
      (more, subject, episode) => ({
        id: 'offline-more',
        tone: 'warn',
        icon: 'network',
        title: `${more.length} more ${more.every((d) => d.accessPoint) ? 'access points' : 'devices'} offline`,
        detail: clip(more.map((d) => d.name).join(' · '), 200),
        link: { kind: 'ask', label: 'Look into it', question: 'Why are some UniFi devices offline?' },
        nature: 'problem',
        check: 'unifi.device_offline',
        subject,
        ignore: { lifts: 'newer', words: 'Until the list changes.' },
        episode,
        confirm: 2,
        badge: 'Devices are offline',
      }),
    ),
  );
  const now = s.gateway?.cpuPct ?? null;
  const lasting = cpu && cpu.readings >= BUSY_READINGS && cpu.avg !== null && cpu.avg >= BUSY_PCT;
  if (lasting && cpu?.avg != null)
    out.push({
      id: 'gateway-busy',
      tone: 'warn',
      icon: 'network',
      title: 'The gateway has been working hard for half an hour',
      detail: `${pct(cpu.avg)} busy on average${now !== null ? `, ${pct(now)} now` : ''}.`,
      link: { kind: 'ask', label: 'Look into it', question: 'Why is the UniFi gateway so busy?' },
      nature: 'problem',
      check: 'unifi.gateway_busy',
      ignore: { lifts: 'fixed', words: 'Until it calms down.' },
      badge: 'The gateway is busy',
    });
  else if (now !== null && now >= BUSY_PCT)
    out.push({
      id: 'gateway-busy',
      tone: 'info',
      icon: 'network',
      title: 'The gateway is busy right now',
      detail:
        cpu?.avg != null && cpu.readings > 1
          ? `${pct(now)} busy now; ${pct(cpu.avg)} on average over the last half hour.`
          : `${pct(now)} busy now.`,
      nature: 'fyi',
      check: 'unifi.gateway_busy',
      ignore: { lifts: 'fixed', words: 'Until it calms down.' },
    });
  // Firmware is one line, however many devices have it (a heads-up per device made the card a list); its Ignore lasts
  // while the same devices wait for the same firmware.
  const updates = s.devices.filter((d) => d.updatable).sort((a, b) => a.name.localeCompare(b.name));
  const first = updates[0];
  if (first)
    out.push({
      id: 'firmware',
      tone: 'info',
      icon: 'update',
      title:
        updates.length === 1
          ? clip(`${first.name} has an update`, 120)
          : `${plural(updates.length, 'device')} have updates`,
      ...(updates.length > 1 ? { detail: clip(someNames(updates.map((d) => d.name)), 200) } : {}),
      nature: 'fyi',
      check: 'unifi.firmware',
      ignore: { lifts: 'newer', words: 'Until there’s newer firmware.' },
      episode: shortHash(updates.map((d) => `${deviceSubject(d).id}@${d.firmware ?? ''}`)),
    });
  return out;
}

/** The checks this read couldn't fully see (QN-S21): a capped device list, devices without details, no CPU reading. */
export function unifiSkipped(s: UnifiSnapshot, cpuRead: boolean): string[] {
  const out: string[] = [];
  if (s.devicesCapped) out.push('unifi.gateway_offline', 'unifi.device_offline', 'unifi.firmware');
  else if (s.firmwareUnread) out.push('unifi.firmware');
  if (!s.gateway || s.gateway.cpuPct === null || !cpuRead) out.push('unifi.gateway_busy');
  return out;
}

/** The points the health pass keeps: the line's down and up, the gateway's CPU and memory, the clients. */
export function unifiSeenPoints(s: UnifiSnapshot): Record<string, number | null> {
  return {
    ...(s.gateway
      ? {
          [WAN_RX_KEY]: s.gateway.rxMbps,
          [WAN_TX_KEY]: s.gateway.txMbps,
          [GW_CPU_KEY]: s.gateway.cpuPct,
          [GW_MEM_KEY]: s.gateway.memoryPct,
        }
      : {}),
    ...(s.clients !== null ? { [CLIENTS_KEY]: s.clients } : {}),
  };
}

/** The health pass's look (SD-05, QN-S20): the card, the points, Worth a look's lines as the page shows them. */
export async function unifiSeen(services: Services, row: CatalogConnectionRow, now: Date): Promise<KindSeen> {
  const [s, cpuPoints] = await Promise.all([
    unifiSnapshot(services, row, now),
    gatewayCpuPoints(services, row.id, now),
  ]);
  const notices = unifiNotices(s, gatewayCpuOf(cpuPoints ?? [], s.gateway?.cpuPct ?? null, now));
  return {
    glance: unifiGlanceOf(s, notices),
    points: unifiSeenPoints(s),
    notices,
    skipped: unifiSkipped(s, cpuPoints !== null),
    tracked: unifiTracked(s),
  };
}

/**
 * What the change log compares (docs/decisions/outside-changes.md): UniFi Network's version and each device's firmware
 * by its name; the firmware is left as it was when this read couldn't see it.
 */
export function unifiTracked(s: UnifiSnapshot): TrackedFacts {
  const firmware: Record<string, string> = {};
  for (const d of s.devices) if (d.firmware) firmware[d.name] = d.firmware;
  return { version: s.version ?? null, firmware: s.firmwareUnread ? null : firmware };
}

const STATE_WORDS: Record<string, string> = {
  ONLINE: 'Online',
  OFFLINE: 'Offline',
  PENDING_ADOPTION: 'Waiting to be adopted',
  UPDATING: 'Updating',
  GETTING_READY: 'Getting ready',
  ADOPTING: 'Adopting',
  DELETING: 'Being removed',
  CONNECTION_INTERRUPTED: 'Connection lost',
  ISOLATED: 'Isolated',
};

export function unifiDeviceRows(s: UnifiSnapshot): ThingPageRow[] {
  const rank = (d: UnifiDevice) => (offline(d) ? 0 : d.gateway ? 1 : 2);
  return s.devices
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, 300)
    .map((d) => ({
      id: (d.id || d.name).slice(0, 200),
      cells: {
        name: { text: clip(d.name, 200) },
        model: { text: d.model, mono: true },
        state: {
          text: STATE_WORDS[d.state] ?? d.state.toLowerCase(),
          dot: online(d) ? ('ok' as const) : offline(d) ? ('bad' as const) : ('warn' as const),
        },
        address: { text: d.ip ?? '', mono: true },
        firmware: {
          text: d.firmware ?? '',
          mono: true,
          ...(d.updatable ? { note: 'update', tone: 'warn' as const } : {}),
        },
      },
    }));
}

const DEVICE_COLUMNS = [
  { key: 'name', label: 'Device' },
  { key: 'model', label: 'Model' },
  { key: 'state', label: 'State' },
  { key: 'address', label: 'Address' },
  { key: 'firmware', label: 'Firmware' },
];

export function unifiFacts(s: UnifiSnapshot): ThingLine[] {
  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`UniFi Network **${s.version}**`));
  if (s.gateway?.uptimeS != null) facts.push(line(`Gateway up **${span(s.gateway.uptimeS * 1000)}**`));
  return facts;
}

/** The internet line over the range and the gateway's CPU as kept (its half-hour average), from the health pass's points. */
export async function unifiPoints(
  services: Services,
  connectionId: string,
  range: PageRange,
  now: Date,
): Promise<{
  timestamps: string[];
  down: (number | null)[];
  up: (number | null)[];
  /** The gateway's CPU as kept, for its half-hour average (every range is at least an hour). */
  cpuRaw: RawPoint[];
}> {
  const keys = [WAN_RX_KEY, WAN_TX_KEY, GW_CPU_KEY];
  const points = await readPoints(services.db, connectionId, keys, now, RANGE_MS[range]);
  const grid = onRange(
    keys.slice(0, 2).map((k) => points.get(k) ?? []),
    range,
    now,
  );
  const [down, up] = grid.values as (number | null)[][];
  return {
    timestamps: grid.timestamps,
    down: down ?? [],
    up: up ?? [],
    cpuRaw: points.get(GW_CPU_KEY) ?? [],
  };
}

/** Two weeks of the line's download speed and the clients, for this week's days and the week before (DB only). */
export const HISTORY_MS = 14 * 86_400_000;

export async function unifiHistory(
  services: Services,
  connectionId: string,
  now: Date,
): Promise<Map<string, RawPoint[]> | null> {
  return readPoints(services.db, connectionId, [WAN_RX_KEY, CLIENTS_KEY], now, HISTORY_MS).catch(() => null);
}

const mbs = (n: number) => `${figure(Math.round(n * 10) / 10)} Mb/s`;

/** The internet line down and up over the page's range (below the slots: it follows the range). */
export function unifiInternetChart(
  p: Pick<Awaited<ReturnType<typeof unifiPoints>>, 'timestamps' | 'down' | 'up'>,
  s: UnifiSnapshot | null,
  now: Date,
  timeZone: string,
): ChartPanel | null {
  if (!drawable(p.down)) return null;
  const down = s?.gateway?.rxMbps ?? lastValue(p.down);
  const up = s?.gateway?.txMbps ?? lastValue(p.up);
  return {
    kind: 'chart',
    id: 'internet',
    title: 'Internet',
    timestamps: p.timestamps,
    series: [
      {
        key: 'down',
        label: 'Down',
        unit: 'Mb/s',
        values: p.down,
        color: 'green',
        fill: true,
        ...(down !== null ? { latest: mbs(down) } : {}),
      },
      {
        key: 'up',
        label: 'Up',
        unit: 'Mb/s',
        values: p.up,
        color: 'orange',
        ...(up !== null ? { latest: mbs(up) } : {}),
      },
    ],
    ...(down !== null
      ? { figure: { value: mbs(down), rest: up !== null ? `down · ${mbs(up)} up` : 'down' } }
      : {}),
    ...statsOf(avgPeakLines(seriesStats(p.down, p.timestamps), mbs, now, timeZone)),
    axis: { min: 0, unit: 'Mb/s' },
  };
}

/** The longest a reading stands for: the health pass keeps one every 5 minutes, an hour's average after 48 hours. */
const READING_MAX_MS = 3600_000;
/** The newest reading stands for one pass. */
const PASS_MS = 5 * 60_000;

/**
 * About how much came down the line per day, in GB, from Whombat's readings of its speed (Mb/s): each reading counts
 * until the next one (at most an hour, the newest one pass), so a day Whombat watched only part of counts that part.
 * Null for a day without a reading. An estimate: a burst between two readings is missed. Pure.
 */
export function downloadedByDay(
  points: readonly RawPoint[],
  keys: readonly string[],
  timeZone: string,
  now: Date,
): (number | null)[] {
  const index = new Map(keys.map((k, i) => [k, i]));
  const out: (number | null)[] = keys.map(() => null);
  const xs = points.filter((p) => p.value !== null && Number.isFinite(p.value) && p.at <= now);
  xs.forEach((p, i) => {
    const k = index.get(dayKey(p.at, timeZone));
    if (k === undefined) return;
    const next = xs[i + 1]?.at.getTime() ?? Math.min(now.getTime(), p.at.getTime() + PASS_MS);
    const ms = Math.max(0, Math.min(next - p.at.getTime(), READING_MAX_MS));
    // Mb/s × seconds is megabits; ÷ 8 000 is gigabytes.
    out[k] = (out[k] ?? 0) + ((p.value as number) * (ms / 1000)) / 8000;
  });
  return out;
}

const gbWords = (gb: number) => (gb >= 1000 ? `${figure1(gb / 1000)} TB` : `${thousands(Math.round(gb))} GB`);

/** The highest reading on today's day, or null. */
function busiestToday(points: readonly RawPoint[], now: Date, timeZone: string): number | null {
  const today = dayKey(now, timeZone);
  const xs = points
    .filter((p) => p.value !== null && Number.isFinite(p.value) && dayKey(p.at, timeZone) === today)
    .map((p) => p.value as number);
  return xs.length ? Math.max(...xs) : null;
}

export interface UnifiInput {
  snapshot: UnifiSnapshot;
  /** The internet line over the page's range and the gateway's CPU readings; null when they can't be read. */
  points: Awaited<ReturnType<typeof unifiPoints>> | null;
  /** Two weeks of `wan_rx_mbps` and `clients`; null when they can't be read. */
  history: Map<string, RawPoint[]> | null;
  now: Date;
  timeZone: string;
  /** Whombat knows the machine the controller runs on (UniFi OS Server): its card, else the gateway's own. */
  machineKnown: boolean;
}

const switchOnly = (d: UnifiDevice) => d.switching && !d.gateway && !d.accessPoint;

/**
 * The network now (Live): the internet line, what is connected and the devices online, each with its figure (a live
 * list draws the figure on the right and the detail under the title; the note is the desk's small line). When the
 * controller runs on a machine Whombat knows, the gateway's own load too: nothing else on the page says it.
 */
export function unifiLive(input: UnifiInput): LivePanel | null {
  const { snapshot: s, history, now, timeZone } = input;
  const g = s.gateway;
  const items: ThingPageItem[] = [];
  if (g?.rxMbps != null && g.txMbps != null) {
    const busiest = busiestToday(history?.get(WAN_RX_KEY) ?? [], now, timeZone);
    items.push(
      countLine({
        id: 'internet',
        title: 'Internet',
        icon: 'network',
        value: `${Math.round(g.rxMbps)} / ${Math.round(g.txMbps)} Mb/s`,
        note: 'down · up now',
        detail:
          busiest !== null ? `Down · up now · busiest today ${Math.round(busiest)} Mb/s` : 'Down · up now',
      }),
    );
  }
  if (s.clients !== null) {
    const most = busiestToday(history?.get(CLIENTS_KEY) ?? [], now, timeZone);
    items.push(
      countLine({
        id: 'clients',
        title: 'Connected now',
        icon: 'device',
        value: thousands(s.clients),
        note: 'phones, laptops and more',
        detail:
          most !== null && most > s.clients
            ? `Phones, laptops and more · most today ${thousands(Math.round(most))}`
            : 'Phones, laptops and more',
      }),
    );
  }
  if (s.devices.length) {
    const down = s.devices.filter(offline);
    const up = s.devices.filter(online).length;
    // Which ones are offline is Worth a look's to say, each with its Ignore (servers-connections-places.md):
    // here only how many, under the count.
    const words = down.length ? `${down.length} offline` : 'All online';
    items.push(
      countLine({
        id: 'online',
        title: 'Devices online',
        icon: 'network',
        value: `${up} of ${s.devices.length}`,
        detail: 'Access points, switches and the gateway',
        ...(down.length
          ? { tone: 'warn' as const, note: words, noteTone: 'warn' as const }
          : { note: words }),
      }),
    );
  }
  if (input.machineKnown && g?.cpuPct != null)
    items.push(
      countLine({
        id: 'gateway',
        title: 'Gateway',
        icon: 'network',
        value: pct(g.cpuPct),
        note: 'busy now',
        detail: [`${clip(g.name, 60)} busy now`, g.memoryPct != null ? `memory ${pct(g.memoryPct)}` : null]
          .filter(Boolean)
          .join(' · '),
        ...(g.cpuPct >= BUSY_PCT ? { tone: 'warn' as const, noteTone: 'warn' as const } : {}),
      }),
    );
  if (!items.length) return null;
  return liveList({
    id: 'now',
    title: 'The network now',
    ...(g?.uptimeS != null ? { meta: `Gateway up ${span(g.uptimeS * 1000)}` } : {}),
    items,
  });
}

/** On the network (Inventory): access points, switches, the gateway, the rest, and the updates waiting. */
export function unifiInventory(s: UnifiSnapshot): InventoryPanel | null {
  if (!s.devices.length) return null;
  const items: ThingPageItem[] = [];
  const aps = s.devices.filter((d) => d.accessPoint);
  const switches = s.devices.filter(switchOnly);
  const gateways = s.devices.filter((d) => d.gateway);
  const other = s.devices.filter((d) => !d.accessPoint && !d.gateway && !switchOnly(d));
  const offNote = (xs: readonly UnifiDevice[]) => {
    const down = xs.filter(offline).length;
    return down ? { note: `${down} offline`, noteTone: 'warn' as const } : { note: 'All online' };
  };
  if (aps.length)
    items.push(
      countLine({
        id: 'access-points',
        title: 'Access points',
        icon: 'network',
        value: thousands(aps.length),
        ...offNote(aps),
      }),
    );
  if (switches.length)
    items.push(
      countLine({
        id: 'switches',
        title: 'Switches',
        icon: 'network',
        value: thousands(switches.length),
        ...offNote(switches),
      }),
    );
  const gw = gateways[0];
  if (gw)
    items.push(
      countLine({
        id: 'gateway',
        title: gateways.length === 1 ? 'Gateway' : 'Gateways',
        icon: 'network',
        value: thousands(gateways.length),
        ...(gw.model ? { detail: clip(gateways.map((d) => d.model).join(' · '), 120) } : {}),
        ...offNote(gateways),
      }),
    );
  if (other.length)
    items.push(
      countLine({
        id: 'other',
        title: 'Other devices',
        icon: 'device',
        value: thousands(other.length),
        ...offNote(other),
      }),
    );
  const updates = s.devices.filter((d) => d.updatable).sort((a, b) => a.name.localeCompare(b.name));
  const first = updates[0];
  if (first)
    items.push(
      countLine({
        id: 'updates',
        title: 'Updates waiting',
        icon: 'update',
        value: thousands(updates.length),
        detail: clip(
          updates.length === 1 && first.firmware
            ? `${first.name} · ${first.firmware} now`
            : someNames(updates.map((d) => d.name)),
          200,
        ),
        // Grey: an update waiting isn't a problem (the mock's “firmware”).
        note: 'Firmware',
      }),
    );
  return inventory({
    id: 'equipment',
    title: 'On the network',
    meta: plural(s.devices.length, 'device'),
    ...(s.devices.length > SUMMARY_DEVICES
      ? { link: { kind: 'tab' as const, label: 'All devices', tab: 'devices' } }
      : {}),
    items,
  });
}

/**
 * Internet this week (Trend): about how much came down the line per day, from Whombat's readings of its speed, with
 * the change on the week before once every day of it was read. Left out under two days.
 */
export function unifiWeek(input: Pick<UnifiInput, 'history' | 'now' | 'timeZone'>): TrendPanel | null {
  const { history, now, timeZone } = input;
  const points = history?.get(WAN_RX_KEY) ?? [];
  if (!points.length) return null;
  const days = lastDays(now, timeZone);
  const values = downloadedByDay(points, days.keys, timeZone, now);
  if (daysWith(values) < 2) return null;
  // The week before up to the same moment, so today's part-day weighs against the same part.
  const then = new Date(now.getTime() - 7 * 86_400_000);
  const before = downloadedByDay(points, lastDays(then, timeZone).keys, timeZone, then);
  const total = values.reduce<number>((a, v) => a + (v ?? 0), 0);
  const prior = before.reduce<number>((a, v) => a + (v ?? 0), 0);
  return trend({
    id: 'week',
    title: 'Internet this week',
    meta: 'About, from Whombat’s readings',
    days,
    values: values.map((v) => (v === null ? null : Math.round(v * 10) / 10)),
    label: 'Downloaded',
    unit: 'GB',
    figure: { value: `about ${gbWords(total)}`, rest: 'down this week' },
    change: daysWith(before) === 7 ? weekChange(total, prior) : null,
    color: 'green',
  });
}

/**
 * UniFi's own lines in the machine card: the gateway's memory when its own figures make the card (UniFi gives a share,
 * no sizes), the controller's version, the gateway's firmware, and how long the gateway has been up.
 */
export function unifiMachineLines(s: UnifiSnapshot, machineKnown: boolean): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  const g = s.gateway;
  if (!machineKnown && g?.memoryPct != null)
    out.push({
      id: 'gateway-memory',
      label: 'Memory',
      value: pct(g.memoryPct),
      pct: Math.min(1, Math.max(0, g.memoryPct / 100)),
      ...(g.memoryPct >= 90 ? { tone: 'warn' as const } : {}),
    });
  if (s.version)
    out.push({ id: 'unifi-version', label: 'UniFi Network', value: clip(s.version, 40), pct: null });
  const gw = s.devices.find((d) => d.gateway);
  if (gw?.firmware)
    out.push({
      id: 'gateway-firmware',
      label: 'Gateway firmware',
      value: clip(gw.firmware, 40),
      mono: true,
      pct: null,
      ...(gw.updatable ? { sub: 'An update is waiting', subTone: 'warn' as const } : { sub: 'Up to date' }),
    });
  if (g?.uptimeS != null)
    out.push({ id: 'gateway-up', label: 'Gateway up', value: span(g.uptimeS * 1000), pct: null });
  return out;
}

/** The Summary's devices: offline ones first, then the gateway, at most ten (the Devices tab has them all). */
export const SUMMARY_DEVICES = 10;

/**
 * The Summary in slots (docs/decisions/service-slots.md): the network now beside what is on it, the internet this week;
 * no shelf (no pictures) and no people (who is online is UniFi's own business, CP-09). The internet over the range
 * and the Devices table below them. The machine card is the one it runs on, else the gateway's own figures.
 */
export function unifiSlots(input: UnifiInput): Pick<KindView, 'panels' | 'slots'> {
  const { snapshot: s, points, now, timeZone } = input;
  const chart = points ? unifiInternetChart(points, s, now, timeZone) : null;
  const down = s.devices.filter(offline);
  const more: ThingPagePanel[] = [
    ...(chart ? [chart] : []),
    ...(s.devices.length
      ? [
          {
            kind: 'table' as const,
            id: 'devices',
            title: 'Devices',
            meta: down.length ? `${down.length} offline` : 'all online',
            ...(s.devices.length > SUMMARY_DEVICES
              ? { link: { kind: 'tab' as const, label: 'All devices', tab: 'devices' } }
              : {}),
            columns: DEVICE_COLUMNS,
            rows: unifiDeviceRows(s).slice(0, SUMMARY_DEVICES),
          },
        ]
      : []),
  ];
  const out = slotPanels({
    live: unifiLive(input),
    inventory: unifiInventory(s),
    trend: unifiWeek(input),
    more,
    machine: unifiMachineLines(s, input.machineKnown),
  });
  // A console (UCG, UDM): the controller runs on the gateway, so the gateway's own figures make the card.
  const g = s.gateway;
  const gw = s.devices.find((d) => d.gateway);
  if (input.machineKnown || !g || g.cpuPct === null) return out;
  return {
    ...out,
    slots: {
      machine: out.slots?.machine ?? [],
      own: {
        figures: {
          cpuPct: g.cpuPct,
          cores: null,
          memoryUsedGb: null,
          memoryTotalGb: null,
          diskUsedGb: null,
          diskTotalGb: null,
          series: null,
        },
        name: clip(gw?.model ? `${g.name} · ${gw.model}` : g.name, 60),
      },
    },
  };
}

/** The page's UniFi part from what was read; pure. */
export function unifiView(input: UnifiInput): Omit<KindView, 'open' | 'suggestions'> {
  const { snapshot: s, points, now } = input;
  const rows = unifiDeviceRows(s);
  const tabs: ThingPageTab[] = s.devices.length
    ? [
        {
          key: 'devices',
          label: 'Devices',
          count: s.devices.length,
          panels: [{ kind: 'table', id: 'devices', title: 'Devices', columns: DEVICE_COLUMNS, rows }],
        },
      ]
    : [];
  return {
    // In slots its figures are in The network now and On the network; the card keeps its own (`unifiGlanceOf`).
    kpis: [],
    charts: [],
    machine: 'after',
    // Without the points the half hour is unknown: a busy gateway is a heads-up then.
    notices: unifiNotices(s, gatewayCpuOf(points?.cpuRaw ?? [], s.gateway?.cpuPct ?? null, now)),
    ...unifiSlots(input),
    tabs,
    facts: unifiFacts(s),
    actions: [],
    readAt: s.readAt,
  };
}

export async function unifiPage(ctx: KindCtx): Promise<KindView> {
  const base = {
    open: {
      label: 'Open UniFi',
      url: (ctx.row.fields.url ?? ctx.row.baseUrl.replace(/\/proxy\/network\/integration$/, '')).replace(
        /\/+$/,
        '',
      ),
    },
    suggestions: ['Gateway CPU', 'Clients over the day', 'Internet speed'],
  };
  const [points, history, read] = await Promise.all([
    unifiPoints(ctx.services, ctx.row.id, ctx.range, ctx.now).catch(() => null),
    unifiHistory(ctx.services, ctx.row.id, ctx.now),
    unifiLatest(ctx.services, ctx.row, ctx.now),
  ]);
  if (read.ok)
    return {
      ...base,
      ...unifiView({
        snapshot: read.value,
        points,
        history,
        now: ctx.now,
        timeZone: ctx.timeZone,
        machineKnown: !!ctx.machine?.figures,
      }),
      refreshing: read.refreshing,
    };
  // Nothing read: the page of a connection without a kind (how it answers) says the rest.
  return {
    ...base,
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    actions: [],
    readAt: null,
    problem: problemOf(read.error, NAME).message,
    refreshing: read.refreshing,
  };
}
