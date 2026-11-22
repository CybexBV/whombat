/** Device directory, claim coordination and client tickets (MA-04 §2, MA-06) — the cloud UI side. */

import { AdmissionJwks, ClaimMethod, RelayClass, TicketChannel } from '@whombat/protocol';
import { PeerIdString } from '@whombat/protocol/session';
import { EpochSeconds, Ident } from '@whombat/release';
import { z } from 'zod';
import { AccountId, ClaimId, DeviceId, DisplayName, HardwareModel, HardwareSerial, OrgId } from './common.js';
import { TicketResponse } from './device/ops.js';
import { DeviceRegistration, DeviceRegistrationResponse } from './device/provisioning.js';
import { DeviceStatusReport, RevocationReport } from './device/status.js';
import { controlEndpoint } from './endpoint.js';

export const DeviceState = z.enum(['unclaimed', 'claim_pending', 'claimed', 'retired']);
export type DeviceState = z.infer<typeof DeviceState>;

/** How the device got into the directory (CC-10): factory provisioning, or self-registration (the ISO). */
export const DeviceOrigin = z.enum(['factory', 'self']);
export type DeviceOrigin = z.infer<typeof DeviceOrigin>;

export const DirectoryDevice = z.object({
  device: DeviceId,
  state: DeviceState,
  origin: DeviceOrigin,
  org: OrgId.nullable(),
  /** Set by the org in the cloud UI, never by the device. */
  name: DisplayName.nullable(),
  model: HardwareModel,
  hardwareSerial: HardwareSerial,
  contentPeerId: PeerIdString,
  registeredAt: EpochSeconds,
  claimedAt: EpochSeconds.nullable(),
  lastSeenAt: EpochSeconds.nullable(),
  /** Last field-allowlisted status report. */
  status: DeviceStatusReport.nullable(),
  revocations: z.array(RevocationReport).max(100),
  /**
   * The box was linked by a code at its own address (4.3; Whombat own-address.md): the account's page shows its name
   * only, never the address. Absent from a control before 4.3 (read as false).
   */
  ownAddress: z.boolean().optional(),
});
export type DirectoryDevice = z.infer<typeof DirectoryDevice>;

/**
 * The version of the Whombat Appliance Terms a claimer accepts in `claims.start` (LC-17, LC-18). Control accepts only
 * this version; changing the terms means a new id, and so a contracts release. The text is the hosted app's
 * `/legal/appliance-terms`. `2026-11-19`: for people and businesses; the Whombat software is open source (AGPL-3.0,
 * Cybex BV) and works fully without Whombat Link, which adds the address, push and the apps away from home; updates
 * come from Production or Beta, and Ask before updating holds them. `2026-11-22` adds the seller's details, Claude Code
 * downloaded from Anthropic, only the keys a self-installed Whombat has, and the Dutch voice's use restrictions.
 */
export const APPLIANCE_TERMS_VERSION = '2026-11-22';

/** A terms version id: the date, optionally followed by a qualifier (`2026-09-26-draft`). */
export const TermsVersion = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,16})?$/);

/** “I agree to the Whombat Appliance Terms”, ticked before the claim (LC-18). */
export const ClaimTerms = z.strictObject({ version: TermsVersion });
export type ClaimTerms = z.infer<typeof ClaimTerms>;

export const ClaimState = z.enum(['pending', 'claimed', 'expired', 'cancelled']);
export const PendingClaim = z.object({
  claim: ClaimId,
  device: DeviceId,
  org: OrgId,
  requestedBy: AccountId,
  state: ClaimState,
  createdAt: EpochSeconds,
  expiresAt: EpochSeconds,
  /** How the claim is authenticated on the appliance (CC-02): the PAKE password is the console letters or the card. */
  method: ClaimMethod,
  /**
   * The directory's PeerId: the client pins it for the Noise handshake and binds it into the claim PAKE (CC-06), which
   * is what authenticates it; nobody compares it by hand any more.
   */
  contentPeerId: PeerIdString,
  /** The terms version the claimer accepted (0.10, LC-18); absent on claims made before. */
  termsVersion: TermsVersion.optional(),
  /** When control recorded the acceptance (control's clock). */
  termsAcceptedAt: EpochSeconds.optional(),
});
export type PendingClaim = z.infer<typeof PendingClaim>;

/**
 * One pending claim per device; a newer one supersedes an older one (the appliance completes whichever claim id the
 * winning PAKE presented, CT-27).
 */
export const CLAIM_PENDING_TTL_S = 900;

/**
 * Claim-code limits at control (CC-03…CC-05, CC-10). Lookup leases: `claim.lookup` renews every `lookupRenewS`; a lease
 * not renewed for `lookupIdleReleaseS` is released; 4 digits until more than `lookupFourDigitMax` leases are live.
 * Discovery: a device counts as nearby when its network tag was seen within `nearbyWindowS`. `claims.start` with
 * `method: 'code'` spends per-account, per-IP and per-device budgets (per hour; an org has one account, CT-1560). Self-registration: per IP per
 * hour and per day; unclaimed, unseen self-registered devices retire after `selfUnclaimedRetireS`.
 */
export const CLAIM_CODE_LIMITS = {
  lookupRenewS: 300,
  lookupIdleReleaseS: 86_400,
  lookupFourDigitMax: 5_000,
  nearbyWindowS: 900,
  codeStartsPerAccountPerHour: 10,
  codeStartsPerIpPerHour: 20,
  codeStartsPerDevicePerHour: 30,
  selfRegistrationsPerIpPerHour: 5,
  selfRegistrationsPerIpPerDay: 20,
  selfUnclaimedRetireS: 604_800,
} as const;

/** The model a self-registered device (the ISO, CC-10) registers with. */
export const SELF_INSTALLED_MODEL = 'self-installed';

/** `claims.start` with the factory card (CC-05): control checks `claimProof` against the registered verifier. */
export const ClaimStartCard = z.strictObject({
  method: z.literal('card'),
  device: DeviceId,
  claimProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  class: RelayClass.default('interactive'),
  /** The accepted appliance terms (0.10, LC-18; `terms_required` without them or for another version). */
  terms: ClaimTerms,
});
/** `claims.start` with the console code for a device `claims.nearby` lists for this caller (`device_not_nearby`). */
export const ClaimStartCodeNearby = z.strictObject({
  method: z.literal('code'),
  device: DeviceId,
  class: RelayClass.default('interactive'),
  /** As for the card form. */
  terms: ClaimTerms,
});
/**
 * The `claims.start` body (CC-05, CC-13): a card, or the console code for a device `claims.nearby` lists for this
 * caller. Claiming by code works only from the box's own network (CC-13, CT-67): there is no lookup-number form.
 */
export const ClaimStartBody = z.discriminatedUnion('method', [ClaimStartCard, ClaimStartCodeNearby]);
export type ClaimStartBody = z.input<typeof ClaimStartBody>;

/** An unclaimed device on the caller's public network (CC-04). The lookup number is never listed. */
export const NearbyDevice = z.object({
  device: DeviceId,
  model: HardwareModel,
  registeredAt: EpochSeconds,
  lastSeenAt: EpochSeconds.nullable(),
});
export type NearbyDevice = z.infer<typeof NearbyDevice>;

/**
 * The device's claim verifier (MA-19d, CT-43), registered by provisioning right after `devices.register` (the device
 * id is control's, so the verifier can only be computed then): `claimVerifier(deviceId, normalizedSecret)` from
 * `@whombat/protocol` (Go `protocol.ClaimVerifier`). Control stores it once (the identical value again: 200; a
 * different one: 409 `claim_verifier_exists`) and opens no claim for a device without one (`claim_verifier_missing`).
 */
export const ClaimVerifierRegistration = z.strictObject({
  claimVerifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const ClientTicketRequest = z.strictObject({
  device: DeviceId,
  channel: TicketChannel,
  class: RelayClass,
});

export const directoryApi = {
  register: controlEndpoint({
    id: 'devices.register',
    method: 'POST',
    path: '/provisioning/devices',
    auth: 'provisioning',
    summary:
      'Factory registration of an unclaimed device (both key proofs checked): 201, or 200 when the identical registration is repeated; `device_exists` (409) for another device with this serial or key.',
    body: DeviceRegistration,
    response: DeviceRegistrationResponse,
    status: 201,
  }),
  registerClaimVerifier: controlEndpoint({
    id: 'devices.registerClaimVerifier',
    method: 'POST',
    path: '/provisioning/devices/:device/claim-verifier',
    auth: 'provisioning',
    summary:
      'Register the device’s claim verifier (derived from the card’s secret; control never sees the secret): 201, 200 for the identical value again.',
    body: ClaimVerifierRegistration,
    response: z.object({ ok: z.literal(true) }),
    status: 201,
  }),
  list: controlEndpoint({
    id: 'devices.list',
    method: 'GET',
    path: '/orgs/:org/devices',
    auth: 'session',
    summary: 'Devices of the org with their last status (metadata only).',
    response: z.object({ devices: z.array(DirectoryDevice).max(1_000) }),
  }),
  rename: controlEndpoint({
    id: 'devices.rename',
    method: 'PUT',
    path: '/orgs/:org/devices/:device',
    auth: 'session',
    summary: 'Name a device in the directory.',
    body: z.strictObject({ name: DisplayName }),
    response: DirectoryDevice,
  }),
  selfRegister: controlEndpoint({
    id: 'devices.selfRegister',
    method: 'POST',
    path: '/devices/self-register',
    auth: 'none',
    summary:
      'Self-registration of an unclaimed device without a factory (the ISO, CC-10): the same registration with both key proofs and `model: "self-installed"`. Only when control runs with `SELF_REGISTRATION=1` (`self_registration_disabled`, 403 otherwise); rate-limited per IP (`CLAIM_CODE_LIMITS`). The device gets `origin: "self"`, no claim verifier (so only `method: "code"` can claim it), and is retired when it stays unclaimed and unseen for 7 days. 201, or 200 when the identical registration is repeated; `device_exists` (409) as for factory registration.',
    body: DeviceRegistration.extend({ model: z.literal(SELF_INSTALLED_MODEL) }),
    response: DeviceRegistrationResponse,
    status: 201,
  }),
  startClaim: controlEndpoint({
    id: 'claims.start',
    method: 'POST',
    path: '/orgs/:org/claims',
    auth: 'session',
    summary:
      'Record a pending claim and issue an enrollment-channel client ticket (CC-05). `method: "card"`: `claimProof` = `claimVerifier(device, normalizedSecret)` from the card, compared in constant time with the registered verifier (`claim_proof_invalid`, `claim_verifier_missing`). `method: "code"`: only a device `claims.nearby` lists for this caller (`device_not_nearby`, 403); claiming by code works only from the box’s own network (CC-13). The code form spends per-account, per-IP and per-device budgets (`rate_limited`). A claimed device: `already_claimed` (409). Every body carries `terms: {version}` (LC-18): only `APPLIANCE_TERMS_VERSION` is accepted (`terms_required`, 400); control records the version and its own time on the claim and in the `claim.created` audit detail. A self-registered device (`origin: "self"`) needs `Entitlement.selfInstall` (`self_install_not_allowed`, 403, LC-15). `devicesAllowed` counts live claimed devices plus other pending claims of the org, checked again inside the claim transaction (`devices_allowed_reached`, 403, LC-16). A newer pending claim supersedes an older one. Admitting a claimer never grants ownership: the appliance decides through the claim PAKE. A device with an own-address label and no org is refused with `claim_at_address` (409, 4.3): it is set up at its own address.',
    body: ClaimStartBody,
    response: z.object({ claim: PendingClaim, ticket: TicketResponse }),
  }),
  nearbyClaims: controlEndpoint({
    id: 'claims.nearby',
    method: 'GET',
    path: '/orgs/:org/claims/nearby',
    auth: 'session',
    summary:
      'Unclaimed devices on the caller’s public network (CC-04): same keyed network tag (IPv4 address or IPv6 /64 after the trusted proxy hops), seen within 15 minutes, with a live lookup lease. At most 20, most recently seen first; the lookup number is not listed. Devices with an own-address label are left out (4.3). Rate-limited per account and per IP. Route it before `/orgs/:org/claims/:claim` (claim ids are ≥ 8 characters, so `nearby` never is one).',
    response: z.object({ devices: z.array(NearbyDevice).max(20) }),
  }),
  getClaim: controlEndpoint({
    id: 'claims.get',
    method: 'GET',
    path: '/orgs/:org/claims/:claim',
    auth: 'session',
    summary: 'One claim of the org (to follow a ceremony).',
    response: z.object({ claim: PendingClaim }),
  }),
  cancelClaim: controlEndpoint({
    id: 'claims.cancel',
    method: 'DELETE',
    path: '/orgs/:org/claims/:claim',
    auth: 'session',
    summary: 'Cancel a pending claim.',
    response: z.object({ ok: z.literal(true) }),
  }),
  ticket: controlEndpoint({
    id: 'tickets.client',
    method: 'POST',
    path: '/orgs/:org/tickets',
    auth: 'session',
    summary:
      'A single-use client ticket for a device of the org (routing only; the appliance authenticates).',
    body: ClientTicketRequest,
    response: TicketResponse,
  }),
  jwks: controlEndpoint({
    id: 'admission.jwks',
    method: 'GET',
    path: '/admission/jwks',
    auth: 'none',
    summary: 'Admission public keys for relays (JWKS, rotated with overlap).',
    response: AdmissionJwks,
  }),
};

/** Relay worker registry entry (operator view). */
export const RelayWorker = z.object({
  worker: Ident,
  url: z.string().min(8).max(256),
  region: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9-]+$/),
  state: z.enum(['active', 'draining', 'down']),
  sessions: z.number().int().min(0).max(1_000_000),
});
export type RelayWorker = z.infer<typeof RelayWorker>;
