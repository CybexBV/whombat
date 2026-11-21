/**
 * Home Assistant's house at a glance (`docs/decisions/service-dashboards.md`, “Home Assistant's house”): four panels on its page that
 * are widgets for a wall or desk screen too — *Home now* (who's home, lights on, doors and windows open, the locks and
 * the alarm), *Weather* (now and the next days), *Rooms* (temperature and humidity per area) and *Energy today* (used,
 * from the sun, back to the grid). Each shows only when Home Assistant has what it needs: no Energy without an energy
 * setup, no Weather without a weather entity.
 *
 * Read over its WebSocket (`ha-socket.ts`) as the connection, one socket per read, kept 10 seconds (the page asks again
 * every 10 while Controls or Home now show):
 * - one `render_template` (`HA_HOUSE_TEMPLATE`; administrators only, like the counts in `homeassistant.ts`) that sends
 *   back a small JSON: the people, how many lights are on, the doors and windows open, the locks, the alarms, the
 *   temperature and humidity sensors and the weather entities as they are now. Never `/api/states`.
 * - the registries the controls keep (`keptLayout`): a sensor's area, and hidden or diagnostic sensors left out.
 * - `weather.get_forecasts` (`call_service` with `return_response`, Home Assistant 2023.12 and later), daily or else
 *   twice daily, kept 15 minutes.
 * - `energy/get_prefs`, then `recorder/statistics_during_period` (each hour's `change` since local midnight, in kWh),
 *   kept 5 minutes.
 * The builders below are pure.
 */
import type { ThingPageItem, ThingPagePanel } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { startOfLocalDay } from '../../../home/time';
import type { Services } from '../../../services';
import { clip, clock, dateOf, figure1, list, num, plural, rec, str } from '../../words';
import { type HaCommands, openHomeAssistant } from '../ha-socket';
import { cachedRead, KIND_DEADLINE_MS, type Latest, liveRead, problemOf, withDeadline } from '../read';
import type { KindCtx } from '../types';
import { type HaLayout, keptLayout, readLayout } from './ha-controls';

/** How long the house read is kept: the page asks every 10 seconds, so at most once per ask. */
export const HOUSE_LIVE_S = 10;
/** How long the forecast is kept. */
export const FORECAST_KEEP_MS = 15 * 60_000;
/** How long today's energy is kept (Home Assistant's statistics come in by the hour). */
export const ENERGY_KEEP_MS = 5 * 60_000;
/** At most this many rows of people, open doors and locks; sensors the template sends. */
const PEOPLE_MAX = 20;
const READINGS_MAX = 300;
/** At most this many camera snapshots on the shelf, and automations asked about for the week. */
const CAMERAS_MAX = 12;
const AUTOMATIONS_MAX = 300;
const TEMPLATE_MS = 5_000;

/* The read ------------------------------------------------------------------------------------------------------------ */

/**
 * Everything the panels need from the states, as one small JSON. Light groups (and Hue's rooms) are left out of the
 * lights so a lamp isn't counted twice; a garage door or gate is a cover, the other doors and windows binary sensors.
 */
export const HA_HOUSE_TEMPLATE = [
  '{%- set ns = namespace(people=[], open=[], locks=[], alarms=[], readings=[], weather=[], cameras=[]) -%}',
  "{%- set gone = ['unavailable', 'unknown'] -%}",
  "{%- for s in states.person | rejectattr('state', 'in', gone) -%}",
  '{%- set ns.people = ns.people + [[s.entity_id, s.name, s.state, s.last_changed.isoformat()]] -%}',
  '{%- endfor -%}',
  "{%- set doors = states.binary_sensor | selectattr('attributes.device_class', 'defined') | selectattr('attributes.device_class', 'in', ['door', 'garage_door', 'opening', 'window']) | rejectattr('state', 'in', gone) | list -%}",
  "{%- set gates = states.cover | selectattr('attributes.device_class', 'defined') | selectattr('attributes.device_class', 'in', ['door', 'garage', 'gate']) | rejectattr('state', 'in', gone) | list -%}",
  "{%- for s in doors | selectattr('state', 'eq', 'on') -%}",
  '{%- set ns.open = ns.open + [[s.entity_id, s.name, s.attributes.device_class, s.last_changed.isoformat()]] -%}',
  '{%- endfor -%}',
  "{%- for s in gates | selectattr('state', 'in', ['open', 'opening']) -%}",
  '{%- set ns.open = ns.open + [[s.entity_id, s.name, s.attributes.device_class, s.last_changed.isoformat()]] -%}',
  '{%- endfor -%}',
  "{%- set lights = states.light | rejectattr('attributes.entity_id', 'defined') | rejectattr('attributes.is_hue_group', 'defined') | rejectattr('state', 'in', gone) | list -%}",
  "{%- for s in states.lock | rejectattr('state', 'in', gone) -%}",
  '{%- set ns.locks = ns.locks + [[s.entity_id, s.name, s.state, s.last_changed.isoformat()]] -%}',
  '{%- endfor -%}',
  "{%- for s in states.alarm_control_panel | rejectattr('state', 'in', gone) -%}",
  '{%- set ns.alarms = ns.alarms + [[s.entity_id, s.name, s.state]] -%}',
  '{%- endfor -%}',
  `{%- for s in (states.sensor | selectattr('attributes.device_class', 'defined') | selectattr('attributes.device_class', 'in', ['temperature', 'humidity']) | rejectattr('state', 'in', gone) | list)[:${READINGS_MAX}] -%}`,
  "{%- set ns.readings = ns.readings + [[s.entity_id, s.attributes.device_class, s.state, s.attributes.unit_of_measurement | default('')]] -%}",
  '{%- endfor -%}',
  "{%- for s in states.camera | rejectattr('state', 'in', gone) -%}",
  '{%- set ns.cameras = ns.cameras + [[s.entity_id, s.name, s.state]] -%}',
  '{%- endfor -%}',
  "{%- for s in states.weather | rejectattr('state', 'in', gone) -%}",
  "{%- set ns.weather = ns.weather + [[s.entity_id, s.name, s.state, s.attributes.temperature | default(none), s.attributes.temperature_unit | default(''), s.attributes.humidity | default(none), s.attributes.wind_speed | default(none), s.attributes.wind_speed_unit | default(''), s.attributes.supported_features | default(0)]] -%}",
  '{%- endfor -%}',
  `{{ {'people': ns.people[:${PEOPLE_MAX}], 'lights': [lights | selectattr('state', 'eq', 'on') | list | count, lights | count], 'doors': (doors | count) + (gates | count), 'open': ns.open[:${PEOPLE_MAX}], 'locks': ns.locks[:${PEOPLE_MAX}], 'alarms': ns.alarms[:5], 'readings': ns.readings, 'weather': ns.weather[:6], 'cameras': ns.cameras[:${CAMERAS_MAX}], 'automations': (states.automation | map(attribute='entity_id') | list)[:${AUTOMATIONS_MAX}], 'automationCount': states.automation | list | count} | to_json }}`,
].join('');

export interface HaPerson {
  id: string;
  name: string;
  /** `home`, `not_home` or a zone's name. */
  state: string;
  since: Date | null;
}

export interface HaOpening {
  id: string;
  name: string;
  /** Its device class: `door`, `window`, `garage`, … */
  kind: string;
  since: Date | null;
}

export interface HaLockNow {
  id: string;
  name: string;
  state: string;
  since: Date | null;
}

export interface HaReading {
  id: string;
  kind: 'temperature' | 'humidity';
  value: number;
  unit: string;
}

export interface HaWeatherNow {
  id: string;
  name: string;
  condition: string;
  temperature: number | null;
  unit: string;
  humidity: number | null;
  wind: number | null;
  windUnit: string;
  /** `WeatherEntityFeature`: 1 daily, 2 hourly, 4 twice daily. */
  features: number;
}

/** A camera Home Assistant has: its snapshot is read through the image route. */
export interface HaCamera {
  id: string;
  name: string;
  /** `idle`, `recording`, `streaming`. */
  state: string;
}

/** The states the house panels show. */
export interface HaHouse {
  people: HaPerson[];
  lights: { on: number; total: number };
  /** Door and window sensors, garage doors and gates. */
  doors: number;
  open: HaOpening[];
  locks: HaLockNow[];
  alarms: { id: string; name: string; state: string }[];
  readings: HaReading[];
  weather: HaWeatherNow[];
  cameras: HaCamera[];
  /** The automations' entity ids (at most 300), for their runs this week. */
  automations: string[];
  automationCount: number;
}

export interface HaDay {
  /** Its local date, `2026-10-21`. */
  date: string;
  condition: string | null;
  high: number | null;
  low: number | null;
  /** The chance of rain, in percent. */
  rain: number | null;
}

/** The energy dashboard's statistics, by kind. */
export interface HaEnergyIds {
  gridIn: string[];
  gridOut: string[];
  solar: string[];
  batteryOut: string[];
  batteryIn: string[];
}

/** Today's energy by the hour, in kWh; null where no statistic came in. */
export interface HaEnergy {
  hours: Date[];
  used: (number | null)[];
  gridIn: (number | null)[];
  gridOut: (number | null)[];
  solar: (number | null)[];
  hasSolar: boolean;
  hasExport: boolean;
}

/** One house read: `null` parts couldn't be read or Home Assistant doesn't have them. */
export interface HaHouseRead {
  readAt: Date;
  house: HaHouse | null;
  layout: HaLayout | null;
  weather: HaWeatherNow | null;
  days: HaDay[] | null;
  energy: HaEnergy | null;
  /** When an automation ran over the last 7 days (the logbook's), null when it couldn't be read. */
  runs: Date[] | null;
}

const at = (v: unknown) => dateOf(v);
const row = (v: unknown) => list(v);

/** The template's answer: Home Assistant sends it as text, or already parsed when it reads as a literal. */
export function parseHouse(events: readonly unknown[]): HaHouse | null {
  const ev = events.map(rec).find((e) => 'result' in e);
  if (!ev) return null;
  let raw: unknown = ev.result;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const r = rec(raw);
  if (!Array.isArray(r.people) || !Array.isArray(r.readings)) return null;
  const lights = row(r.lights);
  return {
    people: row(r.people).flatMap((p) => {
      const [id, name, state, since] = row(p);
      const i = str(id);
      const s = str(state);
      return i && s ? [{ id: i, name: str(name) ?? i, state: s, since: at(since) }] : [];
    }),
    lights: { on: num(lights[0]) ?? 0, total: num(lights[1]) ?? 0 },
    doors: num(r.doors) ?? 0,
    open: row(r.open).flatMap((o) => {
      const [id, name, kind, since] = row(o);
      const i = str(id);
      return i ? [{ id: i, name: str(name) ?? i, kind: str(kind) ?? 'door', since: at(since) }] : [];
    }),
    locks: row(r.locks).flatMap((l) => {
      const [id, name, state, since] = row(l);
      const i = str(id);
      const s = str(state);
      return i && s ? [{ id: i, name: str(name) ?? i, state: s, since: at(since) }] : [];
    }),
    alarms: row(r.alarms).flatMap((a) => {
      const [id, name, state] = row(a);
      const i = str(id);
      const s = str(state);
      return i && s ? [{ id: i, name: str(name) ?? i, state: s }] : [];
    }),
    readings: row(r.readings).flatMap((x): HaReading[] => {
      const [id, kind, value, unit] = row(x);
      const i = str(id);
      const v = num(value);
      if (!i || v === null || (kind !== 'temperature' && kind !== 'humidity')) return [];
      return [{ id: i, kind, value: v, unit: str(unit) ?? '' }];
    }),
    weather: row(r.weather).flatMap((w) => {
      const [id, name, condition, temperature, unit, humidity, wind, windUnit, features] = row(w);
      const i = str(id);
      const c = str(condition);
      if (!i || !c) return [];
      return [
        {
          id: i,
          name: str(name) ?? i,
          condition: c,
          temperature: num(temperature),
          unit: str(unit) ?? '',
          humidity: num(humidity),
          wind: num(wind),
          windUnit: str(windUnit) ?? '',
          features: num(features) ?? 0,
        },
      ];
    }),
    cameras: row(r.cameras).flatMap((c) => {
      const [id, name, state] = row(c);
      const i = str(id);
      return i ? [{ id: i, name: str(name) ?? i, state: str(state) ?? 'idle' }] : [];
    }),
    automations: row(r.automations).filter((x): x is string => typeof x === 'string'),
    automationCount: num(r.automationCount) ?? 0,
  };
}

/** The weather entity to show: Home Assistant's own forecast for home when there is one, else the first. */
export function pickWeather(all: readonly HaWeatherNow[]): HaWeatherNow | null {
  return all.find((w) => w.id === 'weather.home' || w.id === 'weather.forecast_home') ?? all[0] ?? null;
}

const localDate = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);

/**
 * `weather.get_forecasts`' answer for one entity as days: a daily forecast as it is; a twice-daily one by its local
 * date, the day's condition, the highest and the lowest of both halves.
 */
export function daysOf(response: unknown, entityId: string, timeZone: string): HaDay[] {
  const forecast = list(rec(rec(response)[entityId]).forecast).map(rec);
  const byDate = new Map<string, HaDay>();
  for (const f of forecast) {
    const when = dateOf(f.datetime);
    if (!when) continue;
    const date = localDate(when, timeZone);
    const high = num(f.temperature);
    const low = num(f.templow) ?? (f.is_daytime === false ? high : null);
    const day = byDate.get(date);
    const condition = str(f.condition);
    if (!day) {
      byDate.set(date, {
        date,
        condition,
        high: f.is_daytime === false ? null : high,
        low,
        rain: num(f.precipitation_probability),
      });
      continue;
    }
    // The second half of a twice-daily day: the day's condition and the highest win, the night gives the lowest.
    if (f.is_daytime !== false) {
      if (condition) day.condition = condition;
      if (high !== null) day.high = day.high === null ? high : Math.max(day.high, high);
    }
    if (low !== null) day.low = day.low === null ? low : Math.min(day.low, low);
    const rain = num(f.precipitation_probability);
    if (rain !== null) day.rain = Math.max(day.rain ?? 0, rain);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** The statistics of the energy dashboard (both the grid's older `flow_from`/`flow_to` and its single pair). */
export function energyIds(prefs: unknown): HaEnergyIds | null {
  const ids: HaEnergyIds = { gridIn: [], gridOut: [], solar: [], batteryOut: [], batteryIn: [] };
  const add = (to: string[], v: unknown) => {
    const s = str(v);
    if (s && !to.includes(s)) to.push(s);
  };
  for (const src of list(rec(prefs).energy_sources).map(rec)) {
    if (src.type === 'grid') {
      for (const f of list(src.flow_from).map(rec)) add(ids.gridIn, f.stat_energy_from);
      for (const f of list(src.flow_to).map(rec)) add(ids.gridOut, f.stat_energy_to);
      add(ids.gridIn, src.stat_energy_from);
      add(ids.gridOut, src.stat_energy_to);
    } else if (src.type === 'solar') add(ids.solar, src.stat_energy_from);
    else if (src.type === 'battery') {
      add(ids.batteryOut, src.stat_energy_from);
      add(ids.batteryIn, src.stat_energy_to);
    }
  }
  return ids.gridIn.length || ids.solar.length ? ids : null;
}

const HOUR_MS = 3_600_000;

/**
 * Today's hours from the statistics (`{[id]: [{start, change}]}`, `start` in milliseconds), up to the last hour that
 * came in. Used is what came from the grid, the sun and the battery, less what went back and into the battery.
 */
export function energyOf(ids: HaEnergyIds, stats: unknown, midnight: Date, now: Date): HaEnergy {
  const byHour = new Map<string, Map<number, number>>();
  for (const [id, rows] of Object.entries(rec(stats))) {
    const m = new Map<number, number>();
    for (const r of list(rows).map(rec)) {
      const start = num(r.start);
      const change = num(r.change);
      if (start !== null && change !== null) m.set(start, change);
    }
    byHour.set(id, m);
  }
  const hours: Date[] = [];
  for (let t = midnight.getTime(); t + HOUR_MS <= now.getTime(); t += HOUR_MS) hours.push(new Date(t));
  const sum = (group: readonly string[], t: number): number | null => {
    let total: number | null = null;
    for (const id of group) {
      const v = byHour.get(id)?.get(t);
      if (v !== undefined) total = (total ?? 0) + v;
    }
    return total;
  };
  const round = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
  const gridIn = hours.map((h) => round(sum(ids.gridIn, h.getTime())));
  const gridOut = hours.map((h) => round(sum(ids.gridOut, h.getTime())));
  const solar = hours.map((h) => round(sum(ids.solar, h.getTime())));
  const used = hours.map((h, i) => {
    const t = h.getTime();
    if (gridIn[i] === null && solar[i] === null) return null;
    const v =
      (gridIn[i] ?? 0) +
      (solar[i] ?? 0) +
      (sum(ids.batteryOut, t) ?? 0) -
      (gridOut[i] ?? 0) -
      (sum(ids.batteryIn, t) ?? 0);
    return round(Math.max(0, v));
  });
  // The hours still to come in (the statistics of an hour arrive a few minutes after it) are left off the end.
  let last = used.length;
  while (last > 0 && used[last - 1] === null) last--;
  return {
    hours: hours.slice(0, last),
    used: used.slice(0, last),
    gridIn: gridIn.slice(0, last),
    gridOut: gridOut.slice(0, last),
    solar: solar.slice(0, last),
    hasSolar: ids.solar.length > 0,
    hasExport: ids.gridOut.length > 0,
  };
}

/**
 * The logbook's answer as the moments automations ran: an automation's own entry says what triggered it (`source`,
 * “triggered by …”); its switching on and off carries a `state` and isn't a run.
 */
export function runsOf(result: unknown): Date[] {
  return list(result)
    .map(rec)
    .filter(
      (e) =>
        str(e.entity_id)?.startsWith('automation.') &&
        e.state === undefined &&
        (e.source !== undefined || /^triggered/i.test(str(e.message) ?? '')),
    )
    .flatMap((e) => {
      const when = num(e.when);
      return when !== null ? [new Date(when * 1000)] : [];
    });
}

/** How long the week's automation runs are kept: Home Assistant's logbook is a database query. */
export const RUNS_KEEP_MS = 10 * 60_000;

/** When the automations ran since the local midnight six days ago (the Trend's seven days, today last). */
async function readRuns(
  ha: HaCommands,
  ids: readonly string[],
  now: Date,
  timeZone: string,
): Promise<Date[] | null> {
  if (!ids.length) return [];
  const start = startOfLocalDay(new Date(now.getTime() - 6 * 86_400_000), timeZone);
  const r = await ha.call('logbook/get_events', {
    start_time: start.toISOString(),
    end_time: now.toISOString(),
    entity_ids: ids,
  });
  return r.success ? runsOf(r.result) : null;
}

/** A part of the read kept longer than the read itself (the forecast, today's energy, the registries). */
export type Kept = <T>(key: string, ttlMs: number, load: () => Promise<T>) => Promise<T>;

async function readForecast(ha: HaCommands, w: HaWeatherNow, timeZone: string): Promise<HaDay[] | null> {
  // Daily, else twice daily; an entity with only an hourly forecast shows the weather now alone.
  const type = w.features & 1 ? 'daily' : w.features & 4 ? 'twice_daily' : null;
  if (!type) return null;
  const r = await ha.call('call_service', {
    domain: 'weather',
    service: 'get_forecasts',
    service_data: { type },
    target: { entity_id: w.id },
    return_response: true,
  });
  return r.success ? daysOf(rec(r.result).response, w.id, timeZone) : null;
}

async function readEnergy(ha: HaCommands, now: Date, timeZone: string): Promise<HaEnergy | null> {
  const prefs = await ha.call('energy/get_prefs');
  // Without an energy setup Home Assistant answers `not_found`.
  const ids = prefs.success ? energyIds(prefs.result) : null;
  if (!ids) return null;
  const midnight = startOfLocalDay(now, timeZone);
  const all = [
    ...new Set([...ids.gridIn, ...ids.gridOut, ...ids.solar, ...ids.batteryOut, ...ids.batteryIn]),
  ];
  const stats = await ha.call('recorder/statistics_during_period', {
    start_time: midnight.toISOString(),
    statistic_ids: all,
    period: 'hour',
    types: ['change'],
    units: { energy: 'kWh' },
  });
  return stats.success ? energyOf(ids, stats.result, midnight, now) : null;
}

/** Reads the house over a signed-in socket; the slow parts from `kept` when they are fresh. */
export async function readHouse(
  ha: HaCommands,
  now: Date,
  timeZone: string,
  kept: Kept,
  layoutOf: (load: () => Promise<HaLayout>) => Promise<HaLayout>,
): Promise<HaHouseRead> {
  const [template, layout, energy] = await Promise.all([
    ha.collect(
      'render_template',
      { template: HA_HOUSE_TEMPLATE, timeout: 3 },
      (e) => 'result' in rec(e) || 'error' in rec(e),
      TEMPLATE_MS,
    ),
    layoutOf(() => readLayout(ha)).catch(() => null),
    kept(`energy:${localDate(now, timeZone)}`, ENERGY_KEEP_MS, () => readEnergy(ha, now, timeZone)).catch(
      () => null,
    ),
  ]);
  const house = template.result.success ? parseHouse(template.events) : null;
  const weather = house ? pickWeather(house.weather) : null;
  const [days, runs] = await Promise.all([
    weather
      ? kept(`forecast:${weather.id}`, FORECAST_KEEP_MS, () => readForecast(ha, weather, timeZone)).catch(
          () => null,
        )
      : null,
    house
      ? kept(`runs:${localDate(now, timeZone)}`, RUNS_KEEP_MS, () =>
          readRuns(ha, house.automations, now, timeZone),
        ).catch(() => null)
      : null,
  ]);
  return { readAt: now, house, layout, weather, days, energy, runs };
}

function loadHouse(services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) {
  const kept: Kept = (key, ttlMs, load) =>
    cachedRead(services, `ha-house-${key}:${row.id}`, row, load, ttlMs);
  return async (): Promise<HaHouseRead> => {
    const work = (async () => {
      const ha = await openHomeAssistant(services, row, KIND_DEADLINE_MS);
      try {
        return await readHouse(ha, now, timeZone, kept, (load) => keptLayout(services, row, load));
      } finally {
        ha.close();
      }
    })();
    try {
      return await withDeadline(work, KIND_DEADLINE_MS, 'Home Assistant didn’t answer in time.');
    } catch (err) {
      throw problemOf(err, 'Home Assistant');
    }
  };
}

/** The house for a page (kept 10 seconds). */
export function haHouseLatest(
  services: Services,
  row: CatalogConnectionRow,
  timeZone: string,
  now = services.clock(),
): Promise<Latest<HaHouseRead>> {
  return liveRead(services, `homeassistant-house:${row.id}`, row, loadHouse(services, row, now, timeZone), {
    liveS: HOUSE_LIVE_S,
  });
}

/* What it shows ------------------------------------------------------------------------------------------------------- */

/** “14:02” today, “Thu” this week, else “14 Nov”. */
export function sinceWords(when: Date | null, now: Date, timeZone: string): string | null {
  if (!when) return null;
  if (localDate(when, timeZone) === localDate(now, timeZone)) return clock(when, timeZone);
  if (now.getTime() - when.getTime() < 6 * 86_400_000)
    return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(when);
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(when);
}

const ALARM_NOW: Record<string, string> = {
  disarmed: 'Off',
  armed_home: 'On, at home',
  armed_away: 'On, away',
  armed_night: 'On for the night',
  armed_vacation: 'On, on holiday',
  armed_custom_bypass: 'On',
  arming: 'Switching on',
  disarming: 'Switching off',
  pending: 'About to go off',
  triggered: 'Going off',
};

const LOCKED = new Set(['locked', 'locking']);
const LOCK_NOW: Record<string, string> = {
  unlocked: 'Unlocked',
  unlocking: 'Unlocking',
  open: 'Open',
  opening: 'Opening',
  jammed: 'Stuck',
};

export const personNow = (state: string) =>
  state === 'home' ? 'Home' : state === 'not_home' ? 'Away' : clip(state, 30);

/** The line over Home now: what needs a look, else the calm count (“2 home · 3 lights on · all doors locked”). */
export function homeNowLine(h: HaHouse, now: Date, timeZone: string): string | null {
  const warn: string[] = [];
  if (h.alarms.some((a) => a.state === 'triggered')) warn.push('The alarm is going off');
  const open = [...h.open].sort((a, b) => (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0));
  const first = open[0];
  if (open.length === 1 && first) {
    const t = sinceWords(first.since, now, timeZone);
    warn.push(`${first.name} open${t ? ` since ${t}` : ''}`);
  } else if (open.length > 1) warn.push(`${open.length} doors and windows open`);
  const unlocked = h.locks.filter((l) => !LOCKED.has(l.state));
  const lock = unlocked[0];
  if (unlocked.length === 1 && lock)
    warn.push(`${lock.name} ${lock.state === 'jammed' ? 'stuck' : 'unlocked'}`);
  else if (unlocked.length > 1) warn.push(`${unlocked.length} locks unlocked`);
  if (warn.length) return clip(warn.slice(0, 2).join(' · '), 120);
  const calm: string[] = [];
  if (h.people.length) {
    const home = h.people.filter((p) => p.state === 'home').length;
    calm.push(home ? `${home} home` : 'Nobody home');
  }
  if (h.lights.total) calm.push(h.lights.on ? `${plural(h.lights.on, 'light')} on` : 'lights off');
  if (h.locks.length) calm.push(h.locks.length === 1 ? 'door locked' : 'all doors locked');
  else if (h.doors) calm.push('all closed');
  const text = calm.join(' · ');
  return text ? clip(text.charAt(0).toUpperCase() + text.slice(1), 120) : null;
}

/**
 * Home now: what needs a look first, then the people, the alarm, the lights, the doors and the locks. On a page in slots
 * the people are in Who’s home (`people: false`); its line still counts them.
 */
export function homeNowPanel(
  h: HaHouse,
  now: Date,
  timeZone: string,
  { people: withPeople = true }: { people?: boolean } = {},
): ThingPagePanel | null {
  const has =
    (withPeople && h.people.length) || h.lights.total || h.doors || h.locks.length || h.alarms.length;
  if (!has) return null;
  const items: ThingPageItem[] = [];
  const item = (id: string, title: string, right: string, tone?: ThingPageItem['tone']) =>
    items.push({
      id: clip(id, 200),
      title: clip(title, 160),
      right: clip(right, 40),
      ...(tone ? { tone } : {}),
    });
  for (const a of h.alarms.filter((x) => x.state === 'triggered' || x.state === 'pending'))
    item(a.id, a.name, ALARM_NOW[a.state] ?? 'Going off', a.state === 'triggered' ? 'bad' : 'warn');
  for (const o of [...h.open].sort((a, b) => (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0))) {
    const t = sinceWords(o.since, now, timeZone);
    item(o.id, o.name, t ? `Open since ${t}` : 'Open', 'warn');
  }
  for (const l of h.locks.filter((x) => !LOCKED.has(x.state))) {
    const t = sinceWords(l.since, now, timeZone);
    const state = LOCK_NOW[l.state] ?? 'Unlocked';
    item(l.id, l.name, t ? `${state} since ${t}` : state, l.state === 'jammed' ? 'bad' : 'warn');
  }
  const people = withPeople
    ? [...h.people].sort((a, b) => Number(b.state === 'home') - Number(a.state === 'home'))
    : [];
  for (const p of people) item(p.id, p.name, personNow(p.state));
  for (const a of h.alarms.filter((x) => x.state !== 'triggered' && x.state !== 'pending'))
    item(a.id, a.name, ALARM_NOW[a.state] ?? clip(a.state, 30));
  if (h.lights.total) item('lights', 'Lights', h.lights.on ? `${h.lights.on} on` : 'All off');
  if (h.doors && !h.open.length) item('doors', 'Doors and windows', 'All closed', 'ok');
  if (h.locks.length && h.locks.every((l) => LOCKED.has(l.state)))
    item('locks', 'Locks', h.locks.length === 1 ? 'Locked' : 'All locked', 'ok');
  const meta = homeNowLine(h, now, timeZone);
  return {
    kind: 'list',
    id: 'home-now',
    place: 'main',
    title: 'Home now',
    ...(meta ? { meta } : {}),
    items: items.slice(0, 100),
  };
}

/** Home Assistant's weather conditions in words. */
const CONDITION: Record<string, string> = {
  'clear-night': 'Clear',
  cloudy: 'Cloudy',
  exceptional: 'Unusual weather',
  fog: 'Fog',
  hail: 'Hail',
  lightning: 'Thunder',
  'lightning-rainy': 'Thunder and rain',
  partlycloudy: 'Partly cloudy',
  pouring: 'Heavy rain',
  rainy: 'Rain',
  snowy: 'Snow',
  'snowy-rainy': 'Sleet',
  sunny: 'Sunny',
  windy: 'Windy',
  'windy-variant': 'Windy and cloudy',
};

export const conditionWords = (c: string | null): string | null => (c ? (CONDITION[c] ?? null) : null);

/** A temperature as it reads: whole degrees, a real minus sign. */
const degrees = (v: number) => `${Math.round(v)}`.replace('-', '−');
/** A room's reading: one decimal, as Home Assistant shows it. */
const reading = (v: number) => v.toFixed(1).replace('-', '−');

/**
 * Weather: now — the condition, the wind or the humidity and the temperature — then today and the next two days,
 * highest and lowest (“16°/8°”) with the day's condition and a good chance of rain. A list, so it sits below the
 * slots; a screen makes its figures from it (`desk/widgets/screen-panels.ts`, `weatherFigures`).
 */
export function weatherPanel(
  w: HaWeatherNow,
  days: readonly HaDay[] | null,
  now: Date,
  timeZone: string,
): ThingPagePanel | null {
  if (w.temperature === null) return null;
  const said = conditionWords(w.condition);
  const wind = w.wind !== null ? `Wind ${Math.round(w.wind)}${w.windUnit ? ` ${w.windUnit}` : ''}` : null;
  const humidity = w.humidity !== null ? `${Math.round(w.humidity)} % humidity` : null;
  const items: ThingPageItem[] = [
    {
      id: 'now',
      title: clip(said ?? 'Now', 160),
      ...(wind || humidity ? { detail: clip((wind ?? humidity) as string, 300) } : {}),
      right: clip(`${degrees(w.temperature)}${w.unit ? ` ${w.unit}` : '°'}`, 40),
    },
  ];
  const today = localDate(now, timeZone);
  for (const d of (days ?? []).filter((x) => x.date >= today && x.high !== null).slice(0, 3)) {
    const name =
      d.date === today
        ? 'Today'
        : new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(
            new Date(`${d.date}T12:00:00Z`),
          );
    const detail = [
      conditionWords(d.condition),
      d.rain !== null && d.rain >= 30 ? `${Math.round(d.rain)} % chance of rain` : null,
    ].filter(Boolean);
    items.push({
      id: d.date === today ? 'today' : `day-${items.length}`,
      title: name,
      ...(detail.length ? { detail: clip(detail.join(' · '), 300) } : {}),
      right:
        d.low !== null ? `${degrees(d.high as number)}°/${degrees(d.low)}°` : `${degrees(d.high as number)}°`,
    });
  }
  return { kind: 'list', id: 'forecast', place: 'main', title: 'Weather', items };
}

/** Areas outdoors, left out of the inside temperature (“Inside 21 °C”). */
const OUTDOORS = /\b(outside|outdoors?|garden|yard|patio|terrace|balcony|tuin|buiten|balkon|terras)\b/i;

/** Too cold or too warm for a room, in °C. */
const COMFORT = { min: 16, max: 26 };
const celsius = (v: number, unit: string) => (/F/i.test(unit) ? ((v - 32) * 5) / 9 : v);

/**
 * Rooms: each area's temperature and humidity (the average of its sensors), in Home Assistant's order; amber
 * when a room indoors is under 16 °C or over 26 °C. Its line: the average inside, and outside from the weather.
 */
export function roomsPanel(
  h: HaHouse,
  layout: HaLayout,
  outside: HaWeatherNow | null,
): ThingPagePanel | null {
  const byArea = new Map<string, { t: number[]; h: number[]; unit: string }>();
  for (const r of h.readings) {
    const place = layout.entities.get(r.id);
    if (!place?.area || place.hidden || place.category) continue;
    const a = byArea.get(place.area) ?? { t: [], h: [], unit: '' };
    if (r.kind === 'temperature') {
      a.t.push(r.value);
      a.unit ||= r.unit;
    } else a.h.push(r.value);
    byArea.set(place.area, a);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  const items: ThingPageItem[] = [];
  const inside: number[] = [];
  let unit = layout.unit;
  for (const [areaId, name] of layout.areas) {
    const a = byArea.get(areaId);
    if (!a) continue;
    const t = mean(a.t);
    const hum = mean(a.h);
    if (t !== null && !OUTDOORS.test(name)) {
      inside.push(t);
      unit = a.unit || unit;
    }
    const c = t !== null ? celsius(t, a.unit || unit) : null;
    const right = [
      t !== null ? `${reading(t)} ${a.unit || unit}` : null,
      hum !== null ? `${Math.round(hum)} %` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    items.push({
      id: clip(areaId, 200),
      title: clip(name, 160),
      right: clip(right, 40),
      ...(c !== null && !OUTDOORS.test(name) && (c < COMFORT.min || c > COMFORT.max)
        ? { tone: 'warn' as const }
        : {}),
    });
  }
  if (!items.length) return null;
  const avg = mean(inside);
  const out = outside?.temperature ?? null;
  const meta = [
    avg !== null ? `Inside ${degrees(avg)} ${unit}` : null,
    out !== null ? `outside ${degrees(out)} ${outside?.unit || unit}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    kind: 'list',
    id: 'rooms',
    place: 'main',
    title: 'Rooms',
    ...(meta ? { meta: meta.charAt(0).toUpperCase() + meta.slice(1) } : {}),
    items: items.slice(0, 100),
  };
}

const kwh = (v: number) => `${figure1(v)} kWh`;
const total = (xs: readonly (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

/**
 * Energy today: what the house used since midnight, by the hour, beside what came from the sun and what went
 * back to the grid; its figure is what was used, its facts where it came from and went. Bars on the page, lines on
 * a screen.
 */
export function energyPanel(e: HaEnergy, now: Date): ThingPagePanel {
  const used = total(e.used);
  const solar = total(e.solar);
  const back = total(e.gridOut);
  const grid = total(e.gridIn);
  const empty = e.hours.length === 0;
  const series = [
    { key: 'used', label: 'Used', unit: 'kWh', values: empty ? [0] : e.used, color: 'blue' as const },
    ...(e.hasSolar
      ? [
          {
            key: 'solar',
            label: 'From the sun',
            unit: 'kWh',
            values: empty ? [0] : e.solar,
            color: 'orange' as const,
          },
        ]
      : []),
    ...(e.hasExport
      ? [
          {
            key: 'back',
            label: 'Back to the grid',
            unit: 'kWh',
            values: empty ? [0] : e.gridOut,
            color: 'green' as const,
          },
        ]
      : []),
  ];
  return {
    kind: 'chart',
    id: 'energy',
    place: 'main',
    title: 'Energy today',
    meta: empty ? 'Today’s first hour isn’t in yet' : 'By the hour, since midnight',
    timestamps: (empty ? [now] : e.hours).map((h) => h.toISOString()),
    series,
    figure: { value: figure1(used), rest: 'kWh used today' },
    // What was used is the figure; three facts fit a screen's chart at its usual size.
    foot: [
      { label: 'From the grid', value: kwh(grid) },
      ...(e.hasSolar ? [{ label: 'From the sun', value: kwh(solar) }] : []),
      ...(e.hasExport ? [{ label: 'Back to the grid', value: kwh(back) }] : []),
    ],
    style: 'bars',
    axis: { min: 0, unit: 'kWh' },
  };
}

/**
 * The house's panels, in the order the page shows them: Home now, Weather, Rooms, Energy today. On a page in slots the
 * people are in Who’s home, not in Home now.
 */
export function housePanels(
  read: HaHouseRead,
  now: Date,
  timeZone: string,
  opts: { people?: boolean } = {},
): ThingPagePanel[] {
  const h = read.house;
  return [
    h ? homeNowPanel(h, now, timeZone, opts) : null,
    read.weather ? weatherPanel(read.weather, read.days, now, timeZone) : null,
    h && read.layout ? roomsPanel(h, read.layout, read.weather) : null,
    read.energy ? energyPanel(read.energy, now) : null,
  ].filter((p): p is ThingPagePanel => p !== null);
}

/**
 * Home Assistant's page's house read: what Home Assistant has of the house, and whether a newer read is on its way. A
 * read that failed is null with why, so its widgets say so instead of looking like an empty house.
 */
export async function haHousePart(
  ctx: Pick<KindCtx, 'services' | 'row' | 'now' | 'timeZone'>,
): Promise<{ read: HaHouseRead | null; refreshing: boolean; problem?: string }> {
  const read = await haHouseLatest(ctx.services, ctx.row, ctx.timeZone, ctx.now);
  if (read.ok) return { read: read.value, refreshing: read.refreshing };
  return {
    read: null,
    refreshing: read.refreshing,
    problem:
      `Whombat couldn’t read Home Assistant’s house: ${problemOf(read.error, 'Home Assistant').message}`.slice(
        0,
        200,
      ),
  };
}
