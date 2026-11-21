/**
 * Shared links (Whombat docs/decisions/share-links.md): the box keeps a sealed copy of part of a Chat thread at control,
 * which hands it to whoever opens the link. Control never holds the key (it is in the link's fragment), so it keeps and
 * serves bytes it can't read. The manager signs and forwards the three device ops; the viewer reads the copy at
 * `GET /v1/shares/<id>` without signing in. Cross-language.
 */
import { SHARE_MAX_ENVELOPE_BYTES, ShareId } from '@whombat/core/share';
import { EpochSeconds } from '@whombat/release';
import { z } from 'zod';

export { SHARE_MAX_ENVELOPE_BYTES };

/** `share.put`'s largest signed request: the copy in base64url (4/3) and the envelope around it. */
export const SHARE_PUT_MAX_BYTES = Math.ceil((SHARE_MAX_ENVELOPE_BYTES * 4) / 3) + 65_536;
/** Furthest ahead a link may stop working (`expiresAt`); a link that never stops has none. */
export const SHARE_MAX_LIFETIME_S = 400 * 86_400;
/** The most live links one Whombat keeps at control; a put beyond it is refused `share_limit`. */
export const SHARES_PER_DEVICE_MAX = 500;
/** At most this many ids in one `share.delete` or `share.views`. */
export const SHARE_IDS_MAX = 200;

const SharePut = z.strictObject({
  shareId: ShareId,
  /** When control stops serving it and deletes it; absent: it works until the box stops it. */
  expiresAt: EpochSeconds.optional(),
  /** The sealed copy (`sealSnapshot`), base64url. */
  envelope: z
    .string()
    .min(2)
    .max(Math.ceil((SHARE_MAX_ENVELOPE_BYTES * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/),
});

const SharePutResult = z.object({
  /** The viewer page for this share on control's hosted app, without the key (`https://<app>/s/<id>`). */
  url: z
    .string()
    .min(8)
    .max(300)
    .regex(/^https?:[/][/][\x21-\x7e]+$/),
});

const ShareIds = z.strictObject({ shareIds: z.array(ShareId).min(1).max(SHARE_IDS_MAX) });

/** How often a link was opened (each fetch of the sealed copy counts once). */
export const ShareViews = z.object({
  shareId: ShareId,
  views: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  lastViewedAt: EpochSeconds.optional(),
});
export type ShareViews = z.infer<typeof ShareViews>;

/** Why control refused a put: the id is another Whombat's, or this one keeps too many links. */
export const ShareRefusalCode = z.enum(['share_taken', 'share_limit', 'bad_expiry']);
export type ShareRefusalCode = z.infer<typeof ShareRefusalCode>;

export const SHARE_DEVICE_OPS = {
  /**
   * Keep a sealed copy under its id: a new id is stored, the same id of the same Whombat replaces the copy and its
   * expiry (views are kept). Refuses another Whombat's id (`share_taken`), more than `SHARES_PER_DEVICE_MAX` live links
   * (`share_limit`) and an `expiresAt` not in the future or beyond `SHARE_MAX_LIFETIME_S` (`bad_expiry`); an unclaimed
   * device gets `device_unclaimed`, a retired one `device_revoked`.
   */
  'share.put': { body: SharePut, response: SharePutResult },
  /** Stop links: control deletes this Whombat's copies of these ids at once. Unknown ids are ignored. */
  'share.delete': { body: ShareIds, response: z.object({ ok: z.literal(true) }) },
  /** How often this Whombat's links were opened; a link control no longer keeps is left out. */
  'share.views': {
    body: ShareIds,
    response: z.object({ shares: z.array(ShareViews).max(SHARE_IDS_MAX) }),
  },
} as const;
