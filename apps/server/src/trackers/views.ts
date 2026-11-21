/**
 * How a tracker connection's poller is doing, for the connection page (docs/decisions/report-trackers.md TA-03, TA-05;
 * `ConnectionView.poller`): its last check, its last success and what went wrong at the last check, and which
 * installation it is and the version it runs (TA-32) — only while an automation listens to the connection. A refused token isn't a poller problem here: the connection itself says
 * “Needs a new token” (`status`).
 */
import { type ConnectionView, trackerEnvironmentOf } from '@whombat/core';
import { inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { catalogConnections, trackerCursors } from '../db/schema/index';
import { iso } from '../lib/time';
import { listenedConnections } from './store';

/** `ConnectionView.poller` of these connections, by id (absent: nothing listens, or it was never read). */
export async function pollerViews(
  db: Db | Tx,
  connectionIds: readonly string[],
): Promise<Map<string, ConnectionView['poller']>> {
  const out = new Map<string, ConnectionView['poller']>();
  if (!connectionIds.length) return out;
  const listened = await listenedConnections(db as Db);
  const ids = connectionIds.filter((id) => listened.has(id));
  if (!ids.length) return out;
  const rows = await db.select().from(trackerCursors).where(inArray(trackerCursors.connectionId, ids));
  const byId = new Map(rows.map((r) => [r.connectionId, r]));
  const addresses = new Map(
    (
      await db
        .select({ id: catalogConnections.id, baseUrl: catalogConnections.baseUrl })
        .from(catalogConnections)
        .where(inArray(catalogConnections.id, ids))
    ).map((c) => [c.id, c.baseUrl]),
  );
  for (const id of ids) {
    const r = byId.get(id);
    // “Development · Acme Desk 0.1.174” (TA-32): from its `/v1/health`, once read; the address decides when the tracker
    // doesn't say which installation it is.
    const read = !!r?.healthCheckedAt && !!r.healthVersion;
    out.set(id, {
      checkedAt: r?.checkedAt ? iso(r.checkedAt) : null,
      succeededAt: r?.succeededAt ? iso(r.succeededAt) : null,
      problem: r?.problem && r.problemCode !== 'refused' ? r.problem.slice(0, 500) : null,
      environment: read ? trackerEnvironmentOf(r?.healthEnvironment, addresses.get(id) ?? '') : null,
      version: read ? (r?.healthVersion ?? '').slice(0, 100) || null : null,
    });
  }
  return out;
}
