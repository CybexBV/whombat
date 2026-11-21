/**
 * An agent's push to a branch whose key asks a person first (docs/decisions/essentials-agents.md EA-05, EA-06):
 *
 * - The runner's push asks (`runtime.authorize_git`): the approval is a `push_shared_branch` of exactly the commit the
 *   runner was pushing, its card where the turn was asked (the conversation and thread), for the turn's person. Asking
 *   again for the same agent, repo and branch while one waits answers with that one.
 * - A yes (the `push_shared_branch` executor) wakes the agent where it asked (`approval_granted`) and waits: the
 *   approval shows APPROVED · PUSHING.
 * - While it waits, the git credentials route lets exactly that agent push exactly that repo, branch and commit; the
 *   push credential handed out completes it: “Allowed Dusty to push release/2.1” (the push itself is the mirror's
 *   “Pushed …”, signed by the agent).
 * - Still unused a day after the yes: it fails, and says nothing was pushed.
 */
import { type Approval, shortSha } from '@whombat/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { approvals } from '../db/schema/index';
import type { Services } from '../services';
import type { Executor } from './engine';

/** How long a yes lets the agent push before it lapses. */
export const PUSH_ALLOWANCE_MS = 24 * 60 * 60_000;

type ApprovalRow = typeof approvals.$inferSelect;

function pushOf(row: ApprovalRow) {
  return row.action.type === 'push_shared_branch' ? row.action.params : null;
}

const sameCommit = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};

/** The agent's own push requests for a repo and branch in one state, newest first. */
async function pushRequests(
  db: Db | Tx,
  where: { burrowId: string; agentId: string; repo: string; branch: string },
  state: 'pending' | 'approved',
): Promise<ApprovalRow[]> {
  return db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.burrowId, where.burrowId),
        eq(approvals.requesterId, where.agentId),
        eq(approvals.state, state),
        isNull(approvals.executedAt),
        sql`${approvals.action}->>'type' = 'push_shared_branch'`,
        sql`${approvals.action}->'params'->>'repo' = ${where.repo}`,
        sql`${approvals.action}->'params'->>'branch' = ${where.branch}`,
      ),
    )
    .orderBy(sql`${approvals.createdAt} desc`);
}

/** A push request of the agent's that still waits for a person (asking again answers with it). */
export async function waitingPushRequest(
  db: Db | Tx,
  where: { burrowId: string; agentId: string; repo: string; branch: string },
): Promise<ApprovalRow | null> {
  const [row] = await pushRequests(db, where, 'pending');
  return row ?? null;
}

/**
 * The approval that lets this push through now, or null: the agent's own `push_shared_branch` request for this repo
 * and branch, approved and waiting for its push (executing, not executed), of this commit when the runner says which.
 */
export async function pushAllowance(
  db: Db | Tx,
  push: { burrowId: string; agentId: string; repo: string; branch: string; sha?: string | null },
): Promise<string | null> {
  const rows = await pushRequests(db, push, 'approved');
  const row = rows.find((r) => {
    const p = pushOf(r);
    return r.execution.state === 'running' && !!p && (!push.sha || sameCommit(p.sha, push.sha));
  });
  return row?.id ?? null;
}

/** The yes: the agent may push now; it is woken where it asked and the approval waits for its push (deferred). */
export function pushExecutor(wake: (approval: Approval, services: Services) => Promise<void>): Executor {
  return async (approval, services) => {
    if (approval.action.type !== 'push_shared_branch') throw new Error('Not a push_shared_branch approval.');
    await wake(approval, services);
    return { deferred: true };
  };
}

/** Why an allowance lapsed (the `approval.failed` detail). */
export function pushLapsedText(agentName: string, approval: Approval): string {
  const p = approval.action.type === 'push_shared_branch' ? approval.action.params : null;
  return p
    ? `${agentName} didn’t push ${shortSha(p.sha)} to ${p.branch} within a day of the yes, so nothing was pushed. Ask ${agentName} again.`
    : 'Nothing was pushed within a day of the yes.';
}
