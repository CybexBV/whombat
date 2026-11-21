/**
 * The share round (docs/decisions/share-links.md), every five minutes: links stopped here whose copy control hasn't
 * deleted yet are deleted again; links of a thread or chat that is gone are stopped; and a link whose copy never reached
 * control (the runtime stopped between the two steps) is dropped. Expired links need nothing: control deletes their
 * copies itself, and the list reads them as expired.
 */
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { conversations, messages, shares } from '../db/schema/index';
import type { Services } from '../services';
import { shareDiscard, shareStop } from './commands';
import { deleteAtControl, sharePortOf } from './publish';

export const SHARE_ROUND_MS = 5 * 60_000;
/** A link still without control's answer after this long was left behind. */
const UNPUBLISHED_AFTER_MS = 10 * 60_000;

const rounds = new WeakMap<Services, () => void>();

export function startShareRound(services: Services): void {
  if (rounds.has(services)) return;
  rounds.set(
    services,
    services.housekeeping.add('shares.round', SHARE_ROUND_MS, () => shareRound(services)),
  );
}

export async function shareRound(services: Services, now = new Date()): Promise<void> {
  if (services.maintenance.held || !sharePortOf(services)) return;
  const db = services.db;
  const actorOf = (row: { createdById: string | null }) => row.createdById;

  // Copies the runtime never finished handing over.
  const left = await db
    .select()
    .from(shares)
    .where(
      and(isNull(shares.viewerUrl), lt(shares.createdAt, new Date(now.getTime() - UNPUBLISHED_AFTER_MS))),
    );
  for (const row of left) {
    const actorId = actorOf(row);
    if (!actorId) continue;
    // Control may have kept it before the runtime stopped: delete it there too.
    await sharePortOf(services)
      ?.shareDelete({ shareIds: [row.id] })
      .catch(() => undefined);
    await services.pipeline.commit(shareDiscard, { id: row.id }, { burrowId: row.burrowId, actorId });
  }

  // Working links of a thread or chat that is gone.
  const live = await db
    .select({
      id: shares.id,
      burrowId: shares.burrowId,
      createdById: shares.createdById,
      expiresAt: shares.expiresAt,
      root: messages.id,
      rootDeleted: messages.deletedAt,
      conv: conversations.id,
    })
    .from(shares)
    .leftJoin(messages, eq(messages.id, shares.rootId))
    .leftJoin(conversations, eq(conversations.id, shares.conversationId))
    .where(and(isNull(shares.stoppedAt), isNotNull(shares.viewerUrl)));
  for (const row of live) {
    if (row.expiresAt && row.expiresAt <= now) continue;
    if (row.root && !row.rootDeleted && row.conv) continue;
    const actorId = actorOf(row);
    if (!actorId) continue;
    await services.pipeline.commit(
      shareStop,
      { ids: [row.id], why: 'thread_gone' },
      { burrowId: row.burrowId, actorId },
    );
  }

  // Stopped here, not yet at control.
  const pending = await db.select().from(shares).where(eq(shares.stopPending, true));
  const byBurrow = new Map<string, { actorId: string; ids: string[] }>();
  for (const row of pending) {
    const actorId = actorOf(row);
    if (!actorId) continue;
    const b = byBurrow.get(row.burrowId) ?? { actorId, ids: [] };
    b.ids.push(row.id);
    byBurrow.set(row.burrowId, b);
  }
  for (const [burrowId, b] of byBurrow) await deleteAtControl(services, burrowId, b.actorId, b.ids);
}
