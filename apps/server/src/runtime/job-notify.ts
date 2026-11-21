/**
 * Background jobs wake their agent (docs/decisions/resourceful-agents.md RA-31; one-person.md OP-S43): a job the agent
 * left running in its pod (a build, a test run) says `whombat notify` when it is done; the runner hands that to the
 * server (`runner.notify`, `takeJobNotify`). The turn the job names must be this agent's, the person's (never an
 * outsiders' turn, OP-17) and at most `NOTIFY_TURN_MAX_AGE_DAYS` old, and the agent is woken by at most
 * `NOTIFY_PER_HOUR_MAX` of them an hour. Then the job's words are posted in that turn's conversation and thread — as
 * the agent, under a “From Dusty’s background job” pill, so the person sees what woke it — and the agent is woken
 * there (trigger `notify`), the post being the new turn's trigger message: `DispatchContext.notify` is read from it.
 * The post's client id carries the turn that started the job and the event (`notify:<dispatch>:<hash>`), so an event
 * handed over twice is taken once.
 */
import { createHash } from 'node:crypto';
import {
  type DispatchContext,
  type Message,
  NOTIFY_PER_HOUR_MAX,
  NOTIFY_TEXT_MAX,
  NOTIFY_TURN_MAX_AGE_DAYS,
} from '@whombat/core';
import { and, count, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import { dispatches, messages, principals, runs } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { wakeQuietly } from '../domain/wake';
import { forbidden } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import type { Services } from '../services';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Why a notify isn't taken (logged, never shown: the job printed “Sent” already). */
export const NOTIFY_REFUSALS = {
  unknown_turn: 'it names no turn of this Whombat',
  other_agent: 'it names another agent’s turn',
  too_old: `its turn is older than ${NOTIFY_TURN_MAX_AGE_DAYS} days`,
  too_many: `the agent was woken by ${NOTIFY_PER_HOUR_MAX} notifies in the last hour`,
  empty: 'it says nothing',
  gone: 'the agent can’t be woken there any more',
  outside: 'it names an outsiders’ turn',
} as const;
export type NotifyRefusal = keyof typeof NOTIFY_REFUSALS;

export type NotifyOutcome =
  | { outcome: 'woken'; dispatchId: string; messageId: string; created: boolean }
  | { outcome: 'duplicate'; messageId: string }
  | { outcome: 'refused'; reason: NotifyRefusal };

/** Thrown inside the command to undo the post when the agent can't be woken after all. */
export class NotifyRefused extends Error {
  constructor(readonly reason: NotifyRefusal) {
    super(NOTIFY_REFUSALS[reason]);
    this.name = 'NotifyRefused';
  }
}

const CLIENT_PREFIX = 'notify:';

/** The post's client id: the turn that started the job and 12 hex of the event's id (≤ 64, the contracts' limit). */
export function notifyClientId(fromDispatchId: string, eventId: string): string {
  return `${CLIENT_PREFIX}${fromDispatchId}:${createHash('sha256').update(eventId).digest('hex').slice(0, 12)}`;
}

/** The turn that started the job, from a post's client id; null for any other message. */
export function notifyOrigin(clientId: string | null | undefined): string | null {
  return /^notify:([A-Za-z0-9_-]{1,48}):[0-9a-f]{12}$/.exec(clientId ?? '')?.[1] ?? null;
}

/** The pill under the job's words. */
export function notifyPillText(agentName: string): string {
  return `From ${agentName}’s background job`;
}

/** At most `max` UTF-16 units, never half a character. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/**
 * `DispatchContext.notify` of a `notify` turn: the job's words (its trigger message, the agent's own post) and the turn
 * that started the job; null for any other turn, or when the post isn't one (a queued turn took the wake over).
 */
export function notifyContextOf(
  row: { trigger: string },
  trigger: Pick<Message, 'text' | 'clientId'> | null,
): NonNullable<DispatchContext['notify']> | null {
  if (row.trigger !== 'notify' || !trigger) return null;
  const fromDispatchId = notifyOrigin(trigger.clientId);
  return fromDispatchId ? { text: cut(trigger.text, NOTIFY_TEXT_MAX), fromDispatchId } : null;
}

async function liveRun(tx: Tx, runId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.status, 'live')));
  return row?.id ?? null;
}

/** The job's words in the turn's thread, and the agent woken there (run by the pipeline as the agent). */
export const wakeFromJob = defineCommand({
  name: 'agent.job_notify',
  // A new turn: a lapsed appliance refuses it up front (LC-10).
  licence: 'agentTurn',
  schema: z.object({
    fromDispatchId: z.string().min(1).max(80),
    eventId: z.string().min(1).max(40),
    text: z.string().max(16_000),
  }),
  async apply(tx, ctx, input): Promise<NotifyOutcome> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent’s own jobs wake it.');
    const agentId = ctx.actor.id;
    const refused = (reason: NotifyRefusal): NotifyOutcome => ({ outcome: 'refused', reason });
    const [origin] = await tx.select().from(dispatches).where(eq(dispatches.id, input.fromDispatchId));
    if (!origin || origin.burrowId !== ctx.burrow.id) return refused('unknown_turn');
    // The runner names the agent; the turn is whatever the job's environment said (RA-DK12).
    if (origin.agentId !== agentId) return refused('other_agent');
    // Only the person's own work wakes the agent: a job of an outsiders' turn stays quiet (OP-17).
    if (!origin.onBehalfOfAccountId) return refused('outside');
    if (ctx.now.getTime() - origin.createdAt.getTime() > NOTIFY_TURN_MAX_AGE_DAYS * DAY)
      return refused('too_old');
    const text = input.text.trim();
    if (!text) return refused('empty');
    // Taken already (the runner handed it over again: it didn't hear the answer).
    const clientId = notifyClientId(origin.id, input.eventId);
    const [taken] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, origin.conversationId),
          eq(messages.authorId, agentId),
          eq(messages.clientId, clientId),
        ),
      );
    if (taken) return { outcome: 'duplicate', messageId: taken.id };
    // Turns, not posts.
    const [recent] = await tx
      .select({ n: count() })
      .from(dispatches)
      .where(
        and(
          eq(dispatches.agentId, agentId),
          eq(dispatches.trigger, 'notify'),
          gte(dispatches.createdAt, new Date(ctx.now.getTime() - HOUR)),
        ),
      );
    if ((recent?.n ?? 0) >= NOTIFY_PER_HOUR_MAX) return refused('too_many');
    const conversation = await loadConversationRow(tx, origin.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) return refused('gone');
    const posted = await postMessage(ctx, {
      conversation,
      text,
      card: { kind: 'pill', text: notifyPillText(ctx.actor.name), tone: 'neutral' },
      threadRootId: origin.threadRootId,
      clientId,
      // The job's words wake and notify nobody: the turn that follows answers.
      mentions: [],
      dispatch: false,
      notifyMentions: false,
      notifyDmPerson: false,
    });
    // A run turn's job goes on in the run while it is live (its checkout), else in a plain turn.
    const runId = origin.mode === 'run' && origin.runId ? await liveRun(tx, origin.runId) : null;
    const woken = await wakeQuietly(ctx, {
      agentId,
      conversationId: conversation.id,
      threadRootId: origin.threadRootId,
      person: origin.onBehalfOfAccountId,
      trigger: 'notify',
      // Its own turn, with `DispatchContext.notify`; a notify turn already queued there takes it over.
      coalesce: false,
      runId,
      messageId: posted.id,
    });
    // Not woken: nothing is posted either.
    if (!woken) throw new NotifyRefused('gone');
    return { outcome: 'woken', dispatchId: woken.dispatchId, messageId: posted.id, created: woken.created };
  },
});

type Log = Pick<Services['log'], 'info' | 'warn'>;

/** A job's `whombat notify` as the runner hands it over (`runner.notify`). */
export interface JobNotify {
  /** The turn that started the job (`WHOMBAT_TURN` in its environment). */
  fromDispatchId: string;
  /** The event's own id: the same one twice is taken once. */
  eventId: string;
  text: string;
}

/** One job's notify (RA-31): it wakes the agent of the turn it names, or is refused. Never throws. */
export async function takeJobNotify(
  services: Services,
  notify: JobNotify,
  log: Log = services.log,
): Promise<NotifyOutcome | null> {
  // Never the text in a log: anything a job printed may be in it.
  const where = { turn: notify.fromDispatchId, event: notify.eventId };
  const [origin] = await services.db
    .select({ agentId: dispatches.agentId, burrowId: dispatches.burrowId })
    .from(dispatches)
    .where(eq(dispatches.id, notify.fromDispatchId));
  const [agent] = origin
    ? await services.db
        .select({ id: principals.id, burrowId: principals.burrowId, kind: principals.kind })
        .from(principals)
        .where(eq(principals.id, origin.agentId))
    : [];
  if (!origin || agent?.kind !== 'agent') {
    log.info(where, `a notify wasn’t taken: ${NOTIFY_REFUSALS.unknown_turn}`);
    return { outcome: 'refused', reason: 'unknown_turn' };
  }
  try {
    const res = await services.pipeline.commit(
      wakeFromJob,
      { fromDispatchId: notify.fromDispatchId, eventId: notify.eventId, text: notify.text },
      { burrowId: agent.burrowId, actorId: agent.id },
    );
    if (res.status !== 'ok') {
      log.warn({ ...where, status: res.status }, 'a notify wasn’t taken');
      return null;
    }
    const out = res.result;
    if (out.outcome === 'refused') log.info(where, `a notify wasn’t taken: ${NOTIFY_REFUSALS[out.reason]}`);
    else if (out.outcome === 'woken')
      log.info({ ...where, dispatchId: out.dispatchId }, 'a background job woke its agent');
    return out;
  } catch (err) {
    if (err instanceof NotifyRefused) {
      log.info(where, `a notify wasn’t taken: ${err.message}`);
      return { outcome: 'refused', reason: err.reason };
    }
    log.warn({ ...where, err: err instanceof Error ? err.message : String(err) }, 'a notify wasn’t taken');
    return null;
  }
}
