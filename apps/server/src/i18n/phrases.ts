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
  /** Open slots that must look like a name (see `looksLikeName`). */
  guarded: Set<string>;
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

/**
 * What each kind of slot may capture. A slot that holds a figure, a time or a duration captures only that, so a
 * template never takes ordinary English words for a value (“at least 3” is not “at {time}”, “Today by the hour” is
 * not “Today {time}”).
 */
const NUMBER = '(\\d+(?:[.,]\\d+)*)';
const SIZE = '(\\d+(?:[.,]\\d+)*(?:\\s?(?:[KMGTPE]i?B|B|bytes?))?)';
const PCT = '(\\d+(?:[.,]\\d+)?\\s?%)';
const TIME = '(\\d{1,2}[:.]\\d{2}(?:\\s?[aApP][mM])?)';
const UNIT = '(?:ms|s|secs?|seconds?|min|mins|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|months?|years?)';
const DURATION = `(\\d+(?:[.,]\\d+)?\\s?${UNIT}(?:\\s\\d+(?:[.,]\\d+)?\\s?${UNIT})?)`;
const AMOUNT = '(\\d+(?:[.,]\\d+)*(?:\\s?[^\\s\\d]\\S*)?)';

/** Slots that hold a count: the count picks the plural form, and the reader's language writes the number. */
const COUNT_SLOTS = new Set(['n', 'count', 'days', 'hours', 'minutes', 'seconds']);
/** Slots that hold an amount (“1.2 GB”, “40”): a number with an optional unit, never words. */
const SIZE_SLOTS = new Set(['size', 'used', 'total']);
const SLOT_SHAPES: Readonly<Record<string, string>> = {
  ...Object.fromEntries([...COUNT_SLOTS].map((name) => [name, NUMBER])),
  ...Object.fromEntries([...SIZE_SLOTS].map((name) => [name, SIZE])),
  pct: PCT,
  time: TIME,
  duration: DURATION,
  range: DURATION,
  value: AMOUNT,
};
/** Slots whose own words are said again in the reader's language (“3 hours” in “Didn’t answer for 3 hours”). */
const SAID_AGAIN_SLOTS = new Set(['duration', 'range', 'value', 'what']);

/**
 * Phrases that are a button's words only. In Dutch an open door is “Open” and the button that opens it is “Openen”,
 * so outside a button these stay as they were (which is the Dutch state word too).
 */
const BUTTON_ONLY = new Set<ServerMessageKey>(['phrase.open']);

/**
 * Whether what an open slot caught can be a name. A short one-sided template (“Update {name}”, “Part of {server}”)
 * would otherwise take any English after its fixed words for a name (“Update lists”, “Update homebrew on your PS5”),
 * so there every word of a name must look like a name's: a capital, a digit or a sign that ordinary lower-case words
 * don't have. A name with an ordinary word in it stays English, which is never wrong, only untranslated.
 */
const looksLikeName = (captured: string): boolean =>
  captured.split(/\s+/).every((word) => /[^a-z'’,-]/.test(word));

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
      source += SLOT_SHAPES[name] ?? '(.+?)';
    }
    last = (m.index ?? 0) + m[0].length;
  }
  const tail = template.slice(last);
  source += escapeRegExp(tail);
  weight += tail.length;
  if (names.length === 0) return null;
  // A template that is all slots would match anything.
  if (weight < 3) return null;
  const literal = template.replace(SLOT, ' ').trim();
  const oneSided = template.startsWith('{') || template.endsWith('}');
  const short = literal.split(/\s+/).filter(Boolean).length < 3;
  const guarded = new Set(oneSided && short ? names.filter((name) => !SLOT_SHAPES[name]) : []);
  return { key, re: new RegExp(`^${source}$`, 's'), names, weight, counted, guarded };
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

/** An English number: a comma groups thousands (“1,250”), a point is the decimal point (“1.250” is one and a quarter). */
function countOf(raw: string): number {
  const n = Number(raw.replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** An English number (with its unit, when it has one) written the way the reader's language writes it. */
function numberIn(raw: string, locale: string): string {
  const m = /^(\d[\d.,]*)(.*)$/s.exec(raw);
  if (!m) return raw;
  const digits = m[1] ?? '';
  const n = countOf(digits);
  // Keep every decimal the English had (“1.250” stays three places, “1,250”).
  const decimals = /\.(\d+)$/.exec(digits)?.[1]?.length ?? 0;
  const said = formatLocaleNumber(n, locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${said}${m[2] ?? ''}`;
}

/** Where a string is shown: a button's words may differ from the same word as a state. */
export interface PhraseOptions {
  /** The string is a button's (or a link's) words. */
  button?: boolean;
}

/** The phrase an exact English string names, when it may be used here. */
function exactKey(text: string, button: boolean): ServerMessageKey | null {
  const key = phrasebook().exact.get(text);
  if (!key) return null;
  return BUTTON_ONLY.has(key) && !button ? null : key;
}

/** One whole string, by an exact phrase or a template; null when the book has nothing for it. */
function whole(text: string, locale: string, button: boolean): string | null {
  const tr = serverTranslator(locale);
  const key = exactKey(text, button);
  if (key) return tr.t(key);
  for (const p of phrasebook().patterns) {
    const m = p.re.exec(text);
    if (!m) continue;
    const captured = p.names.map((_, i) => m[i + 1] ?? '');
    if (p.names.some((name, i) => p.guarded.has(name) && !looksLikeName(captured[i] ?? ''))) continue;
    const vars: Record<string, string | number> = {};
    let count: number | undefined;
    p.names.forEach((name, i) => {
      const value = captured[i] ?? '';
      if (COUNT_SLOTS.has(name)) {
        count = countOf(value);
        vars[name] = numberIn(value, locale);
      } else if (SIZE_SLOTS.has(name)) {
        vars[name] = numberIn(value, locale);
      } else if (SAID_AGAIN_SLOTS.has(name)) {
        // A duration or a known word in a slot is said in the reader's language too (“Look into it · {what}”).
        vars[name] = whole(value, locale, false) ?? value;
      } else {
        // A name is the thing's own: never translated, even when it happens to be an English word.
        vars[name] = value;
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
export function localizePhrase(
  text: string,
  locale: string | null | undefined,
  options: PhraseOptions = {},
): string {
  if (!text || isEnglish(locale)) return text;
  const button = options.button === true;
  const own = whole(text, locale ?? '', button);
  if (own !== null) return own;
  if (text.includes(' · ')) {
    const parts = text.split(' · ');
    let changed = false;
    const said = parts.map((part) => {
      const found = whole(part, locale ?? '', false);
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
        const found = whole(s, locale ?? '', false);
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
 * never breaks a shape's limit. A field not listed has no limit of its own, so its translation is used whatever its
 * length.
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
  meta: 120,
};

function fits(
  field: string | null,
  english: string,
  said: string,
  limits: Readonly<Record<string, number>>,
): boolean {
  if (said.length <= english.length) return true;
  const max = field ? (limits[field] ?? FIELD_MAX[field]) : undefined;
  return max === undefined || said.length <= max;
}

export interface LocalizeTreeOptions {
  /** Fields of machine data, left as they are (`MACHINE_DATA_FIELDS` when absent). */
  keep?: ReadonlySet<string>;
  /** Field limits of this shape, over the tightest ones every page shape shares. */
  max?: Readonly<Record<string, number>>;
}

/** Fields whose objects are buttons or links: their words are a button's (“Open” is “Openen”). */
const BUTTON_HOLDERS = new Set(['actions', 'buttons', 'toggle', 'link', 'links', 'open', 'confirm']);

/** Where the walk is: what it means for the words below. */
interface Where {
  /** Inside a button or a choice: its `value` is what it sends back, never a word. */
  sends: boolean;
  /** Inside a button or a link: its words are a button's. */
  button: boolean;
  /** The kind of panel the walk is in (`list`, `gallery`, `table` …), when it is in one. */
  panel: string | null;
  /** A table's first column: it names each row's thing. */
  firstColumn: string | null;
}

const OUTSIDE: Where = { sends: false, button: false, panel: null, firstColumn: null };

/**
 * The fields of an object that hold the name of one of the service's own things (a door, a film, a light, a disk, a
 * container), which stay exactly as the service named them: a door called “Open” is not a button. Everything else in
 * the same rows (states, details, buttons) is still said in the reader's language.
 */
function ownNames(obj: Record<string, unknown>, field: string | null, where: Where): ReadonlySet<string> {
  if (field !== 'items') return NO_FIELDS;
  switch (where.panel) {
    // A picture's title is always what it shows: a film, a camera, a request.
    case 'gallery':
      return TITLE;
    // A line with its own buttons, picture or page is one of the service's things; other lines are our words.
    case 'list':
      return 'actions' in obj || 'image' in obj || 'url' in obj ? TITLE : NO_FIELDS;
    // A control's label is the light's, switch's or lock's own name.
    case 'controls':
      return 'groups' in obj ? NO_FIELDS : LABEL;
    // A bar for a person, a mono name or a page of its own names a disk, a volume or someone.
    case 'bars':
      return obj.person === true || obj.mono === true || 'href' in obj ? LABEL : NO_FIELDS;
    default:
      return NO_FIELDS;
  }
}

const NO_FIELDS: ReadonlySet<string> = new Set();
const TITLE: ReadonlySet<string> = new Set(['title']);
const LABEL: ReadonlySet<string> = new Set(['label']);

/** The key of a table panel's first column, when the object is a table with columns. */
function firstColumnOf(obj: Record<string, unknown>): string | null {
  if (obj.kind !== 'table' || !Array.isArray(obj.columns)) return null;
  const first: unknown = obj.columns[0];
  if (first && typeof first === 'object' && typeof (first as { key?: unknown }).key === 'string') {
    return (first as { key: string }).key;
  }
  return null;
}

/**
 * A copy of a finished tree (a service's page, a glance, a desk view) with every word field said in `locale`. Fields of
 * machine data stay as they were, and so do a button's or a choice's `value` (what it sends back) and the names the
 * service gave its own things; a translation longer than its field allows stays English. English gets the tree back
 * as it is.
 */
export function localizeTree<T>(
  tree: T,
  locale: string | null | undefined,
  options: LocalizeTreeOptions = {},
): T {
  if (isEnglish(locale)) return tree;
  const keep = options.keep ?? MACHINE_FIELDS;
  const limits = options.max ?? {};
  const walk = (value: unknown, field: string | null, where: Where): unknown => {
    if (typeof value === 'string') {
      if (field !== null && keep.has(field)) return value;
      if (field === 'value' && where.sends) return value;
      const said = localizePhrase(value, locale, { button: where.button });
      return fits(field, value, said, limits) ? said : value;
    }
    if (Array.isArray(value)) {
      const inArray = field === 'choices' ? { ...where, sends: true } : where;
      return value.map((v) => walk(v, field, inArray));
    }
    if (value && typeof value === 'object') {
      if (field !== null && keep.has(field)) return value;
      const obj = value as Record<string, unknown>;
      // A button (it says whether it is allowed) or a choice sends its value back: never a word.
      const sends = where.sends || typeof obj.allowed === 'boolean' || 'target' in obj;
      const button =
        where.button ||
        typeof obj.allowed === 'boolean' ||
        (field !== null && BUTTON_HOLDERS.has(field)) ||
        obj.button === true;
      const isPanel = typeof obj.kind === 'string' && typeof obj.id === 'string' && field !== 'items';
      const inside: Where = {
        sends,
        button,
        panel: isPanel ? (obj.kind as string) : where.panel,
        firstColumn: isPanel ? firstColumnOf(obj) : where.firstColumn,
      };
      const names = ownNames(obj, field, where);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (names.has(k)) {
          out[k] = v;
          continue;
        }
        if (field === 'cells') {
          // A table's cells are keyed by column, not by field: a column called `status` still holds words. The first
          // column names the row's thing, which stays as the service named it unless the cell is a button.
          const cell = v as Record<string, unknown> | null;
          const named = k === where.firstColumn && cell && cell.button !== true && !('action' in cell);
          out[k] = named ? v : walk(v, null, inside);
          continue;
        }
        out[k] = walk(v, k, inside);
      }
      return out;
    }
    return value;
  };
  return walk(tree, null, OUTSIDE) as T;
}

/** The fields `localizeTree` keeps as they are, for a caller that needs a few more (or fewer). */
export const MACHINE_DATA_FIELDS: ReadonlySet<string> = MACHINE_FIELDS;

/** `MACHINE_DATA_FIELDS` with a few more. */
export function keepFields(...more: string[]): ReadonlySet<string> {
  return new Set([...MACHINE_FIELDS, ...more]);
}
