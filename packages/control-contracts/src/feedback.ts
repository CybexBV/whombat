/**
 * The public feedback drop of control (Whombat `docs/decisions/feedback-drop.md` FD-17 … FD-19, CT-91): the widget
 * frame of a managed Whombat fetches the site card and posts the sealed report here; the appliance collects it with
 * the device ops (`@whombat/control-contracts/device`). Never authenticated, `credentials: 'omit'`; CORS only for
 * control's embed and hosted UI origins (`CONTROL_EMBED_ORIGINS`, FD-31).
 *
 * Not part of `controlApi`: the routes have their own body handling (a binary body, read only after every cheaper
 * check), their own limits and CORS, like the runtime's `/embed/v1` surface.
 *
 * Reporter sign-in (CT-164, Whombat FR-*): `…/reporter/code|session|reports`, the same shapes as the runtime's
 * self-hosted routes (`FEEDBACK_PUBLIC_PATHS.reporter*`). The session is a bearer token (`Authorization: Bearer
 * fbrs_…`), never a cookie: still `credentials: 'omit'`.
 */
import {
  FEEDBACK_PUBLIC_ERROR_STATUS,
  FEEDBACK_PUBLIC_MESSAGES,
  FeedbackPublicError,
  FeedbackReporterCodeRequest,
  FeedbackReporterOk,
  FeedbackReporterReports,
  FeedbackReporterSession,
  FeedbackReporterSessionRequest,
  FeedbackSiteId,
  SignedFeedbackSiteCard,
  Timestamp,
} from '@whombat/core/domain';
import { z } from 'zod';
import { controlEndpoint } from './endpoint.js';

export {
  FEEDBACK_PUBLIC_ERROR_STATUS,
  FEEDBACK_PUBLIC_MESSAGES,
  FeedbackPublicError,
  SignedFeedbackSiteCard,
};

/** The drop body's content type: the envelope bytes (FD-14). */
export const FEEDBACK_DROP_CONTENT_TYPE = 'application/octet-stream';

export const FeedbackDropParams = z.object({ site: FeedbackSiteId });

/** The raw envelope (`sealDropEnvelope`); control parses it with `parseDropHeader` of `@whombat/core/feedback/drop`. */
export const FeedbackDropBody = z.instanceof(Uint8Array);

/** 202 for a new drop, 200 with the first one's time for the same bytes again (FD-17). */
export const FeedbackDropReceipt = z.object({ receivedAt: Timestamp });
export type FeedbackDropReceipt = z.infer<typeof FeedbackDropReceipt>;

/**
 * Control's limits of the public drop (FD-18), checked in this order before the body is read: route, `Origin`, card
 * lookup (cached `cardCacheS`), `Content-Length` (the card's `maxEnvelopeBytes`, at most
 * `FEEDBACK_DROP_MAX_ENVELOPE_BYTES`), the fixed-window counters (keyed network hash, CL-12, CL-37: per network per
 * site the card's `perSourcePerHour`, per network across sites, per site the card's `reportsPerHour` and
 * `reportsPerDay`, per control instance), the queue caps, then the body with its deadline, the header checks and the
 * insert.
 */
export const FEEDBACK_DROP_LIMITS = {
  perNetworkAllSitesPerHour: 60,
  perInstancePerMinute: 600,
  cardGetsPerNetworkPerHour: 600,
  /** Control's own cache of a site's card for the POST checks. */
  cardCacheS: 15,
  /** `Cache-Control: public, max-age=60` on the card. */
  cardMaxAgeS: 60,
  siteQueue: { drops: 200, bytes: 256 * 1024 * 1024 },
  deviceQueue: { drops: 1000, bytes: 1024 * 1024 * 1024 },
  /** The body must arrive within `bodyDeadlineS` plus `bodyDeadlinePerChunkS` per `bodyDeadlineChunk` bytes. */
  bodyDeadlineS: 30,
  bodyDeadlinePerChunkS: 1,
  bodyDeadlineChunk: 256 * 1024,
} as const;

/**
 * CORS of every route (card, drops, reporter sign-in): only control's embed and hosted UI origins, never credentials;
 * preflight 204. `authorization` carries the reporter session (CT-164); DELETE signs out.
 */
export const FEEDBACK_DROP_CORS = {
  allowMethods: 'GET, POST, DELETE',
  allowHeaders: 'content-type, authorization',
  maxAgeS: 600,
} as const;

export const feedbackDropApi = {
  card: controlEndpoint({
    id: 'feedback.card',
    method: 'GET',
    path: '/feedback/sites/:site/card',
    auth: 'none',
    summary:
      'A site’s signed card (`SignedFeedbackSiteCard`), `Cache-Control: public, max-age=60`; 404 `FeedbackPublicError` `unavailable` for an unknown, withdrawn or expired card. The frame verifies it against the snippet’s `data-key`.',
    response: SignedFeedbackSiteCard,
  }),
  drop: controlEndpoint({
    id: 'feedback.drop',
    method: 'POST',
    path: '/feedback/sites/:site/drops',
    auth: 'none',
    summary:
      'Store a sealed report (`application/octet-stream`, the envelope) until the site’s appliance collects it: 202 `{receivedAt}`, 200 with the first time for identical bytes. Errors are `FeedbackPublicError`: 400 `invalid`, 404 `unavailable` (also an `Origin` that isn’t an embed or hosted UI origin), 413 `too_large`, 429 `rate_limited` with `retryAfter` and `Retry-After`, 500 `internal`. An optional `Authorization: Bearer fbrs_…` of a valid reporter session of the same site attests the drop (`FeedbackDrop.reporter`, CT-164); an invalid one is ignored and never refuses the drop.',
    body: FeedbackDropBody,
    response: FeedbackDropReceipt,
    status: 202,
  }),
  reporterCode: controlEndpoint({
    id: 'feedback.reporter.code',
    method: 'POST',
    path: '/feedback/sites/:site/reporter/code',
    auth: 'none',
    summary:
      'Email a 6-digit sign-in code to a reporter (`FeedbackReporterCodeRequest`): 202 `{ok: true}` whether or not one was sent, sent without awaiting. 404 `unavailable` (no live card with `reporters: true`, `parent` not in the card’s `allowedOrigins`, `Origin` not an embed or hosted UI origin, the drop off), 429 `rate_limited`.',
    body: FeedbackReporterCodeRequest,
    response: FeedbackReporterOk,
    status: 202,
  }),
  reporterSession: controlEndpoint({
    id: 'feedback.reporter.session',
    method: 'POST',
    path: '/feedback/sites/:site/reporter/session',
    auth: 'none',
    summary:
      'Exchange the code for a reporter session (`FeedbackReporterSessionRequest` → `FeedbackReporterSession`, 30 days). 400 `code_refused` for every failure (wrong, expired, used, too many tries, unknown email), 404 `unavailable`, 429 `rate_limited`.',
    body: FeedbackReporterSessionRequest,
    response: FeedbackReporterSession,
  }),
  reporterSignOut: controlEndpoint({
    id: 'feedback.reporter.signOut',
    method: 'DELETE',
    path: '/feedback/sites/:site/reporter/session',
    auth: 'none',
    summary:
      'End the reporter session of `Authorization: Bearer fbrs_…`: 204, also for an unknown or expired token or none.',
    response: z.undefined(),
    status: 204,
  }),
  reporterReports: controlEndpoint({
    id: 'feedback.reporter.reports',
    method: 'GET',
    path: '/feedback/sites/:site/reporter/reports',
    auth: 'none',
    summary:
      'The signed-in reporter’s reports on the site (`Authorization: Bearer fbrs_…`), newest first, as the appliance published them (`feedback.reporters.publish`): `FeedbackReporterReports` with `summary: null` (control never holds report text; the frame shows its own). 401 `signed_out`, 404 `unavailable`, 429 `rate_limited`.',
    response: FeedbackReporterReports,
  }),
} as const;
