/**
 * A turn that failed for good says why and can be tried again (docs/decisions/essentials-agents.md EA-08, EA-09;
 * contracts CT-167).
 *
 * - The classification is the runner's (`CompleteBody.failure`), else the same rules over what the server knows (a
 *   lost lease, no runner, a context that couldn't be built, an older runner's text).
 * - The agent says it where it was asked: the public sentence (`turnFailureText`, or the runner's refusal when that is
 *   safe for the room: no host path, secret or stack trace) with a `turn_failed` card, recorded on the dispatch
 *   (`dispatches.failure`). Turns another part of Whombat owns (a Feedback assessment, an automation step, a search
 *   answer) get no card: they are retried by their owner, not by a button.
 * - `dispatches.retry` (the person, in the room) queues the same agent, conversation, thread, trigger
 *   message and person again with trigger `retry`, once per failed turn: a second press answers with the first retry.
 *   The card then says “Tried again” (`message.updated`).
 * - The technical detail (`turnFailureDetail`: redacted, the last 2000 characters) reaches the person only through
 *   `work.overview`, never the room.
 * - A usage limit doesn't end the task (resourceful-agents.md RA-32, RA-DS11…RA-DS13): a turn that failed with
 *   `usage_limit` and a reset time is queued again by the server a minute after the reset (`requeued_for`,
 *   `retry_of_id`), once — the same trigger, place and person, its own turn (nothing merges into it) — and the agent says
 *   it will carry on then. At the claim it gives way to a newer turn of the agent for the same person in the same
 *   conversation and thread (`requeueSuperseded`); Try again before the reset is such a turn.
 */
import { classifyTurnFailure, claudeExtraUsageRequired } from '@whombat/agent-runtime/failures';
import {
  canRetryTurn,
  DispatchId,
  formatGatewayUntil,
  GATEWAY_TOOL_LABELS,
  newId,
  redactSecrets,
  Timestamp,
  TURN_FAILURE_REASON_MAX,
  type TurnFailedCard,
  TurnFailureCode,
  type TurnFailureReport,
  topics,
  turnFailureDetail,
  turnFailureRetryable,
  turnFailureText,
} from '@whombat/core';
import { and, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { dispatchRuntimeFor, isBackgroundDispatch } from '../chats/thread-runtime';
import { reopenRun } from '../commands/run-recovery';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { type DispatchFailure, dispatches, messages, runs } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { gatewayConnectionOf, gatewayName } from '../gateway/store';
import { ApiError, forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { loadConversationRow } from '../read/conversations';
import { loadMessages } from '../read/messages';
import { accountInBurrow, loadPrincipalRow, type PrincipalRow } from '../read/principals';
import { publishDispatch } from './activity';
import type { DispatchRow } from './context';
import { claudeExtraUsageText } from './failure-text';
import { outsidersTurn } from './person';

/** Turns whose failure gets the card and Try again: not a Feedback assessment, an automation step or a search answer. */
export function retryable(row: Pick<DispatchRow, 'trigger' | 'mode'>): boolean {
  return row.trigger !== 'feedback' && row.trigger !== 'automation' && row.mode !== 'answer';
}

/** The failure as the runner reported it, else classified from what the server has (EA-08). */
export function failureReportOf(body: {
  error?: string | null;
  refusal?: string | null;
  failure?: TurnFailureReport | null;
}): TurnFailureReport {
  // Older runners call this HTTP 400 an internal/format error. Its account action has no reset time.
  if (claudeExtraUsageRequired(body.error ?? '')) return { code: 'usage_limit', resetsAt: null };
  if (body.failure) return body.failure;
  const byError = classifyTurnFailure({ error: body.error ?? '' });
  // An older runner's refusal says what its code (`host_not_ready`) doesn't.
  if (byError.code === 'internal' && body.refusal) return classifyTurnFailure({ error: body.refusal });
  return byError;
}

/**
 * A refusal the runner wrote for people, when it is safe for the room (EA-08): no host path (`/…`, `~/…`, `./…`), no
 * secret, no stack trace. Null otherwise (the public sentence stands in).
 */
export function publicRefusal(refusal: string | null | undefined): string | null {
  const text = refusal?.trim();
  if (!text) return null;
  if (/(^|[\s(“"'`])(~|\.{1,2})?\/[^\s/]/.test(text)) return null;
  if (redactSecrets(text) !== text) return null;
  if (/\n\s+at\s|\b[A-Z][A-Za-z]*Error:/.test(text)) return null;
  return text;
}

/**
 * The provider the turn ran on (for the sentence: “Claude”, “Codex”): its Chat thread's choice (chat-runtime-server.md
 * CR-S03), else its agent's.
 */
function providerOf(agent: PrincipalRow | undefined, row: Pick<DispatchRow, 'runtime'>): string | null {
  if (row.runtime) return row.runtime.provider;
  const runtime = agent?.runtime as { provider?: string } | null | undefined;
  return runtime?.provider ?? null;
}

/**
 * A gateway turn's usage limit is its pool's (ai-gateway.md AIG-D31): “Fusebox has no Claude Code room left until today
 * 16:50, so I stopped; press Try again after that.”, named as the claim's refusal and the alerts name it (AIG-12,
 * AIG-14). Null for a turn on someone's own sign-in, or words too long for the card.
 */
async function gatewayLimitText(
  tx: Tx,
  ctx: ApplyContext,
  row: Pick<DispatchRow, 'burrowId' | 'gatewayProvider'>,
  resetsAt: string | null,
): Promise<string | null> {
  const provider = row.gatewayProvider;
  if (provider !== 'claude' && provider !== 'codex') return null;
  const connection = await gatewayConnectionOf(tx, row.burrowId);
  const name = connection ? gatewayName(connection) : 'The AI gateway';
  const room = `I’ve used up what ${name} has for ${GATEWAY_TOOL_LABELS[provider]}`;
  const text = resetsAt
    ? `${room} until ${formatGatewayUntil(resetsAt, ctx.now, ctx.burrow.timeZone)}, so I stopped; press Try again after that.`
    : `${room} for now, so I stopped. Press Try again in a few minutes.`;
  return text.length <= TURN_FAILURE_REASON_MAX ? text : null;
}

/**
 * The agent says why its turn failed where it was asked, and the failure is recorded (EA-08). Run as the agent; a room
 * it is no longer in gets no message (the failure is still recorded for `work.overview`).
 */
export const recordTurnFailure = defineCommand({
  name: 'runtime.turn_failed',
  schema: z.object({
    dispatchId: DispatchId,
    code: TurnFailureCode,
    resetsAt: Timestamp.nullable().optional(),
    /** The runner's refusal, posted instead of the sentence when it is safe for the room. */
    refusal: z.string().max(500).nullable().optional(),
    /** The plain words for a turn that gets no card (its owner retries it, not a button). */
    fallbackText: z.string().max(500),
    /** The runner's technical error (the person reads it, redacted, through `work.overview`). */
    error: z.string().max(2000).nullable().optional(),
  }),
  async apply(tx, ctx, input): Promise<DispatchFailure | null> {
    const [row] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    if (!row || row.burrowId !== ctx.burrow.id || row.agentId !== ctx.actor.id) throw notFound('Dispatch');
    if (row.state !== 'failed' || row.failure) return row.failure ?? null;
    const agent = await loadPrincipalRow(tx, row.agentId);
    const needsExtraUsage = claudeExtraUsageRequired(input.error ?? row.error ?? '');
    const connection =
      needsExtraUsage && row.gatewayProvider ? await gatewayConnectionOf(tx, row.burrowId) : null;
    const extraUsage = needsExtraUsage
      ? claudeExtraUsageText(
          row.gatewayProvider ? (connection ? gatewayName(connection) : 'the AI gateway') : null,
        )
      : null;
    const resetsAt = extraUsage ? null : (input.resetsAt ?? null);
    // A workspace refusal the room may read names the repository, what is missing and where it's fixed (RA-DS54): the
    // card says that, not the general “check the repository in Settings” beside it.
    const said = input.code === 'workspace' ? publicRefusal(input.refusal) : null;
    const reason =
      extraUsage?.reason ??
      (said && said.length <= TURN_FAILURE_REASON_MAX ? said : null) ??
      (input.code === 'usage_limit' ? await gatewayLimitText(tx, ctx, row, resetsAt) : null) ??
      turnFailureText(input.code, {
        provider: providerOf(agent, row),
        resetsAt,
        now: ctx.now,
        timeZone: ctx.burrow.timeZone,
      });
    let messageId: string | null = null;
    // A usage limit with a reset time: the turn carries on after it by itself (RA-32).
    const requeue =
      input.code === 'usage_limit' && resetsAt && agent
        ? await requeueAfterLimit(ctx, row, agent, new Date(resetsAt))
        : null;
    // A search answer shows its own failure on the search screen.
    if (row.mode !== 'answer') {
      const conversation = await loadConversationRow(tx, row.conversationId);
      if (conversation && conversation.burrowId === row.burrowId) {
        const withCard = retryable(row);
        const card: TurnFailedCard = {
          kind: 'turn_failed',
          dispatchId: row.id,
          agentId: row.agentId,
          code: input.code,
          reason,
          retriedAt: null,
          retryDispatchId: null,
        };
        const posted = await postMessage(ctx, {
          conversation,
          text:
            extraUsage?.text ??
            publicRefusal(input.refusal) ??
            (requeue ? carriesOnText(reason) : withCard ? reason : input.fallbackText),
          ...(withCard ? { card } : {}),
          threadRootId: row.threadRootId,
          // Quiet: no mentions, no follow-up work.
          mentions: [],
          dispatch: false,
          outsidersRun: outsidersTurn(row),
        });
        messageId = posted.id;
      }
    }
    const failure: DispatchFailure = {
      code: input.code,
      reason,
      resetsAt,
      messageId,
      detail: turnFailureDetail([input.error, input.refusal].filter(Boolean).join(' — ')),
      retriedAt: null,
      retryDispatchId: null,
    };
    const [updated] = await tx
      .update(dispatches)
      .set({ failure })
      .where(eq(dispatches.id, row.id))
      .returning();
    if (updated) publishDispatch(ctx, updated);
    return failure;
  },
});

/** A requeued turn starts this long after the usage limit's reset (RA-32). */
export const REQUEUE_AFTER_RESET_MS = 60_000;
/** A reset further away than this isn't waited for (a limit resets within a week; anything later is a wrong reading). */
export const REQUEUE_MAX_WAIT_MS = 8 * 24 * 60 * 60_000;

/** The usage-limit sentence when the turn carries on by itself: “… It resets at 14:00; I’ll carry on then.” */
export function carriesOnText(reason: string): string {
  const said = reason.replace(/;? ?press Try again after that\.$/, '; I’ll carry on then.');
  return said === reason ? `${reason} I’ll carry on once it resets.` : said;
}

/**
 * Queues a turn that failed on a usage limit again for a minute after the reset (RA-32), once: not a turn that was
 * itself queued again, not a turn its owner retries (an assessment, an automation step, a search answer),
 * not for a retired agent, an account without a person here, a conversation the agent left or an archived channel. Returns the new
 * dispatch's id, or null.
 */
async function requeueAfterLimit(
  ctx: ApplyContext,
  row: DispatchRow,
  agent: PrincipalRow,
  resetsAt: Date,
): Promise<string | null> {
  if (row.requeuedFor || !retryable(row)) return null;
  if (Number.isNaN(resetsAt.getTime()) || resetsAt.getTime() - ctx.now.getTime() > REQUEUE_MAX_WAIT_MS)
    return null;
  if (agent.kind !== 'agent') return null;
  if (row.onBehalfOfAccountId && !(await accountInBurrow(ctx.tx, row.burrowId, row.onBehalfOfAccountId)))
    return null;
  const conversation = await loadConversationRow(ctx.tx, row.conversationId);
  if (!conversation || conversation.burrowId !== row.burrowId) return null;
  const notBefore = new Date(Math.max(resetsAt.getTime(), ctx.now.getTime()) + REQUEUE_AFTER_RESET_MS);
  const id = newId('dispatch');
  const [inserted] = await ctx.tx
    .insert(dispatches)
    .values({
      id,
      burrowId: row.burrowId,
      agentId: row.agentId,
      // The same kind of turn, so it runs on the same sign-in for the same person (SUB-04).
      trigger: row.trigger,
      // A run's turn carries on as a reply: the run stopped with the failure, and the agent may start it again.
      mode: row.mode === 'run' ? 'reply' : row.mode,
      conversationId: row.conversationId,
      messageId: row.messageId,
      threadRootId: row.threadRootId,
      state: 'queued',
      onBehalfOfAccountId: row.onBehalfOfAccountId,
      planId: row.planId,
      planStepId: row.planStepId,
      approvalId: row.approvalId,
      retryOfId: row.id,
      requeuedFor: 'usage_limit',
      notBefore,
      // Re-resolve the thread's choice or background model setting as a new turn would take it.
      runtime: await dispatchRuntimeFor(ctx.tx, {
        agent,
        conversation,
        threadRootId: row.threadRootId,
        trigger: row.trigger,
        background: await isBackgroundDispatch(ctx.tx, row),
      }),
      createdAt: ctx.now,
    })
    .returning();
  if (inserted) publishDispatch(ctx, inserted);
  await ctx.emit({
    type: 'dispatch.created',
    kind: 'System',
    text: null,
    where: null,
    aboutId: agent.id,
    payload: {
      dispatchId: id,
      agentId: agent.id,
      trigger: row.trigger,
      mode: inserted?.mode ?? 'reply',
      messageId: row.messageId,
      requeuedFor: 'usage_limit',
      retryOfId: row.id,
      notBefore: iso(notBefore),
    },
  });
  return id;
}

/**
 * Why a turn queued again after a usage limit gives way at the claim (RA-32), or null to run it: the person it is for
 * left, or a newer turn of the agent for the same person in the same conversation and thread came after the failed one
 * (a person's new request, Try again) — that turn reads the conversation as it is now. Cancelled turns and other
 * requeued turns don't count.
 */
export async function requeueSuperseded(tx: Tx, d: DispatchRow): Promise<string | null> {
  if (!d.requeuedFor || !d.retryOfId) return null;
  if (d.onBehalfOfAccountId && !(await accountInBurrow(tx, d.burrowId, d.onBehalfOfAccountId)))
    return 'requeue_person_left';
  const [failed] = await tx
    .select({ createdAt: dispatches.createdAt })
    .from(dispatches)
    .where(eq(dispatches.id, d.retryOfId));
  if (!failed) return null;
  const [newer] = await tx
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.agentId, d.agentId),
        eq(dispatches.conversationId, d.conversationId),
        ne(dispatches.id, d.id),
        ne(dispatches.id, d.retryOfId),
        gt(dispatches.createdAt, failed.createdAt),
        ne(dispatches.state, 'cancelled'),
        isNull(dispatches.requeuedFor),
        sql`${dispatches.threadRootId} is not distinct from ${d.threadRootId}`,
        sql`${dispatches.onBehalfOfAccountId} is not distinct from ${d.onBehalfOfAccountId}`,
      ),
    )
    .limit(1);
  return newer ? 'requeue_superseded' : null;
}

/** Whether the viewer may press Try again on this turn: the person, in any of the burrow's rooms. */
async function mayRetry(tx: Tx | Db, viewer: PrincipalRow, row: DispatchRow): Promise<boolean> {
  if (viewer.kind !== 'person' || viewer.burrowId !== row.burrowId) return false;
  const agent = await loadPrincipalRow(tx, row.agentId);
  if (agent?.kind !== 'agent') return false;
  return canRetryTurn({ retriedAt: null }, viewer);
}

/**
 * “Try again” (`dispatches.retry`, EA-09): the same agent, conversation, thread, trigger message and person again, with
 * trigger `retry`, once per failed turn — a second press answers with the first retry.
 */
export const retryDispatch = defineCommand({
  name: 'dispatch.retry',
  schema: z.object({ dispatchId: DispatchId }),
  async apply(tx, ctx, input): Promise<{ dispatchId: string }> {
    const [row] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId)).for('update');
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Turn');
    const viewer = await loadPrincipalRow(tx, ctx.actor.id);
    if (!viewer) throw notFound('Turn');
    if (row.failure?.retryDispatchId) return { dispatchId: row.failure.retryDispatchId };
    if (row.state !== 'failed' || !row.failure)
      throw new ApiError('conflict', 'Only a reply that failed can be tried again.');
    if (!retryable(row))
      throw new ApiError('conflict', 'This one is tried again by the part of Whombat that started it.');
    if (!turnFailureRetryable(row.failure.code))
      throw new ApiError(
        'conflict',
        'The model declined this one. Reword it or switch models, then send it again.',
      );
    const agent = await loadPrincipalRow(tx, row.agentId);
    // Working for an account without a person here (one-person.md OP-S08): nothing to try again.
    if (row.onBehalfOfAccountId && !(await accountInBurrow(tx, row.burrowId, row.onBehalfOfAccountId)))
      throw new ApiError('conflict', 'The person this was for isn’t on this Whombat any more.');
    if (!(await mayRetry(tx, viewer, row))) throw forbidden('Only you can try this again.');
    if (agent?.kind !== 'agent')
      throw new ApiError('conflict', 'Your assistant isn’t in this conversation any more.');
    // An archived channel wakes nobody (docs/decisions/essentials-conversations.md EC-11).
    const id =
      row.runId && row.mode === 'run'
        ? await retryRunTurn(ctx, row, agent)
        : await queueRetry(ctx, row, agent);
    const retriedAt = iso(ctx.now);
    const failure: DispatchFailure = { ...row.failure, retriedAt, retryDispatchId: id };
    const [updated] = await tx
      .update(dispatches)
      .set({ failure })
      .where(eq(dispatches.id, row.id))
      .returning();
    if (updated) publishDispatch(ctx, updated);
    await markCardRetried(ctx, failure, row.conversationId);
    await ctx.emit({
      type: 'dispatch.retried',
      kind: 'System',
      text: null,
      where: null,
      aboutId: row.agentId,
      payload: { dispatchId: row.id, retryDispatchId: id, code: row.failure.code },
    });
    return { dispatchId: id };
  },
});

/**
 * Try again on the failure of a turn on a run (resourceful-agents.md RA-DS54): the run the failure stopped (RC-03) is
 * tried again as the run's own Try again does (RC-10) — live again, and the retry is a run turn with its checkout —
 * rather than a reply that would have to start a new run. A run tried again meanwhile (its own Try again): its turn is
 * the retry, nothing more is queued. A run that finished or was taken over: a reply, as before (EA-09).
 */
async function retryRunTurn(ctx: ApplyContext, row: DispatchRow, agent: PrincipalRow): Promise<string> {
  const [run] = await ctx.tx
    .select()
    .from(runs)
    .where(eq(runs.id, row.runId as string))
    .for('update');
  if (run?.status === 'failed') {
    await reopenRun(ctx, run);
    return queueRetry(ctx, row, agent, run.id);
  }
  if (run?.status === 'live') {
    const [turn] = await ctx.tx
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(and(eq(dispatches.runId, run.id), inArray(dispatches.state, ['queued', 'claimed', 'running'])))
      .orderBy(desc(dispatches.createdAt))
      .limit(1);
    return turn?.id ?? queueRetry(ctx, row, agent, run.id);
  }
  return queueRetry(ctx, row, agent);
}

/**
 * The retry itself: queued as the failed turn was, for its person, with trigger `retry` (EA-09). With `runId`, a run turn
 * on that run (RA-DS54).
 */
async function queueRetry(
  ctx: ApplyContext,
  row: DispatchRow,
  agent: PrincipalRow,
  runId: string | null = null,
): Promise<string> {
  const id = newId('dispatch');
  const [inserted] = await ctx.tx
    .insert(dispatches)
    .values({
      id,
      burrowId: row.burrowId,
      agentId: row.agentId,
      trigger: 'retry',
      // A run's turn is tried again as a reply when its run isn't tried again with it (it finished or was taken over):
      // the agent may start one again.
      mode: runId ? 'run' : row.mode === 'run' ? 'reply' : row.mode,
      ...(runId ? { runId } : {}),
      conversationId: row.conversationId,
      messageId: row.messageId,
      threadRootId: row.threadRootId,
      state: 'queued',
      onBehalfOfAccountId: row.onBehalfOfAccountId,
      planId: row.planId,
      planStepId: row.planStepId,
      approvalId: row.approvalId,
      // A scheduled turn tried again still carries its schedule (resourceful-agents.md RA-30).
      scheduleId: row.scheduleId,
      retryOfId: row.id,
      // Re-resolve the thread's choice or background model setting by the kind of turn it tries again.
      runtime: await dispatchRuntimeFor(ctx.tx, {
        agent,
        conversation: await loadConversationRow(ctx.tx, row.conversationId),
        threadRootId: row.threadRootId,
        trigger: row.trigger,
        background: await isBackgroundDispatch(ctx.tx, row),
      }),
      createdAt: ctx.now,
    })
    .returning();
  if (inserted) publishDispatch(ctx, inserted);
  await ctx.emit({
    type: 'dispatch.created',
    kind: 'System',
    text: null,
    where: null,
    aboutId: agent.id,
    payload: {
      dispatchId: id,
      agentId: agent.id,
      trigger: 'retry',
      mode: inserted?.mode ?? 'reply',
      messageId: row.messageId,
    },
  });
  const services = ctx.services;
  ctx.after(async () => {
    services.typing.start(
      { conversationId: row.conversationId, threadRootId: row.threadRootId, principalId: agent.id },
      id,
    );
    services.runtime.wake();
  });
  return id;
}

/** The failure message's card says “Tried again” (the stored card is patched; `message.updated`). */
async function markCardRetried(ctx: ApplyContext, failure: DispatchFailure, conversationId: string) {
  if (!failure.messageId) return;
  const [row] = await ctx.tx.select().from(messages).where(eq(messages.id, failure.messageId));
  if (row?.card?.kind !== 'turn_failed') return;
  const card: TurnFailedCard = {
    ...row.card,
    retriedAt: failure.retriedAt,
    retryDispatchId: failure.retryDispatchId,
  };
  const [updated] = await ctx.tx.update(messages).set({ card }).where(eq(messages.id, row.id)).returning();
  if (!updated) return;
  const [message] = await loadMessages(ctx.tx, [updated], null);
  if (message) ctx.publish(topics.conversation(conversationId), { type: 'message.updated', message });
}
