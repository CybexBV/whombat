/**
 * Site cards (docs/decisions/feedback-drop.md FD-10 … FD-12, FD-34): what the frame needs to render, check its
 * parent and seal a report, signed with the runtime's site signing key, and their publication to control as one
 * full set (`feedback.cards.sync` through the manager).
 *
 * Every sync re-issues every card: fresh `seq` values from the runtime's counter, `issuedAt` now and 14 days of
 * life (FD-49), so no card is ever older than the last sync and nothing needs to remember the bytes last sent. A
 * `stale_seq` refusal carries control's `seq`: the counter is raised above it and the set sent again (a restored
 * replacement whose counter is behind, FD-34).
 */
import {
  FEEDBACK_CARD_MAX_LIFETIME_S,
  FEEDBACK_CARDS_MAX,
  type FeedbackCardRefusal,
} from '@whombat/control-contracts/device';
import type { FeedbackSiteCard, SignedFeedbackSiteCard } from '@whombat/core';
import {
  dropEnvelopeCap,
  FEEDBACK_DROP_SUITE,
  FEEDBACK_DROP_VERSION,
  FEEDBACK_SITE_CARD_PURPOSE,
  signSiteCard,
} from '@whombat/core/feedback/drop';
import { and, asc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { feedbackDropSites, feedbackDropState, feedbackIntegrations } from '../../db/schema/index';
import type { ManagerPort } from '../../managed/ports';
import type { Services } from '../../services';
import type { IntegrationRow } from '../integrations';
import { bodyCapOf, publicConfigOf } from '../submission';
import type { EncryptionKey, SigningKey } from './keys';
import { markIntegrationReporters } from './reporters';

/** The card of one integration, unsigned (FD-10). `config` is exactly what the direct widget's config route answers. */
export function cardOf(
  row: IntegrationRow,
  keys: { signing: SigningKey; encryption: EncryptionKey },
  seq: number,
  issuedAt: number,
): FeedbackSiteCard {
  const s = row.settings;
  return {
    purpose: FEEDBACK_SITE_CARD_PURPOSE,
    v: FEEDBACK_DROP_VERSION,
    site: row.siteId,
    seq,
    issuedAt,
    expiresAt: issuedAt + FEEDBACK_CARD_MAX_LIFETIME_S,
    allowedOrigins: [...new Set(s.allowedOrigins)],
    // Control sends the sign-in codes of a managed Whombat (FR-03).
    config: publicConfigOf(s, { mail: true }),
    limits: {
      maxEnvelopeBytes: dropEnvelopeCap(bodyCapOf(s)),
      reportsPerHour: s.limits.reportsPerHour,
      reportsPerDay: s.limits.reportsPerDay,
      perSourcePerHour: s.limits.perSourcePerHour,
    },
    encryption: {
      suite: FEEDBACK_DROP_SUITE,
      kid: keys.encryption.kid,
      publicKey: keys.encryption.publicKey,
    },
    signingKey: keys.signing.publicKey,
  };
}

/** Integrations that have a card: intake on, oldest first, at most `FEEDBACK_CARDS_MAX` (FD-11). */
export async function publishableIntegrations(services: Services): Promise<IntegrationRow[]> {
  return services.db
    .select()
    .from(feedbackIntegrations)
    .where(
      and(
        eq(feedbackIntegrations.intake, 'enabled'),
        // A connected system's integration has no widget, so no card (feedback-sources.md FBS-01).
        sql`coalesce(${feedbackIntegrations.settings}->'source'->>'kind', 'widget') = 'widget'`,
      ),
    )
    .orderBy(asc(feedbackIntegrations.createdAt), asc(feedbackIntegrations.id))
    .limit(FEEDBACK_CARDS_MAX + 1);
}

/** Takes `n` fresh sequence numbers (at least one); returns the first. The counter ends at the last one. */
async function takeSeqs(services: Services, n: number, above = 0): Promise<number> {
  const count = Math.max(1, n);
  const [row] = await services.db
    .insert(feedbackDropState)
    .values({ id: 1, cardSeq: Math.max(above, 0) + count })
    .onConflictDoUpdate({
      target: feedbackDropState.id,
      set: { cardSeq: sql`greatest(${feedbackDropState.cardSeq}, ${above}) + ${count}` },
    })
    .returning({ cardSeq: feedbackDropState.cardSeq });
  if (!row) throw new Error('feedback drop: no sequence');
  return row.cardSeq - count + 1;
}

export interface SyncOutcome {
  /** Sites control accepted. */
  accepted: string[];
  /** Reports with a reporter marked for publishing because their site's card came back (FR-10). */
  reportersMarked: number;
  /** Sites (or card positions) control refused, `stale_seq` only when catching up didn't help. */
  refused: FeedbackCardRefusal[];
  /** Syncs sent (more than one after `stale_seq` catch-up). */
  attempts: number;
}

/** How often a `stale_seq` answer is caught up with in one sync. */
const STALE_RETRIES = 3;

/**
 * Publishes the whole card set (`withdrawAll`: none, for `WHOMBAT_FEEDBACK=off`) and records what control holds.
 * Throws the manager's `ManagerCallError` when the manager or control can't be reached or doesn't support the drop.
 */
export async function syncCards(
  services: Services,
  manager: ManagerPort,
  keys: import('./keys').DropKeys,
  options: { withdrawAll?: boolean } = {},
): Promise<SyncOutcome> {
  let rows = options.withdrawAll ? [] : await publishableIntegrations(services);
  if (rows.length > FEEDBACK_CARDS_MAX) {
    services.log.warn(
      { integrations: rows.length },
      `feedback drop: more than ${FEEDBACK_CARDS_MAX} integrations take reports; only the oldest are published`,
    );
    rows = rows.slice(0, FEEDBACK_CARDS_MAX);
  }
  let above = 0;
  for (let attempt = 1; ; attempt++) {
    const signing = rows.length ? await keys.signingKey({ create: true }) : null;
    const encryption = rows.length ? await keys.currentEncryptionKey() : null;
    const first = await takeSeqs(services, rows.length, above);
    const now = services.clock();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const cards: SignedFeedbackSiteCard[] = rows.map((row, i) =>
      signSiteCard(
        cardOf(
          row,
          { signing: signing as SigningKey, encryption: encryption as EncryptionKey },
          first + i,
          issuedAt,
        ),
        (signing as SigningKey).seed,
      ),
    );
    const seq = first + Math.max(rows.length, 1) - 1;
    const answer = await manager.feedbackCards({ seq, cards });
    const stale = answer.refused.filter((r) => r.code === 'stale_seq');
    if (stale.length && attempt <= STALE_RETRIES) {
      // Control holds newer seqs (a restored replacement's counter is behind): jump above them and re-issue.
      above = Math.max(seq, ...stale.map((r) => r.seq ?? 0));
      services.log.info({ above }, 'feedback drop: control holds newer cards; catching up');
      continue;
    }
    const held = await services.db
      .select({ siteId: feedbackDropSites.siteId, expiresAt: feedbackDropSites.expiresAt })
      .from(feedbackDropSites)
      .where(isNotNull(feedbackDropSites.publishedAt));
    await recordSync(services, rows, cards, answer.accepted, answer.refused);
    for (const r of answer.refused)
      services.log.warn({ site: r.site, code: r.code }, 'feedback drop: control refused a site card');
    // A site control holds again after holding no card lost its reporters' entries with the card (FR-10) — also one
    // whose last card had expired before this sync: control unbinds an expired site and deletes its entries (FR-12).
    const before = new Set(
      held.filter((h) => h.expiresAt !== null && h.expiresAt > now).map((h) => h.siteId),
    );
    const back = rows.filter((r) => answer.accepted.includes(r.siteId) && !before.has(r.siteId));
    const reportersMarked = await markIntegrationReporters(
      services,
      back.map((r) => r.id),
    );
    return { accepted: answer.accepted, refused: answer.refused, attempts: attempt, reportersMarked };
  }
}

async function recordSync(
  services: Services,
  rows: readonly IntegrationRow[],
  cards: readonly SignedFeedbackSiteCard[],
  accepted: readonly string[],
  refused: readonly FeedbackCardRefusal[],
): Promise<void> {
  const now = services.clock();
  const ok = new Set(accepted);
  const refusedAt = new Map<number, string>(refused.map((r) => [r.index, r.code]));
  await services.db.transaction(async (tx) => {
    for (const [i, row] of rows.entries()) {
      const card = cards[i]?.card;
      const code = refusedAt.get(i) ?? (ok.has(row.siteId) ? null : 'not_accepted');
      if (code) {
        // Control keeps the card it held for a site whose new card it refused (FD-41), unless the site is another
        // device's: then nothing of ours is published.
        const lost =
          code === 'site_bound_elsewhere' ? { publishedAt: null, cardSeq: null, expiresAt: null } : {};
        await tx
          .insert(feedbackDropSites)
          .values({ siteId: row.siteId, integrationId: row.id, updatedAt: now, refused: code })
          .onConflictDoUpdate({
            target: feedbackDropSites.siteId,
            set: { integrationId: row.id, updatedAt: now, refused: code, ...lost },
          });
        continue;
      }
      const values = {
        publishedAt: now,
        cardSeq: card?.seq ?? null,
        expiresAt: card ? new Date(card.expiresAt * 1000) : null,
        refused: null,
      };
      await tx
        .insert(feedbackDropSites)
        .values({ siteId: row.siteId, integrationId: row.id, updatedAt: now, ...values })
        .onConflictDoUpdate({
          target: feedbackDropSites.siteId,
          set: { integrationId: row.id, updatedAt: now, ...values },
        });
    }
    // Everything else was withdrawn by this full set.
    const kept = rows.map((r) => r.siteId);
    await tx
      .delete(feedbackDropSites)
      .where(kept.length ? notInArray(feedbackDropSites.siteId, kept) : sql`true`);
    await tx.update(feedbackDropState).set({ syncedAt: now }).where(eq(feedbackDropState.id, 1));
  });
}

/**
 * Whether the published set needs a new sync (the hourly check, FD-11): a site that takes reports without an accepted
 * card, a card with less than 7 of its 14 days left, a card of a site that no longer takes reports, or an encryption
 * key due for rotation.
 */
export async function syncDue(
  services: Services,
  keys: import('./keys').DropKeys,
  reissueBeforeS: number,
): Promise<boolean> {
  const rows = await publishableIntegrations(services);
  const sites = await services.db.select().from(feedbackDropSites);
  const bySite = new Map(sites.map((s) => [s.siteId, s]));
  const horizon = services.clock().getTime() + reissueBeforeS * 1000;
  const wanted = new Set(rows.slice(0, FEEDBACK_CARDS_MAX).map((r) => r.siteId));
  for (const site of wanted) {
    const s = bySite.get(site);
    if (!s?.publishedAt || !s.expiresAt || s.expiresAt.getTime() < horizon) return true;
  }
  for (const s of sites) if (!wanted.has(s.siteId)) return true;
  return wanted.size > 0 && (await keys.rotationDue());
}
