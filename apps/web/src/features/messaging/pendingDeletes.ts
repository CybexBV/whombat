/**
 * Deletes waiting for their Undo (docs/decisions/web-messages.md WX-09): a deleted message leaves the lists at once,
 * but the delete is only sent when its toast ends; Undo cancels it. Leaving the conversation sends it (`leaveConversation`
 * when its room closes), and so does leaving the page (as far as the browser lets a request go out then).
 */
import { useSyncExternalStore } from 'react';

interface Pending {
  conversationId: string;
  /** Sends the delete; called once. */
  commit: () => void;
  /** Takes its toast away (the Undo is gone once the delete is sent). */
  dismiss?: () => void;
}

const pending = new Map<string, Pending>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const noop = () => {};

function changed() {
  snapshot = new Set(pending.keys());
  for (const l of listeners) l();
}

/** Hides `messageId` until it is sent and answered (`settleDelete`), or undone (`undoDelete`). */
export function stageDelete(messageId: string, entry: Pending): void {
  pending.set(messageId, entry);
  changed();
}

/** Its toast, once shown. */
export function setDeleteDismiss(messageId: string, dismiss: () => void): void {
  const entry = pending.get(messageId);
  if (entry) entry.dismiss = dismiss;
}

/** Undo: the message comes back, nothing is sent. */
export function undoDelete(messageId: string): void {
  if (pending.delete(messageId)) changed();
}

/** Sends a staged delete (its toast ended, or its conversation closed); it stays hidden until `settleDelete`. */
export function commitDelete(messageId: string): void {
  const entry = pending.get(messageId);
  if (!entry) return;
  const { commit, dismiss } = entry;
  entry.commit = noop;
  entry.dismiss = noop;
  commit();
  dismiss?.();
}

/** The delete's answer is in: the message is gone from the cache, or (refused) shows again. */
export function settleDelete(messageId: string): void {
  if (pending.delete(messageId)) changed();
}

/** The conversation's room closed: its waiting deletes are sent now. */
export function leaveConversation(conversationId: string): void {
  for (const [id, entry] of [...pending]) if (entry.conversationId === conversationId) commitDelete(id);
}

/** Ids of messages deleted and waiting (or being sent): the lists leave them out. */
export function usePendingDeletes(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => snapshot,
    () => snapshot,
  );
}

/** Test hook: forget every staged delete without sending it. */
export function resetPendingDeletes(): void {
  pending.clear();
  changed();
}

// Closing the tab or reloading sends what is waiting (the request may or may not make it out).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const id of [...pending.keys()]) commitDelete(id);
  });
}
