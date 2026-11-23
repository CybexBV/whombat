/**
 * A one-time Find My watch as its card reads it (docs/decisions/findmy-watch.md), apart from the watch's commands so the
 * messages' reader can resolve the card without importing them.
 */
import type { FindMyWatchView } from '@whombat/core';
import { inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { findMyWatches } from '../db/schema/index';

export type WatchRow = typeof findMyWatches.$inferSelect;

/** A watch as the card and the assistant read it. */
export function watchView(row: WatchRow): FindMyWatchView {
  return {
    id: row.id,
    name: row.name,
    change: row.change,
    place: row.place,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    to: row.to,
  };
}

/** The cards of these watches, for messages read (`read/messages.ts`). */
export async function findMyWatchCards(
  db: Db | Tx,
  ids: readonly string[],
): Promise<Map<string, FindMyWatchView>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select()
    .from(findMyWatches)
    .where(inArray(findMyWatches.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, watchView(r)]));
}
