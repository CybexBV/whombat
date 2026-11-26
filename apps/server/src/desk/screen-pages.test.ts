import {
  type DeskCatalogGroup,
  type DeskLayout,
  type DeskPage,
  deskDefaultLayout,
  deskLayoutProblem,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { catalogItemFor, keepPageTimes, placePage } from './screen-pages';

const SHAPE = { cols: 8, rows: 5 };
const MORNING = { from: '07:00', to: '09:00', days: ['mon' as const, 'tue' as const] };

const withPages = (pages: DeskPage[]): DeskLayout => ({ pages, turn: 'touch', size: 'normal' });
const empty = (id: string, show?: DeskPage['show']): DeskPage => ({
  id,
  name: id,
  layouts: { '8x5': [] },
  last: '8x5',
  ...(show ? { show } : {}),
});

describe('a layout from an app that can’t read page times', () => {
  it('keeps each page’s stored times by its id, and leaves new pages without', () => {
    const stored = withPages([empty('p_first'), empty('p_morning', MORNING)]);
    const sent = withPages([empty('p_morning'), empty('p_first'), empty('p_new')]);
    const kept = keepPageTimes(sent, stored);
    expect(kept.pages.map((p) => [p.id, p.show?.from ?? null])).toEqual([
      ['p_morning', '07:00'],
      ['p_first', null],
      ['p_new', null],
    ]);
  });

  it('changes nothing when nothing had times', () => {
    const sent = withPages([empty('p_first')]);
    expect(keepPageTimes(sent, withPages([empty('p_first')]))).toBe(sent);
  });
});

describe('a page made from a list of widgets', () => {
  it('places the widgets in the order asked, at the sizes asked within their limits, in reading order', () => {
    const r = placePage({
      layout: deskDefaultLayout(),
      shape: SHAPE,
      name: 'Media',
      widgets: [
        { type: 'clock', w: 3, h: 2 },
        // A list asked bigger than it can be is kept at its largest the grid allows.
        { type: 'panel', ref: 'connection:con_plex', opts: { panel: 'playing' }, w: 20, h: 9, view: 'list' },
        { type: 'status' },
      ],
    });
    if (!r.ok) throw new Error(r.why);
    const placed = r.page.layouts['8x5'] ?? [];
    expect(placed.map((w) => [w.type, w.x, w.y, w.w, w.h])).toEqual([
      ['clock', 0, 0, 3, 2],
      ['panel', 3, 0, 5, 5],
      ['status', 0, 2, 3, 2],
    ]);
    expect(r.ids).toEqual(placed.map((w) => w.id));
    expect(r.layout.pages.at(-1)).toBe(r.page);
    expect(deskLayoutProblem(r.layout)).toBeNull();
  });

  it('makes a widget smaller to fit, and leaves out what still doesn’t', () => {
    const r = placePage({
      layout: deskDefaultLayout(),
      shape: { cols: 4, rows: 2 },
      name: 'Small',
      widgets: [{ type: 'now', w: 4, h: 2 }, { type: 'clock' }, { type: 'strip' }],
    });
    if (!r.ok) throw new Error(r.why);
    expect(r.ids.map((id) => id !== null)).toEqual([true, false, false]);
  });

  it('gives every widget an id no other page uses, and the page an id of its own', () => {
    const r = placePage({
      layout: deskDefaultLayout(),
      shape: SHAPE,
      name: 'More',
      widgets: [{ type: 'clock' }, { type: 'done' }],
    });
    if (!r.ok) throw new Error(r.why);
    const others = new Set(
      deskDefaultLayout().pages.flatMap((p) =>
        Object.values(p.layouts)
          .flat()
          .map((w) => w.id),
      ),
    );
    for (const id of r.ids) expect(others.has(id ?? '')).toBe(false);
    expect(new Set(r.ids).size).toBe(2);
    expect(r.page.id).not.toBe('p_first');
  });

  it('keeps its times, refuses a seventh page, and takes a page’s place and id with replace', () => {
    const six = withPages(['p_1', 'p_2', 'p_3', 'p_4', 'p_5', 'p_6'].map((id) => empty(id)));
    const ask = { shape: SHAPE, name: 'Morning', widgets: [{ type: 'clock' as const }], show: MORNING };
    expect(placePage({ layout: six, ...ask })).toEqual({ ok: false, why: 'pages_full' });
    expect(placePage({ layout: six, ...ask, replace: 'p_9' })).toEqual({ ok: false, why: 'unknown_page' });
    const r = placePage({ layout: six, ...ask, replace: 'p_3' });
    if (!r.ok) throw new Error(r.why);
    expect(r.layout.pages.map((p) => p.id)).toEqual(['p_1', 'p_2', 'p_3', 'p_4', 'p_5', 'p_6']);
    expect(r.layout.pages[2]).toMatchObject({ name: 'Morning', show: MORNING });
  });
});

describe('what Add a widget offers', () => {
  const groups: DeskCatalogGroup[] = [
    { key: 'own', label: 'Whombat', items: [{ type: 'clock', opts: {}, name: 'Clock', line: 'The time' }] },
    {
      key: 'server:pve-01',
      label: 'pve-01',
      items: [
        { type: 'server', ref: 'server:pve-01', opts: {}, name: 'Overview', line: '…', view: 'server' },
        {
          type: 'server',
          ref: 'server:pve-01',
          opts: { show: 'cpu' },
          name: 'Processor',
          line: '…',
          view: 'chart',
        },
      ],
    },
    {
      key: 'connection:con_protect',
      label: 'Protect',
      items: [
        {
          type: 'panel',
          ref: 'connection:con_protect',
          opts: { panel: 'cameras', item: 'cam_1' },
          name: 'Front door',
          line: '…',
          view: 'camera',
        },
      ],
    },
  ];

  it('finds the item a widget is: its type, thing, panel and item, a server’s part', () => {
    expect(catalogItemFor(groups, { type: 'clock' })?.name).toBe('Clock');
    expect(
      catalogItemFor(groups, { type: 'server', ref: 'server:pve-01', opts: { show: 'cpu' } })?.view,
    ).toBe('chart');
    expect(
      catalogItemFor(groups, {
        type: 'panel',
        ref: 'connection:con_protect',
        opts: { panel: 'cameras', item: 'cam_1' },
      })?.name,
    ).toBe('Front door');
    expect(
      catalogItemFor(groups, { type: 'panel', ref: 'connection:con_protect', opts: { panel: 'cameras' } }),
    ).toBeNull();
    expect(catalogItemFor(groups, { type: 'server', ref: 'server:pve-09' })).toBeNull();
  });
});
