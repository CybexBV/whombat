/**
 * Web search in words (Whombat web-search.md): Settings → Advanced → AI on this Whombat's section, what a check found,
 * and the signed Keys line. Plain words (concise-replies.md).
 */
import type { WebSearchCheckState } from '../domain/web-search.js';

export const WEB_SEARCH_COPY = {
  title: 'Web search',
  /** `{assistant}`: the assistant's name. */
  hint: 'Let {assistant} search the web with Brave Search. Brave gives about 1,000 searches a month free; signing up asks for a card.',
  steps: 'Make a key at Brave, then paste it here.',
  getKey: 'Get a Brave Search key',
  signUp: 'No account yet? Sign up',
  apiKey: 'Brave Search API key',
  save: 'Save',
  checkAgain: 'Check again',
  replace: 'Use another key',
  remove: 'Remove',
  removeTitle: 'Remove web search?',
  removeBody: '{assistant} can’t search the web until you add a key again.',
  /** The line while it is on. */
  on: 'On, with your Brave Search key.',
  saved: 'Web search is on.',
  removed: 'Removed web search.',
  /** Under the field when Brave turns the key away on Save. */
  invalidKey: 'Brave doesn’t accept this key. Copy it again from Brave’s API keys page.',
  /** Under the section when “Browse the web” is off for the assistant. */
  browseOff: 'It works while “Browse the web” is on for {assistant}.',
} as const;

/** What a check found, one or two sentences. */
export function webSearchCheckText(state: WebSearchCheckState): string {
  switch (state) {
    case 'ok':
      return 'It works.';
    case 'invalid_key':
      return 'Brave doesn’t accept the key. Copy it again from Brave’s API keys page.';
    case 'out_of_credit':
      return 'Brave knows the key, but it has no searches left right now. Check your plan at Brave.';
    case 'unreachable':
      return 'Whombat couldn’t reach Brave Search just now. Try again in a moment.';
  }
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
