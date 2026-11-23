/**
 * Whombat Link on the account site (4.4; Whombat docs/decisions/whombat-link.md, one-environment.md): the hosted app,
 * signed in to the person's account, confirms a box's link code at `/link`, lists the account's boxes with their Link
 * state, and opens Stripe Checkout or the Customer Portal for the one Link subscription (`LINK_OFFER_TEXT`: the first
 * month free, then €2.50 a month or €25 a year a box). Not cross-language: only the hosted app and control use these.
 */
import {
  LinkCode,
  LinkState,
  OwnAddressClaimUrl,
  OwnAddressHost,
  OwnAddressLabel,
  OwnAddressNameCandidate,
} from '@whombat/protocol';
import { EpochSeconds } from '@whombat/release';
import { z } from 'zod';
import { BillingRedirect, PlanInterval, SubscriptionTerms } from './billing.js';
import { DeviceId } from './common.js';
import { AddressLeaving } from './device/address.js';
import { TermsVersion } from './directory.js';
import { controlEndpoint } from './endpoint.js';

/** A box's name as its owner gave it (absent at first start, before the box was set up). */
const BoxName = z.string().min(1).max(80);

/** `link.lookup`: which box a code belongs to, so the page can ask “Add <name> to Whombat Link?”. */
export const LinkLookupBody = z.strictObject({ code: LinkCode });
export const LinkLookup = z.object({
  code: LinkCode,
  name: BoxName.nullable(),
  expiresAt: EpochSeconds,
  /** The box is already linked to this account (confirming again is fine). */
  linked: z.boolean(),
  /** Confirming starts the account's free month (the first time per account). */
  trial: z.boolean(),
  /**
   * The Subscription Terms version `link.confirm` asks the person to accept (4.7): control's `SUBSCRIPTION_TERMS_VERSION`.
   * Absent from an older control, which takes no `terms` in the confirm body.
   */
  termsVersion: TermsVersion.optional(),
  /**
   * The box can take a name the person chooses (4.16): its manager said so (`ownNames`) and the account has chosen names
   * left this year. Absent or false: the account site offers no choice and the box gets a random name.
   */
  chooseName: z.boolean().optional(),
});
export type LinkLookup = z.infer<typeof LinkLookup>;

/**
 * `link.confirm`: the code's box joins the account's Link. `terms` (4.7): the Subscription Terms the person ticked, sent
 * when the lookup named a `termsVersion`; control records the version it accepted.
 */
export const LinkConfirmBody = z.strictObject({
  code: LinkCode,
  terms: SubscriptionTerms.optional(),
  /**
   * The name the person chose for the box's address (4.16), checked with `link.name.check` first; absent, the box gets
   * a random one. Control checks it again when it confirms (`label_invalid`, `label_reserved`, `label_taken`, 409:
   * nothing is linked then) and gives it with the box's address; a name another box took in between falls back to a
   * random one, which the person can change later. An older control refuses the member (strict body).
   */
  label: OwnAddressLabel.optional(),
});
export type LinkConfirmBody = z.infer<typeof LinkConfirmBody>;

/** `link.name.check` (4.16): the name the person is typing for the box's address. */
export const LinkNameCheckBody = z.strictObject({ name: OwnAddressNameCandidate });
export type LinkNameCheckBody = z.infer<typeof LinkNameCheckBody>;

/** What a name would be at setup: as `OwnAddressNameVerdict`, without `yours` (no box is asking). */
export const LinkNameVerdict = z.enum(['free', 'taken', 'reserved', 'invalid']);
export type LinkNameVerdict = z.infer<typeof LinkNameVerdict>;

/** `host`: the box's address with that name, only when it is `free` (built with control's zone of today). */
export const LinkNameCheck = z.object({
  name: OwnAddressNameCandidate,
  verdict: LinkNameVerdict,
  host: OwnAddressHost.optional(),
});
export type LinkNameCheck = z.infer<typeof LinkNameCheck>;

/**
 * How the Link subscription is paid for (4.6): `month` (€2.50 a box) or `year` (€25 a box). Chosen at checkout, switched
 * in Stripe's portal. The same values as a plan's `interval`.
 */
export const LinkInterval = PlanInterval;
export type LinkInterval = PlanInterval;

/** A Stripe promotion code as the customer entered it at checkout (admin makes them from letters and digits). */
export const LinkPromotionCode = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/);

/**
 * What the account pays less (4.6): free time an operator gave (3 months, 6 months, a year or forever) or a promotion
 * code entered at checkout. Admin's free time and its codes are percentages; control rounds anything else to whole
 * percent.
 */
export const LinkDiscount = z.object({
  /** 100 = free. */
  percentOff: z.number().int().min(1).max(100),
  /** When the discount stops; null = forever. During the free month it may start later, at the free month's end. */
  endsAt: EpochSeconds.nullable(),
  /** The promotion code the customer entered; null for free time from an operator. */
  code: LinkPromotionCode.nullable(),
});
export type LinkDiscount = z.infer<typeof LinkDiscount>;

/**
 * The countries Whombat Link is sold in (4.10): the 27 EU member states, as ISO 3166-1 codes (Greece is `GR`). Outside
 * them a VAT registration would be needed from the first sale, so the account site asks where the person lives before
 * paying and `link.checkout` refuses another country (`link_country`). Selling in more countries is this list.
 */
export const LINK_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;

/** A country as an ISO 3166-1 code (`NL`), any country: control answers one Link isn't sold in itself. */
export const LinkCountry = z.string().regex(/^[A-Z]{2}$/);
export type LinkCountry = z.infer<typeof LinkCountry>;

/** Whombat Link is sold to people who live in this country (`LINK_COUNTRIES`). */
export function linkSoldIn(country: string): boolean {
  return (LINK_COUNTRIES as readonly string[]).includes(country);
}

/**
 * `link.checkout`: monthly or yearly (4.6; absent = `month`, what an older account site asks for) and the Subscription
 * Terms the person ticked (4.8; needed while the account has accepted none). The page is always a subscription-mode
 * Checkout with Stripe's own field for a promotion code (4.9), so `promotionCode` stays only so a 4.8 body parses: a
 * control on 4.9 refuses a non-empty one (`promotion_code_on_payment_page`, 400) rather than drop it. `country` (4.10):
 * where the person said they live; one outside `LINK_COUNTRIES` is refused (`link_country`, 403) before any page opens.
 * An older account site sends none, and Checkout's billing address is all control learns.
 */
export const LinkCheckoutBody = z.strictObject({
  interval: LinkInterval.optional(),
  promotionCode: LinkPromotionCode.optional(),
  terms: SubscriptionTerms.optional(),
  country: LinkCountry.optional(),
});
export type LinkCheckoutBody = z.infer<typeof LinkCheckoutBody>;

/** `link.portal` (4.8): the Subscription Terms the person ticked, needed while the account has accepted none. */
export const LinkPortalBody = z.strictObject({ terms: SubscriptionTerms.optional() });
export type LinkPortalBody = z.infer<typeof LinkPortalBody>;

/** The account's Link subscription as the account site shows it. */
export const LinkPlanState = z.enum(['none', 'trialing', 'active', 'past_due', 'cancelled', 'comp']);
export type LinkPlanState = z.infer<typeof LinkPlanState>;

export const LinkPlan = z.object({
  state: LinkPlanState,
  /**
   * The free month's own end while it runs; null once it is over, also during free time, whose end is
   * `discount.endsAt` (4.9 wording; control CL-218).
   */
  trialEndsAt: EpochSeconds.nullable(),
  /** The end of the period paid for; null without a subscription. */
  currentPeriodEnd: EpochSeconds.nullable(),
  /** Cancelled in the portal: it ends at `currentPeriodEnd`. */
  cancelAtPeriodEnd: z.boolean(),
  /** The account may still take its free month; false once it started (a linked box, or the payment page opened). */
  trialAvailable: z.boolean(),
  /** The subscription's quantity: boxes linked now. */
  boxes: z.number().int().min(0).max(1_000),
  /**
   * A Stripe subscription with a card on file (4.5): it carries on by itself after the free month, and “Manage
   * subscription” opens the portal. False: nothing in Stripe yet (the free month or free time, which control keeps
   * itself until the person pays, or no plan): Subscribe or “Add a card” opens Checkout, never the portal. Absent from
   * an older control.
   */
  cardOnFile: z.boolean().optional(),
  /** The subscription's billing interval (4.6); absent without a subscription and from an older control. */
  interval: LinkInterval.optional(),
  /**
   * The discount the subscription has now or has coming (4.6): “Free until 19 May 2027”, a used code. Null: none.
   * Absent from an older control.
   */
  discount: LinkDiscount.nullable().optional(),
});
export type LinkPlan = z.infer<typeof LinkPlan>;

/** One of the account's boxes. */
export const LinkedBox = z.object({
  device: DeviceId,
  name: BoxName.nullable(),
  state: LinkState,
  since: EpochSeconds,
  graceEndsAt: EpochSeconds.nullable(),
  label: OwnAddressLabel.nullable(),
  /** `<label>.whombat.app` (`<label>.box.whombat.app` for a box that hasn't moved), once the box has its address. */
  host: OwnAddressHost.nullable(),
  /** The box's earlier address while it still works (4.16); absent when none is, and from an older control. */
  leaving: AddressLeaving.optional(),
  /** The last ticket the box asked for. */
  lastSeenAt: EpochSeconds.nullable(),
  /**
   * The box's claim link (4.13), `https://<host>/c/<six letters>`: only while nobody claimed the box, it has its address
   * and Link runs, and only in the answers of the account the box is linked to. The box reports it (`link.status`
   * `claimLink`); “Claim it now” opens it, so the person types only the four letters on the screen. Absent from an older
   * control or box: open `https://<host>/`, which asks for the six letters too.
   */
  claimUrl: OwnAddressClaimUrl.optional(),
});
export type LinkedBox = z.infer<typeof LinkedBox>;

/** `link.boxes`: the account's Link and its boxes. */
export const LinkAccount = z.object({
  plan: LinkPlan,
  boxes: z.array(LinkedBox).max(1_000),
});
export type LinkAccount = z.infer<typeof LinkAccount>;

export const linkApi = {
  lookup: controlEndpoint({
    id: 'link.lookup',
    method: 'POST',
    path: '/link/lookup',
    auth: 'session',
    summary:
      'Which box a link code belongs to (the `/link` page, before the person confirms): `link_code_invalid` (404) for an unknown, used or expired code. Ten wrong codes an hour per account and per address (`rate_limited`). Reads only.',
    body: LinkLookupBody,
    response: LinkLookup,
  }),
  confirm: controlEndpoint({
    id: 'link.confirm',
    method: 'POST',
    path: '/link/confirm',
    auth: 'session',
    summary:
      'Add the code’s box to the account’s Link: the e-mail must be confirmed (`email_unconfirmed`), the box not another account’s (`link_other_account`), at most two boxes during the free month (`link_trial_boxes`). `label` (4.16), when sent, is checked in the same transaction (`label_invalid`, `label_reserved`, `label_taken`, 409) and becomes the box’s name when control gives it its address (a random one if another box took it in between). `terms` (4.7), when sent, must be the current `SUBSCRIPTION_TERMS_VERSION` (`terms_outdated`, 409) and is recorded as the account’s acceptance; without `terms` an account that has accepted no version is refused (`terms_required`, 400, 4.8). Starts the free month the first time, raises the subscription’s quantity, and gives the box its label (or queues it when the day’s new labels ran out). The code is used up. Audited as `link.confirmed`.',
    body: LinkConfirmBody,
    response: LinkedBox,
  }),
  nameCheck: controlEndpoint({
    id: 'link.name.check',
    method: 'POST',
    path: '/link/name',
    auth: 'session',
    summary:
      'Whether a name the person is typing could be the address of the box they are about to confirm (4.16): `free` (with its `host`), `taken` (another box has or had it), `reserved` or `invalid`. Reads only; 120 an hour per account (`rate_limited`). The answer holds nothing: `link.confirm` checks the name again.',
    body: LinkNameCheckBody,
    response: LinkNameCheck,
  }),
  boxes: controlEndpoint({
    id: 'link.boxes',
    method: 'GET',
    path: '/link/boxes',
    auth: 'session',
    summary: 'The account’s Link subscription and its boxes with their Link state.',
    response: LinkAccount,
  }),
  remove: controlEndpoint({
    id: 'link.remove',
    method: 'DELETE',
    path: '/link/boxes/:device',
    auth: 'session',
    summary:
      'Take a box out of the account’s Link (the quantity drops at once); the box learns `off` with its next ticket. Its label stays its own. `not_found` for a box that isn’t the account’s.',
    response: LinkAccount,
  }),
  checkout: controlEndpoint({
    id: 'link.checkout',
    method: 'POST',
    path: '/link/checkout',
    auth: 'session',
    summary:
      'The one way to start paying (4.9; nothing is in Stripe before): a subscription-mode Stripe Checkout Session for Link, monthly or yearly (`interval`, default `month`), at the linked boxes’ quantity (at least 1), with Stripe’s field for a promotion code, Stripe’s field for a business’s VAT number (4.10), Stripe Tax, a required billing address and the terms checkbox; it trials until the end of the free month or free time when more than 48 hours are left. An open page with the same terms is answered again. `link_country` (403, 4.10: a `country` outside `LINK_COUNTRIES`), `promotion_code_on_payment_page` (400: a non-empty `promotionCode`), `terms_required` (400) / `terms_outdated` (409) as `link.confirm`, `checkout_busy` (409: another billing change of the account runs; try again shortly), `subscription_exists` (409: Stripe has a subscription; use the portal), `manual_billing` (409: a free account, nothing to pay), `billing_provider_error` / `billing_provider_refused` (503).',
    body: LinkCheckoutBody,
    response: BillingRedirect,
  }),
  portal: controlEndpoint({
    id: 'link.portal',
    method: 'POST',
    path: '/link/portal',
    auth: 'session',
    summary:
      'A Stripe Customer Portal session for Link once Stripe has its subscription (card, invoices, monthly or yearly, cancelling at the period’s end): `no_subscription` (409) until then (the free month and free time are paid for through `link.checkout`), `checkout_busy` (409), `terms_required` (400) / `terms_outdated` (409) as `link.confirm`.',
    body: LinkPortalBody,
    response: BillingRedirect,
  }),
};
