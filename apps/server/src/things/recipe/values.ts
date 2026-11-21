/**
 * A page recipe's values (docs/decisions/connection-looks.md): finding one by its path in a read's answer, and writing it
 * in Whombat's words. Pure.
 */
import type { PageFormat, PageItemValue, PageToneRule } from '@whombat/core';
import { bytes, clip, span, thousands, when } from '../words';

/** Nothing at that path. */
export const MISSING: unique symbol = Symbol('missing');
export type Found = unknown | typeof MISSING;

/**
 * The value at `path` in `json`: keys and list positions joined by dots, `$` for the whole answer. A key holding dots
 * is found whole too (`"temp.c"`), so a service's own names work. A path into nothing is `MISSING`.
 */
export function valueAt(json: unknown, path: string): Found {
  if (path === '$') return json;
  return walk(json, path.split('.'));
}

function walk(at: unknown, parts: readonly string[]): Found {
  if (!parts.length) return at;
  if (at === null || typeof at !== 'object') return MISSING;
  // The longest run of parts that is one key wins: `{"a.b": 1}` answers `a.b`.
  for (let n = parts.length; n >= 1; n--) {
    const key = parts.slice(0, n).join('.');
    const next = Array.isArray(at)
      ? /^\d+$/.test(key)
        ? at[Number(key)]
        : key === 'length'
          ? at.length
          : undefined
      : Object.hasOwn(at, key)
        ? (at as Record<string, unknown>)[key]
        : undefined;
    if (next === undefined) continue;
    const found = walk(next, parts.slice(n));
    if (found !== MISSING) return found;
  }
  return MISSING;
}

/** A value as a number when it is one (numbers, numeric strings, true/false as 1/0). */
export function numberOf(v: Found): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** A date from an ISO string or seconds/milliseconds since 1970. */
function dateOf(v: Found): Date | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return dateOf(n);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function decimals(n: number): string {
  const a = Math.abs(n);
  if (a >= 100 || Number.isInteger(n)) return thousands(Math.round(n));
  if (a >= 10) return n.toFixed(1).replace(/\.0$/, '');
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** “2 h 5 min”, “45 s”. */
function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** The format a value gets when the recipe names none: a number's, a date's, or text. */
function guessed(v: Found): PageFormat {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'yesno';
  if (Array.isArray(v)) return 'count';
  return 'text';
}

/**
 * A value in words with its format and unit; null when there is nothing to say (missing, null, an object where words
 * were wanted).
 */
export function words(
  v: Found,
  shown: Pick<PageItemValue, 'format' | 'unit' | 'scale'>,
  now: Date,
  timeZone: string,
): string | null {
  if (v === MISSING || v === null || v === undefined) return null;
  const format = shown.format ?? guessed(v);
  const unit = shown.unit ? ` ${shown.unit}` : '';
  const scaled = (n: number) => n * (shown.scale ?? 1);
  switch (format) {
    case 'count': {
      const n = Array.isArray(v)
        ? v.length
        : typeof v === 'object'
          ? Object.keys(v as object).length
          : numberOf(v);
      return n === null ? null : `${thousands(n)}${unit}`;
    }
    case 'yesno': {
      if (typeof v === 'boolean') return v ? 'Yes' : 'No';
      const n = numberOf(v);
      if (n !== null) return n ? 'Yes' : 'No';
      if (typeof v === 'string')
        return /^(true|yes|on)$/i.test(v) ? 'Yes' : /^(false|no|off)$/i.test(v) ? 'No' : null;
      return null;
    }
    case 'date':
    case 'ago': {
      const d = dateOf(v);
      if (!d) return null;
      if (format === 'date') return when(d, now, timeZone);
      const ms = now.getTime() - d.getTime();
      return ms < 60_000 && ms > -60_000 ? 'Just now' : ms > 0 ? `${span(ms)} ago` : `In ${span(-ms)}`;
    }
    case 'number':
    case 'percent':
    case 'bytes':
    case 'duration': {
      const n = numberOf(v);
      if (n === null) return typeof v === 'string' ? clip(v, 60) : null;
      const x = scaled(n);
      if (format === 'percent') return `${decimals(x)} %`;
      if (format === 'bytes') return bytes(x);
      if (format === 'duration') return duration(x);
      return `${decimals(x)}${unit}`;
    }
    default: {
      if (typeof v === 'object') return null;
      const n = typeof v === 'number' ? scaled(v) : null;
      return `${clip(n !== null ? decimals(n) : String(v), 120)}${unit}`;
    }
  }
}

/** A value as a number for points and conditions, after its scale. */
export function scaledNumber(v: Found, shown: Pick<PageItemValue, 'scale'>): number | null {
  const n = numberOf(v);
  return n === null ? null : n * (shown.scale ?? 1);
}

const same = (a: unknown, b: string | number | boolean) =>
  a === b || (typeof a !== 'object' && String(a).toLowerCase() === String(b).toLowerCase());

/** The colour a tone rule gives an item or a line, from the value at its path. */
export function toneOf(json: unknown, rule: PageToneRule | undefined): 'bad' | 'warn' | null {
  if (!rule) return null;
  const v = valueAt(json, rule.at);
  if (v === MISSING) return null;
  if (rule.bad?.some((b) => same(v, b))) return 'bad';
  if (rule.warn?.some((w) => same(v, w))) return 'warn';
  return null;
}

/** Whether a warning's condition holds for a value. */
export function holds(
  v: Found,
  c: {
    above?: number;
    below?: number;
    equals?: string | number | boolean;
    not?: string | number | boolean;
    present?: true;
  },
  scale?: number,
): boolean {
  if (c.present) {
    if (v === MISSING || v === null || v === undefined || v === '' || v === false) return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }
  if (v === MISSING || v === null || v === undefined) return false;
  if (c.above !== undefined || c.below !== undefined) {
    const n = scaledNumber(v, { scale });
    if (n === null) return false;
    return c.above !== undefined ? n > c.above : n < (c.below as number);
  }
  if (c.equals !== undefined) return same(v, c.equals);
  if (c.not !== undefined) return !same(v, c.not);
  return false;
}
