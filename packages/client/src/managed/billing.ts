/**
 * Billing and signups as the hosted UI shows them (BL-13, BL-15…BL-18, BL-21…BL-25; AP-122…): plan cards, the state
 * line, which Billing page to show, where a new organization goes next, the checkout poll, the words of refusals, the
 * claim refusals that have an action, and the invite code a `/signup#code=` link carries. Pure: the web renders it,
 * the phone only uses the words of claim refusals (billing lives on the web, AP-130).
 */
import {
  type BillingView,
  ControlError,
  type ControlErrorCode,
  devicesAllowedOf,
  type SignupInfo,
  type SignupPlan,
} from './control';
import { COPY } from './copy';
import { licenceDay } from './licence';

const B = COPY.billing;

/* Prices and plans ------------------------------------------------------------------------------------------ */

/** “€49”, “€149”, “€1,490”, “€49.50”: whole euros without cents (BL-02 prices are whole). */
export function formatEuro(cents: number): string {
  const whole = cents % 100 === 0;
  return `€${new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100)}`;
}

export interface PlanCardText {
  name: string;
  /** “€49 per Whombat a month” */
  price: string;
  /**
   * “Unlimited connectors” (no agent count: a Whombat has one agent, one-agent.md OA-02, AP-4906; no people count: a
   * Whombat is one person's, Whombat one-person.md OP-11)
   */
  extras: string;
}

/** A plan card (the Billing page's “Whombat · €49 per Whombat a month”, “Unlimited connectors”). */
export function planCardText(plan: Pick<SignupPlan, 'name' | 'amountCents' | 'limits'>): PlanCardText {
  const { connectors } = plan.limits;
  const extras = connectors === null ? B.unlimitedConnectors : B.connectors(connectors);
  return { name: plan.name, price: B.perWhombat(formatEuro(plan.amountCents)), extras };
}

/** “Total €98 a month” for `whombats` of the plan (excluding VAT, which the fine print says). */
export function planTotalText(plan: Pick<SignupPlan, 'amountCents'>, whombats: number): string {
  return B.total(formatEuro(plan.amountCents * whombats));
}

/** The Whombats stepper's range at checkout and later (BL-15, BL-18). */
export const BILLING_WHOMBATS_MIN = 1;
export const BILLING_WHOMBATS_MAX = 50;

export function clampWhombats(n: number): number {
  if (!Number.isFinite(n)) return BILLING_WHOMBATS_MIN;
  return Math.min(BILLING_WHOMBATS_MAX, Math.max(BILLING_WHOMBATS_MIN, Math.round(n)));
}

/* The Billing page ------------------------------------------------------------------------------------------- */

/**
 * Which Billing page to show (the org's one account reads and acts on its billing, CT-1561):
 * - `choose`: waiting for a plan (BL-13), or a Stripe subscription that ended: the plan cards;
 * - `manual`: a plan Whombat manages (a manual trial or an operator's plan): no buttons;
 * - `subscribed`: a Stripe subscription (trial, active, payment problem).
 */
export type BillingPage = 'choose' | 'manual' | 'subscribed';

export function billingPageOf(view: BillingView): BillingPage {
  if (view.manual) return 'manual';
  if (view.setupRequired || view.state === 'cancelled') return 'choose';
  return 'subscribed';
}

/**
 * The state line: “Trial · ends 11 October 2026”, “Active · renews 1 November 2026” (“Active · ends …” once cancelled
 * at the period end), “Payment problem”, “Ended”. A plan without a period says just “Active” or “Trial”.
 */
export function billingStateLine(
  view: Pick<BillingView, 'state' | 'trialEndsAt' | 'currentPeriodEnd' | 'cancelAtPeriodEnd'>,
  timeZone?: string,
): string {
  const day = (s: number) => licenceDay(new Date(s * 1000).toISOString(), timeZone);
  switch (view.state) {
    case 'trialing': {
      const end = view.trialEndsAt ?? view.currentPeriodEnd;
      return end === null ? B.trial : B.trialEnds(day(end));
    }
    case 'active':
      if (view.currentPeriodEnd === null) return B.active;
      return view.cancelAtPeriodEnd
        ? B.ends(day(view.currentPeriodEnd))
        : B.renews(day(view.currentPeriodEnd));
    case 'past_due':
    case 'grace':
      return B.paymentProblem;
    case 'cancelled':
      return B.ended;
  }
}

/** The status dot next to the state line. */
export function billingTone(view: Pick<BillingView, 'state'>): 'ok' | 'warn' | 'bad' {
  if (view.state === 'past_due' || view.state === 'grace') return 'warn';
  return view.state === 'cancelled' ? 'bad' : 'ok';
}

/** A subscription shows (the webhook arrived, BL-16): no longer waiting for a plan, and not the one that ended. */
export function subscriptionShows(view: Pick<BillingView, 'setupRequired' | 'state'>): boolean {
  return !view.setupRequired && view.state !== 'cancelled';
}

/** `?checkout=done` polls `billing.view` every 2 s for up to 60 s (webhooks can lag). */
export const CHECKOUT_POLL_EVERY_MS = 2_000;
export const CHECKOUT_POLL_FOR_MS = 60_000;

/** After a poll: the subscription shows (`done`), ask again (`wait`), or stop asking and say so (`timeout`). */
export function checkoutPollStep(
  view: Pick<BillingView, 'setupRequired' | 'state'> | null,
  elapsedMs: number,
): 'done' | 'wait' | 'timeout' {
  if (view && subscriptionShows(view)) return 'done';
  return elapsedMs + CHECKOUT_POLL_EVERY_MS > CHECKOUT_POLL_FOR_MS ? 'timeout' : 'wait';
}

/** Room for another claim: the subscription pays for more Whombats than are claimed. */
export function canClaimMore(view: Pick<BillingView, 'whombats' | 'setupRequired' | 'state'>): boolean {
  return subscriptionShows(view) && view.whombats.claimed < view.whombats.paid;
}

/* Where a new organization goes (AP-126) ------------------------------------------------------------------- */

/**
 * After creating an org: with Stripe billing and a plan still to choose, Billing first (BL-13), then the claim;
 * otherwise on to the claim (when the Whombat's screen sent them to `/claim`) or the list.
 */
export function afterCreateOrgPath(input: {
  billing: SignupInfo['billing'] | null;
  view: Pick<BillingView, 'setupRequired'> | null;
  from: string;
}): string {
  if (input.billing === 'stripe' && input.view?.setupRequired) return '/billing';
  return input.from === '/claim' ? '/claim' : '/appliances';
}

/** The Whombats list says “Choose a plan to claim your first Whombat.” and doesn't look for one nearby (BL-13). */
export function needsPlan(view: Pick<BillingView, 'setupRequired'> | null): boolean {
  return !!view?.setupRequired;
}

/* Words of refusals ------------------------------------------------------------------------------------------ */

export type CreateOrgErrorKey = keyof typeof COPY.org.errors;

export function createOrgErrorKey(error: unknown): CreateOrgErrorKey {
  if (!(error instanceof ControlError)) return 'failed';
  const known: readonly ControlErrorCode[] = [
    'signup_code_required',
    'signup_code_invalid',
    'terms_outdated',
    'rate_limited',
    'unavailable',
  ];
  return known.includes(error.code) ? (error.code as CreateOrgErrorKey) : 'failed';
}

export type BillingErrorKey = keyof typeof B.errors;

export function billingErrorKey(error: unknown): BillingErrorKey {
  if (!(error instanceof ControlError)) return 'failed';
  const code = error.code as string;
  return code in B.errors ? (code as BillingErrorKey) : 'failed';
}

export function billingErrorText(error: unknown): string {
  return B.errors[billingErrorKey(error)];
}

/* Where Checkout and the portal may send the browser (AP-160) ------------------------------------------------ */

/** Stripe's hosted Checkout and customer portal: the only hosts `billing.checkout` / `billing.portal` send to. */
export const STRIPE_REDIRECT_HOSTS: readonly string[] = ['checkout.stripe.com', 'billing.stripe.com'];

/**
 * The URL control answered for Checkout or the portal, when the browser may go there: `https:` on one of Stripe's
 * hosts (default port, no credentials), or on one of `alsoOrigins` (the fake world's own page in development and e2e;
 * the real environment passes none). Anything else is null: the page shows its billing error and stays.
 */
export function billingRedirectUrl(url: string, alsoOrigins: readonly string[] = []): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === 'https:' && STRIPE_REDIRECT_HOSTS.includes(u.host)) return u.href;
  if (u.origin !== 'null' && alsoOrigins.includes(u.origin)) return u.href;
  return null;
}

export function waitlistErrorText(error: unknown): string {
  const t = COPY.waitlist.errors;
  if (!(error instanceof ControlError)) return t.failed;
  if (error.code === 'waitlist_closed' || error.code === 'rate_limited' || error.code === 'unavailable')
    return t[error.code];
  // A body the contract refuses: the only field people type that can be wrong is the email.
  if (error.code === 'invalid_link') return t.badEmail;
  return t.failed;
}

/* Claim refusals with an action (BL-13, BL-17, BL-18) --------------------------------------------------------- */

export type ClaimRefusal =
  /** Waiting for a plan: go to Billing. */
  | { kind: 'billing' }
  /** The Whombat had a trial in another org: start the subscription now (when `canStartNow`), then claim again. */
  | { kind: 'trial_used'; canStartNow: boolean }
  /** The plan covers no more Whombats: “Your plan covers {n} Whombats.” and Add a Whombat. */
  | { kind: 'plan_full'; allowed: number | null };

export function claimRefusalOf(error: unknown): ClaimRefusal | null {
  if (!(error instanceof ControlError)) return null;
  if (error.code === 'billing_setup_required') return { kind: 'billing' };
  if (error.code === 'trial_used_device')
    // An older control without `details` still means it (CT-108 made the member optional): offer it.
    return { kind: 'trial_used', canStartNow: error.details.canStartNow !== false };
  if (error.code === 'devices_allowed_reached')
    return { kind: 'plan_full', allowed: devicesAllowedOf(error) };
  return null;
}

/* Invite codes (BL-22) ----------------------------------------------------------------------------------------- */

/**
 * The code a `/signup#code=XXXX-XXXX` link carries, as typed (at most 64 characters), or null. Only the fragment is
 * read, so the code never reaches a server log; the caller takes it out of the address bar at once.
 */
export function readSignupFragment(loc: Pick<Location, 'pathname' | 'hash'>): string | null {
  if (loc.pathname !== '/signup' || !loc.hash) return null;
  let code: string | null;
  try {
    code = new URLSearchParams(loc.hash.slice(1)).get('code');
  } catch {
    return null;
  }
  const typed = code?.trim() ?? '';
  return typed && typed.length <= 64 ? typed : null;
}

/** The one-time sign-in an emailed invitation's link carries next to its code, and the address it is for. */
export interface InvitationSignIn {
  token: string;
  /** Only for the page to show and compare; the token alone decides who is signed in. */
  email: string | null;
}

/**
 * The invitation's sign-in from a `/signup#code=…&token=…&email=…` link, or null. Like the code, it is read from the
 * fragment only and taken out of the address bar at once.
 */
export function readInvitationSignIn(loc: Pick<Location, 'pathname' | 'hash'>): InvitationSignIn | null {
  if (loc.pathname !== '/signup' || !loc.hash) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(loc.hash.slice(1));
  } catch {
    return null;
  }
  const token = params.get('token') ?? '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const email = params.get('email')?.trim().toLowerCase() ?? '';
  return { token, email: email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null };
}

/** What the create-org screen shows for the signup mode (BL-21, AP-124). */
export interface CreateOrgForm {
  /** The waitlist form instead (waitlist mode, no code yet, and “I have an invite code” not chosen). */
  waitlist: boolean;
  /** The invite code field. */
  showCode: boolean;
  /** The code must be filled in before Continue. */
  codeRequired: boolean;
  /** “Whombat is invite-only for now. Enter your invite code.” */
  inviteOnly: boolean;
}

export function createOrgForm(
  info: Pick<SignupInfo, 'mode'> | null,
  input: { heldCode: boolean; wantsCode: boolean },
): CreateOrgForm {
  const mode = info?.mode ?? 'open';
  if (mode === 'open')
    // A code is still accepted in open mode (it may carry a plan): the field shows when a link brought one.
    return { waitlist: false, showCode: input.heldCode, codeRequired: false, inviteOnly: false };
  if (mode === 'invite') return { waitlist: false, showCode: true, codeRequired: true, inviteOnly: true };
  const coded = input.heldCode || input.wantsCode;
  return { waitlist: !coded, showCode: coded, codeRequired: coded, inviteOnly: false };
}

/**
 * `?checkout=done` (BL-16, AP-131): asks `load` every 2 s until the subscription shows or a minute went by. Each view
 * goes to `onView`; a failed ask counts as “not yet”. `live` stops it (the page was left).
 */
export async function pollCheckout(input: {
  load: () => Promise<BillingView>;
  onView: (view: BillingView) => void;
  live?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<'done' | 'timeout' | 'stopped'> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const live = input.live ?? (() => true);
  const started = now();
  for (;;) {
    const view = await input.load().catch(() => null);
    if (!live()) return 'stopped';
    if (view) input.onView(view);
    const step = checkoutPollStep(view, now() - started);
    if (step !== 'wait') return step;
    await sleep(CHECKOUT_POLL_EVERY_MS);
    if (!live()) return 'stopped';
  }
}
