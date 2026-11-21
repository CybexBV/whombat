/**
 * A tracker connection as automations use it (docs/decisions/report-trackers.md TA-01…TA-03): a catalog connection of
 * the burrow (`tracker`, `use: 'automations'`) naming its driver, never an agent's tool. Its requests are its driver's,
 * with the connection's address and token. A token the tracker refuses (401/403) goes through
 * `confirmRefusedCredential`, which re-checks it and marks the connection “Needs a new token” when the check is refused
 * too.
 */
import type { TrackerWords } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { confirmRefusedCredential } from '../connections/refused';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import { catalogConnections, trackerItems } from '../db/schema/index';
import type { Services } from '../services';
import {
  type BoundDriver,
  bindDriver,
  driverIdOf,
  noDriverText,
  trackerConnectionOf,
  wordsOfDriver,
} from './drivers';
import { SourceProblem } from './errors';

/** The catalog entry of a tracker connection. */
export const TRACKER_CATALOG_ID = 'tracker';

/** The burrow's tracker connection with this id, or null (another burrow's, another entry's, gone). */
export async function trackerConnectionRow(
  db: Db | Tx,
  burrowId: string,
  connectionId: string,
): Promise<CatalogConnectionRow | null> {
  const [row] = await db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.id, connectionId),
        eq(catalogConnections.burrowId, burrowId),
        eq(catalogConnections.catalogId, TRACKER_CATALOG_ID),
      ),
    );
  return row ?? null;
}

/**
 * The connection's driver bound to it (`services.tracker.driverFor` lets tests replace it). Throws a `SourceProblem`
 * saying why when its driver isn't installed or didn't load.
 */
export function trackerDriver(services: Services, row: CatalogConnectionRow): BoundDriver {
  const id = driverIdOf(row);
  const driver = id ? services.tracker.drivers.get(id) : null;
  if (!driver)
    throw new SourceProblem(
      'unreachable',
      noDriverText(row, id ? services.tracker.drivers.failure(id) : null),
    );
  return bindDriver(driver, trackerConnectionOf(services, row));
}

/** What the connection's tracker is called (its driver's words), the plain words without one. */
export function trackerWords(services: Services, row: Pick<CatalogConnectionRow, 'fields'>): TrackerWords {
  const id = driverIdOf(row);
  return wordsOfDriver(id ? services.tracker.drivers.get(id) : null);
}

/** What a report's tracker is called, as it was mirrored with the report (else its connection's driver's words). */
export async function reportProduct(
  services: Services,
  db: Db | Tx,
  connectionId: string,
  reportId: string,
): Promise<string> {
  const [row] = await db
    .select({ product: trackerItems.product, burrowId: trackerItems.burrowId })
    .from(trackerItems)
    .where(and(eq(trackerItems.connectionId, connectionId), eq(trackerItems.externalId, reportId)));
  if (row?.product && row.product !== 'the tracker') return row.product.slice(0, 40);
  const connection = row ? await trackerConnectionRow(db, row.burrowId, connectionId) : null;
  return (connection ? trackerWords(services, connection).product : 'the tracker').slice(0, 40);
}

/**
 * The tracker refused the connection's token (401/403, TA-03): the entry's check with the stored token decides, and a
 * refused check marks the connection “Needs a new token”. Best-effort; true when it was marked.
 */
export async function tokenRefused(services: Services, connectionId: string): Promise<boolean> {
  try {
    return await confirmRefusedCredential(services, connectionId);
  } catch (err) {
    services.log.warn(
      { connectionId, err: String(err).slice(0, 200) },
      'trackers: the refused token could not be checked again',
    );
    return false;
  }
}
