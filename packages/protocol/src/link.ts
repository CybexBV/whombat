/**
 * Whombat Link (contracts 4.4; Whombat docs/decisions/whombat-link.md, one-environment.md): the one paid service, remote
 * access without port forwarding (the box's own address through the door), push to the phone apps and the apps away
 * from home. These are the shapes every side shares: the Link state, the one-time code the box shows at the start, a
 * phone's push token and the price people see. Cross-language where the device API and the manager socket use them;
 * the price and the offer sentence are TypeScript only.
 */
import { z } from 'zod';
import { CLAIM_CODE_ALPHABET } from './claim/alphabet.js';

/**
 * Where a box stands with Link. Control is the authority (billing); the manager learns it from every ticket answer.
 * - `off`: never turned on, or the owner turned it off;
 * - `starting`: the box asked (`link.begin`) and waits for the person to confirm its code at `app.whombat.com/link`,
 *   or for an address when the day's new labels ran out;
 * - `on`: linked and paid for (the free month, a subscription, or a comp);
 * - `grace`: the subscription ended or the free month ran out without a card; everything still works until
 *   `graceEndsAt` (7 days), and the box asks for Tailscale and the paper copy of the backup details;
 * - `ended`: after grace. The address, phone push, remote help and shared links stop; the label stays the box's.
 */
export const LINK_STATES = ['off', 'starting', 'on', 'grace', 'ended'] as const;
export const LinkState = z.enum(LINK_STATES);
export type LinkState = z.infer<typeof LinkState>;

/** How long Link keeps working after it ended (Whombat whombat-link.md). */
export const LINK_GRACE_S = 7 * 86_400;
/** The free month: 30 days, once per account, at most two boxes during it. */
export const LINK_TRIAL_DAYS = 30;
export const LINK_TRIAL_BOXES_MAX = 2;

/**
 * The price as people see it: one place, so the installer, the pages and the account site agree. VAT included, per
 * box; a box is paid for by the month or by the year (4.6), chosen at checkout and switched in Stripe's portal.
 */
export const LINK_PRICE_CENTS = 250;
export const LINK_PRICE_CURRENCY = 'EUR';
export const LINK_PRICE_TEXT = '€2.50 a month';
export const LINK_PRICE_YEAR_CENTS = 2_500;
export const LINK_PRICE_YEAR_TEXT = '€25 a year';
export const LINK_TRIAL_TEXT = 'First month free';
/**
 * The one offer sentence (“First month free, then €2.50 a month or €25 a year”): the installer, the box's Settings, the
 * account site and control's e-mails all show this, never their own wording. Not on the iPhone (no price there).
 */
export const LINK_OFFER_TEXT = `${LINK_TRIAL_TEXT}, then ${LINK_PRICE_TEXT} or ${LINK_PRICE_YEAR_TEXT}`;

/**
 * The one-time code the box shows when Link starts (`XXXX-XXXX`, the claim alphabet in upper case): the person types
 * it at `app.whombat.com/link` to confirm the box into their account. It lives `LINK_CODE_TTL_S` and links one box.
 * The other direction, a code from the account typed at the box, is `AccountLinkCode` (4.3).
 */
export const LINK_CODE_RE = /^[ABCDEFGHJKMNPQRTVWXY]{4}-[ABCDEFGHJKMNPQRTVWXY]{4}$/;
export const LinkCode = z.string().regex(LINK_CODE_RE);
export type LinkCode = z.infer<typeof LinkCode>;
export const LINK_CODE_TTL_S = 900;
/** The page on the account site where the code is typed. */
export const LINK_PAGE_PATH = '/link';

/**
 * A code as a person typed it, in the form `LinkCode` wants (upper case, `XXXX-XXXX`), or null when it can't be one:
 * spaces and hyphens anywhere are dropped, then exactly eight letters of the claim alphabet must remain.
 */
export function normalizeLinkCode(input: string): string | null {
  const letters = input.replace(/[\s-]+/g, '').toUpperCase();
  if (letters.length !== 8) return null;
  for (const c of letters) if (!CLAIM_CODE_ALPHABET.includes(c)) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** A page on the account site the box shows: `https://…`, printable ASCII. */
export const LinkPageUrl = z
  .string()
  .min(12)
  .max(256)
  .regex(/^https:[/][/][\x21-\x7e]+$/);

/**
 * A phone app's push token as the phone hands it to its box: APNs or FCM, the token, and the app it belongs to
 * (the APNs topic or the FCM project). The box registers it at control (`push.register`) and keeps the handle.
 */
export const NativePushToken = z.strictObject({
  platform: z.enum(['apns', 'fcm']),
  token: z
    .string()
    .min(16)
    .max(4_096)
    .regex(/^[\x21-\x7e]+$/),
  appId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/),
});
export type NativePushToken = z.infer<typeof NativePushToken>;
