/**
 * The panels every connection's page has and their words (connection-pages.md CP-03, CP-06, CP-15;
 * connection-pages-server.md CP-S03, CP-S16; dashboards.md DS-04, DS-10, DS-14; dashboards-server.md DS-S…). Pure.
 */
import {
  type CatalogCheckResult,
  catalogEntry,
  type ThingPagePanel,
  thingPanelPlace,
  thingPanelSpan,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { ConnectionGlance } from '../home/types';
import { chartReadings, readingCharts, readingKpis, readingRows } from './devices';
import type { ChartPanel } from './kinds/types';
import { diskNotice, machineCard, machineCharts, machineKpis } from './machine';
import {
  accessItems,
  connectionStatus,
  genericKpis,
  genericNotices,
  layout,
  openFigures,
  packCharts,
  responseChart,
} from './panels';
import { devicePoints, readingKey } from './points';
import type { MachineFigures } from './runs-on';
import { bytes, domainName, figure, figure1, line, sizeTextBytes, span } from './words';

const now = new Date('2026-10-18T12:00:00Z');
const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000);
const ok: ConnectionGlance = { status: 'ok', facts: [] };

describe('generic figures and chart (CP-06, DS-14)', () => {
  const rtt = [
    { at: at(50), value: 120 },
    { at: at(30), value: null },
    { at: at(5), value: 160 },
  ];
  const row = {
    status: 'active' as const,
    glance: ok,
    glanceAt: at(4),
    checkedAt: at(4),
    lastUsedAt: new Date('2026-10-08T12:02:00Z'),
  };
  it('Status, Response time (a small line of the range), Last used, Problems', () => {
    const kpis = genericKpis(row, rtt, now, 'Europe/Amsterdam');
    expect(kpis.map(({ spark: _s, ...k }) => k)).toEqual([
      { key: 'status', label: 'Status', value: 'Working', sub: 'checked 4 min ago' },
      {
        key: 'response',
        label: 'Response time',
        value: '160 ms',
        sub: 'average 140 ms in 24 h',
        color: 'blue',
      },
      { key: 'used', label: 'Last used', value: '8 Oct', sub: 'at 14:02' },
      { key: 'problems', label: 'Problems', value: '1', sub: 'failed checks in 24 h', tone: 'warn' },
    ]);
    expect(kpis[1]?.spark).toHaveLength(60);
    const older = [{ at: at(90), value: 100 }, ...rtt];
    expect(genericKpis(row, older, now, 'Europe/Amsterdam')[1]?.sub).toBe('average 127 ms in 24 h');
    expect(genericKpis(row, older, now, 'Europe/Amsterdam', '1h')[1]?.sub).toBe('average 140 ms in 1 h');
  });

  it('beside the machine’s figures, Problems is Status’s line and Last used goes', () => {
    const kpis = genericKpis(row, rtt, now, 'Europe/Amsterdam', '24h', true);
    expect(kpis.map((k) => [k.label, k.sub, k.tone])).toEqual([
      ['Status', '1 failed check in 24 h', 'warn'],
      ['Response time', 'average 140 ms in 24 h', undefined],
    ]);
  });

  it('the response time over the range as a chart card', () => {
    const chart = responseChart(rtt, '24h', now, 'Europe/Amsterdam');
    expect(chart?.timestamps).toHaveLength(96);
    expect(chart).toMatchObject({
      place: 'chart',
      span: 1,
      figure: { value: '160 ms' },
      axis: { min: 0, unit: 'ms' },
    });
    expect(chart?.series[0]).toMatchObject({
      label: 'Response time',
      unit: 'ms',
      latest: '160 ms',
      color: 'blue',
    });
    expect(chart?.stats?.map((l) => l.map((p) => p.text).join(''))).toEqual([
      'Avg 140 ms',
      'Peak 160 ms Now',
    ]);
    expect(responseChart([{ at: at(5), value: 100 }], '24h', now, 'Europe/Amsterdam')).toBeNull();
  });

  it('status and badge from the state and the glance', () => {
    expect(connectionStatus({ status: 'needs_reauth', glance: ok })).toEqual({
      status: 'bad',
      badge: 'Needs you to sign in again',
    });
    expect(connectionStatus({ status: 'active', glance: null })).toEqual({
      status: 'unknown',
      badge: 'Not checked yet',
    });
    expect(connectionStatus({ status: 'active', glance: { status: 'offline', facts: [] } }).badge).toBe(
      'Couldn’t reach it',
    );
  });
});

describe('Worth a look (CP-06)', () => {
  it('signed out, failed checks, new tools, couldn’t read', () => {
    const checks: CatalogCheckResult[] = [{ id: 'mcp', state: 'error', message: 'No answer from /api/mcp' }];
    const reauth = genericNotices({ status: 'needs_reauth', glance: ok, checks, label: 'Grafana' }, 0, null);
    expect(reauth).toMatchObject([
      {
        id: 'reconnect',
        tone: 'bad',
        title: 'Grafana needs you to sign in again',
        link: { kind: 'tab', tab: 'settings' },
        // Only a person can sign in again (quiet-notices.md QN-01).
        nature: 'you',
        check: 'conn.signin',
        ignore: { lifts: 'fixed' },
      },
    ]);
    const rest = genericNotices(
      { status: 'active', glance: { status: 'offline', facts: [] }, checks, label: 'Grafana' },
      3,
      'Grafana didn’t answer in time.',
    );
    expect(rest.map((n) => [n.tone, n.title])).toEqual([
      ['bad', 'Whombat can’t reach it'],
      ['warn', 'Whombat couldn’t use its tools at the last check'],
      ['info', 'Whombat can do 3 new things here'],
      ['info', 'Whombat couldn’t read it just now'],
    ]);
    // Each line's kind, check and item (QN-01, QN-03): not answering colours only from the second check in a row.
    expect(rest.map((n) => [n.check, n.subject?.id ?? null, n.nature, n.confirm ?? null])).toEqual([
      ['conn.answers', null, 'problem', 2],
      ['conn.check', 'mcp', 'problem', null],
      ['conn.new_tools', null, 'you', null],
      ['conn.read', null, 'fyi', null],
    ]);
    expect(rest[0]?.offline).toBe(true);
    // Since 0136 the glance says how the check went apart from the dot (QN-S06): an ignored outage still shows.
    const quietOutage = genericNotices(
      {
        status: 'active',
        glance: { status: 'ok', outcome: 'offline', lines: [], facts: [] },
        checks: [],
        label: 'Grafana',
      },
      0,
      null,
    );
    expect(quietOutage.map((n) => n.check)).toEqual(['conn.answers']);
    // A “Website or address” check says it with its own line (`uptime.down`): no second one.
    expect(
      genericNotices(
        {
          status: 'active',
          catalogId: 'uptime',
          glance: { status: 'ok', outcome: 'offline', lines: [], facts: [] },
          checks: [],
          label: 'Shop',
        },
        0,
        null,
      ),
    ).toEqual([]);
    // Another set of new tools is newer.
    const a = genericNotices({ status: 'active', glance: ok, checks: [], label: 'G' }, 2, null, ['a', 'b']);
    const b = genericNotices({ status: 'active', glance: ok, checks: [], label: 'G' }, 2, null, ['a', 'c']);
    expect(a[0]?.episode).not.toBe(b[0]?.episode);
  });
});

describe('What Whombat may do (CP-06)', () => {
  const entry = catalogEntry('hetzner');
  if (!entry) throw new Error('no hetzner');
  const tools = [
    { name: 'servers_list', access: 'read' as const, tier: 'can' as const, origin: 'adapter' },
    { name: 'request', access: 'write' as const, tier: 'can' as const, origin: 'request' },
    { name: 'server_delete', access: 'write' as const, tier: 'can' as const, origin: 'adapter' },
  ];
  it('reads, changes and what always asks, with their tiers; Look only turns changes off', () => {
    expect(accessItems(entry, { access: 'manage' }, tools)).toEqual([
      { label: 'Read', tier: 'allowed', count: 1 },
      { label: 'Change', tier: 'allowed', count: 1 },
      { label: 'Always asks first', tier: 'ask', count: 1 },
    ]);
    expect(accessItems(entry, { access: 'read' }, tools)).toEqual([
      { label: 'Read', tier: 'allowed', count: 1 },
      { label: 'Change', tier: 'off', count: 1 },
      { label: 'Always asks first', tier: 'off', count: 1 },
    ]);
  });
});

describe('places (DS-04)', () => {
  const chart = (id: string, span?: 1 | 2 | 3): ChartPanel => ({
    kind: 'chart',
    id,
    title: id,
    timestamps: [],
    series: [{ key: 'x', label: 'x', values: [] }],
    ...(span ? { span } : {}),
  });

  it('fills rows of three: a later card takes a gap, the last of a short row widens', () => {
    const spans = (cs: ChartPanel[]) => packCharts(cs).map((c) => `${c.id}:${c.span}`);
    expect(spans([chart('cpu'), chart('memory'), chart('disk'), chart('errors', 2), chart('db')])).toEqual([
      'cpu:1',
      'memory:1',
      'disk:1',
      'errors:2',
      'db:1',
    ]);
    expect(spans([chart('cpu'), chart('memory'), chart('internet', 2), chart('gateway')])).toEqual([
      'cpu:1',
      'memory:1',
      'gateway:1',
      'internet:3',
    ]);
    expect(spans([chart('response')])).toEqual(['response:3']);
    expect(spans([chart('a'), chart('b')])).toEqual(['a:1', 'b:2']);
  });

  it('a card of bars that widens lays its lines side by side', () => {
    const machine = (n: number, columns?: number): ThingPagePanel => ({
      kind: 'bars',
      id: 'machine',
      place: 'chart',
      title: 'The machine',
      items: Array.from({ length: n }, (_, i) => ({ id: `l${i}`, label: `Line ${i}` })),
      ...(columns ? { columns } : {}),
    });
    const columnsOf = (ps: ThingPagePanel[]) =>
      ps.map((p) => (p.kind === 'bars' ? (p.columns ?? null) : null));
    expect(columnsOf(packCharts([machine(5)]))).toEqual([3]);
    // A short row widens its chart, so the machine card beside a Trend keeps its one column.
    expect(packCharts([chart('week'), machine(5)]).map((p) => p.span)).toEqual([2, 1]);
    expect(columnsOf(packCharts([chart('week'), machine(5)]))).toEqual([null, null]);
    expect(columnsOf(packCharts([machine(1)]))).toEqual([null]);
    expect(columnsOf(packCharts([machine(5, 1)]))).toEqual([1]);
    expect(columnsOf(packCharts([chart('a'), chart('b'), machine(5)]))).toEqual([null, null, null]);
  });

  it('every panel gets a place in a phone’s order, and a width for 0.88 clients', () => {
    const panels = layout([
      { kind: 'kpis', id: 'figures', items: [{ key: 'a', label: 'A', value: '1' }] },
      chart('cpu'),
      { kind: 'list', id: 'backups', title: 'Backups', items: [] },
      { kind: 'notices', id: 'notices', title: 'Worth a look', items: [] },
      { kind: 'facts', id: 'device', place: 'side', title: 'The device', items: [] },
      { kind: 'changes', id: 'changes', place: 'main', title: 'Changes here', limit: 5 },
      { kind: 'widgets', id: 'widgets', title: 'Show more here', suggestions: [] },
    ]);
    expect(panels.map((p) => [p.id, p.place, p.width, thingPanelSpan(p)])).toEqual([
      ['figures', 'top', 'full', 1],
      ['cpu', 'chart', 'full', 3],
      ['notices', 'side', 'narrow', 1],
      ['backups', 'main', 'wide', 1],
      ['changes', 'main', 'wide', 1],
      ['device', 'side', 'narrow', 1],
      ['widgets', 'bottom', 'full', 1],
    ]);
    expect(panels.map((p, i) => thingPanelPlace(p, i > 1))).toEqual(panels.map((p) => p.place));
  });
});

describe('a figure opens its charts (CN-05, CN-06, CT-449)', () => {
  const kpi = (key: string) => ({ key, label: key.toUpperCase(), value: '1' });
  const chart = (id: string): ChartPanel => ({ kind: 'chart', id, title: id, timestamps: [], series: [] });
  const line = (id: string, keys: string[]): ThingPagePanel => ({
    ...chart(id),
    series: keys.map((key) => ({ key, label: key, values: [] })),
  });
  const opened = (panels: ThingPagePanel[]) =>
    Object.fromEntries(
      panels.flatMap((p) =>
        p.kind === 'kpis'
          ? p.items.map((k) => [k.key, k.charts ?? (k.link?.kind === 'tab' ? k.link.tab : null)])
          : [],
      ),
    );

  it('opens the chart with its key, then the named ones, then the one drawing its line', () => {
    const panels = openFigures(
      [
        {
          kind: 'kpis',
          id: 'figures',
          items: [kpi('cpu'), kpi('traffic'), kpi('room'), kpi('servers'), kpi('cost')],
        },
        chart('cpu'),
        chart('network'),
        chart('disk-io'),
        line('readings', ['room', 'outside']),
        chart('alone'),
      ],
      ['servers', 'volumes'],
    );
    expect(opened(panels)).toEqual({
      cpu: ['cpu'],
      traffic: ['network', 'disk-io'],
      room: ['readings'],
      servers: 'servers',
      cost: null,
    });
  });

  it('gives a chart to one figure only, its own key first', () => {
    const panels = openFigures([
      { kind: 'kpis', id: 'figures', items: [kpi('integrations'), kpi('errors')] },
      chart('errors'),
    ]);
    expect(opened(panels)).toEqual({ integrations: null, errors: ['errors'] });
    expect(
      opened(layout([{ kind: 'kpis', id: 'f', items: [kpi('integrations')] }, chart('errors')])),
    ).toEqual({
      integrations: ['errors'],
    });
  });
});

describe('the machine it runs on (DS-10)', () => {
  const ts = Array.from({ length: 4 }, (_, i) => at(45 - i * 15).toISOString());
  const m: MachineFigures = {
    kind: 'guest',
    name: 'pve-02 · CT 131',
    label: 'CT 131',
    cpuPct: 2,
    cores: 4,
    memoryUsedGb: 3,
    memoryTotalGb: 8,
    diskUsedGb: 30.4,
    diskTotalGb: 40,
    uptimeS: null,
    lastBackup: null,
    backupJob: null,
    series: { timestamps: ts, cpu: [1.2, 4.6, 1.8, 2], memoryGb: [2.9, 3.1, 2.9, 3] },
  };

  it('CPU and Memory with small lines, Disk with a bar and where it is heading', () => {
    const full = new Date(now.getTime() + 60 * 86_400_000);
    expect(machineKpis(m, full, now)).toEqual([
      { key: 'cpu', label: 'CPU', value: '2 %', sub: 'of 4 cores', spark: [1.2, 4.6, 1.8, 2], color: 'blue' },
      {
        key: 'memory',
        label: 'Memory',
        value: '3.0',
        rest: '/ 8 GB',
        sub: '38 % used',
        spark: [2.9, 3.1, 2.9, 3],
        color: 'violet',
      },
      {
        key: 'disk',
        label: 'Disk',
        value: '30',
        rest: '/ 40 GB',
        sub: '76 % · full in about 2 months',
        meter: 0.76,
        tone: 'warn',
      },
    ]);
  });

  it('chart cards CPU (blue) and Memory (violet) with their figure, average and peak', () => {
    const [cpu, memory] = machineCharts(m, { now, timeZone: 'Europe/Amsterdam' });
    expect(cpu).toMatchObject({
      id: 'cpu',
      place: 'chart',
      span: 1,
      figure: { value: '2 %', rest: 'of 4 cores' },
      series: [{ color: 'blue', fill: true, latest: '2 %' }],
    });
    expect(cpu?.stats?.map((l) => l.map((p) => p.text).join(''))).toEqual([
      'Avg 2.4 %',
      'Peak 4.6 % Sun 13:30',
    ]);
    expect(memory).toMatchObject({
      id: 'memory',
      figure: { value: '3.0 GB', rest: 'of 8 GB' },
      series: [{ color: 'violet', fill: true }],
      axis: { min: 0, max: 8, unit: 'GB' },
    });
  });

  it('its disk is a grey heads-up from 75 %, or worth a look when it is full within 60 days', () => {
    const ask = {
      now,
      timeZone: 'Europe/Amsterdam',
      where: 'pve-02 · CT 131',
      question: 'What takes the space?',
    };
    expect(diskNotice(m, null, ask)).toMatchObject({
      tone: 'info',
      title: 'Disk 76 % full',
      detail: '30 GB of 40 GB used on pve-02 · CT 131',
    });
    const roomy = { ...m, diskUsedGb: 10 };
    expect(diskNotice(roomy, null, ask)).toBeNull();
    expect(diskNotice(roomy, new Date(now.getTime() + 20 * 86_400_000), ask)?.title).toBe(
      'Disk full in about 3 weeks',
    );
    // Its kind of line (QN-04, QN-S11): 75–89 % and a forecast past a week are heads-ups; 90 % and a week are problems.
    expect(diskNotice(m, null, ask)).toMatchObject({ check: 'machine.disk', nature: 'fyi', band: 75 });
    expect(diskNotice({ ...m, diskUsedGb: 37 }, null, ask)).toMatchObject({
      tone: 'bad',
      check: 'machine.disk',
      nature: 'problem',
      band: 90,
      link: { kind: 'ask' },
    });
    const later = diskNotice(roomy, new Date(now.getTime() + 20 * 86_400_000), ask);
    expect(later).toMatchObject({ check: 'machine.disk_forecast', nature: 'fyi', tone: 'info', band: 2 });
    expect(later?.link).toBeUndefined();
    expect(diskNotice(roomy, new Date(now.getTime() + 5 * 86_400_000), ask)).toMatchObject({
      check: 'machine.disk_forecast',
      nature: 'problem',
      tone: 'warn',
      band: 3,
    });
  });
});

describe('words', () => {
  it('figures with a space before units', () => {
    expect(span(30_000)).toBe('a moment');
    expect(span(4 * 60_000)).toBe('4 min');
    expect(span(23 * 3600_000)).toBe('23 h');
    expect(span(6 * 7 * 86_400_000)).toBe('6 weeks');
    expect(sizeTextBytes('2834.56 MiB')).toBeCloseTo(2834.56 * 1024 ** 2);
    expect(sizeTextBytes('pending')).toBeNull();
    expect(bytes(2_800_000_000)).toBe('2.8 GB');
    expect(bytes(640_000_000)).toBe('640 MB');
    expect(figure(3)).toBe('3');
    expect(figure(2.84)).toBe('2.8');
    expect(figure(140.4)).toBe('140');
    expect(figure1(3)).toBe('3.0');
    expect(domainName('mobile_app')).toBe('Mobile app');
    expect(line('Home Assistant **2026.10.2** · Container')).toEqual([
      { text: 'Home Assistant ' },
      { text: '2026.10.2', strong: true },
      { text: ' · Container' },
    ]);
  });

  it('a device’s points: its first three numbers, a gap when it didn’t answer', () => {
    const readings = [
      { key: 'flow', value: 34.5 },
      { key: 'mode', value: 'heating' },
      { key: 'outside', value: 9 },
      { key: 'on', value: true },
      { key: 'Tank-Temp', value: 48 },
      { key: 'x', value: 1 },
    ];
    expect(devicePoints(readings, null)).toEqual({ r_flow: 34.5, r_outside: 9, r_tank_temp: 48 });
    expect(devicePoints(null, readings)).toEqual({ r_flow: null, r_outside: null, r_tank_temp: null });
    expect(readingKey('Tank-Temp')).toBe('r_tank_temp');
  });
});

describe('a device’s page (CP-13)', () => {
  const readings = [
    { key: 'flow', label: 'Flow temperature', unit: '°C', value: 34.5, text: '34.5 °C' },
    { key: 'mode', label: 'Mode', value: 'heating', text: 'Heating' },
    { key: 'power', label: 'Power', unit: 'kW', value: 1.2, text: '1.2 kW' },
    { key: 'tank', label: 'Tank', unit: '°C', value: null, text: '', error: 'No answer at register 40' },
  ];
  it('figures with value and unit apart, the numbers it draws, a table of all', () => {
    expect(readingKpis(readings)).toEqual([
      { key: 'flow', label: 'Flow temperature', value: '34.5', rest: '°C' },
      { key: 'mode', label: 'Mode', value: 'Heating' },
      { key: 'power', label: 'Power', value: '1.2', rest: 'kW' },
    ]);
    expect(chartReadings(readings).map((r) => r.key)).toEqual(['flow', 'power']);
    expect(readingRows(readings)[3]?.cells).toEqual({
      reading: { text: 'Tank' },
      value: { text: 'Couldn’t read it', tone: 'muted' },
      note: { text: 'No answer at register 40', tone: 'muted' },
    });
  });

  it('a chart card for each numeric reading over the range, in its own colour (DS-14)', () => {
    const points = new Map([
      [
        'r_flow',
        [
          { at: at(40), value: 33 },
          { at: at(20), value: 36 },
          { at: at(2), value: 34.5 },
        ],
      ],
      ['r_power', [{ at: at(2), value: 1.2 }]],
    ]);
    const { charts, lines } = readingCharts(readings, points, '1h', now, 'Europe/Amsterdam');
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({
      id: 'r_flow',
      place: 'chart',
      title: 'Flow temperature',
      figure: { value: '34.5', rest: '°C' },
      series: [{ key: 'flow', unit: '°C', color: 'blue', latest: '34.5 °C' }],
      axis: { unit: '°C' },
    });
    expect(charts[0]?.stats?.map((l) => l.map((p) => p.text).join(''))).toEqual([
      'Avg 35 °C',
      'Peak 36 °C Sun 13:40',
    ]);
    expect(lines.get('flow')).toHaveLength(12);
  });
});

describe('a service in slots', () => {
  const card = (id: string, span: 1 | 2 | 3): ThingPagePanel => ({
    kind: 'list',
    id,
    place: 'chart',
    span,
    title: id,
    items: [],
  });

  it('packs any panel in a row, not only charts', () => {
    const laid = layout([
      { kind: 'notices', id: 'notices', place: 'top', title: 'Worth a look', items: [] },
      card('playing', 2),
      card('libraries', 1),
      card('recent', 3),
      card('week', 1),
      card('people', 1),
    ]);
    expect(laid.map((p) => `${p.id}:${p.place}:${p.span ?? ''}`)).toEqual([
      'notices:top:',
      'playing:chart:2',
      'libraries:chart:1',
      'recent:chart:3',
      'week:chart:1',
      'people:chart:2',
    ]);
  });

  it('shows the machine as one card: processor, memory, disk with its forecast, then the kind’s lines', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    const panel = machineCard(
      {
        cpuPct: 9,
        cores: 8,
        memoryUsedGb: 5.2,
        memoryTotalGb: 16,
        diskUsedGb: 7100,
        diskTotalGb: 12000,
        series: null,
      },
      { name: 'thetitan', href: '/things/server%3Athetitan' },
      new Date(now.getTime() + 150 * 86_400_000),
      now,
      [{ id: 'plex-version', label: 'Plex', value: '1.42.1', pct: null }],
    );
    expect(panel?.items.map((b) => [b.label, b.value, b.note ?? b.sub ?? null])).toEqual([
      ['Processor', '9 %', 'of 8 cores'],
      ['Memory', '5.2 of 16 GB', null],
      ['Disk', '7.1 of 12 TB', 'Full in about 5 months'],
      ['Plex', '1.42.1', null],
    ]);
    expect([panel?.meta, panel?.link?.kind, panel?.place, panel?.span]).toEqual([
      'thetitan',
      'href',
      'chart',
      1,
    ]);
    const empty = {
      cpuPct: null,
      cores: null,
      memoryUsedGb: null,
      memoryTotalGb: null,
      diskUsedGb: null,
      diskTotalGb: null,
      series: null,
    };
    expect(machineCard(empty, { name: 'x', href: '/x' }, null, now)).toBeNull();
  });
});
