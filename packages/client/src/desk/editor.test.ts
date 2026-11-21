import { GAP, screenGrid, shapeKey, sizeOf } from '@whombat/screen';
import { describe, expect, it } from 'vitest';
import { type DeskLayout, deskDefaultLayout } from './contract';
import {
  addPage,
  addWidget,
  deletePage,
  didntFit,
  draftProblem,
  dragTarget,
  dropSpot,
  editorGrid,
  editorKey,
  editorPage,
  freeSpot,
  growWidget,
  movePage,
  moveWidget,
  nudgeWidget,
  pageName,
  popUndo,
  pushUndo,
  removeWidget,
  renamePage,
  resizeWidget,
  setWidgetSpec,
  UNDO_MAX,
  type UndoStack,
} from './editor';

/** The calm glance's default on the Z13's 8 × 5: clock and status on top, what's going on, the servers along the bottom. */
const box = editorGrid(null, 'normal');
const base = () => deskDefaultLayout();
const ids = (layout: DeskLayout, g = box) => editorPage(layout, 0, g).widgets.map((w) => w.id);
const at = (layout: DeskLayout, id: string, g = box) =>
  editorPage(layout, 0, g).widgets.find((w) => w.id === id);

describe('the editor', () => {
  it('draws a screen that never said its size at 1280 × 800, its Size changing the grid', () => {
    expect(shapeKey(box)).toBe('8x5');
    expect(shapeKey(editorGrid({ width: 1920, height: 1080 }, 'normal'))).toBe('12x7');
    expect(shapeKey(editorGrid(null, 'larger'))).toBe('6x4');
  });

  it('moves a widget onto a free spot, and refuses a taken one without pushing anything aside', () => {
    const emptied = removeWidget(base(), 0, box, 'w_status');
    const moved = moveWidget(emptied, 0, box, 'w_clock', { x: 4, y: 0 });
    expect(moved.ok && at(moved.layout, 'w_clock')).toMatchObject({ x: 4, y: 0 });
    expect(moveWidget(base(), 0, box, 'w_clock', { x: 2, y: 0 })).toEqual({ ok: false, why: 'taken' });
    expect(nudgeWidget(base(), 0, box, 'w_clock', -1, 0)).toEqual({ ok: false, why: 'taken' });
  });

  it('resizes between a widget’s smallest and largest, and only into room it has', () => {
    const l = removeWidget(base(), 0, box, 'w_status');
    const wider = resizeWidget(l, 0, box, 'w_clock', { w: 6, h: 2 });
    expect(wider.ok && at(wider.layout, 'w_clock')).toMatchObject({ w: 6, h: 2 });
    expect(growWidget(l, 0, box, 'w_clock', 'h', 1)).toEqual({ ok: false, why: 'noRoom' });
    expect(resizeWidget(l, 0, box, 'w_clock', { w: 1, h: 2 })).toEqual({ ok: false, why: 'tooSmall' });
    expect(resizeWidget(l, 0, box, 'w_now', { w: 8, h: 4 })).toEqual({ ok: false, why: 'tooBig' });
  });

  it('adds to the first free spot, smaller when it must, and says when the page is full', () => {
    const l = removeWidget(base(), 0, box, 'w_status');
    const added = addWidget(l, 0, box, { type: 'server', ref: 'server:pve-01', opts: {} });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(at(added.layout, added.id)).toMatchObject({ x: 4, y: 0, w: 2, h: 2 });
    expect(added.smaller).toBe(false);
    // 4 × 2 left at the top right: a 4 × 3 camera panel goes in at 4 × 2.
    const cam = addWidget(
      l,
      0,
      box,
      { type: 'panel', ref: 'connection:ha', opts: { panel: 'cam' } },
      undefined,
      () => 'camera',
    );
    expect(cam.ok && at(cam.layout, cam.id)).toMatchObject({ x: 4, y: 0, w: 4, h: 2 });
    expect(cam.ok && cam.smaller).toBe(true);
    // A panel not resolved yet takes its size from the catalogue's view.
    const fromCatalog = addWidget(l, 0, box, {
      type: 'panel',
      ref: 'connection:ha',
      opts: { panel: 'cam' },
      view: 'camera',
    });
    expect(fromCatalog.ok && fromCatalog.smaller).toBe(true);
    expect(addWidget(base(), 0, box, { type: 'clock', opts: {} })).toEqual({ ok: false, why: 'full' });
  });

  it('drops one in centred under the pointer, else the biggest size that fits there, red when nothing does', () => {
    const widgets = editorPage(removeWidget(base(), 0, box, 'w_status'), 0, box).widgets;
    expect(dropSpot(widgets, box, sizeOf({ type: 'server' }), { x: 6, y: 1 })).toMatchObject({
      x: 6,
      y: 0,
      w: 2,
      h: 2,
      ok: true,
    });
    expect(dropSpot(widgets, box, sizeOf({ type: 'server' }), { x: 1, y: 3 }).ok).toBe(false);
    expect(freeSpot(widgets, box, sizeOf({ type: 'now' }))).toMatchObject({ w: 4, h: 2, smaller: true });
  });

  it('keeps a layout per shape: a rearranged page becomes that shape’s own once changed, the old one untouched', () => {
    const tablet = editorGrid({ width: 820, height: 1180 }, 'normal');
    const page = editorPage(base(), 0, tablet);
    expect(page.rearranged).toBe(true);
    expect(page.from).toBe('8x5');
    const changed = removeWidget(base(), 0, tablet, 'w_clock');
    const p = changed.pages[0];
    expect(p && Object.keys(p.layouts).sort()).toEqual(['5x7', '8x5']);
    expect(p?.last).toBe('5x7');
    expect(ids(changed)).toEqual(['w_clock', 'w_status', 'w_now', 'w_strip']);
    expect(ids(changed, tablet)).not.toContain('w_clock');
  });

  it('what didn’t fit waits until it is placed again', () => {
    const tiny = screenGrid(420, 400);
    const page = editorPage(base(), 0, tiny);
    expect(page.left.length).toBeGreaterThan(0);
    const left = page.left[0];
    if (!left) return;
    expect(didntFit(page.widgets, page.left).map((w) => w.id)).toContain(left.id);
    expect(didntFit([...page.widgets, left], page.left).map((w) => w.id)).not.toContain(left.id);
  });

  it('changes what a widget shows on every shape it has', () => {
    const tablet = editorGrid({ width: 820, height: 1180 }, 'normal');
    const both = removeWidget(base(), 0, tablet, 'w_clock');
    const l = addWidget(both, 0, tablet, { type: 'server', ref: 'server:a', opts: {} });
    if (!l.ok) throw new Error('no room');
    const changed = setWidgetSpec(l.layout, l.id, { ref: 'server:b', opts: { range: '7d' } });
    expect(editorPage(changed, 0, tablet).widgets.find((w) => w.id === l.id)).toMatchObject({
      ref: 'server:b',
      opts: { range: '7d' },
    });
  });

  it('adds pages up to six, named after the others; renames; the last page can’t go', () => {
    let l = base();
    for (let i = 0; i < 5; i++) {
      const r = addPage(l, box);
      if (!r.ok) throw new Error('refused');
      l = r.layout;
    }
    expect(l.pages.map((p) => p.name)).toEqual([
      'Overview',
      'Page 2',
      'Page 3',
      'Page 4',
      'Page 5',
      'Page 6',
    ]);
    expect(addPage(l, box)).toEqual({ ok: false, why: 'pagesFull' });
    expect(renamePage(l, 1, '  Media \n  room ').pages[1]?.name).toBe('Media room');
    expect(pageName('   ')).toBeNull();
    expect(movePage(l, 1, -1).layout.pages[0]?.name).toBe('Page 2');
    expect(deletePage(base(), 0)).toEqual({ ok: false, why: 'lastPage' });
  });

  it('a draft with a widget beyond its sizes can’t be saved', () => {
    expect(draftProblem(base())).toBeNull();
    const l = base();
    const clock = l.pages[0]?.layouts['8x5']?.[0];
    if (clock) clock.h = 4;
    expect(draftProblem(l)).toMatch(/w_clock/);
  });

  it('snaps a drag to the nearest cell and a corner to the sizes it may have', () => {
    const from = { x: 0, y: 0, w: 2, h: 2 };
    const step = box.cw + GAP;
    expect(dragTarget(box, from, 'move', step * 1.6, -40, sizeOf({ type: 'server' }), GAP)).toMatchObject({
      x: 2,
      y: 0,
    });
    expect(dragTarget(box, from, 'resize', step * 9, 0, sizeOf({ type: 'server' }), GAP)).toMatchObject({
      w: 6,
      h: 2,
    });
    expect(dragTarget(box, from, 'resize', -step * 5, 0, sizeOf({ type: 'server' }), GAP)).toMatchObject({
      w: 2,
    });
  });

  it('knows the editor’s keys', () => {
    expect(editorKey({ key: 'ArrowLeft' })).toEqual({ kind: 'move', dx: -1, dy: 0 });
    expect(editorKey({ key: 'ArrowDown', shiftKey: true })).toEqual({ kind: 'grow', dim: 'h', by: 1 });
    expect(editorKey({ key: 'Delete' })).toEqual({ kind: 'remove' });
    expect(editorKey({ key: 'Escape' })).toEqual({ kind: 'deselect' });
    expect(editorKey({ key: 'z', metaKey: true })).toEqual({ kind: 'undo' });
    expect(editorKey({ key: 'Z', ctrlKey: true })).toEqual({ kind: 'undo' });
    expect(editorKey({ key: 'a' })).toBeNull();
  });

  it('undoes step by step, keeping the last eighty', () => {
    let stack: UndoStack<number> = { past: [] };
    for (let i = 0; i < UNDO_MAX + 5; i++) stack = pushUndo(stack, i);
    expect(stack.past).toHaveLength(UNDO_MAX);
    const back = popUndo(stack);
    expect(back?.value).toBe(UNDO_MAX + 4);
    expect(popUndo({ past: [] })).toBeNull();
  });
});
