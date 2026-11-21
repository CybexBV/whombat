/**
 * “Asks you first” as stored (docs/decisions/server-asks.md SA-01, SA-04): one row per server that someone set, in lower
 * case (server-asks-server.md SA-S01); no row is `never`, the default. Reads only; changes go through `servers.setAsks`
 * (`asks.ts`).
 */
import { HOST_ASKS_FIRST_DEFAULT, type HostAsksFirst } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { serverAsks } from '../db/schema/index';

/** The key a server's row has: the hosts service's id in lower case. */
export const asksKey = (serverId: string): string => serverId.trim().toLowerCase();

/** Every server's setting in a burrow, by `asksKey`. */
export async function loadServerAsks(db: Db, burrowId: string): Promise<Map<string, HostAsksFirst>> {
  const rows = await db
    .select({ serverId: serverAsks.serverId, asksFirst: serverAsks.asksFirst })
    .from(serverAsks)
    .where(eq(serverAsks.burrowId, burrowId));
  return new Map(rows.map((r) => [r.serverId, r.asksFirst]));
}

/** One server's setting (`never` without a row). */
export async function serverAsksOf(db: Db, burrowId: string, serverId: string): Promise<HostAsksFirst> {
  const [row] = await db
    .select({ asksFirst: serverAsks.asksFirst })
    .from(serverAsks)
    .where(and(eq(serverAsks.burrowId, burrowId), eq(serverAsks.serverId, asksKey(serverId))));
  return row?.asksFirst ?? HOST_ASKS_FIRST_DEFAULT;
}

/** A server's setting from a loaded map. */
export function asksIn(map: ReadonlyMap<string, HostAsksFirst>, serverId: string): HostAsksFirst {
  return map.get(asksKey(serverId)) ?? HOST_ASKS_FIRST_DEFAULT;
}
