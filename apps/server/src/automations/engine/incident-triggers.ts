import {
  type ThingTrigger,
  type ThingTriggerFacts,
  thingTriggerChecks,
  thingTriggerDueAt,
} from '@whombat/core';
import { and, asc, eq, gt, isNotNull, lte } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { events, incidents, incidentTriggers } from '../../db/schema/index';
import { holdsIncident } from '../../incidents/holds';
import { activeChecks, type LiveLooks, readLiveLooks } from '../../incidents/looks';
import type { Services } from '../../services';

type Pending = typeof incidentTriggers.$inferSelect;
type Event = typeof events.$inferSelect;

/** The checks that count on a thing now; null when Whombat can't read it at the moment. */
export type ActiveChecks = (thing: string) => Promise<ReadonlySet<string> | null>;

/** A delayed start whose thing couldn't be read at its deadline asks again this much later. */
export const CHECK_RETRY_MS = 60_000;

/** The checks that count on each thing, read as the incident watcher reads them, once for a scan and only if asked. */
export function liveChecks(services: Services, burrowId: string, now: Date): ActiveChecks {
  let read: Promise<LiveLooks | null> | null = null;
  return async (thing) => {
    read ??= readLiveLooks(services, burrowId, now).catch(() => null);
    const live = await read;
    return live ? activeChecks(live, thing) : null;
  };
}

export async function dueIncidentTriggers(tx: Db, burrowId: string, now: Date) {
  return tx
    .select({ pending: incidentTriggers, event: events })
    .from(incidentTriggers)
    .innerJoin(events, eq(events.id, incidentTriggers.eventId))
    .where(and(eq(incidentTriggers.burrowId, burrowId), lte(incidentTriggers.dueAt, now)))
    .orderBy(asc(incidentTriggers.dueAt))
    .limit(500);
}

export async function dropIncidentTrigger(tx: Db, pending: Pick<Pending, 'automationId' | 'incidentId'>) {
  await tx
    .delete(incidentTriggers)
    .where(
      and(
        eq(incidentTriggers.automationId, pending.automationId),
        eq(incidentTriggers.incidentId, pending.incidentId),
      ),
    );
}

export async function skipDueIncidentTriggers(tx: Db, burrowId: string, now: Date): Promise<void> {
  await tx
    .delete(incidentTriggers)
    .where(and(eq(incidentTriggers.burrowId, burrowId), lte(incidentTriggers.dueAt, now)));
}

/**
 * Claims the incident in the same transaction as the cursor. A quicker matching transition can bring it forward. At a
 * delayed start's deadline the check it waited on must still count on the thing (`active`): an incident can stay open
 * for another line after the one that started the wait cleared.
 */
export async function claimIncidentTrigger(
  tx: Db,
  automationId: string,
  version: number,
  triggers: readonly ThingTrigger[],
  facts: ThingTriggerFacts,
  event: Event,
  now: Date,
  active: ActiveChecks,
): Promise<boolean> {
  const dueAt = thingTriggerDueAt(triggers, facts);
  if (dueAt === null) return false;
  const { incident } = facts;
  if (
    await holdsIncident(
      tx,
      event.burrowId,
      incident.thing,
      now,
      incident.endedAt ? new Date(incident.endedAt) : event.createdAt,
    )
  )
    return false;

  const [row] = await tx
    .select({ endedAt: incidents.endedAt, cause: incidents.causeThing })
    .from(incidents)
    .where(and(eq(incidents.id, incident.incidentId), eq(incidents.burrowId, event.burrowId)));
  const delayed = dueAt > Date.parse(incident.startedAt);
  if (!row || row.cause || (delayed && row.endedAt)) return false;
  // When to look again: the deadline while it is ahead; a minute on when the thing couldn't be read at it.
  let next: number | null = dueAt > now.getTime() ? dueAt : null;
  if (delayed && next === null) {
    const checks = thingTriggerChecks(triggers, facts);
    const counts = checks.length ? await active(incident.thing) : null;
    if (checks.length && counts === null) next = now.getTime() + CHECK_RETRY_MS;
    else if (counts && !checks.some((c) => counts.has(c))) return false;
  }
  const [claim] = await tx
    .insert(incidentTriggers)
    .values({
      automationId,
      incidentId: incident.incidentId,
      burrowId: event.burrowId,
      version,
      eventId: event.id,
      dueAt: next === null ? null : new Date(next),
    })
    .onConflictDoUpdate({
      target: [incidentTriggers.automationId, incidentTriggers.incidentId],
      set: { eventId: event.id, dueAt: next === null ? null : new Date(next) },
      setWhere: and(
        eq(incidentTriggers.version, version),
        isNotNull(incidentTriggers.dueAt),
        gt(incidentTriggers.dueAt, new Date(next ?? dueAt)),
      ),
    })
    .returning({ automationId: incidentTriggers.automationId });
  return !!claim && next === null;
}
