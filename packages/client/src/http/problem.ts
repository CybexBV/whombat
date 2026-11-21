/**
 * What a person reads when something they did didn't go through, and the raw words behind it for “More detail” (the
 * web and the phone alike). The server's own sentence for a refusal stands: it is written for people. What only a
 * developer can read — a status code, an endpoint's id, a schema's wording, a network error's name — becomes a plain
 * sentence, and the raw words go to `detail`.
 */
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

function byStatus(status: number): string {
  if (status === 413) return PROBLEM_WORDS.tooBig;
  if (status === 404) return PROBLEM_WORDS.whombatUpdate;
  if (status >= 500) return PROBLEM_WORDS.noAnswer;
  return PROBLEM_WORDS.fallback;
}

export function problemOf(e: unknown, fallback: string = PROBLEM_WORDS.fallback): Problem {
  if (e instanceof NetworkError) return { text: PROBLEM_WORDS.network, detail: e.message };
  if (e instanceof InvalidRequestError) return { text: PROBLEM_WORDS.input, detail: e.message };
  if (e instanceof ContractError) return { text: PROBLEM_WORDS.appUpdate, detail: e.message };
  if (e instanceof ApiError) {
    const bare = BARE_STATUS.exec(e.message);
    if (bare) return { text: byStatus(Number(bare[1])), detail: e.message };
    if (NO_ENDPOINT.test(e.message)) return { text: PROBLEM_WORDS.whombatUpdate, detail: e.message };
    if (e.status === 413) return { text: PROBLEM_WORDS.tooBig, detail: e.message || null };
    return e.message ? { text: e.message, detail: null } : { text: fallback, detail: null };
  }
  if (e instanceof Error) return { text: fallback, detail: e.message || null };
  if (typeof e === 'string' && e) return { text: fallback, detail: e };
  return { text: fallback, detail: null };
}

/** `problemOf`'s sentence alone, where there is no room for more (a toast, an alert). */
export function problemText(e: unknown, fallback?: string): string {
  return problemOf(e, fallback).text;
}
