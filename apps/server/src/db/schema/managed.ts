/**
 * The managed appliance runtime (docs/decisions/managed-runtime.md, MA-04, MA-09): enrolled endpoint keys, the
 * claim, pairing and device links, the recovery authority, the appliance's own signed audit log, durable command
 * receipts, the session event log and resumable session uploads. Empty (and unused) in the self-hosted mode.
 */
import type { EndpointEnrolledVia } from '@whombat/protocol/session';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { bytea, ts } from './common';
import { accounts } from './tenancy';

export type EndpointPlatform = 'web' | 'android' | 'ios' | 'desktop' | 'cli';
/** How an endpoint was let in (the contracts' list; `screen`: the six letters on the box's screen, signin-at-box BX-07). */
export type EnrolledVia = EndpointEnrolledVia;

/** One Ed25519 endpoint key (a browser profile or an app install), bound to one local account (MA-03). */
export const applianceEndpoints = pgTable(
  'appliance_endpoints',
  {
    id: text('id').primaryKey(),
    /** libp2p PeerId of the endpoint key: the Noise static identity of its sessions. */
    peerId: text('peer_id').notNull().unique(),
    /** Raw Ed25519 public key, hex. */
    publicKey: text('public_key').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    platform: text('platform').$type<EndpointPlatform>().notNull(),
    enrolledVia: text('enrolled_via').$type<EnrolledVia>().notNull(),
    /** The endpoint (or recovery) that authorized this one; null for the claim. */
    enrolledByEndpointId: text('enrolled_by_endpoint_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at'),
    /**
     * The app build its last session said it runs (`hello.client.build`: `android 3.93.1 (393010)`): which build a
     * phone had when something went wrong on it, without asking. Null before its first session that said.
     */
    appBuild: text('app_build'),
    revokedAt: ts('revoked_at'),
    revokedByAccountId: text('revoked_by_account_id'),
    /** When control was told about the revocation (MA-04 §6: "pending" until then, "applied" after). */
    revocationReportedAt: ts('revocation_reported_at'),
    /** The endpoint's opaque control push handle (CT-11), for content-free push; null = no push. */
    pushHandle: text('push_handle'),
    /**
     * Push through the box (Whombat Link, whombat-link.md LNK-36): the phone app's own APNs or FCM token
     * (`push.token.set`), kept so the box can register it at control whenever Link is on, and the handle control gave
     * this box for it (null until registered). The box sends to that handle rather than `pushHandle`.
     */
    pushToken: jsonb('push_token').$type<{ platform: 'apns' | 'fcm'; token: string; appId: string }>(),
    pushTokenHandle: text('push_token_handle'),
    /** The passkey (credential id) that enrolled it (`via: 'passkey'`, PK-05); `PasskeySummary.current` reads it. */
    enrolledPasskeyId: text('enrolled_passkey_id'),
  },
  (t) => [index('appliance_endpoints_account_idx').on(t.accountId)],
);

/**
 * The appliance's own state (one row, id 1): the claim (hash of the one-use claim secret, consumed atomically),
 * the physical claim window the manager may require, the recovery authority and whether its kit was verified.
 */
export const applianceState = pgTable('appliance_state', {
  id: integer('id').primaryKey(),
  /** Provisioning's `claim.json`: the device id the secret hash is bound to, and the hash itself. */
  claimDeviceId: text('claim_device_id'),
  claimSecretHash: text('claim_secret_hash'),
  claimConsumedAt: ts('claim_consumed_at'),
  claimedByAccountId: text('claimed_by_account_id'),
  /** Control's pending-claim id the enrolling client presented (CT-27); reported with `claimed`. */
  claimId: text('claim_id'),
  /** The claim needs the physical claim window open (manager flag, e.g. a button press). */
  claimWindowRequired: integer('claim_window_required').notNull().default(0),
  /** Until when the manager says the physical claim window is open. */
  claimWindowUntil: ts('claim_window_until'),
  /** When the manager confirmed it reported `claimed` to control. */
  claimReportedAt: ts('claim_reported_at'),
  /**
   * Recovery authority: Ed25519 public key (hex) of the customer's recovery key — only a **confirmed** kit's key
   * (MA-19a): a registered or rotated key waits in `recoveryPendingPublicKey` until its kit is confirmed.
   */
  recoveryPublicKey: text('recovery_public_key'),
  recoveryEnrolledAt: ts('recovery_enrolled_at'),
  /** When the active key's kit was confirmed (the person signed the challenge with the saved kit). */
  recoveryKitVerifiedAt: ts('recovery_kit_verified_at'),
  /**
   * The kit's account (CT-45): the account that registered or last rotated the active kit. A recovery statement enrolls
   * a device only into this account.
   */
  recoveryOwnerAccountId: text('recovery_owner_account_id'),
  /** A registered (no key yet) or rotated key waiting for its kit to be confirmed, and who set it up. */
  recoveryPendingPublicKey: text('recovery_pending_public_key'),
  recoveryPendingOwnerAccountId: text('recovery_pending_owner_account_id'),
  /** The pending kit being confirmed (`recovery.kit.register|rotate` → `recovery.kit.confirm`). */
  recoveryKitId: text('recovery_kit_id'),
  /** Its confirmation challenge (hex) and when it expires. */
  recoveryChallenge: text('recovery_challenge'),
  recoveryChallengeExpiresAt: ts('recovery_challenge_expires_at'),
  /**
   * The running release's client security floor as the manager last reported it (`FactsRequest.update.clientFloor`,
   * CT-53), kept across restarts so a restart doesn't reopen the gap before the manager's first facts push; null = none.
   */
  clientFloor: jsonb('client_floor').$type<Record<string, number>>(),
  /**
   * The appliance licence (LC-07, MR-56): the latest token the manager pushed that verified against the pinned key
   * set (compact JWS; null: none yet), the manager's time high-water mark (max of accepted `iat`s and control's
   * `now`; only ever goes up) and the runtime's own clock mark (raised hourly and at every push to the local clock,
   * reset to the high-water mark by a newer token). Effective time = max(clock, high water, clock mark).
   */
  licenceToken: text('licence_token'),
  licenceHighWater: ts('licence_high_water'),
  licenceClockMark: ts('licence_clock_mark'),
  /** The person's “Only passkeys that stay on one device” (`passkeys.policy {deviceBoundOnly}`, PK-07). */
  passkeysDeviceBoundOnly: boolean('passkeys_device_bound_only').notNull().default(false),
  /**
   * Remote help's follower (docs/decisions/remote-help-server.md RH-S05): the support service's last event recorded
   * (moved in the transaction that signs it) and the service's SSH host key then; a new key is a new event log.
   */
  remoteHelpSeq: bigint('remote_help_seq', { mode: 'number' }),
  remoteHelpHostKey: text('remote_help_host_key'),
  /**
   * The box's own Web Push key (hermes-engine.md HE-61, HE-S220): a VAPID P-256 pair made at the first start of a
   * community box; the public half as `VapidPublicKey` (base64url), the private half sealed under the master key.
   */
  vapidPublicKey: text('vapid_public_key'),
  vapidPrivateKeyEnc: text('vapid_private_key_enc'),
  /**
   * The person's own mail server (HE-61, HE-S224; contracts `MailSettings`, CT-1308): host, port, security, user name,
   * sender and the last test — never the password, which is sealed apart (`mail_password_enc`).
   */
  mailSettings: jsonb('mail_settings').$type<BoxMailSettings>(),
  mailPasswordEnc: text('mail_password_enc'),
  /**
   * Whether this box started with the shared-passkey route off (docs/decisions/own-address.md): decided once, at the
   * first start (true when the manager said the own address is on), never later; null until then. A box that ran before
   * it has false. True: it is claimed only on a page it served, joined without code pairing, and never reports the claim.
   */
  sharedRouteOff: boolean('shared_route_off'),
  /** The owner's switch “Reach my Whombat's page from anywhere”: browsers through the door (on unless turned off). */
  ownAddressReach: boolean('own_address_reach').notNull().default(true),
  /** When the box was linked to the person's Whombat account by its code, and the account's email then. */
  accountLinkedAt: ts('account_linked_at'),
  accountLinkedEmail: text('account_linked_email'),
  /** The box-passkey credential ids control last acknowledged (`kit.credentials.declare`, the full set), and when. */
  kitDeclaredIds: jsonb('kit_declared_ids').$type<string[]>(),
  kitDeclaredAt: ts('kit_declared_at'),
  /**
   * Whombat Link's notices (whombat-link.md LNK-06): which Link stop the owner's devices were pushed about (its grace's
   * end), so a restart doesn't push it again.
   */
  linkNoticed: text('link_noticed'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * The certificates this box served or its manager ordered for its own address (own-address.md): each recorded before
 * it is served, so the certificate watch never calls one foreign.
 */
export const ownAddressCerts = pgTable('own_address_certs', {
  serial: text('serial').primaryKey(),
  spkiSha256: text('spki_sha256').notNull(),
  notBefore: ts('not_before').notNull(),
  notAfter: ts('not_after').notNull(),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
});

/**
 * Certificates Certificate Transparency lists for the box's address that it didn't ask for (own-address.md), by public
 * key. Kept after they end, for the record; `notified_at`: the person was told.
 */
export const ownAddressForeign = pgTable('own_address_foreign', {
  spkiSha256: text('spki_sha256').primaryKey(),
  names: jsonb('names').$type<string[]>().notNull(),
  notBefore: ts('not_before').notNull(),
  notAfter: ts('not_after').notNull(),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  notifiedAt: ts('notified_at'),
});

/**
 * A box passkey's user handle per account (own-address.md): 32 random bytes made once, so two people's passkeys for one
 * box in one browser never replace each other.
 */
export const boxPasskeyUsers = pgTable('box_passkey_users', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  userHandle: text('user_handle').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** `appliance_state.mail_settings` (HE-S224): `MailSettings` without `source` and `hasPassword`. */
export interface BoxMailSettings {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string | null;
  from: string;
  fromName: string | null;
  updatedAt: string;
  lastTest: { state: string; at: string; to: string; detail: string | null } | null;
}

/**
 * A passkey that opens this Whombat (docs/decisions/passkeys.md PK-01, PK-05, PK-06): a WebAuthn credential of one
 * account, registered from one of its enrolled devices, that enrolls new devices into that account. The appliance
 * verifies every assertion itself with the stored COSE public key; control never lets a device in (MA-03).
 * `removed_at` set: it enrolls nothing any more (kept for the audit trail and `current`).
 */
export const appliancePasskeys = pgTable(
  'appliance_passkeys',
  {
    /** The WebAuthn credential id, base64url. */
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Shared owner user handle; null for a legacy per-Whombat credential. */
    ownerHandle: text('owner_handle'),
    /** The credential's COSE public key, as the attestation carried it. */
    publicKey: bytea('public_key').notNull(),
    /** The authenticator's signature counter (0 for most passkeys, which keep none). */
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    /** BE and BS from the authenticator data at registration: the passkey can sync / is synced (PK-07). */
    backupEligible: boolean('backup_eligible').notNull(),
    backedUp: boolean('backed_up').notNull(),
    /** The enrolled device that registered it. */
    createdByEndpointId: text('created_by_endpoint_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** The last device it enrolled. */
    lastUsedAt: ts('last_used_at'),
    lastEndpointId: text('last_endpoint_id'),
    removedAt: ts('removed_at'),
    removedByAccountId: text('removed_by_account_id'),
    /**
     * A box passkey (own-address.md): its RP ID, the box's own host, and the account's box user handle. Null for a
     * passkey under the hosted app's RP.
     */
    rpId: text('rp_id'),
    userHandle: text('user_handle'),
  },
  (t) => [index('appliance_passkeys_account_idx').on(t.accountId)],
);

/** Claim attempts, for the rate limit (per endpoint and overall). */
export const applianceClaimAttempts = pgTable(
  'appliance_claim_attempts',
  {
    id: serial('id').primaryKey(),
    peerId: text('peer_id').notNull(),
    ok: integer('ok').notNull().default(0),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('appliance_claim_attempts_at_idx').on(t.at)],
);

/**
 * Failed claim confirmations (CC-07, MR-50): one row per wrong `enroll.claim` confirm, for the rolling 24 h backoff
 * (`claimBackoffSeconds`). Kept in the database so a restart doesn't reset the backoff; cleared by a successful claim.
 */
export const applianceClaimFailures = pgTable(
  'appliance_claim_failures',
  {
    id: serial('id').primaryKey(),
    method: text('method').notNull(),
    peerId: text('peer_id').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('appliance_claim_failures_at_idx').on(t.at)],
);

/** A new endpoint waiting for an already-trusted endpoint to approve it by its short code (MA-04 §5a). */
export const endpointPairings = pgTable(
  'endpoint_pairings',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    peerId: text('peer_id').notNull(),
    publicKey: text('public_key').notNull(),
    label: text('label').notNull(),
    platform: text('platform').$type<EndpointPlatform>().notNull(),
    state: text('state').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    decidedAt: ts('decided_at'),
    decidedByEndpointId: text('decided_by_endpoint_id'),
    endpointId: text('endpoint_id'),
  },
  (t) => [
    uniqueIndex('endpoint_pairings_pending_code_idx').on(t.code).where(sql`${t.state} = 'pending'`),
    index('endpoint_pairings_peer_idx').on(t.peerId),
  ],
);

/**
 * Device links (hermes-engine.md HE-60, HE-S214; contracts CT-1305): a one-time secret (hash stored) that lets one more
 * device of the account that made it in, for five minutes. One live link per account: a new one replaces the old
 * (`replaced_at`). `expired` is not stored: a live row past `expires_at` is expired.
 */
export const endpointDeviceLinks = pgTable(
  'endpoint_device_links',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The device that made it: the new one is enrolled by it (`enrolled_by_endpoint_id`). */
    createdByEndpointId: text('created_by_endpoint_id').notNull(),
    secretHash: text('secret_hash').notNull().unique(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    consumedByEndpointId: text('consumed_by_endpoint_id'),
    replacedAt: ts('replaced_at'),
  },
  (t) => [index('endpoint_device_links_account_idx').on(t.accountId)],
);

/**
 * Customer-approved diagnostic bundles (contracts 0.5.3 CT-52, MR-42): the validated document as the person will read
 * and download it, with its size and sha256 over `diagnosticBundleBytes`. Deleted after 7 days (a signed
 * `diagnostics.expired` event). Never uploaded anywhere.
 */
export const diagnosticBundles = pgTable('diagnostic_bundles', {
  id: text('id').primaryKey(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  bundle: jsonb('bundle').$type<Record<string, unknown>>().notNull(),
  createdByAccountId: text('created_by_account_id').notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  downloads: integer('downloads').notNull().default(0),
  lastDownloadedAt: ts('last_downloaded_at'),
});

/**
 * The appliance's signed audit log (claim, enrollment, recovery, revocation): not a burrow's, so it has its
 * own hash chain, signed with the appliance audit key (`appliance_keys`). Append-only (trigger).
 */
export const applianceEvents = pgTable('appliance_events', {
  seq: bigint('seq', { mode: 'number' }).primaryKey(),
  type: text('type').notNull(),
  actorAccountId: text('actor_account_id'),
  endpointId: text('endpoint_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdAt: ts('created_at').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
  sig: text('sig').notNull(),
});

/** Keys the runtime holds for itself (the appliance audit key), sealed with the master key. */
export const applianceKeys = pgTable('appliance_keys', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  secretKeyEnc: text('secret_key_enc').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type ReceiptState = 'received' | 'accepted' | 'completed' | 'rejected' | 'not_executed';

/**
 * Durable command receipts (MA-09): one per `(principal, op, request id)`, bound to the request digest. The row
 * becomes `accepted` in the same transaction as the command it covers; a retry replays the stored outcome.
 */
export const commandReceipts = pgTable(
  'command_receipts',
  {
    principalId: text('principal_id').notNull(),
    op: text('op').notNull(),
    requestId: text('request_id').notNull(),
    digest: text('digest').notNull(),
    state: text('state').$type<ReceiptState>().notNull(),
    endpointId: text('endpoint_id'),
    /** The outcome to replay: `{status, body}` of a completed command, or the error of a rejected one. */
    outcome: jsonb('outcome').$type<Record<string, unknown>>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    acceptedAt: ts('accepted_at'),
    finishedAt: ts('finished_at'),
    deadlineAt: ts('deadline_at'),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.op, t.requestId] }),
    index('command_receipts_created_idx').on(t.createdAt),
  ],
);

/**
 * The session event log (MA-09): every realtime frame after commit, with an appliance-owned cursor. Retention is
 * bounded by age and count; an older cursor gets `snapshot_required`.
 */
export const sessionEvents = pgTable(
  'session_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    burrowId: text('burrow_id'),
    topic: text('topic').notNull(),
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    eventId: text('event_id'),
    at: text('at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('session_events_topic_idx').on(t.topic, t.id),
    index('session_events_created_idx').on(t.createdAt),
  ],
);

/** A chunked, resumable upload over a session: bytes received so far into its partial file. */
export const sessionUploads = pgTable('session_uploads', {
  attachmentId: text('attachment_id').primaryKey(),
  accountId: text('account_id').notNull(),
  /** sha256 the client declared for the whole file. */
  sha256: text('sha256').notNull(),
  receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * What the runtime remembers about the box's network (one row, id 1; docs/decisions/network-move-server.md): the
 * servers' latest move with the box for 24 hours, the box's address and cable as last seen, and the events owners are
 * told about in the Inbox (the cable that stopped, the cable back as the backup, connections that stopped letting
 * Whombat in after the address changed). Its shape is `BoxNetworkState` (`managed/network-move-store.ts`), read
 * leniently.
 */
/**
 * What the runtime remembers about the box's own backups (one row, id 1; docs/decisions/backup-options.md), migration
 * 0038: the claim's “Let {assistant} set it up”, the thread to tell when the first backup is done, a new password the
 * place still needs after a “lost or stolen” restore, backups on the box's own disk still to move, and which restore
 * was told about. Its shape is `BoxBackupNotes` (`backup-places/notes.ts`), read leniently.
 */
export const boxBackup = pgTable('box_backup', {
  id: integer('id').primaryKey(),
  state: jsonb('state').$type<Record<string, unknown>>().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const boxNetwork = pgTable('box_network', {
  id: integer('id').primaryKey(),
  state: jsonb('state').$type<Record<string, unknown>>().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * The runtime releases that ran on this database, each recorded at its first start on a managed box (its
 * `WHOMBAT_RELEASE_ID`). Recording began with the release that brought automations started by mail, so every release
 * here knows them: the box turns them on only when the release it would go back to after a failed update is here
 * (automations/release-gate.ts).
 */
export const runtimeReleases = pgTable('runtime_releases', {
  releaseId: text('release_id').primaryKey(),
  version: text('version').notNull(),
  /** The newest migration it has (`0015_runtime_releases`). */
  schema: text('schema'),
  firstStartedAt: ts('first_started_at').notNull(),
});
