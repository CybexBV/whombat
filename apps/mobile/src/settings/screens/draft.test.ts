import type { DeskLayout, DeskScreenDetail } from '@whombat/client/desk';
import { createFakeDesk, fakeDeskApi } from '@whombat/client/desk/fake';
import { describe, expect, it } from 'vitest';
import {
  canNudge,
  type Draft,
  draftAdd,
  draftAddPage,
  draftChoose,
  draftDeletePage,
  draftDirty,
  draftGoPage,
  draftGrow,
  draftMovePage,
  draftNudge,
  draftOf,
  draftPage,
  draftRemove,
  draftRenamePage,
  draftResize,
  draftSaved,
  draftShow,
  draftSize,
  draftSpec,
  draftTidy,
  draftUndo,
  mergeShowPatch,
} from './draft';

const viewer = { personId: 'p_me', name: 'Mara' };

async function boxScreen(): Promise<DeskScreenDetail> {
  const desk = createFakeDesk({ screens: true, now: () => Date.parse('2026-10-27T14:34:00Z') });
  return fakeDeskApi(desk, viewer).screen('box');
}

/** A one-page layout on the Z13's 8 × 5. */
function oneEmptyPage(): DeskLayout {
  return {
    pages: [{ id: 'p_a', name: 'Overview', layouts: { '8x5': [] }, last: '8x5' }],
    turn: 'touch',
    size: 'normal',
  };
}

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

describe('the phone’s layout draft', () => {
  it('starts as the screen is: its first page in reading order, nothing changed', async () => {
    const d = draftOf(await boxScreen());
    const page = draftPage(d);
    expect(page.grid.cols).toBe(8);
    expect(page.grid.rows).toBe(5);
    expect(page.rearranged).toBe(false);
    const order = page.widgets.map((w) => [w.y, w.x]);
    expect(order).toEqual([...order].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0)));
    expect(page.widgets[0]?.type).toBe('clock');
    expect(draftDirty(d)).toBe(false);
  });

  it('moves with the arrows, swaps onto one other, refuses the rest and the edge, and Undo takes a move back', async () => {
    const d0 = draftOf(await boxScreen());
    const clock = draftPage(d0).widgets.find((w) => w.type === 'clock');
    const status = draftPage(d0).widgets.find((w) => w.type === 'status');
    if (!clock || !status) throw new Error('no clock');
    expect(canNudge(d0, clock.id, -1, 0)).toBe(false);
    expect(canNudge(d0, clock.id, 1, 0)).toBe(true);
    // How things are sits right of it: the two change places (DK-167).
    const swapped = ok(draftNudge(d0, clock.id, 1, 0));
    expect(swapped.swapped).toBe(status.id);
    const after = draftPage(swapped.draft).widgets;
    expect(after.find((w) => w.id === clock.id)).toMatchObject({ x: status.x, y: status.y });
    expect(after.find((w) => w.id === status.id)).toMatchObject({ x: clock.x, y: clock.y });
    // What's going on under it is wider: it can't go where the clock was.
    expect(draftNudge(d0, clock.id, 0, 1)).toEqual({ ok: false, why: 'taken' });
    const removed = draftRemove(d0, status.id);
    expect(draftDirty(removed)).toBe(true);
    const moved = ok(draftNudge(removed, clock.id, 1, 0)).draft;
    expect(draftPage(moved).widgets.find((w) => w.id === clock.id)?.x).toBe(1);
    const back = draftUndo(moved);
    expect(back && draftPage(back).widgets.find((w) => w.id === clock.id)?.x).toBe(0);
    const twice = back && draftUndo(back);
    expect(twice && draftDirty(twice)).toBe(false);
    expect(twice && draftUndo(twice)).toBeNull();
  });

  it('sizes within the widget’s limits and the room it has, saying which', async () => {
    const d = { ...draftOf({ layout: oneEmptyPage(), size: { width: 1280, height: 800 } }) };
    const added = ok(draftAdd(d, { type: 'clock', opts: {} }));
    expect(added.draft.selected).toBe(added.id);
    const clock = draftPage(added.draft).widgets[0];
    expect(clock && [clock.x, clock.y, clock.w, clock.h]).toEqual([0, 0, 3, 2]);
    expect(draftGrow(added.draft, added.id, 'h', -1)).toEqual(expect.objectContaining({ ok: true }));
    const flat = ok(draftGrow(added.draft, added.id, 'h', -1)).draft;
    expect(draftGrow(flat, added.id, 'h', -1)).toEqual({
      ok: false,
      why: 'tooSmall',
      grow: true,
      size: { w: 2, h: 1 },
    });
    // The clock is at most 8 × 3.
    let wide = added.draft;
    for (let i = 0; i < 5; i++) wide = ok(draftGrow(wide, added.id, 'w', 1)).draft;
    expect(draftGrow(wide, added.id, 'w', 1)).toEqual(
      expect.objectContaining({ ok: false, why: 'tooBig', size: { w: 8, h: 3 } }),
    );
  });

  it('adds to the first free spot, smaller when it must, and says when the page is full', () => {
    let d: Draft = draftOf({ layout: oneEmptyPage(), size: { width: 1280, height: 800 } });
    const first = ok(draftAdd(d, { type: 'now', opts: {} }));
    expect(first.smaller).toBe(false);
    d = first.draft;
    // What’s going on starts 8 × 2; the next one goes under it.
    const second = ok(draftAdd(d, { type: 'now', opts: {} }));
    expect(draftPage(second.draft).widgets.find((w) => w.id === second.id)?.y).toBe(2);
    d = second.draft;
    // One row left: a clock (3 × 2 at first) fits only 1 high.
    const clock = ok(draftAdd(d, { type: 'clock', opts: {} }));
    expect(clock.smaller).toBe(true);
    d = clock.draft;
    let r = draftAdd(d, { type: 'clock', opts: {} });
    while (r.ok) r = draftAdd(r.draft, { type: 'clock', opts: {} });
    expect(r).toEqual({ ok: false, why: 'full' });
  });

  it('adds a panel at the sizes of what it draws, known from the item before the runtime resolved it', () => {
    let d: Draft = draftOf({ layout: oneEmptyPage(), size: { width: 1280, height: 800 } });
    // Fill all but a 2 × 1 corner.
    d = ok(draftAdd(d, { type: 'now', opts: {} })).draft;
    d = ok(draftAdd(d, { type: 'now', opts: {} })).draft;
    d = ok(draftAdd(d, { type: 'strip', opts: {}, w: 6, h: 1 })).draft;
    const panel = { type: 'panel' as const, ref: 'connection:con_ha', opts: { panel: 'front-door' } };
    // A camera still is never under 2 × 2: no room, rather than a layout the runtime refuses.
    expect(draftAdd(d, panel, undefined, 'camera')).toEqual({ ok: false, why: 'full' });
    // Not knowing what it draws, it would have gone in at 2 × 1.
    expect(draftAdd(d, panel).ok).toBe(true);
  });

  it('keeps a widget’s settings and the screen’s choices in the draft until Save', async () => {
    const screen = await boxScreen();
    const d = draftOf(screen);
    const server = draftPage(d).widgets.find((w) => w.type === 'server');
    if (!server) throw new Error('no server');
    const ranged = draftSpec(d, server.id, { ref: 'server:pve-02', opts: { range: '7d' } });
    const w = draftPage(ranged).widgets.find((x) => x.id === server.id);
    expect(w?.ref).toBe('server:pve-02');
    expect(w?.opts).toEqual({ range: '7d' });
    const chose = draftShow(ranged, { items: { 'connection:con_plex': 'off' } });
    const ordered = draftShow(chose, { order: ['pve-02', 'pve-01'] });
    expect(ordered.show).toEqual({ items: { 'connection:con_plex': 'off' }, order: ['pve-02', 'pve-01'] });
    expect(draftUndo(ordered)?.show).toEqual({ items: { 'connection:con_plex': 'off' } });
    const saved = draftSaved(ordered, ordered.layout);
    expect(draftDirty(saved)).toBe(false);
    expect(saved.show).toBeNull();
  });

  it('merges choices item by item, the later winning', () => {
    expect(
      mergeShowPatch(
        { items: { a: 'off' }, bar: { network: 'always' } },
        { items: { b: 'always', a: 'matters' } },
      ),
    ).toEqual({ items: { a: 'matters', b: 'always' }, bar: { network: 'always' } });
    expect(mergeShowPatch(null, { order: ['x'] })).toEqual({ order: ['x'] });
  });

  it('adds, renames, moves and deletes pages, keeping one', async () => {
    const d0 = draftOf(await boxScreen());
    const added = ok(draftAddPage(d0)).draft;
    expect(added.layout.pages).toHaveLength(4);
    expect(added.page).toBe(3);
    expect(added.layout.pages[3]?.name).toBe('Page 4');
    expect(draftPage(added).widgets).toEqual([]);
    const renamed = draftRenamePage(added, 3, '  Garden   lights ');
    expect(renamed.layout.pages[3]?.name).toBe('Garden lights');
    expect(draftRenamePage(renamed, 3, '   ')).toBe(renamed);
    const moved = draftMovePage(renamed, 3, -1);
    expect(moved.layout.pages.map((p) => p.name)).toEqual(['Overview', 'Media', 'Garden lights', 'House']);
    expect(moved.page).toBe(2);
    const gone = ok(draftDeletePage(moved, 2)).draft;
    expect(gone.layout.pages.map((p) => p.name)).toEqual(['Overview', 'Media', 'House']);
    expect(gone.page).toBe(1);
    let full = gone;
    for (let i = 0; i < 3; i++) full = ok(draftAddPage(full)).draft;
    expect(draftAddPage(full)).toEqual({ ok: false, why: 'pagesFull' });
    let one = draftGoPage(full, 0);
    while (one.layout.pages.length > 1) one = ok(draftDeletePage(one, 0)).draft;
    expect(draftDeletePage(one, 0)).toEqual({ ok: false, why: 'lastPage' });
  });

  it('rearranges for another Size and keeps what didn’t fit once the rearranged page is changed', async () => {
    const d0 = draftOf(await boxScreen());
    const larger = draftSize(d0, 'larger');
    const page = draftPage(larger);
    expect(page.rearranged).toBe(true);
    expect(page.from).toBe('8x5');
    expect(page.grid.cols).toBeLessThan(8);
    expect(page.left.length).toBeGreaterThan(0);
    const left = page.left.map((w) => w.id);
    // A change makes the rearranged layout this shape's own; what didn’t fit still waits.
    const first = page.widgets[0];
    if (!first) throw new Error('nothing drawn');
    const changed = draftRemove(larger, first.id);
    const after = draftPage(changed);
    expect(after.rearranged).toBe(false);
    expect(after.left.map((w) => w.id)).toEqual(left);
    // Back on the screen's own shape, the 8 × 5 layout is as it was.
    expect(draftPage(draftSize(changed, 'normal')).widgets).toHaveLength(draftPage(d0).widgets.length);
    // One that didn’t fit comes back with its id.
    const back = left[0] as string;
    const gone = after.left.find((w) => w.id === back);
    if (!gone) throw new Error('lost');
    const r = draftAdd(changed, {
      id: back,
      type: gone.type,
      ...(gone.ref ? { ref: gone.ref } : {}),
      opts: gone.opts,
    });
    if (r.ok) expect(draftPage(r.draft).left.map((w) => w.id)).not.toContain(back);
  });

  it('fits a widget switched to another of its account’s to what the new one draws, or says there’s no room', () => {
    const today = {
      id: 'w_t',
      type: 'panel' as const,
      ref: 'account:acc_g',
      opts: { panel: 'today', lock: 'show' },
      x: 0,
      y: 0,
      w: 4,
      h: 4,
    };
    const tiny = { ...today, id: 'w_n', opts: { panel: 'next-meeting' }, x: 0, y: 4, w: 1, h: 1 };
    const beside = { id: 'w_c', type: 'clock' as const, opts: {}, x: 1, y: 4, w: 3, h: 1 };
    const on = (widgets: DeskLayout['pages'][number]['layouts'][string]) =>
      draftOf({
        layout: {
          ...oneEmptyPage(),
          pages: [{ id: 'p_a', name: 'Overview', layouts: { '8x5': widgets }, last: '8x5' }],
        },
        size: null,
      });
    const d = on([today, tiny, beside]);
    const item = (panel: string, view: string) => ({
      type: 'panel' as const,
      ref: 'account:acc_g',
      opts: { panel },
      name: panel,
      line: '',
      view: view as 'list',
      private: true,
    });
    // A list at 4 × 4 shrinks to the figures' largest, On a locked screen kept (both private).
    const next = ok(draftChoose(d, 'w_t', item('next-meeting', 'figures')));
    const shrunk = draftPage(next.draft).widgets.find((w) => w.id === 'w_t');
    expect(shrunk).toMatchObject({ w: 4, h: 2, opts: { panel: 'next-meeting', lock: 'show' } });
    expect(draftUndo(next.draft)?.layout).toEqual(d.layout);
    // A 1 × 1 figures widget can't become a list (2 × 1 at least) with the clock beside it.
    const blocked = draftChoose(d, 'w_n', item('today', 'list'));
    expect(blocked).toMatchObject({ ok: false, why: 'noRoom' });
    // With room, it grows to the list's smallest.
    const free = on([tiny]);
    const grown = ok(draftChoose(free, 'w_n', item('today', 'list')));
    expect(draftPage(grown.draft).widgets[0]).toMatchObject({ w: 2, h: 1 });
    // A connection's figures become one of its panels: the type changes too.
    const figures = {
      id: 'w_f',
      type: 'figures' as const,
      ref: 'connection:con_plex',
      opts: {},
      x: 0,
      y: 0,
      w: 2,
      h: 1,
    };
    const panel = ok(
      draftChoose(on([figures]), 'w_f', {
        type: 'panel',
        ref: 'connection:con_plex',
        opts: { panel: 'recent' },
        name: 'Recently added',
        line: '',
        view: 'posters',
      }),
    );
    expect(draftPage(panel.draft).widgets[0]).toMatchObject({
      type: 'panel',
      opts: { panel: 'recent' },
      w: 2,
      h: 1,
    });
  });

  it('sizes to a shape at once, and tidies the page up and to the left as one step', () => {
    const one = (widgets: DeskLayout['pages'][number]['layouts'][string]) =>
      draftOf({
        layout: {
          ...oneEmptyPage(),
          pages: [{ id: 'p_a', name: 'Overview', layouts: { '8x5': widgets }, last: '8x5' }],
        },
        size: null,
      });
    const clock = { id: 'w_c', type: 'clock' as const, opts: {}, x: 2, y: 1, w: 3, h: 2 };
    const status = { id: 'w_s', type: 'status' as const, opts: {}, x: 5, y: 3, w: 3, h: 2 };
    const d = one([clock, status]);
    const wide = ok(draftResize(d, 'w_c', { w: 6, h: 2 }));
    expect(draftPage(wide.draft).widgets[0]).toMatchObject({ w: 6, h: 2 });
    expect(draftResize(d, 'w_c', { w: 6, h: 3 })).toMatchObject({ ok: false, why: 'noRoom' });
    const tidied = draftTidy(d);
    if (!tidied.ok) throw new Error('refused');
    expect(tidied.moved).toBe(2);
    expect(draftPage(tidied.draft).widgets.map((w) => [w.id, w.x, w.y])).toEqual([
      ['w_c', 0, 0],
      ['w_s', 3, 0],
    ]);
    expect(draftUndo(tidied.draft)?.layout).toEqual(d.layout);
    const again = draftTidy(tidied.draft);
    expect(again.ok && again.moved).toBe(0);
    expect(again.ok && again.draft).toBe(tidied.draft);
  });
});
