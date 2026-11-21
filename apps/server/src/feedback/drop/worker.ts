/**
 * Collecting drops (docs/decisions/feedback-drop.md FD-22, FD-24): one `feedback.drops.pull` through the manager,
 * each drop filed one at a time, its outcome made durable, then the batch acknowledged so control deletes it.
 *
 * A drop whose outcome is already final (filed, duplicate, refused) is acked without work, so a crash between the
 * commit and the ack is harmless. A transient failure (database, image worker) leaves the drop unacknowledged: its
 * lease runs out and control delivers it again; after 5 attempts it is refused as `internal`.
 */
import { FEEDBACK_ACK_MAX, type FeedbackDrop } from '@whombat/control-contracts/device';
import { and, eq, lt, sql } from 'drizzle-orm';
import { feedbackDropExpired, feedbackDropOutcomes } from '../../db/schema/index';
import type { ManagerPort } from '../../managed/ports';
import type { Services } from '../../services';
import type { DropKeys } from './keys';
import { receiveDrop } from './receive';

/** FD-22: at most 10 drops and 16 MiB of envelopes per pull. */
export const PULL_MAX_DROPS = 10;
export const PULL_MAX_BYTES = 16 * 1024 * 1024;
/** Attempts before a drop that keeps failing transiently is refused as `internal` (FD-22). */
export const DROP_MAX_ATTEMPTS = 5;
/** Outcomes and expiry counts are kept 8 days (FD-24). */
export const OUTCOME_RETENTION_MS = 8 * 86_400_000;

export interface PullSummary {
  /** Drops in this answer. */
  received: number;
  filed: number;
  duplicate: number;
  refused: number;
  /** Left unacknowledged after a transient failure (they come back). */
  retry: number;
  acked: number;
  /** Control's: drops still waiting, and when to pull next. */
  pending: number;
  nextPullS: number;
}

type Final = 'filed' | 'duplicate' | 'refused';

/** One drop to a durable outcome. Returns the final outcome, or null when it failed transiently. */
async function settle(services: Services, keys: DropKeys, drop: FeedbackDrop): Promise<Final | null> {
  const db = services.db;
  const [known] = await db
    .select()
    .from(feedbackDropOutcomes)
    .where(eq(feedbackDropOutcomes.dropId, drop.dropId));
  if (known && known.outcome !== 'pending') return known.outcome;
  const attempts = (known?.attempts ?? 0) + 1;
  let outcome: Final;
  let code: string | null = null;
  let integrationId: string | null = known?.integrationId ?? null;
  try {
    const result = await receiveDrop(services, keys, drop);
    outcome = result.outcome.outcome;
    code = result.outcome.outcome === 'refused' ? result.outcome.code : null;
    integrationId = result.integrationId;
  } catch (err) {
    // Never the error's message at a level that could quote content: its name and code only.
    services.log.warn(
      {
        dropId: drop.dropId,
        attempts,
        errName: (err as Error).name,
        errCode: (err as { code?: unknown }).code,
      },
      'feedback drop: filing failed; it comes back',
    );
    if (attempts < DROP_MAX_ATTEMPTS) {
      await write(services, drop, { outcome: 'pending', code: null, attempts, integrationId });
      return null;
    }
    outcome = 'refused';
    code = 'internal';
  }
  await write(services, drop, { outcome, code, attempts, integrationId });
  if (outcome === 'refused')
    services.log.info({ dropId: drop.dropId, site: drop.site, code }, 'feedback drop refused');
  return outcome;
}

async function write(
  services: Services,
  drop: FeedbackDrop,
  values: { outcome: Final | 'pending'; code: string | null; attempts: number; integrationId: string | null },
): Promise<void> {
  const at = services.clock();
  await services.db
    .insert(feedbackDropOutcomes)
    .values({ dropId: drop.dropId, siteId: drop.site, at, ...values })
    .onConflictDoUpdate({ target: feedbackDropOutcomes.dropId, set: { at, ...values } });
}

/** UTC day of `at`, `YYYY-MM-DD`. */
function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * One pull: files what arrived, records expiry counts, acknowledges every drop whose outcome is final. Throws the
 * manager's `ManagerCallError` when the pull itself fails (an ack that fails is retried by the next redelivery).
 */
export async function pullOnce(
  services: Services,
  manager: ManagerPort,
  keys: DropKeys,
): Promise<PullSummary> {
  const answer = await manager.feedbackPull({ max: PULL_MAX_DROPS, maxBytes: PULL_MAX_BYTES });
  const now = services.clock();
  for (const e of answer.expired) {
    if (e.count <= 0) continue;
    await services.db
      .insert(feedbackDropExpired)
      .values({ siteId: e.site, day: dayOf(now), count: e.count })
      .onConflictDoUpdate({
        target: [feedbackDropExpired.siteId, feedbackDropExpired.day],
        set: { count: sql`${feedbackDropExpired.count} + ${e.count}` },
      });
    services.log.warn({ site: e.site, count: e.count }, 'feedback drop: reports expired in the cloud unread');
  }
  const summary: PullSummary = {
    received: answer.drops.length,
    filed: 0,
    duplicate: 0,
    refused: 0,
    retry: 0,
    acked: 0,
    pending: answer.pending,
    nextPullS: answer.nextPullS,
  };
  const ack: string[] = [];
  for (const drop of answer.drops) {
    // Quarantine or a drain stops filing mid-batch: the rest come back after their lease.
    if (services.maintenance.paused) {
      summary.retry++;
      continue;
    }
    const outcome = await settle(services, keys, drop);
    if (outcome === null) summary.retry++;
    else {
      summary[outcome]++;
      ack.push(drop.dropId);
    }
  }
  for (let i = 0; i < ack.length; i += FEEDBACK_ACK_MAX) {
    const batch = ack.slice(i, i + FEEDBACK_ACK_MAX);
    try {
      await manager.feedbackAck({ dropIds: batch });
      summary.acked += batch.length;
    } catch (err) {
      services.log.warn(
        { err: String(err), drops: batch.length },
        'feedback drop: ack failed; redelivery acks them',
      );
    }
  }
  return summary;
}

/** Outcomes and expiry counts older than 8 days go (FD-24). */
export async function sweepOutcomes(services: Services): Promise<void> {
  const cutoff = new Date(services.clock().getTime() - OUTCOME_RETENTION_MS);
  await services.db.delete(feedbackDropOutcomes).where(lt(feedbackDropOutcomes.at, cutoff));
  await services.db.delete(feedbackDropExpired).where(and(lt(feedbackDropExpired.day, dayOf(cutoff))));
}
