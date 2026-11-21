/** The Summary on the phone (dashboards-mobile.md AP-2120…): the pure mapping from `ThingPagePanel`s (contracts 0.89). */
import type { ThingPage, ThingPagePanel } from '@whombat/core';
import { at, mara } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { createThingPageFixtures } from '../fixtures/thingPages';
import {
  axisWord,
  barRows,
  chartCard,
  figureTiles,
  fitTicks,
  foldNotices,
  niceTop,
  rangeOptions,
  rangePlace,
  rangeTrend,
  tableRows,
  toneSwatch,
  trendWords,
  wideLayout,
} from './dashboard';

const ZONE = 'Europe/Amsterdam';
const NOW = new Date(at('14:05'));

function world() {
  return createThingPageFixtures({
    now: () => NOW,
    json: (body, status = 200) => new Response(JSON.stringify(body), { status }),
    notFound: (text) =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: text } }), { status: 404 }),
    bodyOf: async <T>(init: RequestInit | undefined) => JSON.parse(String(init?.body ?? '{}')) as T,
    heatOn: () => true,
    assistant: () => ({ id: mara.id, name: 'Neo' }),
    heatChatHref: '/chats/cnv_chat-heat',
  });
}

const page = (thing: string, range: string | null = null) => world().page(thing, range) as ThingPage;
const ha = (range: string | null = null) => page('connection:con_ha', range);
/** Figures and chart cards of a page that isn't in slots (Home Assistant's page is): the chart helpers' sample. */
const sample = (range: '24h' | '7d' = '24h') =>
  ({ tabs: [{ key: 'overview', label: 'Summary', panels: world().dashboardSample(range) }] }) as ThingPage;
const panelOf = <K extends ThingPagePanel['kind']>(p: ThingPage, kind: K, id?: string) =>
  p.tabs[0]?.panels.find((x) => x.kind === kind && (!id || x.id === id)) as Extract<
    ThingPagePanel,
    { kind: K }
  >;

describe('colours', () => {
  it('lets a warn or bad tone win over the colour, then the colour, then blue', () => {
    expect(toneSwatch('warn', 'violet')).toBe('warn');
    expect(toneSwatch('bad', undefined)).toBe('bad');
    expect(toneSwatch('ok', 'violet')).toBe('chart4');
    expect(toneSwatch(undefined, 'grey')).toBe('mut');
    expect(toneSwatch(undefined, undefined)).toBe('chart1');
  });
});

describe('small lines', () => {
  it('say their trend in words for TalkBack', () => {
    expect(trendWords([5, 5, 5, 5, 5, 5, 5, 5])).toBe('steady');
    expect(trendWords([1, 2, 3, 4, 5, 6, 7, 8])).toBe('rising');
    expect(trendWords([8, 7, 6, 5, 4, 3, 2, 1])).toBe('falling');
    expect(trendWords([2, 2, 3, 2, 30, 2, 3, 2])).toBe('steady, with a peak');
    expect(trendWords([1, null, 2])).toBeNull();
    expect(rangeTrend([1, 2, 3, 4, 5, 6, 7, 8], '7d')).toBe('Last 7 days: rising');
  });
});

describe('the range control', () => {
  it('offers the page’s ranges with the web’s words, read as “Last 24 hours”', () => {
    expect(rangeOptions(ha().ranges)).toEqual([
      { value: '1h', label: '1h', spoken: 'Last hour' },
      { value: '6h', label: '6h', spoken: 'Last 6 hours' },
      { value: '24h', label: '24h', spoken: 'Last 24 hours' },
      { value: '7d', label: '7d', spoken: 'Last 7 days' },
      { value: '30d', label: '30d', spoken: 'Last 30 days' },
    ]);
  });

  it('shows nothing for an older page (no ranges) or a single one', () => {
    expect(rangeOptions(undefined)).toEqual([]);
    expect(rangeOptions(['24h'])).toEqual([]);
  });
});

describe('figures', () => {
  it('carry a small line or a meter in their colour, a warn tone winning', () => {
    const tiles = figureTiles(panelOf(sample(), 'kpis').items, '24h');
    expect(tiles.map((t) => [t.key, t.swatch, !!t.spark, t.meter])).toEqual([
      ['cpu', 'chart1', true, null],
      ['memory', 'chart4', true, null],
      ['disk', 'warn', true, null],
      ['database', 'chart3', true, null],
      ['integrations', 'warn', false, 100 / 102],
    ]);
    expect(tiles[2]?.spoken).toMatch(
      /^Disk: 30 \/ 40 GB, 76 % · full in about 2 months\. Last 24 hours: (rising|steady)/,
    );
    expect(tiles[4]?.spoken).toBe('Integrations: 100 of 102, 2 not loading');
  });

  it('draw no small line with fewer than two values read', () => {
    const [tile] = figureTiles([{ key: 'x', label: 'X', value: '1', spark: [null, 3], meter: 0.5 }], '24h');
    expect([tile?.spark, tile?.meter]).toEqual([null, 0.5]);
  });
});

describe('chart cards', () => {
  it('keep the figure, the average and the peak, and the facts under it', () => {
    const chart = chartCard(panelOf(sample(), 'chart', 'cpu'), '24h', ZONE);
    if (!chart) throw new Error('no chart');
    expect(chart.figure).toEqual({ value: '2 %', rest: 'of 4 cores', tone: null });
    expect(chart.foot.map((f) => `${f.label} ${f.value}`)).toEqual([
      'homeassistant 1.6 %',
      'core-mariadb 0.4 %',
    ]);
    expect([chart.min, chart.max, chart.ticks, chart.tickLabel(10)]).toEqual([0, 10, [0, 5, 10], '10%']);
    expect(chart.lines.map((l) => [l.swatch, l.fill])).toEqual([['chart1', true]]);
    expect(chart.legend).toEqual([]);
    expect(chart.timeTicks.at(-1)).toEqual({ index: chart.count - 1, label: 'Now' });
    expect(chart.spoken).toBe('CPU, 2 % of 4 cores, Avg 1.8 %, Peak 4.6 % Sun 04:05');
  });

  it('start the scale where the axis says, and draw the forecast into room after the last point', () => {
    const chart = chartCard(panelOf(sample(), 'chart', 'disk'), '24h', ZONE);
    if (!chart?.forecast) throw new Error('no forecast');
    expect([chart.min, chart.max, chart.tickLabel(75)]).toEqual([50, 100, '75%']);
    expect(chart.slots).toBeGreaterThan(chart.count);
    expect(chart.forecast.from.index).toBe(chart.count - 1);
    expect(chart.forecast.to).toEqual({ index: chart.slots - 1, value: 100 });
    expect(chart.forecast.label).toMatch(/^full ~\d{1,2} \w{3}$/);
    // Now stays where the points end; the forecast's day is the last word.
    expect(chart.timeTicks.find((t) => t.label === 'Now')?.index).toBe(chart.count - 1);
    expect(chart.timeTicks.at(-1)?.index).toBe(chart.slots - 1);
    expect(chart.lines[0]?.swatch).toBe('warn');
  });

  it('stack bars per point, the noisiest source orange and everything else grey, with a legend', () => {
    const panel = panelOf(sample(), 'chart', 'errors');
    const chart = chartCard(panel, '24h', ZONE);
    if (!chart) throw new Error('no chart');
    expect(chart.bars).toBe(true);
    expect(chart.columns).toHaveLength(chart.count);
    expect(chart.columns[0]).toHaveLength(2);
    expect(chart.legend.map((l) => [l.label, l.swatch, l.latest])).toEqual([
      ['Modbus', 'chart2', '11,280'],
      ['Everything else', 'mut', '1,006'],
    ]);
    const tallest = Math.max(...chart.columns.map((c) => (c[0] ?? 0) + (c[1] ?? 0)));
    expect(chart.max).toBeGreaterThanOrEqual(tallest);
    expect(chart.readout(0).lines[0]?.value).toMatch(/^\d+$/);
  });

  it('scale a right-axis line onto the left one; the readout says its own figure', () => {
    const chart = chartCard(
      {
        kind: 'chart',
        id: 'machine',
        title: 'CPU and memory',
        timestamps: [at('13:00'), at('13:30'), at('14:00')],
        series: [
          { key: 'cpu', label: 'CPU', unit: '%', values: [4, 6, 5] },
          { key: 'mem', label: 'Memory', unit: 'GB', axis: 'right', values: [3.1, 3.0, 2.9] },
        ],
      },
      '24h',
      ZONE,
    );
    if (!chart) throw new Error('no chart');
    expect(chart.lines.map((l) => l.swatch)).toEqual(['chart1', 'chart2']);
    expect(chart.lines[1]?.values[2]).not.toBe(2.9);
    expect(chart.readout(2).lines.map((l) => l.value)).toEqual(['5 %', '2.9 GB']);
    expect(chart.legend.map((l) => l.latest)).toEqual(['5 %', '2.9 GB']);
    expect(chart.spoken).toBe('CPU and memory, CPU 5 %, Memory 2.9 GB');
  });

  it('give a chart without anything read no chart', () => {
    expect(
      chartCard(
        {
          kind: 'chart',
          id: 'c',
          title: 'C',
          timestamps: [at('14:00')],
          series: [{ key: 'x', label: 'X', values: [null] }],
        },
        '24h',
        ZONE,
      ),
    ).toBeNull();
  });

  it('follow the range: a week has its days along the bottom', () => {
    const chart = chartCard(panelOf(sample('7d'), 'chart', 'cpu'), '7d', ZONE);
    expect(chart?.count).toBe(85);
    expect(chart?.timeTicks[0]?.label).toMatch(/^\d{1,2} \w{3,4}$/);
  });

  it('round the scale’s top so its middle is round too', () => {
    expect([niceTop(0.4), niceTop(6.6), niceTop(220), niceTop(1166), niceTop(0)]).toEqual([
      0.4, 8, 400, 2000, 1,
    ]);
    expect([axisWord(100, '%'), axisWord(60, '°C'), axisWord(8, 'GB'), axisWord(1500, 'Mb/s')]).toEqual([
      '100%',
      '60°',
      '8 GB',
      '1.5k',
    ]);
  });

  it('keep the first and the last word along the bottom, and those between that fit', () => {
    const ticks = ['Sat 14:00', 'Sat 20:00', 'Sun 02:00', 'Sun 08:00', 'Now'].map((label, i) => ({
      index: i * 24,
      label,
    }));
    expect(fitTicks(ticks, (i) => i * 2.5).map((t) => t.label)).toEqual(['Sat 14:00', 'Sun 02:00', 'Now']);
    expect(fitTicks(ticks, (i) => i * 10)).toHaveLength(5);
  });
});

describe('bar lists', () => {
  it('give each line its bar in its tone and say it for TalkBack', () => {
    const rows = barRows({
      kind: 'bars',
      id: 'array',
      title: 'Array',
      items: [
        { id: 'parity', label: 'Parity', mono: true, note: 'WD Red 8 TB · 34 °C', value: 'valid', pct: null },
        {
          id: 'disk1',
          label: 'Disk 1',
          mono: true,
          note: 'WD Red 8 TB · spun down',
          value: '7.1 of 8 TB',
          pct: 0.89,
          tone: 'warn',
          sub: '89 % · new files go to disks 2 and 3',
          subTone: 'warn',
          href: '/things/server%3Ablackbox?tab=array',
        },
      ],
    });
    expect(rows.map((r) => [r.label, r.pct, r.swatch, r.href])).toEqual([
      ['Parity', null, 'chart1', null],
      ['Disk 1', 0.89, 'warn', '/things/server%3Ablackbox?tab=array'],
    ]);
    expect(rows[1]?.spoken).toBe(
      'Disk 1, WD Red 8 TB · spun down: 7.1 of 8 TB. 89 % · new files go to disks 2 and 3',
    );
  });
});

describe('Worth a look', () => {
  it('shows five and folds the rest behind “Show N more”', () => {
    const rows = Array.from({ length: 9 }, (_, i) => i);
    expect(foldNotices(rows, false)).toEqual({ shown: [0, 1, 2, 3, 4], more: 4 });
    expect(foldNotices(rows, true)).toEqual({ shown: rows, more: 0 });
    expect(foldNotices(rows.slice(0, 5), false).more).toBe(0);
  });
});

describe('tables', () => {
  it('put a server’s CPU with its small bar on the right, its day under it and Open beside it', () => {
    // A table of servers as a page draws it (Hetzner's page is in slots now: its servers are live rows).
    const [row] = tableRows({
      kind: 'table',
      id: 'servers',
      title: 'Servers',
      columns: [
        { key: 'name', label: 'Server' },
        { key: 'type', label: 'Type' },
        { key: 'cpu', label: 'CPU', numeric: true },
        { key: 'day', label: '24 h' },
        { key: 'address', label: 'Address', numeric: true },
        { key: 'open', label: '' },
      ],
      rows: [
        {
          id: 'whombat-prod',
          cells: {
            name: { text: 'whombat-prod', mono: true, dot: 'ok', note: 'Debian 13 · Falkenstein' },
            type: { text: 'CX32', note: '4 vCPU · 8 GB · 80 GB' },
            cpu: { text: '7 %', mono: true, meter: 0.07 },
            day: { text: '', spark: [4, 7, 5, 9, 7] },
            address: { text: '203.0.113.44', mono: true },
            open: { text: 'Open', button: true, href: '/things/server%3Apve-01' },
          },
        },
      ],
    });
    expect(row).toMatchObject({
      title: 'whombat-prod',
      titleMono: true,
      note: 'Debian 13 · Falkenstein',
      dot: 'ok',
      line: [{ text: 'CX32 (4 vCPU · 8 GB · 80 GB)', mono: false, meter: null }],
      right: [
        { text: '7 %', mono: true, meter: 0.07 },
        { text: '203.0.113.44', mono: true, meter: null },
      ],
      button: { label: 'Open', href: '/things/server%3Apve-01' },
      href: null,
    });
    expect(row?.spark?.length).toBeGreaterThan(1);
    expect(row?.spoken).toMatch(
      /^whombat-prod, Debian 13 · Falkenstein\. Type: CX32 \(4 vCPU · 8 GB · 80 GB\)\. CPU: 7 %\. Address: 203\.0\.113\.44\. 24 h: \w+/,
    );
  });

  it('leave out a console button (the web’s) and one that goes where the row goes', () => {
    const rows = tableRows({
      kind: 'table',
      id: 'guests',
      title: 'Busiest guests',
      columns: [
        { key: 'name', label: 'Guest' },
        { key: 'console', label: '' },
      ],
      rows: [
        {
          id: 'a',
          cells: {
            name: { text: 'home-assistant', href: '/things/server%3Apve-02?guest=pve%3A131' },
            console: { text: 'Console', button: true, href: '/things/server%3Apve-02?console=pve%3A131' },
          },
        },
        {
          id: 'b',
          cells: {
            name: { text: 'pihole', href: '/things/server%3Apve-02?guest=pve%3A101' },
            console: { text: 'Open', button: true, href: '/things/server%3Apve-02?guest=pve%3A101' },
          },
        },
      ],
    });
    expect(rows.map((r) => [r.href, r.button])).toEqual([
      ['/things/server%3Apve-02?guest=pve%3A131', null],
      ['/things/server%3Apve-02?guest=pve%3A101', null],
    ]);
  });

  it('say a state’s note after it and a dot that isn’t fine', () => {
    const [row] = tableRows(panelOf(ha(), 'table', 'not-loading'));
    expect(row).toMatchObject({
      title: 'Shelly · Pool pump',
      dot: 'warn',
      line: [{ text: 'Retrying (cannot reach 10.100.0.87 since Thu 07:12)', tone: 'warn' }],
    });
    expect(row?.spoken).toBe(
      'Shelly · Pool pump. Needs a look. State: Retrying (cannot reach 10.100.0.87 since Thu 07:12)',
    );
  });
});

describe('a wide page', () => {
  const text = (id: string, extra: Partial<ThingPagePanel> = {}) =>
    ({ kind: 'text', id, body: id, ...extra }) as ThingPagePanel;
  const chart = (id: string, span?: 1 | 2 | 3) =>
    ({
      kind: 'chart',
      id,
      title: id,
      place: 'chart',
      span,
      timestamps: [],
      series: [],
    }) as unknown as ThingPagePanel;
  const ids = (list: readonly ThingPagePanel[]) => list.map((p) => p.id);

  it('keeps the web’s places: the top, the chart lines, the two columns, the bottom', () => {
    const laid = wideLayout([
      text('banner', { place: 'top' }),
      chart('cpu'),
      chart('mem'),
      chart('net', 2),
      chart('disk'),
      text('list', { place: 'main' }),
      text('facts', { place: 'side' }),
      text('end', { place: 'bottom' }),
    ]);
    expect(ids(laid.top)).toEqual(['banner']);
    // Two to a line; a wide card, and one left alone, take a line.
    expect(laid.chartLines.map(ids)).toEqual([['cpu', 'mem'], ['net'], ['disk']]);
    expect([ids(laid.main), ids(laid.side), ids(laid.bottom)]).toEqual([['list'], ['facts'], ['end']]);
    expect(laid.mainFlex).toBeGreaterThan(1);
  });

  it('gives a settings tab two columns as wide as each other', () => {
    const settings = (id: string, place: 'main' | 'side') =>
      ({ kind: 'settings', id, title: id, place, rows: [] }) as unknown as ThingPagePanel;
    const laid = wideLayout([settings('a', 'main'), settings('b', 'side')]);
    expect([ids(laid.main), ids(laid.side), laid.mainFlex]).toEqual([['a'], ['b'], 1]);
  });
});

describe('where the range control stands', () => {
  const panel = (id: string, kind: string) => ({ id, kind }) as unknown as ThingPagePanel;
  it('stands above the first chart, else above the figures, else at the top', () => {
    expect(rangePlace([panel('look', 'notices'), panel('figs', 'kpis'), panel('cpu', 'chart')])).toBe('cpu');
    expect(rangePlace([panel('look', 'notices'), panel('figs', 'kpis')])).toBe('figs');
    expect(rangePlace([panel('look', 'notices')])).toBeNull();
  });
});
