import { formatLocaleOf, resolveLanguage } from './locale.js';

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

/** Formats a percentage with a non-breaking space before `%` (`85 %`, `12,4 %`). */
export function formatLocalePercent(value: number, localeTag?: string | null, fractionDigits = 0): string {
  const formatted = formatLocaleNumber(value, localeTag, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return `${formatted}\u00a0%`;
}

/** Formats byte counts using locale-appropriate decimal separators (`1.2 GB` / `1,2 GB`). */
export function formatLocaleBytes(bytes: number, localeTag?: string | null): string {
  const lang = resolveLanguage(localeTag);
  if (!Number.isFinite(bytes) || bytes < 0) return `0 ${lang === 'nl' ? 'B' : 'B'}`;
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
  const locale = formatLocaleOf(localeTag);
  const lang = resolveLanguage(localeTag);
  const word = type === 'disjunction' ? (lang === 'nl' ? 'of' : 'or') : lang === 'nl' ? 'en' : 'and';
  if (items.length === 2) return `${items[0]} ${word} ${items[1]}`;
  try {
    const ListFmt = (
      Intl as unknown as {
        ListFormat?: new (
          l: string,
          o: { style: string; type: string },
        ) => { format(a: readonly string[]): string };
      }
    ).ListFormat;
    if (typeof ListFmt === 'function') {
      return new ListFmt(locale, { style: 'long', type }).format(items);
    }
  } catch {
    // Fallback below.
  }
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
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
 * Returns null if the input is empty or not a finite number.
 */
export function parseLocaleNumber(raw: string): number | null {
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
    // Single comma or multiple commas: if exactly one comma with !=3 digits after or <=2 digits, treat as decimal.
    const parts = cleaned.split(',');
    if (parts.length === 2) {
      normalized = `${parts[0]}.${parts[1]}`;
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
