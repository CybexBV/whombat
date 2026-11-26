import { DeskGrid, deskDefaultLayout } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { Services } from '../services';
import { type DoorbellRing, emitDoorbellRing, onDoorbellRing } from '../things/kinds/home/doorbell';
import { screenGrid } from './screen-grid';
import { doorbellWidget, ScreenSpotlights, SPOTLIGHT_WIDGET_ID, withSpotlight } from './spotlight';
import type { ScreenRecord } from './widgets/types';

const T0 = Date.parse('2026-11-26T09:00:00.000Z');
const ring = (eventId = 'evt_1'): DoorbellRing => ({
  connectionId: 'con_protect',
  burrowId: 'brw_1',
  camera: 'cam_front',
  eventId,
  at: new Date(T0),
});
const screen = (id: string, doorbell: 'big' | 'off' = 'big', burrowId = 'brw_1') => ({
  id,
  burrowId,
  doorbell,
});

describe('the doorbell takes over the screens', () => {
  it('shows the doorbell’s camera for a minute on each screen whose choice is Show it big', () => {
    const s = new ScreenSpotlights();
    const shown = s.ring(
      ring(),
      [screen('box'), screen('scr_kitchen01', 'off'), screen('out_x', 'big', 'brw_2')],
      T0,
    );
    expect(shown).toEqual(['box']);
    expect(s.of('box', T0 + 59_000)).toEqual({
      id: 'ring_evt_1',
      widget: {
        id: SPOTLIGHT_WIDGET_ID,
        type: 'panel',
        ref: 'connection:con_protect',
        opts: { panel: 'cameras', item: 'cam_front' },
      },
      until: new Date(T0 + 60_000).toISOString(),
      reason: 'doorbell',
    });
    expect(s.of('scr_kitchen01', T0)).toBeNull();
    expect(s.of('box', T0 + 60_000)).toBeNull();
  });

  it('starts the minute again on a new ring, as a new moment', () => {
    const s = new ScreenSpotlights();
    s.ring(ring('evt_1'), [screen('box')], T0);
    s.ring(ring('evt_2'), [screen('box')], T0 + 50_000);
    expect(s.of('box', T0 + 100_000)).toMatchObject({ id: 'ring_evt_2' });
    s.forget('box');
    expect(s.of('box', T0 + 100_000)).toBeNull();
  });

  it('hears a ring the moment Protect tells it, without waiting', () => {
    const services = { log: { warn() {} } } as unknown as Services;
    const s = new ScreenSpotlights();
    let now = T0;
    const off = onDoorbellRing(services, (r) => s.ring(r, [screen('box')], now));
    now += 5_000;
    emitDoorbellRing(services, ring());
    off();
    expect(s.of('box', now)?.until).toBe(new Date(T0 + 65_000).toISOString());
  });

  it('resolves the moment’s widget first, whatever the screen’s limit', () => {
    const specs = [
      { id: 'w_a', type: 'clock' as const, opts: {} },
      { id: SPOTLIGHT_WIDGET_ID, type: 'clock' as const, opts: {} },
    ];
    const spot = { widget: doorbellWidget({ connectionId: 'con_protect', camera: 'cam_front' }) };
    expect(withSpotlight(specs, spot, 1).map((w) => w.type)).toEqual(['panel']);
    expect(withSpotlight(specs, spot, 64).map((w) => w.id)).toEqual([SPOTLIGHT_WIDGET_ID, 'w_a']);
    expect(withSpotlight(specs, null, 64)).toEqual(specs);
  });

  it('is carried by the screen’s grid, with its view', () => {
    const s = new ScreenSpotlights();
    s.ring(ring(), [screen('box')], T0);
    const record = {
      id: 'box',
      burrowId: 'brw_1',
      kind: 'box',
      name: 'This Whombat’s screen',
      popups: 'all',
      doorbell: 'big',
      layout: deskDefaultLayout(),
      show: {},
      endpointId: null,
      personId: null,
      device: null,
      size: null,
      lastSeenAt: null,
    } as unknown as ScreenRecord;
    const grid = screenGrid({
      record,
      layout: record.layout,
      trying: null,
      spotlight: s.of('box', T0 + 1000),
      views: [{ kind: 'camera', id: SPOTLIGHT_WIDGET_ID, title: 'Front door', locked: true }],
      calm: null,
      view: 'summary',
    });
    expect(DeskGrid.safeParse(grid).success).toBe(true);
    expect(grid?.spotlight).toMatchObject({ reason: 'doorbell', widget: { id: SPOTLIGHT_WIDGET_ID } });
  });
});
