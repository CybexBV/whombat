/**
 * What a person reads when something they did didn't go through, and the raw words behind it for “More detail” (the
 * web and the phone alike). The server's own sentence for a refusal stands: it is written for people. What only a
 * developer can read — a status code, an endpoint's id, a schema's wording, a network error's name — becomes a plain
 * sentence, and the raw words go to `detail`.
 */
import { resolveLanguage } from '@whombat/core';
import { ApiError, ContractError, InvalidRequestError, NetworkError } from './errors';

export const PROBLEM_WORDS = {
  network: 'Can’t reach your Whombat. Check your connection and try again.',
  input: 'Check what you typed and try again.',
  appUpdate: 'This app needs an update for that.',
  whombatUpdate: 'Your Whombat needs an update for that.',
  tooBig: 'That’s too big to send.',
  noAnswer: 'Your Whombat didn’t answer properly. Try again in a moment.',
  fallback: 'That didn’t work. Try again in a moment.',
} as const;

export const PROBLEM_WORDS_NL = {
  network: 'Kan je Whombat niet bereiken. Controleer je verbinding en probeer het opnieuw.',
  input: 'Controleer wat je hebt ingevuld en probeer het opnieuw.',
  appUpdate: 'Deze app heeft een update nodig voor deze actie.',
  whombatUpdate: 'Je Whombat heeft een update nodig voor deze actie.',
  tooBig: 'Dat is te groot om te versturen.',
  noAnswer: 'Je Whombat antwoordde niet goed. Probeer het zo opnieuw.',
  fallback: 'Dat is niet gelukt. Probeer het zo opnieuw.',
} as const;

export function problemWords(locale?: string | null): typeof PROBLEM_WORDS | typeof PROBLEM_WORDS_NL {
  return resolveLanguage(locale) === 'nl' ? PROBLEM_WORDS_NL : PROBLEM_WORDS;
}

export interface Problem {
  /** One plain sentence. */
  text: string;
  /** What the app or the server actually said, for “More detail”; null when the text is all there is. */
  detail: string | null;
}

/** The client's own words for an answer that wasn't a contract error body (`toApiError`). */
const BARE_STATUS = /^Request failed with status (\d{3})$/;
/** The server's words for an operation it doesn't have: a newer app talking to an older Whombat. */
const NO_ENDPOINT = /^No such endpoint\.?$/;

function byStatus(status: number, words: typeof PROBLEM_WORDS | typeof PROBLEM_WORDS_NL): string {
  if (status === 413) return words.tooBig;
  if (status === 404) return words.whombatUpdate;
  if (status >= 500) return words.noAnswer;
  return words.fallback;
}

export function problemOf(e: unknown, fallback?: string, locale?: string | null): Problem {
  const words = problemWords(locale);
  const fb = fallback ?? words.fallback;
  if (e instanceof NetworkError) return { text: words.network, detail: e.message };
  if (e instanceof InvalidRequestError) return { text: words.input, detail: e.message };
  if (e instanceof ContractError) return { text: words.appUpdate, detail: e.message };
  if (e instanceof ApiError) {
    const detailCode =
      typeof e.details === 'object' && e.details !== null
        ? (e.details as { code?: unknown }).code
        : undefined;
    if (e.code === 'not_implemented' || (e.code as string) === 'unknown_op' || detailCode === 'unknown_op')
      return { text: words.whombatUpdate, detail: e.message || null };
    if (e.status === 413) return { text: words.tooBig, detail: e.message || null };
    const bare = BARE_STATUS.exec(e.message);
    if (bare) return { text: byStatus(Number(bare[1]), words), detail: e.message };
    if (NO_ENDPOINT.test(e.message)) return { text: words.whombatUpdate, detail: e.message };
    return e.message ? { text: e.message, detail: null } : { text: fb, detail: null };
  }
  if (e instanceof Error) return { text: fb, detail: e.message || null };
  if (typeof e === 'string' && e) return { text: fb, detail: e };
  return { text: fb, detail: null };
}

/** `problemOf`'s sentence alone, where there is no room for more (a toast, an alert). */
export function problemText(e: unknown, fallback?: string, locale?: string | null): string {
  return problemOf(e, fallback, locale).text;
}
