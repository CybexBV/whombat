/**
 * Recording a deploy (docs/decisions/review-features.md RF-02; contracts 0.55.0 CT-296, CT-297), through the commit
 * pipeline:
 *
 * - `deploy.record` — an agent's `record_deploy`: no key (recording isn't deploying: the deploy itself went by its own
 *   keys), for the turn it is called in (the MCP adapter passes its dispatch). The run is the one named (the agent's
 *   own), else the turn's run. The `deploy` card goes in the turn's thread when the agent may post there.
 * - `deploy.record_job` — the GitHub Actions deploy executor's outcome (`github/deploy.ts`), once per approval: by the
 *   person whose yes ran the job (the requester when nobody had to say yes), its card posted by the requester where the
 *   approval card is.
 *
 * Both: names normalized (`normalizeDeployName`) and keyed for grouping (`deployGroupKey`), `previousId` the deploy of
 * the same service and environment that succeeded before, a signed `deploy.recorded` (`Code`; ids, names, status, how
 * and sha, never the summary or the URL), and `deployment.recorded` on the burrow topic with the conversation and
 * message.
 */
import {
  DEPLOYS_SECTION,
  type DeployCard,
  DeployEnvironmentName,
  type DeploymentHow,
  type DeploymentStatus,
  DeployRef,
  DeployServiceName,
  DeploySha,
  DeployUrl,
  DispatchId,
  deployGroupKey,
  deployLine,
  newId,
  RecordDeployInput,
  RepoFullName,
  topics,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import { approvals, deployments, dispatches, messages, runs } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { dispatchRun } from '../runtime/dispatch-scope';
import { type DeploymentRow, lastSucceeded, toDeployment } from './store';

/** How a GitHub Actions run ended, after “The deploy run on GitHub Actions”. */
const DEPLOY_ENDINGS: Readonly<Record<string, string>> = {
  failure: 'failed',
  cancelled: 'was cancelled',
  timed_out: 'took too long',
  action_required: 'is waiting for someone on GitHub',
  startup_failure: 'couldn’t start',
  stale: 'was dropped by GitHub',
  skipped: 'was skipped',
  neutral: 'ended without a result',
};

/** Trimmed, whitespace collapsed (`normalizeDeployName`), within the contract's limits. */
function name(schema: typeof DeployEnvironmentName | typeof DeployServiceName, value: string): string {
  return schema.parse(value.trim().replace(/\s+/g, ' '));
}

interface Recorded {
  deploymentId: string;
  previousId: string | null;
  messageId: string | null;
}

interface DeployFacts {
  environment: string;
  service: string;
  status: DeploymentStatus;
  how: DeploymentHow;
  summary: string;
  repo: string | null;
  ref: string | null;
  sha: string | null;
  url: string | null;
  byId: string;
  runId: string | null;
  dispatchId: string | null;
  approvalId: string | null;
  /** Where the card goes (posted as the actor), or none. */
  card: { conversationId: string; threadRootId: string | null } | null;
}

/** Records it, posts the card, signs and publishes. */
async function record(ctx: ApplyContext, facts: DeployFacts): Promise<Recorded> {
  const environmentKey = deployGroupKey(facts.environment);
  const serviceKey = deployGroupKey(facts.service);
  const previousId = await lastSucceeded(ctx.tx, ctx.burrow.id, environmentKey, serviceKey);
  const id = newId('deployment');
  const sha = facts.sha?.toLowerCase() ?? null;
  const card: DeployCard = {
    kind: 'deploy',
    deploymentId: id,
    environment: facts.environment,
    service: facts.service,
    status: facts.status,
    sha,
    url: facts.url,
    ...(facts.runId ? { runId: facts.runId } : {}),
  };
  // The card: where the turn (or the approval) is, in the burrow. Quiet: it wakes nobody.
  let place: { conversationId: string; messageId: string } | null = null;
  if (facts.card) {
    const conversation = await loadConversationRow(ctx.tx, facts.card.conversationId);
    if (conversation && conversation.burrowId === ctx.burrow.id) {
      const posted = await postMessage(ctx, {
        conversation,
        // Older clients show the words; newer ones the card's line, which says the same (`deployLine`).
        text: deployLine(card),
        card,
        threadRootId: facts.card.threadRootId,
        mentions: [],
        dispatch: false,
        notifyMentions: false,
      });
      place = { conversationId: conversation.id, messageId: posted.id };
    }
  }
  const [row] = await ctx.tx
    .insert(deployments)
    .values({
      id,
      burrowId: ctx.burrow.id,
      environment: facts.environment,
      environmentKey,
      service: facts.service,
      serviceKey,
      status: facts.status,
      how: facts.how,
      repo: facts.repo,
      ref: facts.ref,
      sha,
      url: facts.url,
      summary: facts.summary,
      byId: facts.byId,
      runId: facts.runId,
      conversationId: place?.conversationId ?? null,
      messageId: place?.messageId ?? null,
      previousId,
      dispatchId: facts.dispatchId,
      approvalId: facts.approvalId,
      createdAt: ctx.now,
    })
    .returning();
  if (!row) throw notFound('Deployment');
  const event = await ctx.emit({
    type: 'deploy.recorded',
    kind: 'Code',
    text: deployLine({ ...card, sha: null }),
    where: 'Deploys',
    ...(facts.byId !== ctx.actor.id ? { aboutId: facts.byId } : {}),
    ref: { type: 'work', section: DEPLOYS_SECTION },
    payload: {
      deploymentId: id,
      environment: facts.environment,
      service: facts.service,
      status: facts.status,
      how: facts.how,
      sha,
      ...(previousId ? { previousId } : {}),
      ...(facts.runId ? { runId: facts.runId } : {}),
    },
  });
  publishRecorded(ctx, row, event.id);
  return { deploymentId: id, previousId, messageId: place?.messageId ?? null };
}

/** `deployment.recorded` on the burrow topic, with its place. */
function publishRecorded(ctx: ApplyContext, row: DeploymentRow, eventId: string) {
  ctx.publish(
    topics.burrow(ctx.burrow.id),
    { type: 'deployment.recorded', deployment: toDeployment(row) },
    { eventId },
  );
}

/* An agent's record_deploy ------------------------------------------------------------------------- */

export const recordDeploy = defineCommand({
  name: 'deploy.record',
  /** `dispatchId` is set by the MCP adapter: the turn the deploy is recorded in. */
  schema: RecordDeployInput.extend({ dispatchId: DispatchId }),
  // No key: recording isn't deploying (CT-296).
  async apply(tx, ctx, input): Promise<Recorded> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Agents record their deploys.');
    const [turn] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    if (!turn || turn.agentId !== ctx.actor.id || turn.burrowId !== ctx.burrow.id) throw notFound('Turn');
    let runId = input.runId ?? null;
    if (runId) {
      const [run] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.burrowId, ctx.burrow.id), eq(runs.agentId, ctx.actor.id)));
      if (!run) throw notFound('Run');
    } else runId = await dispatchRun(tx, turn);
    // A turn that posts nowhere (a search answer, an assessment) records without a card.
    const postsHere = turn.mode !== 'answer' && turn.trigger !== 'feedback';
    return record(ctx, {
      environment: name(DeployEnvironmentName, input.environment),
      service: name(DeployServiceName, input.service),
      status: input.status,
      how: input.how,
      summary: input.summary,
      repo: input.repo ?? null,
      ref: input.ref ?? null,
      sha: input.sha ?? null,
      url: input.url ?? null,
      byId: ctx.actor.id,
      runId,
      dispatchId: turn.id,
      approvalId: null,
      card: postsHere ? { conversationId: turn.conversationId, threadRootId: turn.threadRootId } : null,
    });
  },
});

/* The deploy executor's outcome -------------------------------------------------------------------- */

export const recordDeployJob = defineCommand({
  name: 'deploy.record_job',
  schema: z.object({
    approvalId: z.string().min(1),
    status: z.enum(['succeeded', 'failed']),
    repo: RepoFullName,
    /** The workflow file that ran, and its run's page on GitHub. */
    workflow: z.string().min(1).max(200),
    runUrl: z.string().max(2048).nullable(),
    conclusion: z.string().max(80).nullable(),
  }),
  async apply(tx, ctx, input): Promise<Recorded> {
    const [existing] = await tx
      .select()
      .from(deployments)
      .where(eq(deployments.approvalId, input.approvalId));
    if (existing)
      return { deploymentId: existing.id, previousId: existing.previousId, messageId: existing.messageId };
    const [approval] = await tx.select().from(approvals).where(eq(approvals.id, input.approvalId));
    if (!approval || approval.burrowId !== ctx.burrow.id || approval.action.type !== 'deploy')
      throw notFound('Deploy');
    const p = approval.action.params;
    const sha = p.sha && DeploySha.safeParse(p.sha).success ? p.sha : null;
    const ref = DeployRef.safeParse(p.ref);
    const runUrl = input.runUrl && DeployUrl.safeParse(input.runUrl).success ? input.runUrl : null;
    // The card goes where the approval card is: its thread, or the conversation's top level beside it.
    const [cardMessage] = approval.messageId
      ? await tx
          .select({ threadRootId: messages.threadRootId })
          .from(messages)
          .where(eq(messages.id, approval.messageId))
      : [];
    // GitHub's own words for how a run ended (`failure`, `timed_out`) in plain ones; the run's page is the deploy's link.
    const ended = DEPLOY_ENDINGS[input.conclusion ?? ''] ?? 'ended without a result';
    const summary =
      input.status === 'succeeded'
        ? `The ${input.workflow} workflow on GitHub Actions finished.`
        : `The ${input.workflow} run on GitHub Actions ${ended}.`;
    return record(ctx, {
      environment: name(DeployEnvironmentName, p.environment),
      service: name(DeployServiceName, p.service),
      status: input.status,
      how: 'github_actions',
      summary: summary.slice(0, 500),
      repo: input.repo,
      ref: ref.success ? ref.data : null,
      sha,
      url: runUrl ?? null,
      // The person whose yes ran it; nobody had to say yes: whoever asked.
      byId: approval.decidedById ?? approval.requesterId,
      runId: null,
      dispatchId: null,
      approvalId: approval.id,
      card: { conversationId: approval.conversationId, threadRootId: cardMessage?.threadRootId ?? null },
    });
  },
});
