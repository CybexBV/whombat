/**
 * Home Assistant's Controls (service-dashboards.md SD-30, SD-S05, SD-S14): the favourites pinned on Home Assistant's own
 * Home dashboard and the locks and alarms of its Security dashboard, grouped by area, as switches, buttons and steppers
 * at the top of its page; without favourites the lights that are on now, the scenes and the scripts.
 *
 * Read over its WebSocket (`ha-socket.ts`) as the connection, one socket per read:
 * - `frontend/get_system_data` `home` and `security` (Home Assistant 2026.2 and later; `favorite_entities`, and the
 *   Security dashboard's `alert_entities` since 2026.9). Home Assistant fills its Home dashboard up to eight with the
 *   entities used most when fewer are pinned; those aren't stored, so only the pinned ones show.
 * - The registries — `config/entity_registry/list_for_display` (short keys: `ei` id, `ai` area, `di` device, `ec`
 *   category, `hb` hidden), `config/device_registry/list` (an entity's area is mostly its device's) and
 *   `config/area_registry/list` — kept 5 minutes, and `get_config` for the temperature unit.
 * - The states of just those entities: `subscribe_entities {entity_ids}` (filtered by Home Assistant, compressed), its
 *   first message, then the socket closes (which ends the subscription). Never `/api/states` (6,000 entities on John's
 *   box), and never `subscribe_entities` without ids (that is every entity).
 * The whole read is kept 4 seconds (`liveRead`); the page asks again every 10 seconds while Controls show (SD-09).
 *
 * Buttons (`ha-switch`, `ha-press`, `ha-temp`, `ha-cover`, `ha-lock`, `ha-alarm`) call `POST /api/services/<domain>/
 * <service>` with the entity, as the connection, after checking the entity is among the controls shown now and the
 * service fits its domain. Switches, scenes, scripts, buttons and the thermostat are everyday (SD-08); covers, locks and
 * alarms are confirmed and recorded. An alarm that needs its code has no buttons: the code stays in Home Assistant.
 */
import type { ThingTone } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { badRequest, conflict } from '../../../lib/errors';
import type { Services } from '../../../services';
import { imageRef, thingImage } from '../../images';
import { clip, dateOf, dateWords, domainName, list, num, rec, str } from '../../words';
import { actAs } from '../act';
import { type HaCommands, openHomeAssistant } from '../ha-socket';
import { cachedRead, KIND_DEADLINE_MS, type Latest, liveRead, problemOf, withDeadline } from '../read';
import type { KindAction } from '../registry';
import type { KindCtx } from '../types';
import {
  type ButtonCtx,
  button,
  type ThingControl,
  type ThingControlIcon,
  type ThingControlsPanel,
  type ThingImage,
  type ThingPageButton,
} from './shapes';

/** How often a page with Controls asks again (SD-09). */
export const CONTROLS_REFRESH_S = 10;
/** How long the controls read is kept (SD-S05): a page every 10 seconds asks Home Assistant at most that often. */
export const CONTROLS_LIVE_S = 4;
/** How long the registries are kept. */
export const LAYOUT_CACHE_MS = 5 * 60_000;
/** Without favourites: at most this many lights, scenes and scripts. */
export const FALLBACK_MAX = 24;
/** At most this many controls on the page, and lights asked about without favourites. */
export const CONTROLS_MAX = 48;
const LIGHTS_ASKED_MAX = 200;
const SUBSCRIBE_MS = 5_000;

/** The domains that are switches. */
const SWITCHES = new Set(['light', 'switch', 'fan', 'input_boolean']);
/** The domains that are pressed. */
const PRESSES: Record<string, { service: string; label: string; done: string }> = {
  scene: { service: 'turn_on', label: 'Activate', done: 'Activated' },
  script: { service: 'turn_on', label: 'Run', done: 'Started' },
  button: { service: 'press', label: 'Press', done: 'Pressed' },
  input_button: { service: 'press', label: 'Press', done: 'Pressed' },
};
/** The Security dashboard's favourites that show here. */
const SECURITY = new Set(['lock', 'alarm_control_panel']);
/** Home Assistant domains whose readings reveal presence, locks or cameras on a locked desk screen. */
const PRIVATE_DOMAINS = new Set([
  'person',
  'device_tracker',
  'zone',
  'lock',
  'alarm_control_panel',
  'camera',
]);
/** Binary sensor device classes that reveal presence, motion, locks, doors or alarms regardless of display language. */
const PRIVATE_BINARY_CLASSES = new Set([
  'presence',
  'occupancy',
  'motion',
  'moving',
  'lock',
  'door',
  'window',
  'garage_door',
  'opening',
  'smoke',
  'safety',
  'tamper',
]);

/** An entity as the registries place it. */
export interface HaPlace {
  area: string | null;
  hidden: boolean;
  /** A configuration or diagnostic entity. */
  category: boolean;
}

/** The registries, reduced to what Controls use. */
export interface HaLayout {
  /** By entity id. */
  entities: Map<string, HaPlace>;
  /** Areas in Home Assistant's order: id → name. */
  areas: Map<string, string>;
  /** The temperature unit (“°C”). */
  unit: string;
  /** When each area and each device (disabled ones left out) was added, for what came in this week. */
  added: { areas: (Date | null)[]; devices: (Date | null)[] };
}

/** An entity's state as `subscribe_entities` sends it (compressed). */
export interface HaState {
  s: string;
  a: Record<string, unknown>;
}

/** One controls read. */
export interface HaControlsRead {
  readAt: Date;
  /** Pinned on the Home dashboard, or the locks and alarms of the Security one. */
  pinned: boolean;
  /** The entities shown, in order. */
  ids: string[];
  states: Record<string, HaState>;
  layout: HaLayout;
}

/* Reading ------------------------------------------------------------------------------------------------------------ */

/** The registries' answers as a layout. */
export function parseLayout(entities: unknown, devices: unknown, areas: unknown, unit: unknown): HaLayout {
  const deviceArea = new Map<string, string | null>();
  const devicesAdded: (Date | null)[] = [];
  for (const d of list(devices).map(rec)) {
    const id = str(d.id);
    if (id) deviceArea.set(id, str(d.area_id));
    if (id && (d.disabled_by === null || d.disabled_by === undefined))
      devicesAdded.push(dateOf(d.created_at));
  }
  const out = new Map<string, HaPlace>();
  for (const e of list(rec(entities).entities).map(rec)) {
    const id = str(e.ei);
    if (!id) continue;
    const device = str(e.di);
    out.set(id, {
      area: str(e.ai) ?? (device ? (deviceArea.get(device) ?? null) : null),
      hidden: e.hb === true,
      category: e.ec !== undefined && e.ec !== null,
    });
  }
  const areaNames = new Map<string, string>();
  const areasAdded: (Date | null)[] = [];
  for (const a of list(areas).map(rec)) {
    const id = str(a.area_id);
    if (id) {
      areaNames.set(id, str(a.name) ?? id);
      areasAdded.push(dateOf(a.created_at));
    }
  }
  return {
    entities: out,
    areas: areaNames,
    unit: str(unit) ?? '°C',
    added: { areas: areasAdded, devices: devicesAdded },
  };
}

/** The favourites of a dashboard's system data (`{value: {favorite_entities, alert_entities}}`). */
export function favouritesOf(raw: unknown, keys: readonly string[] = ['favorite_entities']): string[] {
  const value = rec(rec(raw).value);
  return keys.flatMap((k) =>
    list(value[k]).filter((x): x is string => typeof x === 'string' && x.includes('.')),
  );
}

/** The entities to ask about: the favourites (Home, then Security's locks and alarms), else lights, scenes, scripts. */
export function pickEntities(
  home: readonly string[],
  security: readonly string[],
  layout: HaLayout,
): { pinned: boolean; ids: string[] } {
  const ids: string[] = [];
  for (const id of [...home, ...security.filter((x) => SECURITY.has(domainOf(x)))])
    if (!ids.includes(id)) ids.push(id);
  if (ids.length) return { pinned: true, ids: ids.slice(0, CONTROLS_MAX) };
  const visible = [...layout.entities.entries()]
    .filter(([, p]) => !p.hidden && !p.category)
    .map(([id]) => id);
  return {
    pinned: false,
    ids: [
      ...visible.filter((id) => domainOf(id) === 'light').slice(0, LIGHTS_ASKED_MAX),
      ...visible.filter((id) => domainOf(id) === 'scene' || domainOf(id) === 'script').slice(0, FALLBACK_MAX),
    ],
  };
}

/** Without favourites (SD-30): the lights that are on now, then the scenes and scripts, at most 24. */
export function fallbackIds(ids: readonly string[], states: Record<string, HaState>): string[] {
  const on = ids.filter((id) => domainOf(id) === 'light' && states[id]?.s === 'on');
  const rest = ids.filter((id) => domainOf(id) !== 'light' && states[id]);
  return [...on, ...rest].slice(0, FALLBACK_MAX);
}

/** `subscribe_entities`' first message's states (`a`: added). */
export function statesOf(events: readonly unknown[]): Record<string, HaState> {
  const out: Record<string, HaState> = {};
  for (const [id, v] of Object.entries(rec(rec(events[0]).a))) {
    const r = rec(v);
    out[id] = { s: str(r.s) ?? 'unknown', a: rec(r.a) };
  }
  return out;
}

/** The registries and the temperature unit, read over a signed-in socket. */
export async function readLayout(ha: HaCommands): Promise<HaLayout> {
  const [entities, devices, areas, config] = await Promise.all([
    ha.call('config/entity_registry/list_for_display'),
    ha.call('config/device_registry/list'),
    ha.call('config/area_registry/list'),
    ha.call('get_config'),
  ]);
  return parseLayout(
    entities.success ? entities.result : null,
    devices.success ? devices.result : null,
    areas.success ? areas.result : null,
    config.success ? rec(rec(config.result).unit_system).temperature : null,
  );
}

/** The registries kept 5 minutes; the controls and the house (`ha-house.ts`) share them. */
export function keptLayout(
  services: Services,
  row: CatalogConnectionRow,
  load: () => Promise<HaLayout>,
): Promise<HaLayout> {
  // Kept without the connection's id: a button doesn't change the registries, so it doesn't forget them.
  return cachedRead(
    services,
    `ha-layout:${row.id}`,
    { credentialVersion: row.credentialVersion, updatedAt: row.updatedAt },
    load,
    LAYOUT_CACHE_MS,
  );
}

/** Reads the controls over a signed-in socket, the registries from the cache when they are fresh. */
export async function readControls(
  ha: HaCommands,
  now: Date,
  layoutOf: (load: () => Promise<HaLayout>) => Promise<HaLayout>,
): Promise<HaControlsRead> {
  const [home, security, layout] = await Promise.all([
    ha.call('frontend/get_system_data', { key: 'home' }),
    ha.call('frontend/get_system_data', { key: 'security' }),
    layoutOf(() => readLayout(ha)),
  ]);
  const picked = pickEntities(
    home.success ? favouritesOf(home.result) : [],
    security.success ? favouritesOf(security.result, ['favorite_entities', 'alert_entities']) : [],
    layout,
  );
  // Never without ids: an empty list asks for every entity.
  const states = picked.ids.length
    ? statesOf(
        (await ha.collect('subscribe_entities', { entity_ids: picked.ids }, () => true, SUBSCRIBE_MS)).events,
      )
    : {};
  const ids = picked.pinned ? picked.ids.filter((id) => states[id]) : fallbackIds(picked.ids, states);
  return { readAt: now, pinned: picked.pinned, ids, states, layout };
}

function loadControls(services: Services, row: CatalogConnectionRow, now: Date) {
  return async (): Promise<HaControlsRead> => {
    const work = (async () => {
      const ha = await openHomeAssistant(services, row, KIND_DEADLINE_MS);
      try {
        return await readControls(ha, now, (load) => keptLayout(services, row, load));
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

/** The controls for a page (kept 4 seconds, SD-S05). */
export function haControlsLatest(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
): Promise<Latest<HaControlsRead>> {
  return liveRead(services, `homeassistant-live:${row.id}`, row, loadControls(services, row, now), {
    liveS: CONTROLS_LIVE_S,
  });
}

/** The controls a button checks against: the page's read when it is fresh, else a new one. */
export function haControlsNow(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
): Promise<HaControlsRead> {
  return cachedRead(services, `homeassistant-live:${row.id}`, row, loadControls(services, row, now), 30_000);
}

/* What it shows ------------------------------------------------------------------------------------------------------- */

export function domainOf(id: string): string {
  return id.slice(0, Math.max(0, id.indexOf('.')));
}

/** A figure as Home Assistant shows it: whole or one decimal. */
function reading(v: number): string {
  return Number.isInteger(v) ? String(v) : (Math.round(v * 10) / 10).toString();
}

const HVAC: Record<string, string> = {
  heating: 'Heating',
  cooling: 'Cooling',
  drying: 'Drying',
  fan: 'Fan',
  idle: 'Idle',
  off: 'Off',
  preheating: 'Preheating',
  defrosting: 'Defrosting',
};

const ALARM: Record<string, string> = {
  disarmed: 'Disarmed',
  armed_home: 'Armed home',
  armed_away: 'Armed away',
  armed_night: 'Armed night',
  armed_vacation: 'Armed vacation',
  armed_custom_bypass: 'Armed',
  arming: 'Arming',
  disarming: 'Disarming',
  pending: 'Pending',
  triggered: 'Triggered',
};

const BINARY: Record<string, [string, string]> = {
  motion: ['Detected', 'Clear'],
  occupancy: ['Detected', 'Clear'],
  presence: ['Home', 'Away'],
  door: ['Open', 'Closed'],
  window: ['Open', 'Closed'],
  opening: ['Open', 'Closed'],
  garage_door: ['Open', 'Closed'],
  lock: ['Unlocked', 'Locked'],
  moisture: ['Wet', 'Dry'],
  smoke: ['Smoke', 'Clear'],
  problem: ['Problem', 'OK'],
};

const DOORS = new Set(['door', 'window', 'opening', 'garage_door', 'garage', 'gate']);

/** The words of a state, cut to the contract. */
const words = (s: string) => clip(s, 60);

/** “Living Room Fan” in Living Room is “Fan”. */
export function labelIn(name: string, area: string | null): string {
  if (area && name.toLowerCase().startsWith(`${area.toLowerCase()} `) && name.length > area.length + 1) {
    const rest = name.slice(area.length + 1).trim();
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return name;
}

/** What a page needs to draw controls besides the read: who may press, and a camera's picture. */
export interface ControlsCtx {
  buttons: ButtonCtx;
  cameraImage: (entityId: string, alt: string) => ThingImage | undefined;
  /** A date sensor's day in words (“Tomorrow”, “Wednesday 06:00”), where the page knows the Whombat's time zone. */
  dateWords?: (state: string) => string | null;
}

/** One entity as a control (SD-30). */
export function controlOf(
  id: string,
  state: HaState,
  unit: string,
  ctx: ControlsCtx,
  area: string | null,
): ThingControl {
  const domain = domainOf(id);
  const a = state.a;
  const name = clip(labelIn(str(a.friendly_name) ?? id, area), 60);
  const isPrivate =
    PRIVATE_DOMAINS.has(domain) ||
    (domain === 'binary_sensor' && PRIVATE_BINARY_CLASSES.has(str(a.device_class) ?? '')) ||
    (domain === 'cover' && DOORS.has(str(a.device_class) ?? ''));
  const base: ThingControl = { id: id.slice(0, 200), label: name, ...(isPrivate ? { private: true } : {}) };
  const s = state.s;
  if (s === 'unavailable' || s === 'unknown') {
    const unknownOk =
      domain === 'scene' || domain === 'button' || domain === 'input_button' || domain === 'script';
    if (s === 'unavailable' || !unknownOk)
      return { ...base, icon: iconOf(domain, a), state: 'Not answering', tone: 'warn' as ThingTone };
  }
  const btn = (spec: Omit<ThingPageButton, 'allowed' | 'reason'>) => button(ctx.buttons, spec);
  if (SWITCHES.has(domain)) {
    const on = s === 'on';
    const level =
      domain === 'light' && num(a.brightness) !== null
        ? Math.round(((num(a.brightness) as number) / 255) * 100)
        : domain === 'fan'
          ? num(a.percentage)
          : null;
    return {
      ...base,
      icon: iconOf(domain, a),
      on,
      state: on ? (level !== null && level > 0 ? `On · ${Math.round(level)} %` : 'On') : 'Off',
      toggle: btn({ action: 'ha-switch', target: id, label: on ? 'Turn off' : 'Turn on' }),
    };
  }
  const press = PRESSES[domain];
  if (press)
    return {
      ...base,
      icon: iconOf(domain, a),
      ...(domain === 'script' && s === 'on' ? { state: 'Running', on: true } : {}),
      buttons: [btn({ action: 'ha-press', target: id, label: press.label, icon: 'play' })],
    };
  if (domain === 'climate') {
    const target = num(a.temperature);
    const current = num(a.current_temperature);
    const doing = str(a.hvac_action);
    const parts = [
      current !== null ? `Now ${reading(current)} ${unit}` : null,
      s === 'off' ? 'Off' : doing ? (HVAC[doing] ?? null) : null,
    ].filter(Boolean);
    const step = num(a.target_temp_step) ?? (unit === '°F' ? 1 : 0.5);
    const min = num(a.min_temp) ?? 7;
    const max = Math.max(min, num(a.max_temp) ?? 35);
    return {
      ...base,
      icon: 'thermostat',
      on: s !== 'off',
      ...(parts.length ? { state: words(parts.join(' · ')) } : {}),
      ...(target !== null && s !== 'off'
        ? {
            stepper: {
              // The contract keeps it within min…max (a target outside its range, clamped).
              value: Math.min(max, Math.max(min, target)),
              min,
              max,
              step,
              unit: unit.slice(0, 8),
              button: btn({ action: 'ha-temp', target: id, label: 'Set temperature' }),
            },
          }
        : {}),
    };
  }
  if (domain === 'cover') {
    const features = num(a.supported_features) ?? 0;
    const pos = num(a.current_position);
    const stateWords = { open: 'Open', closed: 'Closed', opening: 'Opening', closing: 'Closing' }[s] ?? s;
    const buttons: ThingPageButton[] = [];
    const confirm = (verb: string, button: string) => ({
      title: clip(`${verb} ${name}?`, 80),
      body: `Home Assistant ${verb.toLowerCase()}s it right away, wherever anyone is.`,
      button,
    });
    if (features & 1 && s !== 'open')
      buttons.push(
        btn({
          action: 'ha-cover',
          target: id,
          value: 'open',
          label: 'Open',
          icon: 'up',
          confirm: confirm('Open', 'Open'),
        }),
      );
    if (features & 8)
      buttons.push(
        btn({
          action: 'ha-cover',
          target: id,
          value: 'stop',
          label: 'Stop',
          icon: 'stop',
          confirm: confirm('Stop', 'Stop'),
        }),
      );
    if (features & 2 && s !== 'closed')
      buttons.push(
        btn({
          action: 'ha-cover',
          target: id,
          value: 'close',
          label: 'Close',
          icon: 'down',
          confirm: confirm('Close', 'Close'),
        }),
      );
    return {
      ...base,
      icon: DOORS.has(str(a.device_class) ?? '') ? 'door' : 'blind',
      on: s !== 'closed',
      state: words(pos !== null && s === 'open' && pos < 100 ? `${stateWords} · ${pos} %` : stateWords),
      ...(buttons.length ? { buttons } : {}),
    };
  }
  if (domain === 'lock') {
    const stateWords =
      {
        locked: 'Locked',
        unlocked: 'Unlocked',
        locking: 'Locking',
        unlocking: 'Unlocking',
        jammed: 'Jammed',
        open: 'Open',
        opening: 'Opening',
      }[s] ?? s;
    const lock = btn({
      action: 'ha-lock',
      target: id,
      value: 'lock',
      label: 'Lock',
      icon: 'lock',
      confirm: {
        title: clip(`Lock ${name}?`, 80),
        body: 'Home Assistant locks it right away.',
        button: 'Lock',
      },
    });
    const unlock = btn({
      action: 'ha-lock',
      target: id,
      value: 'unlock',
      label: 'Unlock',
      icon: 'unlock',
      tone: 'danger',
      confirm: {
        title: clip(`Unlock ${name}?`, 80),
        body: 'Home Assistant unlocks it right away, so anyone there can open it.',
        button: 'Unlock',
      },
    });
    return {
      ...base,
      icon: 'lock',
      on: s !== 'locked',
      state: stateWords,
      ...(s === 'jammed' ? { tone: 'bad' as ThingTone } : {}),
      buttons: s === 'locked' ? [unlock] : s === 'unlocked' || s === 'open' ? [lock] : [lock, unlock],
    };
  }
  if (domain === 'alarm_control_panel') {
    const stateWords = ALARM[s] ?? s;
    const tone: ThingTone | undefined = s === 'triggered' ? 'bad' : undefined;
    if (str(a.code_format))
      return {
        ...base,
        icon: 'alarm',
        on: s !== 'disarmed',
        state: words(`${stateWords} · needs its code in Home Assistant`),
        ...(tone ? { tone } : {}),
      };
    const features = num(a.supported_features) ?? 0;
    const arm = (value: 'arm_home' | 'arm_away', label: string) =>
      btn({
        action: 'ha-alarm',
        target: id,
        value,
        label,
        icon: 'shield',
        confirm: {
          title: clip(`${label}?`, 80),
          body: `Home Assistant arms ${name} right away.`,
          button: label,
        },
      });
    const buttons: ThingPageButton[] =
      s === 'disarmed'
        ? [
            ...(features & 1 ? [arm('arm_home', 'Arm home')] : []),
            ...(features & 2 ? [arm('arm_away', 'Arm away')] : []),
          ]
        : [
            btn({
              action: 'ha-alarm',
              target: id,
              value: 'disarm',
              label: 'Disarm',
              icon: 'shield',
              tone: 'danger',
              confirm: {
                title: clip(`Disarm ${name}?`, 80),
                body: 'Home Assistant disarms it right away.',
                button: 'Disarm',
              },
            }),
          ];
    return {
      ...base,
      icon: 'alarm',
      on: s !== 'disarmed',
      state: stateWords,
      ...(tone ? { tone } : {}),
      ...(buttons.length ? { buttons } : {}),
    };
  }
  if (domain === 'camera')
    return {
      ...base,
      icon: 'camera',
      state: { recording: 'Recording', streaming: 'Live', idle: 'Idle' }[s] ?? 'Live',
      ...(() => {
        const image = ctx.cameraImage(id, name);
        return image ? { image } : {};
      })(),
    };
  if (domain === 'media_player') {
    const title = str(a.media_title);
    const stateWords =
      { playing: 'Playing', paused: 'Paused', idle: 'Idle', off: 'Off', on: 'On', buffering: 'Loading' }[s] ??
      s;
    return {
      ...base,
      icon: 'media',
      on: s === 'playing',
      state: words(s === 'playing' && title ? `${stateWords} · ${title}` : stateWords),
    };
  }
  if (domain === 'binary_sensor') {
    const dc = str(a.device_class) ?? '';
    const [onWord, offWord] = BINARY[dc] ?? ['On', 'Off'];
    return {
      ...base,
      icon: DOORS.has(dc) ? 'door' : 'sensor',
      on: s === 'on',
      state: s === 'on' ? onWord : offWord,
    };
  }
  if (domain === 'sensor') {
    const v = num(s);
    const u = str(a.unit_of_measurement);
    const day = v === null ? ctx.dateWords?.(s) : null;
    return {
      ...base,
      icon: 'sensor',
      state: words(day ?? (v !== null ? `${reading(v)}${u ? ` ${u}` : ''}` : s)),
    };
  }
  return { ...base, icon: 'power', state: words(domainName(s)) };
}

function iconOf(domain: string, a: Record<string, unknown>): ThingControlIcon {
  if (domain === 'light') return 'light';
  if (domain === 'fan') return 'fan';
  if (domain === 'switch') return str(a.device_class) === 'outlet' ? 'plug' : 'switch';
  if (domain === 'input_boolean') return 'switch';
  if (domain === 'scene') return 'scene';
  if (domain === 'script') return 'script';
  if (domain === 'button' || domain === 'input_button') return 'button';
  if (domain === 'lock') return 'lock';
  if (domain === 'alarm_control_panel') return 'alarm';
  if (domain === 'camera') return 'camera';
  if (domain === 'climate') return 'thermostat';
  if (domain === 'cover') return 'blind';
  return 'sensor';
}

const HINT = 'Pin favourites on Home Assistant’s Home dashboard to choose what shows here.';

/** The Controls panel (SD-30): the controls grouped by area in the order they first come, those without one last. */
export function controlsPanel(read: HaControlsRead, ctx: ControlsCtx): ThingControlsPanel {
  const groups = new Map<string, { id: string; title: string; items: ThingControl[] }>();
  for (const id of read.ids.slice(0, CONTROLS_MAX)) {
    const state = read.states[id];
    if (!state) continue;
    const areaId = read.layout.entities.get(id)?.area ?? null;
    const areaName = areaId ? (read.layout.areas.get(areaId) ?? null) : null;
    const key = areaName && areaId ? areaId : 'other';
    let group = groups.get(key);
    if (!group) {
      group = { id: key.slice(0, 40), title: areaName ? clip(areaName, 60) : 'Other', items: [] };
      groups.set(key, group);
    }
    group.items.push(controlOf(id, state, read.layout.unit, ctx, areaName));
  }
  const ordered = [...groups.values()].sort((a, b) => Number(a.id === 'other') - Number(b.id === 'other'));
  return {
    kind: 'controls',
    id: 'controls',
    // The lights and the thermostat are what a person opens Home Assistant's page for: first, above its figures.
    place: 'top',
    title: 'Controls',
    meta: read.pinned ? 'Your favourites in Home Assistant' : 'Lights that are on, scenes and scripts',
    ...(read.pinned ? {} : { hint: HINT }),
    groups: ordered.slice(0, 16),
    empty: read.pinned
      ? 'None of the favourites answer just now.'
      : 'No lights on, and no scenes or scripts.',
  };
}

/** What a page reader needs for Controls: the connection (Look only), and a camera's snapshot through the image route (SD-06). */
export function controlsCtx(
  ctx: Pick<KindCtx, 'services' | 'row' | 'now'> & Partial<Pick<KindCtx, 'timeZone'>>,
): ControlsCtx {
  const { timeZone } = ctx;
  return {
    buttons: ctx,
    cameraImage: (entityId, alt) =>
      thingImage(imageRef(ctx, { path: `/api/camera_proxy/${entityId}`, snapshot: true }), alt, 'wide'),
    ...(timeZone ? { dateWords: (state: string) => dateWords(state, ctx.now, timeZone) } : {}),
  };
}

/**
 * Home Assistant's page's Controls (SD-30): the panel for the top of its main column, whether a newer read is on its
 * way, and why there are none when the read failed. Nothing when Home Assistant has no favourites, lights, scenes or
 * scripts to show.
 */
export async function haControlsPart(
  ctx: Pick<KindCtx, 'services' | 'row' | 'now'> & Partial<Pick<KindCtx, 'timeZone'>>,
): Promise<{ panel: ThingControlsPanel | null; refreshing: boolean; problem?: string }> {
  const read = await haControlsLatest(ctx.services, ctx.row, ctx.now);
  if (!read.ok)
    return {
      panel: null,
      refreshing: read.refreshing,
      problem:
        `Whombat couldn’t read Home Assistant’s controls: ${problemOf(read.error, 'Home Assistant').message}`.slice(
          0,
          200,
        ),
    };
  const panel = controlsPanel(read.value, controlsCtx(ctx));
  return { panel: panel.groups.length || read.value.pinned ? panel : null, refreshing: read.refreshing };
}

/* Buttons ------------------------------------------------------------------------------------------------------------ */

/** A service call a button makes, and what it says. */
export interface HaCall {
  domain: string;
  service: string;
  data: Record<string, unknown>;
  message: string;
  title: string;
  everyday: boolean;
}

const STATE_OF = (read: HaControlsRead, id: string): HaState | null =>
  read.ids.includes(id) ? (read.states[id] ?? null) : null;

/**
 * The service call of a button (SD-S04): only for an entity among the controls shown now, a service its domain allows,
 * and a value it offers; throws `badRequest`/`conflict` in plain words otherwise.
 */
export function planCall(read: HaControlsRead, action: string, target: unknown, value?: unknown): HaCall {
  if (typeof target !== 'string' || !target) throw badRequest('Say which control.');
  const state = STATE_OF(read, target);
  if (!state) throw badRequest('That isn’t one of the controls here any more. Read the page again.');
  const domain = domainOf(target);
  const name = str(state.a.friendly_name) ?? target;
  const data = { entity_id: target };
  if (state.s === 'unavailable') throw conflict(`${name} isn’t answering Home Assistant just now.`);
  switch (action) {
    case 'ha-switch': {
      if (!SWITCHES.has(domain)) break;
      const on = typeof value === 'boolean' ? value : state.s !== 'on';
      return {
        domain,
        service: on ? 'turn_on' : 'turn_off',
        data,
        message: `Turned ${on ? 'on' : 'off'} ${name}.`,
        title: `Turned ${on ? 'on' : 'off'} ${name}`,
        everyday: true,
      };
    }
    case 'ha-press': {
      const press = PRESSES[domain];
      if (!press) break;
      return {
        domain,
        service: press.service,
        data,
        message: `${press.done} ${name}.`,
        title: `${press.done} ${name}`,
        everyday: true,
      };
    }
    case 'ha-temp': {
      if (domain !== 'climate') break;
      const t = typeof value === 'number' ? value : Number(value);
      const min = num(state.a.min_temp) ?? 7;
      const max = num(state.a.max_temp) ?? 35;
      if (!Number.isFinite(t) || t < min || t > max)
        throw badRequest(`Choose a temperature from ${reading(min)} to ${reading(max)}.`);
      if (num(state.a.temperature) === null) throw conflict(`${name} keeps a range, not one temperature.`);
      const rounded = Math.round(t * 2) / 2;
      return {
        domain,
        service: 'set_temperature',
        data: { ...data, temperature: rounded },
        message: `Set ${name} to ${reading(rounded)}°.`,
        title: `Set ${name} to ${reading(rounded)}°`,
        everyday: true,
      };
    }
    case 'ha-cover': {
      if (domain !== 'cover') break;
      const verb = {
        open: ['open_cover', 'Opening', 'Opened'],
        close: ['close_cover', 'Closing', 'Closed'],
        stop: ['stop_cover', 'Stopped', 'Stopped'],
      }[String(value)];
      const bit = { open: 1, close: 2, stop: 8 }[String(value)];
      if (!verb || !bit || !((num(state.a.supported_features) ?? 0) & bit))
        throw badRequest(`${name} can’t do that.`);
      return {
        domain,
        service: verb[0] as string,
        data,
        message: `${verb[1]} ${name}.`,
        title: `${verb[2]} ${name}`,
        everyday: false,
      };
    }
    case 'ha-lock': {
      if (domain !== 'lock' || (value !== 'lock' && value !== 'unlock')) break;
      return {
        domain,
        service: value,
        data,
        message: `${value === 'lock' ? 'Locking' : 'Unlocking'} ${name}.`,
        title: `${value === 'lock' ? 'Locked' : 'Unlocked'} ${name}`,
        everyday: false,
      };
    }
    case 'ha-alarm': {
      if (domain !== 'alarm_control_panel') break;
      if (str(state.a.code_format))
        throw conflict(`${name} needs its code: arm or disarm it in Home Assistant.`);
      const plan = {
        arm_home: ['alarm_arm_home', 'Arming', 'Armed', 1, ' at home'],
        arm_away: ['alarm_arm_away', 'Arming', 'Armed', 2, ' (away)'],
        disarm: ['alarm_disarm', 'Disarming', 'Disarmed', 0, ''],
      }[String(value)] as [string, string, string, number, string] | undefined;
      if (!plan || (plan[3] && !((num(state.a.supported_features) ?? 0) & plan[3])))
        throw badRequest(`${name} can’t do that.`);
      return {
        domain,
        service: plan[0],
        data,
        message: `${plan[1]} ${name}${plan[4]}.`,
        title: `${plan[2]} ${name}${plan[4]}`,
        everyday: false,
      };
    }
  }
  throw badRequest(`${name} has no such control.`);
}

/** A control's button: checks it against the controls shown now, then calls the service as the connection. */
function haControl(action: string): KindAction {
  return async ({ services, row, now }, { target, value }) => {
    let read: HaControlsRead;
    try {
      read = await haControlsNow(services, row, now);
    } catch (err) {
      throw conflict(problemOf(err, 'Home Assistant').message);
    }
    const call = planCall(read, action, target, value);
    await actAs(services, row, 'Home Assistant', {
      method: 'POST',
      path: `/api/services/${call.domain}/${call.service}`,
      body: call.data,
    });
    return { message: call.message, title: call.title.slice(0, 200), everyday: call.everyday };
  };
}

/** Home Assistant's control buttons, for its kind's `actions` beside Restart (SD-S04). */
export const HA_CONTROL_ACTIONS: Record<string, KindAction> = Object.fromEntries(
  ['ha-switch', 'ha-press', 'ha-temp', 'ha-cover', 'ha-lock', 'ha-alarm'].map((a) => [a, haControl(a)]),
);
