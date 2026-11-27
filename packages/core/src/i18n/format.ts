import { coreTranslator } from './catalog.js';
import { formatLocaleOf, resolveDisplayLanguage, resolveLanguage } from './locale.js';

/** Formats a number using the resolved BCP-47 locale (`en-GB` or `nl-NL`), falling back cleanly if Intl fails. */
export function formatLocaleNumber(
  value: number,
  localeTag?: string | null,
  options?: Intl.NumberFormatOptions,
): string {
  const locale = formatLocaleOf(localeTag);
  try {
    return new Intl.NumberFormat(locale, options).format(value);
  } catch {
    return String(value);
  }
}

/** Formats percentage points in the locale's percent style (`85%`, `12,4%`). */
export function formatLocalePercent(value: number, localeTag?: string | null, fractionDigits = 0): string {
  try {
    return new Intl.NumberFormat(formatLocaleOf(localeTag), {
      style: 'percent',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value / 100);
  } catch {
    return `${value}%`;
  }
}

/** Formats byte counts using locale-appropriate decimal separators (`1.2 GB` / `1,2 GB`). */
export function formatLocaleBytes(bytes: number, localeTag?: string | null): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'] as const;
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${formatLocaleNumber(value, localeTag, { maximumFractionDigits: digits })} ${units[idx]}`;
}

/**
 * Formats integer cents in EUR or USD consistently in the active locale:
 * - Dutch (`nl-NL`): `€1.234,56` / `€25` (or `$1.234,56`)
 * - English (`en-GB`): `€1,234.56` / `€25` (or `$1,234.56`)
 */
export function formatLocaleCurrency(
  cents: number,
  currency: 'EUR' | 'USD',
  localeTag?: string | null,
  options?: { trimWhole?: boolean; space?: boolean },
): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = options?.trimWhole && abs % 100 === 0;
  const amount = abs / 100;
  const num = formatLocaleNumber(amount, localeTag, {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
  const symbol = currency === 'EUR' ? '€' : '$';
  const sep = options?.space ? '\u00a0' : '';
  return `${negative ? '−' : ''}${symbol}${sep}${num}`;
}

/** Formats a list with conjunction (`and`/`en`) or disjunction (`or`/`of`), with Hermes-safe fallback. */
export function formatLocaleList(
  items: readonly string[],
  localeTag?: string | null,
  type: 'conjunction' | 'disjunction' = 'conjunction',
): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  try {
    if (resolveDisplayLanguage(localeTag) !== 'pseudo' && typeof Intl.ListFormat === 'function') {
      return new Intl.ListFormat(formatLocaleOf(localeTag), { style: 'long', type }).format(items);
    }
  } catch {
    // Fallback below.
  }
  return coreTranslator(localeTag).t(`format.list.${type}`, {
    head: items.slice(0, -1).join(', '),
    last: items.at(-1) ?? '',
  });
}

/** Formats an ISO 3166-1 country/region code (`NL`, `DE`, `US`) in the active locale with safe fallback. */
export function formatLocaleRegion(code: string, localeTag?: string | null): string {
  const upper = code.trim().toUpperCase();
  if (!upper) return '';
  const locale = formatLocaleOf(localeTag);
  try {
    const Display = (
      Intl as unknown as {
        DisplayNames?: new (l: string[], o: { type: string }) => { of(c: string): string | undefined };
      }
    ).DisplayNames;
    if (typeof Display === 'function') {
      return new Display([locale], { type: 'region' }).of(upper) ?? upper;
    }
  } catch {
    // Fallback below.
  }
  return upper;
}

/** Locale-aware string comparison (handles Dutch sorting cleanly), falling back to standard compare. */
export function compareLocaleText(a: string, b: string, localeTag?: string | null): number {
  const locale = formatLocaleOf(localeTag);
  try {
    return new Intl.Collator(locale, { sensitivity: 'base', numeric: true }).compare(a, b);
  } catch {
    return a.localeCompare(b);
  }
}

/**
 * Parses a decimal number typed in either dot or comma style (`"90.5"`, `"90,5"`, `"1.234,56"`, `"1,234.56"`).
 * A single comma before three digits is thousands grouping when one to three digits (not starting with 0) come
 * before it, unless the caller specifies Dutch.
 * Returns null if the input is empty or not a finite number.
 */
export function parseLocaleNumber(raw: string, locale?: string | null): number | null {
  const cleaned = raw
    .trim()
    .replace(/\u00a0|\s+/g, '')
    .replace(/^−/, '-');
  if (!cleaned) return null;
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let normalized = cleaned;
  if (lastDot !== -1 && lastComma !== -1) {
    // Whichever appears last is the decimal separator; the other is thousands grouping.
    normalized =
      lastComma > lastDot ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const parts = cleaned.split(',');
    if (parts.length === 2) {
      const [whole, fraction] = parts;
      // “1,234” groups thousands in English, but “0,005” and “1000,500” can only be decimals.
      const grouping =
        /^[0-9]{3}$/.test(fraction ?? '') &&
        /^-?[1-9]\d{0,2}$/.test(whole ?? '') &&
        resolveLanguage(locale) !== 'nl';
      normalized = `${whole}${grouping ? '' : '.'}${fraction}`;
    } else if (parts.every((p, i) => (i === 0 ? /^-?\d{1,3}$/.test(p) : /^\d{3}$/.test(p)))) {
      normalized = parts.join('');
    } else {
      return null;
    }
  } else if (lastDot !== -1) {
    const parts = cleaned.split('.');
    if (parts.length > 2) {
      if (parts.every((p, i) => (i === 0 ? /^-?\d{1,3}$/.test(p) : /^\d{3}$/.test(p)))) {
        normalized = parts.join('');
      } else {
        return null;
      }
    }
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
