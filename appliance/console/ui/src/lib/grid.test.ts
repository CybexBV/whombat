import { OWN_WIDGETS, VIEW_KINDS, WIDGET_TYPES } from '@whombat/screen';
import { describe, expect, it } from 'vitest';
import { constList, deskScreensSource, deskSocketSource } from './contractsSource';
import {
  DESK_ATTENTION_MAX,
  DESK_GRID_MAX,
  DESK_OUTPUT_KEY_RE,
  DESK_OUTPUTS_MAX,
  DESK_PAGE_SHAPES_MAX,
  DESK_PAGE_WIDGETS_MAX,
  DESK_PAGES_MAX,
  DESK_SCREEN_ID_RE,
  DESK_SCREEN_VIEWS_MAX,
  DESK_SHAPE_RE,
  DESK_VIEW_POINTS_MAX,
  DESK_VIEW_ROWS_MAX,
  DESK_WIDGET_OPTS_MAX,
  DESK_WIDGET_REF_RE,
  lockedGrid,
  parseAttention,
  parseGrid,
  parseOutputGrids,
  parseView,
} from './grid';

const ref = 'eyJ0IjoicGxleCJ9.c2lnbmF0dXJl';
const widget = (id: string, type: string, x: number, y: number, w: number, h: number, more = {}) => ({
  id,
  type,
  opts: {},
  x,
  y,
  w,
  h,
  ...more,
});

/** The mockups' overview, as the runtime sends it. */
const grid = (more: Record<string, unknown> = {}) => ({
  screen: 'box',
  popups: 'all',
  layout: {
    turn: 'touch',
    size: 'normal',
    pages: [
      {
        id: 'p_first',
        name: 'Overview',
        last: '8x5',
        layouts: {
          '8x5': [
            widget('w_clock', 'clock', 0, 0, 3, 2),
            widget('w_status', 'status', 3, 0, 3, 2),
            widget('w_temp', 'panel', 6, 0, 2, 2, { ref: 'device:dev_T1', opts: { panel: 'climate' } }),
            widget('w_now', 'now', 0, 2, 4, 2),
            widget('w_pve', 'server', 4, 2, 2, 2, { ref: 'server:pve-01' }),
            widget('w_strip', 'strip', 0, 4, 8, 1),
          ],
        },
      },
      { id: 'p_media', name: 'Media', last: '8x5', layouts: { '8x5': [] } },
    ],
  },
  views: [
    {
      kind: 'chart',
      id: 'w_temp',
      title: 'Living room',
      mark: 'homeassistant',
      figure: { value: '21.4 °C', rest: '48 %' },
      series: [{ points: [19.8, null, 22.1] }],
      foot: [{ label: 'Today', value: '19.8 – 22.1 °C' }],
    },
    {
      kind: 'server',
      id: 'w_pve',
      title: 'pve-01',
      mark: 'proxmox',
      line: 'Proxmox · 16 cores',
      state: 'ok',
      cpu: 12,
      memory: 41,
      disk: 37,
      server: 'pve-01',
    },
  ],
  attention: {
    items: [
      {
        key: 'server:pve-02',
        kind: 'look',
        tone: 'bad',
        pops: true,
        title: 'pve-02 isn’t answering',
        since: '2026-10-27T13:30:00Z',
        name: 'pve-02',
        look: 'server:pve-02',
        server: 'pve-02',
      },
      { key: 'ask:12', kind: 'ask', tone: 'bad', pops: true, title: 'Dusty has a question', ask: 12 },
    ],
    more: 0,
    tone: 'bad',
  },
  ...more,
});

describe('the screen of widgets as the page reads it', () => {
  it('takes a sound grid as it came', () => {
    const g = grid();
    expect(parseGrid(g)).toEqual(g);
  });

  it('leaves out the widgets it can’t draw, and keeps the rest', () => {
    const g = parseGrid(
      grid({
        layout: {
          pages: [
            {
              id: 'p_first',
              name: '  Overview  ',
              last: '9x9',
              layouts: {
                '4x3': [
                  widget('w_clock', 'clock', 0, 0, 2, 1),
                  widget('w_clock', 'status', 2, 0, 2, 1), // the same id twice
                  widget('w_over', 'status', 1, 0, 2, 1), // on the clock
                  widget('w_out', 'status', 3, 2, 2, 1), // past the shape's edge
                  widget('w_new', 'weather', 0, 1, 1, 1), // a type this page doesn't know
                  widget('w_ref', 'server', 0, 1, 1, 1, { ref: 'file:/etc/passwd' }),
                  widget('w_half', 'status', 0.5, 2, 1, 1),
                  widget('w_ok', 'figures', 0, 2, 2, 1, {
                    ref: 'connection:con_P1',
                    opts: { panel: 'now', Bad: 'x', lock: '' },
                  }),
                ],
                big: [widget('w_x', 'clock', 0, 0, 1, 1)],
              },
            },
            { id: 'p_nothing', name: 'Nothing', last: '8x5', layouts: {} },
            { id: 'bad id', name: 'Bad', last: '8x5', layouts: { '8x5': [] } },
          ],
          turn: 'sometimes',
          size: 'huge',
        },
      }),
    );
    expect(g?.layout.turn).toBe('touch');
    expect(g?.layout.size).toBe('normal');
    expect(g?.layout.pages.map((p) => p.id)).toEqual(['p_first']);
    const page = g?.layout.pages[0];
    expect(page?.name).toBe('Overview');
    expect(page?.last).toBe('4x3');
    expect(Object.keys(page?.layouts ?? {})).toEqual(['4x3']);
    expect(page?.layouts['4x3']?.map((w) => w.id)).toEqual(['w_clock', 'w_ok']);
    expect(page?.layouts['4x3']?.[1]?.opts).toEqual({ panel: 'now' });
  });

  it('is none without a page it can draw, or a screen it knows', () => {
    expect(parseGrid(grid({ layout: { pages: [] } }))).toBeNull();
    expect(
      parseGrid(grid({ layout: { pages: [{ id: 'p_a', name: 'A', last: '8x5', layouts: {} }] } })),
    ).toBeNull();
    expect(parseGrid(grid({ screen: 'kitchen' }))).toBeNull();
    expect(parseGrid(grid({ screen: 'out_HDMI-A-1' }))).toBeNull();
    expect(parseGrid(grid({ screen: 'out_hdmi-a-1' }))?.screen).toBe('out_hdmi-a-1');
    expect(parseGrid([grid()])).toBeNull();
    expect(parseGrid(null)).toBeNull();
  });

  it('keeps the views it can draw, each id once', () => {
    const g = parseGrid(
      grid({
        views: [
          { kind: 'map', id: 'w_a', title: 'A map' },
          { kind: 'text', id: 'w_b', title: 'Note', body: ' Two \n lines ' },
          { kind: 'text', id: 'w_b', title: 'Again', body: 'Twice' },
          { kind: 'text', id: 'w_c', title: 'Empty', body: '  ' },
          { kind: 'server', id: 'w_d', title: 'gone', state: 'ok' },
          { kind: 'figures', id: 'w_e', title: 'Plex', items: [] },
          { kind: 'figures', id: 'w_f', title: 'Plex', items: [], locked: true },
          { kind: 'figures', id: 'w_g', title: 'Plex', items: [], problem: { text: 'Plex isn’t answering' } },
        ],
      }),
    );
    expect(g?.views.map((v) => v.id)).toEqual(['w_b', 'w_f', 'w_g']);
    expect(g?.views[0]).toEqual({ kind: 'text', id: 'w_b', title: 'Note', body: 'Two lines' });
  });

  it('reads a photo and a board, and drops a picture without its image and a tile without its colour', () => {
    const photo = parseView({
      kind: 'photo',
      id: 'w_p',
      title: 'On this day',
      every: 5,
      items: [
        { image: { thing: 'connection:con_I', ref, shape: 'wide' }, caption: '3 years ago · Texel' },
        { caption: 'no picture' },
      ],
    });
    expect(photo).toEqual({
      kind: 'photo',
      id: 'w_p',
      title: 'On this day',
      items: [{ image: { thing: 'connection:con_I', ref, shape: 'wide' }, caption: '3 years ago · Texel' }],
    });
    const board = parseView({
      kind: 'board',
      id: 'w_c',
      title: 'All containers',
      count: 52,
      items: [
        { label: 'plex', tone: 'ok' },
        { label: 'paperless', tone: 'bad', value: 'Stopped' },
        { label: 'x' },
      ],
    });
    expect(board).toEqual({
      kind: 'board',
      id: 'w_c',
      title: 'All containers',
      count: 52,
      items: [
        { label: 'plex', tone: 'ok' },
        { label: 'paperless', tone: 'bad', value: 'Stopped' },
      ],
    });
  });

  it('checks every member of a view, and drops what isn’t right', () => {
    const v = parseView({
      kind: 'list',
      id: 'w_q',
      title: 'SABnzbd',
      mark: 'SABnzbd',
      tone: 'red',
      head: '3 left · about 20 min',
      progress: 140,
      count: 9,
      at: 'yesterday',
      rows: [
        {
          title: 'Shōgun S01 1080p',
          meta: '4.2 GB',
          progress: 62,
          image: { thing: 'connection:con_S', ref, shape: 'wide' },
        },
        { title: 'The Bear', image: { thing: 'connection:con_S', ref: 'short.x', shape: 'wide' } },
        { detail: 'no title' },
        'a row',
      ],
    });
    expect(v).toEqual({
      kind: 'list',
      id: 'w_q',
      title: 'SABnzbd',
      head: '3 left · about 20 min',
      count: 9,
      rows: [
        {
          title: 'Shōgun S01 1080p',
          meta: '4.2 GB',
          progress: 62,
          image: { thing: 'connection:con_S', ref, shape: 'wide' },
        },
        { title: 'The Bear' },
      ],
    });
    const s = parseView({
      kind: 'server',
      id: 'w_s',
      title: 'pve-01',
      state: 'warn',
      server: 'pve-01',
      spark: [1, 50, 101, -3, 2.5, 'x', 99],
      range: '1y',
    });
    expect(s).toEqual({
      kind: 'server',
      id: 'w_s',
      title: 'pve-01',
      state: 'warn',
      server: 'pve-01',
      spark: [1, 50, 99],
    });
    const c = parseView({
      kind: 'chart',
      id: 'w_c',
      title: 'Internet',
      series: [{ points: Array.from({ length: 200 }, (_, i) => (i % 7 === 0 ? null : i)) }],
      limit: 'high',
    });
    expect(c?.kind === 'chart' && c.series[0]?.points.length).toBe(DESK_VIEW_POINTS_MAX);
    expect(c && 'limit' in c).toBe(false);
  });

  it('keeps what needs the person when the modal can act on it', () => {
    const a = parseAttention({
      items: [
        { key: 'ask:1', kind: 'ask', tone: 'bad', pops: true, title: 'Restart Plex?' },
        { key: 'ask:2', kind: 'ask', tone: 'bad', pops: 'yes', title: 'Restart Plex?', ask: 2 },
        { key: 'ask:3', kind: 'ask', tone: 'warn', pops: false, title: 'Restart Plex?', ask: 3, look: 'x' },
        {
          key: 'look:a',
          kind: 'look',
          tone: 'bad',
          pops: true,
          title: 'Zigbee stopped',
          look: 'connection:c',
          research: 'looking',
          fix: 'Restart',
        },
        {
          key: 'look:b',
          kind: 'look',
          tone: 'bad',
          pops: true,
          title: 'Zigbee stopped',
          look: 'connection:d',
          research: 'found',
          fix: 'Restart Zigbee',
        },
        { key: 'look:b', kind: 'look', tone: 'bad', pops: true, title: 'Twice', look: 'connection:d' },
      ],
      more: -1,
      tone: 'bad',
    });
    expect(a.items.map((i) => i.key)).toEqual(['ask:3', 'look:a', 'look:b']);
    expect(a.items[0]).toEqual({
      key: 'ask:3',
      kind: 'ask',
      tone: 'warn',
      pops: false,
      title: 'Restart Plex?',
      ask: 3,
    });
    expect(a.items[1]?.fix).toBeUndefined();
    expect(a.items[2]?.fix).toBe('Restart Zigbee');
    expect(a.more).toBe(0);
    expect(parseAttention({ items: [], more: 0, tone: 'bad' })).toEqual({ items: [], more: 0 });
  });

  it('reads the monitors’ screens', () => {
    const o = parseOutputGrids([
      { key: 'hdmi-a-1', name: 'DELL U2720Q', grid: grid({ screen: 'out_hdmi-a-1' }) },
      { key: 'hdmi-a-1', name: 'Twice', grid: grid() },
      { key: 'dp-3', grid: grid() },
      { key: 'DP-1', name: null, grid: grid() },
      // Past the four a page reports.
      { key: 'dp-2', name: null, grid: grid() },
    ]);
    expect(o.map((x) => [x.key, x.name])).toEqual([
      ['hdmi-a-1', 'DELL U2720Q'],
      ['dp-3', null],
    ]);
  });
});

describe('a grid the page shows locked itself (Whombat away, an unlock that ran out)', () => {
  const g = parseGrid(
    grid({
      views: [
        ...grid().views,
        {
          kind: 'posters',
          id: 'w_play',
          title: 'Now playing',
          name: 'Plex',
          shape: 'poster',
          items: [{ title: 'Dune' }],
        },
      ],
    }),
  );
  if (!g) throw new Error('no grid');
  const title = 'Dusty has a question';

  it('has no grid in Only the time', () => {
    expect(lockedGrid(g, 'time', title)).toBeNull();
  });

  it('shows every widget in Everything, without an ask’s words', () => {
    const e = lockedGrid(g, 'everything', title);
    expect(e?.views).toEqual(g.views);
    expect(e?.attention.items.map((i) => i.title)).toEqual(['pve-02 isn’t answering', title]);
  });

  it('keeps the servers in A summary and says “Unlock to see it” for the rest', () => {
    const s = lockedGrid(g, 'summary', title);
    expect(s?.views.find((v) => v.id === 'w_pve')).toEqual(g.views.find((v) => v.id === 'w_pve'));
    expect(s?.views.find((v) => v.id === 'w_play')).toEqual({
      kind: 'posters',
      id: 'w_play',
      title: 'Now playing',
      name: 'Plex',
      locked: true,
      items: [],
      shape: 'poster',
    });
    expect(s?.views.find((v) => v.id === 'w_temp')).toMatchObject({
      kind: 'chart',
      locked: true,
      series: [],
    });
    expect(s?.layout).toBe(g.layout);
  });
});

describe('the copies of the contract', () => {
  const constant = (src: string, name: string) => {
    const m = new RegExp(`export const ${name} = ([0-9_]+);`).exec(src);
    if (!m?.[1]) throw new Error(`${name} isn't in the vendored contracts`);
    return Number(m[1].replace(/_/g, ''));
  };
  const regex = (src: string, name: string) => {
    // A long pattern sits on the line under its name.
    const m = new RegExp(`export const ${name} =\\s*(/.*/);`).exec(src);
    if (!m?.[1]) throw new Error(`${name} isn't in the vendored contracts`);
    return m[1];
  };

  it('are the vendored desk-screens.ts and desk-socket.ts', () => {
    expect(DESK_PAGES_MAX).toBe(constant(deskScreensSource, 'DESK_PAGES_MAX'));
    expect(DESK_PAGE_WIDGETS_MAX).toBe(constant(deskScreensSource, 'DESK_PAGE_WIDGETS_MAX'));
    expect(DESK_PAGE_SHAPES_MAX).toBe(constant(deskScreensSource, 'DESK_PAGE_SHAPES_MAX'));
    expect(DESK_SCREEN_VIEWS_MAX).toBe(constant(deskScreensSource, 'DESK_SCREEN_VIEWS_MAX'));
    expect(DESK_ATTENTION_MAX).toBe(constant(deskScreensSource, 'DESK_ATTENTION_MAX'));
    expect(DESK_VIEW_ROWS_MAX).toBe(constant(deskScreensSource, 'DESK_VIEW_ROWS_MAX'));
    expect(DESK_VIEW_POINTS_MAX).toBe(constant(deskScreensSource, 'DESK_VIEW_POINTS_MAX'));
    expect(DESK_WIDGET_OPTS_MAX).toBe(constant(deskScreensSource, 'DESK_WIDGET_OPTS_MAX'));
    expect(DESK_GRID_MAX).toBe(constant(deskScreensSource, 'DESK_GRID_MAX'));
    expect(DESK_OUTPUTS_MAX).toBe(constant(deskSocketSource, 'DESK_OUTPUTS_MAX'));
    expect(String(DESK_SCREEN_ID_RE)).toBe(regex(deskScreensSource, 'DESK_SCREEN_ID_RE'));
    expect(String(DESK_WIDGET_REF_RE)).toBe(regex(deskScreensSource, 'DESK_WIDGET_REF_RE'));
    expect(String(DESK_SHAPE_RE)).toBe(regex(deskScreensSource, 'DESK_SHAPE_RE'));
    expect(deskSocketSource).toContain(`DeskOutputKey = z.string().regex(${String(DESK_OUTPUT_KEY_RE)});`);
    // The drawing's lists are the contract's.
    expect([...OWN_WIDGETS]).toEqual(constList(deskScreensSource, 'DESK_OWN_WIDGETS'));
    expect([...WIDGET_TYPES]).toEqual([...OWN_WIDGETS, 'server', 'figures', 'panel', 'widget']);
    expect(deskScreensSource).toContain(
      "export const DESK_WIDGET_TYPES = [...DESK_OWN_WIDGETS, 'server', 'figures', 'panel', 'widget'] as const;",
    );
    expect(deskScreensSource).toContain(`kind: z.literal('${VIEW_KINDS[0]}')`);
    for (const k of VIEW_KINDS) expect(deskScreensSource).toContain(`kind: z.literal('${k}')`);
  });
});
