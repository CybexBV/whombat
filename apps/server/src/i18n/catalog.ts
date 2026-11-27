/**
 * The server's own message catalog: plain declarative data (strings and CLDR plural maps, never functions), split by
 * area under `./messages/` and merged here so `scripts/i18n/` validates and exports it beside every other package's.
 *
 * English is canonical and says exactly what the server said before languages existed, so English output is
 * unchanged. Dutch has every key (the types and `server-i18n.test.ts` enforce parity) and follows the glossary in
 * `docs/decisions/i18n.md`: short, plain, informal “je”.
 *
 * `phrase.*` messages are also the phrasebook `./phrases.ts` matches finished English strings against.
 */
import {
  createTranslator,
  type MessageValue,
  type MessageVars,
  resolveLanguage,
  type Translator,
} from '@whombat/core/i18n';
import { CHAT } from './messages/chat';
import { DESK } from './messages/desk';
import { GUIDES } from './messages/guides';
import { HOME } from './messages/home';
import { HOSTS } from './messages/hosts';
import { MAIL } from './messages/mail';
import { MANAGED } from './messages/managed';
import { PHRASES } from './messages/phrases';
import { SEARCH } from './messages/search';
import { SETTINGS } from './messages/settings';
import { THINGS } from './messages/things';

export const EN = {
  ...HOME.en,
  ...HOSTS.en,
  ...GUIDES.en,
  ...MAIL.en,
  ...MANAGED.en,
  ...DESK.en,
  ...THINGS.en,
  ...PHRASES.en,
  ...SEARCH.en,
  ...SETTINGS.en,
  ...CHAT.en,
};

export type ServerMessageKey = keyof typeof EN & string;

export const NL: { [K in ServerMessageKey]: MessageValue } = {
  ...HOME.nl,
  ...HOSTS.nl,
  ...GUIDES.nl,
  ...MAIL.nl,
  ...MANAGED.nl,
  ...DESK.nl,
  ...THINGS.nl,
  ...PHRASES.nl,
  ...SEARCH.nl,
  ...SETTINGS.nl,
  ...CHAT.nl,
};

export type ServerTranslator = Translator<typeof EN>;

const translators = new Map<string, ServerTranslator>();

/** The server's translator for a locale tag (`en-GB`, `nl-NL`, `nl`, `pseudo`); null or unknown means English. */
export function serverTranslator(locale?: string | null): ServerTranslator {
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

/** Translates one server message key in a locale, with `{placeholders}` filled from `vars`. */
export function tServer(
  locale: string | null | undefined,
  key: ServerMessageKey,
  vars?: MessageVars,
): string {
  return serverTranslator(locale).t(key, vars);
}

/** Translates a count-dependent server message (CLDR plural rules of the locale). */
export function tpServer(
  locale: string | null | undefined,
  key: ServerMessageKey,
  count: number,
  vars?: MessageVars,
): string {
  return serverTranslator(locale).tp(key, count, vars);
}

/** True when the locale renders English text: English, null, unknown tags. The pseudo locale is not English. */
export function isEnglish(locale?: string | null): boolean {
  return serverTranslator(locale).language === 'en';
}

/** The language a locale renders (`en` or `nl`), for `<html lang>` and the like. */
export function languageOf(locale?: string | null): 'en' | 'nl' {
  return resolveLanguage(locale ?? null);
}

/** Whether the catalog has a message under `key` (for keys built from data, like a hub alert's code). */
export function hasServerMessage(key: string): key is ServerMessageKey {
  return Object.hasOwn(EN, key);
}
