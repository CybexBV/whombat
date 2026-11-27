import { type DisplayLanguage, formatLocaleOf, type Language, resolveDisplayLanguage } from './locale.js';

export type MessageVars = Record<string, string | number>;

/** CLDR plural categories supported by `Intl.PluralRules`. */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** Declarative plural entry; `other` is always required, other categories depend on the locale. */
export type PluralMessage = Partial<Record<PluralCategory, string>> & { other: string };

/** Every catalog entry is plain declarative data (string or plural map), never a function. */
export type MessageValue = string | PluralMessage;
export type MessageCatalog = Record<string, MessageValue>;

/** Co-located per-package catalogs: English is required and complete; other locales fall back per key. */
export type LocaleCatalogs<T extends MessageCatalog> = {
  en: T;
} & Partial<Record<Language, Partial<Record<keyof T, MessageValue>>>>;

const pluralRulesCache = new Map<string, Intl.PluralRules | null>();

function getPluralRules(locale: string): Intl.PluralRules | null {
  if (pluralRulesCache.has(locale)) return pluralRulesCache.get(locale) ?? null;
  try {
    if (typeof Intl === 'undefined' || typeof Intl.PluralRules !== 'function') {
      pluralRulesCache.set(locale, null);
      return null;
    }
    const rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
    return rules;
  } catch {
    pluralRulesCache.set(locale, null);
    return null;
  }
}

/**
 * Selects the CLDR plural category for `count` in `locale`, using `Intl.PluralRules` when available
 * with a deterministic built-in fallback for stripped mobile JS runtimes.
 */
export function pluralCategory(locale: string, count: number): PluralCategory {
  const rules = getPluralRules(locale);
  if (rules) return rules.select(count) as PluralCategory;
  return count === 1 ? 'one' : 'other';
}

/** Replaces `{name}` placeholders with values from `vars`. */
export function interpolate(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

const PSEUDO_MAP: Record<string, string> = {
  A: 'À',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Î',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ḿ',
  N: 'Ñ',
  O: 'Ö',
  P: 'Ƥ',
  Q: 'Ǫ',
  R: 'Ř',
  S: 'Ŝ',
  T: 'Ţ',
  U: 'Û',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẍ',
  Y: 'Ý',
  Z: 'Ž',
  a: 'à',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'î',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ḿ',
  n: 'ñ',
  o: 'ö',
  p: 'ƥ',
  q: 'ǫ',
  r: 'ř',
  s: 'ŝ',
  t: 'ţ',
  u: 'û',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẍ',
  y: 'ý',
  z: 'ž',
};

/**
 * Transforms an English string into a pseudo-localized string (`[Ŝéţţîñĝš~~]`) with ~25% length padding
 * while preserving `{placeholders}` and `{{templates}}` verbatim so missed strings and overflows stand out.
 */
export function pseudoize(text: string): string {
  if (!text) return text;
  let out = '';
  let i = 0;
  let visibleChars = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      const close = text.indexOf('}', i + 1);
      if (close !== -1) {
        const end = text[close + 1] === '}' ? close + 2 : close + 1;
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }
    const ch = text[i] ?? '';
    out += PSEUDO_MAP[ch] ?? ch;
    visibleChars += 1;
    i += 1;
  }
  const pad = Math.max(1, Math.ceil(visibleChars * 0.2));
  return `[${out}${'~'.repeat(Math.min(pad, 12))}]`;
}

/** Extracts sorted unique `{placeholder}` names from a message value (for parity tests and tooling). */
export function extractPlaceholders(value: MessageValue): string[] {
  const strings =
    typeof value === 'string'
      ? [value]
      : Object.values(value).filter((s): s is string => typeof s === 'string');
  const set = new Set<string>();
  for (const s of strings) {
    for (const m of s.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
      if (m[1]) set.add(m[1]);
    }
  }
  return [...set].sort();
}

/** Canonical string serialization of a message value for deterministic source-hash staleness checks. */
export function serializeMessage(value: MessageValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key as PluralCategory];
    if (typeof v === 'string') ordered[key] = v;
  }
  return JSON.stringify(ordered);
}

/** Pure-TS 64-bit FNV-1a hex digest (16 hex chars) of a canonical English message, for staleness tracking. */
export function sourceHash(value: MessageValue): string {
  const str = serializeMessage(value);
  let h1 = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h1 ^= BigInt(str.charCodeAt(i));
    h1 = (h1 * prime) & mask;
  }
  return h1.toString(16).padStart(16, '0');
}

export type RichPart = { type: 'text'; value: string } | { type: 'slot'; name: string };

/** Splits a message template into text segments and `{slot}` tokens for framework-agnostic rich rendering. */
export function splitRichTemplate(template: string): RichPart[] {
  const parts: RichPart[] = [];
  let last = 0;
  for (const m of template.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ type: 'text', value: template.slice(last, idx) });
    if (m[1]) parts.push({ type: 'slot', name: m[1] });
    last = idx + m[0].length;
  }
  if (last < template.length) parts.push({ type: 'text', value: template.slice(last) });
  return parts;
}

export interface Translator<T extends MessageCatalog> {
  readonly language: DisplayLanguage;
  readonly locale: string;
  /** Translates a message key (string or plural when `vars.count` or `vars.n` is numeric). */
  t<K extends keyof T & string>(key: K, vars?: MessageVars): string;
  /** Translates a count-dependent plural message key using CLDR plural rules. */
  tp<K extends keyof T & string>(key: K, count: number, vars?: MessageVars): string;
  /** Looks up the raw template string (for rich React slot rendering), falling back to English. */
  raw<K extends keyof T & string>(key: K, count?: number): string;
}

function selectTemplate(entry: MessageValue, locale: string, count?: number): string {
  if (typeof entry === 'string') return entry;
  if (count === undefined) return entry.other;
  const cat = pluralCategory(locale, count);
  return entry[cat] ?? entry.other;
}

/** Creates a lightweight, zero-dependency translator bound to a package's co-located catalogs and locale. */
export function createTranslator<T extends MessageCatalog>(
  catalogs: LocaleCatalogs<T>,
  localeTag?: string | null,
): Translator<T> {
  const language = resolveDisplayLanguage(localeTag);
  const locale = formatLocaleOf(localeTag);
  const target = language === 'pseudo' || language === 'en' ? catalogs.en : catalogs[language];

  const resolveEntry = <K extends keyof T & string>(key: K): MessageValue => {
    const found = target?.[key];
    return found !== undefined ? found : catalogs.en[key];
  };

  const raw = <K extends keyof T & string>(key: K, count?: number): string => {
    const entry = resolveEntry(key);
    const tpl = selectTemplate(entry, locale, count);
    return language === 'pseudo' ? pseudoize(tpl) : tpl;
  };

  const t = <K extends keyof T & string>(key: K, vars?: MessageVars): string => {
    const count =
      typeof vars?.count === 'number' ? vars.count : typeof vars?.n === 'number' ? vars.n : undefined;
    return interpolate(raw(key, count), vars);
  };

  const tp = <K extends keyof T & string>(key: K, count: number, vars?: MessageVars): string => {
    const merged: MessageVars = { count, n: count, ...vars };
    return interpolate(raw(key, count), merged);
  };

  return { language, locale, t, tp, raw };
}
