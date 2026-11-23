import type { ThingPagePanel, ThingSummary } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  figureCharts,
  itemWhen,
  keepHereQuestion,
  panelRows,
  parseThingTab,
  placePanels,
  runsOnChoices,
  runsOnParts,
  type ThingHeadPreview,
  thingBadgeTone,
  thingChartModel,
  thingHeadFromConnections,
  thingHeadFromThings,
  thingSeriesToken,
  thingSubject,
  thingTabs,
} from './thingPage';
import { THING_STATUS_LABELS, thingGlyph, thingMark } from './things';

const kpis = { kind: 'kpis', id: 'f', items: [{ key: 'cpu', label: 'CPU', value: '5 %' }] } as ThingPagePanel;
const wide = { kind: 'changes', id: 'w', width: 'wide', title: 'Did', limit: 3 } as ThingPagePanel;
const narrow = { kind: 'changes', id: 'n', width: 'narrow', title: 'Did', limit: 3 } as ThingPagePanel;

describe('thing pages (CP-05)', () => {
  it('adds Activity, and Settings only when the page has it', () => {
    const tabs = [{ key: 'overview', label: 'Overview', panels: [] }];
    expect(thingTabs({ tabs, settings: true }).map((t) => t.key)).toEqual([
      'overview',
      'activity',
      'settings',
    ]);
    expect(thingTabs({ tabs, settings: false }).map((t) => t.key)).toEqual(['overview', 'activity']);
  });

  it('keeps the server a tab is about, so the apps draw it themselves (Find My)', () => {
    const tabs = [{ key: 'findmy', label: 'Find My', server: 'studio', panels: [] }];
    const shown = thingTabs({ tabs, settings: true });
    expect(shown.map((t) => [t.key, t.server])).toEqual([
      ['findmy', 'studio'],
      ['activity', null],
      ['settings', null],
    ]);
    expect(parseThingTab({ tabs, settings: true }, undefined)).toBe('findmy');
  });

  it('opens the asked tab only when the page has it', () => {
    const tabs = [
      { key: 'overview', label: 'Overview', panels: [] },
      { key: 'logs', label: 'Logs', panels: [] },
    ];
    expect(parseThingTab({ tabs, settings: false }, 'logs')).toBe('logs');
    expect(parseThingTab({ tabs, settings: false }, 'settings')).toBe('overview');
    expect(parseThingTab({ tabs, settings: false }, undefined)).toBe('overview');
  });

  it('puts a wide panel and the narrow one after it in one row', () => {
    expect(panelRows([kpis, wide, narrow, narrow, kpis]).map((r) => r.map((p) => p.id))).toEqual([
      ['f'],
      ['w', 'n'],
      ['n'],
      ['f'],
    ]);
  });

  it('words a chip’s question', () => {
    expect(keepHereQuestion('Cost this month', 'Hetzner Cloud')).toBe(
      'Keep “Cost this month” on the Hetzner Cloud page.',
    );
  });
});

const times = (n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 9, 17, 14) + i * 900_000).toISOString());

describe('a thing page’s chart (CP-07, CP-09)', () => {
  it('draws CPU on the left and memory on a right axis whose gridlines meet the left’s', () => {
    const model = thingChartModel({
      timestamps: times(4),
      series: [
        { key: 'cpu', label: 'CPU', unit: '%', values: [4, 38, null, 5], latest: '5 %' },
        { key: 'mem', label: 'Memory', unit: 'GB', axis: 'right', values: [3.9, 1.6, 2.4, 3] },
      ],
    });
    expect(model.left.ticks).toEqual([0, 25, 50]);
    expect(model.left.ticks.map(model.left.label)).toEqual(['0%', '25%', '50%']);
    expect(model.right?.ticks).toEqual([0, 2.5, 5]);
    expect(model.right?.ticks.map(model.right.label)).toEqual(['0\u00a0GB', '2.5\u00a0GB', '5\u00a0GB']);
    const [cpu, mem] = model.lines;
    expect([cpu?.color, cpu?.area, cpu?.latest]).toEqual(['chart1', false, '5 %']);
    // The right axis's line: purple, washed, behind the CPU's, its figures in its own unit.
    expect([mem?.color, mem?.area, mem?.latest]).toEqual(['chart4', true, '3.0\u00a0GB']);
    expect(mem?.plotted).toEqual([39, 16, 24, 30]);
    expect(mem?.format(1.6)).toBe('1.6\u00a0GB');
    expect(mem?.formatPlotted(16)).toBe('1.6\u00a0GB');
    expect(cpu?.formatPlotted(16)).toBe('16\u00a0%');
    expect(cpu?.format(38)).toBe('38\u00a0%');
    expect(model.drawn.map((l) => l.key)).toEqual(['mem', 'cpu']);
    expect(model.times).toHaveLength(4);
    expect(model.empty).toBe(false);
  });

  it('keeps one axis for lines of one unit, a percentage at most 100, and the serious line in range', () => {
    const traffic = thingChartModel({
      timestamps: times(3),
      series: [
        { key: 'down', label: 'Down', unit: 'Mbit/s', values: [120, 920, 84] },
        { key: 'up', label: 'Up', unit: 'Mbit/s', values: [10, 30, 12] },
      ],
    });
    expect(traffic.right).toBeNull();
    expect(traffic.left.ticks).toEqual([0, 500, 1000]);
    // Mbit/s doesn't fit beside the plot: the meta says it.
    expect(traffic.left.ticks.map(traffic.left.label)).toEqual(['0', '500', '1000']);
    expect(traffic.lines.map((l) => [l.color, l.area])).toEqual([
      ['chart1', true],
      ['chart2', false],
    ]);
    const busy = thingChartModel({
      timestamps: times(2),
      series: [{ key: 'cpu', label: 'CPU', unit: '%', values: [95, 99] }],
      line: { value: 90, label: 'busy' },
    });
    expect(busy.left.ticks).toEqual([0, 50, 100]);
    expect(busy.line).toEqual({ value: 90, label: 'busy' });
    // A pool's pH and water stay far from 0: their axes are around them.
    const pool = thingChartModel({
      timestamps: times(3),
      series: [
        { key: 'ph', label: 'pH', values: [7.2, 7.4, 7.6] },
        { key: 'water', label: 'Water', unit: '°C', axis: 'right', values: [25.2, 26, 26.6] },
      ],
      line: { value: 7.4 },
    });
    expect(pool.left.ticks).toEqual([7, 7.5, 8]);
    expect(pool.right?.ticks.map(pool.right.label)).toEqual(['25°C', '26°C', '27°C']);
    expect(pool.lines[1]?.plotted.map((v) => Math.round((v ?? 0) * 100) / 100)).toEqual([7.1, 7.5, 7.8]);
    const none = thingChartModel({ timestamps: [], series: [{ key: 'rtt', label: 'Response', values: [] }] });
    expect(none.empty).toBe(true);
    expect(none.left.ticks).toHaveLength(3);
  });
});

describe('a thing page’s words', () => {
  it('tones the badge, names the chat’s subject and splits what it runs on', () => {
    expect(
      ['ok', 'warn', 'bad', 'offline', 'unknown', 'learning'].map((s) => thingBadgeTone(s as never)),
    ).toEqual(['ok', 'warn', 'bad', 'bad', 'mut', 'mut']);
    expect(thingSubject({ id: 'connection:con_ha', kind: 'connection', name: 'Home Assistant' })).toEqual({
      kind: 'connection',
      id: 'con_ha',
      name: 'Home Assistant',
    });
    expect(thingSubject({ id: 'device:dvp_heat', kind: 'device', name: 'Heat pump' }).id).toBe('dvp_heat');
    expect(runsOnParts('homeassistant (pve-02)')).toEqual({ server: 'pve-02', rest: 'homeassistant' });
    expect(runsOnParts('pve-02 · CT 131')).toEqual({ server: 'pve-02', rest: 'CT 131' });
    expect(runsOnParts('pve-02')).toEqual({ server: 'pve-02', rest: null });
  });

  it('says when a list line was: the clock today, else the date', () => {
    const now = Date.UTC(2026, 9, 18, 12);
    expect(itemWhen('2026-10-18T05:31:00Z', now, 'Europe/Amsterdam')).toBe('Today 07:31');
    expect(itemWhen('2026-10-17T05:31:00Z', now, 'Europe/Amsterdam')).toBe('17 Oct');
  });
});

describe('the runs-on picker (CP-08)', () => {
  const servers = [
    { id: 'pve-01', name: 'pve-01', os: 'Proxmox VE 9.2' },
    { id: 'pve-02', name: 'pve-02', os: 'Proxmox VE 9.2' },
  ];
  const guests = [
    {
      id: 'pve:136',
      serverId: 'pve-02',
      name: 'unifi',
      platform: 'pve' as const,
      kind: 'container' as const,
      vmid: 136,
    },
    {
      id: 'pve:131',
      serverId: 'pve-02',
      name: 'homeassistant',
      platform: 'pve' as const,
      kind: 'container' as const,
      vmid: 131,
    },
    {
      id: 'pve:118',
      serverId: 'pve-01',
      name: 'arnica',
      platform: 'pve' as const,
      kind: 'vm' as const,
      vmid: 118,
    },
  ];

  it('lists servers with their guests by name, each with what it is called once chosen', () => {
    const all = runsOnChoices(servers, guests);
    expect(all.map((s) => [s.server.name, s.guests.map((g) => g.label)])).toEqual([
      ['pve-01', ['arnica (pve-01)']],
      ['pve-02', ['homeassistant (pve-02)', 'unifi (pve-02)']],
    ]);
  });

  it('finds a server with all its guests, or guests by name or number under their server', () => {
    expect(runsOnChoices(servers, guests, 'pve-01').map((s) => s.guests.length)).toEqual([1]);
    expect(
      runsOnChoices(servers, guests, 'home').map((s) => [s.server.name, s.guests.map((g) => g.name)]),
    ).toEqual([['pve-02', ['homeassistant']]]);
    expect(runsOnChoices(servers, guests, 'ct 136')[0]?.guests[0]?.guestId).toBe('pve:136');
    expect(runsOnChoices(servers, guests, 'nothing')).toEqual([]);
  });
});

describe('placePanels (DS-04, AP-2003)', () => {
  const chart = (id: string, span?: 1 | 2 | 3, extra: Partial<ThingPagePanel> = {}) =>
    ({
      kind: 'chart',
      id,
      title: id,
      timestamps: [],
      series: [{ key: 'a', label: 'A', values: [] }],
      place: 'chart',
      ...(span ? { span } : {}),
      ...extra,
    }) as ThingPagePanel;
  const at = (id: string, place: 'top' | 'main' | 'side' | 'bottom') =>
    ({ kind: 'changes', id, title: id, limit: 3, place }) as ThingPagePanel;

  it('fills chart rows of three columns in order; a card that doesn’t fit starts the next row', () => {
    const p = placePanels([
      { ...kpis, place: 'top' } as ThingPagePanel,
      chart('cpu'),
      chart('mem'),
      chart('temp'),
      chart('net', 2),
      chart('disk'),
      at('busy', 'main'),
      at('look', 'side'),
      at('backups', 'side'),
      at('storage', 'bottom'),
      chart('extra', 3),
    ]);
    expect(p.top.map((x) => x.id)).toEqual(['f']);
    expect(p.chart.map((r) => r.map((c) => `${c.panel.id}:${c.span}`))).toEqual([
      ['cpu:1', 'mem:1', 'temp:1'],
      ['net:2', 'disk:1'],
      ['extra:3'],
    ]);
    expect(p.main.map((x) => x.id)).toEqual(['busy']);
    expect(p.side.map((x) => x.id)).toEqual(['look', 'backups']);
    expect(p.bottom.map((x) => x.id)).toEqual(['storage']);
  });

  it('lays a 0.88 page out from its widths', () => {
    const old = chart('resp', undefined, { place: undefined, width: 'wide' });
    const p = placePanels([kpis, old, wide, narrow, { ...kpis, id: 'g' } as ThingPagePanel]);
    expect(p.top.map((x) => x.id)).toEqual(['f']);
    expect(p.chart).toEqual([[{ panel: old, span: 2 }]]);
    expect(p.main.map((x) => x.id)).toEqual(['w']);
    expect(p.side.map((x) => x.id)).toEqual(['n']);
    expect(p.bottom.map((x) => x.id)).toEqual(['g']);
  });

  it('maps series colours to the chart tokens, in order without one', () => {
    expect(thingSeriesToken('violet')).toBe('chart4');
    expect(thingSeriesToken('amber')).toBe('warn');
    expect(thingSeriesToken('grey')).toBe('mut');
    expect([0, 1, 2, 3, 4].map((i) => thingSeriesToken(undefined, i))).toEqual([
      'chart1',
      'chart2',
      'chart3',
      'chart4',
      'chart1',
    ]);
  });
});

describe('figureCharts (CN-05, CT-449, AP-2510)', () => {
  const chart = (id: string): ThingPagePanel => ({
    kind: 'chart',
    id,
    title: id,
    timestamps: [],
    series: [],
  });
  const figures: ThingPagePanel = {
    kind: 'kpis',
    id: 'figures',
    items: [
      { key: 'cpu', label: 'CPU', value: '1 %', charts: ['cpu'] },
      { key: 'network', label: 'Network', value: '8', charts: ['network', 'gone', 'disk'] },
      { key: 'again', label: 'Again', value: '1', charts: ['cpu'] },
      { key: 'guests', label: 'Guests', value: '3', link: { kind: 'tab', label: 'Guests', tab: 'guests' } },
    ],
  };

  it('gives each figure the charts it names, once, and lays out the rest', () => {
    const { open, panels } = figureCharts([
      figures,
      chart('cpu'),
      chart('network'),
      chart('disk'),
      chart('alone'),
    ]);
    expect(Object.fromEntries(Object.entries(open).map(([k, v]) => [k, v.map((c) => c.id)]))).toEqual({
      cpu: ['cpu'],
      network: ['network', 'disk'],
    });
    expect(panels.map((p) => p.id)).toEqual(['figures', 'alone']);
  });

  it('leaves a page without them as it was', () => {
    const plain: ThingPagePanel = {
      kind: 'kpis',
      id: 'figures',
      items: [{ key: 'a', label: 'A', value: '1' }],
    };
    const all = [plain, chart('cpu')];
    expect(figureCharts(all)).toEqual({ open: {}, panels: all });
  });
});

describe('a thing page’s head before it answers (app page-speed.md AP-2650, AP-2651)', () => {
  const ha = {
    id: 'connection:con_ha',
    kind: 'connection',
    catalogId: 'homeassistant',
    name: 'Home Assistant',
    icon: 'homeassistant',
    status: 'warn',
    facts: [],
    href: '/things/connection%3Acon_ha',
  } as ThingSummary;

  it('takes Home’s row for the thingId: what it is and its status in the sidebar’s words', () => {
    const head = thingHeadFromThings([ha], 'connection:con_ha');
    expect(head).toMatchObject({ id: 'connection:con_ha', name: 'Home Assistant', status: 'warn' });
    expect([thingGlyph(head as ThingHeadPreview), thingMark(head as ThingHeadPreview)]).toEqual([
      'home',
      'homeassistant',
    ]);
    expect(head?.badge).toBe(THING_STATUS_LABELS.warn);
    expect(thingHeadFromThings([ha], 'connection:con_other')).toBeNull();
  });

  it('names a listed connection as its page does, without a status, and leaves devices to their page', () => {
    const conn = { id: 'con_ha', catalogId: 'homeassistant', fields: { url: 'http://10.100.0.5:8123' } };
    for (const label of ['Home Assistant · 10.100.0.5:8123', 'Home Assistant · 10.100.0.5', 'Home Assistant'])
      expect(thingHeadFromConnections([{ ...conn, label }], 'connection:con_ha')).toMatchObject({
        name: 'Home Assistant',
        icon: 'homeassistant',
        catalogId: 'homeassistant',
        status: null,
        badge: null,
      });
    expect(thingHeadFromConnections([{ ...conn, label: 'Attic' }], 'connection:con_ha')?.name).toBe('Attic');
    expect(thingHeadFromConnections([{ ...conn, label: 'Pool' }], 'device:con_ha')).toBeNull();
    expect(thingHeadFromConnections([{ ...conn, label: 'Pool' }], 'connection:con_x')).toBeNull();
  });
});
