import { type ThingTrigger, type ThingTriggerFacts, thingTriggerDueAt } from '@whombat/core';
import { and, asc, eq, gt, isNotNull, lte } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { events, incidents, incidentTriggers } from '../../db/schema/index';
import { holdsIncident } from '../../incidents/holds';

type Pending = typeof incidentTriggers.$inferSelect;
type Event = typeof events.$inferSelect;

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

/** Claims the incident in the same transaction as the cursor. A quicker matching transition can bring it forward. */
export async function claimIncidentTrigger(
  tx: Db,
  automationId: string,
  version: number,
  triggers: readonly ThingTrigger[],
  facts: ThingTriggerFacts,
  event: Event,
  now: Date,
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
  const waiting = dueAt > now.getTime();
  const [claim] = await tx
    .insert(incidentTriggers)
    .values({
      automationId,
      incidentId: incident.incidentId,
      burrowId: event.burrowId,
      version,
      eventId: event.id,
      dueAt: waiting ? new Date(dueAt) : null,
    })
    .onConflictDoUpdate({
      target: [incidentTriggers.automationId, incidentTriggers.incidentId],
      set: { eventId: event.id, dueAt: waiting ? new Date(dueAt) : null },
      setWhere: and(
        eq(incidentTriggers.version, version),
        isNotNull(incidentTriggers.dueAt),
        gt(incidentTriggers.dueAt, new Date(dueAt)),
      ),
    })
    .returning({ automationId: incidentTriggers.automationId });
  return !!claim && !waiting;
}
