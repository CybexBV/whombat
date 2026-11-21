import * as Core from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ATTENTION,
  FIXTURE_BOX_GRID,
  FIXTURE_BOX_GRID_WRONG,
  FIXTURE_CALM,
  FIXTURE_CALM_WRONG,
  FIXTURE_KINDS_GRID,
  FIXTURE_MONITOR_GRID,
  FIXTURE_PHOTO_BOARD_VIEWS,
  FIXTURE_SERVER_VIEWS,
  FIXTURE_TABLET_GRID,
  FIXTURE_VIEWS,
} from './fixtures';
import { PHOTO_EVERY_S } from './forms';
import { sizeOf } from './specs';
import type * as Mine from './types';

/* The plain types and core's zod types are assignable both ways: the compiler checks these. */
const both = {
  layout: [(x: Core.DeskLayout): Mine.DeskLayout => x, (x: Mine.DeskLayout): Core.DeskLayout => x],
  page: [(x: Core.DeskPage): Mine.DeskPage => x, (x: Mine.DeskPage): Core.DeskPage => x],
  widget: [(x: Core.DeskWidget): Mine.DeskWidget => x, (x: Mine.DeskWidget): Core.DeskWidget => x],
  view: [
    (x: Core.DeskWidgetView): Mine.DeskWidgetView => x,
    (x: Mine.DeskWidgetView): Core.DeskWidgetView => x,
  ],
  image: [(x: Core.DeskImage): Mine.DeskImage => x, (x: Mine.DeskImage): Core.DeskImage => x],
  item: [
    (x: Core.DeskAttentionItem): Mine.DeskAttentionItem => x,
    (x: Mine.DeskAttentionItem): Core.DeskAttentionItem => x,
  ],
  attention: [
    (x: Core.DeskAttention): Mine.DeskAttention => x,
    (x: Mine.DeskAttention): Core.DeskAttention => x,
  ],
  grid: [(x: Core.DeskGrid): Mine.DeskGrid => x, (x: Mine.DeskGrid): Core.DeskGrid => x],
  moment: [(x: Core.DeskMoment): Mine.DeskMoment => x, (x: Mine.DeskMoment): Core.DeskMoment => x],
  strip: [
    (x: Core.DeskStripServer): Mine.DeskStripServer => x,
    (x: Mine.DeskStripServer): Core.DeskStripServer => x,
  ],
  headline: [(x: Core.DeskHeadline): Mine.DeskHeadline => x, (x: Mine.DeskHeadline): Core.DeskHeadline => x],
  locked: [
    (x: Core.DeskLockedView): Mine.DeskLockedView => x,
    (x: Mine.DeskLockedView): Core.DeskLockedView => x,
  ],
  /** The calm glance as the widgets read it: core's whole glance is one. */
  calm: [(x: Core.DeskCalm): Mine.ScreenCalm => x],
};

describe('the plain types', () => {
  it('mirror the contract both ways', () => {
    expect(Object.keys(both)).toContain('grid');
  });

  it('change photos as often as the contract allows', () => {
    expect(PHOTO_EVERY_S).toEqual(Core.DESK_PHOTO_EVERY_S);
  });
});

describe('the fixtures', () => {
  it('are what the contract allows', () => {
    for (const grid of [
      FIXTURE_BOX_GRID,
      FIXTURE_BOX_GRID_WRONG,
      FIXTURE_MONITOR_GRID,
      FIXTURE_TABLET_GRID,
    ]) {
      expect(Core.DeskGrid.safeParse(grid).error?.issues).toBeUndefined();
      expect(Core.deskLayoutProblem(grid.layout)).toBeNull();
    }
    for (const v of [...FIXTURE_VIEWS, ...FIXTURE_SERVER_VIEWS, ...FIXTURE_PHOTO_BOARD_VIEWS])
      expect(Core.DeskWidgetView.safeParse(v).error?.issues).toBeUndefined();
    expect(Core.DeskAttention.safeParse(FIXTURE_ATTENTION).success).toBe(true);
    for (const calm of [FIXTURE_CALM, FIXTURE_CALM_WRONG]) {
      expect(Core.DeskHeadline.safeParse(calm.headline).success).toBe(true);
      for (const m of calm.moments) expect(Core.DeskMoment.safeParse(m).success).toBe(true);
      for (const s of calm.strip) expect(Core.DeskStripServer.safeParse(s).success).toBe(true);
    }
  });

  it('place every widget within its sizes', () => {
    for (const grid of [FIXTURE_BOX_GRID, FIXTURE_MONITOR_GRID, FIXTURE_TABLET_GRID, FIXTURE_KINDS_GRID]) {
      const kinds = new Map(grid.views.map((v) => [v.id, v.kind]));
      for (const page of grid.layout.pages)
        for (const w of Object.values(page.layouts).flat()) {
          const s = sizeOf(w, kinds.get(w.id));
          expect([w.id, w.w >= s.min[0] && w.w <= s.max[0] && w.h >= s.min[1] && w.h <= s.max[1]]).toEqual([
            w.id,
            true,
          ]);
        }
    }
  });

  it('give every widget that isn’t Whombat’s own calm reader a view', () => {
    for (const grid of [FIXTURE_BOX_GRID, FIXTURE_MONITOR_GRID, FIXTURE_TABLET_GRID, FIXTURE_KINDS_GRID]) {
      const ids = new Set(grid.views.map((v) => v.id));
      for (const page of grid.layout.pages)
        for (const w of Object.values(page.layouts).flat())
          if (!['clock', 'status', 'now', 'strip'].includes(w.type)) expect(ids).toContain(w.id);
    }
  });
});
