import { ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { HaCommands, HaResult } from '../ha-socket';
import {
  HA_energyPrefsGrid,
  HA_energyPrefsLegacy,
  HA_energyStats,
  HA_forecastDaily,
  HA_forecastTwiceDaily,
  HA_houseAlarm,
  HA_houseAreas,
  HA_houseDevices,
  HA_houseEmpty,
  HA_houseEvent,
  HA_houseRegistry,
  HA_logbook,
} from './fixtures/ha-house';
import { parseLayout } from './ha-controls';
import {
  daysOf,
  energyIds,
  energyOf,
  energyPanel,
  type HaHouse,
  homeNowPanel,
  housePanels,
  type Kept,
  parseHouse,
  pickWeather,
  readHouse,
  roomsPanel,
  runsOf,
  weatherPanel,
} from './ha-house';

const NOW = new Date('2026-10-21T19:50:00Z');
const TZ = 'Europe/Amsterdam';
const MIDNIGHT = new Date('2026-10-20T22:00:00Z');

const house = (event: unknown = HA_houseEvent) => parseHouse([event]) as HaHouse;
const layout = () => parseLayout(HA_houseRegistry, HA_houseDevices, HA_houseAreas, '°C');
const asList = (p: ThingPagePanel | null) => {
  if (p?.kind !== 'list') throw new Error(`expected a list, got ${p?.kind}`);
  return p;
};

describe('Home Assistant’s house: the template', () => {
  it('reads its JSON as text and as Home Assistant’s parsed answer', () => {
    const h = house();
    expect(h.people.map((p) => p.state)).toEqual(['home', 'Work', 'not_home']);
    expect(h.lights).toEqual({ on: 3, total: 14 });
    expect(h.open[0]).toMatchObject({ id: 'binary_sensor.back_door', kind: 'door' });
    expect(h.readings).toHaveLength(9);
    expect(pickWeather(h.weather)?.id).toBe('weather.forecast_home');
    expect(parseHouse([HA_houseEmpty])?.people).toEqual([]);
  });

  it('gives nothing for an answer that isn’t the template’s', () => {
    expect(parseHouse([{ result: 'not json' }])).toBeNull();
    expect(parseHouse([{ error: 'UndefinedError', level: 'ERROR' }])).toBeNull();
  });
});

describe('Home now', () => {
  it('leads with a door left open, then who’s home, the alarm, the lights and the locks', () => {
    const p = asList(homeNowPanel(house(), NOW, TZ));
    expect(p.id).toBe('home-now');
    expect(p.meta).toBe('Back door open since 14:02');
    expect(p.items[0]).toMatchObject({ title: 'Back door', right: 'Open since 14:02', tone: 'warn' });
    expect(p.items.map((i) => [i.title, i.right])).toEqual(
      expect.arrayContaining([
        ['Anna', 'Home'],
        ['John', 'Work'],
        ['Sam', 'Away'],
        ['Alarm', 'Off'],
        ['Lights', '3 on'],
        ['Locks', 'All locked'],
      ]),
    );
    // Home first among the people.
    expect(p.items.findIndex((i) => i.title === 'Anna')).toBeLessThan(
      p.items.findIndex((i) => i.title === 'Sam'),
    );
    expect(p.items.some((i) => i.title === 'Doors and windows')).toBe(false);
  });

  it('says it calmly when all is shut', () => {
    const h = { ...house(), open: [] };
    const p = asList(homeNowPanel(h, NOW, TZ));
    expect(p.meta).toBe('1 home · 3 lights on · all doors locked');
    expect(p.items.find((i) => i.title === 'Doors and windows')).toMatchObject({
      right: 'All closed',
      tone: 'ok',
    });
  });

  it('puts an alarm going off and an unlocked door first', () => {
    const p = asList(homeNowPanel(house(HA_houseAlarm), NOW, TZ));
    expect(p.meta).toBe('The alarm is going off · Shed unlocked');
    expect(p.items[0]).toMatchObject({ title: 'Alarm', right: 'Going off', tone: 'bad' });
    expect(p.items[1]).toMatchObject({ title: 'Shed', right: 'Unlocked since 21:40', tone: 'warn' });
  });

  it('isn’t there for a house with nothing to show', () => {
    const empty = house(HA_houseEmpty);
    expect(homeNowPanel(empty, NOW, TZ)).toBeNull();
    expect(
      housePanels(
        { readAt: NOW, house: empty, layout: layout(), weather: null, days: null, energy: null, runs: null },
        NOW,
        TZ,
      ),
    ).toEqual([]);
  });
});

describe('Weather', () => {
  it('shows now with its condition in words, then today and the next two days', () => {
    const w = pickWeather(house().weather);
    if (!w) throw new Error('no weather');
    const days = daysOf(HA_forecastDaily.response, w.id, TZ);
    const p = asList(weatherPanel(w, days, NOW, TZ));
    expect(p).toMatchObject({ id: 'forecast', title: 'Weather', place: 'main' });
    expect(p.items.map((k) => [k.title, k.right])).toEqual([
      ['Partly cloudy', '14 °C'],
      ['Today', '16°/8°'],
      ['Thu', '12°/6°'],
      ['Fri', '13°/−1°'],
    ]);
    expect(p.items[0]?.detail).toBe('Wind 9 km/h');
    expect(p.items[1]?.detail).toContain('Rain');
    expect(p.items[2]?.detail).toContain('40 %');
  });

  it('makes days of a twice-daily forecast: the day’s condition, the highest and the night’s lowest', () => {
    const days = daysOf(HA_forecastTwiceDaily, 'weather.knmi', TZ);
    expect(days.find((d) => d.date === '2026-10-22')).toMatchObject({
      condition: 'pouring',
      high: 12,
      low: 5,
    });
  });

  it('shows now alone without a forecast', () => {
    const w = pickWeather(house().weather);
    if (!w) throw new Error('no weather');
    expect(asList(weatherPanel(w, null, NOW, TZ)).items).toHaveLength(1);
  });
});

describe('Rooms', () => {
  it('averages each area’s sensors, without hidden, diagnostic or unplaced ones, and tones a cold room', () => {
    const p = asList(roomsPanel(house(), layout(), pickWeather(house().weather)));
    expect(p.items.map((i) => [i.title, i.right])).toEqual([
      ['Living room', '21.6 °C · 48 %'],
      ['Bedroom', '15.2 °C · 55 %'],
      ['Garden', '9.1 °C'],
    ]);
    expect(p.items[1]?.tone).toBe('warn');
    // Cold outside is no warning.
    expect(p.items[2]?.tone).toBeUndefined();
    // The garden isn't inside.
    expect(p.meta).toBe('Inside 18 °C · outside 14 °C');
  });

  it('isn’t there without temperature or humidity in an area', () => {
    expect(roomsPanel(house(HA_houseEmpty), layout(), null)).toBeNull();
  });
});

describe('Energy today', () => {
  it('finds the meters of both grid shapes, solar and a battery', () => {
    expect(energyIds(HA_energyPrefsLegacy)).toMatchObject({
      gridIn: ['sensor.energy_import_t1', 'sensor.energy_import_t2'],
      gridOut: ['sensor.energy_export_t1'],
      solar: ['sensor.solar_energy'],
    });
    expect(energyIds(HA_energyPrefsGrid)).toMatchObject({
      gridIn: ['sensor.p1_import'],
      gridOut: [],
      batteryOut: ['sensor.battery_out'],
      batteryIn: ['sensor.battery_in'],
    });
    expect(energyIds({ energy_sources: [{ type: 'gas', stat_energy_from: 'sensor.gas' }] })).toBeNull();
  });

  it('adds up the hours since midnight, leaving off those not in yet', () => {
    const ids = energyIds(HA_energyPrefsLegacy);
    if (!ids) throw new Error('no ids');
    const e = energyOf(ids, HA_energyStats, MIDNIGHT, NOW);
    expect(e.hours).toHaveLength(19);
    // 11:00 local: nothing from the grid, 1.9 from the sun, 1.0 back.
    expect(e.used[11]).toBeCloseTo(0.9);
    const p = energyPanel(e, NOW);
    if (p.kind !== 'chart') throw new Error('expected a chart');
    expect(p.series.map((s) => s.label)).toEqual(['Used', 'From the sun', 'Back to the grid']);
    expect(p.figure).toMatchObject({ value: '10' });
    expect(p.foot?.map((f) => [f.label, f.value])).toEqual([
      ['From the grid', '4.5 kWh'],
      ['From the sun', '9.9 kWh'],
      ['Back to the grid', '4.1 kWh'],
    ]);
    expect(ThingPagePanel.safeParse(p).success).toBe(true);
  });

  it('draws an empty day right after midnight', () => {
    const ids = energyIds(HA_energyPrefsGrid);
    if (!ids) throw new Error('no ids');
    const p = energyPanel(energyOf(ids, {}, MIDNIGHT, new Date('2026-10-20T22:30:00Z')), NOW);
    expect(ThingPagePanel.safeParse(p).success).toBe(true);
    expect(p.kind === 'chart' && p.series.map((s) => s.key)).toEqual(['used']);
  });
});

/** Home Assistant answering the house's commands; `energy` false: no energy setup; `admin` false: no templates. */
function fakeHa(opts: { energy?: unknown; admin?: boolean } = {}) {
  const calls: { type: string; data: Record<string, unknown> }[] = [];
  const ok = (result: unknown): HaResult => ({ success: true, result });
  const no = (code: string): HaResult => ({ success: false, code, message: '' });
  const answers: Record<string, unknown> = {
    'config/entity_registry/list_for_display': HA_houseRegistry,
    'config/device_registry/list': HA_houseDevices,
    'config/area_registry/list': HA_houseAreas,
    get_config: { unit_system: { temperature: '°C' } },
    call_service: HA_forecastDaily,
    'recorder/statistics_during_period': HA_energyStats,
    'logbook/get_events': HA_logbook,
  };
  const ha: HaCommands = {
    haVersion: '2026.10.2',
    async call(type, data = {}) {
      calls.push({ type, data });
      if (type === 'energy/get_prefs')
        return opts.energy === false ? no('not_found') : ok(opts.energy ?? HA_energyPrefsLegacy);
      return type in answers ? ok(answers[type]) : no('unknown_command');
    },
    async collect(type, data) {
      calls.push({ type, data });
      if (type !== 'render_template' || opts.admin === false)
        return { result: no('unauthorized'), events: [] };
      return { result: ok(null), events: [HA_houseEvent] };
    },
    close() {},
  };
  return { ha, calls };
}

const fresh: Kept = (_key, _ttl, load) => load();
const layoutOf = (load: () => Promise<ReturnType<typeof layout>>) => load();

describe('Home Assistant’s house: the read', () => {
  it('asks once for each part: the template, the forecast of the weather shown, the energy since midnight', async () => {
    const { ha, calls } = fakeHa();
    const read = await readHouse(ha, NOW, TZ, fresh, layoutOf);
    expect(calls.filter((c) => c.type === 'render_template')).toHaveLength(1);
    expect(calls.find((c) => c.type === 'call_service')?.data).toMatchObject({
      domain: 'weather',
      service: 'get_forecasts',
      service_data: { type: 'daily' },
      target: { entity_id: 'weather.forecast_home' },
      return_response: true,
    });
    expect(calls.find((c) => c.type === 'recorder/statistics_during_period')?.data).toMatchObject({
      start_time: MIDNIGHT.toISOString(),
      period: 'hour',
      types: ['change'],
      units: { energy: 'kWh' },
    });
    // The automations' runs since the local midnight six days ago, only theirs.
    expect(calls.find((c) => c.type === 'logbook/get_events')?.data).toEqual({
      start_time: '2026-10-14T22:00:00.000Z',
      end_time: NOW.toISOString(),
      entity_ids: ['automation.hall_light_at_sunset', 'automation.morning_heating'],
    });
    expect(read.runs).toHaveLength(3);
    expect(read.house?.cameras.map((c) => c.id)).toEqual(['camera.front_door', 'camera.garden']);
    expect(housePanels(read, NOW, TZ).map((p) => p.id)).toEqual(['home-now', 'forecast', 'rooms', 'energy']);
    for (const p of housePanels(read, NOW, TZ)) expect(ThingPagePanel.safeParse(p).success).toBe(true);
  });

  it('leaves Energy out without an energy setup, and the rest out without an administrator', async () => {
    const plain = await readHouse(fakeHa({ energy: false }).ha, NOW, TZ, fresh, layoutOf);
    expect(housePanels(plain, NOW, TZ).map((p) => p.id)).not.toContain('energy');
    const { ha, calls } = fakeHa({ admin: false });
    const look = await readHouse(ha, NOW, TZ, fresh, layoutOf);
    expect(housePanels(look, NOW, TZ).map((p) => p.id)).toEqual(['energy']);
    expect(calls.some((c) => c.type === 'call_service')).toBe(false);
  });

  it('takes the forecast and the energy from what is kept', async () => {
    const kept = new Map<string, unknown>();
    const keep: Kept = async (key, _ttl, load) => {
      if (!kept.has(key)) kept.set(key, await load());
      return kept.get(key) as Awaited<ReturnType<typeof load>>;
    };
    await readHouse(fakeHa().ha, NOW, TZ, keep, layoutOf);
    const { ha, calls } = fakeHa();
    await readHouse(ha, NOW, TZ, keep, layoutOf);
    expect(calls.map((c) => c.type)).not.toContain('call_service');
    expect(calls.map((c) => c.type)).not.toContain('energy/get_prefs');
    expect(calls.map((c) => c.type)).not.toContain('logbook/get_events');
  });
});

describe('Automations run', () => {
  it('counts an automation’s own entries, by an event or by hand; switching it off is no run', () => {
    expect(runsOf(HA_logbook).map((d) => d.toISOString())).toEqual([
      '2026-10-21T19:30:26.076Z',
      '2026-10-21T19:30:26.078Z',
      '2026-10-20T19:30:26.082Z',
    ]);
    expect(runsOf(null)).toEqual([]);
  });

  it('asks for no runs without automations', async () => {
    const { ha, calls } = fakeHa();
    const empty = {
      ...ha,
      collect: async () => ({ result: { success: true, result: null }, events: [HA_houseEmpty] }),
    } as HaCommands;
    const read = await readHouse(empty, NOW, TZ, fresh, layoutOf);
    expect(read.runs).toEqual([]);
    expect(calls.map((c) => c.type)).not.toContain('logbook/get_events');
  });
});

describe('Home now in slots', () => {
  it('leaves the people to Who’s home but still counts them in its line', () => {
    const p = asList(homeNowPanel(house(), NOW, TZ, { people: false }));
    expect(p.items.map((i) => i.id)).not.toContain('person.anna');
    expect(p.meta).toBe('Back door open since 14:02');
    const calm = asList(homeNowPanel({ ...house(), open: [] }, NOW, TZ, { people: false }));
    expect(calm.meta).toMatch(/^1 home/);
  });
});
