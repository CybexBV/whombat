import type { ThingWatchView } from '@whombat/core';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { thingWatches } from '../db/schema/index';

export type ThingWatchRow = typeof thingWatches.$inferSelect;

export function thingWatchView(row: ThingWatchRow): ThingWatchView {
  return {
    id: row.id,
    thing: row.thing,
    name: row.name,
    event: row.event,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

export async function thingWatchCards(db: Db, ids: string[]): Promise<Map<string, ThingWatchView>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select()
    .from(thingWatches)
    .where(inArray(thingWatches.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, thingWatchView(row)]));
}
