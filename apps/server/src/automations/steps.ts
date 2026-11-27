/**
 * Step execution (docs/decisions/bp-automations.md BP-C05…C08). Every state change of a run is one commit signed by
 * the automation's principal, fenced by the engine's lease (`fence`), and does its effect in the same transaction
 * as the step's new state: the prompt message and the dispatch (outbox-style), the post, the approval request. So
 * after a crash a step either happened with its state, or not at all — except the external effects (a URL call,
 * opening a PR on GitHub), which are marked `running` with an idempotency key first and reconciled (or marked
 * `uncertain` for a person) if the process dies in between.
 */

import { type JsonObject, mailStepProblem, renderTemplate, trackerAccessAsked } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { openPr } from '../commands/agent-tools';
import { mergeTarget, recordMerge } from '../commands/prs';
import { applyContext } from '../commit/pipeline';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { approvals, automationRunSteps, automationRuns, pullRequests, repos } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { mergeOnOrigin } from '../github/local-prs';
import { conflict, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { publishHandoffs } from '../t3code/handoffs';
import { linkRunPullRequest } from '../t3code/pull-requests';
import { reportProduct } from '../trackers/connection';
import { followFix, openedLine } from '../trackers/fixes';
import { scopeReport } from '../trackers/items';
import { replyLine } from '../trackers/reply';
import { againMarkOf, goAgain } from './again';
import { assessmentOutput, assessmentReported } from './assessment';
import { keyDecision, publisherCheck } from './authority';
import { MERGE_RERUN_MAX_CHECKS, MERGE_WORDS, mergeOutputOf } from './merge';
import { type CardNames, CardNamesInput } from './proposed-card';
import { outsidersRun } from './runs';
import { CONTINUE_STEP } from './steps/approval';
import { stepRoomsCheck } from './steps/checks';
import { executeConnectionActions } from './steps/connection-actions';
import { executeCondition, executeRequestApproval, executeWait } from './steps/control';
import { executeDispatchAgent, resumeDispatchAgent } from './steps/dispatch-agent';
import { executeGitHubComment } from './steps/github-comment';
import { executeHttpCallback } from './steps/http-callback';
import { executeMergePullRequest } from './steps/merge-pull-request';
import {
  alreadyOpenOutput,
  executeOpenPullRequest,
  openPrFrom,
  postPreparedPr,
  useOpenPr,
} from './steps/open-pull-request';
import { executePostMessage } from './steps/post-message';
import { definitionStep, GateFactsInput, retryBackoffMs, stepScope, stepTimeoutMs } from './steps/scope';
import { block, lockRun, noticeOnStep, revokeTrackerAccessAfter, stopRun, updateStep } from './steps/state';
import { placeFor, postInRunThread } from './steps/thread';
import { executeTrackerDecision, executeTrackerReply, executeTrackerUpdate } from './steps/tracker';
import { queuedNoteOf, queuedSummary } from './steps/turn-words';
import {
  type AutomationRunRow,
  type AutomationStepRow,
  activeRunCount,
  loadStepRows,
  publishRun,
} from './store';

export { CONTINUE_STEP } from './steps/approval';
export { branchHead, stepBinding } from './steps/binding';
export { stepRoomsCheck } from './steps/checks';
export { dispatchResult } from './steps/dispatch-agent';
export { commentPlan, NOTHING_TO_COMMENT_ON } from './steps/github-comment';
export { alreadyOpenOutput, mayCommentOnPr, openedPr, openPrFrom } from './steps/open-pull-request';
export {
  definitionStep,
  GateFactsInput,
  retryBackoffMs,
  runScope,
  stepScope,
  stepsStartedToday,
  stepTimeoutMs,
} from './steps/scope';
export { postInRunThread } from './steps/thread';
export {
  approvalWords,
  checkoutWords,
  clipWords,
  leadingQuestion,
  ownQuestion,
  requestLine,
  stepInstructions,
  whatHappensOf,
} from './steps/words';

/* Input ----------------------------------------------------------------------------------------- */

const Fenced = z.object({ runId: z.string(), fence: z.number().int(), owner: z.string() });

export const StepOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start') }),
  z.object({
    op: z.literal('execute'),
    idx: z.number().int().nonnegative(),
    /** A condition that reads `trigger.trusted`/`assigned`/`linkedPr`: them as GitHub has them now (AR-28). */
    facts: GateFactsInput.optional(),
    /** A `connection_actions` step: the names of the ids its actions name, as the services have them now. */
    names: CardNamesInput.optional(),
  }),
  z.object({
    op: z.literal('settle'),
    idx: z.number().int().nonnegative(),
    state: z.enum(['succeeded', 'failed', 'uncertain', 'blocked', 'pending', 'skipped']),
    output: z.record(z.string(), z.unknown()).optional(),
    error: z.string().max(1000).nullable().optional(),
    /** For `pending`: a retry (attempt + 1, after a backoff). */
    retry: z.boolean().optional(),
    /** The retry's backoff counts from this attempt, not the step's first (a later try at a fix starts its own). */
    retryFrom: z.number().int().nonnegative().optional(),
    /** `request_approval`: ask again (a new approval) because the old one no longer covers it. */
    reRequest: z.boolean().optional(),
    /** The step's input summary from now on: a merge step's says what it found (“Checks failed on PR #10”, AR-46). */
    summary: z.string().max(1000).optional(),
    /** Only settle a step that is still in one of these states (compare-and-set). */
    from: z.array(z.enum(['running', 'waiting'])).default(['running', 'waiting']),
  }),
  z.object({ op: z.literal('skip'), fromIdx: z.number().int(), toIdx: z.number().int() }),
  /** An `open_pull_request` step that could not open it: post the prepared pull request instead, and why. */
  z.object({
    op: z.literal('fallback'),
    idx: z.number().int().nonnegative(),
    reason: z.string().max(500),
  }),
  z.object({
    op: z.literal('finish'),
    status: z.enum(['succeeded', 'failed', 'cancelled', 'needs_review']),
    error: z.string().max(1000).nullable(),
    /** A person said no to its card (automation-recipes.md AR-52): the run page says so, the thread hears nothing more. */
    quiet: z.boolean().optional(),
    /** The step it stopped at (`stopRun`'s `noticeOn`): its notice is kept with that step's messages. */
    idx: z.number().int().nonnegative().optional(),
  }),
  /**
   * A `merge_pull_request` step (automation-recipes.md AR-46, AR-47): from waiting for its checks to `running` when they
   * let it merge (the engine merges in the same pass), or back to waiting when they started again just before.
   */
  z.object({
    op: z.literal('merging'),
    idx: z.number().int().nonnegative(),
    state: z.enum(['running', 'waiting']),
    summary: z.string().max(1000),
  }),
  /**
   * A `merge_pull_request` step whose checks failed in GitHub Actions (automation-recipes.md AR-57): it notes what it
   * asks GitHub to run once more and keeps waiting; the engine then asks GitHub, outside any transaction.
   */
  z.object({
    op: z.literal('rerun_checks'),
    idx: z.number().int().nonnegative(),
    summary: z.string().max(1000),
    rerun: z.object({
      at: z.string().datetime(),
      checks: z
        .array(z.object({ name: z.string().max(200), url: z.string().max(2048) }))
        .max(MERGE_RERUN_MAX_CHECKS),
    }),
  }),
  /**
   * An `open_pull_request` step waiting for a person's yes whose pull request was opened meanwhile (AR-41): it uses that
   * one — and, when it may, comments its own body on it (`running` until the engine has, RN-S3d).
   */
  z.object({ op: z.literal('already_open'), idx: z.number().int().nonnegative() }),
  /**
   * A waiting agent step whose turn is queued behind another outsiders' turn says why in its summary (`note`), and only
   * what it asked again once its turn is taken (`note` null).
   */
  z.object({
    op: z.literal('turn_queue'),
    idx: z.number().int().nonnegative(),
    note: z.string().max(200).nullable(),
  }),
  /**
   * A waiting agent step whose turn handed its T3 Code wait to Whombat (docs/decisions/outsiders-turns.md), and the thread
   * finished or asks something now: the step's next turn is queued, with the same instructions. Only while `dispatchId`
   * is still the step's turn.
   */
  z.object({
    op: z.literal('turn_resume'),
    idx: z.number().int().nonnegative(),
    dispatchId: z.string(),
  }),
  /**
   * A run that would end without its fix landing goes round again (`again.ts`): its steps from `fix` (or `review`) back
   * to pending, when it still may. `max`: the most tries.
   */
  z.object({
    op: z.literal('again'),
    /** The fix branch's head as GitHub had it just before: a commit, no branch (`sha` null), or unread (null). */
    head: z.object({ sha: z.string().max(100).nullable() }).nullable(),
    max: z.number().int().positive(),
  }),
]);
export type StepOp = z.infer<typeof StepOp>;

export const StepInput = z.intersection(Fenced, StepOp);

/* The command ----------------------------------------------------------------------------------------- */

export const automationStep = defineCommand({
  name: 'automation.step',
  schema: StepInput,
  async apply(tx, ctx, input): Promise<{ status: string }> {
    const run = await lockRun(tx, input);
    const steps = await loadStepRows(tx, run.id);
    const def = run.definition;
    switch (input.op) {
      case 'start': {
        if (run.status !== 'queued') return { status: run.status };
        // A run queued again after its yes (AR-56) keeps when it first started.
        await tx
          .update(automationRuns)
          .set({ status: 'running', startedAt: run.startedAt ?? ctx.now, updatedAt: ctx.now })
          .where(eq(automationRuns.id, run.id));
        await publishRun(ctx, run.id);
        return { status: 'running' };
      }
      case 'finish': {
        await stopRun(ctx, run, input.status, input.error, {
          quiet: input.quiet === true,
          ...(input.idx !== undefined ? noticeOnStep(run, input.idx) : {}),
        });
        await publishRun(ctx, run.id);
        return { status: input.status };
      }
      case 'merging': {
        const row = steps[input.idx];
        const step = definitionStep(def, input.idx);
        const from = input.state === 'running' ? 'waiting' : 'running';
        if (row?.state !== from || step.kind !== 'merge_pull_request') return { status: 'unchanged' };
        await updateStep(tx, run.id, input.idx, { state: input.state, inputSummary: input.summary }, ctx.now);
        await tx
          .update(automationRuns)
          .set({ status: input.state, updatedAt: ctx.now })
          .where(eq(automationRuns.id, run.id));
        await publishRun(ctx, run.id);
        return { status: input.state };
      }
      case 'rerun_checks': {
        // Once per attempt: a step that already asked, or stopped waiting meanwhile, stays as it is.
        const row = steps[input.idx];
        const step = definitionStep(def, input.idx);
        if (row?.state !== 'waiting' || step.kind !== 'merge_pull_request' || mergeOutputOf(row.output).rerun)
          return { status: 'unchanged' };
        await updateStep(
          tx,
          run.id,
          input.idx,
          { inputSummary: input.summary, output: { ...(row.output as JsonObject), rerun: input.rerun } },
          ctx.now,
        );
        await publishRun(ctx, run.id);
        return { status: 'rerun' };
      }
      case 'turn_queue': {
        const row = steps[input.idx];
        if (row?.state !== 'waiting' || row.kind !== 'dispatch_agent') return { status: 'unchanged' };
        const noted = queuedNoteOf(row.output);
        if ((noted?.note ?? null) === input.note) return { status: 'unchanged' };
        const asked = noted?.asked ?? row.inputSummary;
        const { queuedBehind: _noted, ...output } = row.output as JsonObject;
        await updateStep(
          tx,
          run.id,
          input.idx,
          input.note
            ? {
                inputSummary: queuedSummary(asked, input.note),
                output: { ...output, queuedBehind: { note: input.note, asked } },
              }
            : { inputSummary: asked, output },
          ctx.now,
        );
        await publishRun(ctx, run.id);
        return { status: input.note ? 'queued' : 'taken' };
      }
      case 'turn_resume': {
        const row = steps[input.idx];
        if (row?.state !== 'waiting' || row.kind !== 'dispatch_agent' || row.dispatchId !== input.dispatchId)
          return { status: 'unchanged' };
        const resumed = await resumeDispatchAgent(ctx, run, row);
        if (!resumed) return { status: 'unchanged' };
        await publishRun(ctx, run.id);
        return { status: 'resumed' };
      }
      case 'skip': {
        await tx
          .update(automationRunSteps)
          .set({ state: 'skipped', finishedAt: ctx.now, updatedAt: ctx.now })
          .where(
            and(
              eq(automationRunSteps.runId, run.id),
              sql`${automationRunSteps.idx} >= ${input.fromIdx} and ${automationRunSteps.idx} < ${input.toIdx}`,
              eq(automationRunSteps.state, 'pending'),
            ),
          );
        await publishRun(ctx, run.id);
        return { status: run.status };
      }
      case 'settle': {
        const row = steps[input.idx];
        if (!row || !input.from.includes(row.state as 'running' | 'waiting')) return { status: 'unchanged' };
        const step = definitionStep(def, input.idx);
        if (
          input.reRequest &&
          (step.kind === 'request_approval' ||
            step.kind === 'dispatch_agent' ||
            step.kind === 'github_comment' ||
            step.kind === 'tracker_update' ||
            step.kind === 'tracker_reply' ||
            step.kind === 'merge_pull_request' ||
            step.kind === 'connection_actions')
        ) {
          await executeStep(ctx, run, steps, input.idx, row.attempt + 1);
        } else if (input.state === 'pending') {
          // A note that its turn waited goes with the attempt.
          const noted = queuedNoteOf(row.output);
          const { queuedBehind: _noted, ...kept } = row.output as JsonObject;
          // A card of proposed connection actions tried again starts fresh: no earlier yes, and its names read again
          // from where the calls go now; only what the caller says (which connections changed since the yes) stays.
          const fresh = step.kind === 'connection_actions';
          await updateStep(
            tx,
            run.id,
            input.idx,
            {
              ...(fresh
                ? { output: (input.output ?? {}) as JsonObject }
                : noted
                  ? { inputSummary: noted.asked, output: kept }
                  : {}),
              state: 'pending',
              attempt: row.attempt + 1,
              error: input.error ?? null,
              wakeAt: input.retry
                ? new Date(ctx.now.getTime() + retryBackoffMs(row.attempt - (input.retryFrom ?? 0)))
                : null,
              dispatchId: null,
              approvalId: null,
            },
            ctx.now,
          );
        } else {
          const output = { ...(row.output as JsonObject), ...((input.output ?? {}) as JsonObject) };
          // A note that its turn waited behind another ends with the wait: the summary is what it asked again.
          const noted = queuedNoteOf(output);
          delete output.queuedBehind;
          // An assessment step's result (AR-25): what the agent reported in its turn (the last report, read here under
          // the run's lock so one that just arrived counts), else `unassessed()` — nothing follows from no answer.
          if (step.kind === 'dispatch_agent' && step.assessment && input.state === 'succeeded') {
            // Its turn reported none: what follows is nothing, and a report's run tells the person (`unlanded.ts`).
            if (!assessmentReported(output.assessment)) output.unassessed = true;
            output.assessment = assessmentOutput(output.assessment);
          }
          // A pull request step that opened (or found) its pull request says where it is, once (RN-S4).
          let said: string | null = null;
          // A reply that went says so in the thread, quoted as the customer got it (TA-27).
          if (
            step.kind === 'tracker_reply' &&
            input.state === 'succeeded' &&
            output.sent === true &&
            typeof output.message === 'string' &&
            !output.announced
          ) {
            said = await postInRunThread(
              ctx,
              run,
              replyLine(
                typeof output.number === 'number' ? output.number : 0,
                typeof output.status === 'string' ? output.status : null,
                output.message,
              ).slice(0, 12_000),
            );
            if (said) output.announced = true;
          }
          if (
            step.kind === 'connection_actions' &&
            input.state === 'succeeded' &&
            output.ran === true &&
            typeof output.summary === 'string' &&
            !output.announced
          ) {
            said = await postInRunThread(ctx, run, output.summary.slice(0, 2000));
            if (said) output.announced = true;
          }
          if (
            step.kind === 'open_pull_request' &&
            input.state === 'succeeded' &&
            output.opened === true &&
            typeof output.prNumber === 'number' &&
            !output.announced
          ) {
            said = await announcePr(
              ctx,
              run,
              step.repo,
              output.prNumber,
              output.alreadyOpen === true,
              input.idx,
            );
            if (said) output.announced = true;
          }

          await updateStep(
            tx,
            run.id,
            input.idx,
            {
              state: input.state,
              output,
              error: input.state === 'skipped' ? null : (input.error ?? null),
              ...(input.summary
                ? { inputSummary: input.summary }
                : input.state === 'skipped' && input.error
                  ? { inputSummary: input.error }
                  : noted
                    ? { inputSummary: noted.asked }
                    : {}),
              finishedAt: input.state === 'uncertain' ? null : ctx.now,
              // Added to the step's messages, never in their place (`updateStep`).
              messageIds: [
                ...(Array.isArray(input.output?.messageIds) ? (input.output.messageIds as string[]) : []),
                ...(said ? [said] : []),
              ],
              ...(typeof input.output?.prNumber === 'number' ? { prNumber: input.output.prNumber } : {}),
            },
            ctx.now,
          );
          if (input.state === 'uncertain')
            await stopRun(ctx, run, 'needs_review', input.error ?? null, noticeOnStep(run, input.idx));
          // A no that lets it go on puts the run back among those that take a place, as a yes does (`continueStep`,
          // AR-56); a no that stops it ends it instead.
          if (
            step.kind === 'request_approval' &&
            input.state === 'succeeded' &&
            (run.status === 'waiting' || run.status === 'running') &&
            !(output.decision === 'declined' && step.onDecline === 'stop') &&
            (await activeRunCount(tx, run.automationId, run.id)) >= def.limits.maxConcurrentRuns
          )
            await tx
              .update(automationRuns)
              .set({ status: 'queued', updatedAt: ctx.now })
              .where(eq(automationRuns.id, run.id));
        }
        // The organization access lives as long as the step's attempt (TA-10).
        if (trackerAccessAsked(step)) revokeTrackerAccessAfter(ctx, run);
        await tx.update(automationRuns).set({ updatedAt: ctx.now }).where(eq(automationRuns.id, run.id));
        await publishRun(ctx, run.id);
        return { status: input.state };
      }
      case 'fallback': {
        const row = steps[input.idx];
        const step = definitionStep(def, input.idx);
        if (!row || !['running', 'waiting'].includes(row.state) || step.kind !== 'open_pull_request')
          return { status: 'unchanged' };
        const out = row.output as {
          branch?: string;
          title?: string;
          command?: { input?: JsonObject } | null;
        };
        const cmd = (out.command?.input ?? {}) as { base?: string; body?: string };
        const posted = await postPreparedPr(ctx, run, input.idx, step, {
          branch: String(out.branch ?? ''),
          base: cmd.base ?? step.base ?? 'main',
          title: String(out.title ?? ''),
          body: cmd.body ?? '',
          reason: input.reason,
          fields: { finishedAt: ctx.now },
        });
        if (!posted) {
          await block(ctx, run, input.idx, 'That conversation is gone.');
          await publishRun(ctx, run.id);
          return { status: 'blocked' };
        }
        await tx.update(automationRuns).set({ updatedAt: ctx.now }).where(eq(automationRuns.id, run.id));
        await publishRun(ctx, run.id);
        return { status: 'succeeded' };
      }
      case 'already_open': {
        const row = steps[input.idx];
        const step = definitionStep(def, input.idx);
        if (row?.state !== 'waiting' || step.kind !== 'open_pull_request') return { status: 'unchanged' };
        const branch = String((row.output as { branch?: string }).branch ?? '');
        const pr = await openPrFrom(tx, run.burrowId, step.repo, branch);
        if (!pr) return { status: 'unchanged' };
        const who = await publisherCheck(tx, run.burrowId, run.publishedById);
        const scope = await stepScope(tx, run, steps, ctx.now);
        const used = await useOpenPr(
          ctx,
          run,
          input.idx,
          step,
          pr,
          {
            branch,
            body: renderTemplate(step.body, scope, 8000),
            publisher: who.ok ? who.publisher : null,
            output: { ...(row.output as JsonObject), ...alreadyOpenOutput(pr, {}) },
            fields: {},
          },
          announcePr,
        );
        await publishRun(ctx, run.id);
        return { status: used };
      }
      case 'again':
        return goAgain(ctx, run, steps, input);
      case 'execute': {
        const row = steps[input.idx];
        if (row?.state !== 'pending') return { status: 'unchanged' };
        if (row.wakeAt && row.wakeAt > ctx.now) return { status: 'pending' };
        await executeStep(ctx, run, steps, input.idx, row.attempt, input.facts, input.names);
        await publishRun(ctx, run.id);
        return { status: 'executed' };
      }
    }
  },
});

/** Runs one step's effect in the command's transaction. */
export async function executeStep(
  ctx: ApplyContext,
  run: AutomationRunRow,
  steps: AutomationStepRow[],
  idx: number,
  attempt: number,
  facts?: z.infer<typeof GateFactsInput>,
  names?: CardNames,
): Promise<void> {
  const tx = ctx.tx;
  const step = definitionStep(run.definition, idx);
  const scope = await stepScope(tx, run, steps, ctx.now);
  const deadlineAt = new Date(ctx.now.getTime() + stepTimeoutMs(step));
  // One key per operation, the same on every retry: a receiver that acted on an earlier try and still answered with an
  // error can tell the next one is the same call.
  const idempotencyKey = `${run.id}:${step.id}`;
  const base = { attempt, startedAt: ctx.now, deadlineAt, idempotencyKey, error: null, wakeAt: null };

  // Authority, immediately before the step: the publisher is still allowed, and still in the run's room (where its
  // trigger came from) and in every room whose content goes into or comes out of this step (BP-C20).
  const who = await publisherCheck(tx, run.burrowId, run.publishedById);
  if (!who.ok) return block(ctx, run, idx, who.reason);
  const publisher = who.publisher;
  const inRooms = await stepRoomsCheck(tx, run, idx, publisher);
  if (!inRooms.ok) return block(ctx, run, idx, inRooms.reason);
  if (run.trigger.kind === 'mail' || run.definition.triggers.some((t) => t.kind === 'mail')) {
    const unsafe = mailStepProblem(step);
    if (unsafe) return block(ctx, run, idx, unsafe);
  }
  const execution = { ctx, run, steps, idx, attempt, scope, publisher, base };
  switch (step.kind) {
    case 'dispatch_agent':
      return executeDispatchAgent({ ...execution, step });
    case 'post_message':
      return executePostMessage({ ...execution, step });
    case 'request_approval':
      return executeRequestApproval({ ...execution, step });
    case 'wait':
      return executeWait({ ...execution, step });
    case 'condition':
      return executeCondition({ ...execution, step, facts });
    case 'open_pull_request':
      return executeOpenPullRequest({ ...execution, step }, announcePr);
    case 'github_comment':
      return executeGitHubComment({ ...execution, step });
    case 'tracker_update':
      return executeTrackerUpdate({ ...execution, step });
    case 'tracker_reply':
      return executeTrackerReply({ ...execution, step });
    case 'tracker_decision':
      return executeTrackerDecision({ ...execution, step });
    case 'merge_pull_request':
      return executeMergePullRequest({ ...execution, step });
    case 'http_callback':
      return executeHttpCallback({ ...execution, step });
    case 'connection_actions':
      return executeConnectionActions({ ...execution, step, ...(names ? { names } : {}) });
  }
}

/* Deferred commands and integrations -------------------------------------------------------------- */

/** What an approved `request_approval` step runs (through the approvals engine, with the approval's id). */
export const continueStep = defineCommand({
  name: CONTINUE_STEP,
  schema: z.object({
    runId: z.string(),
    stepId: z.string(),
    attempt: z.number().int().nonnegative(),
    proposal: z.object({ title: z.string(), details: z.string() }),
    actionsHash: z.string().optional(),
  }),
  async apply(tx, ctx, input) {
    if (!ctx.approvalId) throw conflict('Only an approval continues an automation.');
    const [run] = await tx
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, input.runId))
      .for('update');
    if (!run || run.burrowId !== ctx.burrow.id) throw notFound('Automation run');
    const [step] = await tx
      .select()
      .from(automationRunSteps)
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.stepId, input.stepId)));
    if (
      !step ||
      step.approvalId !== ctx.approvalId ||
      step.state !== 'waiting' ||
      step.attempt !== input.attempt
    )
      throw conflict('This automation run is no longer waiting for this approval.');
    if (!['running', 'waiting'].includes(run.status))
      throw conflict('This automation run isn’t going any more.');
    const [approval] = await tx.select().from(approvals).where(eq(approvals.id, ctx.approvalId));
    const kind = run.definition.steps[step.idx]?.kind;
    if (kind === 'tracker_reply') {
      // A person let it reply to the customer (its key asks, or the reply needed a look, TA-27, TA-28): it sends now.
      await updateStep(
        tx,
        run.id,
        step.idx,
        {
          state: 'pending',
          output: {
            ...(step.output as JsonObject),
            replyApprovalId: ctx.approvalId,
            decidedById: approval?.decidedById ?? null,
          },
        },
        ctx.now,
      );
    } else if (kind === 'tracker_update') {
      // A person let it write to the tracker (its key asks, TA-12): the step writes now, with this approval.
      await updateStep(
        tx,
        run.id,
        step.idx,
        {
          state: 'pending',
          output: {
            ...(step.output as JsonObject),
            writeApprovalId: ctx.approvalId,
            decidedById: approval?.decidedById ?? null,
          },
        },
        ctx.now,
      );
    } else if (kind === 'merge_pull_request') {
      // A person let it merge (its key asks, AR-45): the step waits for the checks now, with this approval.
      await updateStep(
        tx,
        run.id,
        step.idx,
        {
          state: 'pending',
          output: {
            ...(step.output as JsonObject),
            mergeApprovalId: ctx.approvalId,
            decidedById: approval?.decidedById ?? null,
          },
        },
        ctx.now,
      );
    } else if (kind === 'github_comment') {
      // A person let it comment on GitHub (its key asks): the step comments now, with this approval.
      await updateStep(
        tx,
        run.id,
        step.idx,
        {
          state: 'pending',
          output: {
            ...(step.output as JsonObject),
            commentApprovalId: ctx.approvalId,
            decidedById: approval?.decidedById ?? null,
          },
        },
        ctx.now,
      );
    } else if (kind === 'connection_actions') {
      // A person approved the proposed connection actions on the card: the step now moves to running.
      await updateStep(
        tx,
        run.id,
        step.idx,
        {
          state: 'pending',
          output: {
            ...(step.output as JsonObject),
            actionsApprovalId: ctx.approvalId,
            decidedById: approval?.decidedById ?? null,
          },
        },
        ctx.now,
      );
    } else if (kind === 'dispatch_agent') {
      // A person let the agent work on its branch (BP-C26): the step asks the agent now, with this approval.
      await updateStep(
        tx,
        run.id,
        step.idx,
        {
          state: 'pending',
          output: {
            ...(step.output as JsonObject),
            branchApprovalId: ctx.approvalId,
            decidedById: approval?.decidedById ?? null,
          },
        },
        ctx.now,
      );
    } else
      await updateStep(
        tx,
        run.id,
        step.idx,
        {
          state: 'succeeded',
          finishedAt: ctx.now,
          output: {
            ...(step.output as JsonObject),
            decision: 'approved',
            decidedById: approval?.decidedById ?? null,
          },
        },
        ctx.now,
      );
    // The yes puts the run back among those that take a place (AR-56): while the others fill every place, it waits its
    // turn, and the engine starts it as it starts any queued run.
    const full =
      (await activeRunCount(tx, run.automationId, run.id)) >= run.definition.limits.maxConcurrentRuns;
    await tx
      .update(automationRuns)
      .set({ status: full ? 'queued' : 'running', updatedAt: ctx.now })
      .where(eq(automationRuns.id, run.id));
    await ctx.emit({
      type: 'automation.step.approved',
      kind: 'System',
      text: null,
      where: null,
      approvalId: ctx.approvalId,
      payload: { runId: run.id, stepId: step.stepId, approvalId: ctx.approvalId },
    });
    await publishRun(ctx, run.id);
    const services = ctx.services;
    ctx.after(async () => services.automations.nudge());
    return { runId: run.id };
  },
});

/**
 * An allowed `open_pull_request` step: runs the existing `open_pr` command's own rules and effect in this commit,
 * as the automation (so a person opening a PR and an automation opening one are the same code), and settles the
 * step. The keys decision (grants ∩ publisher) is taken again here, under the lock.
 */
/** How long a pull request's screenshots part may be: the rest of its body keeps room under GitHub's limit. */
const SHOTS_PART_MAX = 6000;
/** The longest body `open_pull_request` takes. */
const OPEN_PR_BODY_MAX = 20_000;

/** A pull request's body with its screenshots (TA-52) after what the step wrote, within `open_pr`'s limit. */
function withShots<T extends { body: string }>(cmd: T, shots: string | undefined): T {
  if (!shots) return cmd;
  const room = OPEN_PR_BODY_MAX - shots.length - 2;
  return { ...cmd, body: `${cmd.body.slice(0, Math.max(0, room)).trimEnd()}\n\n${shots}` };
}

export const openPrStep = defineCommand({
  name: 'automation.open_pr',
  schema: z.intersection(
    Fenced,
    // `shots`: the pull request's screenshots, read from GitHub just before (TA-52), added to its body.
    z.object({ idx: z.number().int().nonnegative(), shots: z.string().max(SHOTS_PART_MAX).optional() }),
  ),
  async apply(tx, ctx, input) {
    const run = await lockRun(tx, input);
    const steps = await loadStepRows(tx, run.id);
    const row = steps[input.idx];
    if (row?.state !== 'running') return { status: 'unchanged' };
    const command = (row.output as { command?: { input: JsonObject } }).command;
    if (!command) throw conflict('Nothing to open.');
    const who = await publisherCheck(tx, run.burrowId, run.publishedById);
    const refused = !who.ok
      ? who.reason
      : await stepRoomsCheck(tx, run, input.idx, who.publisher).then((r) => (r.ok ? null : r.reason));
    if (!who.ok || refused) {
      await block(ctx, run, input.idx, refused ?? 'It may no longer do this.');
      await publishRun(ctx, run.id);
      return { status: 'blocked' };
    }
    const cmd = withShots(openPr.schema.parse(command.input), input.shots);
    const step = definitionStep(run.definition, input.idx);
    if (step.kind !== 'open_pull_request') return { status: 'unchanged' };
    // Opened meanwhile (by a person, or an older automation): nothing to open, and no key needed to use it (AR-41).
    const already = await openPrFrom(tx, run.burrowId, cmd.repo, cmd.branch);
    if (already) {
      const used = await useOpenPr(
        ctx,
        run,
        input.idx,
        step,
        already,
        {
          branch: cmd.branch,
          body: cmd.body,
          publisher: who.publisher,
          output: { ...(row.output as JsonObject), command: null, ...alreadyOpenOutput(already, {}) },
          fields: {},
        },
        announcePr,
      );
      await publishRun(ctx, run.id);
      return { status: used };
    }
    const requirement = openPr.requiredKey
      ? await openPr.requiredKey(cmd, {
          db: tx,
          services: ctx.services,
          burrow: ctx.burrow,
          actor: ctx.actor,
        })
      : null;
    const decision = await keyDecision(tx, ctx.actor.id, who.publisher, 'pr.open', requirement?.scope);
    if (decision.outcome !== 'allow') {
      await block(ctx, run, input.idx, 'It may no longer open pull requests there.');
      await publishRun(ctx, run.id);
      return { status: 'blocked' };
    }
    const opened = await openPr.apply(tx, applyContext(ctx, { ...ctx, decision, requirement }), cmd);
    const [pr] = await tx
      .select({ number: pullRequests.number, url: pullRequests.url })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.burrowId, ctx.burrow.id),
          eq(repos.fullName, cmd.repo),
          eq(pullRequests.number, opened.number),
        ),
      );
    // Where it is, in the run's thread (RN-S4).
    const said = pr ? await announcePr(ctx, run, cmd.repo, pr.number, false, input.idx) : null;
    await updateStep(
      tx,
      run.id,
      input.idx,
      {
        state: 'succeeded',
        finishedAt: ctx.now,
        prNumber: pr?.number ?? null,
        ...(said ? { messageIds: [said] } : {}),
        output: {
          ...(row.output as JsonObject),
          command: null,
          opened: true,
          prNumber: pr?.number ?? null,
          text: pr ? `PR #${pr.number} is open: ${pr.url}` : 'the pull request is open',
          ...(said ? { announced: true } : {}),
        },
      },
      ctx.now,
    );
    await publishRun(ctx, run.id);
    return { status: 'succeeded' };
  },
});

/**
 * A merge step's merge is done (automation-recipes.md AR-47): GitHub merged it (`github`: the engine's call, outside any
 * transaction), it is Whombat's own pull request (`here`), or its repository is kept on this Whombat (`origin`: merged
 * in its origin now, as merge_pr does; a refusal rolls this back). The mirror says merged by the automation
 * (`recordMerge`, unless the poller got there first), the step succeeds with “Merged PR #10 into main.”, and the
 * automation says that one line in the run's thread. AR-42 then deletes the branch.
 */
export const mergePrStep = defineCommand({
  name: 'automation.merge_pr',
  schema: z.intersection(
    Fenced,
    z.object({
      idx: z.number().int().nonnegative(),
      via: z.enum(['github', 'here', 'origin']),
      sha: z.string().max(64).nullable().default(null),
    }),
  ),
  async apply(tx, ctx, input) {
    const run = await lockRun(tx, input);
    const steps = await loadStepRows(tx, run.id);
    const row = steps[input.idx];
    const step = definitionStep(run.definition, input.idx);
    if (row?.state !== 'running' || step.kind !== 'merge_pull_request') return { status: 'unchanged' };
    const out = mergeOutputOf(row.output);
    const target = out.number ? await mergeTarget(tx, ctx.burrow.id, out.number, step.repo) : null;
    if (!target) throw notFound('Pull request');
    if (target.row.state !== 'merged') {
      const onOrigin =
        input.via === 'origin'
          ? await mergeOnOrigin(ctx, { repo: target.repo, pr: target.pr, method: step.method })
          : null;
      await recordMerge(ctx, target, step.method, {
        github: input.via === 'github' ? { sha: input.sha } : null,
        onOrigin,
      });
    }
    const text = MERGE_WORDS.merged(target.row.number, target.row.baseBranch);
    const place = await placeFor(ctx, run, { conversation: 'run', thread: 'run' });
    const conversation = await loadConversationRow(tx, place.conversationId);
    const posted = conversation
      ? await postMessage(ctx, {
          conversation,
          text,
          threadRootId: place.threadRootId,
          mentions: [],
          dispatch: false,
          outsidersRun: outsidersRun(run.trigger),
        })
      : null;
    if (posted && place.startsThread)
      await tx.update(automationRuns).set({ threadRootId: posted.id }).where(eq(automationRuns.id, run.id));
    await updateStep(
      tx,
      run.id,
      input.idx,
      {
        state: 'succeeded',
        finishedAt: ctx.now,
        prNumber: target.row.number,
        ...(posted ? { messageIds: [posted.id] } : {}),
        output: { ...(row.output as JsonObject), merged: true, text },
      },
      ctx.now,
    );
    await tx
      .update(automationRuns)
      .set({ status: 'running', updatedAt: ctx.now })
      .where(eq(automationRuns.id, run.id));
    await publishRun(ctx, run.id);
    return { status: 'succeeded' };
  },
});

/**
 * Where the pull request is, said once in the run's thread when its step opened or found it (RN-S4): “Opened [PR
 * #52](…).” or “[PR #52](…) was already open.” A run from a tracker report adds that the tracker isn't told and who
 * sets its status — or, when the automation replies to the customer at Can, when the customer hears (report-trackers.md
 * TA-36) — and its fix is followed from now (TA-29). The message's id, or null when the run's room can't take it (gone,
 * archived).
 */
async function announcePr(
  ctx: ApplyContext,
  run: AutomationRunRow,
  repo: string,
  number: number,
  alreadyOpen: boolean,
  idx: number,
): Promise<string | null> {
  const url = await prUrlOf(ctx.tx, run.burrowId, repo, number);
  // A real run's fix for a tracker report is followed until the customer can try it (report-trackers.md TA-29).
  if (!run.test) await followFix(ctx.tx, run, { repo, number, url, stepIdx: idx, now: ctx.now });
  // The job of the T3 Code thread that worked on its branch shows it, its checks and its merge (t3code.md T3-47).
  const jobs = await linkRunPullRequest(ctx.tx, run, { repo, number }, ctx.now);
  if (jobs.length) {
    const services = ctx.services;
    ctx.after(async () => {
      for (const conversationId of jobs) await publishHandoffs(services, run.burrowId, conversationId);
    });
  }
  // A later try finds the pull request its thread already heard about: nothing more to say there.
  if (alreadyOpen && (await prSaidBefore(ctx.tx, run.id, number))) return null;
  const link = url ? `[PR #${number}](${url})` : `PR #${number}`;
  const report = scopeReport(run.scope);
  const product = report
    ? await reportProduct(ctx.services, ctx.tx, report.connectionId, report.reportId)
    : '';
  // An automation that replies to the customer at Can says when they hear (report-trackers.md TA-36).
  const replies = run.test ? null : await openedLine(ctx.tx, run, repo, link, alreadyOpen);
  return postInRunThread(
    ctx,
    run,
    replies ??
      [
        alreadyOpen ? `${link} was already open.` : `Opened ${link}.`,
        ...(report
          ? [
              `${product.charAt(0).toUpperCase()}${product.slice(1)} isn’t told about it; you can set #${report.number}’s status on the run page.`,
            ]
          : []),
      ].join(' '),
  );
}

/** Whether an earlier try of the run already said where pull request `number` is (`again.ts`). */
async function prSaidBefore(db: Db, runId: string, number: number): Promise<boolean> {
  const [fix] = await db
    .select({ output: automationRunSteps.output })
    .from(automationRunSteps)
    .where(and(eq(automationRunSteps.runId, runId), eq(automationRunSteps.stepId, 'fix')));
  return againMarkOf(fix?.output)?.prSaid === number;
}

/** The address of a pull request the burrow mirrors (null: not mirrored, or GitHub gave none). */
async function prUrlOf(db: Db, burrowId: string, repo: string, number: number): Promise<string | null> {
  const [pr] = await db
    .select({ url: pullRequests.url })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(eq(pullRequests.burrowId, burrowId), eq(repos.fullName, repo), eq(pullRequests.number, number)),
    );
  return pr?.url ?? null;
}
