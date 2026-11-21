/**
 * Small pieces the network services' provisioners share (docs/decisions/connections-setup.md CS-30…CS-35): reading
 * answers defensively, the names Whombat gives what it makes (CS-06), and clean-up that never fails the call.
 */
import { type ProvisionResponse, refuseSignIn } from './types';

/** How many names (`Whombat`, `Whombat 2`, …) a provisioner tries before it gives up (CS-06). */
export const MAX_NAME_TRIES = 10;

/** The scheme, host and port of the base URL (UniFi signs in at the console's root, not under its API's path). */
export function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/** A header of an answer by name, any case; the first when sent more than once. */
export function headerOf(response: Pick<ProvisionResponse, 'headers'>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && first !== '') return first;
  }
  return null;
}

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The body as a JSON object, or null (not JSON, or an array or a scalar). */
export function jsonObject(response: Pick<ProvisionResponse, 'json'>): JsonObject | null {
  const body = response.json();
  return isObject(body) ? body : null;
}

/** A non-empty string at `key`, or null. */
export function stringAt(object: JsonObject | null | undefined, key: string): string | null {
  const value = object?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A number at `key` (or a string of digits), or null. */
export function numberAt(object: JsonObject | null | undefined, key: string): number | null {
  const value = object?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** The body's text, lower-cased, for matching a service's own wording (never shown to the person). */
export function bodyText(response: Pick<ProvisionResponse, 'text'>): string {
  try {
    return response.text().toLowerCase();
  } catch {
    return '';
  }
}

/** `yyyymmdd-hhmm` in UTC, the suffix of token names that must differ each time (Grafana, Forgejo). */
export function stamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}-${two(date.getUTCHours())}${two(date.getUTCMinutes())}`;
}

/** The name as an id: lower-case letters, digits and dashes (`Whombat (Home)` → `whombat-home`). */
export function idName(name: string): string {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || 'whombat';
}

/** The `n`th name to try (CS-06): the name itself, then `<name><separator>2`, `…3`. */
export function nthName(name: string, n: number, separator = ' '): string {
  return n <= 1 ? name : `${name}${separator}${n}`;
}

/** A code as typed, without spaces (“123 456”); null when there is none. */
export function cleanCode(code: string | null): string | null {
  const clean = code?.replace(/\s+/g, '') ?? '';
  return clean === '' ? null : clean;
}

/**
 * An answer the provisioner doesn't know: refused as `unsupported` so the form offers the guided token (CS-09). Only
 * the status is named, never the service's text.
 */
export function unexpectedAnswer(service: string, status: number, what = 'an API key') {
  return refuseSignIn(
    'unsupported',
    `${service} answered in a way Whombat doesn’t know (HTTP ${status}). Make ${what} by hand instead.`,
  );
}

/** Clean-up that must not fail the call: logging out after the key is made (or after a refusal). */
export async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    // The session ends on its own; nothing secret is in it after the call.
  }
}
