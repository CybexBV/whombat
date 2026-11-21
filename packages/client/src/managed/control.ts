/**
 * The cloud control API as the managed clients use it (MA-03, MA-04, MA-06, MA-18; `@whombat/control-contracts`):
 * cloud sign-in by magic link, organizations, the appliance directory, claim coordination, admission tickets and
 * push registration. Control never sees content and can't grant content access; a ticket only admits a relay
 * connection (AP-20).
 *
 * `ControlApi` is the port; `createHttpControl` talks to control with the cloud session's bearer token
 * from a `TokenStore` (web: local storage; mobile: the platform keystore). The web's fake world implements the
 * same port for development and the e2e suite.
 */
import {
  AndroidDownload,
  authApi,
  BillingRedirect,
  BillingView,
  billingApi,
  directoryApi,
  downloadsApi,
  formatSignupCode,
  isSafeNext,
  KitEnvelope,
  KitEnvelopeInput,
  LinkAccount,
  LinkedBox,
  type LinkInterval,
  LinkLookup,
  linkApi,
  orgApi,
  type Passkey,
  PasskeyAuthenticateOptions,
  PasskeyRegisterOptions,
  type PhoneHandoffReport,
  PhoneHandoffView,
  pushApi,
  ReleaseSummary,
  rolloutApi,
  SignupInfo,
  signupApi,
  WhombatLink,
} from '@whombat/control-contracts';
import { type OwnerPasskeyRecord, OwnerPasskeyRecord as OwnerRecordSchema } from '@whombat/protocol/session';

export { APPLIANCE_TERMS_VERSION, SUBSCRIPTION_TERMS_VERSION } from '@whombat/control-contracts';
export type {
  AndroidDownload,
  BillingView,
  LinkAccount,
  LinkedBox,
  LinkInterval,
  LinkLookup,
  Passkey,
  PasskeyAuthenticateOptions,
  PasskeyRegisterOptions,
  PhoneHandoffReport,
  PhoneHandoffView,
  ReleaseSummary,
  SignupInfo,
};
/** A public plan as `signup.info` lists it (BL-25). */
export type SignupPlan = SignupInfo['plans'][number];

import type { Ticket } from '../session/connector';

/** An org of the signed-in account: it has that one account (CT-1560). */
export interface ControlOrg {
  orgId: string;
  name: string;
  /** The account's hidden Whombat Link org (contracts 4.5; absent from an older control); see `hostedOrgOf`. */
  link?: boolean;
}

export interface ControlSession {
  account: { accountId: string; email: string; name: string | null };
  orgs: ControlOrg[];
}

/** An appliance as the directory knows it: metadata only. */
export interface ApplianceSummary {
  device: string;
  orgId: string | null;
  name: string | null;
  state: 'unclaimed' | 'claim_pending' | 'claimed' | 'retired';
  /** The content identity the client pins. */
  contentPeerId: string;
  /** Epoch seconds of the last report (null: never seen). */
  lastSeenAt: number | null;
  /** Revocations recorded on the appliance and not yet delivered to their device (metadata, MA-04 §6). */
  revocationsPending: number;
  /**
   * Linked by a code at its own address (4.3): this page shows its name only, never its address, and opens nothing
   * (own-address.md). Absent or false from a control before 4.3.
   */
  ownAddress?: boolean;
}

export interface PendingClaim {
  claim: string;
  device: string;
  /** How the appliance will authenticate this claim (CC-02): its console letters or the factory card. */
  method: 'code' | 'card';
  /**
   * The directory's PeerId. The enrollment session pins it, and the claim PAKE binds it (CC-06): a box that doesn't
   * hold this identity can't produce the appliance's confirmation tag.
   */
  contentPeerId: string;
  expiresAt: number;
}

/** A code that links a Whombat to the account at its own address (`orgs.createWhombatLink`). */
export interface WhombatLinkCode {
  /** `ABCD-EFGH`. */
  code: string;
  /** ISO time. */
  expiresAt: string;
}

/** An unclaimed Whombat on the caller's public network (`claims.nearby`, CC-04). The lookup number is never listed. */
export interface NearbyAppliance {
  device: string;
  /** Hardware model (`wb-mini-1`, `self-installed`). */
  model: string;
  /** Epoch seconds. */
  registeredAt: number;
  lastSeenAt: number | null;
}

/**
 * What `claims.start` reserves a claim with (CC-05, CC-13): the card's proof, or a nearby device for the console
 * letters. A code claim works only from the box's own network, so there is no other form.
 */
export type ClaimStart = (
  | { method: 'card'; device: string; claimProof: string }
  | { method: 'code'; device: string }
) & {
  /** The appliance terms the person agreed to (LC-18): control accepts only its current version. */
  terms: { version: string };
};

/**
 * What a client registers for push (MA-18): an app install's APNs/FCM token, or a browser's Web Push subscription
 * (`PushSubscription.toJSON()`, contracts 0.5.1).
 */
export type PushRegistration =
  | { platform: 'apns' | 'fcm'; token: string; appId: string }
  | {
      platform: 'webpush';
      subscription: {
        endpoint: string;
        keys: { p256dh: string; auth: string };
        expirationTime: number | null;
      };
    };

export type ControlErrorCode =
  | 'signed_out'
  /** A phone handoff's 15 minutes are over (CT-190). */
  | 'handoff_expired'
  | 'invalid_link'
  | 'rate_limited'
  | 'not_found'
  | 'claim_competing'
  | 'already_claimed'
  | 'claim_invalid'
  /** `claims.start {method:'code', device}` for a box that isn't on this network (any more): look again (CC-13). */
  | 'device_not_nearby'
  /** `claims.start` without the current appliance terms (LC-18): this app is older than control. */
  | 'terms_required'
  /** A self-installed box, and the org's plan doesn't include those (LC-15). */
  | 'self_install_not_allowed'
  /**
   * The plan covers no more Whombats (LC-16, BL-18: `entitlement_withheld` with this reason); `details.allowed` names
   * how many it covers (CT-108), an older control only its message.
   */
  | 'devices_allowed_reached'
  /** The org is waiting for a plan (BL-13): claims wait until its account subscribes. */
  | 'billing_setup_required'
  /** A trialing org claims a Whombat that had a trial elsewhere (BL-17); `details.canStartNow`. */
  | 'trial_used_device'
  /** `orgs.create` refusals (BL-21). */
  | 'signup_code_required'
  | 'signup_code_invalid'
  | 'terms_outdated'
  /** `signup.waitlist` outside `waitlist` mode (BL-23). */
  | 'waitlist_closed'
  /** Billing refusals (CT-108). */
  | 'subscription_exists'
  | 'manual_billing'
  | 'no_subscription'
  | 'not_trialing'
  | 'plan_unavailable'
  | 'whombats_below_claimed'
  | 'billing_provider_error'
  /** `accounts.delete` refusals (CT-78, CT-1560). */
  | 'org_has_devices'
  | 'subscription_live'
  | 'email_mismatch'
  /**
   * A passkey sign-in or registration control didn't verify (`passkey_invalid`, CL-11/CL-117), or a sign-in with a
   * passkey control doesn't know, its Whombat gone (reason `passkey_unknown`).
   */
  | 'passkey_invalid'
  /** The account has as many passkeys as control keeps (`passkey_limit`). */
  | 'passkey_limit'
  /** Whombat Link at the account site (`linkApi`, contracts 4.4): a code that isn't live (404). */
  | 'link_code_invalid'
  /** The code's Whombat belongs to another Whombat account (409). */
  | 'link_other_account'
  /** `link.confirm` before the account's e-mail is confirmed (403). */
  | 'email_unconfirmed'
  /** A third Whombat during the free month without a card (403). */
  | 'link_trial_boxes'
  /** A Whombat added while the account's Link plan has stopped and no free month starts (403). */
  | 'link_subscribe'
  /** `link.checkout`'s typed code didn't work (a 4.8 control). */
  | 'promotion_code_invalid'
  /** `link.checkout` with a code (4.9): codes are typed on the payment page; only an old tab sends one. */
  | 'promotion_code_on_payment_page'
  /**
   * `link.checkout` or `link.portal` while another billing change of the account runs, or while a payment page for
   * another interval is open (its message says until when, HH:MM UTC): try again later.
   */
  | 'checkout_busy'
  /** `link.checkout` without a linked Whombat (409): Link is paid for each Whombat linked. */
  | 'link_no_boxes'
  /** Stripe refused the change for good (503, 4.9). */
  | 'billing_provider_refused'
  /** `link.checkout` for a country Link isn't sold in (403, 4.10). */
  | 'link_country'
  | 'forbidden'
  | 'unavailable';

/** What a few refusals carry besides their reason (CT-108). */
export interface ControlErrorDetails {
  /** `trial_used_device`: `billing.startNow` would let the claim through. */
  canStartNow?: boolean;
  /** `devices_allowed_reached`: the plan's `devicesAllowed`. */
  allowed?: number;
}

export class ControlError extends Error {
  override name = 'ControlError';
  constructor(
    readonly code: ControlErrorCode,
    message: string,
    readonly details: ControlErrorDetails = {},
    /**
     * The precise reason control named (`details.code`, `CONTROL_REASONS`: `device_not_found`, `org_not_found`, …), when
     * it named one; null otherwise. `code` is what the apps tell apart, this only where one code means two things
     * (a ticket's 404, AP-693).
     */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

/**
 * “Your plan covers {n} Whombats.”: the number control's `devices_allowed_reached` names, from `details.allowed`
 * (CT-108) or, from an older control, its message.
 */
export function devicesAllowedOf(error: unknown): number | null {
  if (!(error instanceof ControlError) || error.code !== 'devices_allowed_reached') return null;
  if (typeof error.details.allowed === 'number') return error.details.allowed;
  const m = /covers (\d+) Whombats?/.exec(error.message);
  return m?.[1] ? Number(m[1]) : null;
}

/** What `orgs.create` takes (BL-21): the company name, the terms the person ticked, and a signup code if any. */
export interface CreateOrgInput {
  name: string;
  terms: { version: string };
  /** As typed or linked; normalised before it is sent (`formatSignupCode`). */
  code?: string | null;
}

/** `signup.waitlist` (BL-23). */
export interface WaitlistInput {
  email: string;
  company?: string;
  note?: string;
}

export interface ControlRequestOptions {
  signal?: AbortSignal;
}

export interface ControlApi {
  session(): Promise<ControlSession | null>;
  /** Emails a one-time sign-in link that opens `/auth/verify#token=…` (the hosted UI, or this app by its link). */
  /** `next`: the app path to continue to after sign-in; sent only when it passes `isSafeNext` (CT-48). */
  /** `code`: a held signup code, so an address without an account gets a link outside `open` mode (BL-33). */
  requestSignInLink(email: string, next?: string, code?: string): Promise<void>;
  verifySignIn(token: string): Promise<ControlSession>;
  signOut(): Promise<void>;
  /**
   * A new cloud account has no organization yet: create one (the caller's). Refused with
   * `signup_code_required`, `signup_code_invalid`, `terms_outdated` or `rate_limited` (BL-21).
   */
  createOrg(input: CreateOrgInput): Promise<ControlOrg>;
  /**
   * The signup mode, billing provider, trial length, terms version and public plans (`signup.info`, BL-25; public).
   * Null when this control has no signups (an older control answers 404): the UI then hides Billing (CT-110).
   */
  signupInfo(): Promise<SignupInfo | null>;
  /** Join the waitlist (public; always fine for a valid body, a repeat included). Refused `waitlist_closed`. */
  joinWaitlist(input: WaitlistInput): Promise<void>;
  /** The org's subscription as the Billing page shows it (`billing.view`). */
  billing(orgId: string): Promise<BillingView>;
  /** A Stripe Checkout page for a public plan × `whombats` (BL-15): the browser goes there. */
  billingCheckout(orgId: string, input: { plan: string; whombats: number }): Promise<{ url: string }>;
  /** The Stripe Customer Portal (BL-18): cards, invoices, switching plan, cancelling. */
  billingPortal(orgId: string): Promise<{ url: string }>;
  /** Pay for `count` Whombats from now on, prorated (BL-18); answers the new view at once. */
  billingWhombats(orgId: string, count: number): Promise<BillingView>;
  /** End the trial now, so a Whombat that had a trial elsewhere can be claimed (BL-17). */
  billingStartNow(orgId: string): Promise<BillingView>;
  appliances(orgId: string, options?: ControlRequestOptions): Promise<ApplianceSummary[]>;
  /** Names a Whombat in the directory (`devices.rename`; AP-3086). */
  renameAppliance(input: { orgId: string; device: string; name: string }): Promise<ApplianceSummary>;
  /**
   * Unclaimed Whombats on this browser's or phone's public network (CC-04), most recently seen first, at most 20.
   */
  nearbyClaims(orgId: string): Promise<NearbyAppliance[]>;
  /**
   * A one-time code to link a Whombat to this org at the Whombat's own address (`orgs.createWhombatLink`, 4.3): typed
   * there, it lives 10 minutes and links one box. The terms must be `APPLIANCE_TERMS_VERSION` (`terms_required`).
   * Optional: test doubles and an older control's client leave it out.
   */
  createWhombatLink?(orgId: string, terms: { version: string }): Promise<WhombatLinkCode>;
  /**
   * Reserve the claim for this org (one pending claim per appliance, expires; CC-05). A card claim carries
   * `claimProof` computed from the card (`claimProofOf`, CT-43); a code claim names a nearby device (CC-13). Control
   * never learns the letters or the card's secret.
   */
  startClaim(input: { orgId: string } & ClaimStart): Promise<{ claim: PendingClaim; ticket: Ticket }>;
  /** An admission ticket for one relay connection. */
  ticket(
    input: {
      orgId: string;
      device: string;
      channel: 'app' | 'enroll';
      class: 'interactive' | 'bulk';
    },
    options?: ControlRequestOptions,
  ): Promise<Ticket>;
  /** Registers this install's push token or this browser's subscription; the opaque handle goes to the appliance. */
  pushRegister(registration: PushRegistration): Promise<{ handle: string }>;
  pushUnregister(handle: string): Promise<void>;
  /**
   * Control's VAPID public key for browser push (MA-18, CT-42). Null when this control has none (an older control
   * answers 404): browser notifications are then not offered.
   */
  pushVapidKey(): Promise<string | null>;
  /**
   * Deletes this cloud account and its orgs (`accounts.delete`, CT-78, CT-1560), confirmed by typing its email. Refused
   * while one of its orgs still has a Whombat (`org_has_devices`) or a live subscription (`subscription_live`). The data
   * on its Whombats is never touched.
   */
  deleteAccount(email: string): Promise<void>;
  /**
   * What a release brought (`rollout.releaseSummary`, CT-138): the summary of its notes, shown under
   * “Updated to … on …” (AP-258). Null when control has no record of it (`release_not_found`), or is too old to say.
   */
  releaseSummary(release: string): Promise<ReleaseSummary | null>;
  /** Phone sign-in by QR code (CT-190, AP-520): a one-time token for the QR code and the handoff to watch. */
  createPhoneHandoff(): Promise<{ handoffId: string; token: string; expiresAt: string }>;
  /** The handoff as its creator sees it (`not_found` once it is over). */
  phoneHandoff(handoffId: string): Promise<PhoneHandoffView>;
  /** The phone: the QR code's token for its own cloud session (kept like `verifySignIn`'s), and the handoff. */
  redeemPhoneHandoff(token: string): Promise<{ session: ControlSession; handoffId: string }>;
  /** The phone: what the browser should do next (let a pairing request in, or nothing). */
  reportPhoneHandoff(handoffId: string, report: PhoneHandoffReport): Promise<void>;
  /** The Android APK this control hands out (CT-191); null when none is published or control is older. */
  androidDownload(): Promise<AndroidDownload | null>;
  /**
   * Passkey sign-in, step 1 (PK-04, CT-283; public): a single-use challenge bound to this device's key (`endpoint`, its
   * PeerId) and control's nonce. The client recomputes the challenge before it is signed (`preparePasskeySignIn`).
   */
  passkeyAuthenticateOptions(endpoint: string): Promise<PasskeyAuthenticateOptions>;
  /** Passkey sign-in, step 2: control checks the assertion and answers a cloud session (kept like `verifySignIn`'s). */
  passkeyAuthenticateVerify(challengeId: string, response: unknown): Promise<ControlSession>;
  /** A Whombat passkey's registration options (PK-06): the PK-01 user and the PK-03 challenge with control's nonce. */
  passkeyRegisterOptions(input: {
    /** Left out (with `applianceNonce`) for an account passkey, one that opens no Whombat (own-address.md). */
    appliance?: string;
    applianceNonce?: string;
    ownerHandle?: string;
  }): Promise<PasskeyRegisterOptions>;
  /** Control keeps the new passkey too (it signs the cloud account in). */
  passkeyRegisterVerify(input: {
    name: string;
    response: unknown;
    ownerRecord?: OwnerPasskeyRecord;
  }): Promise<{ id: string; name: string }>;
  /** The account's passkeys as control keeps them (`id` is the credential id, base64url). */
  passkeys(): Promise<Passkey[]>;
  /** Safe consolidation: control checks recovery dependencies and the unchanged directory atomically. */
  retirePasskey?(id: string, input: import('@whombat/control-contracts').PasskeyRetireInput): Promise<void>;
  /** Control forgets one of the account's passkeys (`not_found` when it has none by that id). */
  deletePasskey(id: string): Promise<void>;
  putPasskeyOwner?(id: string, record: OwnerPasskeyRecord): Promise<void>;
  unlinkPasskey?(id: string, appliance: string): Promise<void>;
  /**
   * The account's passkey-locked recovery kits (Whombat backup-options.md), retired Whombats' included. An older control
   * answers 404: none.
   */
  kitEnvelopes(): Promise<KitEnvelope[]>;
  /** Keeps a passkey-locked kit for one of the account's Whombats (replacing the same Whombat and passkey's). */
  putKitEnvelope(input: KitEnvelopeInput): Promise<{ id: string }>;
  deleteKitEnvelope(id: string): Promise<void>;
  /**
   * Whombat Link at the account site (`linkApi`, contracts 4.4; Whombat whombat-link.md LNK-13, LNK-35). Optional:
   * the phone and test doubles leave them out. `linkLookup`: which Whombat a code its screen shows belongs to
   * (`link_code_invalid`, `link_other_account`, `rate_limited`).
   */
  linkLookup?(code: string): Promise<LinkLookup>;
  /**
   * The code's Whombat joins the account's Link (`email_unconfirmed`, `link_trial_boxes`, the lookup's refusals). `terms`:
   * the Subscription Terms the person ticked, only when the lookup named a `termsVersion` (an older control refuses
   * it); another version than control's is `terms_outdated`.
   */
  linkConfirm?(code: string, terms?: { version: string }): Promise<LinkedBox>;
  /** The account's Link subscription and its Whombats. */
  linkAccount?(): Promise<LinkAccount>;
  /** Takes a Whombat out of the account's Link. */
  linkRemove?(device: string): Promise<LinkAccount>;
  /**
   * The one way to start paying (4.9): Stripe's Checkout for Link by the month or the year, where the person types a
   * promotion code in Stripe's own field, with the Subscription Terms when the account has none (`terms_required`).
   * Refusals: `subscription_exists` (use the portal), `checkout_busy`, `manual_billing` (a free account),
   * `billing_provider_error`/`billing_provider_refused`. `interval` only to a control that takes it (4.6, `linkYearly`).
   * The contract's `promotionCode` is never sent.
   */
  linkCheckout?(input?: LinkCheckoutInput): Promise<{ url: string }>;
  /**
   * The Stripe Customer Portal for Link, once Stripe has the subscription (`no_subscription` until then: Checkout),
   * with the terms when the account has none (4.8).
   */
  linkPortal?(terms?: { version: string }): Promise<{ url: string }>;
}

/** What `linkCheckout` sends: each member only when set. */
export interface LinkCheckoutInput {
  interval?: LinkInterval;
  terms?: { version: string };
  /** Where the person lives, as an ISO 3166-1 code (4.10): control refuses a country Link isn't sold in. */
  country?: string;
}

/** Where the cloud session's bearer token is kept (it admits relay connections only; AP-20). */
export interface TokenStore {
  get(): Promise<string | null> | string | null;
  set(token: string): Promise<void> | void;
  remove(): Promise<void> | void;
}

const TOKEN_KEY = 'whombat:cloud-token';

type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The browser's store: local storage under `whombat:cloud-token`, reached when used (reaching it may throw: storage
 * turned off, a sandboxed frame). Its failures are the control client's to handle (`sessionTokens`).
 */
export function storageTokenStore(storage: TokenStorage | (() => TokenStorage)): TokenStore {
  const reach = typeof storage === 'function' ? storage : () => storage;
  return {
    get: () => reach().getItem(TOKEN_KEY),
    set: (token) => reach().setItem(TOKEN_KEY, token),
    remove: () => reach().removeItem(TOKEN_KEY),
  };
}

/**
 * The token store as the control client uses it (AP-594): it never fails. A token that can't be stored signs in this
 * page (or app run) only, and the older stored one is removed, so no other account's token stands in after a reload.
 * One that can't be removed is gone for this page all the same (control ends it on sign-out); one that can't be read
 * is none (signed out). Nothing unstored pretends to be stored: a reload asks the store again.
 */
function sessionTokens(store: TokenStore): TokenStore {
  /** The page's own answer while the store couldn't take it; undefined: the store answers. */
  let kept: string | null | undefined;
  return {
    async get() {
      if (kept !== undefined) return kept;
      try {
        return (await store.get()) ?? null;
      } catch {
        return null;
      }
    },
    async set(token) {
      try {
        await store.set(token);
        kept = undefined;
      } catch {
        kept = token;
        try {
          await store.remove();
        } catch {
          // The page's own token is what counts here; control refuses a stale one after a reload.
        }
      }
    },
    async remove() {
      try {
        await store.remove();
        kept = undefined;
      } catch {
        kept = null;
      }
    },
  };
}

/** Reasons (`error.details.code`, CT-33) the apps tell apart by name. */
const NAMED_REASONS = new Set<string>([
  'terms_required',
  'self_install_not_allowed',
  'devices_allowed_reached',
  'org_has_devices',
  'subscription_live',
  'email_mismatch',
  'billing_setup_required',
  'trial_used_device',
  'signup_code_required',
  'signup_code_invalid',
  'terms_outdated',
  'waitlist_closed',
  'subscription_exists',
  'manual_billing',
  'no_subscription',
  'not_trialing',
  'plan_unavailable',
  'whombats_below_claimed',
  'billing_provider_error',
  'handoff_expired',
  'link_code_invalid',
  'link_other_account',
  'email_unconfirmed',
  'link_trial_boxes',
  'link_subscribe',
  'promotion_code_invalid',
  'promotion_code_on_payment_page',
  'checkout_busy',
  'link_no_boxes',
  'billing_provider_refused',
  'link_country',
] satisfies ControlErrorCode[]);

/** The refusal's reason as `ControlError` names it; exported for the tests. */
export function controlErrorCodeOf(status: number, body: unknown): ControlErrorCode {
  const error = (body as { error?: { code?: string; details?: { code?: string } } } | undefined)?.error;
  // Control puts the precise reason in `details.code` (e.g. `forbidden` + `claim_proof_invalid`).
  const code = error?.details?.code ?? error?.code;
  if (status === 429) return 'rate_limited';
  // A passkey control didn't verify is a 401 too, but nobody signed out (CL-11). One it doesn't know at all (its
  // Whombat is gone) is the same code; `reason` says `passkey_unknown`.
  if (code === 'passkey_invalid' || code === 'passkey_limit') return code;
  if (code === 'passkey_unknown') return 'passkey_invalid';
  if (status === 401) return 'signed_out';
  if (code === 'claim_pending' || code === 'claim_competing' || code === 'conflict') return 'claim_competing';
  if (code === 'already_claimed') return 'already_claimed';
  if (code === 'device_not_nearby') return 'device_not_nearby';
  if (code && NAMED_REASONS.has(code)) return code as ControlErrorCode;
  // The card's proof didn't match what the appliance registered (CT-43): the card was typed wrong.
  if (code === 'claim_proof_invalid' || code === 'claim_verifier_missing') return 'claim_invalid';
  if (status === 404) return 'not_found';
  if (status === 403) return 'forbidden';
  if (status === 400 && code) return 'invalid_link';
  return 'unavailable';
}

/** `canStartNow` and `allowed` of a refusal's details (CT-108), when well-formed; anything else is dropped. */
function detailsOf(body: unknown): ControlErrorDetails {
  const d = (body as { error?: { details?: Record<string, unknown> } } | undefined)?.error?.details;
  if (!d || typeof d !== 'object') return {};
  const out: ControlErrorDetails = {};
  if (typeof d.canStartNow === 'boolean') out.canStartNow = d.canStartNow;
  if (typeof d.allowed === 'number' && Number.isInteger(d.allowed) && d.allowed >= 0 && d.allowed <= 10_000)
    out.allowed = d.allowed;
  return out;
}

/** The precise reason of a refusal (`error.details.code`), when it is one's shape; anything else is none. */
function reasonOf(body: unknown): string | null {
  const code = (body as { error?: { details?: { code?: unknown } } } | undefined)?.error?.details?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A Billing view as the contract has it; anything else is control not answering properly. */
function viewOf(body: unknown): BillingView {
  const r = BillingView.safeParse(body);
  if (!r.success) throw new ControlError('unavailable', 'Whombat’s service didn’t answer.');
  return r.data;
}

/** A Whombat as `devices.list` and `devices.rename` answer it (`DirectoryDevice`), the fields the apps read. */
interface DirectoryEntry {
  device: string;
  org: string | null;
  name: string | null;
  state: ApplianceSummary['state'];
  contentPeerId: string;
  lastSeenAt: number | null;
  revocations: { state: 'pending' | 'applied' }[];
  ownAddress?: boolean;
}

function summaryOf(d: DirectoryEntry): ApplianceSummary {
  return {
    device: d.device,
    orgId: d.org,
    name: d.name,
    state: d.state,
    contentPeerId: d.contentPeerId,
    lastSeenAt: d.lastSeenAt,
    revocationsPending: d.revocations.filter((x) => x.state === 'pending').length,
    ...(d.ownAddress === true && { ownAddress: true }),
  };
}

/** Stripe's page (`BillingRedirect`): the browser goes there and nowhere else (CT-106). */
function redirectOf(body: unknown): { url: string } {
  const r = BillingRedirect.safeParse(body);
  if (!r.success) throw new ControlError('unavailable', 'Whombat’s service didn’t answer.');
  return { url: r.data.url };
}

/** Control's answer as the contract has it; anything else is control not answering properly. */
function parsed<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  body: unknown,
): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ControlError('unavailable', 'Whombat’s service didn’t answer.');
  return r.data;
}

/** control over HTTPS. */
export function createHttpControl(
  baseUrl: string,
  options: { tokens: TokenStore; fetch?: FetchLike },
): ControlApi {
  const base = baseUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((i, init) => fetch(i, init));
  const tokens = sessionTokens(options.tokens);
  const url = (path: string, params: Record<string, string> = {}) =>
    `${base}/v1${path.replace(/:([A-Za-z]+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ''))}`;

  async function call<T>(
    ep: { method: string; path: string },
    input: { params?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const token = await tokens.get();
    if (input.signal?.aborted) throw new ControlError('unavailable', 'Request cancelled.');
    let res: Response;
    try {
      res = await doFetch(url(ep.path, input.params), {
        method: ep.method,
        headers: {
          ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(input.signal && { signal: input.signal }),
      });
    } catch {
      throw new ControlError('unavailable', 'Couldn’t reach Whombat. Check your connection.');
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
      throw new ControlError(
        controlErrorCodeOf(res.status, body),
        message ?? 'Whombat’s service didn’t answer.',
        detailsOf(body),
        reasonOf(body),
      );
    }
    return body as T;
  }

  const toSession = (s: {
    account: { accountId: string; email: string; name: string | null };
    orgs: ControlOrg[];
  }): ControlSession => ({ account: s.account, orgs: s.orgs });

  return {
    async session() {
      if (!(await tokens.get())) return null;
      try {
        return toSession(await call(authApi.session));
      } catch (error) {
        if (error instanceof ControlError && error.code === 'signed_out') {
          await tokens.remove();
          return null;
        }
        throw error;
      }
    },
    /** Control mails `…/auth/verify#token=…&next=…` (a fragment, so the token never reaches server logs). */
    async requestSignInLink(email, next = '/appliances', code) {
      // Control refuses anything else (`SAFE_NEXT`); a path that doesn't pass is left out, not sent.
      const held = code === undefined ? null : formatSignupCode(code);
      await call(authApi.requestMagicLink, {
        body: { email, ...(isSafeNext(next) && { next }), ...(held && { code: held }) },
      });
    },
    async verifySignIn(token) {
      const s = await call<{ token: string } & ControlSession>(authApi.verify, { body: { token } });
      await tokens.set(s.token);
      return toSession(s);
    },
    async signOut() {
      try {
        await call(authApi.signOut, { body: {} });
      } finally {
        await tokens.remove();
      }
    },
    async deleteAccount(email) {
      await call(authApi.deleteAccount, { body: { email } });
      await tokens.remove();
    },
    async createOrg({ name, terms, code }) {
      // Control takes the canonical form (CT-107); a code that isn't one goes as typed and is refused there.
      const typed = code?.trim();
      const sent = typed ? (formatSignupCode(typed) ?? typed) : null;
      const org = await call<{ orgId: string; name: string }>(orgApi.create, {
        body: { name, terms: { version: terms.version }, ...(sent && { code: sent }) },
      });
      return { orgId: org.orgId, name: org.name };
    },
    async signupInfo() {
      try {
        const r = SignupInfo.safeParse(await call(signupApi.info));
        return r.success ? r.data : null;
      } catch (error) {
        if (error instanceof ControlError && error.code === 'not_found') return null;
        throw error;
      }
    },
    async joinWaitlist({ email, company, note }) {
      await call(signupApi.waitlist, {
        body: {
          email: email.trim(),
          ...(company?.trim() && { company: company.trim() }),
          ...(note?.trim() && { note: note.trim() }),
        },
      });
    },
    async billing(orgId) {
      return viewOf(await call(billingApi.view, { params: { org: orgId } }));
    },
    async billingCheckout(orgId, { plan, whombats }) {
      return redirectOf(
        await call(billingApi.checkout, { params: { org: orgId }, body: { plan, whombats } }),
      );
    },
    async billingPortal(orgId) {
      return redirectOf(await call(billingApi.portal, { params: { org: orgId }, body: {} }));
    },
    async billingWhombats(orgId, count) {
      return viewOf(await call(billingApi.whombats, { params: { org: orgId }, body: { count } }));
    },
    async billingStartNow(orgId) {
      return viewOf(await call(billingApi.startNow, { params: { org: orgId }, body: {} }));
    },
    async appliances(orgId, options) {
      const r = await call<{ devices: DirectoryEntry[] }>(directoryApi.list, {
        params: { org: orgId },
        signal: options?.signal,
      });
      return r.devices.map(summaryOf);
    },
    async renameAppliance({ orgId, device, name }) {
      return summaryOf(
        await call<DirectoryEntry>(directoryApi.rename, { params: { org: orgId, device }, body: { name } }),
      );
    },
    async createWhombatLink(orgId, terms) {
      const r = WhombatLink.safeParse(
        await call(orgApi.createWhombatLink, { params: { org: orgId }, body: { terms } }),
      );
      if (!r.success) throw new ControlError('unavailable', 'Whombat’s service didn’t answer.');
      return r.data;
    },
    async nearbyClaims(orgId) {
      const r = await call<{ devices: NearbyAppliance[] }>(directoryApi.nearbyClaims, {
        params: { org: orgId },
      });
      return r.devices.map((d) => ({
        device: d.device,
        model: d.model,
        registeredAt: d.registeredAt,
        lastSeenAt: d.lastSeenAt,
      }));
    },
    async startClaim({ orgId, ...start }) {
      const r = await call<{
        claim: PendingClaim;
        ticket: { ticket: string; relay: { url: string } };
      }>(directoryApi.startClaim, {
        params: { org: orgId },
        body: { ...start, class: 'interactive' },
      });
      const claim: PendingClaim = {
        claim: r.claim.claim,
        device: r.claim.device,
        method: r.claim.method,
        contentPeerId: r.claim.contentPeerId,
        expiresAt: r.claim.expiresAt,
      };
      return { claim, ticket: { ticket: r.ticket.ticket, relayUrl: r.ticket.relay.url } };
    },
    async ticket({ orgId, ...body }, options) {
      const r = await call<{ ticket: string; relay: { url: string } }>(directoryApi.ticket, {
        params: { org: orgId },
        body,
        signal: options?.signal,
      });
      return { ticket: r.ticket, relayUrl: r.relay.url };
    },
    async pushRegister(registration) {
      return call<{ handle: string }>(pushApi.register, { body: registration });
    },
    async pushUnregister(handle) {
      await call(pushApi.unregister, { params: { handle } });
    },
    async releaseSummary(release) {
      try {
        const r = ReleaseSummary.safeParse(await call(rolloutApi.releaseSummary, { params: { release } }));
        return r.success ? r.data : null;
      } catch (error) {
        if (error instanceof ControlError && error.code === 'not_found') return null;
        throw error;
      }
    },
    async createPhoneHandoff() {
      return call<{ handoffId: string; token: string; expiresAt: string }>(authApi.createPhoneHandoff, {
        body: {},
      });
    },
    async phoneHandoff(handoffId) {
      const r = PhoneHandoffView.safeParse(await call(authApi.phoneHandoff, { params: { handoffId } }));
      if (!r.success) throw new ControlError('unavailable', 'Whombat’s service didn’t answer.');
      return r.data;
    },
    async redeemPhoneHandoff(token) {
      const s = await call<{ token: string; handoffId: string } & ControlSession>(
        authApi.redeemPhoneHandoff,
        {
          body: { token },
        },
      );
      await tokens.set(s.token);
      return { session: toSession(s), handoffId: s.handoffId };
    },
    async reportPhoneHandoff(handoffId, report) {
      await call(authApi.reportPhoneHandoff, { params: { handoffId }, body: report });
    },
    async androidDownload() {
      try {
        const r = await call<{ android?: unknown }>(downloadsApi.android);
        const a = AndroidDownload.safeParse(r?.android);
        return a.success ? a.data : null;
      } catch (error) {
        if (error instanceof ControlError && error.code === 'not_found') return null;
        throw error;
      }
    },
    async passkeyAuthenticateOptions(endpoint) {
      const r = PasskeyAuthenticateOptions.safeParse(
        await call(authApi.passkeyAuthenticateOptions, { body: { endpoint } }),
      );
      if (!r.success) throw new ControlError('unavailable', 'Whombat’s service didn’t answer.');
      return r.data;
    },
    async passkeyAuthenticateVerify(challengeId, response) {
      const s = await call<{ token: string } & ControlSession>(authApi.passkeyAuthenticateVerify, {
        body: { challengeId, response },
      });
      await tokens.set(s.token);
      return toSession(s);
    },
    async passkeyRegisterOptions(input) {
      const r = PasskeyRegisterOptions.safeParse(await call(authApi.passkeyRegisterOptions, { body: input }));
      if (!r.success) throw new ControlError('unavailable', 'Whombat’s service didn’t answer.');
      return r.data;
    },
    async passkeyRegisterVerify({ name, response, ownerRecord }) {
      return call<{ id: string; name: string }>(authApi.passkeyRegisterVerify, {
        body: { name, response, ...(ownerRecord ? { ownerRecord } : {}) },
      });
    },
    async passkeys() {
      const r = await call<{ passkeys: Passkey[] }>(authApi.passkeys);
      return r.passkeys;
    },
    async putPasskeyOwner(id, record) {
      await call(authApi.putPasskeyOwner, { params: { id }, body: OwnerRecordSchema.parse(record) });
    },
    async unlinkPasskey(id, appliance) {
      await call(authApi.unlinkPasskey, { params: { id, appliance } });
    },
    async deletePasskey(id) {
      await call(authApi.deletePasskey, { params: { id } });
    },
    async retirePasskey(id, input) {
      await call(authApi.retirePasskey, { params: { id }, body: authApi.retirePasskey.body.parse(input) });
    },
    async kitEnvelopes() {
      try {
        const r = await call<{ envelopes: unknown[] }>(authApi.kitEnvelopes);
        return (r.envelopes ?? []).flatMap((e) => {
          const p = KitEnvelope.safeParse(e);
          return p.success ? [p.data] : [];
        });
      } catch (error) {
        if (error instanceof ControlError && error.code === 'not_found') return [];
        throw error;
      }
    },
    async putKitEnvelope(input) {
      return call<{ id: string }>(authApi.putKitEnvelope, { body: KitEnvelopeInput.parse(input) });
    },
    async deleteKitEnvelope(id) {
      await call(authApi.deleteKitEnvelope, { params: { id } });
    },
    async linkLookup(code) {
      return parsed(LinkLookup, await call(linkApi.lookup, { body: { code } }));
    },
    async linkConfirm(code, terms) {
      const body = { code, ...(terms && { terms: { version: terms.version } }) };
      return parsed(LinkedBox, await call(linkApi.confirm, { body }));
    },
    async linkAccount() {
      return parsed(LinkAccount, await call(linkApi.boxes));
    },
    async linkRemove(device) {
      return parsed(LinkAccount, await call(linkApi.remove, { params: { device } }));
    },
    async linkCheckout(input = {}) {
      const body = {
        ...(input.interval && { interval: input.interval }),
        ...(input.terms && { terms: { version: input.terms.version } }),
        ...(input.country && { country: input.country }),
      };
      return redirectOf(await call(linkApi.checkout, { body }));
    },
    async linkPortal(terms) {
      return redirectOf(
        await call(linkApi.portal, { body: terms ? { terms: { version: terms.version } } : {} }),
      );
    },
    async pushVapidKey() {
      try {
        const r = await call<{ publicKey?: unknown }>(pushApi.vapid);
        return typeof r?.publicKey === 'string' && /^[A-Za-z0-9_-]{87}$/.test(r.publicKey)
          ? r.publicKey
          : null;
      } catch (error) {
        if (error instanceof ControlError && error.code === 'not_found') return null;
        throw error;
      }
    },
  };
}

/** Which words a refused account deletion gets (`COPY.account.errors[key]`, CT-78). */
export function deleteAccountErrorKey(
  error: unknown,
): 'email_mismatch' | 'org_has_devices' | 'subscription_live' | 'unavailable' | 'failed' {
  if (!(error instanceof ControlError)) return 'failed';
  if (
    error.code === 'email_mismatch' ||
    error.code === 'org_has_devices' ||
    error.code === 'subscription_live'
  )
    return error.code;
  return error.code === 'unavailable' ? 'unavailable' : 'failed';
}
