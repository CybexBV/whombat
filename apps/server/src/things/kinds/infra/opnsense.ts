/**
 * OPNsense's page (service-dashboards.md SD-40, SD-S06, SD-S16): the internet line (the default gateway's delay and
 * loss, now and over the range from the points the health pass keeps), CPU, memory and the firewall's open
 * connections; its gateways, services (buttons **Start** and **Restart**✱) and WireGuard peers; what OPNsense itself
 * says (its notices, a firmware update, a restart it needs). Read with the API key and secret, GETs only (25.7+ names,
 * snake_case): `/api/routes/gateway/status`, `/api/routing/settings/search_gateway` (which is the default),
 * `/api/core/system/status`, `/api/core/firmware/status`, `/api/core/service/search`,
 * `/api/diagnostics/system/system_resources`, `/api/diagnostics/activity/get_activity` (CPU, kept a minute),
 * `/api/diagnostics/system/system_time`, `/api/diagnostics/firewall/pf_states`, `/api/wireguard/service/show`. Its
 * certificates are left out: `/api/trust/cert/search` answers their private keys (SD-S16). The head's **Check for
 * updates** only checks; never updates, upgrades, reboots or powers off.
 */
import type {
  ThingLine,
  ThingPageBar,
  ThingPageCell,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageRow,
  ThingTone,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { EXPOSURE_NEW } from '../../../exposure/check';
import { ApiError, badRequest } from '../../../lib/errors';
import type { Services } from '../../../services';
import { readPoints } from '../../points';
import { shortHash } from '../../quiet/items';
import type { KindCheck, KindNotice } from '../../quiet/types';
import {
  avgPeakLines,
  downsample,
  drawable,
  onRange,
  type PageRange,
  RANGE_MS,
  type RawPoint,
  seriesStats,
  statFigure,
  statsOf,
} from '../../series';
import { bytes, clip, line, list, num, pct, plural, rec, span, str, thousands } from '../../words';
import { actAs } from '../act';
import { type PageButton, pageButton } from '../buttons';
import { cachedRead, getJson } from '../read';
import type { KindAction, KindModule } from '../registry';
import {
  countLine,
  daysWith,
  type InventoryPanel,
  inventory,
  type LivePanel,
  lastDays,
  liveList,
  type PeoplePanel,
  people,
  pointsByDay,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from '../slots';
import type { ChartPanel, KindCtx, KindView } from '../types';
import {
  type ButtonCtx,
  badgeOf,
  cardOf,
  idOf,
  itemLines,
  linesSeen,
  notOffered,
  okStatus,
  optional,
  serviceUrl,
  snapshotReader,
  uniqueById,
  unreadView,
} from './shared';

const NAME = 'OPNsense';
/** The points the health pass keeps (SD-S06): the default gateway's delay (ms) and loss (%). */
export const GW_DELAY_KEY = 'gw_delay_ms';
export const GW_LOSS_KEY = 'gw_loss_pct';
const CPU_CACHE_MS = 60_000;
/** A gateway losing more than this is worth a look (SD-40). */
const LOSS_WARN = 5;
/** A WireGuard peer is online with a handshake this recent (OPNsense's own rule). */
const HANDSHAKE_S = 300;

export type GatewayState = 'online' | 'down' | 'loss' | 'delay' | 'delay+loss' | 'pending';

export interface OpnGateway {
  name: string;
  state: GatewayState;
  /** Switched off by hand in OPNsense (`force_down`): down on purpose (QN-04). */
  forced: boolean;
  delayMs: number | null;
  lossPct: number | null;
  monitored: boolean;
  ipv6: boolean;
}

export interface OpnService {
  /** `unbound`, or `openvpn/3` for one of several. */
  id: string;
  name: string;
  running: boolean;
  /** Not to be started or stopped from outside. */
  locked: boolean;
}

export interface OpnNotice {
  key: string;
  title: string;
  message: string | null;
  level: 'error' | 'warning' | 'notice';
}

export interface OpnPeer {
  key: string;
  name: string;
  iface: string | null;
  handshakeAgeS: number | null;
  /** Bytes received and sent since its interface came up (`transfer-rx` + `transfer-tx`); null when not said. */
  bytes?: number | null;
}

export interface OpnFirmware {
  version: string | null;
  /** “update” or “upgrade” with what is waiting; null when nothing (or never checked). */
  waiting: { latest: string | null; packages: number; major: string | null } | null;
  needsReboot: boolean;
}

export interface OpnSnapshot {
  readAt: Date;
  gateways: OpnGateway[] | null;
  /** The default (IPv4) gateway's name. */
  defaultGateway: string | null;
  services: OpnService[] | null;
  notices: OpnNotice[];
  firmware: OpnFirmware | null;
  cpuPct: number | null;
  memory: { used: number; total: number } | null;
  states: { current: number; limit: number | null } | null;
  peers: OpnPeer[] | null;
  uptime: string | null;
  /** Its own messages (`/api/core/system/status`) couldn't be read: their lines don't look fixed (QN-11). */
  statusUnread?: boolean;
}

/* Reading -------------------------------------------------------------------------------------------------------------- */

const STATES: Record<string, GatewayState> = {
  none: 'online',
  down: 'down',
  force_down: 'down',
  loss: 'loss',
  delay: 'delay',
  'delay+loss': 'delay+loss',
};

/** “4.2 ms”, “0.0 %”, “~” → 4.2, 0, null. */
const figureOf = (v: unknown): number | null => {
  const m = /^\s*(-?[\d.]+)/.exec(str(v) ?? '');
  return m ? num(m[1]) : null;
};

/** `/api/routes/gateway/status` (`{items, status}`): OPNsense's order, the default first. */
export function parseGateways(body: unknown): OpnGateway[] {
  return list(rec(body).items)
    .slice(0, 50)
    .map((raw): OpnGateway | null => {
      const g = rec(raw);
      const name = str(g.name);
      if (!name) return null;
      const delayMs = figureOf(g.delay);
      const status = (str(g.status) ?? '').toLowerCase();
      return {
        name: clip(name, 80),
        state: STATES[status] ?? 'pending',
        forced: status === 'force_down',
        delayMs,
        lossPct: figureOf(g.loss),
        monitored: delayMs !== null,
        ipv6: (str(g.address) ?? '').includes(':') || (str(g.monitor) ?? '').includes(':'),
      };
    })
    .filter((g): g is OpnGateway => g !== null);
}

/** `/api/routing/settings/search_gateway`: the default IPv4 gateway (`defaultgw`), else the first IPv4 default. */
export function parseDefaultGateway(body: unknown): string | null {
  const rows = list(rec(body).rows).map(rec);
  const defaults = rows.filter((r) => r.defaultgw === true || r.defaultgw === '1');
  const v4 = defaults.find((r) => str(r.ipprotocol) !== 'inet6') ?? defaults[0];
  return v4 ? str(v4.name) : null;
}

/** `/api/core/service/search` (`{rows: [{id, name, description, running, locked}]}`). */
export function parseServices(body: unknown): OpnService[] {
  return list(rec(body).rows)
    .slice(0, 100)
    .map((raw): OpnService | null => {
      const s = rec(raw);
      const id = str(s.id) ?? str(s.name);
      if (!id || !/^[a-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/i.test(id)) return null;
      return {
        id: id.slice(0, 120),
        name: clip(str(s.description) ?? str(s.name) ?? id, 80),
        running: num(s.running) === 1 || s.running === true,
        locked: num(s.locked) === 1 || s.locked === true,
      };
    })
    .filter((s): s is OpnService => s !== null);
}

/** `/api/core/system/status`: OPNsense's own notices (errors, warnings, notices), banners left out. */
export function parseSystemStatus(body: unknown): OpnNotice[] {
  const out: OpnNotice[] = [];
  for (const [key, raw] of Object.entries(rec(rec(body).subsystems)).slice(0, 30)) {
    const s = rec(raw);
    if (s.isBanner === true) continue;
    const code = num(s.statusCode);
    const level = code === -1 ? 'error' : code === 0 ? 'warning' : code === 1 ? 'notice' : null;
    if (!level) continue;
    out.push({
      key: key.slice(0, 60),
      title: clip(str(s.title) ?? key, 80),
      message: str(s.message) ? clip(str(s.message) as string, 200) : null,
      level,
    });
  }
  return out;
}

/** `/api/core/firmware/status`. */
export function parseFirmware(body: unknown): OpnFirmware {
  const b = rec(body);
  const product = rec(b.product);
  const version = str(product.product_version) ?? str(b.product_version);
  const status = str(b.status);
  const major = str(b.upgrade_major_version);
  const latest = str(product.product_latest);
  const packages = Object.keys(rec(status === 'upgrade' ? b.all_sets : b.all_packages)).length;
  const waiting =
    status === 'update' || status === 'upgrade' || major
      ? { latest: latest && latest !== version ? latest : null, packages, major: major || null }
      : null;
  return { version, waiting, needsReboot: str(b.needs_reboot) === '1' || b.needs_reboot === 1 };
}

/** `/api/diagnostics/activity/get_activity`'s head: “CPU: 2.3% user, … 96.1% idle” → 3.9. */
export function parseCpu(body: unknown): number | null {
  for (const h of list(rec(body).headers)) {
    const m = /CPU:.*?([\d.]+)%\s*idle/i.exec(String(h));
    if (m) {
      const idle = num(m[1]);
      return idle === null ? null : Math.max(0, Math.min(100, 100 - idle));
    }
  }
  return null;
}

/** `/api/diagnostics/system/system_resources` (`{memory: {total, used}}`, bytes). */
export function parseMemory(body: unknown): OpnSnapshot['memory'] {
  const m = rec(rec(body).memory);
  const total = num(m.total);
  const used = num(m.used);
  return total && used !== null ? { used, total } : null;
}

/** `/api/diagnostics/firewall/pf_states` (`{current, limit}` as text). */
export function parseStates(body: unknown): OpnSnapshot['states'] {
  const current = num(rec(body).current);
  return current === null ? null : { current, limit: num(rec(body).limit) };
}

/** `/api/wireguard/service/show`: the peers, with how long since their last handshake. */
export function parsePeers(body: unknown): OpnPeer[] {
  return list(rec(body).rows)
    .map(rec)
    .filter((r) => str(r.type) === 'peer')
    .slice(0, 100)
    .map((r, i) => {
      const key = str(r['public-key']) ?? String(i);
      const handshake = num(r['latest-handshake']);
      const rx = num(r['transfer-rx']);
      const tx = num(r['transfer-tx']);
      return {
        key: key.slice(0, 60),
        name: clip(str(r.name) || `Peer ${key.slice(0, 8)}`, 80),
        iface: str(r.ifname) ?? str(r.if),
        handshakeAgeS: handshake ? (num(r['latest-handshake-age']) ?? null) : null,
        bytes: rx === null && tx === null ? null : (rx ?? 0) + (tx ?? 0),
      };
    });
}

/** `/api/diagnostics/system/system_time`'s `uptime` (“12 days, 03:04:05”, “03:04:05”) as “12 days”, “3 h”. */
export function uptimeWords(body: unknown): string | null {
  const up = str(rec(body).uptime);
  if (!up) return null;
  const days = /^(\d+)\s+days?/.exec(up);
  if (days) return plural(Number(days[1]), 'day');
  const hms = /^(\d+):(\d+):(\d+)$/.exec(up);
  return hms ? span((Number(hms[1]) * 3600 + Number(hms[2]) * 60) * 1000) : null;
}

async function cpuOf(services: Services, row: CatalogConnectionRow): Promise<number | null> {
  return cachedRead(
    services,
    `opnsense-cpu:${row.id}`,
    row,
    async () => parseCpu(await getJson(services, row, NAME, '/api/diagnostics/activity/get_activity')),
    CPU_CACHE_MS,
  ).catch(() => null);
}

export const opnsenseReader = snapshotReader<OpnSnapshot>(NAME, 'opnsense', async (services, row, now) => {
  const get = (path: string) => getJson(services, row, NAME, path);
  const [gateways, defaults, status, firmware, servicesDoc, resources, time, states, wireguard, cpu] =
    await Promise.all([
      optional(get('/api/routes/gateway/status')),
      optional(get('/api/routing/settings/search_gateway')),
      optional(get('/api/core/system/status')),
      optional(get('/api/core/firmware/status')),
      optional(get('/api/core/service/search')),
      optional(get('/api/diagnostics/system/system_resources')),
      optional(get('/api/diagnostics/system/system_time')),
      optional(get('/api/diagnostics/firewall/pf_states')),
      optional(get('/api/wireguard/service/show')),
      cpuOf(services, row),
    ]);
  // Nothing answered: say why with the one read every OPNsense has.
  if (!gateways && !status && !firmware && !servicesDoc) await get('/api/core/system/status');
  const gws = gateways ? parseGateways(gateways) : null;
  const chosen = defaults ? parseDefaultGateway(defaults) : null;
  return {
    readAt: now,
    gateways: gws,
    defaultGateway:
      (chosen && gws?.some((g) => g.name === chosen) ? chosen : null) ??
      gws?.find((g) => !g.ipv6)?.name ??
      gws?.[0]?.name ??
      null,
    services: servicesDoc ? parseServices(servicesDoc) : null,
    notices: status ? parseSystemStatus(status) : [],
    firmware: firmware ? parseFirmware(firmware) : null,
    cpuPct: cpu,
    memory: resources ? parseMemory(resources) : null,
    states: states ? parseStates(states) : null,
    peers: wireguard ? parsePeers(wireguard) : null,
    uptime: time ? uptimeWords(time) : null,
    ...(status ? {} : { statusUnread: true }),
  };
});

/* What it means ------------------------------------------------------------------------------------------------------- */

const internet = (s: OpnSnapshot) => s.gateways?.find((g) => g.name === s.defaultGateway) ?? null;
const ms = (n: number) => `${statFigure(n)} ms`;
const lossWords = (n: number) => `${statFigure(n)} %`;

const GATEWAY_WORDS: Record<GatewayState, { text: string; dot: NonNullable<ThingPageCell['dot']> }> = {
  online: { text: 'Online', dot: 'ok' },
  down: { text: 'Offline', dot: 'bad' },
  loss: { text: 'Losing packets', dot: 'warn' },
  delay: { text: 'Slow', dot: 'warn' },
  'delay+loss': { text: 'Slow and losing packets', dot: 'warn' },
  pending: { text: 'Waiting', dot: 'off' },
};

/** The points the health pass keeps (SD-S06); a gap when the default gateway isn't monitored or is down. */
export function opnsensePoints(s: OpnSnapshot): Record<string, number | null> {
  const g = internet(s);
  if (!g) return {};
  return {
    [GW_DELAY_KEY]: g.state === 'down' ? null : g.delayMs,
    [GW_LOSS_KEY]: g.state === 'down' ? 100 : g.lossPct,
  };
}

export interface OpnLines {
  timestamps: string[];
  delay: (number | null)[];
  loss: (number | null)[];
}

export function opnsenseKpis(s: OpnSnapshot, lines: OpnLines | null): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  const g = internet(s);
  if (g) {
    const words = GATEWAY_WORDS[g.state];
    const bad = g.state === 'down';
    const lossy = (g.lossPct ?? 0) > LOSS_WARN;
    out.push({
      key: 'internet',
      label: 'Internet',
      value: bad ? 'Down' : g.delayMs !== null ? ms(g.delayMs) : words.text,
      ...(!bad && g.lossPct !== null ? { rest: `· ${lossWords(g.lossPct)} loss` } : {}),
      sub: clip(`${g.name}${g.monitored || bad ? '' : ' · not monitored'}`, 80),
      ...(bad ? { tone: 'bad' as const } : lossy || g.state !== 'online' ? { tone: 'warn' as const } : {}),
      ...(lines && drawable(lines.delay) ? { spark: downsample(lines.delay), color: 'green' as const } : {}),
    });
  }
  if (s.cpuPct !== null)
    out.push({
      key: 'cpu',
      label: 'CPU',
      value: pct(s.cpuPct),
      meter: Math.min(1, s.cpuPct / 100),
      ...(s.cpuPct >= 90 ? { tone: 'warn' as const } : { color: 'blue' as const }),
    });
  if (s.memory)
    out.push({
      key: 'memory',
      label: 'Memory',
      value: pct((s.memory.used / s.memory.total) * 100),
      sub: `${bytes(s.memory.used)} of ${bytes(s.memory.total)}`,
      meter: Math.min(1, s.memory.used / s.memory.total),
      color: 'violet',
    });
  if (s.states)
    out.push({
      key: 'connections',
      label: 'Connections',
      value: thousands(s.states.current),
      sub: s.states.limit ? `of ${thousands(s.states.limit)} at most` : 'firewall states',
      ...(s.states.limit ? { meter: Math.min(1, s.states.current / s.states.limit) } : {}),
      ...(s.states.limit && s.states.current / s.states.limit >= 0.9 ? { tone: 'warn' as const } : {}),
    });
  return out;
}

/** Gateway delay and loss over the range (SD-S06): delay on the left in ms, loss on the right in %. */
export function opnsenseChart(
  lines: OpnLines,
  s: OpnSnapshot | null,
  now: Date,
  timeZone: string,
): ChartPanel | null {
  if (!drawable(lines.delay) && !drawable(lines.loss)) return null;
  const g = s ? internet(s) : null;
  return {
    kind: 'chart',
    id: 'internet',
    // Below the slots, over the page's range: what happened within the hour is what the page is opened for.
    place: 'main',
    title: g ? clip(`Internet · ${g.name}`, 60) : 'Internet',
    timestamps: lines.timestamps,
    series: [
      {
        key: 'delay',
        label: 'Delay',
        unit: 'ms',
        values: lines.delay,
        color: 'green',
        fill: true,
        ...(g?.delayMs != null ? { latest: ms(g.delayMs) } : {}),
      },
      {
        key: 'loss',
        label: 'Loss',
        unit: '%',
        values: lines.loss,
        axis: 'right',
        color: 'red',
        ...(g?.lossPct != null ? { latest: lossWords(g.lossPct) } : {}),
      },
    ],
    ...(g?.delayMs != null
      ? {
          figure: {
            value: ms(g.delayMs),
            rest: g.lossPct != null ? `delay · ${lossWords(g.lossPct)} loss` : 'delay',
          },
        }
      : {}),
    ...statsOf(avgPeakLines(seriesStats(lines.delay, lines.timestamps), ms, now, timeZone)),
    axis: { min: 0, unit: 'ms' },
  };
}

/** OPNsense's own messages a person deals with: the crash reporter (send or dismiss the report). */
const STATUS_YOU = new Set(['crashreporter']);

/** Every check OPNsense's page can raise (QN-15). */
export const OPNSENSE_CHECKS: readonly KindCheck[] = [
  {
    check: 'opnsense.gateway_down',
    name: 'Gateways going down',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'opnsense.gateway_loss',
    name: 'Packet loss on a gateway',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'opnsense.service_stopped',
    name: 'Services stopping',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'opnsense.states',
    name: 'The connection table filling up',
    nature: 'problem',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'opnsense.status',
    name: 'OPNsense’s own messages',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'opnsense.reboot',
    name: 'A restart needed after an update',
    nature: 'you',
    perItem: false,
    startsOn: false,
  },
  { check: 'opnsense.updates', name: 'OPNsense updates', nature: 'fyi', perItem: false, startsOn: false },
  // Something new is open to the internet: a new opening in its settings (internet-exposure.md).
  EXPOSURE_NEW,
];

/** What this read couldn't see (QN-11): a part that didn't answer, or a table without its limit. */
export function opnsenseSkipped(s: OpnSnapshot): string[] {
  const out: string[] = [];
  if (!s.gateways) out.push('opnsense.gateway_down', 'opnsense.gateway_loss');
  if (!s.services) out.push('opnsense.service_stopped');
  if (!s.states?.limit) out.push('opnsense.states');
  if (s.statusUnread) out.push('opnsense.status');
  if (!s.firmware) out.push('opnsense.reboot', 'opnsense.updates');
  return out;
}

const gatewaySubject = (g: OpnGateway) => ({ id: clip(`gateway:${g.name}`, 160), name: g.name });

function gatewayLines(s: OpnSnapshot): KindNotice[] {
  const out: KindNotice[] = [];
  for (const g of s.gateways ?? []) {
    const main = g.name === s.defaultGateway;
    if (g.state === 'down' && g.forced)
      // Switched off by hand: a heads-up (QN-04), never the dot.
      out.push({
        id: idOf('gateway-down', g.name),
        tone: 'info',
        icon: 'network',
        title: clip(
          main ? `The internet gateway ${g.name} is switched off` : `Gateway ${g.name} is switched off`,
          120,
        ),
        detail: 'Someone switched it off in OPNsense.',
        nature: 'fyi',
        check: 'opnsense.gateway_down',
        subject: gatewaySubject(g),
        ignore: { lifts: 'fixed', words: 'Until it’s back up.' },
      });
    else if (g.state === 'down')
      out.push({
        id: idOf('gateway-down', g.name),
        tone: main ? 'bad' : 'warn',
        icon: 'network',
        title: clip(main ? `The internet gateway ${g.name} is down` : `Gateway ${g.name} is down`, 120),
        ...(main ? { detail: 'The network may be without internet.' } : {}),
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: clip(`Why is the OPNsense gateway ${g.name} down?`, 300),
        },
        nature: 'problem',
        check: 'opnsense.gateway_down',
        subject: gatewaySubject(g),
        ignore: { lifts: 'fixed', words: 'Until it’s back up.' },
        confirm: 2,
        badge: main ? 'Internet down' : badgeOf(`${g.name} down`),
      });
    else if ((g.lossPct ?? 0) > LOSS_WARN)
      out.push({
        id: idOf('gateway-loss', g.name),
        tone: 'warn',
        icon: 'network',
        title: clip(`${g.name} is losing ${lossWords(g.lossPct as number)} of its packets`, 120),
        ...(g.delayMs !== null ? { detail: `Delay ${ms(g.delayMs)}.` } : {}),
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: clip(`Why is the OPNsense gateway ${g.name} losing packets?`, 300),
        },
        nature: 'problem',
        check: 'opnsense.gateway_loss',
        subject: gatewaySubject(g),
        ignore: { lifts: 'fixed', words: 'Until the loss stops.' },
        confirm: 2,
        badge: main ? `Losing ${lossWords(g.lossPct as number)}` : badgeOf(`${g.name} losing packets`),
      });
  }
  return out;
}

function serviceLines(s: OpnSnapshot, ctx?: ButtonCtx): KindNotice[] {
  const lines = (s.services ?? [])
    .filter((x) => !x.running)
    .map(
      (x): KindNotice => ({
        id: idOf('service', x.id),
        tone: 'warn',
        icon: 'power',
        title: clip(`${x.name} has stopped`, 120),
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: clip(`Why did ${x.name} stop on OPNsense?`, 300),
        },
        ...(ctx && !x.locked ? { action: serviceButton(ctx, x) as PageButton } : {}),
        nature: 'problem',
        check: 'opnsense.service_stopped',
        subject: { id: clip(`service:${x.id}`, 160), name: x.name },
        ignore: { lifts: 'fixed', words: 'Until it’s running again.' },
        badge: badgeOf(`${x.name} stopped`),
      }),
    );
  return itemLines(lines, (rest) => ({
    id: 'service-more',
    title: `${plural(rest.length, 'more service has', 'more services have')} stopped`,
    detail: clip(rest.map((n) => n.subject?.name ?? n.title).join(' · '), 200),
    link: { kind: 'ask', label: 'Look into it', question: 'Why have several services stopped on OPNsense?' },
    badge: badgeOf(`${lines.length} services stopped`),
  }));
}

function statusLines(s: OpnSnapshot, url: string): KindNotice[] {
  return s.notices.map((n): KindNotice => {
    const nature = n.level === 'notice' ? 'fyi' : STATUS_YOU.has(n.key) ? 'you' : 'problem';
    return {
      id: idOf('opnsense', n.key),
      tone: nature === 'fyi' ? 'info' : 'warn',
      icon: nature === 'fyi' ? 'info' : 'warn',
      // OPNsense's own status words are for admins: the detail, under Whombat's title.
      title: nature === 'fyi' ? 'OPNsense has a note' : 'OPNsense has a warning',
      detail: clip(n.message ? `${n.title}: ${n.message}` : n.title, 200),
      link:
        nature === 'problem'
          ? {
              kind: 'ask',
              label: 'Look into it',
              question: clip(`OPNsense says “${n.title}”. What does it mean, and what should I do?`, 300),
            }
          : { kind: 'url', label: 'Open OPNsense', url },
      nature,
      check: 'opnsense.status',
      subject: { id: clip(`status:${n.key}`, 160), name: n.title },
      // One part of OPNsense can say several things: another message is news.
      episode: shortHash([n.message ?? n.title]),
      ignore: { lifts: 'newer', words: 'Until OPNsense says something new.' },
    };
  });
}

/** Worth a look (SD-40; quiet-notices.md QN-01…QN-04): one line per gateway, service and message. */
export function opnsenseNotices(s: OpnSnapshot, url: string, ctx?: ButtonCtx): KindNotice[] {
  const out: KindNotice[] = [...gatewayLines(s), ...serviceLines(s, ctx)];
  if (s.states?.limit && s.states.current / s.states.limit >= 0.9) {
    const share = s.states.current / s.states.limit;
    out.push({
      id: 'states',
      tone: 'warn',
      icon: 'network',
      title: `The firewall’s connection table is ${pct(share * 100)} full`,
      detail: 'New connections are refused once it’s full.',
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: 'What fills the OPNsense firewall’s connection table?',
      },
      nature: 'problem',
      check: 'opnsense.states',
      band: share >= 0.95 ? 95 : 90,
      ignore: { lifts: 'fixed', words: 'Until it’s less full.' },
      confirm: 2,
      badge: 'Connection table full',
    });
  }
  out.push(...statusLines(s, url));
  if (s.firmware?.needsReboot)
    out.push({
      id: 'reboot',
      tone: 'warn',
      icon: 'update',
      title: 'OPNsense needs a restart to finish updating',
      detail: 'Whombat leaves the moment to you: the network drops while it restarts.',
      link: { kind: 'url', label: 'Open OPNsense', url },
      nature: 'you',
      check: 'opnsense.reboot',
      // A later update that needs one again is news.
      episode: s.firmware.version ?? 'unknown',
      ignore: { lifts: 'newer', words: 'Until a later update needs one.' },
      badge: 'Needs a restart',
    });
  const w = s.firmware?.waiting;
  if (w)
    out.push({
      id: 'firmware',
      tone: 'info',
      icon: 'update',
      title: clip(
        w.latest || w.major ? 'OPNsense has an update' : `${plural(w.packages || 1, 'update')} waiting`,
        120,
      ),
      ...(w.latest || w.major
        ? {
            detail: `Version ${w.latest ?? w.major}${s.firmware?.version ? `; this one runs ${s.firmware.version}` : ''}.`,
          }
        : s.firmware?.version
          ? { detail: `This one runs ${s.firmware.version}.` }
          : {}),
      link: { kind: 'url', label: 'Open updates', url: `${url}/ui/core/firmware` },
      nature: 'fyi',
      check: 'opnsense.updates',
      episode: w.latest ?? w.major ?? `packages:${w.packages}`,
      ignore: { lifts: 'newer', words: 'Until a newer version is out.' },
    });
  return uniqueById(out);
}

/** The head when nothing is worth a look (QN-S30): the internet's delay; the lines say what's wrong. */
export function opnsenseStatus(s: OpnSnapshot): NonNullable<KindView['status']> | undefined {
  const g = internet(s);
  return g?.delayMs != null && g.state !== 'down' ? okStatus(`Internet ${ms(g.delayMs)}`) : undefined;
}

/** Start for a stopped service, Restart✱ for a running one; none for a locked one (SD-40). */
export function serviceButton(ctx: ButtonCtx, x: OpnService): PageButton | null {
  if (x.locked) return null;
  return x.running
    ? pageButton(ctx, {
        action: 'restart',
        target: x.id,
        label: 'Restart',
        icon: 'restart',
        confirm: {
          title: clip(`Restart ${x.name}?`, 80),
          body: 'It stops for a moment; what depends on it may drop its connections.',
          button: 'Restart',
        },
      })
    : pageButton(ctx, { action: 'start', target: x.id, label: 'Start', icon: 'play', tone: 'primary' });
}

/** The head's “Check for updates” (SD-40): only checks. */
export function checkButton(ctx: ButtonCtx): PageButton {
  return pageButton(ctx, { action: 'check_updates', label: 'Check for updates', icon: 'search' });
}

function serviceCell(ctx: ButtonCtx, x: OpnService): ThingPageRow['cells'] {
  const b = serviceButton(ctx, x);
  return b ? { action: { text: b.label, action: b } } : {};
}

export function serviceRows(s: OpnSnapshot, ctx: ButtonCtx): ThingPageRow[] {
  return [...(s.services ?? [])]
    .sort((a, b) => Number(a.running) - Number(b.running) || a.name.localeCompare(b.name))
    .map((x) => ({
      id: x.id,
      cells: {
        name: { text: x.name },
        state: x.running ? { text: 'Running', dot: 'ok' as const } : { text: 'Stopped', dot: 'bad' as const },
        ...serviceCell(ctx, x),
      },
    }));
}

export function opnsenseFacts(s: OpnSnapshot): ThingLine[] {
  const facts: ThingLine[] = [];
  if (s.firmware?.version) facts.push(line(`OPNsense **${s.firmware.version}**`));
  if (s.uptime) facts.push(line(`Up **${s.uptime}**`));
  return facts;
}

/** The default gateway's delay per day of the last 14 days (`gw_delay_ms`), for the Trend; null when unread. */
export type OpnWeek = RawPoint[] | null;

export interface OpnInput {
  snapshot: OpnSnapshot;
  lines: OpnLines | null;
  week?: OpnWeek;
  now: Date;
  timeZone: string;
  url: string;
  row: ButtonCtx['row'];
}

const online = (p: OpnPeer) => p.handshakeAgeS !== null && p.handshakeAgeS <= HANDSHAKE_S;

/** A gateway's state in a word for its line, and the line's colour. */
function gatewayNote(g: OpnGateway): { note: string; noteTone?: ThingTone } {
  if (g.state === 'down') return g.forced ? { note: 'Switched off' } : { note: 'Down', noteTone: 'bad' };
  if ((g.lossPct ?? 0) > LOSS_WARN)
    return { note: `Losing ${lossWords(g.lossPct as number)}`, noteTone: 'warn' };
  if (g.state === 'pending') return { note: 'Waiting' };
  if (g.state !== 'online') return { note: GATEWAY_WORDS[g.state].text, noteTone: 'warn' };
  return { note: 'Online', noteTone: 'ok' };
}

/**
 * Live, “Internet now”: the default gateway first (its line keeps the id `internet`, the desk's figure), then the
 * others, and the firewall's open connections.
 */
export function opnsenseLive(s: OpnSnapshot): LivePanel | null {
  const items: ThingPageItem[] = [];
  const main = internet(s);
  const gateways = [...(main ? [main] : []), ...(s.gateways ?? []).filter((g) => g !== main)].slice(0, 6);
  for (const g of gateways) {
    const isMain = g === main;
    const note = gatewayNote(g);
    const delay = g.state !== 'down' && g.delayMs !== null ? ms(g.delayMs) : null;
    // The state's word leads the line, so a client that draws only `right` still says it.
    const detail = [
      note.note,
      isMain ? g.name : g.ipv6 ? 'IPv6' : null,
      g.state !== 'down' && g.lossPct !== null && note.noteTone !== 'warn'
        ? `${lossWords(g.lossPct)} loss`
        : null,
      g.monitored || g.state === 'down' ? null : 'not monitored',
    ]
      .filter(Boolean)
      .join(' · ');
    items.push({
      ...countLine({
        id: isMain ? 'internet' : idOf('gw', g.name, 60),
        title: isMain ? 'Internet' : g.name,
        icon: 'network',
        value: delay ?? '—',
        detail,
        ...note,
        ...(note.noteTone ? { tone: note.noteTone } : {}),
      }),
      right: delay ?? note.note,
    });
  }
  if (s.states) {
    const share = s.states.limit ? s.states.current / s.states.limit : null;
    items.push(
      countLine({
        id: 'connections',
        title: 'Open connections',
        icon: 'shield',
        value: thousands(s.states.current),
        detail: s.states.limit ? `of ${thousands(s.states.limit)} the firewall keeps` : 'in the firewall',
        ...(share !== null && share >= 0.9
          ? { note: `${pct(share * 100)} full`, noteTone: 'warn' as const, tone: 'warn' as const }
          : share !== null && share >= 0.5
            ? { note: `${pct(share * 100)} full` }
            : {}),
      }),
    );
  }
  if (!items.length) return null;
  const g = main;
  const meta =
    g?.state === 'down' && !g.forced ? 'The internet is down' : s.uptime ? `Up ${s.uptime}` : undefined;
  return liveList({ id: 'internet-now', title: 'Internet now', ...(meta ? { meta } : {}), items });
}

/** Inventory, “On OPNsense”: its services (stopped ones amber), gateways and VPN peers, how many of each run. */
export function opnsenseInventory(s: OpnSnapshot, url: string): InventoryPanel | null {
  const items: ThingPageItem[] = [];
  if (s.services) {
    const stopped = s.services.filter((x) => !x.running).length;
    items.push(
      countLine({
        id: 'services',
        title: 'Services',
        icon: 'power',
        value: thousands(s.services.length),
        ...(stopped ? { note: `${stopped} stopped`, noteTone: 'warn' as const } : { note: 'All running' }),
        url: `${url}/ui/core/service`,
      }),
    );
  }
  if (s.gateways?.length) {
    const down = s.gateways.filter((g) => g.state === 'down' && !g.forced).length;
    const up = s.gateways.filter((g) => g.state !== 'down').length;
    items.push(
      countLine({
        id: 'gateways',
        title: 'Gateways',
        icon: 'network',
        value: thousands(s.gateways.length),
        ...(down
          ? { note: `${down} down`, noteTone: 'bad' as const }
          : { note: up === s.gateways.length ? 'All online' : `${up} online` }),
      }),
    );
  }
  if (s.peers?.length)
    items.push(
      countLine({
        id: 'peers',
        title: 'VPN devices',
        icon: 'key',
        value: thousands(s.peers.length),
        note: `${s.peers.filter(online).length} online`,
      }),
    );
  return items.length ? inventory({ id: 'inventory', title: 'On OPNsense', items }) : null;
}

const DAY_MS = 86_400_000;
const mean = (vs: readonly (number | null)[]) => {
  const xs = vs.filter((v): v is number => v !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

/**
 * Trend, “Internet this week”: the default gateway's average delay per day from the readings Whombat keeps (OPNsense
 * keeps no history of its own), with the change on the week before once those days are there.
 */
export function opnsenseWeek(points: OpnWeek, now: Date, timeZone: string): TrendPanel | null {
  if (!points?.length) return null;
  const days = lastDays(now, timeZone);
  const values = pointsByDay(points, days.keys, timeZone, 'mean').map((v) =>
    v === null ? null : Math.round(v * 10) / 10,
  );
  if (daysWith(values) < 2) return null;
  const before = lastDays(new Date(now.getTime() - 7 * DAY_MS), timeZone);
  const earlier = pointsByDay(points, before.keys, timeZone, 'mean');
  const week = mean(values) as number;
  const last = daysWith(earlier) >= 2 ? mean(earlier) : null;
  return trend({
    id: 'week',
    title: 'Internet this week',
    meta: 'Average delay per day',
    days,
    values,
    label: 'Delay',
    unit: 'ms',
    figure: { value: ms(week), rest: 'average delay' },
    change: last !== null ? weekChange(week, last) : null,
    color: 'green',
  });
}

/** People, “On the VPN”: the WireGuard devices by what they moved since the tunnel came up, and when last seen. */
export function vpnPeople(s: OpnSnapshot): PeoplePanel | null {
  if (!s.peers?.length) return null;
  const peers = [...s.peers].sort(
    (a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || Number(online(b)) - Number(online(a)),
  );
  const moved = peers.some((p) => p.bytes != null);
  return people({
    id: 'wireguard',
    title: 'On the VPN',
    meta: moved ? 'Data since it started' : `${peers.filter(online).length} online`,
    items: peers.map((p) => ({
      name: p.name,
      n: p.bytes ?? 0,
      value: p.bytes ? bytes(p.bytes) : moved ? 'Nothing yet' : online(p) ? 'Online' : '',
      note: online(p) ? 'Online' : p.handshakeAgeS === null ? 'Never' : `${span(p.handshakeAgeS * 1000)} ago`,
    })),
  });
}

/** Its own lines in the machine card: its version and whether a newer one is out, a restart it needs, how long up. */
export function opnsenseMachineLines(s: OpnSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  const f = s.firmware;
  if (f?.version) {
    const w = f.waiting;
    out.push({
      id: 'opnsense-version',
      label: 'OPNsense',
      value: clip(f.version, 40),
      pct: null,
      ...(w
        ? w.latest || w.major
          ? { sub: clip(`Version ${w.latest ?? w.major} is out`, 120) }
          : { sub: plural(w.packages || 1, 'update waiting', 'updates waiting') }
        : { sub: 'Up to date', subTone: 'ok' as const }),
    });
  }
  if (f?.needsReboot)
    out.push({
      id: 'restart',
      label: 'Restart',
      value: 'Needed',
      pct: null,
      tone: 'warn',
      sub: 'To finish updating',
      subTone: 'warn',
    });
  if (s.uptime) out.push({ id: 'up', label: 'Up', value: s.uptime, pct: null });
  return out;
}

/** The card's figures when Whombat knows no machine it runs on: OPNsense is the machine (its processor and memory). */
export function opnsenseOwn(s: OpnSnapshot): NonNullable<KindView['slots']>['own'] | undefined {
  if (s.cpuPct === null && !s.memory) return undefined;
  const GIB = 1024 ** 3;
  return {
    name: 'OPNsense',
    figures: {
      cpuPct: s.cpuPct,
      cores: null,
      memoryUsedGb: s.memory ? s.memory.used / GIB : null,
      memoryTotalGb: s.memory ? s.memory.total / GIB : null,
      diskUsedGb: null,
      diskTotalGb: null,
      series: null,
    },
  };
}

/**
 * The page's OPNsense part (SD-40), its Summary in slots: the internet now beside what runs on it, the week's delay and
 * the VPN's devices beside the machine (OPNsense's own figures when Whombat knows no machine); the internet over the
 * range and the services with Start and Restart✱ below them. Pure.
 */
export function opnsenseView({ snapshot: s, lines, week, now, timeZone, url, row }: OpnInput): KindView {
  const ctx: ButtonCtx = { row };
  const more: ThingPagePanel[] = [];
  const chart = lines ? opnsenseChart(lines, s, now, timeZone) : null;
  if (chart) more.push(chart);
  if (s.services) {
    const stopped = s.services.filter((x) => !x.running).length;
    more.push({
      kind: 'table',
      id: 'services',
      place: 'main',
      title: 'Services',
      meta: stopped ? `${stopped} stopped` : 'all running',
      columns: [
        { key: 'name', label: 'Service' },
        { key: 'state', label: 'State' },
        { key: 'action', label: '' },
      ],
      rows: serviceRows(s, ctx),
    });
  }
  const parts = slotPanels({
    live: opnsenseLive(s),
    inventory: opnsenseInventory(s, url),
    trend: opnsenseWeek(week ?? null, now, timeZone),
    people: vpnPeople(s),
    more,
    machine: opnsenseMachineLines(s),
  });
  const own = opnsenseOwn(s);
  const status = opnsenseStatus(s);
  return {
    // In slots its figures are in Internet now and the machine card; the card keeps them (`opnsenseCardView`).
    kpis: [],
    machine: 'after',
    charts: [],
    notices: opnsenseNotices(s, url, ctx),
    ...parts,
    ...(own ? { slots: { machine: parts.slots?.machine ?? [], own } } : {}),
    tabs: [],
    facts: opnsenseFacts(s),
    ...(status ? { status } : {}),
    open: { label: 'Open OPNsense', url },
    actions: [],
    buttons: [checkButton(ctx)],
    readAt: s.readAt,
    suggestions: ['Firewall log', 'DHCP leases', 'Traffic per interface'],
  };
}

/** The page's part as the card reads it: the page in slots has no row of figures, the card keeps Internet and CPU. */
export function opnsenseCardView(input: OpnInput): KindView {
  return { ...opnsenseView(input), kpis: opnsenseKpis(input.snapshot, input.lines) };
}

/** The Trend's readings: 14 days of the default gateway's delay, for the week and the week before. */
async function weekOf(services: Services, connectionId: string, now: Date): Promise<OpnWeek> {
  const points = await readPoints(services.db, connectionId, [GW_DELAY_KEY], now, 14 * DAY_MS);
  return points.get(GW_DELAY_KEY) ?? [];
}

async function linesOf(
  services: Services,
  connectionId: string,
  range: PageRange,
  now: Date,
): Promise<OpnLines> {
  const points = await readPoints(
    services.db,
    connectionId,
    [GW_DELAY_KEY, GW_LOSS_KEY],
    now,
    RANGE_MS[range],
  );
  const grid = onRange(
    [points.get(GW_DELAY_KEY) ?? ([] as RawPoint[]), points.get(GW_LOSS_KEY) ?? []],
    range,
    now,
  );
  return { timestamps: grid.timestamps, delay: grid.values[0] ?? [], loss: grid.values[1] ?? [] };
}

export async function opnsensePage(ctx: KindCtx): Promise<KindView> {
  const url = serviceUrl(ctx.row);
  const [read, lines, week] = await Promise.all([
    opnsenseReader.latest(ctx.services, ctx.row, ctx.now),
    linesOf(ctx.services, ctx.row.id, ctx.range, ctx.now).catch(() => null),
    weekOf(ctx.services, ctx.row.id, ctx.now).catch(() => null),
  ]);
  if (!read.ok) {
    const chart = lines ? opnsenseChart(lines, null, ctx.now, ctx.timeZone) : null;
    return unreadView(read, NAME, { label: 'Open OPNsense', url }, chart ? [chart] : []);
  }
  return {
    ...opnsenseView({
      snapshot: read.value,
      lines,
      week,
      now: ctx.now,
      timeZone: ctx.timeZone,
      url,
      row: ctx.row,
    }),
    refreshing: read.refreshing,
  };
}

/* Buttons --------------------------------------------------------------------------------------------------------------- */

/** `openvpn/3` → `openvpn/3`, each part encoded. */
const servicePath = (id: string) => id.split('/').map(encodeURIComponent).join('/');

function serviceAction(verb: 'start' | 'restart'): KindAction {
  return async ({ services, row, now }, { target }) => {
    const s = await opnsenseReader.cached(services, row, now);
    const x = (s.services ?? []).find((v) => v.id === target && !v.locked);
    if (!x) throw notOffered('That service');
    if (verb === 'start' && x.running) throw badRequest(`${x.name} is running already.`);
    const answer = await actAs(services, row, NAME, {
      method: 'POST',
      path: `/api/core/service/${verb}/${servicePath(x.id)}`,
      body: {},
    });
    if (str(rec(answer.json).result) !== 'ok')
      throw new ApiError('unavailable', `OPNsense didn’t ${verb} ${x.name}.`);
    return verb === 'start'
      ? { message: `Started ${x.name}.`, title: clip(`Started ${x.name} on OPNsense`, 200) }
      : { message: `Restarted ${x.name}.`, title: clip(`Restarted ${x.name} on OPNsense`, 200) };
  };
}

/** Starts OPNsense's own check (in the background); the page reads its result (SD-40). An everyday button (SD-08). */
const checkUpdates: KindAction = async ({ services, row }) => {
  await actAs(services, row, NAME, { method: 'POST', path: '/api/core/firmware/check', body: {} });
  return {
    message: 'OPNsense is checking for updates. Its answer shows here in a minute or two.',
    title: 'Checked OPNsense for updates',
    everyday: true,
  };
};

export const OPNSENSE_KIND: KindModule = {
  page: opnsensePage,
  seen: async (services, row, now, timeZone) => {
    const s = await opnsenseReader.cached(services, row, now);
    const view = opnsenseCardView({
      snapshot: s,
      lines: null,
      now,
      timeZone,
      url: serviceUrl(row),
      row,
    });
    return {
      glance: cardOf(view, ['internet', 'cpu'], 'Firewall and router'),
      points: opnsensePoints(s),
      ...linesSeen(view, opnsenseSkipped(s)),
    };
  },
  checks: OPNSENSE_CHECKS,
  actions: { start: serviceAction('start'), restart: serviceAction('restart'), check_updates: checkUpdates },
};
