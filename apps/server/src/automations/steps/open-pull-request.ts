import {
  type AutomationStep,
  blockedEventFields,
  type JsonObject,
  renderTemplate,
  withoutFixOutcome,
  withoutOrganization,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { ApplyContext } from '../../commit/types';
import type { Db } from '../../db/client';
import { type automationRunSteps, automationRuns, pullRequests, repos } from '../../db/schema/index';
import { postMessage } from '../../domain/messages';
import { loadConversationRow } from '../../read/conversations';
import { withTrackerLine } from '../../trackers/pr-line';
import { keyDecision } from '../authority';
import { outsidersRun } from '../runs';
import type { AutomationRunRow } from '../store';
import { requestStepApproval } from './approval';
import { automationPrincipal } from './checks';
import { block, updateStep } from './state';
import { startsRunThread } from './thread';
import type { PrAnnouncer, StepExecution } from './types';

/**
 * What a pull request step opens: its branch, title and body as they are rendered now. The step and the approval
 * guard both use it, so a pull request a person said yes to re-renders to what they approved.
 */
export async function pullRequestText(
  ctx: ApplyContext,
  run: Pick<AutomationRunRow, 'burrowId'>,
  step: Extract<AutomationStep, { kind: 'open_pull_request' }>,
  scope: Record<string, unknown>,
): Promise<{ branch: string; title: string; body: string }> {
  const branch = renderTemplate(step.branch, scope, 255);
  // A tracker report's organization stays out of the team's pull request, whatever the agents wrote (TA-18).
  const trigger = scope.trigger as { kind?: unknown; organization?: unknown } | undefined;
  const organization =
    trigger?.kind === 'tracker' && typeof trigger.organization === 'string' ? trigger.organization : null;
  const title = withoutOrganization(renderTemplate(step.title, scope, 200), organization);
  // A fix's line for the customer (TA-55) is for its notice, not the team's pull request.
  // The tracker's own line for its tooling goes before the marker that names the report (its driver's `prLine`).
  const body = await withTrackerLine(
    ctx,
    run.burrowId,
    withoutOrganization(withoutFixOutcome(renderTemplate(step.body, scope, 8000)), organization),
  );
  return { branch, title, body };
}

export async function executeOpenPullRequest(
  { ctx, run, idx, attempt, scope, publisher, base, step }: StepExecution<'open_pull_request'>,
  announcePr: PrAnnouncer,
): Promise<void> {
  const tx = ctx.tx;
  const { branch, title, body } = await pullRequestText(ctx, run, step, scope);
  const [repo] = await tx
    .select()
    .from(repos)
    .where(and(eq(repos.burrowId, run.burrowId), eq(repos.fullName, step.repo)));
  const base_ = step.base ?? repo?.defaultBranch ?? 'main';
  // Someone may have opened it already (a person, an older automation): that one is the pull request (AR-41).
  const already = await openPrFrom(tx, run.burrowId, step.repo, branch);
  if (already) {
    await useOpenPr(
      ctx,
      run,
      idx,
      step,
      already,
      {
        branch,
        body,
        publisher,
        output: alreadyOpenOutput(already, { branch, title }),
        fields: base,
      },
      announcePr,
    );
    return;
  }
  const decision = await keyDecision(tx, (await automationPrincipal(tx, run)) ?? '', publisher, 'pr.open', {
    repo: step.repo,
    branch,
  });
  const permitted = !!repo?.enabled && decision.outcome !== 'deny';
  if (!permitted) {
    if (step.otherwise === 'fail') {
      if (decision.outcome === 'deny')
        await ctx.emit({
          ...blockedEventFields(decision, ctx.actor.shortName, `open a pull request from ${branch}`),
          where: step.repo,
          payload: { runId: run.id, keyId: 'pr.open', reason: decision.reason },
        });
      return block(
        ctx,
        run,
        idx,
        repo?.enabled ? 'It may not open pull requests there.' : `${step.repo} is not switched on.`,
      );
    }
    // Not a permitted target: post what the PR would be, for a person to open.
    const posted = await postPreparedPr(ctx, run, idx, step, {
      branch,
      base: base_,
      title,
      body,
      reason: `I may not open it in ${step.repo} myself`,
      fields: base,
    });
    if (!posted) return block(ctx, run, idx, 'That conversation is gone.');
    return;
  }
  const command = {
    name: 'open_pr',
    input: {
      repo: step.repo,
      branch,
      base: base_,
      title,
      body,
      conversationId: run.conversationId,
    } as JsonObject,
  };
  if (decision.outcome === 'ask') {
    const approval = await requestStepApproval(ctx, run, step, attempt, scope, command, {
      title: `Open a pull request from ${branch}`,
      details: `${title} · into ${base_} in ${step.repo}`,
      keyId: 'pr.open',
    });
    await updateStep(
      tx,
      run.id,
      idx,
      {
        ...base,
        state: 'waiting',
        approvalId: approval.id,
        inputSummary: `Asked to open a pull request from ${branch}`,
        output: { branch, title },
      },
      ctx.now,
    );
    await tx
      .update(automationRuns)
      .set({ status: 'waiting', updatedAt: ctx.now })
      .where(eq(automationRuns.id, run.id));
    return;
  }
  // Allowed: marked running first (it reaches GitHub); the engine opens it in its own commit.
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'running',
      inputSummary: `Opening a pull request from ${branch}`,
      output: { branch, title, command },
    },
    ctx.now,
  );
  return;
}

/**
 * The pull request a person can open themselves, posted in the run's thread with why the automation didn't open it
 * (not a permitted target, or opening it failed), and the step settled as done with `opened: false`.
 */
export async function postPreparedPr(
  ctx: ApplyContext,
  run: AutomationRunRow,
  idx: number,
  step: Extract<AutomationStep, { kind: 'open_pull_request' }>,
  pr: {
    branch: string;
    base: string;
    title: string;
    body: string;
    reason: string;
    fields: Partial<typeof automationRunSteps.$inferInsert>;
  },
): Promise<boolean> {
  const conversation = await loadConversationRow(ctx.tx, run.conversationId);
  if (!conversation) return false;
  const text =
    `The pull request is ready to open (${pr.reason}):\n\nFrom ${pr.branch} into ${pr.base}\nTitle: ${pr.title}\n\n${pr.body}`.slice(
      0,
      4000,
    );
  const posted = await postMessage(ctx, {
    conversation,
    text,
    threadRootId: run.threadRootId,
    mentions: [],
    dispatch: false,
    outsidersRun: outsidersRun(run.trigger),
  });
  if (!run.threadRootId) await startsRunThread(ctx.tx, run.id, posted.id);
  await updateStep(
    ctx.tx,
    run.id,
    idx,
    {
      ...pr.fields,
      state: 'succeeded',
      finishedAt: ctx.now,
      messageIds: [posted.id],
      inputSummary: `Prepared a pull request from ${pr.branch}`,
      output: {
        opened: false,
        branch: pr.branch,
        title: pr.title,
        reason: pr.reason,
        command: null,
        text: `the pull request from ${pr.branch} into ${step.repo} is ready for a person to open (${pr.reason})`,
      },
    },
    ctx.now,
  );
  return true;
}

type OpenPrStep = Extract<AutomationStep, { kind: 'open_pull_request' }>;
type Publisher = Parameters<typeof keyDecision>[2];

/**
 * Whether an automation may post on its pull request on GitHub (RN-S3d): a GitHub repository switched on, and the
 * automation's “Comment on pull requests” or “Open pull requests” there at Can (∩ its publisher, as every step). Asks
 * or No: it doesn't, as no card is worth a comment on a pull request that is already open.
 */
export async function mayCommentOnPr(
  db: Db,
  principalId: string,
  publisher: Publisher,
  burrowId: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: repos.enabled, source: repos.source })
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), eq(repos.fullName, repo)));
  if (!row?.enabled || row.source !== 'github') return false;
  if ((await keyDecision(db, principalId, publisher, 'pr.comment', { repo })).outcome === 'allow')
    return true;
  return (await keyDecision(db, principalId, publisher, 'pr.open', { repo, branch })).outcome === 'allow';
}

/**
 * An `open_pull_request` step uses the pull request already open from its branch (AR-41). Its title and body stay as
 * whoever opened it wrote them, so its own body — the review in it — goes on it as one comment (RN-S3d): when the
 * automation may post there, the step stays `running` with the comment to post (`output.comment`) and the engine posts it
 * in its own pass, outside any transaction; otherwise it succeeds now and says where the pull request is (RN-S4).
 */
export async function useOpenPr(
  ctx: ApplyContext,
  run: AutomationRunRow,
  idx: number,
  step: OpenPrStep,
  pr: { number: number; url: string | null },
  o: {
    branch: string;
    body: string;
    publisher: Publisher | null;
    output: JsonObject;
    fields: Partial<typeof automationRunSteps.$inferInsert>;
  },
  announcePr: PrAnnouncer,
): Promise<'succeeded' | 'commenting'> {
  const tx = ctx.tx;
  const text = o.body.trim();
  const comment =
    text &&
    !o.output.commented &&
    o.publisher &&
    (await mayCommentOnPr(tx, ctx.actor.id, o.publisher, run.burrowId, step.repo, o.branch))
      ? `${text}\n\n— ${ctx.actor.name} via Whombat`
      : null;
  const inputSummary = `PR #${pr.number} was already open from ${o.branch}`;
  await tx
    .update(automationRuns)
    .set({ status: 'running', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
  if (comment) {
    await updateStep(
      tx,
      run.id,
      idx,
      {
        ...o.fields,
        state: 'running',
        prNumber: pr.number,
        inputSummary,
        output: { ...o.output, comment: { body: comment.slice(0, 8000) } },
      },
      ctx.now,
    );
    return 'commenting';
  }
  const said = await announcePr(ctx, run, step.repo, pr.number, true, idx);
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...o.fields,
      state: 'succeeded',
      finishedAt: ctx.now,
      prNumber: pr.number,
      inputSummary,
      ...(said ? { messageIds: [said] } : {}),
      output: { ...o.output, ...(said ? { announced: true } : {}) },
    },
    ctx.now,
  );
  return 'succeeded';
}

/**
 * The pull request open from `branch` in `repo`, when there is one: an `open_pull_request` step uses it instead of
 * failing on “already open” (AR-41) — a developer agent often opens it itself during its turn.
 */
export async function openPrFrom(tx: Db, burrowId: string, repo: string, branch: string) {
  const [pr] = await tx
    .select({ number: pullRequests.number, url: pullRequests.url })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.burrowId, burrowId),
        eq(repos.fullName, repo),
        eq(pullRequests.branch, branch),
        eq(pullRequests.state, 'open'),
      ),
    );
  return pr ?? null;
}

/** An `open_pull_request` step's output when it used a pull request that was already open (AR-41). */
export function alreadyOpenOutput(
  pr: { number: number; url: string | null },
  fields: { branch?: string; title?: string },
): JsonObject {
  return {
    ...fields,
    opened: true,
    alreadyOpen: true,
    prNumber: pr.number,
    text: pr.url ? `PR #${pr.number} is open: ${pr.url}` : `PR #${pr.number} is open`,
  };
}

/** After a crash: did the PR a `running` open_pull_request step was opening get opened? */
export async function openedPr(tx: Db, burrowId: string, repo: string, branch: string) {
  const [pr] = await tx
    .select({ number: pullRequests.number, url: pullRequests.url })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(eq(pullRequests.burrowId, burrowId), eq(repos.fullName, repo), eq(pullRequests.branch, branch)),
    );
  return pr ?? null;
}
