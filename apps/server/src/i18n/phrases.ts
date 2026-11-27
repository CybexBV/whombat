/**
 * Words the server already wrote in English, said in the reader's language on the way out.
 *
 * Most of what the server renders is built with keyed messages (`tServer`). Some of it is written deep in code that
 * builds a service's page or glance, or was stored as English before languages existed (a connection's glance line,
 * a page's panel titles). For those, the catalog's `phrase.*` messages double as a phrasebook: each English template
 * (`Part of {server}`) is matched against a finished string and, when it matches, the same message in the reader's
 * language is filled with what it captured. A string nobody listed stays English, so a missed phrase is never wrong,
 * only untranslated. Matching never touches what a page marks as machine data (ids, keys, privacy flags, links).
 */
import { formatLocaleNumber, type MessageValue } from '@whombat/core/i18n';
import { EN, isEnglish, type ServerMessageKey, serverTranslator } from './catalog';

interface Pattern {
  key: ServerMessageKey;
  re: RegExp;
  names: string[];
  /** How many fixed characters the template has: longer templates are more specific and match first. */
  weight: number;
  /** The template held a plural form: its count is captured as a number. */
  counted: boolean;
}

interface Book {
  exact: Map<string, ServerMessageKey>;
  patterns: Pattern[];
}

/** The messages that make up the phrasebook. */
const PHRASE_PREFIXES = ['phrase.', 'things.page.'];
const SLOT = /\{(\w+)\}/g;
/** Whether a template has a slot (not global: a global pattern would carry its position from one test to the next). */
const HAS_SLOT = /\{\w+\}/;

let book: Book | null = null;

/** Slots that hold a count: they capture only a number, and the reader's language writes it its own way. */
const COUNT_SLOTS = new Set(['n', 'count']);
/** Slots that hold an amount (“1.2 GB”, “40”): a number with an optional unit, never words. */
const SIZE_SLOTS = new Set(['size', 'used', 'total']);
const NUMBER = '(\\d[\\d.,]*)';
const SIZE = '(\\d[\\d.,]*(?:\\s?(?:[KMGTPE]i?B|B|bytes?))?)';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formsOf(value: MessageValue): string[] {
  if (typeof value === 'string') return [value];
  return [...new Set(Object.values(value).filter((v): v is string => typeof v === 'string'))];
}

function compile(key: ServerMessageKey, template: string, counted: boolean): Pattern | null {
  const names: string[] = [];
  let source = '';
  let last = 0;
  let weight = 0;
  for (const m of template.matchAll(SLOT)) {
    const literal = template.slice(last, m.index);
    source += escapeRegExp(literal);
    weight += literal.length;
    const name = m[1] ?? '';
    // The same slot twice must say the same thing.
    const seen = names.indexOf(name);
    if (seen >= 0) source += `\\${seen + 1}`;
    else {
      names.push(name);
      source += COUNT_SLOTS.has(name) ? NUMBER : SIZE_SLOTS.has(name) ? SIZE : '(.+?)';
    }
    last = (m.index ?? 0) + m[0].length;
  }
  const tail = template.slice(last);
  source += escapeRegExp(tail);
  weight += tail.length;
  if (names.length === 0) return null;
  // A template that is all slots would match anything.
  if (weight < 3) return null;
  return { key, re: new RegExp(`^${source}$`, 's'), names, weight, counted };
}

function phrasebook(): Book {
  if (book) return book;
  const exact = new Map<string, ServerMessageKey>();
  const patterns: Pattern[] = [];
  for (const [key, value] of Object.entries(EN) as [ServerMessageKey, MessageValue][]) {
    if (!PHRASE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    const counted = typeof value !== 'string';
    for (const form of formsOf(value)) {
      if (!HAS_SLOT.test(form)) {
        if (!exact.has(form)) exact.set(form, key);
      } else {
        const p = compile(key, form, counted);
        if (p) patterns.push(p);
      }
    }
  }
  patterns.sort((a, b) => b.weight - a.weight);
  book = { exact, patterns };
  return book;
}

function countOf(raw: string): number {
  const n = Number(raw.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** An English number (with its unit, when it has one) written the way the reader's language writes it. */
function numberIn(raw: string, locale: string): string {
  const m = /^(\d[\d.,]*)(.*)$/s.exec(raw);
  if (!m) return raw;
  const digits = m[1] ?? '';
  const n = countOf(digits);
  const decimals = /\.(\d{1,2})$/.exec(digits)?.[1]?.length ?? 0;
  const said = formatLocaleNumber(n, locale, { maximumFractionDigits: decimals });
  return `${said}${m[2] ?? ''}`;
}

/** One whole string, by an exact phrase or a template; null when the book has nothing for it. */
function whole(text: string, locale: string): string | null {
  const tr = serverTranslator(locale);
  const { exact, patterns } = phrasebook();
  const key = exact.get(text);
  if (key) return tr.t(key);
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (!m) continue;
    const vars: Record<string, string | number> = {};
    let count: number | undefined;
    p.names.forEach((name, i) => {
      const captured = m[i + 1] ?? '';
      if (COUNT_SLOTS.has(name) && /^\d/.test(captured)) {
        count = countOf(captured);
        vars[name] = numberIn(captured, locale);
      } else if (SIZE_SLOTS.has(name) && /^\d/.test(captured)) {
        vars[name] = numberIn(captured, locale);
      } else {
        // What a slot holds may itself be a known word (“Look into it · {what}”).
        const known = exact.get(captured);
        vars[name] = known ? tr.t(known) : captured;
      }
    });
    if (p.counted && count !== undefined) return tr.tp(p.key, count, vars);
    return tr.t(p.key, vars);
  }
  return null;
}

/**
 * A finished English string in `locale`: the whole of it when the phrasebook knows it, else each part between ` · `
 * on its own, else as it was. English locales get it back untouched.
 */
export function localizePhrase(text: string, locale: string | null | undefined): string {
  if (!text || isEnglish(locale)) return text;
  const own = whole(text, locale ?? '');
  if (own !== null) return own;
  if (text.includes(' · ')) {
    const parts = text.split(' · ');
    let changed = false;
    const said = parts.map((part) => {
      const found = whole(part, locale ?? '');
      if (found === null) return part;
      changed = true;
      return found;
    });
    if (changed) return said.join(' · ');
  }
  // A sentence followed by more (“Disk is full. Free up space.”): each sentence on its own.
  if (/[.!?]\s/.test(text)) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    if (sentences.length > 1) {
      let changed = false;
      const said = sentences.map((s) => {
        const found = whole(s, locale ?? '');
        if (found === null) return s;
        changed = true;
        return found;
      });
      if (changed) return said.join(' ');
    }
  }
  return text;
}

/**
 * Fields that carry machine data, never words: ids, links, keys, the figures' privacy flags and what kind of state
 * they are. A walk over a page leaves them (and what they hold) exactly as they were. Containers of words (a page's
 * tabs, a chart's series, the assistant's research, suggestion chips) are never listed: what they hold is walked, and
 * only their own machine fields stay.
 */
const MACHINE_FIELDS = new Set([
  'id',
  'ids',
  'href',
  'url',
  'src',
  'icon',
  'logo',
  'kind',
  'key',
  'itemKey',
  'figureKey',
  'stateKind',
  'role',
  'private',
  'place',
  'layout',
  'style',
  'tone',
  'status',
  'severity',
  'nature',
  'check',
  'subject',
  'thing',
  'catalogId',
  'ref',
  'at',
  'until',
  'since',
  'from',
  'to',
  'range',
  'ranges',
  'unit',
  'name',
  'entityId',
  'domain',
  'service',
  'tool',
  'args',
  'params',
  'action',
  'command',
  'values',
  'points',
  'color',
  'colour',
  'format',
  'mime',
  'path',
  'image',
  'version',
  'account',
  'email',
  'address',
  'host',
  'serverId',
  'connectionId',
  'deviceId',
  'tab',
  'refreshS',
  'generatedAt',
  'charts',
  'timestamps',
  'current',
  'target',
  'tier',
  'dot',
  'axis',
  'look',
  'width',
  'shape',
  'how',
  'source',
  'guestId',
  'changeId',
  'thingId',
  'proposalId',
  'conversationId',
  'threadRootId',
  'refreshSec',
]);

/**
 * The most characters a word field may hold, by its name: the tightest any page shape allows, so a longer translation
 * never breaks a shape's limit. A field not listed may grow no longer than its English.
 */
const FIELD_MAX: Readonly<Record<string, number>> = {
  label: 30,
  button: 30,
  title: 60,
  detail: 200,
  body: 300,
  sub: 80,
  note: 40,
  noteEnd: 60,
  right: 40,
  rest: 40,
  latest: 40,
  text: 120,
  alt: 120,
  value: 20,
  state: 60,
  short: 60,
  help: 200,
  hint: 200,
  reason: 160,
  line: 160,
  words: 60,
  empty: 120,
  caption: 120,
  question: 300,
  questions: 200,
  suggestions: 60,
  labels: 12,
  summary: 240,
  plan: 120,
  fix: 32,
};

function fits(
  field: string | null,
  english: string,
  said: string,
  limits: Readonly<Record<string, number>>,
): boolean {
  if (said.length <= english.length) return true;
  const max = field ? (limits[field] ?? FIELD_MAX[field]) : undefined;
  return max !== undefined && said.length <= max;
}

export interface LocalizeTreeOptions {
  /** Fields of machine data, left as they are (`MACHINE_DATA_FIELDS` when absent). */
  keep?: ReadonlySet<string>;
  /** Field limits of this shape, over the tightest ones every page shape shares. */
  max?: Readonly<Record<string, number>>;
}

/**
 * A copy of a finished tree (a service's page, a glance, a desk view) with every word field said in `locale`. Fields of
 * machine data stay as they were, and so does a button's or a choice's `value` (what it sends back); a translation
 * longer than its field allows stays English. English gets the tree back as it is.
 */
export function localizeTree<T>(
  tree: T,
  locale: string | null | undefined,
  options: LocalizeTreeOptions = {},
): T {
  if (isEnglish(locale)) return tree;
  const keep = options.keep ?? MACHINE_FIELDS;
  const limits = options.max ?? {};
  const walk = (value: unknown, field: string | null, machineValue: boolean): unknown => {
    if (typeof value === 'string') {
      if (field !== null && keep.has(field)) return value;
      if (field === 'value' && machineValue) return value;
      const said = localizePhrase(value, locale);
      return fits(field, value, said, limits) ? said : value;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, field, field === 'choices'));
    if (value && typeof value === 'object') {
      if (field !== null && keep.has(field)) return value;
      const obj = value as Record<string, unknown>;
      // A button (it says whether it is allowed) or a choice sends its value back: never a word.
      const sends = machineValue || typeof obj.allowed === 'boolean' || 'target' in obj;
      const out: Record<string, unknown> = {};
      // A table's cells are keyed by column, not by field: a column called `status` still holds words.
      for (const [k, v] of Object.entries(obj)) out[k] = walk(v, field === 'cells' ? null : k, sends);
      return out;
    }
    return value;
  };
  return walk(tree, null, false) as T;
}

/** The fields `localizeTree` keeps as they are, for a caller that needs a few more (or fewer). */
export const MACHINE_DATA_FIELDS: ReadonlySet<string> = MACHINE_FIELDS;

/** `MACHINE_DATA_FIELDS` with a few more. */
export function keepFields(...more: string[]): ReadonlySet<string> {
  return new Set([...MACHINE_FIELDS, ...more]);
}
