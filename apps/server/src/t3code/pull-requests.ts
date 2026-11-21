/**
 * Pull requests of jobs handed to T3 Code that the thread didn't open itself (docs/decisions/t3code.md T3-47): an
 * automation's `open_pull_request` step opens the pull request from the branch its own T3 Code thread worked on, and it
 * becomes that job's, so the job shows Pull request, Checks and Merged as it does for one the thread opened. Written in
 * the step's own commit; whoever has the conversation open gets its hand-overs after it.
 */
import type { AutomationDefinition } from '@whombat/core';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { pullRequests, repos, t3Watches } from '../db/schema/index';
import { linkPullRequest, progressOf } from './progress';

/** At most this many jobs take one pull request (the threads of a run that worked on its branch). */
const JOBS_MAX = 5;

/**
 * The watch's progress is still what it was read as: a write made from an older read would undo a newer change (a new
 * hand-over starting the job anew, a pull request linked to it).
 */
export const sameProgress = (progress: unknown) =>
  progress === null || progress === undefined
    ? isNull(t3Watches.progress)
    : sql`${t3Watches.progress} = ${JSON.stringify(progress)}::jsonb`;

/** Where an automation's run hands work over: its own conversation and the ones its agent steps name. */
function placesOf(run: { conversationId: string; definition: AutomationDefinition }): string[] {
  const named = run.definition.steps.flatMap((s) =>
    s.kind === 'dispatch_agent' && s.conversation !== 'run' ? [s.conversation] : [],
  );
  return [...new Set([run.conversationId, ...named])];
}

/**
 * Links the pull request an automation's step opened (or found open) in `repo` to the jobs of the T3 Code threads its
 * run handed work to on that pull request's branch: same places, handed over since the run began, the branch T3 Code
 * says the thread works on. A job with a pull request of its own keeps it. Returns the conversations whose hand-overs
 * changed (to send after the commit).
 */
export async function linkRunPullRequest(
  tx: Db | Tx,
  run: {
    burrowId: string;
    conversationId: string;
    createdAt: Date;
    definition: AutomationDefinition;
  },
  pr: { repo: string; number: number },
  now: Date,
): Promise<string[]> {
  const [row] = await tx
    .select({ branch: pullRequests.branch, url: pullRequests.url })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.burrowId, run.burrowId),
        eq(repos.fullName, pr.repo),
        eq(pullRequests.number, pr.number),
      ),
    );
  const branch = row?.branch.trim();
  if (!branch || !row?.url) return [];
  const jobs = await tx
    .select()
    .from(t3Watches)
    .where(
      and(
        eq(t3Watches.burrowId, run.burrowId),
        inArray(t3Watches.conversationId, placesOf(run)),
        gte(t3Watches.armedAt, run.createdAt),
        // A council's and a checklist's threads show on their own cards, which link their own pull requests.
        isNull(t3Watches.councilId),
        isNull(t3Watches.delegationTaskId),
        sql`${t3Watches.progress}->>'branch' = ${branch}`,
      ),
    )
    .limit(JOBS_MAX)
    // Held until the step's commit: the watcher's next write of a job's progress then sees the link (`sameProgress`).
    .for('update');
  const changed = new Set<string>();
  for (const job of jobs) {
    const before = progressOf(job.progress);
    const after = linkPullRequest(before, { repo: pr.repo, number: pr.number, url: row.url }, now);
    if (after === before) continue;
    const linked = await tx
      .update(t3Watches)
      .set({ progress: after })
      .where(and(eq(t3Watches.connectionId, job.connectionId), eq(t3Watches.threadId, job.threadId)))
      .returning({ conversationId: t3Watches.conversationId });
    for (const l of linked) changed.add(l.conversationId);
  }
  return [...changed];
}
