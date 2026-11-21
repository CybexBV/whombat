/**
 * The names people gave servers as stored (`server_names`, one row per named server, by lower-case id). Reads only;
 * changes go through `servers.rename` (`names.ts`).
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { serverNames } from '../db/schema/index';
import { serverNameKey } from './self';

/** Every server's name in a burrow, by lower-case id. */
export async function loadServerNames(db: Db, burrowId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ serverId: serverNames.serverId, name: serverNames.name })
    .from(serverNames)
    .where(eq(serverNames.burrowId, burrowId));
  return new Map(rows.map((r) => [r.serverId, r.name]));
}

/** One server's name, or null. */
export async function serverNameOf(db: Db, burrowId: string, serverId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: serverNames.name })
    .from(serverNames)
    .where(and(eq(serverNames.burrowId, burrowId), eq(serverNames.serverId, serverNameKey(serverId))));
  return row?.name ?? null;
}
