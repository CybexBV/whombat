/**
 * Starts of `home_state` triggers and the cooldown of automations that act without AI
 * (docs/decisions/direct-automations.md). A trigger with `forMinutes` starts only once its entity has stayed in the
 * state that long: the change that matched keeps a wait (`automation_waits`, one per automation and entity) until then,
 * any later change of that entity ends it, and at its time the entity's state now must still be the trigger's (Home
 * Assistant's socket says so; while Whombat can't tell, it asks again each minute for an hour). Each stretch of a state
 * starts at most one run.
 */
import {
  type AutomationDefinition,
  cooldownOf,
  type HomeStateFacts,
  type HomeStateTrigger,
  homeStateTriggerMatches,
} from '@whombat/core';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { automationRuns, automationWaits, events } from '../../db/schema/index';

type Wait = typeof automationWaits.$inferSelect;
type Event = typeof events.$inferSelect;

/**
 * An entity's state now, as Home Assistant's socket last said it, and Home Assistant's time of its last change (its
 * `last_changed`; null when it didn't say); `gone` when Home Assistant removed it or doesn't have it; null when Whombat
 * can't tell now.
 */
export type HomeNow = (
  connectionId: string,
  entity: string,
) => { state: string; changedAt: number | null } | 'gone' | null;

/** Home Assistant's times are seconds with a fraction: the same change reads the same to well within a millisecond. */
const SAME_CHANGE_S = 0.001;

const RETRY_MS = 60_000;
const RETRY_LIMIT_MS = 60 * RETRY_MS;

const keyOf = (facts: Pick<HomeStateFacts, 'connectionId' | 'entity'>) =>
  `home:${facts.connectionId}:${facts.entity}`;

/** The waits whose time has come (500 at most). */
export async function dueHomeWaits(tx: Db, burrowId: string, now: Date) {
  return tx
    .select({ wait: automationWaits, event: events })
    .from(automationWaits)
    .innerJoin(events, eq(events.id, automationWaits.eventId))
    .where(and(eq(automationWaits.burrowId, burrowId), lte(automationWaits.dueAt, now)))
    .orderBy(asc(automationWaits.dueAt))
    .limit(500);
}

/** While the licence is lapsed: waits that came due start nothing later. */
export async function skipDueHomeWaits(tx: Db, burrowId: string, now: Date): Promise<void> {
  await tx
    .delete(automationWaits)
    .where(and(eq(automationWaits.burrowId, burrowId), lte(automationWaits.dueAt, now)));
}

/** Ends a wait. */
export async function dropHomeWait(tx: Db, automationId: string, key: string): Promise<void> {
  await tx
    .delete(automationWaits)
    .where(and(eq(automationWaits.automationId, automationId), eq(automationWaits.key, key)));
}

/**
 * A change of an entity, for one live automation (in the trigger scan's transaction): whether it starts a run now.
 * Any change of an entity the automation names ends the wait it had for it; a change that matches a trigger without
 * `forMinutes` starts now, one that matches only triggers with it waits the shortest of them.
 */
export async function claimHomeChange(
  tx: Db,
  automationId: string,
  version: number,
  definition: Pick<AutomationDefinition, 'triggers'>,
  facts: HomeStateFacts,
  event: Event,
): Promise<boolean> {
  const triggers = definition.triggers.filter(
    (t): t is HomeStateTrigger =>
      t.kind === 'home_state' && t.connectionId === facts.connectionId && t.entity === facts.entity,
  );
  if (!triggers.length) return false;
  const key = keyOf(facts);
  await dropHomeWait(tx, automationId, key);
  const matching = triggers.filter((t) => homeStateTriggerMatches(t, facts));
  if (!matching.length) return false;
  if (matching.some((t) => !t.forMinutes)) return true;
  const minutes = Math.min(...matching.map((t) => t.forMinutes ?? 0));
  const dueAt = new Date(event.createdAt.getTime() + minutes * 60_000);
  await tx.insert(automationWaits).values({
    automationId,
    key,
    burrowId: event.burrowId,
    version,
    eventId: event.id,
    dueAt,
    firstDueAt: dueAt,
  });
  return false;
}

/**
 * A wait whose time came, for its automation: whether it starts a run now. A newer version than the wait's starts
 * nothing, nor an entity Home Assistant removed; the entity must still be in the trigger's state, and still from the
 * change that started the wait: when Home
 * Assistant's time of its last change isn't that change's any more, it changed and came back meanwhile (unseen while
 * Home Assistant was away, or among a flapping sensor's changes that weren't signed), so it didn't hold. While Whombat
 * can't tell, the wait asks again each minute for an hour after its time.
 */
export async function claimDueHomeWait(
  tx: Db,
  wait: Wait,
  version: number,
  definition: Pick<AutomationDefinition, 'triggers'>,
  facts: HomeStateFacts,
  now: Date,
  current: HomeNow,
): Promise<boolean> {
  if (wait.version !== version) {
    await dropHomeWait(tx, wait.automationId, wait.key);
    return false;
  }
  const heard = current(facts.connectionId, facts.entity);
  // An entity Home Assistant removed didn't hold: its wait ends without a start.
  if (heard === 'gone') {
    await dropHomeWait(tx, wait.automationId, wait.key);
    return false;
  }
  if (heard === null) {
    const limit = wait.firstDueAt.getTime() + RETRY_LIMIT_MS;
    if (now.getTime() >= limit) await dropHomeWait(tx, wait.automationId, wait.key);
    else
      await tx
        .update(automationWaits)
        .set({ dueAt: new Date(Math.min(now.getTime() + RETRY_MS, limit)) })
        .where(and(eq(automationWaits.automationId, wait.automationId), eq(automationWaits.key, wait.key)));
    return false;
  }
  await dropHomeWait(tx, wait.automationId, wait.key);
  return heldAtItsTime(definition, facts, heard);
}

/**
 * Whether the change behind a wait held until its time (pure): the entity is still in the state it went to (the
 * trigger's `to`; its `from` was about the change itself), and Home Assistant's time of its last change is still that
 * change's. Both times are Home Assistant's own, so no clock is compared with another; a change signed without one
 * leaves the state alone to decide.
 */
export function heldAtItsTime(
  definition: Pick<AutomationDefinition, 'triggers'>,
  facts: HomeStateFacts,
  heard: { state: string; changedAt: number | null },
): boolean {
  if (
    typeof facts.changedAt === 'number' &&
    heard.changedAt !== null &&
    Math.abs(heard.changedAt - facts.changedAt) > SAME_CHANGE_S
  )
    return false;
  return definition.triggers.some(
    (t) =>
      t.kind === 'home_state' &&
      t.connectionId === facts.connectionId &&
      t.entity === facts.entity &&
      !!t.forMinutes &&
      homeStateTriggerMatches(t, facts) &&
      t.to.trim().toLowerCase() === heard.state.trim().toLowerCase(),
  );
}

/**
 * Whether an automation is still cooling down from its last run (`cooldownOf`: its own minutes, else 10 for one that
 * starts on Home Assistant or Protect): a sensor that flaps or a doorbell pressed five times starts one run.
 */
export async function coolingDown(
  tx: Db,
  automationId: string,
  definition: Pick<AutomationDefinition, 'triggers' | 'limits'>,
  now: Date,
): Promise<boolean> {
  const minutes = cooldownOf(definition);
  if (minutes <= 0) return false;
  const since = new Date(now.getTime() - minutes * 60_000);
  const [row] = await tx
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationId, automationId),
        gt(automationRuns.createdAt, since),
        sql`${automationRuns.status} <> 'skipped'`,
      ),
    )
    .limit(1);
  return !!row;
}
