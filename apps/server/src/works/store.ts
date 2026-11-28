/**
 * The runs of a service's test (docs/decisions/service-works.md), kept 30 days: read newest first, and written through
 * the pipeline's transaction once a run ended (never while it runs: the service may take its time). Like the health
 * pass's glance, a run is Whombat's own bookkeeping: nothing is signed.
 */
import { newId } from '@whombat/core';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db } from '../db/client';
import { changes, type ServiceTestRunRow, serviceTestRuns } from '../db/schema/index';
import type { Services } from '../services';
import type { TestResult } from './tests';

/** How long runs are kept. */
export const RUNS_KEEP_MS = 30 * 86_400_000;
/** How many runs the page and the assistant read: half a day of a watched test. */
export const RUNS_READ = 48;

/** A connection's newest runs, newest first. */
export async function recentRuns(
  db: Db,
  connectionId: string,
  limit = RUNS_READ,
): Promise<ServiceTestRunRow[]> {
  return db
    .select()
    .from(serviceTestRuns)
    .where(eq(serviceTestRuns.connectionId, connectionId))
    .orderBy(desc(serviceTestRuns.at))
    .limit(limit);
}

/** When something was last changed on the connection's service (a restart, a setting, a fix), or null. */
export async function lastChangedAt(
  db: Db,
  row: Pick<CatalogConnectionRow, 'id' | 'burrowId'>,
): Promise<Date | null> {
  const [last] = await db
    .select({ at: changes.createdAt })
    .from(changes)
    .where(
      and(
        eq(changes.burrowId, row.burrowId),
        eq(changes.subjectKind, 'connection'),
        eq(changes.subjectId, row.id),
      ),
    )
    .orderBy(desc(changes.createdAt))
    .limit(1);
  return last?.at ?? null;
}

/** Keeps a run's result, and lets runs older than 30 days go. */
export async function recordRun(
  services: Services,
  row: Pick<CatalogConnectionRow, 'id' | 'burrowId'>,
  run: TestResult & Pick<ServiceTestRunRow, 'at' | 'ms' | 'by'>,
): Promise<ServiceTestRunRow> {
  const values = {
    id: newId('serviceTestRun'),
    burrowId: row.burrowId,
    connectionId: row.id,
    at: run.at,
    outcome: run.outcome,
    step: run.step ?? null,
    reason: run.reason ?? null,
    status: run.status ?? null,
    ms: Math.max(0, Math.round(run.ms)),
    by: run.by,
    facts: run.facts,
  };
  const { result } = await services.pipeline.transact(row.burrowId, async (session) => {
    const [made] = await session.tx.insert(serviceTestRuns).values(values).returning();
    // Every connection's old runs go, also those of a test nobody runs any more.
    await session.tx
      .delete(serviceTestRuns)
      .where(
        and(
          eq(serviceTestRuns.burrowId, row.burrowId),
          lt(serviceTestRuns.at, new Date(run.at.getTime() - RUNS_KEEP_MS)),
        ),
      );
    return made;
  });
  return result ?? (values as ServiceTestRunRow);
}
