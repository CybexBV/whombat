/**
 * Plans as the server stores and writes them (docs/decisions/work-supervision.md WS-01…WS-10, WS-20, WS-21).
 *
 * Every plan change goes through `savePlan` inside a commit (or a session holding the burrow lock): the row, one
 * signed `plan.updated` event (ids and old/new links and states in the payload, never titles or notes; its text
 * names the plan only in channels and branch rooms), the `plan.updated` frame for the plan's members, the `PLAN`
 * search document in the same transaction, and the needs-you notifications a blocked step warrants (once per
 * recipient and dedup key, WS-20). A plan is the agent's own work: steps have no owner (one-agent.md OA-14).
 */
import {
  conversationLabel,
  type JsonObject,
  type LinkRef,
  type Plan,
  planStepRemovable,
  type SignedEvent,
  topics,
} from '@whombat/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ApplyContext, BurrowRow, EmitFields, TxSession } from '../commit/types';
import type { Db } from '../db/client';
import { messages, plans, type StoredPlanStep } from '../db/schema/index';
import { publishChatChanged } from '../home/notify';
import { iso } from '../lib/time';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadPrincipalsByIds, shortName } from '../read/principals';
import { loadPlan } from '../read/work';
import { linkOfConversation } from './links';
import { type NotificationDraft, notify } from './notify';
import { indexPlan } from './search-index';
import { thePerson } from './the-person';

export type PlanRow = typeof plans.$inferSelect;
export type StoredStep = StoredPlanStep;

/**
 * Who writes a plan change: a session holding the burrow lock, the burrow, who the change is by (they sign it and
 * are not notified about it) and when.
 */
export interface PlanWriter {
  session: TxSession;
  burrow: BurrowRow;
  actorId: string;
  now: Date;
  emit(fields: EmitFields): Promise<SignedEvent>;
}

/** A command's writer: signs as the actor, with its key used and on-behalf-of (`ctx.emit`). */
export function commandWriter(ctx: ApplyContext): PlanWriter {
  return { session: ctx, burrow: ctx.burrow, actorId: ctx.actor.id, now: ctx.now, emit: ctx.emit };
}

/** A runtime writer (following linked work, the startup reconcile): signs as `signerId`. */
export function sessionWriter(
  session: TxSession,
  burrow: BurrowRow,
  signerId: string,
  now: Date,
): PlanWriter {
  return {
    session,
    burrow,
    actorId: signerId,
    now,
    emit: (fields) => session.append(signerId, { createdAt: iso(now), ...fields }),
  };
}

/** The plan row, locked for the rest of the transaction; null when it isn't in this burrow. */
export async function lockPlanRow(db: Db, burrowId: string, planId: string): Promise<PlanRow | null> {
  const [row] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.burrowId, burrowId)))
    .for('update');
  return row ?? null;
}

/**
 * Whether a step can be removed outright (WS-07): the contract's rule, plus our own record that it was started (marked
 * in progress by hand), so a started step is never removed.
 */
export function stepRemovable(step: StoredStep): boolean {
  return planStepRemovable({ ...step, followKey: step.followKey || (step.startedAt ? 'started' : null) });
}

/** A new queued step. */
export function newStep(id: string, title: string, at: string | null): StoredStep {
  return {
    id,
    title,
    state: 'queued',
    stateLabel: 'Queued',
    runId: null,
    approvalId: null,
    automationRunId: null,
    dispatchId: null,
    note: null,
    updatedAt: at,
    refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
    followKey: null,
    startedAt: null,
  };
}

const LINK_FIELDS = ['runId', 'approvalId', 'automationRunId', 'dispatchId'] as const;
const WATCHED = ['title', 'state', 'stateLabel', 'note', ...LINK_FIELDS] as const;

function same(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/** Steps with `updatedAt` stamped on the ones whose visible fields changed. */
function stamp(before: readonly StoredStep[], after: readonly StoredStep[], at: string): StoredStep[] {
  const byId = new Map(before.map((s) => [s.id, s]));
  return after.map((s) => {
    const was = byId.get(s.id);
    if (!was) return { ...s, updatedAt: s.updatedAt ?? at };
    return WATCHED.some((f) => !same(was[f], s[f])) ? { ...s, updatedAt: at } : s;
  });
}

/**
 * The signed payload of a change: ids, states and links before and after — never titles or notes (a DM's plan stays
 * out of the burrow-wide log, WS-10). A replaced link keeps its previous id here (WS-03).
 */
export function planChangePayload(
  before: Pick<PlanRow, 'title' | 'due' | 'steps'> | null,
  after: Pick<PlanRow, 'title' | 'due' | 'steps'>,
): JsonObject {
  const was = new Map((before?.steps ?? []).map((s) => [s.id, s]));
  const now = new Set(after.steps.map((s) => s.id));
  const steps: JsonObject[] = [];
  for (const s of after.steps) {
    const prev = was.get(s.id);
    if (!prev) continue;
    const change: JsonObject = {};
    if (!same(prev.state, s.state)) change.state = [prev.state, s.state];
    if (!same(prev.title, s.title)) change.title = true;
    if (!same(prev.note, s.note)) change.note = true;
    for (const f of LINK_FIELDS) if (!same(prev[f], s[f])) change[f] = [prev[f] ?? null, s[f] ?? null];
    if (!same(prev.followKey, s.followKey)) change.followKey = s.followKey ?? null;
    if (Object.keys(change).length) steps.push({ stepId: s.id, ...change });
  }
  const beforeOrder = (before?.steps ?? []).map((s) => s.id).filter((id) => now.has(id));
  const afterOrder = after.steps.map((s) => s.id).filter((id) => was.has(id));
  return {
    ...(before && before.title !== after.title ? { renamed: true } : {}),
    ...(before && !same(before.due, after.due) ? { due: [before.due ?? null, after.due ?? null] } : {}),
    added: after.steps.filter((s) => !was.has(s.id)).map((s) => s.id),
    removed: (before?.steps ?? []).filter((s) => !now.has(s.id)).map((s) => s.id),
    ...(beforeOrder.join() !== afterOrder.join() ? { reordered: true } : {}),
    steps,
  };
}

/** “Updated the plan “Invoice PDF export”” in a channel or branch room; a DM's plan isn't named (WS-10). */
export function planEventText(
  conversation: Pick<ConversationRow, 'kind'> | undefined,
  title: string,
  verb: 'made' | 'updated',
): string {
  const named = conversation && conversation.kind !== 'dm';
  if (verb === 'made') return named ? `Made the plan “${title}”` : 'Made a plan';
  return named ? `Updated the plan “${title}”` : 'Updated a plan';
}

export function planWhere(conversation: ConversationRow | undefined): string | null {
  if (!conversation) return null;
  return conversation.kind === 'dm' ? 'a DM' : conversationLabel(conversation);
}

export async function planLink(db: Db, plan: Pick<PlanRow, 'id' | 'conversationId'>, stepId?: string) {
  const conversation = await loadConversationRow(db, plan.conversationId);
  if (!conversation) return null;
  const link: LinkRef = { type: 'plan', planId: plan.id, in: await linkOfConversation(db, conversation) };
  if (stepId) link.stepId = stepId;
  return link;
}

export interface PlanChange {
  title?: string;
  due?: string | null;
  steps?: StoredStep[];
  /** Audit text (null: a hidden change, e.g. following linked work or a canvas block sync). */
  text: string | null;
  /** Extra payload (`{canvasId}` for a canvas edit). */
  payload?: JsonObject;
  /** Publish the plan even when nothing changed (the canvas block must be re-synced after a refused removal). */
  republish?: boolean;
}

/** Writes a plan change (see the module comment). Returns the plan as read after the change. */
export async function savePlan(
  w: PlanWriter,
  before: PlanRow,
  change: PlanChange,
): Promise<Plan | undefined> {
  const tx = w.session.tx;
  const at = iso(w.now);
  const next = {
    title: change.title ?? before.title,
    due: change.due !== undefined ? change.due : before.due,
    steps: stamp(before.steps, change.steps ?? before.steps, at),
  };
  const changed =
    next.title !== before.title ||
    !same(next.due, before.due) ||
    JSON.stringify(next.steps) !== JSON.stringify(before.steps);
  if (!changed) {
    const plan = await loadPlan(tx, before.id);
    if (change.republish && plan)
      w.session.publish(topics.burrow(w.burrow.id), { type: 'plan.updated', plan });
    return plan;
  }
  await tx
    .update(plans)
    .set({ title: next.title, due: next.due, steps: next.steps, updatedAt: w.now })
    .where(eq(plans.id, before.id));
  const conversation = await loadConversationRow(tx, before.conversationId);
  const event = await w.emit({
    type: 'plan.updated',
    kind: 'Messages',
    text: change.text,
    where: planWhere(conversation),
    ...(change.text ? { ref: (await planLink(tx, before)) ?? undefined } : {}),
    payload: {
      planId: before.id,
      conversationId: before.conversationId,
      ...planChangePayload(before, next),
      ...(change.payload ?? {}),
    },
  });
  const plan = await loadPlan(tx, before.id);
  if (plan)
    w.session.publish(topics.burrow(w.burrow.id), { type: 'plan.updated', plan }, { eventId: event.id });
  // A plan in a chat with the assistant: Home's chats and Working on (home-redesign.md HR-43).
  if (conversation) publishChatChanged(w.session, conversation);
  await indexPlan(tx, before.id);
  await queueStepNotifications(w, { ...before, ...next }, before.steps);
  return plan;
}

/* Notifications (WS-06, WS-20) ------------------------------------------------------------------ */

/**
 * Needs-you rows for what a change asks of people, deduplicated per recipient and key: the plan's creator and the
 * person whose Chat it is in, when a step became blocked or needs a person (once per step, state and projection key).
 * Never the person who made the change, and only the Whombat's person: anyone else's rows are history.
 */
async function queueStepNotifications(w: PlanWriter, plan: PlanRow, beforeSteps: readonly StoredStep[]) {
  const was = new Map(beforeSteps.map((s) => [s.id, s]));
  const wanted: { principalId: string; step: StoredStep; index: number; dedupKey: string }[] = [];
  const tx = w.session.tx;
  const room = await loadConversationRow(tx, plan.conversationId);
  const who = [...new Set([plan.createdById, room?.dmPersonId])].filter((id): id is string => !!id);
  plan.steps.forEach((s, index) => {
    const prev = was.get(s.id);
    if (!prev) return;
    const attention = s.state === 'blocked' || s.state === 'gate';
    const moved = prev.state !== s.state || !same(prev.followKey, s.followKey);
    if (attention && moved)
      for (const principalId of who)
        wanted.push({
          principalId,
          step: s,
          index,
          dedupKey: `plan-step:${s.id}:${s.state}:${s.followKey ?? s.stateLabel}`,
        });
  });
  const candidates = wanted.filter((n) => n.principalId !== w.actorId);
  if (candidates.length === 0) return;
  const person = await thePerson(tx, plan.burrowId);
  const recipients = candidates.filter((n) => n.principalId === person?.id);
  if (recipients.length === 0) return;
  const drafts: NotificationDraft[] = [];
  for (const n of recipients) {
    const link = await planLink(tx, plan, n.step.id);
    if (!link) continue;
    const ref = `step ${n.index + 1} of “${plan.title}”`;
    const text = `${cap(ref)} ${n.step.state === 'blocked' ? 'is blocked' : 'needs a person'}: ${n.step.stateLabel}.${n.step.note ? ` ${n.step.note}` : ''}`;
    drafts.push({
      burrowId: w.burrow.id,
      burrowSlug: w.burrow.slug,
      principalId: n.principalId,
      kind: 'needs_you',
      actorId: w.actorId,
      where: room ? conversationLabel(room) : 'Plan',
      text,
      link,
      createdAt: w.now,
      dedupKey: n.dedupKey,
    });
  }
  const services = w.session.services;
  w.session.after(() => notify(services, drafts));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The thread a plan's work happens in: where its card went (or the card itself), else top level. */
export async function planThread(
  db: Db,
  plan: Pick<PlanRow, 'id' | 'conversationId' | 'sourceThreadRootId' | 'messageId'>,
): Promise<string | null> {
  if (plan.sourceThreadRootId) return plan.sourceThreadRootId;
  if (plan.messageId) return plan.messageId;
  const [card] = await db
    .select({ id: messages.id, threadRootId: messages.threadRootId })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, plan.conversationId),
        sql`${messages.card}->>'kind' = 'plan' and ${messages.card}->>'planId' = ${plan.id}`,
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(1);
  return card ? (card.threadRootId ?? card.id) : null;
}

/** For plan steps shown to agents and in notes: “Dusty”, “Mara”. */
export async function principalNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = ids.length ? await loadPrincipalsByIds(db, [...new Set(ids)]) : [];
  return new Map(rows.map((r) => [r.id, shortName(r)]));
}
