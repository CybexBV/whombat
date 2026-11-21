/** OPNsense's page from answers as OPNsense 25.7's source writes them (service-dashboards.md SD-40, SD-S06). Pure. */
import { ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { gridTimes } from '../../series';
import { slotProblems } from '../slots';
import {
  OPN_ACTIVITY,
  OPN_FIRMWARE,
  OPN_GATEWAY_SEARCH,
  OPN_GATEWAYS,
  OPN_RESOURCES,
  OPN_SERVICES,
  OPN_STATES,
  OPN_SYSTEM_STATUS,
  OPN_TIME,
  OPN_WIREGUARD,
} from './fixtures/opnsense';
import { buttonsOf } from './fixtures/row';
import {
  checkButton,
  GW_DELAY_KEY,
  GW_LOSS_KEY,
  OPNSENSE_CHECKS,
  type OpnSnapshot,
  opnsenseCardView,
  opnsenseChart,
  opnsenseKpis,
  opnsenseNotices,
  opnsensePoints,
  opnsenseSkipped,
  opnsenseStatus,
  opnsenseView,
  opnsenseWeek,
  parseCpu,
  parseDefaultGateway,
  parseFirmware,
  parseGateways,
  parseMemory,
  parsePeers,
  parseServices,
  parseStates,
  parseSystemStatus,
  serviceButton,
  serviceRows,
  uptimeWords,
} from './opnsense';

const NOW = new Date('2026-10-21T19:40:00Z');
const URL = 'https://192.168.1.1';

function snapshot(): OpnSnapshot {
  return {
    readAt: NOW,
    gateways: parseGateways(OPN_GATEWAYS),
    defaultGateway: parseDefaultGateway(OPN_GATEWAY_SEARCH),
    services: parseServices(OPN_SERVICES),
    notices: parseSystemStatus(OPN_SYSTEM_STATUS),
    firmware: parseFirmware(OPN_FIRMWARE),
    cpuPct: parseCpu(OPN_ACTIVITY),
    memory: parseMemory(OPN_RESOURCES),
    states: parseStates(OPN_STATES),
    peers: parsePeers(OPN_WIREGUARD),
    uptime: uptimeWords(OPN_TIME),
  };
}

describe('opnsense reading', () => {
  it('reads gateways, the default one and their figures', () => {
    const s = snapshot();
    expect(s.defaultGateway).toBe('WAN_DHCP');
    expect(s.gateways?.map((g) => [g.name, g.state, g.delayMs, g.lossPct, g.ipv6])).toEqual([
      ['WAN_DHCP', 'online', 4.2, 0, false],
      ['WAN_DHCP6', 'online', 5.1, 0, true],
      ['LTE_GW', 'loss', 48.3, 12, false],
      ['VPN_GW', 'online', null, null, false],
    ]);
  });

  it('reads services, notices, firmware, CPU, memory, states, peers and uptime', () => {
    const s = snapshot();
    expect(s.services?.map((x) => [x.id, x.running, x.locked])).toEqual([
      ['configd', true, true],
      ['unbound', true, false],
      ['openvpn/3', false, false],
      ['ntpd', true, false],
    ]);
    // The banner (“booting”) is left out.
    expect(s.notices.map((n) => [n.key, n.level])).toEqual([['crashreporter', 'error']]);
    expect(s.firmware).toEqual({
      version: '25.7.5',
      waiting: { latest: '25.7.6', packages: 2, major: null },
      needsReboot: false,
    });
    expect(s.cpuPct).toBeCloseTo(3.9, 5);
    expect(s.memory).toEqual({ used: 2536594637, total: 8455315456 });
    expect(s.states).toEqual({ current: 1234, limit: 1622000 });
    expect(s.peers?.map((p) => [p.name, p.handshakeAgeS, p.bytes])).toEqual([
      ['phone', 42, 777777],
      ['laptop', null, 0],
    ]);
    expect(s.uptime).toBe('12 days');
    expect(uptimeWords({ uptime: '03:04:05' })).toBe('3 h');
    expect(parseSystemStatus({ metadata: { system: { status: 2 } } })).toEqual([]);
    expect(parseFirmware({ status: 'none', product: { product_version: '25.7.6' } }).waiting).toBeNull();
  });
});

describe('opnsense page', () => {
  it('has four figures and keeps the default gateway’s points', () => {
    const s = snapshot();
    const kpis = opnsenseKpis(s, null);
    for (const k of kpis) ThingPageKpi.parse(k);
    expect(kpis.map((k) => [k.key, k.value])).toEqual([
      ['internet', '4.2 ms'],
      ['cpu', '4 %'],
      ['memory', '30 %'],
      ['connections', '1,234'],
    ]);
    expect(opnsensePoints(s)).toEqual({ [GW_DELAY_KEY]: 4.2, [GW_LOSS_KEY]: 0 });
    const down = { ...s, gateways: (s.gateways ?? []).map((g) => ({ ...g, state: 'down' as const })) };
    expect(opnsensePoints(down)).toEqual({ [GW_DELAY_KEY]: null, [GW_LOSS_KEY]: 100 });
    expect(opnsenseKpis(down, null)[0]).toMatchObject({ value: 'Down', tone: 'bad' });
    // The lines decide the head (QN-S30): the default gateway's line carries “Internet down”.
    expect(opnsenseStatus(down)).toBeUndefined();
    expect(opnsenseNotices(down, URL)[0]).toMatchObject({
      id: 'gateway-down-wan_dhcp',
      tone: 'bad',
      nature: 'problem',
      check: 'opnsense.gateway_down',
      subject: { id: 'gateway:WAN_DHCP', name: 'WAN_DHCP' },
      confirm: 2,
      badge: 'Internet down',
      link: { kind: 'ask' },
    });
  });

  it('says what is worth a look, with Start on a stopped service', () => {
    const s = snapshot();
    const notices = opnsenseNotices(s, URL, buttonsOf('opnsense'));
    for (const n of notices) ThingPageNotice.parse(n);
    expect(notices.map((n) => [n.id, n.tone])).toEqual([
      ['gateway-loss-lte_gw', 'warn'],
      ['service-openvpn-3', 'warn'],
      ['opnsense-crashreporter', 'warn'],
      ['firmware', 'info'],
    ]);
    expect(notices[1]?.action).toMatchObject({ action: 'start', target: 'openvpn/3', allowed: true });
    expect(notices.map((n) => [n.check, n.nature, n.subject?.id, n.ignore?.lifts])).toEqual([
      ['opnsense.gateway_loss', 'problem', 'gateway:LTE_GW', 'fixed'],
      ['opnsense.service_stopped', 'problem', 'service:openvpn/3', 'fixed'],
      // The crash reporter is a person's: send or dismiss the report.
      ['opnsense.status', 'you', 'status:crashreporter', 'newer'],
      ['opnsense.updates', 'fyi', undefined, 'newer'],
    ]);
    expect(notices[1]?.link).toMatchObject({ kind: 'ask' });
    expect(notices[2]?.link).toMatchObject({ kind: 'url' });
    expect(notices[3]).toMatchObject({ episode: '25.7.6' });
    // Only what's fine is the kind's to say in the head.
    expect(opnsenseStatus(s)).toEqual({ status: 'ok', badge: 'Internet 4.2 ms' });
    for (const c of OPNSENSE_CHECKS) expect(c.check).toMatch(/^opnsense\.[a-z_]+$/);
    expect(new Set(notices.map((n) => n.check)).size).toBeLessThanOrEqual(OPNSENSE_CHECKS.length);
    for (const n of notices) expect(OPNSENSE_CHECKS.map((c) => c.check)).toContain(n.check);
  });

  it('makes a gateway switched off by hand a heads-up, and flapping checks wait for two passes', () => {
    const s = snapshot();
    const forced = parseGateways({
      items: [{ name: 'WAN_DHCP', status: 'force_down', delay: '~', loss: '~' }],
    });
    expect(forced[0]).toMatchObject({ state: 'down', forced: true });
    const off = opnsenseNotices({ ...s, gateways: forced, services: [], notices: [], firmware: null }, URL);
    expect(off).toEqual([
      expect.objectContaining({
        tone: 'info',
        nature: 'fyi',
        check: 'opnsense.gateway_down',
        title: expect.stringContaining('switched off'),
      }),
    ]);
    expect(off[0]?.link).toBeUndefined();
    const full = opnsenseNotices(
      {
        ...s,
        gateways: [],
        services: [],
        notices: [],
        firmware: null,
        states: { current: 960, limit: 1000 },
      },
      URL,
    );
    expect(full).toEqual([expect.objectContaining({ check: 'opnsense.states', band: 95, confirm: 2 })]);
  });

  it('gives each stopped service a line, then one line for the rest', () => {
    const s = snapshot();
    const services = Array.from({ length: 11 }, (_, i) => ({
      id: `svc${i}`,
      name: `Service ${i}`,
      running: false,
      locked: false,
    }));
    const lines = opnsenseNotices({ ...s, gateways: [], services, notices: [], firmware: null }, URL);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({
      check: 'opnsense.service_stopped',
      subject: { id: '+more', name: '9 more' },
      ignore: { lifts: 'newer' },
      nature: 'problem',
    });
    expect(lines[2]?.episode).toMatch(/^[0-9a-f]{8}$/);
  });

  it('says which checks it couldn’t read, so their ignores don’t end', () => {
    const s = snapshot();
    expect(opnsenseSkipped(s)).toEqual([]);
    expect(
      opnsenseSkipped({
        ...s,
        gateways: null,
        services: null,
        statusUnread: true,
        firmware: null,
        states: null,
      }),
    ).toEqual([
      'opnsense.gateway_down',
      'opnsense.gateway_loss',
      'opnsense.service_stopped',
      'opnsense.states',
      'opnsense.status',
      'opnsense.reboot',
      'opnsense.updates',
    ]);
  });

  it('offers Start, Restart✱ or nothing on a locked service', () => {
    const s = snapshot();
    const ctx = buttonsOf('opnsense');
    const [configd, unbound, openvpn] = s.services ?? [];
    if (!configd || !unbound || !openvpn) throw new Error('services');
    expect(serviceButton(ctx, configd)).toBeNull();
    expect(serviceButton(ctx, unbound)).toMatchObject({ action: 'restart', target: 'unbound' });
    expect(serviceButton(ctx, unbound)?.confirm).toBeDefined();
    expect(serviceButton(ctx, openvpn)).toMatchObject({ action: 'start', allowed: true });
    expect(serviceButton(buttonsOf('opnsense', 'read'), openvpn)?.allowed).toBe(false);
    expect(serviceRows(s, ctx)[0]?.id).toBe('openvpn/3');
    expect(checkButton(ctx)).toMatchObject({ action: 'check_updates', allowed: true });
  });

  it('draws gateway delay and loss over the range', () => {
    const times = gridTimes('24h', NOW).map((d) => d.toISOString());
    const delay = times.map((_, i) => (i % 2 ? 4 + i / 100 : null));
    const loss = times.map(() => 0);
    const chart = opnsenseChart({ timestamps: times, delay, loss }, snapshot(), NOW, 'UTC');
    expect(chart).not.toBeNull();
    ThingPagePanel.parse(chart);
    expect(chart?.series.map((x) => [x.key, x.axis ?? 'left'])).toEqual([
      ['delay', 'left'],
      ['loss', 'right'],
    ]);
    expect(opnsenseChart({ timestamps: times, delay: [], loss: [] }, null, NOW, 'UTC')).toBeNull();
  });

  it('builds its Summary in slots: internet now, what runs on it, the week, the VPN', () => {
    const times = gridTimes('24h', NOW).map((d) => d.toISOString());
    const view = opnsenseView({
      snapshot: snapshot(),
      lines: { timestamps: times, delay: times.map(() => 4), loss: times.map(() => 0) },
      week: weekPoints(),
      now: NOW,
      timeZone: 'UTC',
      url: URL,
      ...buttonsOf('opnsense'),
    });
    for (const p of view.panels) ThingPagePanel.parse(p);
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => [p.id, p.place])).toEqual([
      ['internet-now', 'chart'],
      ['inventory', 'chart'],
      ['week', 'chart'],
      ['wireguard', 'chart'],
      ['internet', 'main'],
      ['services', 'main'],
    ]);
    const live = view.panels[0];
    if (live?.kind !== 'list') throw new Error('live');
    // The default gateway keeps the desk's figure key; the lossy one says so.
    expect(live.items.map((i) => [i.id, i.title, i.figure?.value, i.figure?.note])).toEqual([
      ['internet', 'Internet', '4.2 ms', 'Online'],
      ['gw-wan_dhcp6', 'WAN_DHCP6', '5.1 ms', 'Online'],
      ['gw-lte_gw', 'LTE_GW', '48 ms', 'Losing 12 %'],
      ['gw-vpn_gw', 'VPN_GW', '—', 'Online'],
      ['connections', 'Open connections', '1,234', undefined],
    ]);
    expect(live.meta).toBe('Up 12 days');
    // The state's word leads each line and colours it; the delay is on the right.
    expect(live.items.slice(0, 4).map((i) => [i.detail, i.right, i.tone])).toEqual([
      ['Online · WAN_DHCP · 0 % loss', '4.2 ms', 'ok'],
      ['Online · IPv6 · 0 % loss', '5.1 ms', 'ok'],
      ['Losing 12 %', '48 ms', 'warn'],
      ['Online · not monitored', 'Online', 'ok'],
    ]);
    const inv = view.panels[1];
    if (inv?.kind !== 'list') throw new Error('inventory');
    expect(inv.items.map((i) => [i.title, i.figure?.value, i.figure?.note])).toEqual([
      ['Services', '4', '1 stopped'],
      ['Gateways', '4', 'All online'],
      ['VPN devices', '2', '1 online'],
    ]);
    const week = view.panels[2];
    if (week?.kind !== 'chart') throw new Error('week');
    expect(week.labels?.at(-1)).toBe('Today');
    expect(week.series[0]?.values).toEqual([null, null, null, null, 5, 4, 3]);
    expect(week.figure).toEqual({ value: '4.0 ms', rest: 'average delay' });
    // The week before averaged 8 ms.
    expect(week.stats?.[0]?.[0]?.text).toBe('−50 %');
    const vpn = view.panels[3];
    if (vpn?.kind !== 'bars') throw new Error('people');
    expect(vpn.items.map((i) => [i.label, i.value, i.note])).toEqual([
      ['phone', '778 kB', 'Online'],
      ['laptop', 'Nothing yet', 'Never'],
    ]);
    // OPNsense is the machine when Whombat knows none: its processor and memory, then its own lines.
    expect(view.slots?.own?.figures).toMatchObject({
      cpuPct: expect.closeTo(3.9, 5),
      memoryTotalGb: expect.closeTo(7.87, 2),
    });
    expect(view.slots?.machine.map((b) => [b.label, b.value, b.sub])).toEqual([
      ['OPNsense', '25.7.5', 'Version 25.7.6 is out'],
      ['Up', '12 days', undefined],
    ]);
    expect(view.buttons?.map((b) => [b.action, b.allowed])).toEqual([['check_updates', true]]);
    expect(view.facts.length).toBe(2);
    expect(view.kpis).toEqual([]);
    expect(view.charts).toEqual([]);
  });

  it('keeps its figures on the card and leaves out what it hasn’t got', () => {
    const input = {
      snapshot: snapshot(),
      lines: null,
      now: NOW,
      timeZone: 'UTC',
      url: URL,
      ...buttonsOf('opnsense'),
    };
    expect(opnsenseCardView(input).kpis?.map((k) => k.key)).toEqual([
      'internet',
      'cpu',
      'memory',
      'connections',
    ]);
    // No readings yet, no WireGuard: no Trend, no People.
    const bare = opnsenseView({ ...input, snapshot: { ...snapshot(), peers: null }, week: [] });
    expect(slotProblems(bare)).toEqual([]);
    expect(bare.panels.map((p) => p.id)).toEqual(['internet-now', 'inventory', 'services']);
    // One day of readings isn't a week.
    expect(opnsenseWeek(weekPoints().slice(-2), NOW, 'UTC')).toBeNull();
    // The internet down: its line says so in red.
    const s = snapshot();
    const down = {
      ...s,
      gateways: (s.gateways ?? []).map((g) => (g.name === 'WAN_DHCP' ? { ...g, state: 'down' as const } : g)),
    };
    const live = opnsenseView({ ...input, snapshot: down }).panels[0];
    expect(live?.kind === 'list' && live.items[0]?.figure).toEqual({ value: '—', note: 'Down', tone: 'bad' });
    expect(live?.kind === 'list' && live.meta).toBe('The internet is down');
  });
});

/** The default gateway's delay as Whombat keeps it: three days this week (5, 4, 3 ms), and 8 ms the week before. */
function weekPoints() {
  const day = (d: number, value: number) => ({ at: new Date(NOW.getTime() - d * 86_400_000), value });
  return [day(9, 8), day(8, 8), day(2, 5), day(1, 4), day(0, 2), day(0, 4)];
}
