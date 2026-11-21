/**
 * What counts against the licence's limits (LC-11, MR-58): connector connections (Google and similar; AI provider
 * sign-ins are credentials, not connectors). No members (one-person.md OP-S10); the one agent isn't counted (one-agent.md
 * OA-02). Shared by `licence.status` (usage) and the checks on adding one more.
 */
import { count, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { connections } from '../db/schema/index';
import type { LicenceLimitKind } from '../lib/maintenance';

type Reader = Db | Tx;

export async function countConnectors(db: Reader): Promise<number> {
  const [row] = await db.select({ n: count() }).from(connections);
  return row?.n ?? 0;
}

export async function licenceUsage(db: Reader): Promise<Record<LicenceLimitKind, number>> {
  return { connectors: await countConnectors(db) };
}

/**
 * Serializes adding one more `kind` across burrows and sessions (a transaction-level advisory lock), so two
 * additions can't both count the last free place.
 */
export async function lockLicenceCount(tx: Tx, kind: LicenceLimitKind): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whombat/licence-${kind}`}))`);
}

/**
 * The connectors there are now, counted in the transaction that adds one after taking the count's lock (held until it
 * ends): `assertCanAdd`'s count, so two connectors added at once can't both take the last place.
 */
export function lockedConnectorCount(tx: Tx): () => Promise<number> {
  return async () => {
    await lockLicenceCount(tx, 'connectors');
    return countConnectors(tx);
  };
}
