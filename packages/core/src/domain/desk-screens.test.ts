import { describe, expect, it } from 'vitest';
import { deskAttentionFor } from './desk.js';
import type { DeskCalmInput } from './desk-calm.js';
import { DEFAULT_DESK_SHOW } from './desk-glance.js';
import {
  DeskGrid,
  DeskLayout,
  DeskWidgetView,
  deskDefaultLayout,
  deskLayoutProblem,
  deskLayoutWidgets,
  deskWidgetSpecProblem,
} from './desk-screens.js';

const input = (over: Partial<DeskCalmInput> = {}): DeskCalmInput => ({
  assistant: 'Dusty',
  now: new Date('2026-10-27T14:34:00Z'),
  timeZone: 'Europe/Amsterdam',
  asks: [],
  askCount: 0,
  looks: [],
  work: null,
  servers: [],
  activities: [],
  figures: [],
  coming: [],
  services: 0,
  doneCount: 0,
  ...over,
});

describe('layouts', () => {
  it('starts as the calm glance, and that layout is sound', () => {
    const layout = DeskLayout.parse(deskDefaultLayout());
    expect(deskLayoutProblem(layout)).toBeNull();
    expect(deskLayoutWidgets(layout).map((w) => w.type)).toEqual(['clock', 'status', 'now', 'strip']);
  });

  it('refuses a widget outside its shape, on another, or naming the wrong thing', () => {
    const base = deskDefaultLayout();
    const page = base.pages[0];
    if (!page) throw new Error('no page');
    const at = (widgets: unknown[]) =>
      DeskLayout.parse({ ...base, pages: [{ ...page, layouts: { '8x5': widgets } }] });
    expect(deskLayoutProblem(at([{ id: 'w_a', type: 'clock', x: 7, y: 0, w: 2, h: 1 }]))).toMatch(/outside/);
    expect(
      deskLayoutProblem(
        at([
          { id: 'w_a', type: 'clock', x: 0, y: 0, w: 2, h: 1 },
          { id: 'w_b', type: 'status', x: 1, y: 0, w: 2, h: 1 },
        ]),
      ),
    ).toMatch(/w_a on w_b/);
    expect(
      deskLayoutProblem(at([{ id: 'w_a', type: 'server', ref: 'connection:con_x', x: 0, y: 0, w: 2, h: 1 }])),
    ).toMatch(/server/);
  });

  it('knows what each kind of widget names', () => {
    expect(
      deskWidgetSpecProblem({ type: 'panel', ref: 'connection:con_plex', opts: { panel: 'playing' } }),
    ).toBeNull();
    expect(deskWidgetSpecProblem({ type: 'panel', ref: 'connection:con_plex', opts: {} })).not.toBeNull();
    expect(deskWidgetSpecProblem({ type: 'clock', ref: 'server:pve-01', opts: {} })).not.toBeNull();
    expect(deskWidgetSpecProblem({ type: 'widget', ref: 'widget:wid_1', opts: {} })).toBeNull();
  });

  it('carries views and a grid', () => {
    const view = DeskWidgetView.parse({
      kind: 'list',
      id: 'w_sab',
      title: 'Queue',
      name: 'SABnzbd',
      head: '3 left · about 20 min',
      rows: [{ title: 'Shōgun S01 1080p', meta: '4.2 GB', progress: 78 }],
    });
    expect(
      DeskGrid.parse({
        screen: 'box',
        layout: deskDefaultLayout(),
        views: [view],
        attention: { items: [], more: 0 },
        popups: 'all',
      }).views,
    ).toHaveLength(1);
  });
});

describe('what needs the person (the modal and the pill)', () => {
  const down = {
    key: 'server:pve-02',
    kind: 'server' as const,
    name: 'pve-02',
    state: 'down' as const,
    server: 'pve-02',
    runsOn: ['Plex', 'SABnzbd'],
  };
  const disk = {
    key: 'server:nas',
    kind: 'server' as const,
    name: 'nas',
    state: 'look' as const,
    disk: { pct: 88, days: 12 },
  };

  it('puts outages first, then questions, and pops only outages and questions', () => {
    const a = deskAttentionFor(
      input({ looks: [disk, down], asks: [{ number: 7, title: 'Send the reply?' }], askCount: 1 }),
      DEFAULT_DESK_SHOW,
      'everything',
      'all',
    );
    expect(a.items.map((i) => [i.key, i.pops])).toEqual([
      ['server:pve-02', true],
      ['ask:7', true],
      ['server:nas', false],
    ]);
    expect(a.tone).toBe('bad');
    expect(a.items[0]?.name).toBe('pve-02');
  });

  it('follows the screen’s pop-ups', () => {
    const at = (popups: 'all' | 'problems' | 'none') =>
      deskAttentionFor(
        input({ looks: [down], asks: [{ number: 7, title: 'Send?' }], askCount: 1 }),
        DEFAULT_DESK_SHOW,
        'everything',
        popups,
      )
        .items.filter((i) => i.pops)
        .map((i) => i.kind);
    expect(at('all')).toEqual(['look', 'ask']);
    expect(at('problems')).toEqual(['look']);
    expect(at('none')).toEqual([]);
  });

  it('keeps an ask’s title off a locked screen and shows nothing on Only the time', () => {
    const asks = { asks: [{ number: 7, title: 'Send the reply to Bakkerij de Vries?' }], askCount: 1 };
    expect(deskAttentionFor(input(asks), DEFAULT_DESK_SHOW, 'summary', 'all').items[0]?.title).toBe(
      'Dusty has a question',
    );
    expect(deskAttentionFor(input(asks), DEFAULT_DESK_SHOW, 'time', 'all')).toEqual({ items: [], more: 0 });
  });

  it('is amber for something to look at alone, and empty when nothing needs you', () => {
    expect(deskAttentionFor(input({ looks: [disk] }), DEFAULT_DESK_SHOW, 'everything', 'all').tone).toBe(
      'warn',
    );
    expect(deskAttentionFor(input(), DEFAULT_DESK_SHOW, 'everything', 'all')).toEqual({ items: [], more: 0 });
  });

  it('leaves out what the assistant is on, as Needs you does, until it finds something', () => {
    const research = (state: 'looking' | 'fixing' | 'fixed' | 'found' | 'failed') => ({
      key: down.key,
      state,
      title: 'pve-02 lost power',
      summary: 'Its UPS reports a cut.',
      at: '2026-11-01T09:00:00Z',
    });
    const keys = (state: Parameters<typeof research>[0]) =>
      deskAttentionFor(
        input({ looks: [{ ...down, research: research(state) }] }),
        DEFAULT_DESK_SHOW,
        'everything',
        'all',
      ).items.map((i) => i.key);
    expect(keys('looking')).toEqual([]);
    expect(keys('fixing')).toEqual([]);
    expect(keys('fixed')).toEqual([]);
    expect(keys('found')).toEqual(['server:pve-02']);
    expect(keys('failed')).toEqual(['server:pve-02']);
  });
});
