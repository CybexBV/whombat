import {
  type DeskCatalogGroup,
  type DeskGrid,
  type DeskLayout,
  type DeskWidget,
  deskLayoutProblem,
} from '@whombat/core';
import { WEATHER_NEWS_MINOR } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { catalogFor, gridFor, layoutFor, screenDetailFor, viewsFor, withHiddenWidgets } from './older-apps';

const OLD = WEATHER_NEWS_MINOR - 1;
const w = (id: string, type: DeskWidget['type'], x: number, y: number, wd = 2, h = 2): DeskWidget => ({
  id,
  type,
  opts: {},
  x,
  y,
  w: wd,
  h,
});

/** The layout as stored: a clock, the weather beside it, the news under it; on a second page the news alone. */
const stored: DeskLayout = {
  pages: [
    {
      id: 'p_first',
      name: 'Overview',
      layouts: {
        '8x5': [
          w('w_clock', 'clock', 0, 0),
          w('w_weather', 'weather', 2, 0),
          w('w_news', 'news', 0, 2, 4, 2),
        ],
        '4x6': [w('w_clock', 'clock', 0, 0), w('w_weather', 'weather', 2, 0)],
      },
      last: '8x5',
    },
    { id: 'p_news', name: 'News', layouts: { '8x5': [w('w_news2', 'news', 0, 0, 4, 3)] }, last: '8x5' },
  ],
  turn: 'touch',
  size: 'normal',
};

describe('an app from before the weather and the news', () => {
  it('reads layouts without those widgets, and a newer app reads them all', () => {
    const old = layoutFor(stored, OLD);
    expect(old.pages[0]?.layouts['8x5']?.map((x) => x.id)).toEqual(['w_clock']);
    expect(old.pages[0]?.layouts['4x6']?.map((x) => x.id)).toEqual(['w_clock']);
    expect(old.pages[1]?.layouts['8x5']).toEqual([]);
    expect(deskLayoutProblem(old)).toBeNull();
    expect(layoutFor(stored, WEATHER_NEWS_MINOR)).toBe(stored);
    expect(layoutFor(stored, undefined)).toBe(stored);
    const detail = { layout: stored } as Parameters<typeof screenDetailFor>[0];
    expect(screenDetailFor(detail, OLD).layout).toEqual(old);
  });

  it('gets its saved layout back with the widgets it couldn’t see, where they were', () => {
    const saved = layoutFor(stored, OLD);
    // It moved the clock down and added nothing over the hidden ones.
    const moved: DeskLayout = {
      ...saved,
      pages: saved.pages.map((p) =>
        p.id === 'p_first' ? { ...p, layouts: { ...p.layouts, '8x5': [w('w_clock', 'clock', 6, 3)] } } : p,
      ),
    };
    const back = withHiddenWidgets(moved, stored, OLD);
    expect(back.pages[0]?.layouts['8x5']?.map((x) => [x.id, x.x, x.y])).toEqual([
      ['w_clock', 6, 3],
      ['w_weather', 2, 0],
      ['w_news', 0, 2],
    ]);
    expect(back.pages[0]?.layouts['4x6']?.map((x) => x.id)).toEqual(['w_clock', 'w_weather']);
    expect(back.pages[1]?.layouts['8x5']?.map((x) => x.id)).toEqual(['w_news2']);
    expect(deskLayoutProblem(back)).toBeNull();
    // Saved again unchanged, it is the stored layout.
    expect(withHiddenWidgets(saved, stored, OLD)).toEqual(stored);
  });

  it('leaves out one whose place it filled, whose page or shape it removed', () => {
    const saved: DeskLayout = {
      ...stored,
      pages: [
        {
          id: 'p_first',
          name: 'Overview',
          // A server over the weather's place; the 4x6 layout gone.
          layouts: { '8x5': [w('w_clock', 'clock', 0, 0), w('w_srv', 'strip', 2, 0, 2, 1)] },
          last: '8x5',
        },
      ],
    };
    const back = withHiddenWidgets(saved, stored, OLD);
    expect(back.pages.map((p) => p.id)).toEqual(['p_first']);
    expect(back.pages[0]?.layouts['8x5']?.map((x) => x.id)).toEqual(['w_clock', 'w_srv', 'w_news']);
    expect(Object.keys(back.pages[0]?.layouts ?? {})).toEqual(['8x5']);
    expect(deskLayoutProblem(back)).toBeNull();
  });

  it('keeps what a newer app saves as it is', () => {
    const saved = layoutFor(stored, OLD);
    expect(withHiddenWidgets(saved, stored, WEATHER_NEWS_MINOR)).toBe(saved);
  });

  it('reads no weather view, no weather or news in Add a widget, and a grid without them', () => {
    const views = [
      { kind: 'weather' as const, id: 'w_weather' },
      { kind: 'list' as const, id: 'w_news' },
      { kind: 'text' as const, id: 'w_clock' },
    ];
    expect(viewsFor(views, OLD).map((v) => v.id)).toEqual(['w_news', 'w_clock']);
    expect(viewsFor(views, WEATHER_NEWS_MINOR)).toHaveLength(3);
    const groups: DeskCatalogGroup[] = [
      {
        key: 'own',
        label: 'Whombat',
        items: [
          { type: 'clock', opts: {}, name: 'Clock', line: 'The time' },
          { type: 'weather', opts: {}, name: 'Weather', line: 'Today', view: 'weather' },
          { type: 'news', opts: {}, name: 'News', line: 'Headlines', view: 'list' },
        ],
      },
    ];
    expect(catalogFor(groups, OLD)[0]?.items.map((i) => i.type)).toEqual(['clock']);
    expect(catalogFor(groups, WEATHER_NEWS_MINOR)[0]?.items).toHaveLength(3);
    // A moment's widget (the doorbell's camera) isn't on a page: its view stays.
    const grid = {
      layout: stored,
      views: [...views, { kind: 'camera' as const, id: 'w_doorbell' }],
    } as unknown as DeskGrid;
    const old = gridFor(grid, OLD);
    expect(old.layout).toEqual(layoutFor(stored, OLD));
    // The news's list view goes with its widget.
    expect(old.views.map((v) => v.id)).toEqual(['w_clock', 'w_doorbell']);
  });
});
