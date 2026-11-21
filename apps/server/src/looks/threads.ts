/**
 * Whether a thread is where the assistant looks into a look (docs/decisions/look-research.md LR-04): its replies stay
 * quiet, no push and no inbox row, because the look itself tells the person. Kept apart from `research.ts` so the
 * message notifications read it without the commands.
 */
import { eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { lookResearches } from '../db/schema/index';

export async function isLookThread(db: Db | Tx, rootId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: lookResearches.id })
    .from(lookResearches)
    .where(eq(lookResearches.threadRootId, rootId))
    .limit(1);
  return !!row;
}
