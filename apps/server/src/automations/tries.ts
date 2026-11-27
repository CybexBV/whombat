/**
 * What a run keeps about the tries at its fix, and the reset that puts its steps back to pending: the part of going
 * round again (`again.ts`) that a person's restart (`continueAutomationRun`) and the unlanded notice share. This file
 * loads no step or connection code, so `commands.ts` and `trackers/unlanded.ts` can load it.
 */
import { billedTokens, type JsonObject } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { automationRunSteps, dispatches } from '../db/schema/index';
import { turnThreadsOf } from './mail-text';
import type { AutomationStepRow } from './store';

/** Why a run goes again. */
export type AgainCause =
  | 'review_changes'
  | 'review_unconfirmed'
  | 'fix_failed'
  | 'review_failed'
  | 'checks_failed'
  | 'changed'
  | 'conflict';

/** The fix branch's head as GitHub has it: a commit, `sha: null` when there is no such branch, null when unreadable. */
export type HeadReading = { sha: string | null } | null;

/** What the `fix` row keeps about the tries (`output.again`). */
export interface AgainMark {
  /** The try at the fix now under way: 1 is the first (a person's restart starts over there). */
  tries: number;
  /** The most tries this run makes, as it was when it went again. */
  max?: number;
  /** The fix branch's head when it last went again from the fix (null: GitHub couldn't be read). */
  head?: HeadReading;
  cause?: AgainCause;
  detail?: string;
  /** The review step's attempt this try starts at: its one re-read of an unread reviewer is once per try. */
  reviewAttempt?: number;
  /** When it last went again from the fix (ISO): a review that began before then didn't read this try's work. */
  since?: string;
  /** The try whose broken review was done again: once in each try. */
  reviewRedo?: number;
  /** The pull request the run's thread already heard about: a later try doesn't say it again. */
  prSaid?: number;
}

/** The mark a `fix` row's output keeps, or null. */
export function againMarkOf(output: unknown): AgainMark | null {
  const again = (output as { again?: unknown } | null)?.again;
  if (!again || typeof again !== 'object') return null;
  const tries = (again as { tries?: unknown }).tries;
  return typeof tries === 'number' && Number.isInteger(tries) && tries >= 1 ? (again as AgainMark) : null;
}

/**
 * What a step's turns that handed their wait over used (`output.handedWait.tokens`). Read here rather than through
 * `turn-waits.ts`, which loads the T3 Code reader and with it the connections' code.
 */
function handedTokensOf(output: unknown): number {
  const tokens = (output as { handedWait?: { tokens?: unknown } } | null)?.handedWait?.tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0;
}

/** What earlier attempts of a step used, as billed, which a reset keeps (`output.earlierTokens`). */
export function earlierTokensOf(output: unknown): number {
  const kept = (output as { earlierTokens?: unknown } | null)?.earlierTokens;
  return typeof kept === 'number' && Number.isFinite(kept) && kept > 0 ? kept : 0;
}

/**
 * What a step reset to pending keeps of its output: which threads its turns ran in (a mail's text is wiped from them),
 * and what its earlier attempts used.
 */
export function resetOutput(output: unknown): JsonObject {
  const threads = turnThreadsOf(output);
  const tokens = earlierTokensOf(output);
  return {
    ...(threads.length ? { turnThreads: threads } : {}),
    ...(tokens ? { earlierTokens: tokens } : {}),
  };
}

/**
 * Puts the run's steps from `fromIdx` on back to pending, each as a new attempt with nothing of the old one but what it
 * used (its turn's tokens join `earlierTokens`, so the run's and the day's limits still count them): the engine runs
 * them again. `keep` leaves a step as it is. Shared by the engine going again and a person's restart
 * (`continueAutomationRun`). The outputs it wrote, by step.
 */
export async function resetStepsFrom(
  tx: Tx,
  runId: string,
  rows: readonly AutomationStepRow[],
  fromIdx: number,
  now: Date,
  o: { keep?: (row: AutomationStepRow) => boolean } = {},
): Promise<Map<number, JsonObject>> {
  const reset = rows.filter((s) => s.idx >= fromIdx && !o.keep?.(s));
  const turnIds = reset.map((s) => s.dispatchId).filter((id): id is string => !!id);
  const usage = new Map(
    turnIds.length
      ? (
          await tx
            .select({ id: dispatches.id, usage: dispatches.usage })
            .from(dispatches)
            .where(inArray(dispatches.id, turnIds))
        ).map((d) => [d.id, d.usage])
      : [],
  );
  const written = new Map<number, JsonObject>();
  for (const s of reset) {
    const turn = s.dispatchId ? usage.get(s.dispatchId) : null;
    const used = earlierTokensOf(s.output) + (turn ? billedTokens(turn) : 0) + handedTokensOf(s.output);
    const output = { ...resetOutput(s.output), ...(used > 0 ? { earlierTokens: used } : {}) };
    written.set(s.idx, output);
    await tx
      .update(automationRunSteps)
      .set({
        state: 'pending',
        attempt: s.attempt + 1,
        idempotencyKey: null,
        startedAt: null,
        finishedAt: null,
        wakeAt: null,
        deadlineAt: null,
        inputSummary: '',
        output,
        error: null,
        dispatchId: null,
        approvalId: null,
        promptMessageId: null,
        messageIds: [],
        prNumber: null,
        updatedAt: now,
      })
      .where(and(eq(automationRunSteps.runId, runId), eq(automationRunSteps.idx, s.idx)));
  }
  return written;
}
