/**
 * Same-person follow-ups into a running turn (docs/decisions/steering.md; contracts 0.55.0 CT-305).
 *
 * A person who writes again while the agent works on their request in the same conversation and thread queues a
 * follow-up dispatch as before (coalescing, `domain/dispatch.ts`). Each beat of the running turn now offers it to the
 * turn (`ProgressResponse.inject`, every message the queued dispatch carries, oldest first); once the runner reports it
 * delivered (`ProgressBody.injected`) the queued dispatch is closed as merged: `cancelled`, `error = merged:<turn>` (the
 * server-only link, SX-11), shown as `TURN_MERGED_REASON`, `dispatch.updated`. A follow-up the runner never reports runs
 * as its own turn, as before. Nothing about what wakes an agent changes: mentions of other agents, other people's
 * messages and other threads queue and run as they did, and AH-01/AH-02 and the reply-to rules decide what is queued.
 *
 * Which turn takes which follow-up (SX-07): a turn for a person (`on_behalf_of`) that is a chat turn or a run's turn
 * of a person's kind (a mention, a DM, a retry, a yes or no to an ask, a Vault pass, run control), never one Whombat
 * owns or a plan step's; a queued `mention`/`dm` of the same agent, conversation, thread and person, never claimed, with
 * nothing of its own (a plan step, an approval, a schedule, a retry, a usage-limit requeue); a reply-mode one, or the
 * same run's answer for a run's turn. Of two turns of that person in flight there (HRS-01), the one claimed last.
 *
 * The messages a queued dispatch carries: its trigger and the person's later messages in the same place that don't
 * name only others. One the person wrote elsewhere in the conversation has a turn of its own there (coalescing is per
 * thread), so it never keeps the dispatch out. A message Whombat posts for the
 * person with more for the agent than the chat shows (a brief, a Feedback handoff's report) reaches the agent whole only
 * as the request of a turn of its own: it is never offered, and a follow-up is offered only up to it. It also never
 * coalesces into a queued follow-up (`domain/dispatch.ts`), so the merge finds its own queued turn.
 *
 * What a follow-up is offered with is fixed at its first offer and kept in memory per turn (SX-10), so a report always
 * means those messages. The merge runs under the burrow lock (serialized with the enqueue that coalesces); a message
 * the follow-up took on after its offer becomes a follow-up of its own, queued in the same commit (offered next beat).
 * After a restart nothing was offered: the next report re-offers, the one after merges.
 */
import { type DispatchTrigger, TURN_INJECT_MAX, type TurnInjection } from '@whombat/core';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { dispatches, messages, principals } from '../db/schema/index';
import { ownTurnMessages } from '../domain/agent-brief';
import { enqueueInSession } from '../domain/dispatch';
import { dispatchAttachments } from '../files/dispatch';
import { loadMessages } from '../read/messages';
import type { Services } from '../services';
import { publishDispatch } from './activity';
import { type DispatchRow, WINDOW_SIZE } from './context';

/** `dispatches.error` of a follow-up merged into a running turn: `merged:<that turn's id>` (SX-11). */
export const MERGED_ERROR_PREFIX = 'merged:';

/** Turns that take follow-ups: a person's own kinds of turn (SX-07). */
const TURN_TRIGGERS: ReadonlySet<DispatchTrigger> = new Set<DispatchTrigger>([
  'mention',
  'dm',
  'retry',
  'approval_granted',
  'approval_declined',
  'run_control',
  // A person's Undo of a change the agent reported (home-redesign.md HR-03): their message is the trigger.
  'undo_requested',
  // The step a person let the assistant take on a look (look-research.md LR-08): their press is the trigger.
  'look_fix',
]);

/** What a follow-up is: a person's message that woke the agent. */
const FOLLOW_UP_TRIGGERS: DispatchTrigger[] = ['mention', 'dm'];

type Turn = Pick<
  DispatchRow,
  | 'id'
  | 'agentId'
  | 'conversationId'
  | 'threadRootId'
  | 'onBehalfOfAccountId'
  | 'mode'
  | 'runId'
  | 'trigger'
  | 'search'
  | 'planStepId'
  | 'scheduleId'
>;

/** Whether a turn takes follow-ups (SX-07): a person's chat or run turn of a person's kind. */
export function steerableTurn(row: Turn): boolean {
  return (
    !!row.onBehalfOfAccountId &&
    (row.mode === 'reply' || row.mode === 'run') &&
    TURN_TRIGGERS.has(row.trigger) &&
    !row.search &&
    !row.planStepId &&
    !row.scheduleId
  );
}

/** The queued follow-ups that may join `turn`, oldest first (SX-07). */
function followUpsOf(turn: Turn) {
  const person = turn.onBehalfOfAccountId as string;
  const reply = and(eq(dispatches.mode, 'reply'), isNull(dispatches.runId));
  return and(
    eq(dispatches.agentId, turn.agentId),
    eq(dispatches.conversationId, turn.conversationId),
    eq(dispatches.state, 'queued'),
    eq(dispatches.onBehalfOfAccountId, person),
    turn.threadRootId ? eq(dispatches.threadRootId, turn.threadRootId) : isNull(dispatches.threadRootId),
    inArray(dispatches.trigger, FOLLOW_UP_TRIGGERS),
    // A run's turn also takes the same run's answer (RA-DS62) that came while it ran.
    turn.mode === 'run' && turn.runId
      ? or(reply, and(eq(dispatches.mode, 'run'), eq(dispatches.runId, turn.runId)))
      : reply,
    isNotNull(dispatches.messageId),
    eq(dispatches.attempts, 0),
    isNull(dispatches.requeuedFor),
    isNull(dispatches.planStepId),
    isNull(dispatches.approvalId),
    isNull(dispatches.scheduleId),
    isNull(dispatches.retryOfId),
    isNull(dispatches.search),
  );
}

/** How many of the person's messages since a follow-up's trigger are read to tell what it carries. */
const CARRIED_LOOKAHEAD = TURN_INJECT_MAX * 4;

interface Offered {
  messageIds: string[];
  items: TurnInjection[];
}

export class FollowUps {
  readonly #services: Services;
  /** Per running turn: per queued follow-up, what it is offered with, fixed at its first offer (SX-10). */
  readonly #offered = new Map<string, Map<string, Offered>>();

  constructor(services: Services) {
    this.#services = services;
  }

  /**
   * One beat of a running turn whose lease holds and that isn't stopping: merges what the runner delivered, then
   * answers what is waiting for it. Never fails the beat (a failed beat loses the lease): a problem is logged, and the
   * follow-ups run as their own turns.
   */
  async beat(turn: DispatchRow, injected: readonly string[]): Promise<TurnInjection[]> {
    try {
      if (!steerableTurn(turn)) {
        this.forget(turn.id);
        return [];
      }
      if (injected.length) await this.#merge(turn, injected);
      return await this.#offer(turn);
    } catch (err) {
      this.#services.log.warn({ err: String(err), dispatchId: turn.id }, 'follow-ups for a running turn');
      return [];
    }
  }

  /** The turn ended (or was handed back): nothing more is offered to it. */
  forget(turnId: string): void {
    this.#offered.delete(turnId);
  }

  async #merge(turn: DispatchRow, injected: readonly string[]): Promise<void> {
    const offered = this.#offered.get(turn.id);
    for (const queuedId of new Set(injected)) {
      // Never offered by this server (it restarted since): offered again now, merged when the runner reports it again.
      const last = offered?.get(queuedId);
      if (!last) continue;
      const now = this.#services.clock();
      // Under the burrow lock: a message the person sends meanwhile coalesces before or after, never in between.
      const { result } = await this.#services.pipeline.transact(turn.burrowId, async (session) => {
        const tx = session.tx;
        const [queued] = await tx
          .select()
          .from(dispatches)
          .where(and(eq(dispatches.id, queuedId), followUpsOf(turn)));
        if (!queued) return null;
        const carried = await this.#carried(tx, turn, queued);
        if (!carried) return null;
        const [row] = await tx
          .update(dispatches)
          .set({ state: 'cancelled', error: `${MERGED_ERROR_PREFIX}${turn.id}`, finishedAt: now })
          .where(and(eq(dispatches.id, queuedId), eq(dispatches.state, 'queued')))
          .returning();
        if (!row) return null;
        publishDispatch(session, row);
        // What it took on after its offer is a follow-up of its own (SX-10): offered next, or run as a turn.
        const rest = carried.filter((m) => !last.messageIds.includes(m.id));
        const next = rest[0];
        if (next)
          await enqueueInSession(session, {
            burrowId: turn.burrowId,
            causedById: next.authorId,
            conversationId: queued.conversationId,
            messageId: next.id,
            threadRootId: queued.threadRootId,
            requests: [{ agentId: queued.agentId, trigger: queued.trigger, mode: queued.mode }],
            at: now,
            runId: queued.runId,
            onBehalfOfAccountId: queued.onBehalfOfAccountId,
          });
        return { took: carried.length - rest.length, left: rest.length };
      });
      offered?.delete(queuedId);
      if (result)
        this.#services.log.info(
          { dispatchId: queuedId, turnId: turn.id, ...result },
          'a follow-up was answered in the running turn',
        );
    }
  }

  async #offer(turn: DispatchRow): Promise<TurnInjection[]> {
    const db = this.#services.db;
    const queued = await db
      .select()
      .from(dispatches)
      .where(followUpsOf(turn))
      .orderBy(asc(dispatches.createdAt), asc(dispatches.id));
    if (!queued.length || !(await this.#takesThem(turn))) {
      this.forget(turn.id);
      return [];
    }
    const before = this.#offered.get(turn.id);
    const now = new Map<string, Offered>();
    const out: TurnInjection[] = [];
    for (const q of queued) {
      // Still able to join (a message elsewhere since keeps it out), in order: one that can't keeps the later ones out.
      const carried = await this.#carried(db, turn, q);
      if (!carried?.length) break;
      // Only up to a message that needs a turn of its own: the merge queues it, and what follows it, as a follow-up of
      // its own, which then runs as its own turn.
      const own = await ownTurnMessages(db, turn.burrowId, turn.agentId, carried);
      const cut = carried.findIndex((m) => own.has(m.id));
      const offerable = cut === -1 ? carried : carried.slice(0, cut);
      if (!offerable.length) break;
      const offer =
        before?.get(q.id) ??
        (out.length + offerable.length <= TURN_INJECT_MAX
          ? { messageIds: offerable.map((m) => m.id), items: await this.#items(turn, q.id, offerable) }
          : null);
      if (!offer || out.length + offer.items.length > TURN_INJECT_MAX) break;
      now.set(q.id, offer);
      out.push(...offer.items);
      if (cut !== -1) break;
    }
    if (now.size) this.#offered.set(turn.id, now);
    else this.forget(turn.id);
    return out;
  }

  /** Of the person's turns in flight in this place, only the one claimed last takes follow-ups (HRS-01's pair). */
  async #takesThem(turn: DispatchRow): Promise<boolean> {
    const inFlight = await this.#services.db
      .select()
      .from(dispatches)
      .where(
        and(
          eq(dispatches.agentId, turn.agentId),
          eq(dispatches.conversationId, turn.conversationId),
          inArray(dispatches.state, ['claimed', 'running']),
          eq(dispatches.onBehalfOfAccountId, turn.onBehalfOfAccountId as string),
          turn.threadRootId
            ? eq(dispatches.threadRootId, turn.threadRootId)
            : isNull(dispatches.threadRootId),
        ),
      )
      .orderBy(desc(dispatches.claimedAt), desc(dispatches.id));
    return inFlight.find(steerableTurn)?.id === turn.id;
  }

  /**
   * The messages a queued follow-up carries for this turn (SX-09), oldest first: its trigger and the same person's
   * later messages in the turn's place that don't name only others. Null when it can't join: its trigger isn't a
   * person's message here. What the person wrote elsewhere since is another place's turn (HN-T05).
   */
  async #carried(db: Db | Tx, turn: Turn, queued: Pick<DispatchRow, 'messageId'>) {
    if (!queued.messageId) return null;
    const [first] = await db
      .select({ id: messages.id, ord: messages.ord, authorId: messages.authorId, kind: principals.kind })
      .from(messages)
      .innerJoin(principals, eq(principals.id, messages.authorId))
      .where(and(eq(messages.id, queued.messageId), eq(messages.conversationId, turn.conversationId)));
    if (first?.kind !== 'person') return null;
    const rows = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, turn.conversationId),
          eq(messages.authorId, first.authorId),
          gte(messages.ord, first.ord),
        ),
      )
      .orderBy(asc(messages.ord))
      .limit(CARRIED_LOOKAHEAD);
    // More than that since the follow-up: too many to tell what it carries; it runs as its own turn.
    if (rows.length >= CARRIED_LOOKAHEAD) return null;
    const carried: typeof rows = [];
    for (const m of rows) {
      if (m.deletedAt) continue;
      const forOthers = m.mentions.length > 0 && !m.mentions.includes(turn.agentId);
      // Elsewhere (another thread, or the top level of a thread's turn): its own turn there, never in this dispatch.
      const here = (m.threadRootId ?? null) === (turn.threadRootId ?? null);
      if (here && (!forOthers || m.id === first.id)) carried.push(m);
    }
    return carried.length && carried[0]?.id === first.id ? carried : null;
  }

  /** The follow-up's messages as the agent reads them, with the files the turn may fetch (runnerFetch's own rule). */
  async #items(
    turn: DispatchRow,
    queuedId: string,
    rows: Parameters<typeof loadMessages>[1],
  ): Promise<TurnInjection[]> {
    const db = this.#services.db;
    const shown = await loadMessages(db, rows, turn.agentId);
    const out: TurnInjection[] = [];
    for (const message of shown) {
      const attachments = await dispatchAttachments(db, turn, WINDOW_SIZE, [message]);
      out.push({ dispatchId: queuedId, messageId: message.id, message, attachments });
    }
    return out;
  }
}
