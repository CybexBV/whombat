/**
 * “Reply in thread” opens the thread pane with its reply box focused (AP-443); opening a thread from its link or an
 * address doesn't. The request is one-shot and short-lived, so a pane opened later for another reason keeps focus
 * where it was.
 */
let requested: { threadId: string; at: number } | null = null;

const WINDOW_MS = 5000;

export function requestReplyFocus(threadId: string, now: number = Date.now()): void {
  requested = { threadId, at: now };
}

/**
 * “Answer” under a question that waits (docs/decisions/ui-refresh-chat.md) opens its thread at the card that waits, with
 * the card's first button focused; one-shot as the reply box's request.
 */
/** A card's answer button that can be pressed now. */
export const CARD_BUTTON = 'button:not([disabled]):not([aria-disabled="true"])';

let cardRequested: { threadId: string; at: number } | null = null;

export function requestCardFocus(threadId: string, now: number = Date.now()): void {
  cardRequested = { threadId, at: now };
}

/** Whether the pane that just opened `threadId` should focus the card that waits (clears the request). */
export function takeCardFocus(threadId: string, now: number = Date.now()): boolean {
  const hit =
    cardRequested !== null && cardRequested.threadId === threadId && now - cardRequested.at < WINDOW_MS;
  if (cardRequested?.threadId === threadId) cardRequested = null;
  return hit;
}

/** Whether the pane that just opened `threadId` should focus its reply box (clears the request). */
export function takeReplyFocus(threadId: string, now: number = Date.now()): boolean {
  const hit = requested !== null && requested.threadId === threadId && now - requested.at < WINDOW_MS;
  if (requested?.threadId === threadId) requested = null;
  return hit;
}
