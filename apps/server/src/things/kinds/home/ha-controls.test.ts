import { ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { dateWords } from '../../words';
import type { HaCommands, HaResult } from '../ha-socket';
import {
  HA_areas,
  HA_devices,
  HA_home,
  HA_lightStates,
  HA_registry,
  HA_security,
  HA_states,
  HA_unit,
} from './fixtures/homeassistant';
import {
  type ControlsCtx,
  controlOf,
  controlsPanel,
  favouritesOf,
  type HaControlsRead,
  labelIn,
  parseLayout,
  pickEntities,
  planCall,
  readControls,
  statesOf,
} from './ha-controls';

const NOW = new Date('2026-10-21T20:00:00Z');
const ROW = {
  access: 'manage',
  label: 'Home Assistant',
  catalogId: 'homeassistant',
  fields: {},
} as unknown as CatalogConnectionRow;
const LOOK = { ...ROW, access: 'read' } as CatalogConnectionRow;

const ctx = (row = ROW): ControlsCtx => ({
  buttons: { row },
  cameraImage: (id, alt) => ({ ref: `ref-of-${id.replace('.', '-')}.sig0123456789`, alt, shape: 'wide' }),
});

const layout = () => parseLayout(HA_registry, HA_devices, HA_areas, HA_unit);

/** The controls read as Home Assistant answered it. */
function pinnedRead(): HaControlsRead {
  const picked = pickEntities(
    favouritesOf({ value: HA_home.value }),
    favouritesOf({ value: HA_security.value }, ['favorite_entities', 'alert_entities']),
    layout(),
  );
  const states = statesOf([HA_states]);
  return {
    readAt: NOW,
    pinned: picked.pinned,
    ids: picked.ids.filter((id) => states[id]),
    states,
    layout: layout(),
  };
}

const control = (read: HaControlsRead, id: string) =>
  controlsPanel(read, ctx())
    .groups.flatMap((g) => g.items)
    .find((c) => c.id === id);

describe('Home Assistant’s Controls: what shows', () => {
  it('takes the Home favourites, then the Security dashboard’s locks and alarms', () => {
    const read = pinnedRead();
    expect(read.pinned).toBe(true);
    expect(read.ids.slice(0, 3)).toEqual(['light.kitchen_lights', 'light.bed_light', 'switch.ac']);
    expect(read.ids).toContain('lock.front_door');
    expect(read.ids).toContain('alarm_control_panel.security');
    // A garage door and a motion alert on the Security dashboard aren't locks or alarms.
    expect(read.ids).not.toContain('cover.garage_door');
    expect(read.ids).not.toContain('binary_sensor.movement_backyard');
  });

  it('groups by area (the device’s when the entity has none), the rest last', () => {
    const panel = controlsPanel(pinnedRead(), ctx());
    expect(panel.groups.map((g) => g.id)).toEqual(['kitchen', 'bedroom', 'living_room', 'other']);
    expect(panel.groups[2]?.items.map((c) => c.id)).toEqual(['fan.living_room_fan', 'climate.hvac']);
    expect(panel.hint).toBeUndefined();
    // The contract's own checks: steppers within range, switches with `on`.
    expect(ThingPagePanel.safeParse(panel).success).toBe(true);
  });

  it('draws each kind of entity as its control', () => {
    const read = pinnedRead();
    expect(control(read, 'light.bed_light')).toMatchObject({
      on: true,
      state: 'On · 24 %',
      icon: 'light',
      toggle: { action: 'ha-switch', target: 'light.bed_light', allowed: true },
    });
    expect(control(read, 'switch.ac')).toMatchObject({ on: false, icon: 'plug' });
    expect(control(read, 'fan.living_room_fan')).toMatchObject({ label: 'Fan', state: 'On · 67 %' });
    expect(control(read, 'climate.hvac')?.stepper).toMatchObject({
      value: 21.5,
      min: 7,
      max: 35,
      step: 0.5,
      unit: '°C',
      button: { action: 'ha-temp' },
    });
    expect(control(read, 'climate.hvac')?.state).toBe('Now 22 °C · Cooling');
    const cover = control(read, 'cover.kitchen_window');
    expect(cover?.buttons?.map((b) => [b.value, !!b.confirm])).toEqual([
      ['stop', true],
      ['close', true],
    ]);
    expect(control(read, 'lock.front_door')?.buttons?.map((b) => b.value)).toEqual(['lock']);
    expect(control(read, 'scene.movie_time')?.buttons?.[0]).toMatchObject({
      action: 'ha-press',
      label: 'Activate',
    });
    expect(control(read, 'script.good_night')?.buttons?.[0]?.label).toBe('Run');
    expect(control(read, 'button.push')?.buttons?.[0]?.label).toBe('Press');
    expect(control(read, 'sensor.outside_temperature')?.state).toBe('15.6 °C');
    expect(control(read, 'camera.demo_camera')?.image).toMatchObject({ shape: 'wide' });
    expect(control(read, 'media_player.living_room')?.state).toMatch(/^Playing/);
  });

  it('says a date sensor’s day in words where it knows the time zone, else as it came', () => {
    const now = new Date('2026-10-28T09:00:00Z');
    const bins = { s: '2026-10-29', a: { friendly_name: 'Bin day', device_class: 'date' } };
    const words = (state: string) => dateWords(state, now, 'Europe/Amsterdam');
    expect(controlOf('sensor.bins', bins, '°C', { ...ctx(), dateWords: words }, null).state).toBe('Tomorrow');
    expect(controlOf('sensor.bins', bins, '°C', ctx(), null).state).toBe('2026-10-29');
    const alarm = {
      s: '2026-10-30T05:00:00+00:00',
      a: { friendly_name: 'Next alarm', device_class: 'timestamp' },
    };
    expect(controlOf('sensor.alarm', alarm, '°C', { ...ctx(), dateWords: words }, null).state).toBe(
      'Friday 06:00',
    );
  });

  it('gives an alarm that needs its code no buttons', () => {
    const alarm = control(pinnedRead(), 'alarm_control_panel.security');
    expect(alarm?.buttons).toBeUndefined();
    expect(alarm?.state).toContain('code');
    const free = controlOf(
      'alarm_control_panel.house',
      { s: 'disarmed', a: { friendly_name: 'House', supported_features: 3, code_format: null } },
      '°C',
      ctx(),
      null,
    );
    expect(free.buttons?.map((b) => [b.value, !!b.confirm])).toEqual([
      ['arm_home', true],
      ['arm_away', true],
    ]);
  });

  it('keeps a thermostat’s target inside its range and leaves a switch without state words out', () => {
    const c = controlOf(
      'climate.x',
      { s: 'heat', a: { temperature: 40, min_temp: 7, max_temp: 30 } },
      '°C',
      ctx(),
      null,
    );
    expect(c.stepper?.value).toBe(30);
    const gone = controlOf('light.x', { s: 'unavailable', a: { friendly_name: 'Hall' } }, '°C', ctx(), null);
    expect(gone.toggle).toBeUndefined();
    expect(gone.tone).toBe('warn');
  });

  it('draws the buttons disabled on Look only', () => {
    const panel = controlsPanel(pinnedRead(), ctx(LOOK));
    const toggle = panel.groups[0]?.items[0]?.toggle;
    expect(toggle?.allowed).toBe(false);
    expect(toggle?.reason).toContain('Look only');
  });

  it('without favourites shows the lights that are on, scenes and scripts, with the hint', async () => {
    const ha = fakeHa({ home: { value: null }, security: { value: null }, states: HA_lightStates });
    const read = await readControls(ha, NOW, (load) => load());
    expect(read.pinned).toBe(false);
    expect(read.ids).toEqual([
      'light.bed_light',
      'light.ceiling_lights',
      'light.office_rgbw_lights',
      'light.living_room_rgbww_lights',
      'light.entrance_color_white_lights',
      'script.good_night',
      'scene.movie_time',
    ]);
    expect(controlsPanel(read, ctx()).hint).toBeDefined();
    // Only those entities' states were asked for.
    expect(ha.subscribed[0]).toContain('light.kitchen_lights');
    expect(ha.subscribed[0]?.every((id) => /^(light|scene|script)\./.test(id))).toBe(true);
  });

  it('never subscribes without entity ids (that would be every entity)', async () => {
    const ha = fakeHa({
      home: { value: null },
      security: { value: null },
      states: {},
      registry: { entities: [] },
    });
    const read = await readControls(ha, NOW, (load) => load());
    expect(read.ids).toEqual([]);
    expect(ha.subscribed).toEqual([]);
  });

  it('labels without the area’s name', () => {
    expect(labelIn('Living Room Fan', 'Living Room')).toBe('Fan');
    expect(labelIn('Living Room', 'Living Room')).toBe('Living Room');
    expect(labelIn('Hall light', 'Kitchen')).toBe('Hall light');
  });
});

describe('Home Assistant’s Controls: buttons', () => {
  it('switches, presses and sets as everyday changes', () => {
    const read = pinnedRead();
    expect(planCall(read, 'ha-switch', 'light.kitchen_lights', true)).toMatchObject({
      domain: 'light',
      service: 'turn_on',
      everyday: true,
    });
    expect(planCall(read, 'ha-switch', 'light.bed_light', false).service).toBe('turn_off');
    expect(planCall(read, 'ha-press', 'scene.movie_time')).toMatchObject({
      domain: 'scene',
      service: 'turn_on',
      everyday: true,
    });
    expect(planCall(read, 'ha-press', 'button.push').service).toBe('press');
    expect(planCall(read, 'ha-temp', 'climate.hvac', 20.3)).toMatchObject({
      service: 'set_temperature',
      data: { entity_id: 'climate.hvac', temperature: 20.5 },
    });
  });

  it('records covers, locks and alarms', () => {
    const read = pinnedRead();
    expect(planCall(read, 'ha-cover', 'cover.kitchen_window', 'close')).toMatchObject({
      service: 'close_cover',
      everyday: false,
    });
    expect(planCall(read, 'ha-lock', 'lock.front_door', 'unlock')).toMatchObject({
      domain: 'lock',
      service: 'unlock',
      everyday: false,
    });
  });

  it('refuses what the page doesn’t offer', () => {
    const read = pinnedRead();
    expect(() => planCall(read, 'ha-switch', 'light.ceiling_lights', true)).toThrow(/controls here/);
    expect(() => planCall(read, 'ha-lock', 'light.bed_light', 'unlock')).toThrow(/no such control/);
    expect(() => planCall(read, 'ha-switch', 'lock.front_door', true)).toThrow(/no such control/);
    expect(() => planCall(read, 'ha-temp', 'climate.hvac', 50)).toThrow(/temperature/);
    expect(() => planCall(read, 'ha-alarm', 'alarm_control_panel.security', 'disarm')).toThrow(/code/);
    expect(() => planCall(read, 'ha-lock', 'lock.front_door', 'open')).toThrow();
    expect(() => planCall(read, 'ha-cover', 'cover.kitchen_window', 'tilt')).toThrow();
    expect(() => planCall(read, 'ha-switch', undefined, true)).toThrow(/which control/);
  });
});

/** A signed-in socket that answers the controls' commands from the fixtures. */
function fakeHa(opts: {
  home: unknown;
  security: unknown;
  states: { a: Record<string, unknown> } | Record<string, never>;
  registry?: unknown;
}): HaCommands & { subscribed: string[][] } {
  const subscribed: string[][] = [];
  const ok = (result: unknown): HaResult => ({ success: true, result });
  const answers: Record<string, unknown> = {
    'config/entity_registry/list_for_display': opts.registry ?? HA_registry,
    'config/device_registry/list': HA_devices,
    'config/area_registry/list': HA_areas,
    get_config: { unit_system: { temperature: HA_unit } },
  };
  return {
    haVersion: '2026.10.2',
    subscribed,
    async call(type, data) {
      if (type === 'frontend/get_system_data') return ok(data?.key === 'home' ? opts.home : opts.security);
      return type in answers ? ok(answers[type]) : { success: false, code: 'unknown_command', message: '' };
    },
    async collect(type, data) {
      if (type !== 'subscribe_entities')
        return { result: { success: false, code: 'unknown_command', message: '' }, events: [] };
      const ids = data.entity_ids as string[];
      subscribed.push(ids);
      const all = (opts.states as { a?: Record<string, unknown> }).a ?? {};
      return {
        result: ok(null),
        events: [{ a: Object.fromEntries(Object.entries(all).filter(([k]) => ids.includes(k))) }],
      };
    },
    close() {},
  };
}
