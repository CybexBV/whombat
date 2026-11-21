/**
 * A device profile as Whombat checks it and turns it into tools (docs/decisions/one-whombat.md ONE-16, ONE-18;
 * one-whombat-devices.md). Pure.
 *
 * - **Problems** (`deviceProfileProblems`): what the schema can't say — unique keys, a reading or action for the
 *   profile's driver, writes only to tables that take them, ranges in order, choices for a choice, sane paths. Each in
 *   a sentence the agent can fix.
 * - **Hash** (`profileHash`): sha256 of the canonical profile. The person's choices hold for exactly that profile; a
 *   rewritten profile starts from the defaults again (ONE-18).
 * - **Tools** (`deviceToolDefinitions`): `<device>_read` (the readings, all or some) and one tool per action
 *   (`<device>_<action>`, its value typed by the profile). An action marked sensitive always asks (origin
 *   `device-sensitive`).
 * - **Proposal** (`proposedChoice`): what the card suggests before the person chooses — Ask for each action, Off for a
 *   sensitive one, limits from the profile's own range.
 */
import { canonicalJson, type JsonObject, sha256Hex } from '@whombat/core';
import type { ArgLimit, ToolLimits } from '../connections/limits';
import type { DeviceAction, DeviceChoice, DeviceProfile, DeviceReading } from './types';
import { registersFor } from './values';

export const DEVICE_READINGS_MAX = 40;
export const DEVICE_ACTIONS_MAX = 20;
export const DEVICE_SLUG_MAX = 24;
/** The argument every action tool takes. */
export const DEVICE_VALUE_POINTER = '/value';

const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** A profile's hash (ONE-18): the person's choices are bound to it. */
export function profileHash(profile: DeviceProfile): string {
  return sha256Hex(canonicalJson(profile));
}

/** “Daikin Altherma heat pump” → `daikin_altherma_heat` (snake case, at most 24 characters, cut at a word). */
export function deviceSlug(name: string): string {
  const words = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let out = '';
  for (const w of words) {
    const next = out ? `${out}_${w}` : w;
    if (next.length > DEVICE_SLUG_MAX) break;
    out = next;
  }
  if (!out) out = (words[0] ?? 'device').slice(0, DEVICE_SLUG_MAX);
  return /^[a-z]/.test(out) ? out : `d_${out}`.slice(0, DEVICE_SLUG_MAX);
}

/**
 * The device as a sentence names it: “the heat pump” (a plain first word lower-cased), “the SolarEdge inverter” (a
 * brand kept as it is).
 */
export function deviceNoun(name: string): string {
  const first = name.split(/\s+/)[0] ?? '';
  const plain = /^[A-Z][a-z]+$/.test(first);
  return `the ${plain ? name.charAt(0).toLowerCase() + name.slice(1) : name}`;
}

/** The connection's handle from the device's name: `daikin-altherma-heat`. */
export function deviceHandleBase(name: string): string {
  return deviceSlug(name).replace(/_/g, '-').replace(/^d-/, 'device-');
}

function pathProblem(path: string): boolean {
  return !path.startsWith('/') || path.includes('..') || /[\s#]/.test(path) || path.length > 300;
}

function pointerProblem(pointer: string): boolean {
  return pointer !== '' && !/^(\/([^~/]|~[01])*)+$/.test(pointer);
}

function choicesProblem(choices: readonly DeviceChoice[] | undefined): string | null {
  if (!choices?.length) return null;
  const values = new Set(choices.map((c) => JSON.stringify(c.value)));
  return values.size === choices.length ? null : 'has the same choice twice';
}

/** What is wrong with a profile, each in a sentence for the agent; empty when it is usable. */
export function deviceProfileProblems(profile: DeviceProfile): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const modbus = profile.driver === 'modbus_tcp';
  if (profile.readings.length === 0) problems.push('A profile needs at least one reading.');
  if (profile.readings.length > DEVICE_READINGS_MAX)
    problems.push(`A profile has at most ${DEVICE_READINGS_MAX} readings.`);
  if (profile.actions.length > DEVICE_ACTIONS_MAX)
    problems.push(`A profile has at most ${DEVICE_ACTIONS_MAX} actions.`);
  const checkReading = (r: DeviceReading) => {
    if (!KEY.test(r.key)) problems.push(`Reading key “${r.key}” must be lower case letters, digits and _.`);
    if (seen.has(`r:${r.key}`)) problems.push(`Two readings are called “${r.key}”.`);
    seen.add(`r:${r.key}`);
    if (modbus) {
      if (!r.modbus) problems.push(`Reading “${r.key}” needs its Modbus register.`);
      else {
        const m = r.modbus;
        const bits = m.table === 'coil' || m.table === 'discrete';
        if (bits && m.type !== 'bool') problems.push(`Reading “${r.key}”: a ${m.table} is a bool.`);
        if (m.address + (bits ? 1 : registersFor(m.type)) - 1 > 0xffff)
          problems.push(`Reading “${r.key}”: the address is past the last Modbus register.`);
        if (m.scale !== undefined && !(m.scale !== 0 && Number.isFinite(m.scale)))
          problems.push(`Reading “${r.key}”: the scale must be a number other than 0.`);
      }
    } else if (!r.http) problems.push(`Reading “${r.key}” needs its HTTP path and pointer.`);
    else if (pathProblem(r.http.path) || pointerProblem(r.http.pointer))
      problems.push(`Reading “${r.key}”: the path starts with / and the pointer is a JSON pointer.`);
    const dup = choicesProblem(r.choices);
    if (dup) problems.push(`Reading “${r.key}” ${dup}.`);
  };
  const checkAction = (a: DeviceAction) => {
    if (!KEY.test(a.key)) problems.push(`Action key “${a.key}” must be lower case letters, digits and _.`);
    if (a.key === 'read') problems.push('An action can’t be called “read”.');
    if (seen.has(`a:${a.key}`)) problems.push(`Two actions are called “${a.key}”.`);
    seen.add(`a:${a.key}`);
    if (modbus) {
      if (!a.modbus) problems.push(`Action “${a.key}” needs its Modbus register.`);
      else {
        const m = a.modbus;
        // The schema allows only these two; a profile from elsewhere is checked anyway.
        const table: string = m.table;
        if (table !== 'holding' && table !== 'coil')
          problems.push(
            `Action “${a.key}”: ${table} registers can only be read; use a holding register or a coil.`,
          );
        if (m.table === 'coil' && a.valueType === 'number')
          problems.push(`Action “${a.key}”: a coil is on or off, not a number.`);
        if (m.address + (m.table === 'coil' ? 1 : registersFor(m.type)) - 1 > 0xffff)
          problems.push(`Action “${a.key}”: the address is past the last Modbus register.`);
      }
    } else if (!a.http) problems.push(`Action “${a.key}” needs its HTTP method and path.`);
    else if (
      pathProblem(a.http.path) ||
      (a.http.valuePointer !== undefined && pointerProblem(a.http.valuePointer))
    )
      problems.push(`Action “${a.key}”: the path starts with / and the value pointer is a JSON pointer.`);
    if (a.valueType === 'choice' && !a.choices?.length)
      problems.push(`Action “${a.key}” is a choice: list its choices.`);
    if (a.valueType === 'number') {
      if (a.min !== undefined && a.max !== undefined && a.min > a.max)
        problems.push(`Action “${a.key}”: min is above max.`);
      if (a.step !== undefined && !(a.step > 0)) problems.push(`Action “${a.key}”: a step is more than 0.`);
      if (a.min === undefined || a.max === undefined)
        problems.push(`Action “${a.key}”: give the range the manual allows (min and max).`);
    }
    const dup = choicesProblem(a.choices);
    if (dup) problems.push(`Action “${a.key}” ${dup}.`);
  };
  profile.readings.forEach(checkReading);
  profile.actions.forEach(checkAction);
  return [...new Set(problems)].slice(0, 20);
}

/**
 * The unit an action's value is in: its own (`DeviceAction.unit`, contracts 0.80.1), else the reading of the same key's,
 * else the reading of the same Modbus register or HTTP path's (profiles written before 0.80.1).
 */
export function actionUnit(
  profile: Pick<DeviceProfile, 'readings'>,
  action: DeviceAction,
): string | undefined {
  // Its own unit first (contracts 0.80.1, CT-345), else the reading of the same key, register or path.
  if (action.unit) return action.unit;
  const same = profile.readings.find((r) => r.key === action.key);
  if (same) return same.unit;
  const m = action.modbus;
  if (m)
    return profile.readings.find((r) => r.modbus?.table === m.table && r.modbus.address === m.address)?.unit;
  const h = action.http;
  return h ? profile.readings.find((r) => r.http?.path === h.path)?.unit : undefined;
}

/** The profile's own range of an action as a limit (the card's starting point and the driver's hard bound). */
export function actionRange(action: DeviceAction): ArgLimit | undefined {
  if (action.valueType === 'number') {
    const out: ArgLimit = {};
    if (action.min !== undefined) out.min = action.min;
    if (action.max !== undefined) out.max = action.max;
    if (action.step !== undefined) out.step = action.step;
    return Object.keys(out).length ? out : undefined;
  }
  if (action.valueType === 'choice' && action.choices?.length)
    return { choices: action.choices.map((c) => c.value) };
  return undefined;
}

export interface ProposedChoice {
  tier: 'off' | 'ask' | 'can';
  limits?: ArgLimit;
}

/** What the card suggests for an action before the person chooses: Ask, Off when sensitive, the profile's range. */
export function proposedChoice(action: DeviceAction): ProposedChoice {
  const range = actionRange(action);
  return { tier: action.sensitive ? 'off' : 'ask', ...(range ? { limits: range } : {}) };
}

/** A choice's limits as the action tool's (`{args: {'/value': …}}`), or null. */
export function toolLimitsOf(limits: ArgLimit | undefined): ToolLimits | null {
  return limits && Object.keys(limits).length ? { args: { [DEVICE_VALUE_POINTER]: limits } } : null;
}

export interface DeviceToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  access: 'read' | 'write';
  origin: 'device' | 'device-sensitive';
  /** The action it sets (none for `_read`). */
  actionKey: string | null;
}

export function readToolName(slug: string): string {
  return `${slug}_read`;
}

export function actionToolName(slug: string, key: string): string {
  return `${slug}_${key}`.slice(0, 64);
}

function valueSchema(profile: DeviceProfile, action: DeviceAction): JsonObject {
  const unit = actionUnit(profile, action);
  const describe = [action.description, unit ? `In ${unit}.` : ''].filter(Boolean).join(' ');
  if (action.valueType === 'boolean')
    return { type: 'boolean', description: describe || 'On (true) or off (false).' };
  if (action.valueType === 'choice') {
    const choices = action.choices ?? [];
    return {
      enum: choices.map((c) => c.value),
      description:
        `${describe} ${choices.map((c) => `${JSON.stringify(c.value)} = ${c.label}`).join(', ')}.`.trim(),
    };
  }
  return {
    type: 'number',
    ...(action.min !== undefined ? { minimum: action.min } : {}),
    ...(action.max !== undefined ? { maximum: action.max } : {}),
    ...(action.step !== undefined ? { multipleOf: action.step } : {}),
    description: describe,
  };
}

/** The tools a device connection gets from its profile (ONE-16): `_read`, then one per action. */
export function deviceToolDefinitions(profile: DeviceProfile, slug: string): DeviceToolDefinition[] {
  const keys = profile.readings.map((r) => r.key);
  const readings = profile.readings
    .map((r) => `${r.key} (${r.label}${r.unit ? `, ${r.unit}` : ''})`)
    .join(', ');
  const out: DeviceToolDefinition[] = [
    {
      name: readToolName(slug),
      description:
        `Reads ${profile.name} now: ${readings}`.slice(0, 950) +
        (readings.length > 900 ? '…' : '') +
        '. Leave keys out to read everything.',
      inputSchema: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { enum: keys }, description: 'Only these readings.' },
        },
        additionalProperties: false,
      },
      access: 'read',
      origin: 'device',
      actionKey: null,
    },
  ];
  for (const a of profile.actions)
    out.push({
      name: actionToolName(slug, a.key),
      description: `Sets ${a.label.toLowerCase()} on ${profile.name}. ${a.description}`.slice(0, 1000),
      inputSchema: {
        type: 'object',
        properties: { value: valueSchema(profile, a) },
        required: ['value'],
        additionalProperties: false,
      },
      access: 'write',
      origin: a.sensitive ? 'device-sensitive' : 'device',
      actionKey: a.key,
    });
  return out;
}
