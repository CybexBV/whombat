/**
 * A prompt's “Merge into main when it’s done” (docs/decisions/prompts.md): the thread was told to open a pull request
 * into the default branch and get its checks passing; once its job is done Whombat merges that pull request itself, so
 * a main branch that takes no direct pushes works the same. Each watcher pass looks at the jobs that want it
 * (`t3_watches.merge` `wanted`): it waits for the checks as an automation's merge step does (`mergeReadiness`), merges
 * on GitHub with the head the checks passed on (outside any transaction), and records it in its own commit, which says
 * in the person's thread, in one line, that it merged or why it left the pull request for them.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { MERGE_WORDS, mergeHistory, mergeReadiness } from '../automations/merge';
import { mergeTarget, recordMerge } from '../commands/prs';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { type T3WatchRow, t3Watches } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { publishHandoffs } from './handoffs';
import { progressOf } from './progress';

/** How long after the job ended its pull request's checks may take before it is left for the person. */
export const PROMPT_MERGE_WAIT_MINUTES = 180;

/** How long a job's pull request may take to show (in the job and in Whombat's copy of GitHub) after the job ended. */
export const PROMPT_MERGE_GRACE_MS = 10 * 60_000;

/** At most this many jobs are looked at in one pass. */
const PER_PASS = 10;

/** What it says when there was nothing to merge; the other lines are the merge step's (`MERGE_WORDS`). */
export const PROMPT_MERGE_WORDS = {
  nothing: 'There was nothing to merge: the job didn’t open a pull request.',
} as const;

/** The outcome as the watch keeps it, and the line for the person (null: nothing to say). */
export type PromptMergeOutcome =
  | { kind: 'wait' }
  | { kind: 'merge'; repo: string; number: number; headSha: string; title: string; base: string }
  | { kind: 'merged'; text: string | null }
  | { kind: 'left'; text: string | null };

/** The T3 Code statuses of a run that ended without finishing its work: nothing is merged, and its report says why. */
const UNFINISHED = new Set(['interrupted', 'failed', 'cancelled', 'rolled_back']);

/**
 * What to do for one job that wants its work merged, from the watch and Whombat's copy of GitHub. Pure but for the
 * reads; the merge itself is the caller's.
 */
export async function promptMergeStep(db: Db, watch: T3WatchRow, now: Date): Promise<PromptMergeOutcome> {
  const ended = watch.runEndedAt;
  if (watch.state !== 'idle' || watch.told?.event !== 'finished' || !ended) return { kind: 'wait' };
  if (watch.status && UNFINISHED.has(watch.status)) return { kind: 'left', text: null };
  const pr = progressOf(watch.progress).pullRequest;
  const late = now.getTime() > ended.getTime() + PROMPT_MERGE_GRACE_MS;
  if (!pr) return late ? { kind: 'left', text: PROMPT_MERGE_WORDS.nothing } : { kind: 'wait' };
  const target = await mergeTarget(db, watch.burrowId, pr.number, pr.repo);
  if (!target && !late) return { kind: 'wait' };
  const history = target
    ? await mergeHistory(db, target.repo.id, target.row.baseBranch, target.row.id)
    : { expected: [], quiet: false };
  const ready = mergeReadiness({
    number: pr.number,
    repo: pr.repo,
    target,
    review: null,
    waitingSince: ended,
    waitMinutes: PROMPT_MERGE_WAIT_MINUTES,
    // Failed checks aren't run again: the thread already got them passing before it ended, so a failure now is real.
    rerun: null,
    now,
    ...history,
  });
  switch (ready.kind) {
    case 'wait':
      return { kind: 'wait' };
    case 'merged':
      // Someone merged it already: the job shows it, nothing to add.
      return { kind: 'merged', text: null };
    case 'rerun':
      return { kind: 'left', text: MERGE_WORDS.checksFailed(pr.number) };
    case 'fail':
      return { kind: 'left', text: ready.error };
    case 'merge': {
      if (!target) return { kind: 'wait' };
      if (target.repo.source === 'local' || target.row.localOnly)
        return { kind: 'left', text: MERGE_WORDS.failed(pr.number, 'it isn’t on GitHub.') };
      const headSha = target.row.headSha;
      return {
        kind: 'merge',
        repo: target.repo.fullName,
        number: pr.number,
        headSha,
        title: target.row.title,
        base: target.row.baseBranch,
      };
    }
  }
}

/** Merges on GitHub with a merge commit, or squashed where the repository allows no merge commits. */
async function mergeOnGitHub(
  services: Services,
  watch: T3WatchRow,
  m: Extract<PromptMergeOutcome, { kind: 'merge' }>,
  mergedBy: string,
) {
  const ask = (method: 'merge' | 'squash') =>
    services.github.mergeOutcome({
      burrowId: watch.burrowId,
      repo: m.repo,
      number: m.number,
      method,
      headSha: m.headSha,
      title: m.title,
      mergedBy,
    });
  const first = await ask('merge');
  if (first.outcome === 'refused' && /merge commits? (are|is) not allowed/i.test(first.reason))
    return { method: 'squash' as const, res: await ask('squash') };
  return { method: 'merge' as const, res: first };
}

/** Looks at the jobs that want their work merged: one pass of the watcher. */
export async function mergePromptJobs(services: Services): Promise<void> {
  const { db } = services;
  const rows = await db
    .select()
    .from(t3Watches)
    .where(and(eq(t3Watches.state, 'idle'), sql`${t3Watches.merge}->>'state' = 'wanted'`))
    .orderBy(t3Watches.runEndedAt)
    .limit(PER_PASS);
  for (const watch of rows) {
    try {
      await mergeOne(services, watch);
    } catch (err) {
      services.log.warn(
        { err: err instanceof Error ? err.message : String(err), threadId: watch.threadId },
        't3 watch: a prompt’s pull request could not be merged',
      );
    }
  }
}

async function mergeOne(services: Services, watch: T3WatchRow): Promise<void> {
  const step = await promptMergeStep(services.db, watch, services.clock());
  if (step.kind === 'wait') return;
  const key = { connectionId: watch.connectionId, threadId: watch.threadId };
  const opts = { burrowId: watch.burrowId, actorId: watch.agentId };
  if (step.kind !== 'merge') {
    await services.pipeline.commit(promptMerged, { ...key, outcome: step.kind, text: step.text }, opts);
    await publishHandoffs(services, watch.burrowId, watch.conversationId);
    return;
  }
  const agent = await loadPrincipalRow(services.db, watch.agentId);
  const { method, res } = await mergeOnGitHub(services, watch, step, agent?.name ?? 'Whombat');
  const done =
    res.outcome === 'merged' || res.outcome === 'here'
      ? {
          outcome: 'merged' as const,
          text: MERGE_WORDS.merged(step.number, step.base),
          record: { method, sha: res.outcome === 'merged' ? res.sha : null },
        }
      : {
          outcome: 'left' as const,
          text:
            res.outcome === 'refused'
              ? MERGE_WORDS.refused(step.number, res.reason)
              : MERGE_WORDS.noAnswer(step.number),
        };
  await services.pipeline.commit(promptMerged, { ...key, ...done, text: done.text.slice(0, 900) }, opts);
  await publishHandoffs(services, watch.burrowId, watch.conversationId);
}

/**
 * A prompt's merge settled: the watch says so, a merge is recorded in Whombat's copy of GitHub, and its line goes in
 * the person's thread in the agent's name. Only once: a watch no longer wanting it is left alone.
 */
export const promptMerged = defineCommand({
  name: 't3code.prompt_merged',
  schema: z.object({
    connectionId: z.string().min(1).max(64),
    threadId: z.string().min(1).max(300),
    outcome: z.enum(['merged', 'left']),
    text: z.string().min(1).max(1000).nullable(),
    record: z.object({ method: z.enum(['merge', 'squash']), sha: z.string().max(100).nullable() }).optional(),
  }),
  async apply(tx, ctx, input): Promise<{ posted: string | null }> {
    const [watch] = await tx
      .select()
      .from(t3Watches)
      .where(
        and(
          eq(t3Watches.burrowId, ctx.burrow.id),
          eq(t3Watches.connectionId, input.connectionId),
          eq(t3Watches.threadId, input.threadId),
          eq(t3Watches.agentId, ctx.actor.id),
        ),
      )
      .for('update');
    if (watch?.merge?.state !== 'wanted') return { posted: null };
    await tx
      .update(t3Watches)
      .set({ merge: { state: input.outcome, at: ctx.at } })
      .where(and(eq(t3Watches.connectionId, watch.connectionId), eq(t3Watches.threadId, watch.threadId)));
    const pr = progressOf(watch.progress).pullRequest;
    if (input.record && pr) {
      const target = await mergeTarget(tx, ctx.burrow.id, pr.number, pr.repo);
      if (target && target.row.state !== 'merged')
        await recordMerge(ctx, target, input.record.method, {
          github: { sha: input.record.sha },
          onOrigin: null,
        });
    }
    if (!input.text) return { posted: null };
    const conversation = await loadConversationRow(tx, watch.conversationId);
    if (!conversation) return { posted: null };
    // The thread it was handed over from, while it is there; else the top of the conversation.
    const root = watch.threadRootId ? await loadMessageRow(tx, watch.threadRootId) : undefined;
    const posted = await postMessage(ctx, {
      conversation,
      text: input.text,
      threadRootId: root && root.conversationId === conversation.id ? root.id : null,
      // News for the person, not a request for the agent.
      dispatch: false,
    });
    return { posted: posted.id };
  },
});
