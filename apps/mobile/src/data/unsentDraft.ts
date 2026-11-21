/**
 * A message the composer let go of that didn't go (MX-02): the box empties as Send is pressed, so a send the Whombat
 * refused or that failed outright would lose what was typed. Its words come back into the box, as the web keeps its
 * draft until a send is taken. Not when the message waits for a person's approval (it goes once approved), nor when it
 * may have arrived: an unconfirmed send keeps its bubble (“Not confirmed yet”), and a second copy must not follow it.
 */
import { OutcomeUnknownError, wentThrough } from '@whombat/client';

export type SendEnd = { result: { status: string } } | { error: unknown };

/** Whether the message is gone from the conversation: refused, or failed without reaching the Whombat. */
export function sendWasLost(end: SendEnd): boolean {
  if ('result' in end) return end.result.status !== 'ok' && end.result.status !== 'pending_approval';
  return !(end.error instanceof OutcomeUnknownError) && !wentThrough(end.error);
}

/**
 * What the box holds once a lost message's words come back: the message alone in an empty box, or the message above
 * what has been typed since (nothing typed is overwritten). Null: the message went, or may have.
 */
export function draftAfterSend(end: SendEnd, sent: string, typedSince: string): string | null {
  if (!sendWasLost(end) || !sent.trim()) return null;
  return typedSince.trim() ? `${sent}\n\n${typedSince}` : sent;
}
