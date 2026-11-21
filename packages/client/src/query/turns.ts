/**
 * “Try again” on a failed turn (Whombat essentials item 4; contracts CT-167) in the cache: once `dispatches.retry`
 * answers, every `turn_failed` card of that turn and its Work item say “Tried again” at once. The runtime's
 * `message.updated` (the card's `retriedAt`) and the work overview's next read carry the same, so this only saves the
 * wait; a card already marked keeps its time.
 */
import type { QueryClient } from '@tanstack/query-core';
import type { Message, WorkOverview } from '@whombat/core';
import { patchMessages } from './apply';
import { patchEndpoint } from './cache';

/** `message` with its `turn_failed` card of `dispatchId` marked retried; the same object when nothing changes. */
export function markTurnRetried(
  message: Message,
  dispatchId: string,
  retryDispatchId: string,
  at: string,
): Message {
  const card = message.card;
  if (card?.kind !== 'turn_failed' || card.dispatchId !== dispatchId || card.retriedAt) return message;
  return { ...message, card: { ...card, retriedAt: at, retryDispatchId } };
}

/** The work overview with the failed turn's item marked retried (its `failure`); the same object when nothing changes. */
export function markWorkRetried(
  overview: WorkOverview,
  dispatchId: string,
  retryDispatchId: string,
  at: string,
): WorkOverview {
  let changed = false;
  const sections = overview.sections.map((s) => {
    let hit = false;
    const items = s.items.map((item) => {
      if (item.refs.dispatchId !== dispatchId || !item.failure || item.failure.retriedAt) return item;
      hit = true;
      return { ...item, failure: { ...item.failure, retriedAt: at, retryDispatchId } };
    });
    if (!hit) return s;
    changed = true;
    // The spread keeps the count of items only a newer app shows (AP-255, an own member).
    return { ...s, items };
  });
  return changed ? { ...overview, sections } : overview;
}

/** Put a retry everywhere the failed turn shows: its cards and its Work item. */
export function applyTurnRetry(
  qc: QueryClient,
  dispatchId: string,
  retryDispatchId: string,
  at: string = new Date().toISOString(),
): void {
  patchMessages({ qc }, (m) => markTurnRetried(m, dispatchId, retryDispatchId, at));
  patchEndpoint<WorkOverview>(qc, 'work.overview', (d) =>
    markWorkRetried(d, dispatchId, retryDispatchId, at),
  );
}
