/**
 * The generic mapping of a page's panels into widgets (desk-display-server.md “Every connection's widgets”): words a
 * screen can draw, times, points, a table as rows, a gallery as posters or a camera, a chart's lines, and what *Add a
 * widget* offers of a page.
 */
import { DeskWidgetView, type ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { kindHints } from './thing-kinds';
import { NOW, pageOf, pictureRef, TZ } from './thing-testing';
import {
  catalogItems,
  chartView,
  dateWords,
  figuresPrivate,
  figuresView,
  NO_HINTS,
  type PanelHint,
  panelHint,
  panelView,
  rowTime,
  slotFigures,
  splitReading,
  squeeze,
  viewKindOf,
  words,
} from './thing-views';

const b = { id: 'w_x', title: 'Something' };
const THING = 'connection:con_x' as const;
const view = (panel: ThingPagePanel, hint?: PanelHint, item?: string) =>
  panelView({
    b,
    thing: THING,
    page: pageOf({ panels: [panel] }, { catalogId: 'x', name: 'X' }),
    panel,
    hint,
    item,
    now: NOW,
    timeZone: TZ,
  });
const listOf = (v: ReturnType<typeof view>) => {
  if (v?.kind !== 'list') throw new Error(`a list, got ${JSON.stringify(v)}`);
  return v;
};
const figuresOf = (v: ReturnType<typeof view>) => {
  if (v?.kind !== 'figures') throw new Error(`figures, got ${JSON.stringify(v)}`);
  return v;
};

describe('words for a screen', () => {
  it('are one plain line: no markdown, no odd spaces or controls, clipped with an ellipsis', () => {
    expect(words('**30** GB free​', 40)).toBe('30 GB free');
    expect(words('a\nb', 40)).toBe('a b');
    expect(words('abcdefghij', 5)).toBe('abcd…');
    expect(words(undefined, 5)).toBe('');
  });

  it('say a time as the hour today, the day within a week, else the date', () => {
    expect(rowTime('2026-10-21T19:00:00Z', NOW, TZ)).toBe('21:00');
    expect(rowTime('2026-10-23T19:00:00Z', NOW, TZ)).toBe('Fri');
    expect(rowTime('2026-11-14T19:00:00Z', NOW, TZ)).toBe('14 Nov');
    expect(rowTime('soon', NOW, TZ)).toBeUndefined();
  });

  it('split a reading into its figure and unit', () => {
    expect(splitReading('21.5 °C')).toEqual({ value: '21.5', rest: '°C' });
    expect(splitReading('Open')).toEqual({ value: 'Open' });
  });
});

describe('points', () => {
  it('are at most 120, each the average of those it stands for; a bucket with none stays empty', () => {
    const long = Array.from({ length: 600 }, (_, i) => (i < 5 ? null : i));
    const out = squeeze(long);
    expect(out).toHaveLength(120);
    expect(out[0]).toBeNull();
    expect(squeeze([1.234, null, Number.NaN])).toEqual([1.23, null, null]);
  });
});

describe('a panel as a view', () => {
  it('turns a table into rows: title, the figure on the right that isn’t its bar, the rest under it', () => {
    const v = view({
      kind: 'table',
      id: 't',
      title: 'Containers',
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'state', label: 'State' },
        { key: 'cpu', label: 'CPU', numeric: true },
        { key: 'mem', label: 'Memory', numeric: true },
        { key: 'image', label: 'Image' },
        { key: 'go', label: '' },
      ],
      rows: [
        {
          id: 'r1',
          cells: {
            name: { text: 'plex', note: 'stack media', dot: 'ok' },
            state: { text: 'Running' },
            cpu: { text: '12 %', meter: 0.12 },
            mem: { text: '1.2 GB' },
            image: { text: '—' },
            go: { text: 'Restart', action: { action: 'restart', label: 'Restart', allowed: true } },
          },
        },
      ],
    });
    if (v?.kind !== 'list') throw new Error('a list');
    expect(v.rows[0]).toEqual({
      title: 'plex',
      detail: 'stack media · Running',
      meta: '1.2 GB',
      tone: 'ok',
      progress: 12,
    });
  });

  it('turns a gallery of snapshots into a camera, and other galleries into posters', () => {
    const items = [
      {
        id: 'c1',
        title: 'Garden',
        image: { ref: pictureRef('snap/c1', true), alt: '', shape: 'wide' as const },
      },
    ];
    const camera: ThingPagePanel = { kind: 'gallery', id: 'cams', title: 'Cameras', shape: 'wide', items };
    expect(viewKindOf(camera)).toBe('camera');
    const v = view(camera);
    expect(v).toMatchObject({ kind: 'camera', title: 'Garden', image: { thing: THING, shape: 'wide' } });
    const still: ThingPagePanel = {
      ...camera,
      items: [
        { ...items[0], image: { ref: pictureRef('poster/1'), alt: 'A poster', shape: 'poster' as const } },
      ] as never,
    };
    expect(viewKindOf(still)).toBe('posters');
  });

  it('draws a chart’s left-axis lines with their tones, its figure, facts and dashed line', () => {
    const chart = chartView(b, {
      kind: 'chart',
      id: 'cpu',
      title: 'CPU',
      timestamps: [],
      series: [
        { key: 'cpu', label: 'CPU', values: Array.from({ length: 300 }, (_, i) => i % 100), color: 'red' },
        { key: 'mem', label: 'Memory', unit: 'GB', values: [1, 2.04], axis: 'right' },
      ],
      figure: { value: '18 %', rest: 'of 16 threads' },
      stats: [[{ text: 'Avg ' }, { text: '14 %', strong: true }]],
      line: { value: 90 },
      axis: { unit: '%' },
    });
    expect(chart).toMatchObject({
      kind: 'chart',
      figure: { value: '18 %', rest: 'of 16 threads' },
      // The right-axis line isn't drawn on the screen's one scale: it's said instead.
      stats: ['Avg 14 %', 'Memory 2 GB'],
      unit: '%',
      limit: 90,
    });
    if (chart?.kind !== 'chart') throw new Error('a chart');
    expect(chart.series).toHaveLength(1);
    expect(chart.series[0]).toMatchObject({ label: 'CPU', tone: 'bad' });
    expect(chart.series[0]?.points).toHaveLength(120);
    expect(DeskWidgetView.safeParse(chart).success).toBe(true);
  });

  it('colours a row by the worst of its cells’ dots and tones', () => {
    const table = (cells: Extract<ThingPagePanel, { kind: 'table' }>['rows'][number]['cells']) =>
      listOf(
        view({
          kind: 'table',
          id: 't',
          title: 'Tasks',
          columns: [
            { key: 'name', label: 'Task' },
            { key: 'due', label: 'Due' },
          ],
          rows: [{ id: 'r', cells }],
        }),
      ).rows[0];
    expect(
      table({ name: { text: 'Pay rent', dot: 'ok' }, due: { text: '3 days late', tone: 'bad' } })?.tone,
    ).toBe('bad');
    expect(table({ name: { text: 'Side door' }, due: { text: 'Open', tone: 'warn' } })?.tone).toBe('warn');
    expect(table({ name: { text: 'Plex', dot: 'off' }, due: { text: '—', tone: 'muted' } })?.tone).toBe(
      'off',
    );
  });

  it('keeps a bar’s words: on the right when there’s no other figure, a second bar’s under the title', () => {
    const v = listOf(
      view({
        kind: 'table',
        id: 'servers',
        title: 'Servers',
        columns: [
          { key: 'name', label: 'Server' },
          { key: 'memory', label: 'Memory', numeric: true },
          { key: 'disk', label: 'Disk', numeric: true },
        ],
        rows: [
          {
            id: 'r',
            cells: {
              name: { text: 'minecraft' },
              memory: { text: '1.2 of 4 GB', meter: 0.3 },
              disk: { text: '3.1 of 10 GB', meter: 0.31 },
            },
          },
        ],
      }),
    );
    expect(v.rows[0]).toMatchObject({ meta: '1.2 of 4 GB', detail: 'Disk 3.1 of 10 GB', progress: 30 });
  });

  it('puts a column the kind names as the row’s time', () => {
    const v = listOf(
      view(
        {
          kind: 'table',
          id: 'grabs',
          title: 'Grabs',
          columns: [
            { key: 'title', label: 'Title' },
            { key: 'indexer', label: 'Indexer' },
            { key: 'at', label: 'When' },
          ],
          rows: [
            {
              id: 'r',
              cells: { title: { text: 'Dune' }, indexer: { text: 'nzbgeek' }, at: { text: '2 h ago' } },
            },
          ],
        },
        { panel: 'grabs', columns: { time: 'at' } },
      ),
    );
    expect(v.rows[0]).toEqual({ title: 'Dune', detail: 'nzbgeek', time: '2 h ago' });
  });

  it('counts the rows of the whole list when the Summary shows only the first', () => {
    const rows = Array.from({ length: 41 }, (_, i) => ({
      id: `r${i}`,
      cells: { name: { text: `box-${i}` } },
    }));
    const columns = [{ key: 'name', label: 'Device' }];
    const summary: ThingPagePanel = {
      kind: 'table',
      id: 'devices',
      title: 'Devices',
      columns,
      rows: rows.slice(0, 15),
    };
    const page = pageOf(
      {
        panels: [summary],
        tabs: [
          {
            key: 'devices',
            label: 'Devices',
            panels: [{ kind: 'table', id: 'devices', title: 'Devices', columns, rows }],
          },
        ],
      },
      { catalogId: 'x', name: 'X' },
    );
    const v = panelView({ b, thing: THING, page, panel: summary, now: NOW, timeZone: TZ });
    expect(listOf(v).count).toBe(41);
  });

  it('shows a thermostat’s room temperature big and the setpoint under it, also when it is off', () => {
    const thermostat = (control: Record<string, unknown>) =>
      figuresOf(
        view(
          {
            kind: 'controls',
            id: 'controls',
            title: 'Controls',
            groups: [
              { id: 'other', title: 'Other', items: [{ id: 'climate.hall', label: 'Hall', ...control }] },
            ],
          },
          undefined,
          'climate.hall',
        ),
      );
    const heating = thermostat({
      icon: 'thermostat',
      state: 'Now 20.5 °C · Heating',
      stepper: {
        value: 21,
        min: 7,
        max: 35,
        step: 0.5,
        unit: '°C',
        button: { action: 'ha-temp', label: 'Set temperature', allowed: true },
      },
    });
    expect(heating.items[0]).toMatchObject({ value: '20.5', unit: '°C' });
    expect(heating.line).toBe('Set to 21 °C · Heating');
    const off = thermostat({ icon: 'thermostat', state: 'Now 19 °C · Off' });
    expect(off.items[0]).toMatchObject({ value: '19', unit: '°C' });
    expect(off.line).toBe('Off');
  });

  it('says a sensor’s date as a day, not a timestamp', () => {
    expect(dateWords('2026-10-21', NOW, TZ)).toBe('Today');
    expect(dateWords('2026-10-22', NOW, TZ)).toBe('Tomorrow');
    expect(dateWords('2026-10-27', NOW, TZ)).toBe('Tuesday');
    expect(dateWords('2026-11-14', NOW, TZ)).toBe('14 Nov');
    expect(dateWords('2026-10-23T04:00:00+00:00', NOW, TZ)).toBe('Friday 06:00');
    expect(dateWords('21.5', NOW, TZ)).toBeNull();
    const bins = figuresOf(
      view(
        {
          kind: 'controls',
          id: 'controls',
          title: 'Controls',
          groups: [
            {
              id: 'other',
              title: 'Other',
              items: [{ id: 'sensor.bins', label: 'Bins', icon: 'sensor', state: '2026-10-24' }],
            },
          ],
        },
        undefined,
        'sensor.bins',
      ),
    );
    expect(bins.items[0]?.value).toBe('Saturday');
  });

  it('leaves a version number out of the figures while there are others', () => {
    const v = figuresView(b, [
      { key: 'version', label: 'Version', value: '11.2.0' },
      { key: 'firing', label: 'Firing', value: '2' },
    ]);
    expect(v?.kind === 'figures' && v.items.map((i) => i.label)).toEqual(['Firing']);
    const alone = figuresView(b, [{ key: 'version', label: 'Version', value: '11.2.0' }]);
    expect(alone?.kind === 'figures' && alone.items[0]?.value).toBe('11.2.0');
  });

  it('makes the figures private when one of the four shown is money or a person', () => {
    const kpis = [
      { key: 'servers', label: 'Servers', value: '3' },
      { key: 'cost', label: 'Cost', value: '€ 12' },
    ];
    expect(figuresPrivate({ privateFigures: ['cost'] }, kpis)).toBe(true);
    expect(figuresPrivate({ privateFigures: ['cost'] }, kpis.slice(0, 1))).toBe(false);
    const many = ['a', 'b', 'c', 'd'].map((key) => ({ key, label: key, value: '1' }));
    expect(figuresPrivate({ privateFigures: ['cost'] }, [...many, kpis[1] as (typeof kpis)[number]])).toBe(
      false,
    );
  });

  it('leaves quiet lines out of Worth a look, and the info tone', () => {
    const v = view({
      kind: 'notices',
      id: 'notices',
      title: 'Worth a look',
      items: [
        { id: 'a', tone: 'bad', icon: 'disk', title: 'Disk full' },
        { id: 'b', tone: 'info', icon: 'info', title: 'An update' },
        {
          id: 'c',
          tone: 'warn',
          icon: 'warn',
          title: 'Ignored',
          quiet: { state: 'ignored', words: 'Ignored', at: NOW.toISOString() },
        },
      ],
    });
    if (v?.kind !== 'list') throw new Error('a list');
    expect(v.rows).toEqual([{ title: 'Disk full', tone: 'bad' }, { title: 'An update' }]);
  });
});

describe('what a page offers Add a widget', () => {
  it('its figures first, its panels, Worth a look last; nothing about Whombat itself', () => {
    const page = pageOf(
      {
        kpis: [{ key: 'a', label: 'Used', value: '75 %' }],
        panels: [
          { kind: 'list', id: 'log', title: 'Log', items: [{ id: '1', title: 'Started' }] },
          { kind: 'text', id: 'part-of', title: 'Part of pve-01', body: 'How Whombat reaches it.' },
          { kind: 'access', id: 'access', title: 'What Whombat may do', items: [], lookOnly: false },
          { kind: 'changes', id: 'changes', title: 'Changes here', limit: 5 },
        ],
      },
      { catalogId: 'x', name: 'X' },
    );
    const items = catalogItems(page, THING, NO_HINTS, 'x');
    expect(items.map((i) => i.opts.panel ?? i.type)).toEqual(['figures', 'log', 'notices']);
    expect(items[0]).toMatchObject({ name: 'Figures', line: 'Used', mark: 'x', view: 'figures' });
    expect(items[1]).toMatchObject({ name: 'Log', line: 'Started', view: 'list' });
  });
});

describe('a slots page’s figures', () => {
  it('keep a line’s colour: a nearly full pool stays amber, a line of the Live list stays red', () => {
    const figures = slotFigures([
      {
        kind: 'list',
        id: 'now',
        place: 'chart',
        span: 2,
        title: 'Now',
        items: [{ id: 'blocked', title: 'Blocked', figure: { value: 'Off', tone: 'bad' } }],
      },
      {
        kind: 'list',
        id: 'pools',
        look: 'counts',
        place: 'chart',
        span: 1,
        title: 'Pools',
        items: [
          { id: 'tank', title: 'Tank', tone: 'warn', figure: { value: '92 %', note: '+120 GB this week' } },
          { id: 'fast', title: 'Fast', figure: { value: '40 %', note: '+2 GB', tone: 'ok' } },
        ],
      },
    ]);
    expect(figures.map((f) => [f.key, f.value, f.tone])).toEqual([
      ['blocked', 'Off', 'bad'],
      ['f-tank', '92 %', 'warn'],
      ['f-fast', '40 %', undefined],
    ]);
  });

  it('keep a gallery’s people private: a row someone is at, and a count of rows people are at', () => {
    const gallery = (id: string, people: boolean): ThingPagePanel => ({
      kind: 'gallery',
      id,
      place: 'main',
      span: 2,
      title: id === 'now' ? 'Now playing' : 'Downloads',
      shape: 'poster',
      look: 'rows',
      items: [
        {
          id: `${id}-1`,
          title: 'Dune',
          progress: 0.4,
          note: '38:12 of 55:00',
          ...(people ? { person: { name: 'Anna', note: 'iPad' } } : {}),
        },
        { id: `${id}-2`, title: 'Arrival', progress: 0.1 },
      ],
    });
    const figures = slotFigures(
      [gallery('now', true), gallery('queue', false), gallery('limits', true)],
      ['limits'],
    );
    const privacy = Object.fromEntries(figures.map((f) => [f.key, !!f.private]));
    expect(privacy).toEqual({
      now: true,
      queue: false,
      'limits-1': true,
      'limits-2': false,
    });
  });
});

describe('limits as meters of blocks', () => {
  const fusebox = kindHints('fusebox');
  const subsHint = panelHint(fusebox, 'subscriptions');
  const limitsHint = panelHint(fusebox, 'limits');
  const meter = (used: number) => ({ text: `${used} %`, mono: true, meter: used / 100 });
  const subs: ThingPagePanel = {
    kind: 'table',
    id: 'subscriptions',
    place: 'main',
    title: 'Subscriptions',
    meta: '2 of 3 working',
    columns: [
      { key: 'subscription', label: 'Subscription' },
      { key: 'five', label: '5 hours', numeric: true },
      { key: 'week', label: 'Week', numeric: true },
      { key: 'resets', label: 'Week resets' },
      { key: 'status', label: 'Status' },
    ],
    rows: [
      {
        id: 'a',
        cells: {
          subscription: { text: 'work@example.com', note: 'Claude · Ultra', mark: 'claude' },
          five: { text: 'No limit', tone: 'muted' },
          week: { ...meter(92), tone: 'warn' },
          resets: { text: '2 Dec', mono: true },
          status: { text: 'Working', dot: 'ok', note: '2 min ago' },
        },
      },
      {
        id: 'b',
        cells: {
          subscription: { text: 'muse@example.com', note: 'Meta · Muse Code Max', mark: 'meta' },
          five: meter(3),
          week: meter(1),
          resets: { text: '30 Nov', mono: true },
          status: { text: 'Working', dot: 'ok' },
        },
      },
      {
        id: 'c',
        cells: {
          subscription: { text: 'old@example.com', note: 'Claude', mark: 'claude' },
          five: { text: '—', tone: 'muted' },
          week: { text: '—', tone: 'muted' },
          resets: { text: '—', tone: 'muted' },
          status: { text: 'Off in Fusebox', dot: 'off' },
        },
      },
    ],
  };
  const draw = (panel: ThingPagePanel, hint: PanelHint | undefined, limits?: 'used' | 'left') =>
    panelView({
      b,
      thing: THING,
      page: pageOf({ panels: [panel] }, { catalogId: 'fusebox', name: 'Fusebox' }),
      panel,
      hint,
      limits,
      now: NOW,
      timeZone: TZ,
    });

  it('draws each subscription with its mark, its limits as blocks, the week’s reset and how it is', () => {
    const v = listOf(draw(subs, subsHint));
    expect(DeskWidgetView.safeParse(v).success).toBe(true);
    expect(v.head).toBe('2 of 3 working');
    expect(v.rows[0]).toMatchObject({
      title: 'work@example.com',
      detail: 'Claude · Ultra',
      meta: 'Working',
      note: 'used 2 min ago',
      tone: 'ok',
      mark: 'claude',
      // A screen without meters draws the week's bar, as it did.
      progress: 92,
    });
    // No 5-hour limit: only the week, amber from 80 %.
    expect(v.rows[0]?.meters).toEqual([
      { key: 'WEEK', pct: 92, text: '92 % used', reset: 'resets 2 Dec', tone: 'warn' },
    ]);
    expect(v.rows[1]?.meters?.map((m) => [m.key, m.text, m.reset])).toEqual([
      ['5H', '3 % used', undefined],
      ['WEEK', '1 % used', 'resets 30 Nov'],
    ]);
    // Off and unread: the week unlit, the row grey.
    expect(v.rows[2]).toMatchObject({ tone: 'off', meters: [{ key: 'WEEK', pct: 0, text: '–' }] });
    expect(v.rows[2]?.progress).toBeUndefined();
  });

  it('says what is left when the widget’s settings chose it, its colours still from what is used', () => {
    const v = listOf(draw(subs, subsHint, 'left'));
    expect(v.rows[0]?.meters?.[0]).toMatchObject({ pct: 8, text: '8 % left', tone: 'warn' });
    expect(v.rows[1]?.meters?.map((m) => m.text)).toEqual(['97 % left', '99 % left']);
    expect(v.rows[0]?.progress).toBe(8);
  });

  it('draws the pools’ limits with their tool’s mark and when they reset or run out', () => {
    const pools: ThingPagePanel = {
      kind: 'gallery',
      id: 'limits',
      place: 'chart',
      look: 'rows',
      shape: 'square',
      title: 'Limits now',
      items: [
        {
          id: 'claude-week',
          title: 'Claude · week',
          sub: '3 subscriptions',
          progress: 1,
          note: '100 % used',
          noteEnd: 'resets Fri 09:00',
          badge: { text: 'Used up', tone: 'bad' },
        },
        {
          id: 'codex-week',
          title: 'ChatGPT · week',
          sub: '1 subscription',
          progress: 0.22,
          noteEnd: 'resets 1 Dec',
        },
      ],
    };
    const v = listOf(draw(pools, limitsHint, 'left'));
    expect(
      v.rows.map((r) => [r.mark, r.title, r.detail, r.meta, r.meters?.[0]?.text, r.meters?.[0]?.reset]),
    ).toEqual([
      ['claude', 'Claude · week', '3 subscriptions', 'Used up', '0 % left', 'resets Fri 09:00'],
      ['openai', 'ChatGPT · week', '1 subscription', undefined, '78 % left', 'resets 1 Dec'],
    ]);
    expect(v.rows[0]?.meters?.[0]?.tone).toBe('bad');
  });

  it('offers the choice in the editor for Fusebox’s limits and subscriptions only', () => {
    const page = pageOf({ panels: [subs] }, { catalogId: 'fusebox', name: 'Fusebox' });
    const items = catalogItems(page, THING, fusebox, 'fusebox');
    expect(items.find((i) => i.opts.panel === 'subscriptions')?.limits).toBe(true);
    expect(items.filter((i) => i.limits).map((i) => i.opts.panel)).toEqual(['subscriptions']);
  });
});
