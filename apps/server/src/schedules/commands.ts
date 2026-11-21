/**
 * The agent's own schedules, write side (docs/decisions/resourceful-agents.md RA-30, RA-DC12…RA-DC15; RA-DS34…RA-DS38):
 * the agent makes one (`schedule.create`, the MCP `schedule` tool) or cancels one it may see (`schedule.cancel`); people
 * pause, resume and remove one (`schedules.pause|resume|remove`, only the person it is for, one-agent.md OA-S13);
 * Whombat ends one (`endSchedule`: a one-off ran, a repeating one ran its 90 days, its person left). Every change is one
 * signed `schedule.*` event (System) carrying ids, `when` and status, never the prompt, and republishes the room card. A
 * paused schedule's queued turn is cancelled, and so is a stopped one's (cancelled, removed, its person left); one that
 * ran its course keeps the turn it queued last (RA-DS43).
 */
import {
  AgentScheduleId,
  DispatchId,
  describeScheduleWhen,
  newId,
  nextScheduleRun,
  SCHEDULE_PROMPT_MAX,
  SCHEDULES_ACTIVE_MAX,
  type ScheduleEndReason,
  ScheduleWhen,
  scheduleEndsAt,
  scheduleLimitProblem,
  scheduleWhenProblem,
  topics,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext, TxSession } from '../commit/types';
import { defineCommand } from '../commit/types';
import { agentSchedules, dispatches } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { conflict, forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow, loadMessages } from '../read/messages';
import { accountInBurrow, loadAgentRow, loadPrincipalRow, type PrincipalRow } from '../read/principals';
import { publishDispatch } from '../runtime/activity';
import { dispatchRun } from '../runtime/dispatch-scope';
import { activeScheduleCount, lockSchedule, mayChangeSchedule, type ScheduleRow } from './store';

/** Why a turn can't schedule (`unavailable`). */
export const NOT_FOR_A_PERSON =
  'A scheduled turn runs for the person this turn is for, and this turn isn’t for anyone. Schedule it in a turn someone asked for.';
export const NOT_HERE = 'You can’t post in this conversation any more, so nothing can be scheduled here.';

export type CreateOutcome =
  | { status: 'ok'; schedule: ScheduleRow }
  | { status: 'invalid'; problems: string[] }
  | { status: 'unavailable'; message: string };

/** The room card's words (RA-DS35): when it runs, never the prompt (the card itself shows it to the room). */
export function scheduleMessageText(
  when: z.output<typeof ScheduleWhen>,
  timeZone: string,
  now: Date,
): string {
  const described = describeScheduleWhen(when, timeZone, now);
  return `I’ll come back to this ${described.charAt(0).toLowerCase()}${described.slice(1)}.`;
}

/** The turn a tool call comes from, as `schedule` needs it; null when it isn't this agent's. */
async function turnOf(ctx: ApplyContext, dispatchId: string) {
  const [d] = await ctx.tx.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!d || d.agentId !== ctx.actor.id || d.burrowId !== ctx.burrow.id) return null;
  return d;
}

/** Re-sends the schedule's room card, resolved per recipient by the hub (`schedules/frames.ts`). */
export async function republishScheduleCard(
  session: Pick<TxSession, 'tx' | 'publish'>,
  row: Pick<ScheduleRow, 'messageId'>,
  eventId: string | null,
): Promise<void> {
  const message = row.messageId ? await loadMessageRow(session.tx, row.messageId) : undefined;
  if (!message) return;
  const [loaded] = await loadMessages(session.tx, [message], null);
  if (loaded)
    session.publish(
      topics.conversation(message.conversationId),
      { type: 'message.updated', message: loaded },
      { eventId },
    );
}

/** Cancels a schedule's queued turn (it was paused or ended before the turn started). */
export async function cancelQueuedRuns(
  session: Pick<TxSession, 'tx' | 'publish'>,
  scheduleId: string,
  at: Date,
) {
  const cancelled = await session.tx
    .update(dispatches)
    .set({ state: 'cancelled', finishedAt: at, error: 'schedule_stopped' })
    .where(and(eq(dispatches.scheduleId, scheduleId), eq(dispatches.state, 'queued')))
    .returning();
  for (const row of cancelled) publishDispatch(session, row);
  return cancelled.length;
}

/** The signed fields every `schedule.*` event shares (RA-DC12: ids, `when`, status; never the prompt). */
function eventPayload(row: ScheduleRow, extra: Record<string, string | number | null> = {}) {
  return {
    scheduleId: row.id,
    agentId: row.agentId,
    conversationId: row.conversationId,
    threadRootId: row.threadRootId,
    when: row.when,
    status: row.status,
    runs: row.runs,
    ...extra,
  };
}

/**
 * The ends that stop what a schedule queued (RA-DS43): the person or the agent cancelled or removed it. A schedule that
 * ran its course — a one-off after its run (`done`), a repeating one at its 90 days
 * (`expired`) — keeps the turn it queued last: that run was due, and the ticker ends the schedule in the very commit
 * that queues it.
 */
const STOPPING_ENDS: ReadonlySet<ScheduleEndReason> = new Set(['cancelled']);

/**
 * Ends a schedule for good (RA-30): `ended` with its reason, no next run, its queued turn cancelled when the end stops
 * it (`STOPPING_ENDS`), a signed `schedule.ended` by `signerId` (`text` null: Whombat's own bookkeeping, hidden from the
 * log) and the card republished.
 */
export async function endSchedule(
  session: TxSession,
  row: ScheduleRow,
  reason: ScheduleEndReason,
  by: { signerId: string; text: string | null; at: Date },
): Promise<{ eventId: string }> {
  const [ended] = await session.tx
    .update(agentSchedules)
    .set({ status: 'ended', endedReason: reason, nextAt: null, updatedAt: by.at })
    .where(eq(agentSchedules.id, row.id))
    .returning();
  if (STOPPING_ENDS.has(reason)) await cancelQueuedRuns(session, row.id, by.at);
  const agent = await loadPrincipalRow(session.tx, row.agentId);
  const event = await session.append(by.signerId, {
    type: 'schedule.ended',
    kind: 'System',
    text: by.text,
    where: agent ? `Agent · ${agent.name}` : null,
    aboutId: row.agentId,
    ...(agent ? { ref: { type: 'agent' as const } } : {}),
    payload: eventPayload(ended ?? { ...row, status: 'ended' }, { reason }),
    createdAt: iso(by.at),
  });
  await republishScheduleCard(session, row, event.id);
  return { eventId: event.id };
}

/* An agent's own: create and cancel (the `schedule` tool) ----------------------------------------- */

export const createSchedule = defineCommand({
  name: 'schedule.create',
  // The turn it is made in (the MCP handler passes its dispatch): its room, thread and person.
  schema: z.object({
    dispatchId: DispatchId,
    when: ScheduleWhen,
    prompt: z.string().trim().min(1).max(SCHEDULE_PROMPT_MAX),
  }),
  // No key: every agent schedules its own turns (RA-30); what a scheduled turn does is decided by its keys then.
  async apply(tx, ctx, input): Promise<CreateOutcome> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Agents schedule their own turns.');
    const turn = await turnOf(ctx, input.dispatchId);
    if (!turn) throw notFound('Turn');
    // A turn for the person (their keys and passes, RA-30): not a search answer, nor an outsiders' turn (OP-17).
    const person = turn.onBehalfOfAccountId;
    if (!person || turn.search || turn.mode === 'answer' || turn.trigger === 'feedback')
      return { status: 'unavailable', message: NOT_FOR_A_PERSON };
    if (!(await accountInBurrow(tx, ctx.burrow.id, person)))
      return { status: 'unavailable', message: NOT_FOR_A_PERSON };
    const conversation = await loadConversationRow(tx, turn.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id)
      return { status: 'unavailable', message: NOT_HERE };
    const now = ctx.now;
    const problems: string[] = [];
    const whenProblem = scheduleWhenProblem(input.when, now);
    if (whenProblem) problems.push(whenProblem);
    const limit = scheduleLimitProblem(await activeScheduleCount(tx, ctx.actor.id));
    if (limit) problems.push(limit);
    const next = whenProblem ? null : nextScheduleRun(input.when, now, { anchor: now });
    if (!whenProblem && !next) problems.push('That schedule never runs. Pick another time.');
    if (problems.length || !next) return { status: 'invalid', problems };
    const ends = scheduleEndsAt(input.when, now);
    const id = newId('agentSchedule');
    const [row] = await tx
      .insert(agentSchedules)
      .values({
        id,
        burrowId: ctx.burrow.id,
        agentId: ctx.actor.id,
        conversationId: conversation.id,
        threadRootId: turn.threadRootId,
        forAccountId: person,
        prompt: input.prompt,
        when: input.when,
        status: 'active',
        endedReason: null,
        nextAt: new Date(next),
        endsAt: ends ? new Date(ends) : null,
        anchorAt: now,
        runs: 0,
        lastRunAt: null,
        createdByDispatchId: turn.id,
        messageId: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw conflict('The schedule wasn’t saved.');
    // The card in the room (RA-30): server-made, by reference, wakes nobody. Scheduled from a run's turn, it carries
    // that run: a chat shows it inside the run's line (card-settle.md QC-02, CT-261).
    const runId = await dispatchRun(tx, turn);
    const posted = await postMessage(ctx, {
      conversation,
      text: scheduleMessageText(input.when, ctx.burrow.timeZone, now),
      card: { kind: 'schedule', scheduleId: id, ...(runId ? { runId } : {}) },
      threadRootId: turn.threadRootId,
      mentions: [],
      dispatch: false,
      notifyMentions: false,
    });
    const [saved] = await tx
      .update(agentSchedules)
      .set({ messageId: posted.id })
      .where(eq(agentSchedules.id, id))
      .returning();
    await ctx.emit({
      type: 'schedule.created',
      kind: 'System',
      text: 'Scheduled a turn',
      where: `Agent · ${ctx.actor.name}`,
      aboutId: ctx.actor.id,
      ref: { type: 'agent' },
      payload: eventPayload(saved ?? row, { nextAt: next, endsAt: ends }),
    });
    return { status: 'ok', schedule: saved ?? row };
  },
});

export const cancelScheduleByAgent = defineCommand({
  name: 'schedule.cancel',
  schema: z.object({ dispatchId: DispatchId, scheduleId: AgentScheduleId }),
  async apply(tx, ctx, input): Promise<{ schedule: ScheduleRow; eventId: string }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Agents cancel their own schedules here.');
    const turn = await turnOf(ctx, input.dispatchId);
    if (!turn) throw notFound('Turn');
    const row = await lockSchedule(tx, input.scheduleId);
    // Only one of the schedules this turn may see (RA-DC15): its agent's, in this room or for this turn's person.
    const visible =
      row &&
      row.agentId === ctx.actor.id &&
      row.status !== 'ended' &&
      (row.conversationId === turn.conversationId ||
        (turn.onBehalfOfAccountId !== null && row.forAccountId === turn.onBehalfOfAccountId));
    if (!row || !visible) throw notFound('Schedule');
    const { eventId } = await endSchedule(ctx, row, 'cancelled', {
      signerId: ctx.actor.id,
      text: 'Cancelled a schedule',
      at: ctx.now,
    });
    return { schedule: (await lockSchedule(tx, row.id)) ?? row, eventId };
  },
});

/* People's: pause, resume, remove (the Schedules tab and the card's Cancel) ---------------------- */

const PersonInput = z.object({ scheduleId: AgentScheduleId });

/** The agent and its schedule for a person who may change it (else 404 / 403). */
async function changeable(
  ctx: ApplyContext,
  input: z.output<typeof PersonInput>,
): Promise<{ agent: PrincipalRow; row: ScheduleRow }> {
  if (ctx.actor.kind !== 'person') throw forbidden('Only you can change the agent’s schedules here.');
  const agent = await loadAgentRow(ctx.tx, ctx.burrow.id);
  if (!agent) throw notFound('Agent');
  const row = await lockSchedule(ctx.tx, input.scheduleId);
  if (!row || row.agentId !== agent.id || row.burrowId !== ctx.burrow.id) throw notFound('Schedule');
  if (!mayChangeSchedule(ctx.actor)) throw forbidden('Only you change the agent’s schedules.');
  return { agent, row };
}

export const pauseSchedule = defineCommand({
  name: 'schedules.pause',
  schema: PersonInput,
  async apply(tx, ctx, input): Promise<{ scheduleId: string; eventId: string | null }> {
    const { agent, row } = await changeable(ctx, input);
    if (row.status === 'paused') return { scheduleId: row.id, eventId: null };
    if (row.status !== 'active') throw conflict('This schedule has ended.');
    const [paused] = await tx
      .update(agentSchedules)
      .set({ status: 'paused', nextAt: null, updatedAt: ctx.now })
      .where(eq(agentSchedules.id, row.id))
      .returning();
    await cancelQueuedRuns(ctx, row.id, ctx.now);
    const event = await ctx.emit({
      type: 'schedule.paused',
      kind: 'System',
      text: `Paused ${agent.name}’s schedule`,
      where: `Agent · ${agent.name}`,
      aboutId: agent.id,
      ref: { type: 'agent' },
      payload: eventPayload(paused ?? row),
    });
    await republishScheduleCard(ctx, row, event.id);
    return { scheduleId: row.id, eventId: event.id };
  },
});

/**
 * Resume (RA-30, RA-DC14): a paused schedule runs again from now (an `every` one counts its interval from now); one
 * that ran its 90 days is renewed for 90 more. The agent's 20 active hold; a one-off whose time passed while it was
 * paused can't come back.
 */
export const resumeSchedule = defineCommand({
  name: 'schedules.resume',
  schema: PersonInput,
  async apply(tx, ctx, input): Promise<{ scheduleId: string; eventId: string | null }> {
    const { agent, row } = await changeable(ctx, input);
    if (row.status === 'active') return { scheduleId: row.id, eventId: null };
    const now = ctx.now;
    // Ran its 90 days (or they passed while it was paused): renewed for 90 more.
    const renew =
      (row.status === 'ended' && row.endedReason === 'expired') ||
      (row.status === 'paused' && row.endsAt !== null && row.endsAt <= now);
    if (row.status === 'ended' && !renew) throw conflict('This schedule has ended.');
    if ((await activeScheduleCount(tx, agent.id)) >= SCHEDULES_ACTIVE_MAX)
      throw conflict(
        `${agent.name} has ${SCHEDULES_ACTIVE_MAX} active schedules, the most an agent keeps. Pause or remove one first.`,
      );
    const next = nextScheduleRun(row.when, now, { anchor: now });
    if (!next) throw conflict('Its time has passed. Ask the agent to schedule it again.');
    const ends = renew ? scheduleEndsAt(row.when, now) : row.endsAt ? iso(row.endsAt) : null;
    if (ends && Date.parse(next) >= Date.parse(ends))
      throw conflict('It ran its 90 days. Ask the agent to schedule it again.');
    const [resumed] = await tx
      .update(agentSchedules)
      .set({
        status: 'active',
        endedReason: null,
        nextAt: new Date(next),
        endsAt: ends ? new Date(ends) : null,
        anchorAt: now,
        updatedAt: now,
      })
      .where(eq(agentSchedules.id, row.id))
      .returning();
    const event = await ctx.emit({
      type: 'schedule.resumed',
      kind: 'System',
      text: renew ? `Renewed ${agent.name}’s schedule` : `Resumed ${agent.name}’s schedule`,
      where: `Agent · ${agent.name}`,
      aboutId: agent.id,
      ref: { type: 'agent' },
      payload: eventPayload(resumed ?? row, { nextAt: next, endsAt: ends, renewed: renew ? 1 : 0 }),
    });
    await republishScheduleCard(ctx, row, event.id);
    return { scheduleId: row.id, eventId: event.id };
  },
});

export const removeSchedule = defineCommand({
  name: 'schedules.remove',
  schema: PersonInput,
  async apply(_tx, ctx, input): Promise<{ scheduleId: string; eventId: string | null }> {
    const { agent, row } = await changeable(ctx, input);
    if (row.status === 'ended') throw conflict('This schedule has ended already.');
    const { eventId } = await endSchedule(ctx, row, 'cancelled', {
      signerId: ctx.actor.id,
      text: `Removed ${agent.name}’s schedule`,
      at: ctx.now,
    });
    return { scheduleId: row.id, eventId };
  },
});
