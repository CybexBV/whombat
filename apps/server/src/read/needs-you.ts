/**
 * How many things wait on the viewer (docs/decisions/review-features.md RF-06; contracts 0.55.0 CT-302): the pending
 * approvals the viewer may decide. Only `work.needsYou` carries it; bootstrap's `sidebar.counts.needsYou` is always 0.
 */
import type { Db } from '../db/client';
import type { PrincipalRow } from './principals';
import { decidablePendingCount } from './work';

export async function needsYouCount(db: Db, burrowId: string, viewer: PrincipalRow): Promise<number> {
  // The approvals are counted in SQL (server-efficiency.md SV-06).
  return decidablePendingCount(db, burrowId, viewer);
}
