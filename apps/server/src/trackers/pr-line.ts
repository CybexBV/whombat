/**
 * A tracker fix's pull request names its report by Whombat's marker (`<!-- whombat-tracker:<connection>:<number> -->`,
 * the recipe's `TRACKER_PR_MARKER`); the tracker's own line for its tooling — its driver's `prLine`, which the tracker
 * may look for in merged pull requests — goes just before it when the pull request opens (report-trackers.md).
 */
import { and, eq } from 'drizzle-orm';
import type { ApplyContext } from '../commit/types';
import { catalogConnections } from '../db/schema/index';
import { TRACKER_CATALOG_ID } from './connection';

const MARKER_RE = /<!--\s*whombat-tracker:([A-Za-z0-9_-]{1,100}):(\d{1,12})\s*-->/;

/** `body` with the driver's line before its marker; as it was without a marker, a connection, a driver or a line. */
export async function withTrackerLine(ctx: ApplyContext, burrowId: string, body: string): Promise<string> {
  const m = MARKER_RE.exec(body);
  if (!m) return body;
  const [row] = await ctx.tx
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.id, m[1] as string),
        eq(catalogConnections.burrowId, burrowId),
        eq(catalogConnections.catalogId, TRACKER_CATALOG_ID),
      ),
    );
  if (!row) return body;
  let line: string | null = null;
  try {
    line = ctx.services.tracker.driverFor(row).prLine(Number(m[2]));
  } catch {
    // No driver: the marker alone, which Whombat follows the fix by.
    return body;
  }
  if (!line || body.includes(line)) return body;
  return `${body.slice(0, m.index)}${line}\n${body.slice(m.index)}`;
}
