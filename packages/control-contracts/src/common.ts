/** Identifiers and small shared schemas of the control API. Cross-language where the device API uses them. */
import { z } from 'zod';

const opaque = (min = 1, max = 64) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/** Cloud account (pseudonymous to the relay; appears as ticket `sub`). */
export const AccountId = opaque();
export const OrgId = opaque();
/** Device directory id (a ticket's `sub` for appliance tickets). */
export const DeviceId = opaque();
/** Opaque appliance route id the relay routes by (ticket `apl`); rotatable, unrelated to the serial. */
export const ApplianceRouteId = opaque();
export const RelayWorkerId = opaque();
export const ClaimId = opaque(8);
export const CohortId = opaque();
export const RolloutId = opaque();
/** Device-reported opaque ids (revocations, push refs) meaningful only to the appliance. */
export const OpaqueRef = opaque(1, 64);
/** Hardware serial as printed on the device. */
export const HardwareSerial = z
  .string()
  .min(4)
  .max(64)
  .regex(/^[A-Z0-9-]+$/);
/** Hardware model identifier (`wb-mini-1`). */
export const HardwareModel = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
/** 16 random bytes, lowercase hex. */
export const NonceHex = z.string().regex(/^[0-9a-f]{32}$/);
/** Display names typed by people (org names, device nicknames). Never sent by devices. */
export const DisplayName = z.string().trim().min(1).max(80);
export const Email = z.email().max(254);
/** `https://…` or `wss://…` (http/ws allowed only for `local`). */
export const ServiceUrl = z
  .string()
  .min(8)
  .max(256)
  .regex(/^(https|wss|http|ws):\/\/[\x21-\x7e]+$/);

export const Cursor = z.string().min(1).max(256);
export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item).max(500), next: Cursor.nullable() });

export const ControlErrorCode = z.enum([
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'expired',
  /** Device request: bad signature, unknown device, stale timestamp, replayed nonce. */
  'bad_device_signature',
  /** The device is retired or its management key was rotated. */
  'device_revoked',
  /** Claim: the device already has a pending claim from someone else, or is claimed. */
  'claim_conflict',
  /** Billing withholds a convenience (claiming more appliances, cohorts); never data or updates. */
  'entitlement_withheld',
  'internal',
]);
export type ControlErrorCode = z.infer<typeof ControlErrorCode>;

/**
 * Precise reasons in `error.details.code` (CT-33; replaces the `x-whombat-reason` header). The set is open (a newer
 * control may add reasons); UIs branch on known ones and fall back to `error.code`.
 */
export const CONTROL_REASONS = {
  // Sessions and sign-in.
  no_session: 'No session (sign in).',
  session_invalid: 'The session expired or was revoked.',
  link_invalid: 'The magic link is unknown, used or expired.',
  passkey_invalid: 'The passkey assertion or registration did not verify.',
  passkey_unknown:
    'A passkey sign-in with a credential control doesn’t hold, or one for a retired Whombat (forgotten now); apps may tell the platform to forget it.',
  passkey_kept_for_kit:
    'A passkey sign-in for a retired Whombat whose passkey is kept because it locks a recovery kit (Whombat backup-options.md): it no longer signs in, but apps must not tell the platform to forget it.',
  account_disabled: 'The cloud account is disabled.',
  email_mismatch: 'The typed confirmation isn’t the account’s email address (`accounts.delete`).',
  origin_forbidden: 'A cookie-authenticated request from an origin outside the allowlist (CSRF).',
  // Orgs (one account each since 3.0, CT-1560).
  org_not_found: 'No such org (or not the caller’s).',
  org_has_devices:
    '`accounts.delete` while one of the account’s orgs still has a claimed appliance (release or retire it first).',
  entitlement_withheld: 'The org’s plan withholds this convenience.',
  devices_allowed_reached:
    'The org’s plan allows no more appliances: `claims.start` (live claimed devices plus other pending claims of the org count), and `licence.renew` for a device claimed over the limit (LC-16).',
  terms_required:
    '`claims.start` without `terms`, or with another version than the current `APPLIANCE_TERMS_VERSION` (LC-18); `link.confirm`, `link.checkout` or `link.portal` (4.8) without `terms` while the account has accepted no Subscription Terms (400).',
  self_install_not_allowed:
    'The org’s plan doesn’t cover self-installed devices (`origin: "self"`, the ISO; `Entitlement.selfInstall`, LC-15).',
  // Devices and claims.
  device_not_found: 'No such device (or held by another org).',
  device_retired: 'The device is retired (stolen, RMA, destroyed).',
  device_unclaimed: 'The device isn’t claimed yet.',
  device_unavailable: 'The device can’t be reached for this.',
  claim_not_found: 'No such claim.',
  claim_pending: 'The device already has a pending claim of this org.',
  claim_conflict: 'Another org holds a pending claim for the device.',
  claim_unknown: 'The appliance reported a claim control doesn’t know (`claim.claimed`).',
  already_claimed:
    'The device is already claimed (by this or another org); also the device op `claim.lookup` of a claimed device.',
  device_not_nearby:
    'The device isn’t on the caller’s network (`claims.start` code form with `device`); use the full code.',
  self_registration_disabled:
    'Self-registration isn’t enabled on this control service (`SELF_REGISTRATION`).',
  claim_proof_invalid: 'The claim proof doesn’t match the card of this device.',
  claim_verifier_missing: 'The device has no registered claim verifier (provisioning incomplete).',
  claim_verifier_exists: 'A different claim verifier is already registered for the device.',
  device_exists: 'A device with this serial or key is already registered (provisioning).',
  relay_unavailable: 'No relay worker is available (retry after `retryAfterS`).',
  // The box's own address (4.3; Whombat own-address.md).
  claim_at_address:
    '`claims.start` for a device that has an own-address label and no org (409): that box is set up at its own address.',
  label_invalid: '`address.register` with a label that isn’t three different words of the list.',
  label_taken: '`address.register` with a label used before (409): the box draws another.',
  link_code_invalid:
    '`account.link.lookup` or `account.link` with an unknown code; `account.link.lookup` answers it for expired and used codes too.',
  link_code_expired: '`account.link` with a code whose ten minutes are over.',
  link_code_used: '`account.link` with a code already used.',
  link_other_account: '`account.link` for a device another org holds.',
  link_terms:
    '`account.link` while the code’s account hasn’t accepted the current `APPLIANCE_TERMS_VERSION`.',
  link_devices_allowed: '`account.link` while the account’s plan allows no more Whombats.',
  device_unlinked: '`kit.credentials.declare` from a device no account holds yet.',
  // Whombat Link (4.4; Whombat whombat-link.md). `link_code_invalid` and `link_other_account` also answer `link.lookup`
  // and `link.confirm` (an unknown, used or expired code is one reason there, so codes can't be probed).
  registration_invalid:
    '`link.begin` with a registration whose proofs don’t verify, or whose `contentPeerId` isn’t its content key’s.',
  email_unconfirmed: '`link.confirm` before the account confirmed its e-mail: no address before it is.',
  link_trial_boxes:
    '`link.confirm` for a third box during the free month (403): add a card first (`link.checkout`).',
  link_off: '`push.register` or `push.send` while the box’s Link is off or ended.',
  link_country:
    '`link.checkout` with a `country` outside `LINK_COUNTRIES` (403, 4.10): Whombat Link is sold in EU countries only for now.',
  // Device API and provisioning.
  bad_envelope: 'The device request envelope is malformed.',
  bad_signature: 'The device signature doesn’t verify.',
  bad_body: 'The device request body doesn’t match its operation.',
  wrong_audience: 'The envelope names another environment.',
  unknown_device: 'The device isn’t in the directory (or its key rotated).',
  stale: 'The device clock is outside ±300 s.',
  replayed: 'The nonce was already used.',
  op_mismatch: 'The path’s operation differs from the envelope’s.',
  provisioning_auth: 'The provisioning credential is missing or wrong.',
  bad_proof: 'A registration proof doesn’t verify.',
  bad_time: 'A time in the request is out of range (registration `provisionedAt`, a period end).',
  too_large: 'The request body is too large.',
  wrong_environment: 'The registration names another environment.',
  // Operator API.
  operator_auth: 'The operator token is missing or wrong.',
  operator_permission: 'The operator lacks the permission.',
  release_exists: 'The release is already registered.',
  release_not_found: 'No such release.',
  release_not_approved: 'The release isn’t approved (quarantined or retired).',
  rollout_not_found: 'No such rollout.',
  rollout_open: 'Another rollout is open.',
  rollout_not_active: 'The rollout isn’t active.',
  rollout_not_paused: 'The rollout isn’t paused.',
  rollout_finished: 'The rollout is finished.',
  bad_waves: 'The waves are inconsistent.',
  unknown_cohort: 'A wave names an unknown cohort.',
  worker_not_found: 'No such relay worker.',
  alert_not_found: 'No such alert (404, CT-141).',
  registration_not_found: 'No such pending re-registration (404, CT-141).',
  remote_help_off:
    '`operator.supportOpen` and `operator.supportTicket` for a device without a status report of the last 15 minutes whose remote help is on (409, CT-947).',
  support_unavailable: '`operator.supportOpen` on a control without a support CA key (503, CT-947).',
  nothing_to_retry:
    '`operator.retryDevice` for a device without a `failed_before` hold for that release (409, CT-147).',
  invalid_json: 'The body isn’t JSON.',
  // Billing, trials and signups (BL-13…BL-28, CT-106…CT-109).
  billing_setup_required:
    'The org is waiting for a plan (BL-13): `claims.start` and cohort opt-in answer 403 until its account subscribes on the Billing page.',
  trial_used_device:
    '`claims.start` by a trialing org for a device that already had a trial in another org (409, BL-17); `details.canStartNow` says `billing.startNow` would let the claim through.',
  subscription_exists:
    '`billing.checkout`, or `link.checkout` (4.9), while the org has a live Stripe subscription (409): use the portal.',
  subscription_live:
    '`operator.setPlan`, `operator.deleteOrg`, `operator.deleteAccount` and `accounts.delete` while the org (or one of the account’s orgs) has a live Stripe subscription (409): cancel it first.',
  no_subscription:
    'The org has no Stripe customer or subscription for this (409); `link.portal` answers it until Stripe has the Link subscription (4.9): pay through `link.checkout`.',
  manual_billing:
    'The org’s plan is managed by Whombat (the manual provider or an operator’s plan): no checkout, portal, Whombats change or start-now (409). At `link.checkout` (4.9): a free account, nothing to pay.',
  not_trialing: 'The org isn’t trialing (`billing.startNow`, `operator.extendTrial`; 409).',
  plan_unavailable: '`billing.checkout` for an unknown or non-public plan (400).',
  plan_not_found: 'No such plan (operator; 404).',
  whombats_below_claimed:
    '`billing.whombats` below the number of claimed Whombats (409): release or retire one first.',
  billing_provider_error: 'Stripe refused or didn’t answer (503); retry.',
  billing_provider_refused: 'Stripe refused the change for good (503, 4.9): trying again won’t help.',
  signup_code_required: '`orgs.create` in `waitlist` or `invite` mode without a code (403, BL-21).',
  signup_code_invalid:
    '`orgs.create` with an unknown, used, expired or revoked code (403; one answer for all, BL-21).',
  signup_code_other_email:
    '`orgs.create` with an active code bound to another email address than the signed-in account’s (403, BL-34).',
  terms_outdated:
    '`orgs.create`, `link.confirm` (4.7), `link.checkout` or `link.portal` (4.8) with another Subscription Terms version than `SUBSCRIPTION_TERMS_VERSION` (409, BL-21); reload the terms.',
  promotion_code_invalid:
    '`link.checkout` on 4.8 with a `promotionCode` that is unknown, stopped, used up or expired, a months-code on the yearly price, or while a discount is already applied (400). A control on 4.9 answers `promotion_code_on_payment_page` instead.',
  promotion_code_on_payment_page:
    '`link.checkout` with a non-empty `promotionCode` (400, 4.9): codes are typed in the payment page’s own field.',
  checkout_busy:
    '`link.checkout` or `link.portal` while another billing change of the account runs (409, 4.8; the portal from 4.9); try again in a moment.',
  waitlist_closed: '`signup.waitlist` outside `waitlist` mode (409, BL-23).',
  // Operator panel and customers (BL-27, BL-28).
  operator_session_invalid: 'The panel session cookie is missing, expired or revoked (401): sign in again.',
  panel_header_required: 'A non-GET panel request without `X-Whombat-Panel: 1` (403, CSRF).',
  invalid_credentials:
    'Panel sign-in with an unknown username or a wrong password (401; one answer for both).',
  account_not_found: 'No such cloud account (operator; 404).',
  waitlist_entry_not_found: 'No such waitlist entry (404).',
  waitlist_entry_not_waiting: 'The waitlist entry was already invited or removed (409).',
  signup_code_not_found: 'No such signup code (404).',
  signup_code_not_resendable:
    '`operator.resendSignupCode` for a code without an email address, or one that is used or revoked (409, BL-35).',
  // Feedback drop (Whombat FD-17 … FD-21).
  feedback_drop_off:
    'The feedback drop is switched off on this control service (`FEEDBACK_DROP`): its device ops answer 404 with this reason and the manager reports them as unsupported.',
} as const;
export type ControlReason = keyof typeof CONTROL_REASONS;

/** `error.details.code` names: `lower_snake`. */
export const ControlReasonName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

export const ControlErrorBody = z.object({
  error: z.object({
    code: ControlErrorCode,
    message: z.string().max(500),
    retryAfterS: z.number().int().min(0).max(86_400).optional(),
    /**
     * `code`: the precise reason (`CONTROL_REASONS`, open set). A few reasons carry more (CT-108): `canStartNow` with
     * `trial_used_device`, `allowed` (the plan's `devicesAllowed`) with `devices_allowed_reached`.
     */
    details: z
      .object({
        code: ControlReasonName,
        canStartNow: z.boolean().optional(),
        allowed: z.number().int().min(0).max(10_000).optional(),
      })
      .optional(),
  }),
});
export type ControlErrorBody = z.infer<typeof ControlErrorBody>;
