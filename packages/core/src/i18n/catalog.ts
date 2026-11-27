/**
 * `@whombat/core`'s own message catalog: plain declarative data (strings and CLDR plural maps, never
 * functions), split by area under `./messages/` and merged here so `scripts/i18n/` validates and exports it.
 *
 * English is canonical and complete; Dutch has every key (the types and `catalog.test.ts` enforce parity).
 * Modules read it through `coreTranslator(locale)` / `tCore(locale, key, vars)`, which fall back to English per
 * key and render the `pseudo` locale for QA.
 */
import {
  createTranslator,
  type MessageCatalog,
  type MessageValue,
  type MessageVars,
  type Translator,
} from './engine.js';
import { AI } from './messages/ai.js';
import { APPROVALS } from './messages/approvals.js';
import { AUDIT } from './messages/audit.js';
import { AUTOMATION_VIEWS } from './messages/automation-views.js';
import { BACKUP } from './messages/backup.js';
import { BACKUP_FILES } from './messages/backup-files.js';
import { CONNECTION_MESSAGES } from './messages/connections.js';
import { DESK_MESSAGES } from './messages/desk.js';
import { DOMAIN_MESSAGES } from './messages/domain.js';
import { GATEWAY } from './messages/gateway.js';
import { GRANTS_MESSAGES } from './messages/grants.js';
import { HOST_WATCH } from './messages/host-watch.js';
import { KEYS } from './messages/keys.js';
import { LABELS_MESSAGES } from './messages/labels.js';
import { LIVE_MESSAGES } from './messages/live.js';
import { NEWS_MESSAGES } from './messages/news.js';
import { ONEPASSWORD } from './messages/onepassword.js';
import { PROTOCOL } from './messages/protocol.js';
import { RECIPES } from './messages/recipes.js';
import { SCHEDULE } from './messages/schedule.js';
import { SPEND } from './messages/spend.js';
import { STATUS } from './messages/status.js';
import { TEXT } from './messages/text.js';
import { TIME_EN, TIME_NL } from './messages/time.js';
import { VAULT } from './messages/vault.js';
import { VAULT_MORE_MESSAGES } from './messages/vault-more.js';
import { VOICE_MESSAGES } from './messages/voice.js';
import { WEATHER } from './messages/weather.js';

/** A flat declarative message catalog (what `scripts/i18n/` reads from every package). */
export type Catalog = MessageCatalog;

export const EN = {
  ...TIME_EN,
  ...BACKUP.en,
  ...BACKUP_FILES.en,
  ...RECIPES.en,
  ...AUTOMATION_VIEWS.en,
  ...SCHEDULE.en,
  ...SPEND.en,
  ...VAULT.en,
  ...ONEPASSWORD.en,
  ...AUDIT.en,
  ...APPROVALS.en,
  ...KEYS.en,
  ...HOST_WATCH.en,
  ...CONNECTION_MESSAGES.en,
  ...DOMAIN_MESSAGES.en,
  ...VOICE_MESSAGES.en,
  ...DESK_MESSAGES.en,
  ...WEATHER.en,
  ...NEWS_MESSAGES.en,
  ...TEXT.en,
  ...STATUS.en,
  ...GATEWAY.en,
  ...AI.en,
  ...PROTOCOL.en,
  ...LABELS_MESSAGES.en,
  ...LIVE_MESSAGES.en,
  ...GRANTS_MESSAGES.en,
  ...VAULT_MORE_MESSAGES.en,
} satisfies Catalog;

export type CoreMessageKey = keyof typeof EN;

export const NL: { [K in CoreMessageKey]: MessageValue } = {
  ...TIME_NL,
  ...BACKUP.nl,
  ...BACKUP_FILES.nl,
  ...RECIPES.nl,
  ...AUTOMATION_VIEWS.nl,
  ...SCHEDULE.nl,
  ...SPEND.nl,
  ...VAULT.nl,
  ...ONEPASSWORD.nl,
  ...AUDIT.nl,
  ...APPROVALS.nl,
  ...KEYS.nl,
  ...HOST_WATCH.nl,
  ...CONNECTION_MESSAGES.nl,
  ...DOMAIN_MESSAGES.nl,
  ...VOICE_MESSAGES.nl,
  ...DESK_MESSAGES.nl,
  ...WEATHER.nl,
  ...NEWS_MESSAGES.nl,
  ...TEXT.nl,
  ...STATUS.nl,
  ...GATEWAY.nl,
  ...AI.nl,
  ...PROTOCOL.nl,
  ...LABELS_MESSAGES.nl,
  ...LIVE_MESSAGES.nl,
  ...GRANTS_MESSAGES.nl,
  ...VAULT_MORE_MESSAGES.nl,
};

export type CoreTranslator = Translator<typeof EN>;

const translators = new Map<string, CoreTranslator>();

/** The core translator for a locale tag (`en-GB`, `nl-NL`, `nl`, `pseudo`); null or unknown means English. */
export function coreTranslator(locale?: string | null): CoreTranslator {
  // A formatter passed straight to `Array.map` receives an index here; anything but a tag means English.
  const tag = typeof locale === 'string' ? locale : null;
  const cacheKey = tag ?? '';
  let tr = translators.get(cacheKey);
  if (!tr) {
    if (translators.size > 64) translators.clear();
    tr = createTranslator<typeof EN>({ en: EN, nl: NL }, tag);
    translators.set(cacheKey, tr);
  }
  return tr;
}

/** Translates one core message key in a locale, with `{placeholders}` filled from `vars`. */
export function tCore(locale: string | null | undefined, key: CoreMessageKey, vars?: MessageVars): string {
  return coreTranslator(locale).t(key, vars);
}

/** Translates a count-dependent core message (CLDR plural rules of the locale). */
export function tpCore(
  locale: string | null | undefined,
  key: CoreMessageKey,
  count: number,
  vars?: MessageVars,
): string {
  return coreTranslator(locale).tp(key, count, vars);
}

/** True when the locale renders English text (English, null, unknown tags and the pseudo locale's source). */
export function isEnglishLocale(locale?: string | null): boolean {
  return coreTranslator(locale).language === 'en';
}

/**
 * A record of plain strings read from `{prefix}.{key}` for each key, in a locale: the shape of the word tables that
 * screens import (`EFFORT_LABELS`, `LOCAL_MODEL_COPY`, …). A key missing from the catalog throws at load.
 */
export function coreWords<const K extends string>(
  locale: string | null | undefined,
  prefix: string,
  keys: readonly K[],
): Record<K, string> {
  const tr = coreTranslator(locale);
  const out = {} as Record<K, string>;
  for (const key of keys) out[key] = tr.t(`${prefix}.${key}` as CoreMessageKey);
  return out;
}

/** The keys of a nested word table: `0` marks a string, an object a group of strings. */
export type WordShape = { readonly [key: string]: 0 | WordShape };

/** A nested word table with every `0` of its shape filled with a string. */
export type WordTree<S> = { readonly [K in keyof S]: S[K] extends 0 ? string : WordTree<S[K]> };

/**
 * A nested word table read from `{prefix}.{path}` for each leaf of `shape`, in a locale: the shape of the larger word
 * tables screens import (`DESK_WORDS`, …). A key missing from the catalog throws at load.
 */
export function coreTree<const S extends WordShape>(
  locale: string | null | undefined,
  prefix: string,
  shape: S,
): WordTree<S> {
  const tr = coreTranslator(locale);
  const fill = (node: WordShape, path: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = value === 0 ? tr.t(`${path}.${key}` as CoreMessageKey) : fill(value, `${path}.${key}`);
    }
    return out;
  };
  return fill(shape, prefix) as WordTree<S>;
}

/** Whether the core catalog has a message under `key` (for keys built from data, like a check's id). */
export function hasCoreMessage(key: string): key is CoreMessageKey {
  return Object.hasOwn(EN, key);
}
