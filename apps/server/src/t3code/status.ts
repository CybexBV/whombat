/**
 * T3 Code's words for where a thread is (`status` in its answers), and how a hand-over's job ended from them. Kept apart
 * from the connection's code (`things/kinds/business/t3code.ts`, which re-exports them) so the thread list reads them
 * without loading it.
 */
import type { HandoffOutcome } from '@whombat/core';
import { progressOf } from './progress';

export const T3_STATUSES = [
  'idle',
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
] as const;
export type T3Status = (typeof T3_STATUSES)[number];

/** A thread at work: `waiting` is a finished turn whose after-work still runs, not a thread waiting for the person. */
export const AT_WORK: readonly T3Status[] = ['preparing', 'queued', 'starting', 'running', 'waiting'];
export const FINISHED: readonly T3Status[] = [
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
];

/** How a thread's run ended, as the person sees it. */
export const outcomeOf = (status: T3Status): HandoffOutcome =>
  status === 'failed' || status === 'rolled_back'
    ? 'failed'
    : status === 'interrupted' || status === 'cancelled'
      ? 'stopped'
      : 'completed';

/**
 * How a watch's job ended, for its Whombat thread's row (`ChatThread.job`): its outcome and when, once T3 Code said its
 * run is over and nothing it waits for goes on (no pull request's checks, no work it is still finishing). Null while it
 * is at work, waits, or before T3 Code said.
 */
export function jobEndOf(row: {
  state: string;
  status: string | null;
  prs: unknown;
  progress?: unknown;
  runEndedAt: Date | null;
}): { outcome: HandoffOutcome; endedAt: Date } | null {
  const status = row.status as T3Status | null;
  if (!status || !(FINISHED.includes(status) || status === 'idle') || !row.runEndedAt) return null;
  const prs = Array.isArray(row.prs) && row.prs.some((p) => typeof p === 'string' && p.length > 0);
  if (row.state === 'watching' && (progressOf(row.progress).held || prs)) return null;
  return { outcome: outcomeOf(status), endedAt: row.runEndedAt };
}
