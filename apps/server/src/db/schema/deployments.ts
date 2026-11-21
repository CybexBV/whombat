/**
 * Recorded deploys (docs/decisions/review-features.md RF-02; contracts 0.55.0 CT-296): one row per finished deploy of
 * a service to an environment, by an agent's `record_deploy` or by the GitHub Actions deploy executor. Never edited: a
 * redeploy is a new row whose `previous_id` is the deploy of the same service and environment that succeeded before.
 *
 * Names are stored as written (`normalizeDeployName`) and grouped by their keys (`deployGroupKey`, lowercase), so
 * “Production” and “production” are one environment on the board.
 */
import type { DeploymentHow, DeploymentStatus } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

export const deployments = pgTable(
  'deployments',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    environment: text('environment').notNull(),
    /** `deployGroupKey(environment)`: what the board and the filters group by. */
    environmentKey: text('environment_key').notNull(),
    service: text('service').notNull(),
    serviceKey: text('service_key').notNull(),
    status: text('status').$type<DeploymentStatus>().notNull(),
    how: text('how').$type<DeploymentHow>().notNull(),
    repo: text('repo'),
    ref: text('ref'),
    sha: text('sha'),
    url: text('url'),
    /** The deployer's words; every member of the burrow reads them. */
    summary: text('summary').notNull(),
    /** The agent that recorded it, or the person whose approval ran the deploy job. */
    byId: text('by_id').notNull(),
    runId: text('run_id'),
    /** Where its `deploy` card was posted. */
    conversationId: text('conversation_id'),
    messageId: text('message_id'),
    previousId: text('previous_id'),
    /** The turn that recorded it (`record_deploy`); server-only. */
    dispatchId: text('dispatch_id'),
    /** The deploy job's approval (the GitHub Actions executor); server-only, one deployment per approval. */
    approvalId: text('approval_id'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    index('deployments_burrow_idx').on(t.burrowId, t.createdAt, t.id),
    index('deployments_service_idx').on(t.burrowId, t.environmentKey, t.serviceKey, t.createdAt),
    uniqueIndex('deployments_approval_idx').on(t.approvalId).where(sql`${t.approvalId} is not null`),
  ],
);
