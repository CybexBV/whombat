/**
 * Catalog connection rows as the person sees and changes them (docs/decisions/connections-catalog.md CX-05, CX-25;
 * one-person.md OP-S50): every connection is the person's, in their Whombat's burrow; one in another burrow reads as
 * missing. Handles are unique in the burrow.
 */
import { CONNECTIONS_MAX } from '@whombat/core';
import { asc, count, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { catalogConnections, connectionTools } from '../db/schema/index';
import { notFound } from '../lib/errors';
import type { PrincipalRow } from '../read/principals';
import { connectionError } from './errors';
import type { CatalogConnectionRow, ConnectionToolRow } from './types';

/** Who is looking: the signed-in account and its person in the burrow of the request. */
export interface ConnectionViewer {
  accountId: string;
  burrowId: string;
  principal: PrincipalRow;
}

/** The burrow's connections (CX-25), by label. */
export async function visibleConnections(
  db: Db | Tx,
  viewer: Pick<ConnectionViewer, 'burrowId'>,
): Promise<CatalogConnectionRow[]> {
  return db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, viewer.burrowId))
    .orderBy(asc(sql`lower(${catalogConnections.label})`), asc(catalogConnections.createdAt));
}

/** One connection of the viewer's burrow, or 404. */
export async function visibleConnection(
  db: Db | Tx,
  viewer: Pick<ConnectionViewer, 'burrowId'>,
  id: string,
): Promise<CatalogConnectionRow> {
  const [row] = await db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  if (!row || !isVisibleTo(row, viewer)) throw notFound('Connection');
  return row;
}

export function isVisibleTo(
  row: Pick<CatalogConnectionRow, 'burrowId'>,
  viewer: Pick<ConnectionViewer, 'burrowId'>,
): boolean {
  return row.burrowId === viewer.burrowId;
}

export async function connectionRow(db: Db | Tx, id: string): Promise<CatalogConnectionRow | null> {
  const [row] = await db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  return row ?? null;
}

export async function toolRowsOf(db: Db | Tx, connectionId: string): Promise<ConnectionToolRow[]> {
  return db
    .select()
    .from(connectionTools)
    .where(eq(connectionTools.connectionId, connectionId))
    .orderBy(asc(connectionTools.position), asc(connectionTools.name));
}

/** How many connections the burrow has (CX-05). */
export async function connectionCount(db: Db | Tx, burrowId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, burrowId));
  return Number(row?.n ?? 0);
}

/** Refuses a new connection beyond the limit (CX-05). */
export async function requireRoom(db: Db | Tx, burrowId: string): Promise<void> {
  if ((await connectionCount(db, burrowId)) >= CONNECTIONS_MAX)
    throw connectionError('limit_reached', { max: CONNECTIONS_MAX });
}

/** The burrow's connections by handle and service: what a new one's handle and label must not repeat (CX-D03). */
export async function connectionsSeenWith(
  db: Db | Tx,
  burrowId: string,
): Promise<{ handle: string; catalogId: string }[]> {
  return db
    .select({ handle: catalogConnections.handle, catalogId: catalogConnections.catalogId })
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, burrowId));
}

/** The handles a new connection must not take: every handle of the burrow's connections. */
export async function takenHandles(db: Db | Tx, burrowId: string): Promise<string[]> {
  return (await connectionsSeenWith(db, burrowId)).map((r) => r.handle);
}
