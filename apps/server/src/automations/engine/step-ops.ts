/**
 * What the engine's step handlers share (bp-automations BP-C05): the run they work on under the engine's lease, with the
 * fenced commit of its next transition; a failed attempt; and a step waiting for a person's yes to its own request.
 */
import type { AutomationStep } from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { ApprovalRow } from '../../approvals/engine';
import type { CommitResult } from '../../commit/types';
import type { Db } from '../../db/client';
import { approvals } from '../../db/schema/index';
import { loadPrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import type { StepOp } from '../steps';
import { changedSinceCard, freshCardOutput } from '../steps/connection-actions';
import type { AutomationRunRow, AutomationStepRow } from '../store';

/** A run this engine holds the lease on, as a step's effect uses it. */
export interface LeasedRun {
  readonly services: Services;
  /** The run as this pass loaded it. */
  readonly run: AutomationRunRow;
  /** The fencing token taken with the lease: every commit of the run carries it. */
  readonly fence: number;
  /** The engine holding the lease (`lease_owner`). */
  readonly owner: string;
  /** The automation's own principal, which signs every commit of its runs. */
  principal(): Promise<string>;
  /** One transition of the run (steps.ts `automationStep`): fenced by the lease, signed by the automation. */
  commit(op: StepOp): Promise<CommitResult<{ status: string }>>;
}

/** A failed attempt: retry after a backoff while retries are left, else the step fails. */
export function failure(row: AutomationStepRow, step: AutomationStep, error: string): StepOp {
  if (row.attempt < step.retries)
    return {
      op: 'settle',
      idx: row.idx,
      state: 'pending',
      retry: true,
      error,
      from: ['running', 'waiting'],
    };
  return { op: 'settle', idx: row.idx, state: 'failed', error, from: ['running', 'waiting'] };
}

/** Who decided an approval, as a step's words name them. */
export async function deciderName(db: Db, approval: ApprovalRow): Promise<string> {
  const decider = approval.decidedById ? await loadPrincipalRow(db, approval.decidedById) : undefined;
  return decider ? (decider.shortName ?? decider.name) : 'A person';
}

/**
 * A step waiting for a person's yes to its own request (a branch, a comment, a tracker write or reply, a merge): the
 * approval gone fails the attempt, a no is what `declined` makes of it, an execution its guard refused asks again when
 * the request went stale (else the step is blocked), and nobody deciding by the step's deadline fails it. Null: it
 * keeps waiting.
 */
export async function awaitingYes(
  db: Db,
  row: AutomationStepRow,
  step: AutomationStep,
  now: Date,
  declined: (name: string) => StepOp,
): Promise<StepOp | null> {
  const [a] = row.approvalId ? await db.select().from(approvals).where(eq(approvals.id, row.approvalId)) : [];
  if (!a) return failure(row, step, 'The approval is gone.');
  if (a.state === 'declined') return declined(await deciderName(db, a));
  if (a.execution.state === 'failed') {
    if ((row.output as { refusal?: string }).refusal === 'stale')
      // A card of proposed connection actions is asked again on the engine's next pass, which reads its names again from
      // where the calls go now (a connection given another address or sign-in shows the new one's).
      return step.kind === 'connection_actions'
        ? {
            op: 'settle',
            idx: row.idx,
            state: 'pending',
            from: ['waiting'],
            output: freshCardOutput(await changedSinceCard(db, row.output)),
          }
        : { op: 'settle', idx: row.idx, state: 'pending', reRequest: true, from: ['waiting'] };
    return {
      op: 'settle',
      idx: row.idx,
      state: 'blocked',
      error: a.execution.error ?? 'It was refused.',
      from: ['waiting'],
    };
  }
  if (a.state === 'pending' && row.deadlineAt && now > row.deadlineAt)
    return {
      op: 'settle',
      idx: row.idx,
      state: 'failed',
      error: 'Nobody decided in time.',
      from: ['waiting'],
    };
  return null;
}
