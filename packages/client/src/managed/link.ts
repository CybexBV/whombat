/**
 * Whombat Link on the account site (Whombat whombat-link.md LNK-06, LNK-13, LNK-32…LNK-35, one-environment.md; app
 * link-account-site.md): the words of the `/link` page and of Your Whombats, the plan's and each Whombat's Link state in
 * plain words, its price by the month or the year and its free time, the Whombats in the order this device opened them,
 * the notice while Link ends, the code a link carries, and the poll after Stripe Checkout. Pure: only the web shows
 * these (the phone shows no price and no sign-up, LNK-44).
 */

import { LINK_COUNTRIES, linkSoldIn } from '@whombat/control-contracts';
import {
  LINK_PRICE_TEXT,
  LINK_PRICE_YEAR_TEXT,
  LINK_TRIAL_BOXES_MAX,
  type LinkState,
  normalizeLinkCode,
} from '@whombat/protocol';
import {
  ControlError,
  type ControlOrg,
  type LinkAccount,
  type LinkCheckoutInput,
  type LinkedBox,
  type LinkInterval,
} from './control';
import { licenceDay } from './licence';

export const WHOMBAT_LINK_TEXT = {
  kicker: 'WHOMBAT LINK',
  tip: 'Whombat Link lets you reach your Whombat from anywhere. Everything you keep stays on your Whombat.',
  /** The price lines, from the contracts' constants: both ways to pay, or the one the subscription has. */
  price: `${LINK_PRICE_TEXT} or ${LINK_PRICE_YEAR_TEXT} for each Whombat, VAT included.`,
  priceMonth: `${LINK_PRICE_TEXT} for each Whombat, VAT included.`,
  paidMonth: `You pay ${LINK_PRICE_TEXT} for each Whombat, VAT included.`,
  paidYear: `You pay ${LINK_PRICE_YEAR_TEXT} for each Whombat, VAT included.`,
  trial: 'Your first month is free. No card needed.',
  /** Free time from Whombat or a promotion code (`LinkPlan.discount`). */
  freeUntil: (day: string) => `Free until ${day}`,
  freeForGood: 'Free for good',
  offUntil: (percent: number, day: string) => `${percent}% off until ${day}`,
  offForGood: (percent: number) => `${percent}% off for good`,
  withCode: (line: string, code: string) => `${line}, with the code ${code}`,
  fromCode: (code: string) => `With the code ${code}`,
  /** During free time with a card on file: what it costs once the free time is over. */
  thenFrom: (price: string, day: string) => `Then ${price} for each Whombat from ${day}, VAT included.`,
  /** Checkout by the month or the year, chosen here; a promotion code goes in the payment page's own field. */
  interval: 'How to pay',
  month: LINK_PRICE_TEXT,
  year: LINK_PRICE_YEAR_TEXT,
  haveCode: 'Have a code? Enter it on the payment page.',
  /**
   * Where the person lives, asked before the payment page opens: Link is sold in EU countries only for now
   * (`LINK_COUNTRIES`, control's `link_country`). A business adds its VAT number on the payment page.
   */
  country: 'Where you live',
  countryChoose: 'Choose your country',
  countryOther: 'Another country',
  countryOutside:
    'Whombat Link is only sold in EU countries for now. Your Whombat keeps working at home without it.',
  vatNumber: 'Buying for a business? Add your VAT number on the payment page.',
  /**
   * No Whombat linked: nothing to pay for yet (control answers `link_no_boxes`). The free month starts when the first
   * Whombat is linked, never with Subscribe.
   */
  needsBox: 'Add a Whombat to start your free month.',
  needsBoxAgain: 'Add a Whombat first, then subscribe.',
  /** A payment page this browser opened is still open: the same interval answers it again. */
  backToPage: (price: string) => `Back to the payment page (${price})`,
  /** The Subscription Terms ticked before a Whombat joins (`link.confirm`). */
  termsAgree: 'I agree to the',
  termsLink: 'Whombat Subscription Terms',

  /* `/link` */
  linkTitle: 'Add your Whombat',
  linkSub: 'Enter the code your Whombat shows on its screen.',
  signedOutSub:
    'Enter the code your Whombat shows on its screen and your email address. We email you a link to sign in, or to make your account.',
  code: 'Code from its screen',
  codeHint: 'Like ABCD-EFGH. It changes every 15 minutes.',
  email: 'Email',
  send: 'Email me a link',
  sentTitle: 'Check your email',
  sent: (email: string) => `We sent a link to ${email}. Open it on this device to carry on.`,
  again: 'Use another address',
  find: 'Continue',
  finding: 'Checking…',
  alreadyTitle: (name: string) => `${name} is already in your account`,
  yourWhombat: 'your Whombat',
  yourWhombatTitle: 'Your Whombat',
  /**
   * A box not named yet (an Easy box links at its first start, before its setup asks for a name): the code on its
   * screen is what tells the person which one this is.
   */
  showing: (code: string) => `It’s the Whombat whose screen shows ${code}.`,
  what: 'You can open it from anywhere, get its notifications on your phone, and it gets its own web address.',
  joins: 'It joins your subscription.',
  needsPlan: 'It turns on once you subscribe.',
  confirm: 'Add it',
  confirming: 'Adding…',
  otherCode: 'Use another code',
  doneTitle: (name: string) => `${name} is added`,
  doneNext: 'It gets its own address in a moment. Its screen then shows where to open it.',
  doneNeedsPlan: 'It turns on once you subscribe to Whombat Link.',
  /**
   * After linking, the page waits for the Whombat's own address, then opens its page by itself (`pollLinkAddress`):
   * the person types only the letters its screen shows there. While it waits, what it is doing now, step by step.
   */
  addressWaiting: 'Getting your Whombat ready to open from anywhere. This usually takes a minute or two.',
  addressOpening: 'Opening your Whombat’s page…',
  addressOpen: 'Its web address is ready.',
  addressSlow: 'This is taking longer than usual. Its screen shows where to open it once it’s ready.',
  /** The wait, step by step: linked, its web address, its page answering. */
  progress: {
    linked: 'Added to your account',
    address: 'Getting its web address',
    page: 'Waiting for its page to answer',
    open: 'Opening its page',
  },
  /** Only when the page didn't open by itself. */
  openNotYet: 'Didn’t open? Use the button.',
  claimNow: 'Claim it now',
  toAccount: 'Your Whombats',

  /* Your Whombats */
  accountTitle: 'Your Whombats',
  accountSub: 'Your Whombat Link and the Whombats it covers.',
  plan: 'Whombat Link',
  planNone: 'Not subscribed',
  planTrial: (day: string) => `Free month · until ${day}`,
  planRenews: (day: string) => `Active · renews ${day}`,
  /**
   * The subscription ends at its period's end: cancelled in the portal, or ended for Link with no Whombat billed. Who
   * ended it isn't said; linking a Whombat again doesn't resume it, only the portal does (control CL-238).
   */
  endsOn: (day: string) => `Your Whombat Link ends on ${day}. Resume it in Manage subscription.`,
  endsSoon: 'Your Whombat Link is set to end. Resume it in Manage subscription.',
  planActive: 'Active',
  planPastDue: 'Payment problem',
  planEnded: 'Ended',
  planIncluded: 'Included',
  subscribe: 'Subscribe',
  addCard: 'Add a card',
  manage: 'Manage subscription',
  subscribeAgain: 'Subscribe again',
  opening: 'Opening…',
  noBoxes: 'No Whombats yet. Your Whombat’s screen shows a code: add it here with that code.',
  boxOn: 'On',
  boxIncluded: 'On · Included',
  boxTrial: (day: string) => `Free month · until ${day}`,
  boxEnds: (day: string) => `Ends ${day}`,
  boxEnded: 'Ended',
  boxStarting: 'Getting its address…',
  boxOff: 'Off',
  /** Each Whombat opens at its own address, in this tab. */
  open: 'Open',
  openName: (name: string) => `Open ${name}`,
  remove: 'Remove',
  removeLabel: (name: string) => `Remove ${name} from Whombat Link`,
  removeConfirm: (name: string) =>
    `Remove ${name} from Whombat Link? It keeps working at home, but you can’t open it from elsewhere without Tailscale.`,
  removeIt: 'Remove it',
  removing: 'Removing…',
  cancel: 'Cancel',
  graceNotice: (day: string) =>
    `Whombat Link ends on ${day}. Subscribe to keep reaching your Whombat from anywhere, or turn on Tailscale on your Whombat.`,
  endedNotice:
    'Whombat Link has ended. Your Whombat keeps working at home. Subscribe again to reach it from anywhere.',
  pastDueNotice: 'Your last payment didn’t go through. Update your card in Manage subscription.',
  trialFull: `You can link ${LINK_TRIAL_BOXES_MAX} Whombats during the free month. Add a card to link more.`,
  subscribed: 'You’re subscribed to Whombat Link.',
  settingUp: 'Setting up your subscription…',
  slow: 'This is taking longer than usual. Your subscription shows here as soon as it’s ready.',
  checkAgain: 'Check again',
  loadFailed: 'Couldn’t load your Whombats. Check your connection and try again.',
  retry: 'Try again',
  linkEntry: 'Add a Whombat',
  openHere: 'Open a Whombat here',
  /** The older Whombats list's way to this page. */
  entry: 'Whombat Link',
  /** A claim at this site refused because the organization has no plan (its business plans went with Link). */
  claimNoPlan: 'Your organization has no plan any more. Ask Whombat support.',
  errors: {
    badCode: 'Enter the 8 letters from its screen, like ABCD-EFGH.',
    link_code_invalid: 'That code doesn’t work. Check the code on your Whombat’s screen.',
    link_other_account: 'This Whombat belongs to another Whombat account.',
    email_unconfirmed: 'Confirm your email address first: open the link we emailed you.',
    link_trial_boxes: `You can link ${LINK_TRIAL_BOXES_MAX} Whombats during the free month. Add a card to link more.`,
    link_subscribe: 'Your Whombat Link has stopped. Subscribe to add this Whombat.',
    terms_outdated: 'The Whombat Subscription Terms have changed. Reload this page, then try again.',
    terms_required: 'Agree to the Whombat Subscription Terms first.',
    promotion_code_invalid: 'That code doesn’t work. Check it, or leave it empty.',
    checkout_busy: 'Try again in a moment.',
    link_no_boxes: 'Add a Whombat first, then subscribe.',
    link_country:
      'Whombat Link is only sold in EU countries for now. Your Whombat keeps working at home without it.',
    promotion_code_on_payment_page: 'Enter the code on the payment page: it has a field for it.',
    billing_provider_refused: 'Our payment provider refused this. Try again later, or ask Whombat support.',
    manual_billing: 'Your Whombat Link is free: there’s nothing to pay.',
    no_subscription: 'There’s no subscription to manage yet.',
    billing_provider_error: 'Our payment provider didn’t answer. Try again later.',
    not_found: 'That Whombat isn’t in your Whombat Link any more.',
    rate_limited: 'Too many tries. Wait a few minutes, then try again.',
    unavailable: 'Couldn’t reach Whombat. Check your connection and try again.',
    failed: 'That didn’t work. Try again.',
  },
} as const;

const T = WHOMBAT_LINK_TEXT;

export type LinkAccountErrorKey = Exclude<keyof typeof T.errors, 'badCode'>;

/** Which words a refusal on the Link pages gets. */
export function linkAccountErrorKey(error: unknown): LinkAccountErrorKey {
  if (!(error instanceof ControlError)) return 'failed';
  const code = error.code as string;
  return code in T.errors && code !== 'badCode' ? (code as LinkAccountErrorKey) : 'failed';
}

export function linkAccountErrorText(error: unknown): string {
  return T.errors[linkAccountErrorKey(error)];
}

/** The code a link to `/link` carries (`?code=ABCD-EFGH`, what the box's screen may show), normalised; else null. */
export function linkCodeOf(search: string): string | null {
  const raw = new URLSearchParams(search).get('code');
  return raw ? normalizeLinkCode(raw) : null;
}

/**
 * The page that adds a Whombat, keeping a code (the sign-in link's `next`): `/add`. The box's screen still shows `/link`,
 * which opens the same page.
 */
export function linkPagePath(code: string | null): string {
  return code ? `/add?code=${code}` : '/add';
}

const day = (s: number, timeZone?: string) => licenceDay(new Date(s * 1000).toISOString(), timeZone);

type Plan = LinkAccount['plan'];

/** The plan's line: “Free month · until 18 December 2026”, “Active · renews …”, “Included”, “Ended”. */
export function linkPlanLine(plan: Plan, timeZone?: string): string {
  const free = linkFreeTime(plan);
  // Set to end at the period's end, whoever ended it: said first, with the way back (the portal).
  if (linkEnding(plan))
    return plan.currentPeriodEnd === null ? T.endsSoon : T.endsOn(day(plan.currentPeriodEnd, timeZone));
  switch (plan.state) {
    case 'none':
      return T.planNone;
    case 'trialing': {
      if (free === 'forever') return T.freeForGood;
      if (free?.grant) return T.freeUntil(day(free.until, timeZone));
      const end = plan.trialEndsAt ?? plan.currentPeriodEnd;
      return end === null ? T.trial : T.planTrial(day(end, timeZone));
    }
    case 'active':
      if (free === 'forever') return T.freeForGood;
      if (free) return T.freeUntil(day(free.until, timeZone));
      if (plan.currentPeriodEnd === null) return T.planActive;
      return T.planRenews(day(plan.currentPeriodEnd, timeZone));
    case 'past_due':
      return T.planPastDue;
    case 'cancelled':
      return T.planEnded;
    case 'comp':
      return T.planIncluded;
  }
}

export function linkPlanTone(plan: Pick<Plan, 'state' | 'cancelAtPeriodEnd'>): 'ok' | 'warn' | 'bad' | 'mut' {
  if (plan.state === 'none') return 'mut';
  if (plan.state === 'past_due' || plan.cancelAtPeriodEnd) return 'warn';
  return plan.state === 'cancelled' ? 'bad' : 'ok';
}

/** The running subscription is set to end at its period's end (`cancelAtPeriodEnd`): only the portal resumes it. */
export function linkEnding(plan: Pick<Plan, 'state'> & Partial<Pick<Plan, 'cancelAtPeriodEnd'>>): boolean {
  return (
    plan.cancelAtPeriodEnd === true &&
    (plan.state === 'trialing' || plan.state === 'active' || plan.state === 'past_due')
  );
}

/**
 * What the plan's button does: Subscribe (none yet), Add a card (the free month or free time, nothing in Stripe yet),
 * Manage (a Stripe subscription with a card: the portal), Subscribe again (ended), or nothing (Included). Only a card on
 * file opens the portal; everything before it is Checkout, which answers `subscription_exists` when Stripe has one after
 * all, so the page then opens the portal. An older control doesn't say whether a card is on file: its paying states
 * still open the portal.
 */
export type LinkPlanAction = 'subscribe' | 'addCard' | 'manage' | 'subscribeAgain' | null;

export function linkPlanAction(
  plan: Pick<Plan, 'state' | 'cardOnFile'> & Partial<Pick<Plan, 'cancelAtPeriodEnd'>>,
): LinkPlanAction {
  // A subscription set to end is resumed in the portal only: never Checkout, never a Whombat linked again.
  if (linkEnding(plan)) return 'manage';
  switch (plan.state) {
    case 'none':
      return 'subscribe';
    case 'trialing':
      return plan.cardOnFile ? 'manage' : 'addCard';
    case 'active':
    case 'past_due':
      return plan.cardOnFile === false ? 'addCard' : 'manage';
    case 'cancelled':
      return 'subscribeAgain';
    case 'comp':
      return null;
  }
}

export function linkPlanActionText(action: Exclude<LinkPlanAction, null>): string {
  return { subscribe: T.subscribe, addCard: T.addCard, manage: T.manage, subscribeAgain: T.subscribeAgain }[
    action
  ];
}

/** One Whombat's Link in plain words: on, free month until …, ends on …, ended, getting its address. */
export function linkBoxLine(
  box: Pick<LinkedBox, 'state' | 'graceEndsAt'>,
  plan: FreePlan & Pick<Plan, 'cancelAtPeriodEnd'>,
  timeZone?: string,
): string {
  return linkStateLine(box.state, box.graceEndsAt, plan, timeZone);
}

function linkStateLine(
  state: LinkState,
  graceEndsAt: number | null,
  plan: FreePlan & Pick<Plan, 'cancelAtPeriodEnd'>,
  timeZone?: string,
): string {
  switch (state) {
    case 'on': {
      if (plan.state === 'comp') return T.boxIncluded;
      // A cancelled subscription ends when its period does; the free month says its own end.
      const ends = plan.cancelAtPeriodEnd && plan.currentPeriodEnd !== null;
      if (ends && plan.state !== 'trialing') return T.boxEnds(day(plan.currentPeriodEnd as number, timeZone));
      const free = linkFreeTime(plan);
      if (free === 'forever') return T.freeForGood;
      if (free)
        return free.grant ? T.freeUntil(day(free.until, timeZone)) : T.boxTrial(day(free.until, timeZone));
      return ends ? T.boxEnds(day(plan.currentPeriodEnd as number, timeZone)) : T.boxOn;
    }
    case 'grace':
      return graceEndsAt === null ? T.boxEnded : T.boxEnds(day(graceEndsAt, timeZone));
    case 'ended':
      return T.boxEnded;
    case 'starting':
      return T.boxStarting;
    case 'off':
      return T.boxOff;
  }
}

export function linkBoxTone(box: Pick<LinkedBox, 'state'>): 'ok' | 'warn' | 'bad' | 'mut' {
  if (box.state === 'on') return 'ok';
  if (box.state === 'grace' || box.state === 'starting') return 'warn';
  return box.state === 'ended' ? 'bad' : 'mut';
}

/**
 * What the page says above everything while Link is ending (LNK-06): in grace, until when and how to keep it; ended,
 * how to get it back; a failed payment, where to fix it. Null otherwise.
 */
export function linkNotice(account: LinkAccount, timeZone?: string): string | null {
  const grace = account.boxes
    .filter((b) => b.state === 'grace' && b.graceEndsAt !== null)
    .map((b) => b.graceEndsAt as number)
    .sort((a, b) => a - b)[0];
  if (grace !== undefined) return T.graceNotice(day(grace, timeZone));
  if (account.boxes.some((b) => b.state === 'ended')) return T.endedNotice;
  if (account.plan.state === 'past_due') return T.pastDueNotice;
  return null;
}

/**
 * Control takes `interval` at checkout and says the subscription's interval and discount (contracts 4.6): such a control
 * always sends `discount`, null when there is none. An older one sends neither and refuses `interval`, so the page then
 * offers the month only.
 */
export function linkYearly(plan: Pick<Plan, 'discount'>): boolean {
  return plan.discount !== undefined;
}

type FreePlan = Pick<Plan, 'state' | 'trialEndsAt' | 'currentPeriodEnd' | 'discount'>;

/**
 * Until when Link costs nothing: the free month's end, or the end of free time (a 100% discount, `grant`); `forever`
 * for free time without an end; null while it is paid for. A plain free month carries no discount, so a finite 100%
 * discount is free time even when its end is the trial's own: control stretches the Stripe trial to the grant's end,
 * so `trialEndsAt` and `discount.endsAt` are then the same second.
 */
export function linkFreeTime(plan: FreePlan): { until: number; grant: boolean } | 'forever' | null {
  const trialEnd = plan.state === 'trialing' ? (plan.trialEndsAt ?? plan.currentPeriodEnd) : null;
  const d = plan.discount;
  const running = plan.state === 'trialing' || plan.state === 'active' || plan.state === 'past_due';
  if (running && d?.percentOff === 100) {
    if (d.endsAt === null) return 'forever';
    if (trialEnd === null || d.endsAt >= trialEnd) return { until: d.endsAt, grant: true };
  }
  return trialEnd === null ? null : { until: trialEnd, grant: false };
}

/** The price of the plan's interval (month or year), or both ways where control takes both. */
function intervalPrice(plan: Pick<Plan, 'interval' | 'discount'>): string {
  if (plan.interval === 'year') return LINK_PRICE_YEAR_TEXT;
  if (plan.interval === 'month') return LINK_PRICE_TEXT;
  return linkYearly(plan) ? `${LINK_PRICE_TEXT} or ${LINK_PRICE_YEAR_TEXT}` : LINK_PRICE_TEXT;
}

/**
 * The plan's price line, never as if the full price were charged during free time: free for good, none; free time with
 * a card on file, the price that follows (“Then €25 a year for each Whombat from 19 May 2027, VAT included.”); free
 * time without a card (it ends unless one is added), what Link costs; paid, what the subscription pays.
 */
export function linkPriceLine(
  plan: FreePlan & Pick<Plan, 'interval' | 'cardOnFile'>,
  timeZone?: string,
): string | null {
  const free = linkFreeTime(plan);
  if (free === 'forever') return null;
  if (free && plan.cardOnFile) return T.thenFrom(intervalPrice(plan), day(free.until, timeZone));
  if (free || !plan.interval) return linkYearly(plan) ? T.price : T.priceMonth;
  return plan.interval === 'year' ? T.paidYear : T.paidMonth;
}

/**
 * A discount the plan line doesn't already say: a code's free time (“With the code FRIENDS”), part off (“50% off until
 * …, with the code X”). Free time from Whombat is the plan line itself.
 */
export function linkDiscountLine(plan: Pick<Plan, 'discount'>, timeZone?: string): string | null {
  const d = plan.discount;
  if (!d) return null;
  if (d.percentOff === 100) return d.code ? T.fromCode(d.code) : null;
  const line =
    d.endsAt === null ? T.offForGood(d.percentOff) : T.offUntil(d.percentOff, day(d.endsAt, timeZone));
  return d.code ? T.withCode(line, d.code) : line;
}

/** Where a Whombat opens (`https://<host>/`), while its address works: Link on, or still in its last week. */
export function linkBoxOpenUrl(box: Pick<LinkedBox, 'host' | 'state'>): string | null {
  if (!box.host || (box.state !== 'on' && box.state !== 'grace')) return null;
  return `https://${box.host}/`;
}

/** The account's Whombats with the one this device opened last first, the rest in control's order. */
export function linkBoxesInOrder<B extends Pick<LinkedBox, 'device'>>(
  boxes: readonly B[],
  lastOpened: string | null,
): B[] {
  const last = boxes.find((b) => b.device === lastOpened);
  return last ? [last, ...boxes.filter((b) => b !== last)] : [...boxes];
}

/**
 * What Checkout is sent: the interval only to a control that takes it (one that says `discount`), the terms when the
 * person ticked them (asked only after control said `terms_required`, or at `/link`). Never a code: it is typed on the
 * payment page.
 */
export function linkCheckoutInput(
  plan: Pick<Plan, 'discount'>,
  chosen: { interval: LinkInterval; terms?: { version: string }; country?: string },
): LinkCheckoutInput {
  return {
    ...(linkYearly(plan) && { interval: chosen.interval }),
    ...(chosen.terms && { terms: chosen.terms }),
    ...(chosen.country && { country: chosen.country }),
  };
}

/**
 * The plan needs a linked Whombat before paying can start: no box, and the button would open Checkout (control answers
 * `link_no_boxes`). The portal of a subscription Stripe has stays.
 */
export function linkNeedsBox(plan: Pick<Plan, 'boxes'>, action: LinkPlanAction): boolean {
  return plan.boxes === 0 && action !== null && action !== 'manage';
}

/**
 * What `checkout_busy` says: control's own sentence when it names until when a payment page is open (“… until 14:05
 * UTC. …”), else ours.
 */
export function linkCheckoutBusyText(error: unknown): string {
  const said = error instanceof ControlError ? error.message : '';
  return /\b\d{2}:\d{2} UTC\b/.test(said) ? said : T.errors.checkout_busy;
}

/** How long a payment page stays open (control closes it after 31 minutes). */
export const LINK_PAGE_OPEN_MS = 31 * 60_000;

/** The payment page this browser opened, as it keeps it: its interval while it can still be open, else null. */
export function linkOpenPageInterval(kept: unknown, now: number = Date.now()): LinkInterval | null {
  const k = kept as { interval?: unknown; at?: unknown } | null;
  if (!k || (k.interval !== 'month' && k.interval !== 'year') || typeof k.at !== 'number') return null;
  return now - k.at < LINK_PAGE_OPEN_MS ? k.interval : null;
}

/** The interval Checkout asks for: none to a control before 4.6, which refuses the member. */
export function linkCheckoutInterval(
  plan: Pick<Plan, 'discount'>,
  chosen: LinkInterval,
): LinkInterval | undefined {
  return linkYearly(plan) ? chosen : undefined;
}

/** The plan runs (the free month, a subscription, a failed payment still within Stripe's retries, Included). */
export function linkPlanRuns(plan: Pick<Plan, 'state'>): boolean {
  return (
    plan.state === 'trialing' || plan.state === 'active' || plan.state === 'past_due' || plan.state === 'comp'
  );
}

/**
 * The account is subscribed: a running plan with a card on file. An older control doesn't say, so any running plan
 * counts, the free month without a card too.
 */
export function linkSubscribed(plan: Pick<Plan, 'state' | 'cardOnFile'>): boolean {
  if (plan.cardOnFile === undefined) return linkPlanRuns(plan);
  return (
    plan.cardOnFile && (plan.state === 'trialing' || plan.state === 'active' || plan.state === 'past_due')
  );
}

/** Back from Checkout: ask every 2 s for up to a minute until the subscription shows (Stripe's webhook can lag). */
export const LINK_CHECKOUT_POLL_EVERY_MS = 2_000;
export const LINK_CHECKOUT_POLL_FOR_MS = 60_000;

export async function pollLinkCheckout(input: {
  load: () => Promise<LinkAccount>;
  onAccount: (account: LinkAccount) => void;
  live?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<'done' | 'timeout' | 'stopped'> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const live = input.live ?? (() => true);
  const started = now();
  for (;;) {
    const account = await input.load().catch(() => null);
    if (!live()) return 'stopped';
    if (account) input.onAccount(account);
    if (account && linkSubscribed(account.plan)) return 'done';
    if (now() - started + LINK_CHECKOUT_POLL_EVERY_MS > LINK_CHECKOUT_POLL_FOR_MS) return 'timeout';
    await sleep(LINK_CHECKOUT_POLL_EVERY_MS);
    if (!live()) return 'stopped';
  }
}

/**
 * After `link.confirm`: ask every 2 s, for up to 5 minutes, until the Whombat has its own address and its claim link.
 * Control knows the address once the box registered it; its certificate follows within a minute or two, then the claim
 * link. The person watches this page for that moment, so it opens within a couple of seconds of the link reaching
 * control; each ask is one cheap read of the account's own Whombats.
 */
export const LINK_ADDRESS_POLL_EVERY_MS = 2_000;
export const LINK_ADDRESS_POLL_FOR_MS = 5 * 60_000;

/**
 * How long the wait goes on for a Whombat's claim link once its address is known. The box reports the link once its
 * page works, which takes its certificate, a minute or so after the address; until then the page wouldn't open anyway.
 * A slow box can take longer, and the claim link saves the person typing six letters, so the wait is generous. A box or
 * a control from before the claim link never sends it: then its page opens after this, asking for the six letters too.
 */
export const LINK_CLAIM_URL_GRACE_MS = 3 * 60_000;

/** How long the page stays after opening the Whombat's page by itself before it offers a button (a slow page load). */
export const LINK_OPEN_FALLBACK_MS = 10_000;

/** Where the wait after linking stands: no address yet, or the address is there and its page doesn't answer yet. */
export type LinkAddressStage = 'address' | 'page';

/**
 * The claim link control gave for this Whombat (`https://<host>/c/<six letters>`): only while its address works, and
 * only on its own host.
 */
export function linkBoxClaimUrl(box: Pick<LinkedBox, 'host' | 'state' | 'claimUrl'>): string | null {
  if (!box.claimUrl || !linkBoxOpenUrl(box)) return null;
  return box.claimUrl.startsWith(`https://${box.host}/c/`) ? box.claimUrl : null;
}

/**
 * The linked Whombat's page once it has one, or why the wait ended. `claim`: nobody set it up yet (it has no name, or
 * control gave its claim link), so the page opens on its claim; `url` is then the claim link when control has it.
 */
export async function pollLinkAddress(input: {
  device: string;
  load: () => Promise<LinkAccount>;
  /** Hears where the wait stands each time it asked. */
  onStage?: (stage: LinkAddressStage) => void;
  live?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<{ url: string; box: LinkedBox; claim: boolean } | 'timeout' | 'stopped'> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const live = input.live ?? (() => true);
  const started = now();
  let addressAt: number | null = null;
  for (;;) {
    // A failed load is one more wait: control or the network may be back by the next.
    const account = await input.load().catch(() => null);
    if (!live()) return 'stopped';
    const box = account?.boxes.find((b) => b.device === input.device);
    const open = box ? linkBoxOpenUrl(box) : null;
    const claimUrl = box ? linkBoxClaimUrl(box) : null;
    if (box && claimUrl) return { url: claimUrl, box, claim: true };
    const last = now() - started + LINK_ADDRESS_POLL_EVERY_MS > LINK_ADDRESS_POLL_FOR_MS;
    input.onStage?.(box && open ? 'page' : 'address');
    if (box && open) {
      addressAt ??= now();
      // A Whombat nobody set up yet: a little longer for its claim link, so the person types only the four letters.
      const waitForLink = box.name === null && now() - addressAt < LINK_CLAIM_URL_GRACE_MS;
      if (!waitForLink || last) return { url: open, box, claim: box.name === null };
    }
    if (last) return 'timeout';
    await sleep(LINK_ADDRESS_POLL_EVERY_MS);
    if (!live()) return 'stopped';
  }
}

/**
 * Control's name for an account's hidden Link org (made by the first confirm, never shown). A control that marks it in
 * the session (`ControlOrg.link`, contracts 4.5) is believed; only an older one's list is told apart by this name.
 */
export const LINK_ORG_NAME = 'Whombat Link';

/**
 * The organization whose Whombats this site still opens (made before Link, LNK-35 phase 1); null for an account that
 * has only its Link org, or none: it has Your Whombats and the `/link` page only.
 */
export function hostedOrgOf(orgs: readonly ControlOrg[]): ControlOrg | null {
  const marked = orgs.some((o) => o.link !== undefined);
  return orgs.find((o) => (marked ? !o.link : o.name !== LINK_ORG_NAME)) ?? null;
}

/** What the country choice holds: a country Link is sold in, `other` (one it isn't), or nothing chosen yet. */
export type LinkCountryChoice = (typeof LINK_COUNTRIES)[number] | 'other' | '';

/**
 * The time zones of the countries Link is sold in, for a first guess at where the person lives (they can change it).
 * Zones of places outside the EU's VAT area (the Canary Islands, Ceuta, Åland) are left out: no guess there.
 */
const COUNTRY_OF_ZONE: Readonly<Record<string, (typeof LINK_COUNTRIES)[number]>> = {
  'Europe/Vienna': 'AT',
  'Europe/Brussels': 'BE',
  'Europe/Sofia': 'BG',
  'Asia/Nicosia': 'CY',
  'Asia/Famagusta': 'CY',
  'Europe/Nicosia': 'CY',
  'Europe/Prague': 'CZ',
  'Europe/Berlin': 'DE',
  'Europe/Busingen': 'DE',
  'Europe/Copenhagen': 'DK',
  'Europe/Tallinn': 'EE',
  'Europe/Madrid': 'ES',
  'Europe/Helsinki': 'FI',
  'Europe/Paris': 'FR',
  'Europe/Athens': 'GR',
  'Europe/Zagreb': 'HR',
  'Europe/Budapest': 'HU',
  'Europe/Dublin': 'IE',
  'Europe/Rome': 'IT',
  'Europe/Vilnius': 'LT',
  'Europe/Luxembourg': 'LU',
  'Europe/Riga': 'LV',
  'Europe/Malta': 'MT',
  'Europe/Amsterdam': 'NL',
  'Europe/Warsaw': 'PL',
  'Europe/Lisbon': 'PT',
  'Atlantic/Madeira': 'PT',
  'Atlantic/Azores': 'PT',
  'Europe/Bucharest': 'RO',
  'Europe/Stockholm': 'SE',
  'Europe/Ljubljana': 'SI',
  'Europe/Bratislava': 'SK',
};

/**
 * The country the choice starts on: the one this device's time zone is in when Link is sold there, else nothing (the
 * person chooses). A zone elsewhere (`Europe/London`) is no guess either: they say “Another country” themselves.
 */
export function linkCountryGuess(timeZone: string | undefined): LinkCountryChoice {
  return (timeZone && COUNTRY_OF_ZONE[timeZone]) || '';
}

/** The countries to choose from, by their names in `names` (the browser's own, in English), A to Z. */
export function linkCountryOptions(
  names: (code: string) => string | undefined,
): { code: (typeof LINK_COUNTRIES)[number]; name: string }[] {
  return LINK_COUNTRIES.map((code) => ({ code, name: names(code) ?? code })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );
}

/** The payment page may open for this choice: a country Link is sold in. */
export function linkCountryReady(choice: LinkCountryChoice): choice is (typeof LINK_COUNTRIES)[number] {
  return choice !== '' && choice !== 'other' && linkSoldIn(choice);
}
