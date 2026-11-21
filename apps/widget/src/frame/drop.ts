/**
 * Drop mode of the frame (Whombat `docs/decisions/feedback-drop.md` FD-27, FD-28; AP-106): on a managed Whombat
 * the frame runs on the embed origin, a static host, and talks to control only. It fetches the site's signed card,
 * verifies it against the snippet's `data-key` pin, seals the report to the card's key in the visitor's browser and
 * posts the ciphertext to control's drop. Nothing here reads or writes cookies or any storage. Reporter sign-in uses
 * control's `…/reporter/*` routes (`reporter*Path`, CT-164) with the same shapes as the self-hosted ones.
 *
 * Kept free of Zod: `@whombat/core/feedback/drop` is pure (noble + WebCrypto), the card's `config` is checked by the
 * frame's own `parseConfig`, and the control paths are repeated here (a test keeps them equal to
 * `feedbackDropApi` of `@whombat/control-contracts`).
 */
import type { FeedbackSiteCard } from '@whombat/core/domain';
import {
  FEEDBACK_DROP_SUITE,
  FeedbackDropError,
  feedbackReferenceFor,
  sealDropEnvelope,
  verifySiteCard,
} from '@whombat/core/feedback/drop';
import { normalizeOrigin } from '@whombat/core/feedback/sanitize';
import { WIDGET_VERSION } from '../version';
import type { FrameParams } from './bridge';
import { type PublicConfig, parseConfig } from './config';
import type { SubmissionBody } from './draft';
import { type FetchLike, type Outcome, SUBMIT_TIMEOUT_MS } from './submit';

/** The `<meta name>` of the static `frame.html` that names control's origin (the embed build writes it). */
export const CONTROL_META = 'whombat-control';
export const CARD_TIMEOUT_MS = 15_000;
/** `FeedbackDropFrame.ancestorOrigins` holds at most this many entries. */
export const MAX_ANCESTORS = 8;

/** `CONTROL_PREFIX` + `feedbackDropApi.card.path` of `@whombat/control-contracts`. */
export const cardPath = (site: string) => `/v1/feedback/sites/${encodeURIComponent(site)}/card`;
/** `CONTROL_PREFIX` + `feedbackDropApi.drop.path`. */
export const dropPath = (site: string) => `/v1/feedback/sites/${encodeURIComponent(site)}/drops`;
/** `CONTROL_PREFIX` + `feedbackDropApi.reporterCode.path`. */
export const reporterCodePath = (site: string) =>
  `/v1/feedback/sites/${encodeURIComponent(site)}/reporter/code`;
/** `CONTROL_PREFIX` + `feedbackDropApi.reporterSession.path` (and `reporterSignOut.path`, DELETE). */
export const reporterSessionPath = (site: string) =>
  `/v1/feedback/sites/${encodeURIComponent(site)}/reporter/session`;
/** `CONTROL_PREFIX` + `feedbackDropApi.reporterReports.path`. */
export const reporterReportsPath = (site: string) =>
  `/v1/feedback/sites/${encodeURIComponent(site)}/reporter/reports`;

/** What drop mode knows besides the frame's URL: control's origin and the frame's ancestors. */
export interface DropEnvironment {
  /** Control's origin from `frame.html`'s meta, or null (a frame served without one can't drop). */
  control: string | null;
  /** `location.ancestorOrigins` as an array (at most 8), or null where the browser has none. */
  ancestorOrigins: string[] | null;
}

/** Control's origin as `frame.html` names it, canonical, or null. */
export function controlOrigin(doc: Document): string | null {
  const meta = doc.querySelector<HTMLMetaElement>(`meta[name="${CONTROL_META}"]`);
  return normalizeOrigin(meta?.content ?? '');
}

/** `location.ancestorOrigins` as the plaintext carries it (FD-15). */
export function ancestorOriginsOf(location: {
  ancestorOrigins?: { length: number; [i: number]: string };
}): string[] | null {
  const list = location.ancestorOrigins;
  if (!list) return null;
  const out: string[] = [];
  for (let i = 0; i < list.length && i < MAX_ANCESTORS; i++) out.push(String(list[i]));
  return out;
}

export interface LoadedCard {
  card: FeedbackSiteCard;
  config: PublicConfig;
}

/**
 * Fetches and checks the site's card (FD-28 (1), (2)): signed by the key the snippet pins, for this site, a known
 * version and suite, a config the frame can show, the embedding page one of the card's allowed origins and, where
 * the browser says, the frame's direct ancestor. Null on any failure: the frame then shows “unavailable”. Card times
 * are not checked against the visitor's clock (control and the runtime enforce expiry).
 */
export async function loadCard(
  fetchImpl: FetchLike,
  params: FrameParams,
  env: DropEnvironment,
  timeoutMs = CARD_TIMEOUT_MS,
): Promise<LoadedCard | null> {
  if (!params.key || !env.control) return null;
  const first = env.ancestorOrigins?.[0];
  if (first !== undefined && first !== params.parent) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let json: unknown;
  try {
    const res = await fetchImpl(`${env.control}${cardPath(params.site)}`, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  const verified = verifySiteCard(json, params.key, { site: params.site });
  if (!verified.ok) return null;
  const card = verified.card;
  if (card.v !== 1 || card.encryption.suite !== FEEDBACK_DROP_SUITE) return null;
  if (!card.allowedOrigins.includes(params.parent)) return null;
  const config = parseConfig(card.config);
  return config ? { card, config } : null;
}

/** One draft's sealed report: the envelope bytes, sent unchanged on every retry, and its derived reference. */
export interface SealedDrop {
  envelope: Uint8Array;
  reference: string;
}

/** The frame's evidence sealed with the submission (FD-15). */
export interface DropFrameEvidence {
  bridgeOrigin: string;
  ancestorOrigins: string[] | null;
  cardSeq: number;
}

/**
 * Seals `submission` to the card's key (FD-14, FD-15) with the reference the runtime will file it under (FD-16).
 * Throws `FeedbackDropError` `too_large` above the card's `maxEnvelopeBytes`.
 */
export async function sealSubmission(
  card: FeedbackSiteCard,
  submission: SubmissionBody,
  evidence: DropFrameEvidence,
): Promise<SealedDrop> {
  const plaintext = JSON.stringify({
    v: 1,
    submission,
    frame: {
      bridgeOrigin: evidence.bridgeOrigin,
      ancestorOrigins: evidence.ancestorOrigins,
      widget: WIDGET_VERSION,
      cardSeq: evidence.cardSeq,
    },
  });
  const envelope = await sealDropEnvelope(card, plaintext);
  return { envelope, reference: feedbackReferenceFor(card.site, submission.submissionId) };
}

export function isTooLarge(err: unknown): boolean {
  return err instanceof FeedbackDropError && err.code === 'too_large';
}

function retryAfterOf(body: unknown, header: string | null): number | null {
  const fromBody = (body as { error?: { retryAfter?: unknown } } | null)?.error?.retryAfter;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

/**
 * Posts the envelope to control's drop (FD-17) and says what happened (FD-28 (6)); never throws. 202 (new) and 200
 * (the same bytes again) are the receipt with the derived reference; 404 unavailable; 413 too large; 429 rate
 * limited; anything else the server message, no answer the network message. Signed in, the reporter session goes
 * along as a bearer token so control can attest the drop (CT-164); control ignores one it doesn't know.
 */
export async function postDrop(
  fetchImpl: FetchLike,
  url: string,
  sealed: SealedDrop,
  timeoutMs = SUBMIT_TIMEOUT_MS,
  token: string | null = null,
): Promise<Outcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let json: unknown = null;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: sealed.envelope as Uint8Array<ArrayBuffer>,
      credentials: 'omit',
      cache: 'no-store',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    try {
      json = await res.json();
    } catch {
      json = null;
    }
  } catch {
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
  const s = res.status;
  if (s === 200 || s === 202) {
    const receivedAt = (json as { receivedAt?: unknown } | null)?.receivedAt;
    return typeof receivedAt === 'string'
      ? { kind: 'received', receipt: { reference: sealed.reference, receivedAt } }
      : { kind: 'server' };
  }
  if (s === 404) return { kind: 'unavailable' };
  if (s === 413) return { kind: 'attachments', reason: 'too_large', fields: [] };
  if (s === 429)
    return { kind: 'rate_limited', retryAfter: retryAfterOf(json, res.headers.get('retry-after')) };
  return { kind: 'server' };
}
