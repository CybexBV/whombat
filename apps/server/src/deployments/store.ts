/**
 * Recorded deploys, read (docs/decisions/review-features.md RF-02; contracts 0.55.0 CT-296): the history
 * (`deployments.list`, newest first, a keyset cursor) and the environments board (`deployments.environments`).
 *
 * Every read and frame carries a deploy's place, the conversation and message its card was posted in: everything on
 * the box is the person's (one-person.md OP-S69).
 */
import {
  type DeployEnvironmentsResponse,
  type Deployment,
  type DeploymentsPage,
  deployEnvironmentsFrom,
  deployGroupKey,
} from '@whombat/core';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { deployments } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import { iso } from '../lib/time';

export type DeploymentRow = typeof deployments.$inferSelect;

/** A row as the contract says it. */
export function toDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    environment: row.environment,
    service: row.service,
    status: row.status,
    how: row.how,
    repo: row.repo,
    ref: row.ref,
    sha: row.sha,
    url: row.url,
    summary: row.summary,
    byId: row.byId,
    runId: row.runId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    previousId: row.previousId,
    createdAt: iso(row.createdAt),
  };
}

/* The history ------------------------------------------------------------------------------------- */

const CURSOR = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|(dpl_[A-Za-z0-9_-]{1,64})$/;

function encodeCursor(row: Pick<DeploymentRow, 'createdAt' | 'id'>): string {
  return Buffer.from(`${iso(row.createdAt)}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const m = CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  const at = m ? new Date(m[1] as string) : null;
  if (!m || !at || Number.isNaN(at.getTime()))
    throw new ApiError('validation_failed', 'That cursor isn’t one of these pages.', {
      fields: { before: ['This cursor belongs to another list, or is out of date. Ask again without it.'] },
    });
  return { at, id: m[2] as string };
}

/** `deployments.list`: newest first, of one environment or service when asked (case-insensitive). */
export async function deploymentsPage(
  db: Db,
  burrowId: string,
  query: {
    environment?: string | undefined;
    service?: string | undefined;
    before?: string | undefined;
    limit: number;
  },
): Promise<DeploymentsPage> {
  const where = [eq(deployments.burrowId, burrowId)];
  if (query.environment) where.push(eq(deployments.environmentKey, deployGroupKey(query.environment)));
  if (query.service) where.push(eq(deployments.serviceKey, deployGroupKey(query.service)));
  if (query.before) {
    const pos = decodeCursor(query.before);
    const older = or(
      lt(deployments.createdAt, pos.at),
      and(eq(deployments.createdAt, pos.at), lt(deployments.id, pos.id)),
    );
    if (older) where.push(older);
  }
  const rows = await db
    .select()
    .from(deployments)
    .where(and(...where))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    deployments: page.map(toDeployment),
    before: rows.length > query.limit && last ? encodeCursor(last) : null,
  };
}

/* The board --------------------------------------------------------------------------------------- */

/**
 * `deployments.environments`: per environment and service the newest deploy and the two newest that succeeded — all
 * core's `deployEnvironmentsFrom` needs for `current`, `failed` and `previous` — read in one pass over the burrow's
 * deploys by their grouping keys.
 */
export async function deployEnvironments(db: Db, burrowId: string): Promise<DeployEnvironmentsResponse> {
  const ranked = db.$with('ranked').as(
    db
      .select({
        id: deployments.id,
        status: deployments.status,
        newest:
          sql<number>`row_number() over (partition by ${deployments.environmentKey}, ${deployments.serviceKey} order by ${deployments.createdAt} desc, ${deployments.id} desc)`.as(
            'newest',
          ),
        newestOk:
          sql<number>`row_number() over (partition by ${deployments.environmentKey}, ${deployments.serviceKey}, ${deployments.status} order by ${deployments.createdAt} desc, ${deployments.id} desc)`.as(
            'newest_ok',
          ),
      })
      .from(deployments)
      .where(eq(deployments.burrowId, burrowId)),
  );
  const picked = await db
    .with(ranked)
    .select({ id: ranked.id })
    .from(ranked)
    .where(or(eq(ranked.newest, 1), and(eq(ranked.status, 'succeeded'), sql`${ranked.newestOk} <= 2`)));
  const rows = picked.length
    ? await db
        .select()
        .from(deployments)
        .where(
          inArray(
            deployments.id,
            picked.map((p) => p.id),
          ),
        )
    : [];
  return deployEnvironmentsFrom(rows.map(toDeployment));
}

/** The deploy of this service and environment that succeeded last (before this one is recorded): its `previousId`. */
export async function lastSucceeded(
  tx: Tx,
  burrowId: string,
  environmentKey: string,
  serviceKey: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.burrowId, burrowId),
        eq(deployments.environmentKey, environmentKey),
        eq(deployments.serviceKey, serviceKey),
        eq(deployments.status, 'succeeded'),
      ),
    )
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(1);
  return row?.id ?? null;
}
