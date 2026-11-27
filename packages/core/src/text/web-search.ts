/**
 * Web search in words (Whombat web-search.md): Settings → Advanced → AI on this Whombat's section, what a check found,
 * and the signed Keys line. Plain words (concise-replies.md).
 */

import type { WebSearchCheckState } from '../domain/web-search.js';
import { coreTranslator, coreWords } from '../i18n/catalog.js';

const WEB_SEARCH_KEYS = [
  'title',
  /** `{assistant}`: the assistant's name. */
  'hint',
  'steps',
  'getKey',
  'signUp',
  'apiKey',
  'save',
  'checkAgain',
  'replace',
  'remove',
  'removeTitle',
  'removeBody',
  /** The line while it is on. */
  'on',
  'saved',
  'removed',
  /** Under the field when Brave turns the key away on Save. */
  'invalidKey',
  /** Under the section when “Browse the web” is off for the assistant. */
  'browseOff',
] as const;

/** Settings → Advanced → AI on this Whombat → Web search, in a locale (`{assistant}` stays for the caller). */
export function webSearchCopy(
  locale?: string | null,
): Readonly<Record<(typeof WEB_SEARCH_KEYS)[number], string>> {
  return coreWords(locale, 'webSearch', WEB_SEARCH_KEYS);
}

export const WEB_SEARCH_COPY = webSearchCopy('en');

/** What a check found, one or two sentences. */
export function webSearchCheckText(state: WebSearchCheckState, locale?: string | null): string {
  return coreTranslator(locale).t(`webSearch.check.${state}`);
}

/** What changed, for `burrow.web_search_changed`. */
export type WebSearchChange = 'set' | 'changed' | 'removed';

/** The signed Keys line of `burrow.web_search_changed`, never the key. */
export function webSearchKeysText(input: { actor: string; change: WebSearchChange }): string {
  switch (input.change) {
    case 'set':
      return `${input.actor} turned on web search with a Brave Search key`;
    case 'changed':
      return `${input.actor} changed the Brave Search key for web search`;
    case 'removed':
      return `${input.actor} removed web search`;
  }
}
