/**
 * When a conversation's list says it is being updated or couldn't be (`ui/readState.tsx`): only when it says
 * something — a read under way for a moment over data a while old, or a failed read with data on screen.
 */

export const READ_STATE_TEXT = {
  updating: 'Updating…',
  failed: 'Couldn’t update',
  retry: 'Try again',
  retryHint: 'Reads these messages again',
} as const;

/** A read under way shows “Updating…” only once it has taken this long: most answers come sooner. */
export const UPDATING_AFTER_MS = 2_000;
/** Data read this long ago or more counts as old enough to say it is being updated. */
export const OLD_AFTER_MS = 60_000;

export type ReadLine = 'updating' | 'failed' | null;

export interface ReadFacts {
  hasData: boolean;
  /** The read's status: `error` with data on screen is a failure to update. */
  status: 'pending' | 'error' | 'success';
  /** A read of the first page is under way, or waits to get online. */
  asking: boolean;
  /** When the data on screen was read (ms). */
  dataUpdatedAt: number;
  /** When the read now under way began (ms), null when none is. */
  askingSince: number | null;
}

/** What the pill says, if anything. */
export function readLineOf(facts: ReadFacts, now: number): ReadLine {
  if (!facts.hasData) return null;
  if (facts.status === 'error' && !facts.asking) return 'failed';
  if (!facts.asking || facts.askingSince === null) return null;
  const old = facts.status === 'error' || now - facts.dataUpdatedAt >= OLD_AFTER_MS;
  return old && now - facts.askingSince >= UPDATING_AFTER_MS ? 'updating' : null;
}
