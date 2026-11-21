/**
 * The built-in drivers (docs/decisions/one-whombat.md ONE-16): a device profile's readings and actions run here, never
 * as code an AI wrote. Modbus TCP through `modbus.ts`, local HTTP/JSON through the outbound helper under the
 * connections' destination rule. Every call checks the device's address first (`destination.ts`), runs one at a time
 * per device, and keeps to the profile's own ranges whatever else allows (the person's limits are checked before, in
 * `call.ts`).
 */

import { connectionPolicy } from '../connections/destination';
import { OutboundError, outboundRequest } from '../lib/outbound';
import type { Services } from '../services';
import { vaultNetOf } from '../vault/net';
import { DeviceDestinationError, deviceDialAddress } from './destination';
import { MODBUS_LIMITS, ModbusError, ModbusTcpClient } from './modbus';
import type {
  DeviceAction,
  DeviceAddress,
  DeviceChoice,
  DeviceProfile,
  DeviceReading,
  ModbusAddress,
} from './types';
import {
  atPointer,
  decodeRegisters,
  encodeRegisters,
  registersFor,
  tidy,
  ValueError,
  withPointer,
} from './values';

export type ReadingValue = number | boolean | string;

export interface ReadingResult {
  key: string;
  label: string;
  unit?: string;
  /** The value as read (scaled), or null when this one couldn't be read. */
  value: ReadingValue | null;
  /** How a person reads it: “21.0 °C”, “Heating”, “On”. */
  text: string;
  /** What it was read from: the register words (“16281 39322”), the bit, or the JSON at the pointer. */
  raw?: string;
  /** Why it couldn't be read. */
  error?: string;
}

/** A device call that didn't work, in a sentence for the agent and the person. */
export class DeviceCallError extends Error {
  constructor(
    readonly reason: 'destination' | 'unreachable' | 'timeout' | 'refused' | 'invalid' | 'protocol',
    message: string,
  ) {
    super(message);
    this.name = 'DeviceCallError';
  }
}

export const DEVICE_TIMEOUT_MS = 3000;
export const DEVICE_HTTP_MAX_BYTES = 256 * 1024;
/** Registers read together at most, and the widest gap bridged between two readings. */
const BATCH_WORDS = 64;
const BATCH_GAP = 8;

/* One device at a time ------------------------------------------------------------------------------ */

const locks = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(run);
  const tail = mine.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await mine;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/* Words ---------------------------------------------------------------------------------------------- */

function decimalsOf(scale: number | undefined): number {
  if (!scale || scale >= 1) return 0;
  return Math.min(4, Math.max(0, Math.round(-Math.log10(scale))));
}

function withUnit(text: string, unit?: string): string {
  if (!unit) return text;
  return unit === '%' ? `${text}%` : `${text} ${unit}`;
}

function choiceLabel(choices: readonly DeviceChoice[] | undefined, value: ReadingValue): string | null {
  const hit = choices?.find(
    (c) => c.value === value || (typeof c.value === 'number' && Number(value) === c.value),
  );
  return hit?.label ?? null;
}

/** How a person reads a value: decimals from the scale (0.1 → one), On/Off, a choice's words, the unit. */
export function readingText(
  reading: Pick<DeviceReading, 'unit' | 'modbus'> & { choices?: readonly DeviceChoice[] | undefined },
  value: ReadingValue | null,
): string {
  if (value === null) return '—';
  const label = choiceLabel(reading.choices, value);
  if (label) return label;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') {
    const decimals =
      // A float or a JSON number: its own decimals, at most two; a scaled register: the scale's (0.1 → one).
      !reading.modbus || (reading.modbus.type === 'f32' && reading.modbus.scale === undefined)
        ? Number.isInteger(value)
          ? 0
          : Math.min(2, String(tidy(value)).split('.')[1]?.length ?? 0)
        : decimalsOf(reading.modbus?.scale);
    return withUnit(value.toFixed(decimals).replace('-', '−'), reading.unit);
  }
  return withUnit(value.slice(0, 80), reading.unit);
}

/* Errors --------------------------------------------------------------------------------------------- */

function fromModbus(err: unknown): DeviceCallError {
  if (err instanceof DeviceCallError) return err;
  if (err instanceof DeviceDestinationError) return new DeviceCallError('destination', err.message);
  if (err instanceof ValueError) return new DeviceCallError('invalid', err.message);
  if (err instanceof ModbusError) {
    switch (err.reason) {
      case 'timeout':
        return new DeviceCallError('timeout', 'The device didn’t answer in time.');
      case 'unreachable':
        return new DeviceCallError('unreachable', 'Couldn’t reach the device.');
      case 'closed':
        return new DeviceCallError('unreachable', 'The device closed the connection.');
      case 'exception':
        return new DeviceCallError('refused', err.message);
      case 'invalid':
        return new DeviceCallError('invalid', err.message);
      default:
        return new DeviceCallError('protocol', 'The device doesn’t answer like a Modbus device.');
    }
  }
  return new DeviceCallError('protocol', 'The device didn’t answer as expected.');
}

function fromHttp(err: unknown): DeviceCallError {
  if (err instanceof DeviceCallError) return err;
  if (err instanceof DeviceDestinationError) return new DeviceCallError('destination', err.message);
  if (err instanceof ValueError) return new DeviceCallError('invalid', err.message);
  if (err instanceof OutboundError) {
    if (err.refused)
      return new DeviceCallError(
        'destination',
        'This device’s address isn’t allowed. Check the local network settings.',
      );
    if (err.reason === 'timeout') return new DeviceCallError('timeout', 'The device didn’t answer in time.');
    if (err.reason === 'too_large')
      return new DeviceCallError('protocol', 'The device’s answer was too large.');
    if (err.reason === 'untrusted_certificate')
      return new DeviceCallError('protocol', 'The device’s certificate isn’t trusted.');
    return new DeviceCallError('unreachable', 'Couldn’t reach the device.');
  }
  return new DeviceCallError('protocol', 'The device didn’t answer as expected.');
}

/* Modbus --------------------------------------------------------------------------------------------- */

async function withModbus<T>(
  services: Services,
  address: DeviceAddress,
  run: (client: ModbusTcpClient) => Promise<T>,
): Promise<T> {
  const dial = await deviceDialAddress(services, address.host, address.port, 'call').catch((err: unknown) => {
    throw fromModbus(err);
  });
  const timeoutMs = vaultNetOf(services).deviceTimeoutMs ?? DEVICE_TIMEOUT_MS;
  return oneAtATime(`${dial}:${address.port}`, async () => {
    let client: ModbusTcpClient | null = null;
    try {
      client = await ModbusTcpClient.connect({
        host: dial,
        port: address.port,
        unitId: address.unitId ?? 1,
        timeoutMs,
        connectTimeoutMs: timeoutMs,
      });
      return await run(client);
    } catch (err) {
      throw fromModbus(err);
    } finally {
      client?.close();
    }
  });
}

interface Span {
  table: ModbusAddress['table'];
  start: number;
  count: number;
  readings: DeviceReading[];
}

/** Readings of one table close together, read in one request (gaps up to 8 registers bridged). */
export function modbusSpans(readings: readonly DeviceReading[]): Span[] {
  const sorted = readings
    .filter((r) => r.modbus)
    .sort((a, b) => {
      const x = a.modbus as ModbusAddress;
      const y = b.modbus as ModbusAddress;
      return x.table.localeCompare(y.table) || x.address - y.address;
    });
  const spans: Span[] = [];
  for (const r of sorted) {
    const m = r.modbus as ModbusAddress;
    const bits = m.table === 'coil' || m.table === 'discrete';
    const size = bits ? 1 : registersFor(m.type);
    const last = spans[spans.length - 1];
    const end = m.address + size;
    if (
      last &&
      last.table === m.table &&
      m.address <= last.start + last.count + BATCH_GAP &&
      end - last.start <= (bits ? MODBUS_LIMITS.readBits : BATCH_WORDS)
    ) {
      last.count = Math.max(last.count, end - last.start);
      last.readings.push(r);
    } else spans.push({ table: m.table, start: m.address, count: size, readings: [r] });
  }
  return spans;
}

/** A reading's value from a span's values, and the raw words it came from (“210”, “16281 39322”, “1”). */
function decodeAt(
  r: DeviceReading,
  start: number,
  values: readonly (number | boolean)[],
): { value: ReadingValue; raw: string } {
  const m = r.modbus as ModbusAddress;
  const at = m.address - start;
  if (m.table === 'coil' || m.table === 'discrete') {
    const bit = Boolean(values[at]);
    return { value: bit, raw: bit ? '1' : '0' };
  }
  const words = values.slice(at, at + registersFor(m.type)) as number[];
  const value = decodeRegisters(words, m.type, {
    ...(m.wordOrder ? { wordOrder: m.wordOrder } : {}),
    ...(m.scale !== undefined ? { scale: m.scale } : {}),
  });
  return { value, raw: words.join(' ') };
}

/** A reading with the words for its coded values: its own, else the choices of the action of the same key. */
type WordedReading = DeviceReading;

function result(r: WordedReading, value: ReadingValue | null, error?: string, raw?: string): ReadingResult {
  return {
    key: r.key,
    label: r.label,
    ...(r.unit ? { unit: r.unit } : {}),
    value,
    text: readingText(r, value),
    ...(raw !== undefined ? { raw: raw.slice(0, 200) } : {}),
    ...(error ? { error } : {}),
  };
}

function decoded(r: WordedReading, start: number, values: readonly (number | boolean)[]): ReadingResult {
  const { value, raw } = decodeAt(r, start, values);
  return result(r, value, undefined, raw);
}

async function readModbus(
  client: ModbusTcpClient,
  readings: readonly DeviceReading[],
): Promise<ReadingResult[]> {
  const out = new Map<string, ReadingResult>();
  for (const span of modbusSpans(readings)) {
    try {
      const values = await client.read(span.table, span.start, span.count);
      for (const r of span.readings) out.set(r.key, decoded(r, span.start, values));
    } catch (err) {
      // A span over registers the device doesn't have: each reading on its own, so the rest still reads.
      if (!(err instanceof ModbusError) || err.reason !== 'exception' || span.readings.length === 1) {
        if (err instanceof ModbusError && (err.reason === 'closed' || err.reason === 'timeout')) throw err;
        for (const r of span.readings) out.set(r.key, result(r, null, fromModbus(err).message));
        continue;
      }
      for (const r of span.readings) {
        const m = r.modbus as ModbusAddress;
        const size = m.table === 'coil' || m.table === 'discrete' ? 1 : registersFor(m.type);
        try {
          const values = await client.read(m.table, m.address, size);
          out.set(r.key, decoded(r, m.address, values));
        } catch (one) {
          if (one instanceof ModbusError && (one.reason === 'closed' || one.reason === 'timeout')) throw one;
          out.set(r.key, result(r, null, fromModbus(one).message));
        }
      }
    }
  }
  return readings.map((r) => out.get(r.key) ?? result(r, null, 'This one has no Modbus address.'));
}

/* HTTP/JSON ------------------------------------------------------------------------------------------ */

function httpBase(address: DeviceAddress): string {
  const scheme = address.port === 443 ? 'https' : 'http';
  const host =
    address.host.includes(':') && !address.host.startsWith('[') ? `[${address.host}]` : address.host;
  const base = (address.basePath ?? '').replace(/\/+$/, '');
  return `${scheme}://${host}:${address.port}${base}`;
}

function joinPath(base: string, path: string): string {
  if (!path.startsWith('/') || path.includes('..') || /[\s#]/.test(path))
    throw new DeviceCallError('invalid', `${path} isn’t a usable path on the device.`);
  return `${base}${path}`;
}

async function httpSend(
  services: Services,
  address: DeviceAddress,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  try {
    // The address is checked as a device's (local network only), then the request goes under the connections' rule.
    await deviceDialAddress(services, address.host, address.port, 'call');
    const base = httpBase(address);
    const url = joinPath(base, path);
    const policy = await connectionPolicy(services, `${base}/`, {
      maxBytes: DEVICE_HTTP_MAX_BYTES,
      deadlineMs: 10_000,
    });
    const res = await oneAtATime(`http ${address.host}:${address.port}`, () =>
      outboundRequest(
        url,
        {
          method,
          headers: {
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
        policy,
      ),
    );
    let json: unknown = null;
    const text = res.body.toString('utf8');
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        if (method === 'GET') throw new DeviceCallError('protocol', 'The device didn’t answer with JSON.');
      }
    }
    return { status: res.status, json };
  } catch (err) {
    throw fromHttp(err);
  }
}

function jsonValue(v: unknown): ReadingValue | null {
  if (typeof v === 'number' && Number.isFinite(v)) return tidy(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, 200);
  return null;
}

async function readHttp(
  services: Services,
  address: DeviceAddress,
  readings: readonly WordedReading[],
): Promise<ReadingResult[]> {
  const byPath = new Map<string, Promise<{ status: number; json: unknown }>>();
  const out: ReadingResult[] = [];
  for (const r of readings) {
    if (!r.http) {
      out.push(result(r, null, 'This one has no HTTP path.'));
      continue;
    }
    const path = r.http.path;
    let answer = byPath.get(path);
    if (!answer) {
      answer = httpSend(services, address, 'GET', path);
      byPath.set(path, answer);
    }
    try {
      const { status, json } = await answer;
      if (status < 200 || status > 299) {
        out.push(result(r, null, `The device answered ${status}.`));
        continue;
      }
      const raw = atPointer(json, r.http.pointer);
      const value = jsonValue(raw);
      const rawText = raw === undefined ? undefined : JSON.stringify(raw);
      out.push(
        value === null
          ? result(r, null, 'That value isn’t in the device’s answer.', rawText)
          : result(r, value, undefined, rawText),
      );
    } catch (err) {
      const e = fromHttp(err);
      if (e.reason === 'destination' || e.reason === 'unreachable' || e.reason === 'timeout') throw e;
      out.push(result(r, null, e.message));
    }
  }
  return out;
}

/* Reading -------------------------------------------------------------------------------------------- */

/**
 * Reads the profile's readings (all, or those named): each with its value and words, or why it couldn't be read. A
 * device that can't be reached at all throws `DeviceCallError`.
 */
export async function readDevice(
  services: Services,
  profile: Pick<DeviceProfile, 'driver' | 'readings'> & { actions?: readonly DeviceAction[] },
  address: DeviceAddress,
  keys?: readonly string[],
): Promise<ReadingResult[]> {
  const picked = keys ? profile.readings.filter((r) => keys.includes(r.key)) : profile.readings;
  // A reading's own words for its codes first (contracts 0.80.1, CT-345), else the action of the same key's.
  const readings: WordedReading[] = picked.map((r) => {
    if (r.choices?.length) return r;
    const choices = profile.actions?.find((a) => a.key === r.key)?.choices;
    return choices?.length ? { ...r, choices } : r;
  });
  if (readings.length === 0) return [];
  if (profile.driver === 'modbus_tcp') return withModbus(services, address, (c) => readModbus(c, readings));
  return readHttp(services, address, readings);
}

/* Actions -------------------------------------------------------------------------------------------- */

/** Why `value` doesn't fit the action as the profile describes it (its type, range, steps, choices), or null. */
export function actionValueProblem(action: DeviceAction, value: unknown): string | null {
  if (action.valueType === 'boolean')
    return typeof value === 'boolean' ? null : `${action.label} is on or off.`;
  if (action.valueType === 'choice') {
    const ok = action.choices?.some((c) => c.value === value);
    return ok ? null : `${action.label} is one of: ${(action.choices ?? []).map((c) => c.label).join(', ')}.`;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${action.label} is a number.`;
  if ((action.min !== undefined && value < action.min) || (action.max !== undefined && value > action.max))
    return `${action.label} goes from ${action.min ?? '…'} to ${action.max ?? '…'} on this device.`;
  if (action.step !== undefined && action.step > 0) {
    const steps = (value - (action.min ?? 0)) / action.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) return `${action.label} goes in steps of ${action.step}.`;
  }
  return null;
}

async function writeModbus(client: ModbusTcpClient, m: ModbusAddress, value: number | boolean | string) {
  if (m.table === 'coil') {
    if (typeof value !== 'boolean' && typeof value !== 'number')
      throw new DeviceCallError('invalid', 'A coil is on or off.');
    return client.writeSingleCoil(m.address, Boolean(value));
  }
  if (m.table !== 'holding') throw new DeviceCallError('invalid', 'That register can only be read.');
  const v = m.type === 'bool' ? Boolean(value) : typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  const words = encodeRegisters(v, m.type, {
    ...(m.wordOrder ? { wordOrder: m.wordOrder } : {}),
    ...(m.scale !== undefined ? { scale: m.scale } : {}),
  });
  if (words.length === 1) return client.writeSingleRegister(m.address, words[0] as number);
  return client.writeMultipleRegisters(m.address, words);
}

/** Sets an action's value on the device (checked against the profile first). Throws `DeviceCallError`. */
export async function writeDeviceAction(
  services: Services,
  profile: Pick<DeviceProfile, 'driver'>,
  address: DeviceAddress,
  action: DeviceAction,
  value: number | boolean | string,
): Promise<void> {
  const problem = actionValueProblem(action, value);
  if (problem) throw new DeviceCallError('invalid', problem);
  if (profile.driver === 'modbus_tcp') {
    const m = action.modbus;
    if (!m) throw new DeviceCallError('invalid', `${action.label} has no Modbus address.`);
    await withModbus(services, address, (c) => writeModbus(c, m, value));
    return;
  }
  const h = action.http;
  if (!h) throw new DeviceCallError('invalid', `${action.label} has no HTTP path.`);
  let body: unknown;
  try {
    body = h.valuePointer !== undefined ? withPointer(h.body ?? {}, h.valuePointer, value) : value;
  } catch (err) {
    throw fromHttp(err);
  }
  const res = await httpSend(services, address, h.method, h.path, body);
  if (res.status < 200 || res.status > 299)
    throw new DeviceCallError('refused', `The device answered ${res.status}.`);
}

/**
 * An action's value on the device now (to undo a change), or null when Whombat can't read it back: the reading of the
 * same key, else (Modbus) the action's own register.
 */
export async function readActionValue(
  services: Services,
  profile: Pick<DeviceProfile, 'driver' | 'readings' | 'actions'>,
  address: DeviceAddress,
  action: DeviceAction,
): Promise<ReadingValue | null> {
  const same = profile.readings.find((r) => r.key === action.key);
  const reading: DeviceReading | null = same
    ? same
    : profile.driver === 'modbus_tcp' && action.modbus
      ? { key: action.key, label: action.label, modbus: action.modbus }
      : null;
  if (!reading) return null;
  const [read] = await readDevice(
    services,
    { driver: profile.driver, readings: [reading], actions: profile.actions },
    address,
  );
  return read?.value ?? null;
}
