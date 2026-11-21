/** A saved merge request, one external call without a database lock, then a commit of its answer. */
import { decide, keyRefOf, type MergeMethod, newId } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type MergeTarget, mergeHold, mergeKeyOf, mergeTarget, recordMerge } from '../commands/prs';
import { applyContext } from '../commit/pipeline';
import { currentCommandScope, outsideCommandScope } from '../commit/scope';
import { type ApplyContext, defineCommand } from '../commit/types';
import { mergeIntents, pullRequests, repos } from '../db/schema/index';
import { conflict, UnknownOutcomeError } from '../lib/errors';
import { engineActor, loadGrants, loadPrincipalRow, toActor } from '../read/principals';
import type { Services } from '../services';

type Intent = typeof mergeIntents.$inferSelect;
const uncertain = () =>
  new UnknownOutcomeError(
    'Whombat can’t yet confirm this merge. Check the pull request on GitHub before trying again.',
  );

async function recordIntentMerge(
  ctx: ApplyContext,
  intent: Intent,
  target: MergeTarget,
  sha: string | null,
): Promise<string> {
  const actor = await loadPrincipalRow(ctx.tx, intent.actorId);
  if (!actor || actor.burrowId !== ctx.burrow.id) throw conflict('The merge requester could not be found.');
  const bound = applyContext(ctx, {
    burrow: ctx.burrow,
    actor: toActor(actor),
    now: ctx.now,
    at: ctx.at,
    decision: null,
    requirement: null,
    approvalId: null,
    onBehalfOf: intent.onBehalfOf,
  });
  const start = ctx.eventIds.length;
  await recordMerge(
    {
      ...bound,
      emit: (fields) =>
        bound.emit({ ...fields, ...(actor.kind === 'agent' ? { keyUsed: keyRefOf(intent.keyId) } : {}) }),
    },
    { ...target, pr: { ...target.pr, headSha: intent.headSha, baseBranch: intent.baseBranch } },
    intent.method,
    { github: { sha }, onOrigin: null },
  );
  const eventId = ctx.eventIds[start];
  if (!eventId) throw new Error('The merge was not signed.');
  return eventId;
}

/** A poll can see success before the caller gets its answer. Settle the same intent and sign as its requester. */
export async function recordMirroredMerge(
  ctx: ApplyContext,
  input: { prId: string; number: number; repo: string; headSha: string; baseBranch: string },
): Promise<string | null> {
  const [intent] = await ctx.tx
    .select()
    .from(mergeIntents)
    .where(
      and(
        eq(mergeIntents.prId, input.prId),
        eq(mergeIntents.burrowId, ctx.burrow.id),
        eq(mergeIntents.headSha, input.headSha),
        eq(mergeIntents.baseBranch, input.baseBranch),
        inArray(mergeIntents.state, ['running', 'unknown']),
      ),
    );
  if (!intent) return null;
  const target = await mergeTarget(ctx.tx, ctx.burrow.id, input.number, input.repo);
  if (!target) return null;
  const eventId = await recordIntentMerge(ctx, intent, target, null);
  await ctx.tx
    .update(mergeIntents)
    .set({ state: 'merged', reason: null, eventId, updatedAt: ctx.now })
    .where(eq(mergeIntents.id, intent.id));
  return eventId;
}

export async function prepareMerge(
  ctx: ApplyContext,
  target: MergeTarget,
  method: MergeMethod,
): Promise<void> {
  const [active] = await ctx.tx
    .select()
    .from(mergeIntents)
    .where(
      and(
        eq(mergeIntents.prId, target.pr.id),
        inArray(mergeIntents.state, ['pending', 'running', 'unknown']),
      ),
    );
  if (active)
    throw active.state === 'pending' || active.state === 'running'
      ? conflict('This pull request is already being merged. Check it again shortly.')
      : uncertain();
  const id = `merge_${newId('event')}`;
  await ctx.tx.insert(mergeIntents).values({
    id,
    burrowId: ctx.burrow.id,
    prId: target.pr.id,
    actorId: ctx.actor.id,
    headSha: target.pr.headSha,
    baseBranch: target.pr.baseBranch,
    method,
    keyId: mergeKeyOf(target.pr.baseBranch, target.repo.defaultBranch),
    onBehalfOf: ctx.onBehalfOf,
    state: 'pending',
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  currentCommandScope()?.deferResult?.();
  ctx.complete(() => runMergeIntent(ctx.services, id));
}

async function targetOf(services: Services, intent: Intent): Promise<MergeTarget | null> {
  const [row] = await services.db.select().from(pullRequests).where(eq(pullRequests.id, intent.prId));
  if (!row) return null;
  const [repo] = await services.db.select().from(repos).where(eq(repos.id, row.repoId));
  return repo ? mergeTarget(services.db, intent.burrowId, row.number, repo.fullName) : null;
}

const claimMerge = defineCommand({
  name: 'claim_merge_intent',
  schema: z.object({ id: z.string() }),
  async apply(tx, ctx, { id }) {
    const [intent] = await tx.select().from(mergeIntents).where(eq(mergeIntents.id, id));
    if (
      !intent ||
      intent.burrowId !== ctx.burrow.id ||
      intent.actorId !== ctx.actor.id ||
      intent.state !== 'pending'
    )
      return null;
    const [row] = await tx.select().from(pullRequests).where(eq(pullRequests.id, intent.prId));
    const [repo] = row ? await tx.select().from(repos).where(eq(repos.id, row.repoId)) : [];
    const target = row && repo ? await mergeTarget(tx, ctx.burrow.id, row.number, repo.fullName) : null;
    let reason: string | null = null;
    if (
      target?.pr.state !== 'open' ||
      target.pr.headSha !== intent.headSha ||
      target.pr.baseBranch !== intent.baseBranch ||
      mergeKeyOf(target.pr.baseBranch, target.repo.defaultBranch) !== intent.keyId
    )
      reason = 'The pull request changed before the merge could start. Check it and try again.';
    else {
      const decision = decide(
        engineActor(ctx.actor),
        ctx.actor.kind === 'agent' ? await loadGrants(tx, ctx.actor.id) : [],
        intent.keyId,
        { repo: target.repo.fullName, branch: target.pr.baseBranch },
      );
      if (decision.outcome !== 'allow')
        reason = 'Permission to merge changed. Check the agent’s access and try again.';
      else if (
        await mergeHold({ db: tx, services: ctx.services, burrowId: ctx.burrow.id, actor: ctx.actor }, target)
      )
        reason = 'The pull request is no longer ready to merge. Check its reviews and checks.';
    }
    await tx
      .update(mergeIntents)
      .set({ state: reason ? 'refused' : 'running', reason, updatedAt: ctx.now })
      .where(eq(mergeIntents.id, id));
    return reason || !target ? null : { target, actorName: ctx.actor.name };
  },
});

const settleMerge = defineCommand({
  name: 'settle_merge_intent',
  schema: z.object({
    id: z.string(),
    outcome: z.enum(['merged', 'refused', 'unknown']),
    sha: z.string().nullable(),
    reason: z.string().nullable(),
  }),
  async apply(tx, ctx, input) {
    const [intent] = await tx.select().from(mergeIntents).where(eq(mergeIntents.id, input.id));
    if (!intent || intent.burrowId !== ctx.burrow.id || intent.actorId !== ctx.actor.id) return null;
    if (intent.state === 'merged') return { state: intent.state, eventId: intent.eventId };
    const [row] = await tx.select().from(pullRequests).where(eq(pullRequests.id, intent.prId));
    const [repo] = row ? await tx.select().from(repos).where(eq(repos.id, row.repoId)) : [];
    const target = row && repo ? await mergeTarget(tx, ctx.burrow.id, row.number, repo.fullName) : null;
    // A poll may already have recorded this PR. Never sign a second success or overwrite its actor.
    const eventId =
      input.outcome === 'merged' && target && target.pr.state !== 'merged'
        ? await recordIntentMerge(ctx, intent, target, input.sha)
        : null;
    await tx
      .update(mergeIntents)
      .set({ state: input.outcome, reason: input.reason, mergeSha: input.sha, eventId, updatedAt: ctx.now })
      .where(eq(mergeIntents.id, intent.id));
    return { state: input.outcome, eventId };
  },
});

export async function runMergeIntent(services: Services, id: string): Promise<readonly string[]> {
  const [intent] = await services.db.select().from(mergeIntents).where(eq(mergeIntents.id, id));
  if (!intent) throw conflict('This merge request could not be found.');
  const options = { burrowId: intent.burrowId, actorId: intent.actorId, onBehalfOf: intent.onBehalfOf };
  const claimed = await services.pipeline.commit(claimMerge, { id }, options);
  if (claimed.status !== 'ok' || !claimed.result) {
    const [current] = await services.db.select().from(mergeIntents).where(eq(mergeIntents.id, id));
    if (current?.state === 'merged') return current.eventId ? [current.eventId] : [];
    if (current?.state === 'refused')
      throw conflict(current.reason ?? 'This pull request could not be merged.');
    throw uncertain();
  }
  const { target, actorName } = claimed.result;
  // Both the intent and its claim committed before GitHub is called. A crash from here is uncertain, never replayed.
  let outcome: Awaited<ReturnType<Services['github']['mergeOutcome']>>;
  try {
    outcome = await services.github.mergeOutcome({
      burrowId: intent.burrowId,
      repo: target.repo.fullName,
      number: target.pr.number,
      method: intent.method,
      headSha: intent.headSha,
      title: target.pr.title,
      mergedBy: actorName,
    });
  } catch (error) {
    outcome = { outcome: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
  let state = outcome.outcome === 'here' ? 'merged' : outcome.outcome;
  let eventIds: string[];
  try {
    const settled = await services.pipeline.commit(
      settleMerge,
      {
        id,
        outcome: state,
        sha: outcome.outcome === 'merged' ? outcome.sha : null,
        reason: 'reason' in outcome ? outcome.reason.slice(0, 500) : null,
      },
      options,
    );
    if (settled.status !== 'ok' || !settled.result) throw uncertain();
    state = settled.result.state;
    eventIds = [
      ...new Set([...settled.eventIds, ...(settled.result.eventId ? [settled.result.eventId] : [])]),
    ];
  } catch (err) {
    services.log.error({ err, intentId: id }, 'could not record GitHub merge outcome');
    throw uncertain();
  }
  if (state === 'unknown') throw uncertain();
  if (state === 'refused')
    throw conflict('reason' in outcome ? outcome.reason : 'GitHub refused this merge.');
  return eventIds;
}

/** On boot running means uncertain. Later mirror updates can prove success; uncertain calls are never repeated. */
export async function recoverMergeIntents(services: Services, afterRestart = false): Promise<void> {
  const intents = await services.db
    .select()
    .from(mergeIntents)
    .where(inArray(mergeIntents.state, ['pending', 'running', 'unknown']));
  for (const intent of intents) {
    if (intent.state === 'pending') {
      outsideCommandScope(() =>
        services.background.run('saved merge', async () => {
          await runMergeIntent(services, intent.id);
        }),
      );
      continue;
    }
    if (intent.state === 'running' && !afterRestart) continue;
    const target = await targetOf(services, intent);
    const merged =
      target?.pr.state === 'merged' &&
      target.pr.headSha === intent.headSha &&
      target.pr.baseBranch === intent.baseBranch;
    await services.pipeline.commit(
      settleMerge,
      {
        id: intent.id,
        outcome: merged ? 'merged' : 'unknown',
        sha: null,
        reason: merged ? null : 'The merge was interrupted. Check the pull request on GitHub.',
      },
      { burrowId: intent.burrowId, actorId: intent.actorId, onBehalfOf: intent.onBehalfOf },
    );
  }
}
