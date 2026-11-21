/**
 * “Web search” in Settings → Advanced → AI on this Whombat (Whombat web-search.md): the words the card shows, with the
 * assistant's name in them, the dot's tone for what the last check found, and the message a refused key puts under the
 * field. Pure.
 */
import {
  WEB_SEARCH_COPY,
  type WebSearchCheck,
  type WebSearchCheckState,
  webSearchCheckText,
} from '@whombat/core';

export type WebSearchTone = 'ok' | 'warn' | 'bad' | 'mut';

/** The contracts' words with `{assistant}` filled in: the name mid-sentence, capitalised where a sentence starts. */
export function webSearchWords(assistant: { name: string; Name: string }) {
  const fill = (text: string) =>
    text
      .replace(/(^|[.!?]\s+)\{assistant\}/g, `$1${assistant.Name}`)
      .replaceAll('{assistant}', assistant.name);
  return {
    hint: fill(WEB_SEARCH_COPY.hint),
    removeBody: fill(WEB_SEARCH_COPY.removeBody),
  };
}

const TONES: Record<WebSearchCheckState, WebSearchTone> = {
  ok: 'ok',
  invalid_key: 'bad',
  out_of_credit: 'warn',
  unreachable: 'warn',
};

/** The dot and the line under “On, with your Brave Search key.”; not checked since it was saved: no line. */
export function webSearchCheckLine(check: WebSearchCheck | null): {
  tone: WebSearchTone;
  text: string | null;
} {
  return check
    ? { tone: TONES[check.state], text: webSearchCheckText(check.state) }
    : { tone: 'ok', text: null };
}

/**
 * The key's own problem from a refused Save: Brave turned it away (`validation_failed` on `apiKey`) or it isn't a
 * key's shape (the client checks the body before sending). Null for any other failure.
 */
export function webSearchKeyProblem(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('fields' in error)) return null;
  const fields = (error as { fields: unknown }).fields;
  if (!fields || typeof fields !== 'object') return null;
  const messages = (fields as Record<string, unknown>).apiKey;
  return Array.isArray(messages) && typeof messages[0] === 'string' ? messages[0] : null;
}
