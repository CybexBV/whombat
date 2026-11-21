/**
 * The fake box's screens (3.6, DK-126…DK-149): what Settings → Screens and the editor read and change, and a device
 * becoming a screen and drawing its own state.
 */
import { DeskGrid, DeskLayout } from '@whombat/core/domain';
import { DeskScreenViews, ScreenState } from '@whombat/protocol/session';
import { screenGrid, shapeKey, sizeOf } from '@whombat/screen';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DESK_SETTINGS, deskLayoutProblem, deskLayoutWidgets } from './contract';
import { createFakeDesk, type FakeDeskPerson, fakeDeskApi, fakeScreenDevice } from './fake';
import { fakeBoxLayout, fakeKitchenLayout, fakeOfficeLayout, fakeViews } from './fakeScreens';
import { defaultFakeDeskWorld } from './fakeWorld';

const MARA: FakeDeskPerson = { personId: 'per_mara', name: 'Mara' };
const T0 = Date.parse('2026-10-27T13:34:00Z');

function world(clock = { t: T0 }) {
  const desk = createFakeDesk({
    now: () => clock.t,
    screens: true,
    initial: {
      paired: { personId: MARA.personId, name: MARA.name, pairedAt: '2026-10-25T09:00:00Z', pin: '2580' },
      settings: DEFAULT_DESK_SETTINGS,
    },
  });
  return { desk, api: fakeDeskApi(desk, MARA), clock };
}

describe('the fake screens', () => {
  it('every seeded layout is one the runtime keeps, each widget within its sizes, at its screen’s shape', () => {
    for (const [layout, w, h] of [
      [fakeBoxLayout(), 1280, 800],
      [fakeOfficeLayout(), 1920, 1080],
      [fakeKitchenLayout(), 820, 1180],
    ] as const) {
      expect(DeskLayout.safeParse(layout).success).toBe(true);
      expect(deskLayoutProblem(layout)).toBeNull();
      const shape = shapeKey(screenGrid(w, h));
      const views = fakeViews(defaultFakeDeskWorld(), deskLayoutWidgets(layout));
      for (const page of layout.pages) {
        expect(Object.keys(page.layouts)).toEqual([shape]);
        for (const widget of page.layouts[shape] ?? []) {
          const size = sizeOf(widget, views.find((v) => v.id === widget.id)?.kind);
          expect(widget.w, widget.id).toBeGreaterThanOrEqual(size.min[0]);
          expect(widget.w, widget.id).toBeLessThanOrEqual(size.max[0]);
          expect(widget.h, widget.id).toBeGreaterThanOrEqual(size.min[1]);
          expect(widget.h, widget.id).toBeLessThanOrEqual(size.max[1]);
        }
      }
    }
  });

  it('lists the box first, reads one screen, and answers views the contract takes', async () => {
    const { api } = world();
    const list = await api.screens();
    expect(list.screens.map((s) => s.id)).toEqual(['box', 'scr_office01', 'scr_kitchen1']);
    expect(list.canAdd).toBe(true);
    const box = await api.screen('box');
    expect(box.layout.pages.map((p) => p.name)).toEqual(['Overview', 'Media', 'House']);
    const views = await api.screenViews({ screen: 'box', widgets: deskLayoutWidgets(box.layout) });
    expect(DeskScreenViews.safeParse(views).success).toBe(true);
    expect(views.views.map((v) => v.kind)).toContain('posters');
    await expect(api.screen('scr_gone0000')).rejects.toMatchObject({ details: { code: 'unknown_screen' } });
  });

  it('saves a layout, refuses one with a widget on another, and keeps the box’s name', async () => {
    const { api } = world();
    const box = await api.screen('box');
    const layout = structuredClone(box.layout);
    const first = layout.pages[0]?.layouts['8x5'];
    if (!first?.[0]) throw new Error('no widgets');
    first[0].x = 5;
    await expect(api.updateScreen({ screen: 'box', layout })).rejects.toMatchObject({
      details: { code: 'bad_layout' },
    });
    const turned = await api.updateScreen({ screen: 'box', layout: { ...box.layout, turn: '60s' } });
    expect(turned.layout.turn).toBe('60s');
    expect((await api.updateScreen({ screen: 'box', name: 'Mine' })).name).toBe('This Whombat’s screen');
    expect((await api.updateScreen({ screen: 'scr_kitchen1', name: 'Kitchen' })).name).toBe('Kitchen');
  });

  it('a device shows six letters, becomes a screen when they’re typed, draws its state, and ends when removed', async () => {
    const { desk, api, clock } = world();
    const device = fakeScreenDevice(desk, 'end_new');
    const asked = await device.enrol.request({ label: 'iPad · Safari', platform: 'web' });
    expect(asked.code).toMatch(/^[A-HJ-NP-Z]{6}$/);
    expect(desk.displayLetters('end_new')).toBe(asked.code);
    expect((await device.enrol.status(asked.requestId)).state).toBe('waiting');
    await expect(
      api.addScreen({ code: 'ZZZZZZ', name: 'Hall', popups: 'problems', start: 'copy' }),
    ).rejects.toMatchObject({ details: { code: 'wrong_code' } });
    const added = await api.addScreen({ code: asked.code, name: 'Hall', popups: 'problems', start: 'empty' });
    expect(added.layout.pages).toHaveLength(1);
    expect(await device.enrol.status(asked.requestId)).toMatchObject({
      state: 'added',
      screen: { id: added.id },
    });

    const state = await device.screen.state({ size: { width: 820, height: 1180 } });
    const parsed = ScreenState.parse(state);
    expect(parsed.lock.state).toBe('locked');
    expect(parsed.grid && DeskGrid.safeParse(parsed.grid).success).toBe(true);
    expect(await device.screen.state({ size: { width: 820, height: 1180 }, known: parsed.etag })).toEqual({
      same: true,
      etag: parsed.etag,
    });
    expect((await api.screen(added.id)).size).toEqual({ width: 820, height: 1180 });

    expect((await device.screen.unlock('1111')).triesLeft).toBe(4);
    const unlocked = await device.screen.unlock('2580');
    expect(unlocked.state).toBe('unlocked');
    clock.t += 3 * 60_000;
    expect((await device.screen.lock()).state).toBe('locked');

    await api.removeScreen(added.id);
    await expect(device.screen.state({ size: { width: 820, height: 1180 } })).rejects.toMatchObject({
      code: 'revoked',
    });
  });

  it('a runtime before 3.6 doesn’t know the ops', async () => {
    const api = fakeDeskApi(createFakeDesk(), MARA);
    await expect(api.screens()).rejects.toMatchObject({ code: 'unknown_op' });
  });
});
