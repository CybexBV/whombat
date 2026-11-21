/**
 * A tracker feature request's card as people read it (docs/decisions/report-trackers.md TA-44): kept apart from
 * `features.ts` so the message reads can resolve it without loading what posts and decides.
 */
import type { FeatureRequestView } from '@whombat/core';
import { signedReply } from '@whombat/core';
import { inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { featureRequests } from '../db/schema/index';

type RequestRow = typeof featureRequests.$inferSelect;

/** A request's card as people read it: the drafts signed, exactly as the customer would get them. */
export function featureRequestView(row: RequestRow): FeatureRequestView {
  return {
    id: row.id,
    runId: row.runId,
    automationId: row.automationId,
    connection: row.connection.slice(0, 80),
    number: Math.max(1, row.number),
    title: row.title.slice(0, 300),
    organization: row.organization?.slice(0, 200) ?? null,
    agent: row.agent.slice(0, 80),
    value: row.value !== null && row.value >= 1 && row.value <= 10 ? row.value : null,
    valueWhy: row.valueWhy,
    summary: row.summary.slice(0, 300),
    importance: row.importance as FeatureRequestView['importance'],
    size: row.size as FeatureRequestView['size'],
    approvedMessage: row.approvedReply ? signedReply(row.approvedReply, row.signature) : '',
    declinedMessage: row.declinedReply ? signedReply(row.declinedReply, row.signature) : '',
    declineReason: row.declineReason,
    canBuild: row.canBuild,
    state: row.state,
    choice: row.choice ?? null,
    note: row.note ?? null,
    decidedById: row.decidedById ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The cards of these requests, by id (`read/messages.ts`): the same for everyone, so they resolve in frames too. */
export async function featureRequestCards(
  db: Db | Tx,
  ids: readonly string[],
): Promise<Map<string, FeatureRequestView>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select()
    .from(featureRequests)
    .where(inArray(featureRequests.id, [...ids]));
  return new Map(rows.map((r) => [r.id, featureRequestView(r)]));
}
