/**
 * Web search for the agent (Whombat web-search.md WS-01…): a Brave Search API key the person pastes once in Settings →
 * Advanced → AI on this Whombat. One per burrow (`Burrow.webSearch`); the person sets, checks and removes it
 * (`burrows.setWebSearch`, `burrows.testWebSearch`, `burrows.clearWebSearch`). With one, the person's turns get Hermes's
 * `web_search` tool on Brave; it stays under the key “Browse the web”.
 *
 * The key stays on the server: it goes only to the runner, for the turn's Hermes (`WebSearchDispatchContext`), and into
 * a backup file. No client read model carries it.
 */
import { z } from 'zod';
import { Timestamp } from './common.js';

/** Where the person makes a key: Brave's own pages (sign-up, then API keys). */
export const BRAVE_SEARCH_KEYS_URL = 'https://api-dashboard.search.brave.com/app/keys';
export const BRAVE_SEARCH_SIGNUP_URL = 'https://api-dashboard.search.brave.com/register';

/** The longest key taken (Brave's are about 31 characters). */
export const WEB_SEARCH_KEY_MAX = 200;

/** A Brave Search API key as pasted: one word of printable characters, spaces around it trimmed. */
export const WebSearchApiKey = z
  .string()
  .trim()
  .min(8, 'That’s too short for a Brave Search key.')
  .max(WEB_SEARCH_KEY_MAX)
  .regex(/^[\x21-\x7e]+$/, 'A Brave Search key is one word without spaces.');

/** The search services Whombat sets up. Brave only for now. */
export const WebSearchProvider = z.enum(['brave']);
export type WebSearchProvider = z.infer<typeof WebSearchProvider>;

/**
 * How the last check went (one search for “whombat”): `ok` — Brave answered with results; `invalid_key` — Brave turned
 * the key away; `out_of_credit` — the key is known, but its plan or monthly credit doesn't cover a search now (402, 429
 * with a quota); `unreachable` — no answer, or one Whombat couldn't read.
 */
export const WEB_SEARCH_CHECK_STATES = ['ok', 'invalid_key', 'out_of_credit', 'unreachable'] as const;
export const WebSearchCheckState = z.enum(WEB_SEARCH_CHECK_STATES);
export type WebSearchCheckState = z.infer<typeof WebSearchCheckState>;

export const WebSearchCheck = z.object({
  state: WebSearchCheckState,
  at: Timestamp,
  /** What Brave or the network said, for the person's More detail; null when `ok`. */
  detail: z.string().max(500).nullable(),
});
export type WebSearchCheck = z.infer<typeof WebSearchCheck>;

/** `Burrow.webSearch`: web search as the apps read it, never the key. */
export const WebSearchView = z.object({
  provider: WebSearchProvider,
  /** The last check; null: not checked since it was set. */
  check: WebSearchCheck.nullable(),
  updatedAt: Timestamp,
});
export type WebSearchView = z.infer<typeof WebSearchView>;
