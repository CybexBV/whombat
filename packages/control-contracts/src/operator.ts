/**
 * Operator API additions (CT-33; control's separate operator listener, `auth: 'operator'`, permissions per
 * endpoint): release registration, rollout listing/stop/promotion, fleet (devices, internal flag, retire,
 * release), relay worker drain, entitlements, audit and retention.
 */
import { RemoteHelpLevel, RemoteHelpWho, SshEd25519PublicKey } from '@whombat/protocol/session';
import {
  EpochSeconds,
  GitCommit,
  Ident,
  ReleaseId,
  ReleaseTuple,
  Sha256Hex,
  UpdateFailureDetail,
  UpdateJournalState,
  UpdateWaitReason,
  VersionString,
} from '@whombat/release';
import { z } from 'zod';
import {
  BillingProviderName,
  Entitlement,
  EntitlementState,
  Plan,
  PlanAmountCents,
  PlanId,
  PlanLimit,
  PlanName,
  SignupMode,
  TrialDays,
} from './billing.js';
import {
  AccountId,
  CohortId,
  Cursor,
  DeviceId,
  DisplayName,
  Email,
  HardwareModel,
  OrgId,
  Page,
  RelayWorkerId,
} from './common.js';
import { TicketResponse } from './device/ops.js';
import { DeviceOrigin, DeviceState, DirectoryDevice, TermsVersion } from './directory.js';
import { controlEndpoint } from './endpoint.js';
import { OrgAuditEvent } from './orgs.js';
import { ReleaseStatus, Rollout } from './rollout.js';
import { SignupCodeDisplay, SignupCodeHint } from './signup.js';

export const OperatorReasonBody = z.strictObject({ reason: Ident });

const Count = z.number().int().min(0);

const Schema = z.number().int().min(0).max(1_000_000);

/** One pipeline stage's record (`build.json`, `gates.json`, `upgrade-gates.json`, `dev-soak.json`; UP-C1). */
export const ReleaseGate = z.object({
  ok: z.boolean(),
  at: EpochSeconds,
  /** sha256 of the stage's record file. */
  sha256: Sha256Hex,
  summary: z.string().max(500),
});
export type ReleaseGate = z.infer<typeof ReleaseGate>;

/**
 * What control keeps with a release besides its signed tuple (CT-139, UP-X02, UP-C3): the notes, its migrations with
 * class and floors, the DEV twin, the pipeline's
 * gates and where it was built from. Not signed (the tuple is); it arrives stage by stage from `release/ship`.
 */
export const ReleaseRecord = z.object({
  /** `notes.json`: `summary` is what the app shows (`rollout.releaseSummary`), `markdown` the operator's notes. */
  notes: z.object({ summary: z.string().max(500), markdown: z.string().max(20_000) }).optional(),
  /** The runtime's migrations (Whombat `compat.json`): tag, class (`expand`, `backfill`, `contract`, …), floors. */
  migrations: z
    .array(
      z.object({
        tag: z.string().max(80),
        class: z.string().max(16),
        readers: Schema,
        writers: Schema,
        version: Schema,
      }),
    )
    .max(1_000)
    .optional(),
  /** The DEV twin of a PROD release (UP-C1), or the PROD release of a twin. */
  twin: ReleaseId.optional(),
  env: z.enum(['dev', 'prod']).optional(),
  gates: z
    .object({
      build: ReleaseGate.optional(),
      validate: ReleaseGate.optional(),
      upgradeGates: ReleaseGate.optional(),
      devSoak: ReleaseGate.optional(),
    })
    .optional(),
  builtFrom: z
    .object({
      appliance: GitCommit,
      whombat: GitCommit.optional(),
      /** whombat-app and contracts versions (`0.12.0`). */
      app: z.string().max(40).optional(),
      contracts: z.string().max(40).optional(),
    })
    .optional(),
  knownIssues: z.array(z.string().max(300)).max(20).optional(),
  /**
   * The releases a custody rollback may leave (CT-144, UP-B2): copied by the publisher from the release's TUF-signed
   * `custom.whombat.allowDowngradeFrom`. Control uses it only to *offer* this older release to devices that run one of
   * these ids (an exception to `notOlder`, UP-X03); the box still verifies the TUF-signed list itself, so control alone
   * can never downgrade a device.
   */
  allowDowngradeFrom: z.array(ReleaseId).max(16).optional(),
});
export type ReleaseRecord = z.infer<typeof ReleaseRecord>;

export const RegisteredRelease = ReleaseStatus.extend({
  tupleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** The release record (CT-139); absent until one arrives. */
  record: ReleaseRecord.optional(),
  /** From the tuple: component versions and the runtime's schema. */
  versions: z.object({ host: VersionString, runtime: VersionString, manager: VersionString }).optional(),
  schemaWrites: Schema.optional(),
  createdAt: EpochSeconds.optional(),
});
export type RegisteredRelease = z.infer<typeof RegisteredRelease>;

export const OperatorRelayWorker = z.object({
  worker: RelayWorkerId,
  url: z.string().min(8).max(256),
  draining: z.boolean(),
  updatedAt: EpochSeconds.nullable(),
});

/** An operator id as in `operators.json`. */
export const OperatorId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export const OperatorAuditEvent = z.object({
  at: EpochSeconds,
  operator: OperatorId,
  action: z.string().min(1).max(64),
  target: z.string().max(128).nullable(),
  detail: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])),
});

/**
 * Every member but `state` is optional: an absent member keeps the org's current value, and for an org without an
 * entitlement row the configured default (`DEFAULT_PLAN`, `DEFAULT_DEVICES_ALLOWED`, `DEFAULT_SELF_INSTALL`; the
 * limits default to null = unlimited). An explicit null limit sets it to unlimited (0.10, LC-11, LC-15).
 */
export const SetEntitlementBody = z.strictObject({
  state: EntitlementState,
  plan: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  devicesAllowed: z.number().int().min(0).max(10_000).optional(),
  currentPeriodEnd: EpochSeconds.nullable().optional(),
  limits: z
    .strictObject({
      connectors: PlanLimit.optional(),
    })
    .optional(),
  selfInstall: z.boolean().optional(),
});

// ── Rollout devices, fleet, alerts, re-registrations (CT-140, CT-141) ──

/**
 * One device of a rollout (CT-140): where it stands with the rollout's release. `hold` is why control holds it back
 * (an open set): `manager_too_old` (UP-E6: a migrating release for a manager below 0.2.0), `failed_before` (it failed
 * this release already), `not_older` (it runs something newer, UP-X03), `emergency_stop`, `quarantined`.
 */
export const RolloutDevice = z.object({
  device: DeviceId,
  org: OrgId.nullable(),
  cohort: CohortId,
  /** The wave that includes it, null while no wave does. */
  wave: z.number().int().min(0).max(100).nullable(),
  state: UpdateJournalState.nullable(),
  attempt: z.number().int().min(0).max(100),
  failure: Ident.nullable(),
  failureDetail: UpdateFailureDetail.nullable(),
  hold: Ident.nullable(),
  managerVersion: VersionString.nullable(),
  updatedAt: EpochSeconds.nullable(),
  /** Why its staged candidate waits, from its last report (CT-147); absent when it doesn't wait. */
  waiting: z.object({ reason: UpdateWaitReason, since: EpochSeconds }).optional(),
});
export type RolloutDevice = z.infer<typeof RolloutDevice>;

/**
 * `GET /operator/fleet` (CT-141, UP-B4, UP-G3): what the hosted deploys check before they ship and what
 * `release/ship status` prints. `devices.total` counts devices that aren't retired, `live` those that reported in the
 * last 24 h, `unseen24h` claimed devices that didn't. `releases`: the releases live devices run.
 */
export const FleetSummary = z.object({
  generatedAt: EpochSeconds,
  /** `backupUnconfigured` (CT-147): claimed devices whose last report says no backup destination. */
  devices: z.object({ total: Count, live: Count, unseen24h: Count, backupUnconfigured: Count.optional() }),
  releases: z
    .array(
      z.object({
        release: ReleaseId,
        devices: Count,
        managerVersions: z.array(VersionString).max(16),
      }),
    )
    .max(10_000),
  /** Open rollouts (active or paused). */
  rollouts: z.array(Rollout).max(1_000),
  /** `mail` (CT-147): whether control mails alerts (`OPERATOR_ALERT_EMAILS` set). */
  alerts: z.object({ open: Count, critical: Count, mail: z.boolean().optional() }),
});
export type FleetSummary = z.infer<typeof FleetSummary>;

/** Alert kinds (CT-141, UP-G2). */
export const OPERATOR_ALERT_KINDS = [
  'rollout_paused',
  'rollout_stopped',
  'device_update_failed',
  'device_unseen',
  'tuf_timestamp_stale',
  'tuf_expiring',
  'client_channel_expiring',
  'backup_failing',
  /** An active rollout that hasn't moved (no activation, no promotion) for longer than its window allows (CT-147). */
  'rollout_stalled',
] as const;
export const OperatorAlertKind = z.enum(OPERATOR_ALERT_KINDS);
export type OperatorAlertKind = z.infer<typeof OperatorAlertKind>;

/**
 * An operator alert (CT-141, UP-G2): one per kind and subject (deduplicated), resolved automatically when the
 * condition clears, mailed to `OPERATOR_ALERT_EMAILS` when opened. `subject` names what it is about (a rollout, a
 * device, a repository); `detail` is plain text for people.
 */
export const OperatorAlert = z.object({
  id: Ident,
  kind: OperatorAlertKind,
  severity: z.enum(['warning', 'critical']),
  subject: z.string().max(120),
  detail: z.string().max(500),
  openedAt: EpochSeconds,
  lastSeenAt: EpochSeconds,
  resolvedAt: EpochSeconds.nullable(),
  acknowledgedAt: EpochSeconds.nullable(),
  acknowledgedBy: OperatorId.nullable(),
});
export type OperatorAlert = z.infer<typeof OperatorAlert>;

export const OperatorAlertsQuery = z.object({ state: z.enum(['open', 'all']).optional() });

/**
 * A pending re-registration (CT-141, UP-E5): a self-registration refused because a live record holds the same
 * hardware serial (a reinstalled box). Retiring the existing record lets the box's next attempt register.
 */
export const PendingRegistration = z.object({
  id: Ident,
  existingDevice: DeviceId,
  /** The existing record's state (`claimed`, `unclaimed`, …). */
  existingState: z.string().max(32),
  attempts: Count,
  firstAt: EpochSeconds,
  lastAt: EpochSeconds,
});
export type PendingRegistration = z.infer<typeof PendingRegistration>;

// ── Operator sessions and permissions (BL-27, BL-28) ──

/**
 * The permissions control knows (an operator's `permissions` in `operators.json`). The panel hides what the signed-in
 * operator's permissions don't allow. `billing.write` covers entitlements, plans of an org, trials and subscriptions;
 * `plans.write` the plan table; `signup.write` the waitlist and signup codes; `settings.write` the live settings;
 * `support` remote help into a device whose person turned it on (0.120).
 */
export const OPERATOR_PERMISSIONS = [
  'fleet.read',
  'fleet.write',
  'releases.write',
  'rollouts.write',
  'rollouts.emergency_stop',
  'relay.drain',
  'billing.write',
  'audit.read',
  'retention.run',
  'customers.read',
  'customers.write',
  'signup.write',
  'plans.write',
  'settings.write',
  /** Remote help (0.120, CT-946): certificates and client tickets for a device's support route. */
  'support',
] as const;
export const OperatorPermission = z.enum(OPERATOR_PERMISSIONS);
export type OperatorPermission = z.infer<typeof OperatorPermission>;

/** A permission name in an answer: an open set, so a newer control may add permissions an older panel ignores. */
export const OperatorPermissionName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);

/** The panel's session cookie (HttpOnly, SameSite=Strict, Path=/, Secure outside `local`; BL-27). */
export const OPERATOR_SESSION_COOKIE = 'wb_op';
/** Every non-GET panel request carries this header with the value `1` (CSRF, BL-27). */
export const OPERATOR_PANEL_HEADER = 'X-Whombat-Panel';
/** A panel session lasts 12 hours (BL-27). */
export const OPERATOR_SESSION_TTL_S = 12 * 3600;

/** A panel username (BL-27): 1…64 of `a-z 0-9 . _ -`. */
export const OperatorUsername = z.string().regex(/^[a-z0-9._-]{1,64}$/);

/** Panel sign-in (BL-27): username and password, from an allowlisted address. The password is never trimmed. */
export const OperatorSignInBody = z.strictObject({
  username: OperatorUsername,
  password: z.string().min(1).max(256),
});
export type OperatorSignInBody = z.infer<typeof OperatorSignInBody>;

/** Who is signed in to the panel (or, on the bearer listener, whose token it is). */
export const OperatorSession = z.object({
  operator: OperatorId,
  /** The panel username (for a bearer token, the operator id). */
  username: OperatorUsername,
  permissions: z.array(OperatorPermissionName).max(64),
});
export type OperatorSession = z.infer<typeof OperatorSession>;

// ── Customers (BL-28) ──

/** `GET /operator/overview` (`customers.read`): counts only, no revenue (BL-10). */
export const OperatorOverview = z.object({
  at: EpochSeconds,
  accounts: z.object({ total: Count, new7d: Count, new30d: Count }),
  orgs: z.object({
    total: Count,
    /** Every state, 0 included. */
    byState: z.record(EntitlementState, Count),
    /** Plans with at least one org (`none` = waiting for a plan). */
    byPlan: z.record(PlanId, Count),
    /** Orgs waiting for a plan (BL-13). */
    waitingForPlan: Count,
  }),
  /** Trials ending within 3 days. */
  trialsEndingSoon: Count,
  waitlistWaiting: Count,
  whombats: z.object({ claimed: Count, seen24h: Count }),
});
export type OperatorOverview = z.infer<typeof OperatorOverview>;

/** Another org, by id and name. */
export const OrgRef = z.object({ org: OrgId, name: DisplayName });
export type OrgRef = z.infer<typeof OrgRef>;

/** One row of `GET /operator/orgs` (BL-28). */
export const OperatorOrgRow = z.object({
  org: OrgId,
  name: DisplayName,
  /** The email of the org's account (one per org since 3.0, CT-1560); null if it has none left. */
  email: Email.nullable(),
  createdAt: EpochSeconds,
  plan: PlanId,
  /** The plan's name; null for `none` or a plan without a row. */
  planName: PlanName.nullable(),
  state: EntitlementState,
  provider: BillingProviderName,
  trialEndsAt: EpochSeconds.nullable(),
  currentPeriodEnd: EpochSeconds.nullable(),
  whombats: z.object({ claimed: Count, allowed: Count }),
  /** The most recent `lastSeenAt` of the org's Whombats. */
  lastSeenAt: EpochSeconds.nullable(),
  flags: z.object({
    /** Other orgs with a trial whose `network` mark matches (a signal, never a block; BL-17). */
    sameNetworkAs: z.array(OrgRef).max(10),
    /** The trial was ended early because the card or device had a trial before. */
    trialEndedEarly: z.boolean(),
  }),
});
export type OperatorOrgRow = z.infer<typeof OperatorOrgRow>;

export const OperatorOrgsQuery = z.object({
  /** The org's name or its account's email, case-insensitive substring. */
  q: z.string().trim().max(254).optional(),
  state: EntitlementState.optional(),
  plan: PlanId.optional(),
  cursor: Cursor.optional(),
});

/** Newest first, 50 per page. */
export const OperatorOrgPage = Page(OperatorOrgRow);
export type OperatorOrgPage = z.infer<typeof OperatorOrgPage>;

export const TrialMarkKind = z.enum(['account', 'device', 'card', 'network']);
export type TrialMarkKind = z.infer<typeof TrialMarkKind>;

/** A trial mark of the org (BL-17). The card fingerprint and the network tag are never shown. */
export const OperatorTrialMark = z.object({
  kind: TrialMarkKind,
  /** The account's email or the device id; null for `card` and `network`. */
  label: z.string().max(254).nullable(),
  createdAt: EpochSeconds,
  /** Other orgs with the same mark. */
  alsoUsedBy: z.array(OrgRef).max(20),
});
export type OperatorTrialMark = z.infer<typeof OperatorTrialMark>;

/** `GET /operator/orgs/:org` (`customers.read`), also the answer of every org action. */
export const OperatorOrgDetail = OperatorOrgRow.extend({
  /** The org's account (3.0, CT-1560); null if it has none left. */
  account: z.object({ account: AccountId, email: Email, joinedAt: EpochSeconds }).nullable(),
  devices: z
    .array(
      z.object({
        device: DeviceId,
        name: DisplayName.nullable(),
        model: HardwareModel,
        origin: DeviceOrigin,
        state: DeviceState,
        claimedAt: EpochSeconds.nullable(),
        lastSeenAt: EpochSeconds.nullable(),
      }),
    )
    .max(10_000),
  entitlement: Entitlement,
  billing: z.object({
    stripeCustomerId: z.string().max(255).nullable(),
    stripeSubscriptionId: z.string().max(255).nullable(),
    /** Stripe dashboard links (test or live per the key's mode). */
    customerUrl: z.string().max(512).nullable(),
    subscriptionUrl: z.string().max(512).nullable(),
    cancelAtPeriodEnd: z.boolean(),
  }),
  trialMarks: z.array(OperatorTrialMark).max(100),
  terms: z
    .array(
      z.object({
        account: AccountId,
        email: Email.nullable(),
        document: z.literal('subscription-terms'),
        version: TermsVersion,
        acceptedAt: EpochSeconds,
      }),
    )
    .max(100),
  /** The last 50 org audit events, newest first. */
  audit: z.array(OrgAuditEvent).max(50),
});
export type OperatorOrgDetail = z.infer<typeof OperatorOrgDetail>;

export const ExtendTrialBody = z.strictObject({ days: z.number().int().min(1).max(30) });
export type ExtendTrialBody = z.infer<typeof ExtendTrialBody>;

/** A manual plan (a comp) for an org (`billing.write`); `state` defaults to `active`. */
export const SetOrgPlanBody = z.strictObject({
  plan: PlanId,
  whombats: z.number().int().min(0).max(10_000),
  state: EntitlementState.optional(),
});
export type SetOrgPlanBody = z.infer<typeof SetOrgPlanBody>;

export const CancelSubscriptionBody = z.strictObject({ at: z.enum(['now', 'period_end']) });
export type CancelSubscriptionBody = z.infer<typeof CancelSubscriptionBody>;

/** Deleting an org (BL-31): the typed confirmation is the org's name (compared trimmed, case-insensitive). */
export const DeleteOrgBody = z.strictObject({ name: DisplayName });
export type DeleteOrgBody = z.infer<typeof DeleteOrgBody>;

export const OperatorOrgDeleted = z.object({
  ok: z.literal(true),
  /** Claimed Whombats that went back to unclaimed. */
  devicesReleased: z.number().int().min(0),
});
export type OperatorOrgDeleted = z.infer<typeof OperatorOrgDeleted>;

/** One row of `GET /operator/accounts` (BL-28). */
export const OperatorAccountRow = z.object({
  account: AccountId,
  email: Email,
  name: DisplayName.nullable(),
  createdAt: EpochSeconds,
  orgs: z.array(OrgRef).max(100),
  lastSignInAt: EpochSeconds.nullable(),
  disabled: z.boolean(),
});
export type OperatorAccountRow = z.infer<typeof OperatorAccountRow>;

export const OperatorAccountsQuery = z.object({
  /** Email or name, case-insensitive substring. */
  q: z.string().trim().max(254).optional(),
  cursor: Cursor.optional(),
});

/** Newest first, 50 per page. */
export const OperatorAccountPage = Page(OperatorAccountRow);
export type OperatorAccountPage = z.infer<typeof OperatorAccountPage>;

/** Deleting an account (BL-32): the typed confirmation is the account's email (compared case-insensitive). */
export const OperatorDeleteAccountBody = z.strictObject({ email: Email });
export type OperatorDeleteAccountBody = z.infer<typeof OperatorDeleteAccountBody>;

export const OperatorAccountDeleted = z.object({
  ok: z.literal(true),
  /** Its orgs, deleted with it. */
  orgsDeleted: z.number().int().min(0),
  /** Claimed Whombats of those orgs that went back to unclaimed. */
  devicesReleased: z.number().int().min(0),
});
export type OperatorAccountDeleted = z.infer<typeof OperatorAccountDeleted>;

// ── Live settings (BL-09, BL-29) ──

export const ControlSettings = z.object({
  signupMode: SignupMode,
  /** Self-registered devices (the ISO) may register (`SELF_REGISTRATION`). */
  selfRegistration: z.boolean(),
  /** The website feedback drop is on (`FEEDBACK_DROP`). */
  feedbackDrop: z.boolean(),
  trialDays: TrialDays,
});
export type ControlSettings = z.infer<typeof ControlSettings>;

/** `PUT /operator/settings`: absent members keep their value; at least one member. */
export const ControlSettingsUpdate = ControlSettings.partial()
  .strict()
  .refine((u) => Object.keys(u).length > 0, { message: 'Nothing to change.' });
export type ControlSettingsUpdate = z.infer<typeof ControlSettingsUpdate>;

// ── Waitlist and signup codes (BL-22, BL-23) ──

export const WaitlistStatus = z.enum(['waiting', 'invited', 'removed']);
export type WaitlistStatus = z.infer<typeof WaitlistStatus>;

export const WaitlistEntryId = Ident;
export const SignupCodeId = Ident;

export const WaitlistEntry = z.object({
  id: WaitlistEntryId,
  email: Email,
  company: z.string().max(120).nullable(),
  note: z.string().max(500).nullable(),
  status: WaitlistStatus,
  createdAt: EpochSeconds,
  invitedAt: EpochSeconds.nullable(),
  /** The hint of the code sent on approval. */
  codeHint: SignupCodeHint.nullable(),
  /** Orgs with a trial whose `network` mark matches the entry's network (a signal). */
  sameNetworkAs: z.array(OrgRef).max(10),
});
export type WaitlistEntry = z.infer<typeof WaitlistEntry>;

export const OperatorWaitlistQuery = z.object({
  status: WaitlistStatus.optional(),
  cursor: Cursor.optional(),
});

/** Oldest first (a queue), 100 per page. */
export const OperatorWaitlistPage = Page(WaitlistEntry);
export type OperatorWaitlistPage = z.infer<typeof OperatorWaitlistPage>;

/** Derived: `used` when `uses` reached `maxUses`; `revoked` wins over `expired`, which wins over `used`. */
export const SignupCodeStatus = z.enum(['active', 'used', 'expired', 'revoked']);
export type SignupCodeStatus = z.infer<typeof SignupCodeStatus>;

/** A signup code as the panel lists it: the hint only, never the code. */
export const SignupCode = z.object({
  id: SignupCodeId,
  hint: SignupCodeHint,
  note: z.string().max(500),
  /** A manual plan the code applies (no trial); null = the normal paid or manual trial path. */
  plan: PlanId.nullable(),
  /** `devicesAllowed` with a plan. */
  whombats: z.number().int().min(1).max(1_000),
  maxUses: z.number().int().min(1).max(1_000),
  uses: Count,
  expiresAt: EpochSeconds.nullable(),
  /** The operator, or `waitlist` for a code made by approving an entry. */
  createdBy: z.string().max(64),
  createdAt: EpochSeconds,
  revokedAt: EpochSeconds.nullable(),
  waitlistEntryId: WaitlistEntryId.nullable(),
  status: SignupCodeStatus,
  /** An invitation (BL-34): only the account with this address can use the code; null = anyone who holds it. */
  email: Email.nullable(),
  /** When control last emailed the code (an invitation, a resend, a waitlist approval); null = never. */
  sentAt: EpochSeconds.nullable(),
});
export type SignupCode = z.infer<typeof SignupCode>;

/** The answer to creating a code: the only time the code itself is shown. */
export const CreatedSignupCode = SignupCode.extend({
  code: SignupCodeDisplay,
  /** `${UI_URL}/signup#code=XXXX-XXXX`. */
  link: z.string().max(512),
});
export type CreatedSignupCode = z.infer<typeof CreatedSignupCode>;

/**
 * `expiresInDays` defaults to 30; `whombats` (default 1) matters only with a plan; `maxUses` defaults to 1. With
 * `email` the code is an invitation (BL-34): bound to that address, single-use, and emailed by control.
 */
export const CreateSignupCodeBody = z
  .strictObject({
    note: z.string().trim().min(1).max(200),
    email: Email.optional(),
    plan: PlanId.optional(),
    whombats: z.number().int().min(1).max(1_000).optional(),
    maxUses: z.number().int().min(1).max(1_000).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .refine((b) => b.email === undefined || b.maxUses === undefined || b.maxUses === 1, {
    message: 'An invitation is single-use: leave maxUses out or set it to 1.',
    path: ['maxUses'],
  });
export type CreateSignupCodeBody = z.infer<typeof CreateSignupCodeBody>;

export const OperatorSignupCodesQuery = z.object({ cursor: Cursor.optional() });

/** Newest first, 100 per page. */
export const OperatorSignupCodePage = Page(SignupCode);
export type OperatorSignupCodePage = z.infer<typeof OperatorSignupCodePage>;

// ── Plans (BL-11, BL-20) ──

/** A `plans` row as the panel shows it. */
export const OperatorPlan = Plan.extend({
  sort: z.number().int().min(0).max(10_000),
  stripeLookupKey: z.string().max(200).nullable(),
  /** Null until `stripe:setup` ran (or with the manual provider). */
  stripePriceId: z.string().max(255).nullable(),
  updatedAt: EpochSeconds,
});
export type OperatorPlan = z.infer<typeof OperatorPlan>;

/**
 * `PUT /operator/plans/:plan` (`plans.write`): absent members keep their value, and so do absent limits; an explicit
 * null limit means unlimited. A price change with Stripe configured creates a new Stripe price (BL-20). At least one
 * member.
 */
export const PlanUpdate = z
  .strictObject({
    name: PlanName.optional(),
    amountCents: PlanAmountCents.optional(),
    limits: z
      .strictObject({
        connectors: PlanLimit.optional(),
      })
      .optional(),
    public: z.boolean().optional(),
  })
  .refine((u) => Object.keys(u).length > 0, { message: 'Nothing to change.' });
export type PlanUpdate = z.infer<typeof PlanUpdate>;

// ── Remote help (0.120, CT-946…CT-948; Whombat remote-help.md RH-05, RH-06, RH-09) ──

/**
 * The support person's own key, as `ssh-keygen -t ed25519` writes it: `ssh-ed25519 AAAA…` and an optional comment
 * (printable ASCII). Control signs a certificate for it; the private key never leaves the support person's machine.
 */
export const SupportPublicKey = z
  .string()
  .max(181)
  .regex(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}( [\x20-\x7e]{1,100})?$/);

/** An OpenSSH Ed25519 user certificate line, `ssh-ed25519-cert-v01@openssh.com AAAA…`. */
export const SshEd25519Certificate = z
  .string()
  .max(4_096)
  .regex(
    /^ssh-ed25519-cert-v01@openssh[.]com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29t[A-Za-z0-9+/]+={0,2}$/,
  );

/**
 * `support.open`'s body: the key to certify and the name the person reads (“Claude”, display text of 1…40; RH-07, “who”).
 * Control writes the certificate's key id as `<name> (<operator>[ via <panel user>])`; the box shows only the name.
 */
export const SupportOpenBody = z.strictObject({ publicKey: SupportPublicKey, name: RemoteHelpWho });
export type SupportOpenBody = z.infer<typeof SupportOpenBody>;

/**
 * A certificate for one visit (RH-07) and how to reach the box: `certificate` (user certificate, principal the device id,
 * valid from 60 s ago until `validBefore`, extensions `permit-pty` and `permit-port-forwarding`), `principal` the device
 * id, `hostKey` the support service's key from the last report (pin it: never trust the relay), the grant's `level` and
 * seconds left (`untilS`, null: forever) as last reported, whether the box needs the help code (`helpCodeRequired`: the
 * SSH user name), and a client ticket for the device's support route.
 */
export const SupportOpenResponse = z.object({
  certificate: SshEd25519Certificate,
  validBefore: z.iso.datetime({ offset: true }),
  principal: DeviceId,
  hostKey: SshEd25519PublicKey,
  level: RemoteHelpLevel,
  untilS: z.number().int().min(0).max(604_800).nullable(),
  helpCodeRequired: z.boolean(),
  ticket: TicketResponse,
});
export type SupportOpenResponse = z.infer<typeof SupportOpenResponse>;

const Ok = z.object({ ok: z.literal(true) });

export const operatorApi = {
  registerRelease: controlEndpoint({
    id: 'operator.registerRelease',
    method: 'POST',
    path: '/operator/releases',
    auth: 'operator',
    summary:
      'Register a TUF-approved tuple so rollouts can choose it (control computes `tupleDigest`): 201, or 200 for the identical tuple again (a `record` given then is stored as `setReleaseRecord` stores it); `release_exists` (409) for another tuple under the same id.',
    body: z.strictObject({ tuple: ReleaseTuple, record: ReleaseRecord.optional() }),
    response: RegisteredRelease,
    status: 201,
  }),
  setReleaseRecord: controlEndpoint({
    id: 'operator.setReleaseRecord',
    method: 'PUT',
    path: '/operator/releases/:release/record',
    auth: 'operator',
    summary:
      'Store a release’s record as it arrives stage by stage (`releases.write`, CT-139): members given replace the stored ones, absent members keep theirs, and `gates` merges gate by gate. Refuses `release_not_found` (404).',
    body: ReleaseRecord,
    response: RegisteredRelease,
  }),
  releases: controlEndpoint({
    id: 'operator.releases',
    method: 'GET',
    path: '/operator/releases',
    auth: 'operator',
    summary: 'Registered releases and their status.',
    response: z.object({ releases: z.array(RegisteredRelease).max(10_000) }),
  }),
  rollouts: controlEndpoint({
    id: 'operator.rollouts',
    method: 'GET',
    path: '/operator/rollouts',
    auth: 'operator',
    summary: 'Rollouts, newest first.',
    response: z.object({ rollouts: z.array(Rollout).max(1_000) }),
  }),
  rollout: controlEndpoint({
    id: 'operator.rollout',
    method: 'GET',
    path: '/operator/rollouts/:rollout',
    auth: 'operator',
    summary: 'One rollout.',
    response: Rollout,
  }),
  rolloutDevices: controlEndpoint({
    id: 'operator.rolloutDevices',
    method: 'GET',
    path: '/operator/rollouts/:rollout/devices',
    auth: 'operator',
    summary:
      'The devices of a rollout’s cohorts with their state for its release, failure detail and hold (`fleet.read`, CT-140). Refuses `rollout_not_found` (404).',
    response: z.object({ devices: z.array(RolloutDevice).max(10_000) }),
  }),
  stopRollout: controlEndpoint({
    id: 'operator.stopRollout',
    method: 'POST',
    path: '/operator/rollouts/:rollout/stop',
    auth: 'operator',
    summary: 'End a rollout for good (installed devices keep what they run).',
    body: OperatorReasonBody,
    response: Rollout,
  }),
  promoteWave: controlEndpoint({
    id: 'operator.promoteWave',
    method: 'POST',
    path: '/operator/rollouts/:rollout/promote',
    auth: 'operator',
    summary:
      'Promote the current wave now (manual approval of the next wave), skipping the rest of its observation window.',
    body: z.strictObject({ wave: z.number().int().min(0).max(100), reason: Ident }),
    response: Rollout,
  }),
  devices: controlEndpoint({
    id: 'operator.devices',
    method: 'GET',
    path: '/operator/devices',
    auth: 'operator',
    summary: 'The fleet (metadata only).',
    response: z.object({ devices: z.array(DirectoryDevice.extend({ internal: z.boolean() })).max(100_000) }),
  }),
  device: controlEndpoint({
    id: 'operator.device',
    method: 'GET',
    path: '/operator/devices/:device',
    auth: 'operator',
    summary: 'One device.',
    response: DirectoryDevice.extend({ internal: z.boolean() }),
  }),
  setInternal: controlEndpoint({
    id: 'operator.setInternal',
    method: 'PUT',
    path: '/operator/devices/:device/internal',
    auth: 'operator',
    summary: 'Mark a device internal (the `internal` cohort).',
    body: z.strictObject({ internal: z.boolean() }),
    response: Ok,
  }),
  retireDevice: controlEndpoint({
    id: 'operator.retireDevice',
    method: 'POST',
    path: '/operator/devices/:device/retire',
    auth: 'operator',
    summary: 'Retire a device for good (stolen, RMA, destroyed): device API refused (`device_retired`).',
    body: OperatorReasonBody,
    response: Ok,
  }),
  supportOpen: controlEndpoint({
    id: 'operator.supportOpen',
    method: 'POST',
    path: '/operator/devices/:device/support',
    auth: 'operator',
    summary:
      'Remote help into a device (`support`, 0.120, CT-947): certify the support person’s key for this device (`SUPPORT_CERT_TTL_S`) and hand out a client ticket for its support route, with the host key, level and time left from its last status report. Refuses `device_not_found` (404), `remote_help_off` (409: no status report in the last 15 minutes, its `support.state` is `off`, or it has no host key) and `support_unavailable` (503: control has no support CA key). Audited in `operator_audit` and the device org’s audit (“Whombat support”): device, name, level, the certificate’s serial and validity.',
    body: SupportOpenBody,
    response: SupportOpenResponse,
  }),
  supportTicket: controlEndpoint({
    id: 'operator.supportTicket',
    method: 'POST',
    path: '/operator/devices/:device/support/ticket',
    auth: 'operator',
    summary:
      'Another client ticket for a device’s support route (`support`, 0.120, CT-947): `rol: client`, `sub` a stable opaque subject per operator. Refuses `device_not_found` (404) and `remote_help_off` (409) as `supportOpen`.',
    body: z.strictObject({}),
    response: TicketResponse,
  }),
  releaseDevice: controlEndpoint({
    id: 'operator.releaseDevice',
    method: 'POST',
    path: '/operator/devices/:device/release',
    auth: 'operator',
    summary: 'Release a device back to unclaimed (ownership transfer after a local reset).',
    body: OperatorReasonBody,
    response: Ok,
  }),
  fleet: controlEndpoint({
    id: 'operator.fleet',
    method: 'GET',
    path: '/operator/fleet',
    auth: 'operator',
    summary:
      'Devices by release with each release’s API level, open rollouts and open alerts (`fleet.read`, CT-141): what `deploy.sh` checks before a hosted deploy (UP-B4) and `release/ship status` prints.',
    response: FleetSummary,
  }),
  alerts: controlEndpoint({
    id: 'operator.alerts',
    method: 'GET',
    path: '/operator/alerts',
    auth: 'operator',
    summary: 'Alerts, newest first: open ones (`state=open`, the default) or all (`fleet.read`, CT-141).',
    query: OperatorAlertsQuery,
    response: z.object({ alerts: z.array(OperatorAlert).max(1_000) }),
  }),
  ackAlert: controlEndpoint({
    id: 'operator.ackAlert',
    method: 'POST',
    path: '/operator/alerts/:alert/ack',
    auth: 'operator',
    summary:
      'Acknowledge an alert (`fleet.write`): it stays open until its condition clears, but isn’t mailed again. Idempotent. Refuses `alert_not_found` (404).',
    body: z.strictObject({}),
    response: OperatorAlert,
  }),
  registrations: controlEndpoint({
    id: 'operator.registrations',
    method: 'GET',
    path: '/operator/registrations',
    auth: 'operator',
    summary:
      'Pending re-registrations: self-registrations refused because a live record holds the same hardware serial (`fleet.read`, CT-141, UP-E5).',
    response: z.object({ registrations: z.array(PendingRegistration).max(1_000) }),
  }),
  retireExisting: controlEndpoint({
    id: 'operator.retireExisting',
    method: 'POST',
    path: '/operator/registrations/:id/retire-existing',
    auth: 'operator',
    summary:
      '“Reinstalled — retire the old record” (`fleet.write`, UP-E5): retires the existing device as `retireDevice` does and answers it; the box’s next self-registration attempt registers. Refuses `registration_not_found` (404).',
    body: OperatorReasonBody,
    response: DirectoryDevice.extend({ internal: z.boolean() }),
  }),
  retryDevice: controlEndpoint({
    id: 'operator.retryDevice',
    method: 'POST',
    path: '/operator/devices/:device/retry',
    auth: 'operator',
    summary:
      'Let a device try a release again (`fleet.write`, CT-147): clears its sticky `failed_before` hold for that release (after the cause was fixed on the box, e.g. space freed or a backup destination added), so its next assignment poll can get the release again; the box’s own quarantine of the release still applies. Answers the device as `rolloutDevices` shows it. Refuses `device_not_found`, `release_not_found` (404), `nothing_to_retry` (409: no `failed_before` hold for that release).',
    body: z.strictObject({ release: ReleaseId, reason: Ident }),
    response: RolloutDevice,
  }),
  relayWorkers: controlEndpoint({
    id: 'operator.relayWorkers',
    method: 'GET',
    path: '/operator/relay-workers',
    auth: 'operator',
    summary: 'Relay workers and their drain state.',
    response: z.object({ workers: z.array(OperatorRelayWorker).max(1_000) }),
  }),
  drainWorker: controlEndpoint({
    id: 'operator.drainWorker',
    method: 'POST',
    path: '/operator/relay-workers/:worker/drain',
    auth: 'operator',
    summary: 'Stop assigning appliances to a worker (rendezvous moves only its appliances).',
    body: z.strictObject({}),
    response: OperatorRelayWorker,
  }),
  undrainWorker: controlEndpoint({
    id: 'operator.undrainWorker',
    method: 'POST',
    path: '/operator/relay-workers/:worker/undrain',
    auth: 'operator',
    summary: 'Assign appliances to the worker again.',
    body: z.strictObject({}),
    response: OperatorRelayWorker,
  }),
  setEntitlement: controlEndpoint({
    id: 'operator.setEntitlement',
    method: 'PUT',
    path: '/operator/orgs/:org/entitlement',
    auth: 'operator',
    summary:
      'Set an org’s entitlement (until a billing provider adapter exists). Absent members keep their current value; limits and `selfInstall` flow into the next licence token of each device (0.10).',
    body: SetEntitlementBody,
    response: Entitlement,
  }),
  audit: controlEndpoint({
    id: 'operator.audit',
    method: 'GET',
    path: '/operator/audit',
    auth: 'operator',
    summary: 'The operator audit log.',
    query: z.object({ limit: z.coerce.number().int().min(1).max(1_000).optional() }),
    response: z.object({ events: z.array(OperatorAuditEvent).max(1_000) }),
  }),
  customerAudit: controlEndpoint({
    id: 'operator.customerAudit',
    method: 'GET',
    path: '/operator/customer-audit',
    auth: 'operator',
    summary:
      'Customer audit events across orgs (support; metadata only). `org` matches the event’s org; `device` matches events whose `target` is that device id.',
    query: z.object({
      org: OrgId.optional(),
      device: DeviceId.optional(),
      limit: z.coerce.number().int().min(1).max(1_000).optional(),
    }),
    response: z.object({ events: z.array(OrgAuditEvent.extend({ org: OrgId.nullable() })).max(1_000) }),
  }),
  signIn: controlEndpoint({
    id: 'operator.signIn',
    method: 'POST',
    path: '/operator/session',
    auth: 'none',
    summary:
      'Panel listener only (BL-27): sign in with username and password for a 12-hour panel session in the `wb_op` cookie. Refuses `invalid_credentials` (401: unknown username or wrong password, one answer for both), `rate_limited` (429: 10 per 15 min per network). A caller outside the panel’s IP allowlist gets a bare 403 (no body contract) on every panel request, this one included.',
    body: OperatorSignInBody,
    response: OperatorSession,
  }),
  session: controlEndpoint({
    id: 'operator.session',
    method: 'GET',
    path: '/operator/session',
    auth: 'operator',
    summary:
      'Who is signed in, with which permissions (the panel cookie, or a bearer token on the operator listener).',
    response: OperatorSession,
  }),
  signOut: controlEndpoint({
    id: 'operator.signOut',
    method: 'DELETE',
    path: '/operator/session',
    auth: 'operator',
    summary: 'End the panel session (revokes it and clears the cookie).',
    response: Ok,
  }),
  overview: controlEndpoint({
    id: 'operator.overview',
    method: 'GET',
    path: '/operator/overview',
    auth: 'operator',
    summary: 'Customer counts (`customers.read`; no revenue, BL-10).',
    response: OperatorOverview,
  }),
  orgs: controlEndpoint({
    id: 'operator.orgs',
    method: 'GET',
    path: '/operator/orgs',
    auth: 'operator',
    summary:
      'Orgs with their account and billing, newest first, 50 per page (`customers.read`). `q` matches the name or the account’s email.',
    query: OperatorOrgsQuery,
    response: OperatorOrgPage,
  }),
  org: controlEndpoint({
    id: 'operator.org',
    method: 'GET',
    path: '/operator/orgs/:org',
    auth: 'operator',
    summary:
      'One org: its account, devices, entitlement, Stripe ids and dashboard links, trial marks, terms acceptance and the last 50 audit events (`customers.read`).',
    response: OperatorOrgDetail,
  }),
  extendTrial: controlEndpoint({
    id: 'operator.extendTrial',
    method: 'POST',
    path: '/operator/orgs/:org/trial/extend',
    auth: 'operator',
    summary:
      'Extend a trial by `days` (`billing.write`): Stripe `trial_end`, or a manual trial’s `currentPeriodEnd`. Refuses `not_trialing` (409), `billing_provider_error` (503).',
    body: ExtendTrialBody,
    response: OperatorOrgDetail,
  }),
  setPlan: controlEndpoint({
    id: 'operator.setPlan',
    method: 'POST',
    path: '/operator/orgs/:org/plan',
    auth: 'operator',
    summary:
      'Put an org on a manual plan (a comp; `billing.write`): the plan’s limits, `whombats` as `devicesAllowed`, `state` (default `active`). Refuses `subscription_live` (409: a live Stripe subscription; cancel it first), `plan_not_found` (404).',
    body: SetOrgPlanBody,
    response: OperatorOrgDetail,
  }),
  cancelSubscription: controlEndpoint({
    id: 'operator.cancelSubscription',
    method: 'POST',
    path: '/operator/orgs/:org/subscription/cancel',
    auth: 'operator',
    summary:
      'Cancel the org’s Stripe subscription now or at the period end (`billing.write`). Refuses `no_subscription` (409), `billing_provider_error` (503).',
    body: CancelSubscriptionBody,
    response: OperatorOrgDetail,
  }),
  syncBilling: controlEndpoint({
    id: 'operator.syncBilling',
    method: 'POST',
    path: '/operator/orgs/:org/billing/sync',
    auth: 'operator',
    summary:
      'Apply the org’s subscription from Stripe now (`billing.write`). Refuses `no_subscription` (409), `billing_provider_error` (503).',
    body: z.strictObject({}),
    response: OperatorOrgDetail,
  }),
  deleteOrg: controlEndpoint({
    id: 'operator.deleteOrg',
    method: 'POST',
    path: '/operator/orgs/:org/delete',
    auth: 'operator',
    summary:
      'Delete an org for good (`customers.write`; BL-31): its account link, entitlement, claims, feedback sites and terms acceptances. Its claimed Whombats go back to unclaimed (like `releaseDevice`; data on the appliance is never touched); retired ones keep their directory row without the org. Its account stays. Trial marks stay, so a new org doesn’t get another trial. The body is the org’s name as a typed confirmation (`name_mismatch`, 400). Refuses `org_not_found` (404), `subscription_live` (409: cancel the Stripe subscription first).',
    body: DeleteOrgBody,
    response: OperatorOrgDeleted,
  }),
  accounts: controlEndpoint({
    id: 'operator.accounts',
    method: 'GET',
    path: '/operator/accounts',
    auth: 'operator',
    summary: 'Cloud accounts, newest first, 50 per page (`customers.read`). `q` matches the email or name.',
    query: OperatorAccountsQuery,
    response: OperatorAccountPage,
  }),
  disableAccount: controlEndpoint({
    id: 'operator.disableAccount',
    method: 'POST',
    path: '/operator/accounts/:account/disable',
    auth: 'operator',
    summary:
      'Disable an account and revoke its sessions (`customers.write`); sign-in answers `account_disabled`. Idempotent. Refuses `account_not_found` (404).',
    body: z.strictObject({}),
    response: OperatorAccountRow,
  }),
  enableAccount: controlEndpoint({
    id: 'operator.enableAccount',
    method: 'POST',
    path: '/operator/accounts/:account/enable',
    auth: 'operator',
    summary: 'Enable a disabled account (`customers.write`). Idempotent. Refuses `account_not_found` (404).',
    body: z.strictObject({}),
    response: OperatorAccountRow,
  }),
  deleteAccount: controlEndpoint({
    id: 'operator.deleteAccount',
    method: 'POST',
    path: '/operator/accounts/:account/delete',
    auth: 'operator',
    summary:
      'Delete a cloud account for good (`customers.write`; BL-32), as `accounts.delete` does for the account itself: its sessions (signed out everywhere), passkeys, push handles, magic links and waitlist entries. Its orgs are deleted with it as `deleteOrg` does (their claimed Whombats go back to unclaimed). The body is the account’s email as a typed confirmation (`email_mismatch`, 400). Refuses `account_not_found` (404), `subscription_live` (409: one of its orgs has a live Stripe subscription).',
    body: OperatorDeleteAccountBody,
    response: OperatorAccountDeleted,
  }),
  settings: controlEndpoint({
    id: 'operator.settings',
    method: 'GET',
    path: '/operator/settings',
    auth: 'operator',
    summary: 'The live settings (`customers.read`; BL-29).',
    response: ControlSettings,
  }),
  setSettings: controlEndpoint({
    id: 'operator.setSettings',
    method: 'PUT',
    path: '/operator/settings',
    auth: 'operator',
    summary:
      'Change live settings (`settings.write`); absent members keep their value. Takes effect within 5 s (cached read).',
    body: ControlSettingsUpdate,
    response: ControlSettings,
  }),
  waitlist: controlEndpoint({
    id: 'operator.waitlist',
    method: 'GET',
    path: '/operator/waitlist',
    auth: 'operator',
    summary: 'Waitlist entries, oldest first, 100 per page (`customers.read`).',
    query: OperatorWaitlistQuery,
    response: OperatorWaitlistPage,
  }),
  approveWaitlist: controlEndpoint({
    id: 'operator.approveWaitlist',
    method: 'POST',
    path: '/operator/waitlist/:id/approve',
    auth: 'operator',
    summary:
      'Approve an entry (`signup.write`): a single-use code that expires in 30 days, emailed as a link; the entry becomes `invited`. Refuses `waitlist_entry_not_found` (404), `waitlist_entry_not_waiting` (409).',
    body: z.strictObject({}),
    response: WaitlistEntry,
  }),
  removeWaitlist: controlEndpoint({
    id: 'operator.removeWaitlist',
    method: 'POST',
    path: '/operator/waitlist/:id/remove',
    auth: 'operator',
    summary:
      'Remove an entry (`signup.write`); a code sent for it is revoked if unused. Idempotent. Refuses `waitlist_entry_not_found` (404).',
    body: z.strictObject({}),
    response: WaitlistEntry,
  }),
  signupCodes: controlEndpoint({
    id: 'operator.signupCodes',
    method: 'GET',
    path: '/operator/signup-codes',
    auth: 'operator',
    summary: 'Signup codes, newest first, 100 per page, by hint only (`customers.read`).',
    query: OperatorSignupCodesQuery,
    response: OperatorSignupCodePage,
  }),
  createSignupCode: controlEndpoint({
    id: 'operator.createSignupCode',
    method: 'POST',
    path: '/operator/signup-codes',
    auth: 'operator',
    summary:
      'Create a signup code (`signup.write`); the answer is the only time the code is shown. With `email` it is an invitation (BL-34): bound to that address, single-use, and emailed as a `/signup#code=` link. Refuses `plan_not_found` (404).',
    body: CreateSignupCodeBody,
    response: CreatedSignupCode,
    status: 201,
  }),
  revokeSignupCode: controlEndpoint({
    id: 'operator.revokeSignupCode',
    method: 'POST',
    path: '/operator/signup-codes/:id/revoke',
    auth: 'operator',
    summary: 'Revoke a signup code (`signup.write`). Idempotent. Refuses `signup_code_not_found` (404).',
    body: z.strictObject({}),
    response: SignupCode,
  }),
  deleteSignupCode: controlEndpoint({
    id: 'operator.deleteSignupCode',
    method: 'POST',
    path: '/operator/signup-codes/:id/delete',
    auth: 'operator',
    summary:
      'Delete a signup code or invitation for good (`signup.write`): it leaves the list and stops working; organizations created with it don’t change, and a waitlist entry it was sent for stays invited. Refuses `signup_code_not_found` (404).',
    body: z.strictObject({}),
    response: Ok,
  }),
  resendSignupCode: controlEndpoint({
    id: 'operator.resendSignupCode',
    method: 'POST',
    path: '/operator/signup-codes/:id/resend',
    auth: 'operator',
    summary:
      'Email an invitation again (`signup.write`, BL-35). Control keeps only a digest, so the code is replaced by a new one (the old one stops working) and an expired invitation gets its validity again, counted from now. Refuses `signup_code_not_found` (404), `signup_code_not_resendable` (409: no email address, used or revoked).',
    body: z.strictObject({}),
    response: CreatedSignupCode,
  }),
  plans: controlEndpoint({
    id: 'operator.plans',
    method: 'GET',
    path: '/operator/plans',
    auth: 'operator',
    summary: 'Every plan, in `sort` order (`customers.read`).',
    response: z.object({ plans: z.array(OperatorPlan).max(100) }),
  }),
  updatePlan: controlEndpoint({
    id: 'operator.updatePlan',
    method: 'PUT',
    path: '/operator/plans/:plan',
    auth: 'operator',
    summary:
      'Change a plan (`plans.write`). A price change with Stripe configured creates a new price and moves the lookup key; existing subscribers keep theirs (BL-20). Refuses `plan_not_found` (404), `billing_provider_error` (503).',
    body: PlanUpdate,
    response: OperatorPlan,
  }),
  runRetention: controlEndpoint({
    id: 'operator.runRetention',
    method: 'POST',
    path: '/operator/retention/run',
    auth: 'operator',
    summary: 'Apply retention now (normally hourly).',
    body: z.strictObject({}),
    response: z.object({
      ok: z.literal(true),
      deleted: z.record(z.string().max(64), z.number().int().min(0)),
    }),
  }),
};
