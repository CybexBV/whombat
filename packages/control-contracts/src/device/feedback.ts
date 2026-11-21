/**
 * Feedback drop delivery (Whombat `docs/decisions/feedback-drop.md` FD-11, FD-19 … FD-21, CT-91): the device ops'
 * pieces and limits, cross-language (the manager signs and forwards them; it never opens a card or an envelope).
 *
 * A card travels opaque here (`card` is a JSON object the schema doesn't look into): it holds free text (labels,
 * paths) that the cross-language subset can't describe, and nothing in Go reads it. Control parses each card with
 * `SignedFeedbackSiteCard` and `verifySiteCard` of `@whombat/core` before it stores it.
 */

import { FeedbackReporterStatus, FeedbackReportType } from '@whombat/core/domain';
import {
  FEEDBACK_CARD_MAX_BYTES,
  FEEDBACK_CARD_MAX_LIFETIME_S,
  FEEDBACK_DROP_MAX_ENVELOPE_BYTES,
} from '@whombat/core/feedback/drop';
import { FEEDBACK_REPORTER_ID_PATTERN } from '@whombat/core/feedback/reporters';
import { EpochSeconds, Sha256Hex } from '@whombat/release';
import { z } from 'zod';

export {
  FEEDBACK_CARD_MAX_BYTES,
  FEEDBACK_CARD_MAX_LIFETIME_S,
  FEEDBACK_DROP_MAX_ENVELOPE_BYTES,
  FeedbackReporterStatus,
  FeedbackReportType,
};

const MiB = 1024 * 1024;

/** Control deletes an undelivered drop this long after it arrived (FD-19). */
export const FEEDBACK_DROP_TTL_S = 604_800;
/** A pulled drop is leased this long: no other pull returns it meanwhile (FD-20). */
export const FEEDBACK_DROP_LEASE_S = 120;
/** At most this many cards in one `feedback.cards.sync` (all of a runtime's cards). */
export const FEEDBACK_CARDS_MAX = 200;
/**
 * The largest `feedback.cards.sync` request (canonical JSON of the signed envelope, and the manager socket's request
 * body): 200 cards of at most 16 KiB with room to spare. Every other device request stays within
 * `DEVICE_REQUEST_MAX_BYTES` (`deviceRequestMaxBytes`, CT-91).
 */
export const FEEDBACK_CARDS_SYNC_MAX_BYTES = 4 * MiB;
/** `feedback.drops.pull`: at most 20 drops; `maxBytes` (envelope bytes) between 1 and 47 MiB. */
export const FEEDBACK_PULL_MAX_DROPS = 20;
export const FEEDBACK_PULL_MIN_BYTES = 1 * MiB;
export const FEEDBACK_PULL_MAX_BYTES = 47 * MiB;
/**
 * The largest `feedback.drops.pull` answer the manager and the runtime must accept: `FEEDBACK_PULL_MAX_BYTES` of
 * envelopes in base64url (4/3) plus the JSON around them fits in 64 MiB, and so does a single drop of the hard cap
 * (always returned, even above `maxBytes`). Other feedback answers are small (1 MiB is ample).
 */
export const FEEDBACK_PULL_RESPONSE_MAX_BYTES = 64 * MiB;
/** `nextPullS`: 2 while drops are pending, else control's `FEEDBACK_PULL_S` (default 30); bounds 2…3,600. */
export const FEEDBACK_PULL_BUSY_S = 2;
export const FEEDBACK_PULL_S = 30;
/** At most this many drop ids per `feedback.drops.ack`. */
export const FEEDBACK_ACK_MAX = 100;
/** `feedback.reporters.publish`: at most this many updates and this many removals per request (CT-164). */
export const FEEDBACK_REPORTERS_PUBLISH_MAX = 100;

const SiteId = z.string().regex(/^fbs_[A-Za-z0-9]{24}$/);

/** Control's drop id, `fdr_` + 22 base64url characters. */
export const FeedbackDropId = z.string().regex(/^fdr_[A-Za-z0-9_-]{22}$/);

/** A `SignedFeedbackSiteCard` as the device API carries it: `card` opaque, `sig` 64 bytes base64url. */
export const FeedbackCardWire = z.strictObject({
  card: z.record(z.string(), z.unknown()),
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type FeedbackCardWire = z.infer<typeof FeedbackCardWire>;

/**
 * Why control refused a card (FD-12): `bad_card` (shape, lifetime, `kid`), `too_large` (over
 * `FEEDBACK_CARD_MAX_BYTES`), `bad_signature`, `expired` (`expiresAt` not in the future), `site_bound_elsewhere`
 * (another signing key or another org owns the site), `stale_seq` (not above the stored card's `seq`, or the whole
 * sync is older than this device's last one).
 */
export const FeedbackCardRefusalCode = z.enum([
  'bad_card',
  'too_large',
  'bad_signature',
  'expired',
  'site_bound_elsewhere',
  'stale_seq',
]);
export type FeedbackCardRefusalCode = z.infer<typeof FeedbackCardRefusalCode>;

/**
 * One refused card: `index` in the request's `cards`, its `site` when readable. For `stale_seq`, `seq` is the card
 * sequence control holds for the site, so the runtime raises its counter above it and re-issues (a restored
 * replacement whose counter is behind, CT-91).
 */
export const FeedbackCardRefusal = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .max(FEEDBACK_CARDS_MAX - 1),
  site: SiteId.nullable(),
  code: FeedbackCardRefusalCode,
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type FeedbackCardRefusal = z.infer<typeof FeedbackCardRefusal>;

/** A reporter id, `fbr_` + 22 base64url characters (control's `feedback_reporters.id`, CT-164). */
export const FeedbackReporterId = z.string().regex(FEEDBACK_REPORTER_ID_PATTERN);

/** A report reference, `FB-XXXX-XXXX` (Crockford's base32), as core's `FeedbackReference`. */
const Reference = z.string().regex(/^FB-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

/**
 * Control's attestation on a drop (CT-164): it was posted with a valid reporter session of this site. `emailDigest` is
 * `reporterEmailDigest(site, email)` of the session's address; the runtime marks the report verified only when the
 * sealed submission's `reporter.email` gives the same digest.
 */
export const FeedbackDropReporter = z.object({
  id: FeedbackReporterId,
  emailDigest: Sha256Hex,
});
export type FeedbackDropReporter = z.infer<typeof FeedbackDropReporter>;

/** One stored drop, handed to its device (FD-20). `envelope` is the exact bytes the frame posted, base64url. */
export const FeedbackDrop = z.object({
  dropId: FeedbackDropId,
  site: SiteId,
  receivedAt: EpochSeconds,
  /** The request's `Origin` (always one of control's embed or hosted UI origins). */
  origin: z
    .string()
    .min(8)
    .max(255)
    .regex(/^https?:[/][/][\x21-\x7e]+$/),
  bytes: z.number().int().min(1).max(FEEDBACK_DROP_MAX_ENVELOPE_BYTES),
  envelope: z
    .string()
    .min(2)
    .max(Math.ceil((FEEDBACK_DROP_MAX_ENVELOPE_BYTES * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/),
  /** Present when the drop was posted signed in (CT-164); absent for anonymous drops. */
  reporter: FeedbackDropReporter.optional(),
});
export type FeedbackDrop = z.infer<typeof FeedbackDrop>;

/** Drops of a site that expired unread since the last pull reported them (FD-19). */
export const FeedbackExpiredCount = z.object({
  site: SiteId,
  count: z.number().int().min(1).max(1_000_000),
});
export type FeedbackExpiredCount = z.infer<typeof FeedbackExpiredCount>;

/** `feedback.cards.sync` body: the runtime's whole current set (0–200 cards). */
const FeedbackCardsSync = z.strictObject({
  /**
   * The runtime's card counter when it built this set: at least every card's `seq`, and higher than the previous
   * sync's (an empty set takes a fresh value). Control applies a sync only when `seq` is above this device's last
   * applied one; otherwise it changes nothing and refuses every card `stale_seq`.
   */
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  cards: z.array(FeedbackCardWire).max(FEEDBACK_CARDS_MAX),
});

const FeedbackCardsSyncResult = z.object({
  accepted: z.array(SiteId).max(FEEDBACK_CARDS_MAX),
  refused: z.array(FeedbackCardRefusal).max(FEEDBACK_CARDS_MAX),
});

const FeedbackDropsPull = z.strictObject({
  max: z.number().int().min(1).max(FEEDBACK_PULL_MAX_DROPS),
  maxBytes: z.number().int().min(FEEDBACK_PULL_MIN_BYTES).max(FEEDBACK_PULL_MAX_BYTES),
});

const FeedbackDropsPullResult = z.object({
  drops: z.array(FeedbackDrop).max(FEEDBACK_PULL_MAX_DROPS),
  /** Drops still waiting for this device after this answer (leased ones not counted). */
  pending: z.number().int().min(0).max(1_000_000),
  expired: z.array(FeedbackExpiredCount).max(FEEDBACK_CARDS_MAX),
  nextPullS: z.number().int().min(FEEDBACK_PULL_BUSY_S).max(3_600),
});

const FeedbackDropsAck = z.strictObject({
  dropIds: z.array(FeedbackDropId).min(1).max(FEEDBACK_ACK_MAX),
});

/**
 * A report of a signed-in reporter as control keeps it for “Your reports” (CT-164): its reference, type and the
 * reporter's status (`reporterStatusOf`), never its text. Times are epoch seconds.
 */
export const FeedbackReporterUpdate = z.strictObject({
  site: SiteId,
  reporterId: FeedbackReporterId,
  reference: Reference,
  type: FeedbackReportType,
  status: FeedbackReporterStatus,
  receivedAt: EpochSeconds,
  updatedAt: EpochSeconds,
});
export type FeedbackReporterUpdate = z.infer<typeof FeedbackReporterUpdate>;

/** A report control must forget (content removed, retention, the report deleted). */
export const FeedbackReporterRemoval = z.strictObject({
  site: SiteId,
  reference: Reference,
});
export type FeedbackReporterRemoval = z.infer<typeof FeedbackReporterRemoval>;

const FeedbackReportersPublish = z.strictObject({
  updates: z.array(FeedbackReporterUpdate).max(FEEDBACK_REPORTERS_PUBLISH_MAX),
  removals: z.array(FeedbackReporterRemoval).max(FEEDBACK_REPORTERS_PUBLISH_MAX),
});

/** The four device ops (FD-20, CT-164), merged into `DEVICE_OPS`. */
export const FEEDBACK_DEVICE_OPS = {
  /**
   * Publish this runtime's whole card set: control verifies each card (`verifySiteCard`, its site binding FD-12) and
   * upserts it, and withdraws this device's cards that aren't in the set. An unclaimed device gets `device_unclaimed`;
   * with the drop switched off control answers 404 `feedback_drop_off`.
   */
  'feedback.cards.sync': { body: FeedbackCardsSync, response: FeedbackCardsSyncResult },
  /**
   * Collect waiting drops of this device's sites, oldest first, and lease them for `FEEDBACK_DROP_LEASE_S` (a pull
   * never returns a leased drop). Stops at `max` drops or when the next would exceed `maxBytes` (envelope bytes), but
   * returns at least one. `expired` counts are reported once. Counts against the device's 120 requests a minute.
   */
  'feedback.drops.pull': { body: FeedbackDropsPull, response: FeedbackDropsPullResult },
  /** Delete drops whose outcome is durable in the runtime (filed or finally refused). Unknown ids are ignored. */
  'feedback.drops.ack': { body: FeedbackDropsAck, response: z.object({ ok: z.literal(true) }) },
  /**
   * Publish status changes of signed-in reporters' reports (CT-164). Control applies an update only for this device's
   * own sites (others are skipped silently) and only when its `updatedAt` is not older than the entry it holds (the
   * same `updatedAt` overwrites, so a retry is harmless); a removal deletes the entry (unknown ones are ignored). A
   * report's `reporterId` is the one control attested on its drop. With the drop switched off: 404
   * `feedback_drop_off`; unclaimed: `device_unclaimed`.
   */
  'feedback.reporters.publish': {
    body: FeedbackReportersPublish,
    response: z.object({ ok: z.literal(true) }),
  },
} as const;
