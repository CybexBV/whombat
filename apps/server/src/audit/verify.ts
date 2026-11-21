/** Whole-chain verification: every signature against the actor's key, every hash and every link. */
import { type ChainFailure, type ChainHead, verifyChain } from '@whombat/core';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { events, principals } from '../db/schema/index';
import { rowToSignedEvent } from './events';

export interface ChainReport {
  ok: boolean;
  checked: number;
  head: ChainHead | null;
  failures: ChainFailure[];
}

export async function verifyBurrowChain(db: Db, burrowId: string, batchSize = 1000): Promise<ChainReport> {
  const keys = new Map(
    (
      await db
        .select({ id: principals.id, publicKey: principals.publicKey })
        .from(principals)
        .where(eq(principals.burrowId, burrowId))
    ).map((p) => [p.id, p.publicKey]),
  );
  let head: ChainHead | null = null;
  let checked = 0;
  const failures: ChainFailure[] = [];
  for (;;) {
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, burrowId), gt(events.seq, head?.seq ?? 0)))
      .orderBy(asc(events.seq))
      .limit(batchSize);
    if (rows.length === 0) break;
    const report = verifyChain(rows.map(rowToSignedEvent), {
      keysOf: (actorId) => keys.get(actorId),
      from: head,
      burrowId,
    });
    checked += report.checked;
    failures.push(...report.failures);
    head = report.head;
    if (rows.length < batchSize) break;
  }
  return { ok: failures.length === 0, checked, head, failures };
}
