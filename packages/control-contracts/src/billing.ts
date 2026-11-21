/**
 * Billing/entitlement boundary. Entitlement drives cloud services (relay routing, updates, push) and, through the
 * signed licence token (`licence.renew`, LC-01…LC-12), whether an appliance runs its paid features (the agent,
 * automations, growth). It never deletes, locks or degrades data on an appliance, and a lapsed subscription never
 * blocks local export, recovery or security updates (`ENTITLEMENT_NEVER_AFFECTS`).
 */
import { EntitlementState } from '@whombat/protocol/licence';
import { EpochSeconds } from '@whombat/release';
import { z } from 'zod';
import { OrgId } from './common.js';
import { TermsVersion } from './directory.js';
import { controlEndpoint } from './endpoint.js';

/** Lives in `@whombat/protocol` since 0.10.0 (the licence token carries it, LC-01); re-exported here. */
export { EntitlementState };

/** A plan limit the appliance enforces on adding (LC-10, LC-11): an integer, or null = unlimited. */
export const PlanLimit = z.number().int().min(0).max(100_000).nullable();

/**
 * What the plan allows on an appliance besides `devicesAllowed` (LC-11); copied into every licence token. Connectors
 * only since 3.0 (CT-1562): a Whombat is one person's, so there is no member limit.
 */
export const EntitlementLimits = z.object({
  connectors: PlanLimit,
});
export type EntitlementLimits = z.infer<typeof EntitlementLimits>;

/**
 * A plan id (BL-11): `whombat` (the one plan since 3.0, Whombat one-person.md OP-18), `free`, or an operator's own. An
 * entitlement also uses `none` while the org is waiting for a plan (BL-13), which has no `plans` row.
 */
export const PlanId = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9-]+$/);
export type PlanId = z.infer<typeof PlanId>;

export const Entitlement = z.object({
  org: OrgId,
  plan: PlanId,
  state: EntitlementState,
  devicesAllowed: z.number().int().min(0).max(10_000),
  currentPeriodEnd: EpochSeconds.nullable(),
  /** The appliance's connector limit (0.10, LC-11; connectors only since 3.0); null = unlimited. */
  limits: EntitlementLimits,
  /**
   * The org may claim self-registered devices (`origin: 'self'`, the ISO; LC-15). Otherwise `claims.start` answers
   * 403 `self_install_not_allowed` for one.
   */
  selfInstall: z.boolean(),
  /** Cloud services that remain available in this state. */
  services: z.object({
    relay: z.boolean(),
    updates: z.boolean(),
    push: z.boolean(),
  }),
});
export type Entitlement = z.infer<typeof Entitlement>;

/** Invariant: whatever the state, security updates and data export stay available. */
export const ENTITLEMENT_NEVER_AFFECTS = ['local_data', 'export', 'recovery', 'security_updates'] as const;

/** A plan's display name (“Whombat”). */
export const PlanName = z.string().trim().min(1).max(64);

/** Price in cents for one `interval`; EUR only. Business plans exclude VAT (BL-02); Whombat Link's include it. */
export const PlanAmountCents = z.number().int().min(0).max(100_000_000);

/**
 * How often a plan is paid for: by the month, or by the year (4.6: Whombat Link's yearly price, Whombat
 * one-environment.md). Business plans, the ones `signup.info` offers, are monthly.
 */
export const PlanInterval = z.enum(['month', 'year']);
export type PlanInterval = z.infer<typeof PlanInterval>;

/**
 * A plan (BL-02, BL-11). The price is per Whombat per `interval`; the subscription's quantity is the number of Whombats
 * paid for (`devicesAllowed`, BL-01). Its limits are copied into the entitlement whenever the plan is applied.
 */
export const Plan = z.object({
  id: PlanId,
  name: PlanName,
  amountCents: PlanAmountCents,
  currency: z.literal('eur'),
  interval: PlanInterval,
  limits: EntitlementLimits,
  selfInstall: z.boolean(),
  /** Offered at checkout and in `signup.info`. */
  public: z.boolean(),
});
export type Plan = z.infer<typeof Plan>;

/** A public plan as `signup.info` lists it (BL-25): a business plan, so monthly. */
export const SignupPlan = Plan.pick({
  id: true,
  name: true,
  amountCents: true,
  currency: true,
  limits: true,
}).extend({ interval: z.literal('month') });
export type SignupPlan = z.infer<typeof SignupPlan>;

/** Who may create an org (BL-04, BL-21): anyone, with a code from the waitlist or with an invite code. */
export const SignupMode = z.enum(['open', 'waitlist', 'invite']);
export type SignupMode = z.infer<typeof SignupMode>;

/** Control's billing provider (BL-12, environment, not a live setting). */
export const BillingProviderName = z.enum(['manual', 'stripe']);
export type BillingProviderName = z.infer<typeof BillingProviderName>;

/**
 * The version of the Whombat Subscription Terms accepted when a box joins an account's Whombat Link (`link.confirm`,
 * 4.7) and when an org is created (BL-06, BL-24). Control accepts only this version (`terms_outdated` otherwise);
 * changing the terms means a new id, and so a contracts release. The text is the hosted app's
 * `/legal/subscription-terms`. `2026-11-19`: Whombat Link for people and businesses, €2.50 a month or €25 a year a box
 * with VAT, the free month without a card, cancelling any time, money back within 14 days of the first payment, and
 * the grace week when it ends.
 */
export const SUBSCRIPTION_TERMS_VERSION = '2026-11-19';

/** “I agree to the Whombat Subscription Terms”, ticked when creating an org (BL-21, BL-24). */
export const SubscriptionTerms = z.strictObject({ version: TermsVersion });
export type SubscriptionTerms = z.infer<typeof SubscriptionTerms>;

/** Trial length in days (BL-29). */
export const TrialDays = z.number().int().min(1).max(60);

/** `GET /v1/signup` (BL-25): what the create-org screen needs. */
export const SignupInfo = z.object({
  mode: SignupMode,
  billing: BillingProviderName,
  trialDays: TrialDays,
  termsVersion: TermsVersion,
  /** Public plans only, in the panel's order. */
  plans: z.array(SignupPlan).max(20),
});
export type SignupInfo = z.infer<typeof SignupInfo>;

/** Number of Whombats a customer pays for at checkout or later (BL-15, BL-18). */
export const BillingWhombats = z.number().int().min(1).max(50);

/**
 * `GET /v1/orgs/:org/billing` (BL-13, BL-15…BL-18): the org's subscription as the Billing page shows it. The org's one
 * account reads it and acts on it (3.0, CT-1561: no roles, so no `canManage`).
 */
export const BillingView = z.object({
  org: OrgId,
  /** Who manages the org's entitlement: `stripe` (a subscription) or `manual` (a trial or a plan set by Whombat). */
  provider: BillingProviderName,
  /** Null while the org is waiting for a plan (entitlement plan `none`, `setupRequired`). */
  plan: z.object({ id: PlanId, name: PlanName }).nullable(),
  state: EntitlementState,
  /** Set while trialing: when the trial ends (Stripe charges then; a manual trial ends). */
  trialEndsAt: EpochSeconds.nullable(),
  /** The end of the current period (for a trial, the trial end). Null for a plan without a period. */
  currentPeriodEnd: EpochSeconds.nullable(),
  /** The subscription ends at `currentPeriodEnd` (cancelled in the portal, or during the trial). */
  cancelAtPeriodEnd: z.boolean(),
  whombats: z.object({
    /** Claimed Whombats (live claimed devices). */
    claimed: z.number().int().min(0).max(10_000),
    /** Whombats paid for (`devicesAllowed`). */
    paid: z.number().int().min(0).max(10_000),
  }),
  /** Waiting for a plan (BL-13): claims and cohort opt-in answer `billing_setup_required`. */
  setupRequired: z.boolean(),
  /** Checkout would include the trial days (BL-17); otherwise the UI says “Subscribe”. */
  trialAvailable: z.boolean(),
  /** The plan is managed by Whombat (manual provider or an operator's plan): no checkout, portal or Whombats buttons. */
  manual: z.boolean(),
});
export type BillingView = z.infer<typeof BillingView>;

export const BillingCheckoutBody = z.strictObject({ plan: PlanId, whombats: BillingWhombats });
export type BillingCheckoutBody = z.infer<typeof BillingCheckoutBody>;

export const BillingWhombatsBody = z.strictObject({ count: BillingWhombats });
export type BillingWhombatsBody = z.infer<typeof BillingWhombatsBody>;

/** A Stripe-hosted page (Checkout, Customer Portal) the browser goes to. */
export const BillingRedirect = z.object({
  url: z
    .string()
    .min(10)
    .max(2048)
    .regex(/^https?:\/\/[\x21-\x7e]+$/),
});
export type BillingRedirect = z.infer<typeof BillingRedirect>;

export const billingApi = {
  entitlement: controlEndpoint({
    id: 'billing.entitlement',
    method: 'GET',
    path: '/orgs/:org/entitlement',
    auth: 'session',
    summary: 'The org’s plan and which cloud services it covers.',
    response: Entitlement,
  }),
  view: controlEndpoint({
    id: 'billing.view',
    method: 'GET',
    path: '/orgs/:org/billing',
    auth: 'session',
    summary: 'The org’s subscription for the Billing page (BL-17, BL-18).',
    response: BillingView,
  }),
  checkout: controlEndpoint({
    id: 'billing.checkout',
    method: 'POST',
    path: '/orgs/:org/billing/checkout',
    auth: 'session',
    summary:
      'A Stripe Checkout Session for a public plan × `whombats` (with the trial days when the org may trial, BL-15, BL-17). Refuses `subscription_exists` (409: use the portal), `manual_billing` (409: manual provider), `plan_unavailable` (400: unknown or not public), `billing_provider_error` (503).',
    body: BillingCheckoutBody,
    response: BillingRedirect,
  }),
  portal: controlEndpoint({
    id: 'billing.portal',
    method: 'POST',
    path: '/orgs/:org/billing/portal',
    auth: 'session',
    summary:
      'A Stripe Customer Portal session (cards, invoices, switching plan, cancelling at period end; BL-18). Refuses `no_subscription` (409: no Stripe customer yet), `manual_billing` (409).',
    body: z.strictObject({}),
    response: BillingRedirect,
  }),
  whombats: controlEndpoint({
    id: 'billing.whombats',
    method: 'POST',
    path: '/orgs/:org/billing/whombats',
    auth: 'session',
    summary:
      'Change the number of Whombats paid for (with prorations; applied at once, BL-18). Refuses `whombats_below_claimed` (409: fewer than the claimed Whombats), `no_subscription` (409), `manual_billing` (409).',
    body: BillingWhombatsBody,
    response: BillingView,
  }),
  startNow: controlEndpoint({
    id: 'billing.startNow',
    method: 'POST',
    path: '/orgs/:org/billing/start-now',
    auth: 'session',
    summary:
      'End the trial now so the subscription starts and is charged today (after `trial_used_device`, BL-17). Refuses `manual_billing` (409: an operator sets a plan instead), `not_trialing` (409), `no_subscription` (409).',
    body: z.strictObject({}),
    response: BillingView,
  }),
};
