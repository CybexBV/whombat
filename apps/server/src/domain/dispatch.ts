/**
 * Dispatch queue (ARCHITECTURE "Agent runtime"). Mentions of an agent, messages in an agent DM, search
 * questions and declined approvals queue a dispatch the runner claims later.
 *
 * Invariant (REFERENCE_NOTES §6): at most one *queued* dispatch per (agent, conversation, thread, person the work is
 * for), the conversation's top level counting as one thread (hermes-native.md HN-T04). A mention that arrives while one
 * is queued there for the same person coalesces into it (the runner reads the latest window when it claims); one that
 * arrives while a turn is running there queues exactly one follow-up turn. Requests in other threads get turns of their
 * own: the claim runs a conversation's threads side by side (HN-T01). An outsiders' turn never takes in the person's
 * request, nor the other way round. A message with more for the agent than the chat shows (a brief, a Feedback
 * handoff) queues a turn of its own next to a queued one, so that its turn's request is that message
 * (docs/decisions/steering.md).
 *
 * Each dispatch records the person it is for (`onBehalfOfAccountId`, CT-69): the person (one-person.md OP-01), or nobody for
 * an outsiders' turn (OP-17, `runtime/person.ts`).
 * */
import { conversationLabel, type DispatchMode, type DispatchTrigger, newId } from '@whombat/core';
import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import { dispatchRuntimeFor } from '../chats/thread-runtime';
import { loadBurrowRow } from '../commit/pipeline';
import type { TxSession } from '../commit/types';
import type { Tx } from '../db/client';
import { type DispatchSearch, dispatches, principals, runs } from '../db/schema/index';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { publishDispatch } from '../runtime/activity';
import { currentDispatchScope } from '../runtime/dispatch-scope';
import type { Services } from '../services';
import { turnOfItsOwn } from './agent-brief';
import { linkDispatchToStep, stepNotStarted } from './plan-follow';
import { sessionWriter } from './plans';
import { thePersonAccountId } from './the-person';
import { stoppableTurn } from './turn-stop';

export interface DispatchRequest {
  agentId: string;
  trigger: DispatchTrigger;
  mode?: DispatchMode;
}

export interface EnqueueArgs {
  burrowId: string;
  /** Principal whose action caused the dispatch (signs the internal `dispatch.created` event). */
  causedById: string;
  conversationId: string;
  /** The conversation's row, when the caller already read it in this commit (a message posted there). */
  conversation?: ConversationRow;
  messageId: string | null;
  threadRootId: string | null;
  requests: readonly DispatchRequest[];
  at: Date;
  search?: DispatchSearch;
  runId?: string | null;
  /** The person the work is for (CT-69); absent: derived from the cause (`personBehind`). */
  onBehalfOfAccountId?: string | null;
  /**
   * A plan step handed to its agent owner (work-supervision WS-04): the owner's dispatch is linked to the step and
   * carries it; nobody woken leaves the step “Couldn’t start”.
   */
  planStep?: { planId: string; stepId: string; agentId: string };
  /** A `schedule` turn: the agent's schedule it runs (`dispatches.schedule_id`, resourceful-agents.md RA-30). */
  scheduleId?: string;
}

/**
 * The person a new dispatch is for (CT-69 `onBehalfOfAccountId`) when the caller didn't say (one-person.md OP-01,
 * OP-17): the person, for every turn but an outsiders' — inside one (an agent's act in a turn queued for nobody), the
 * new turn stays apart too (null). An outsiders' turn is started by its caller saying null (an assessment, a tracker
 * customer's report).
 */
export async function personBehind(
  tx: Tx,
  args: Pick<EnqueueArgs, 'burrowId' | 'causedById' | 'onBehalfOfAccountId'>,
): Promise<string | null> {
  if (args.onBehalfOfAccountId !== undefined) return args.onBehalfOfAccountId;
  const scope = currentDispatchScope();
  if (scope && scope.agentId === args.causedById && !scope.onBehalfOfAccountId) return null;
  return thePersonAccountId(tx, args.burrowId);
}

/**
 * Turns that never merge with another queued turn, nor take one in (AG-10, concise-replies.md): a scheduled turn
 * carries its own prompt (RA-30); a person's message never joins a Looks ahead check, which reads strangers' text
 * (looks-ahead.md).
 */
const OWN_TURNS: readonly DispatchTrigger[] = ['expand', 'schedule', 'ahead'];

export interface QueuedDispatch {
  dispatchId: string;
  agentId: string;
  /** False when the request coalesced into a dispatch that was already queued. */
  created: boolean;
}

/** Links a plan step's dispatch to the step, in the enqueue's commit, signed by whoever started the step. */
async function linkStep(
  session: TxSession,
  args: EnqueueArgs,
  dispatchId: string,
  step: { planId: string; stepId: string },
): Promise<void> {
  const burrow = await loadBurrowRow(session.tx, args.burrowId);
  if (!burrow) return;
  await linkDispatchToStep(sessionWriter(session, burrow, args.causedById, args.at), dispatchId, step);
}

/** Nobody was woken for a started step (the agent can't be woken here): it says so (WS-04). */
async function ownerNotWoken(
  session: TxSession,
  args: EnqueueArgs,
  planStep: { planId: string; stepId: string },
) {
  const burrow = await loadBurrowRow(session.tx, args.burrowId);
  if (!burrow) return;
  await stepNotStarted(
    sessionWriter(session, burrow, args.causedById, args.at),
    planStep,
    'The agent wasn’t asked: it can’t be woken in this conversation. Start it again once it is here.',
  );
}

/** Queues dispatches in their own commit for callers without an open transaction. */
export async function enqueueDispatches(services: Services, args: EnqueueArgs): Promise<QueuedDispatch[]> {
  const { result } = await services.pipeline.transact(args.burrowId, (session) =>
    enqueueInSession(session, args),
  );
  return result;
}

/** Queues dispatches in a session that already holds the burrow lock (a command's commit); “thinking” starts after it. */
export async function enqueueInSession(session: TxSession, args: EnqueueArgs): Promise<QueuedDispatch[]> {
  const result = args.requests.length ? await queueIn(session, args) : [];
  if (args.planStep && !result.some((d) => d.agentId === args.planStep?.agentId))
    await ownerNotWoken(session, args, args.planStep);
  const services = session.services;
  session.after(async () => startThinking(services, args, result));
  return result;
}

function startThinking(services: Services, args: EnqueueArgs, queued: readonly QueuedDispatch[]) {
  if (args.search) return;
  for (const d of queued) {
    // The turn that thinks, for Stop on the line (review-features.md RF-01); not for turns Whombat itself owns.
    const trigger = args.requests.find((r) => r.agentId === d.agentId)?.trigger;
    const stoppable = !trigger || stoppableTurn({ trigger, mode: args.runId ? 'run' : 'reply' });
    services.typing.start(
      { conversationId: args.conversationId, threadRootId: args.threadRootId, principalId: d.agentId },
      stoppable ? d.dispatchId : null,
    );
  }
}

/** The turn that started a run, with the plan step it was asked to do. */
async function originOfRun(tx: Tx, runId: string) {
  const [row] = await tx
    .select({ agentId: dispatches.agentId, planId: dispatches.planId, planStepId: dispatches.planStepId })
    .from(runs)
    .innerJoin(dispatches, eq(dispatches.id, runs.dispatchId))
    .where(eq(runs.id, runId));
  return row ?? null;
}

async function queueIn(session: TxSession, args: EnqueueArgs): Promise<QueuedDispatch[]> {
  const tx = session.tx;
  // Read under the burrow lock (the caller's, when it read it in this commit).
  const conversation =
    args.conversation?.id === args.conversationId
      ? args.conversation
      : await loadConversationRow(tx, args.conversationId);
  const where = conversation ? conversationLabel(conversation) : null;
  const out: QueuedDispatch[] = [];
  const step = args.planStep ?? null;
  const requested = await tx
    .select({
      id: principals.id,
      system: principals.system,
      kind: principals.kind,
      runtime: principals.runtime,
    })
    .from(principals)
    .where(
      inArray(
        principals.id,
        args.requests.map((r) => r.agentId),
      ),
    );
  const byId = new Map(requested.map((r) => [r.id, r]));
  // Only the agent is woken: never one of Whombat's own signers (one-agent.md OA-17), and only in a conversation of its
  // burrow. Every conversation there is the person's with the agent, so a mention anywhere in it wakes the agent.
  const seen = new Set<string>(
    requested
      .filter((r) => r.kind !== 'agent' || !conversation || conversation.burrowId !== args.burrowId)
      .map((r) => r.id),
  );
  // The person wakes the agent — in their Chat, any room of theirs — and its turn is for them (one-person.md OP-S41).
  const person = await personBehind(tx, args);
  // Run control carries on the turn that started the run: its plan step (budgets, projection) goes with it.
  const runOrigin = args.runId ? await originOfRun(tx, args.runId) : null;
  for (const req of args.requests) {
    if (seen.has(req.agentId)) continue;
    seen.add(req.agentId);
    const mode = req.mode ?? 'reply';
    const agent = byId.get(req.agentId);
    const waiting = OWN_TURNS.includes(req.trigger)
      ? []
      : await tx
          .select({ id: dispatches.id, messageId: dispatches.messageId })
          .from(dispatches)
          .where(
            and(
              eq(dispatches.agentId, req.agentId),
              eq(dispatches.conversationId, args.conversationId),
              eq(dispatches.state, 'queued'),
              eq(dispatches.mode, mode),
              // A run's turn carries that run only: another run's queued turn never takes it over (RC-02).
              args.runId ? eq(dispatches.runId, args.runId) : undefined,
              notInArray(dispatches.trigger, [...OWN_TURNS]),
              // A turn waiting for a usage limit's reset is its own (RA-32): a new request gets a turn now.
              isNull(dispatches.requeuedFor),
              // Only the same person's requests share a turn, whatever the source (SUB-29).
              person ? eq(dispatches.onBehalfOfAccountId, person) : isNull(dispatches.onBehalfOfAccountId),
              // A turn carries at most one plan step (WS-04): another step gets its own turn.
              step && step.agentId === req.agentId
                ? or(isNull(dispatches.planStepId), eq(dispatches.planStepId, step.stepId))
                : undefined,
              // Only a queued turn of the same thread, or of the top level for a top-level request (HN-T04): a message
              // that opens its own thread (a person's top-level message in their Chat) gets its own turn, and a queued
              // turn takes in only its own thread's messages (channel-threads.md CH-02).
              args.threadRootId
                ? eq(dispatches.threadRootId, args.threadRootId)
                : isNull(dispatches.threadRootId),
            ),
          );
    // A message with more for the agent than the chat shows (a brief, a Feedback handoff's report) reaches it whole only
    // as the request of its own turn: it never joins a queued turn for an earlier message, only one it already has.
    const queued =
      waiting.length && args.messageId && (await turnOfItsOwn(tx, args.burrowId, req.agentId, args.messageId))
        ? waiting.find((w) => w.messageId === args.messageId)
        : waiting[0];
    // “More detail” is its own turn (concise-replies.md): it neither takes over a queued reply nor absorbs one.
    if (queued && mode !== 'answer') {
      out.push({ dispatchId: queued.id, agentId: req.agentId, created: false });
      if (step && step.agentId === req.agentId) await linkStep(session, args, queued.id, step);
      continue;
    }
    const id = newId('dispatch');
    const linked =
      req.trigger === 'run_control' && runOrigin?.agentId === req.agentId && runOrigin.planStepId
        ? { planId: runOrigin.planId as string, stepId: runOrigin.planStepId }
        : null;
    // A turn in a thread of its person's Chat runs on the thread's choice (chat-runtime.md CR-02, CR-S04).
    const runtime = agent
      ? await dispatchRuntimeFor(tx, {
          agent,
          conversation,
          threadRootId: args.threadRootId,
          trigger: req.trigger,
        })
      : null;
    const [inserted] = await tx
      .insert(dispatches)
      .values({
        id,
        burrowId: args.burrowId,
        agentId: req.agentId,
        trigger: req.trigger,
        mode,
        runtime,
        conversationId: args.conversationId,
        messageId: args.messageId,
        threadRootId: args.threadRootId,
        runId: args.runId ?? null,
        state: 'queued',
        search: args.search ?? null,
        onBehalfOfAccountId: person,
        ...(linked ? { planId: linked.planId, planStepId: linked.stepId } : {}),
        ...(args.scheduleId && req.trigger === 'schedule' ? { scheduleId: args.scheduleId } : {}),
        createdAt: args.at,
      })
      .returning();
    // A new turn in the conversation (work-supervision WS-19).
    if (inserted) publishDispatch(session, inserted);
    await session.append(args.causedById, {
      type: 'dispatch.created',
      kind: 'System',
      text: null,
      where,
      aboutId: req.agentId,
      payload: {
        dispatchId: id,
        agentId: req.agentId,
        trigger: req.trigger,
        mode,
        messageId: args.messageId,
      },
      createdAt: args.at.toISOString(),
    });
    out.push({ dispatchId: id, agentId: req.agentId, created: true });
    if (step && step.agentId === req.agentId) await linkStep(session, args, id, step);
  }
  return out;
}
