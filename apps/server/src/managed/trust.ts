/**
 * Enrollment and trust on the appliance (MA-04; docs/decisions/managed-runtime.md MR-09 … MR-12). The op inputs
 * and outputs are `@whombat/protocol/session`'s enrollment schemas; the appliance extensions (`endpoints.rename`,
 * `push.handles.*`, `appliance.status`) became contract ops in 0.3.0 (CT-17; MR-08).
 *
 * Every session's client end is an Ed25519 endpoint key (the Noise static identity, a libp2p PeerId). An
 * endpoint is either unenrolled (only the `enroll` channel ops) or enrolled to exactly one local account.
 * The box is one person's (one-person.md OP-01, OP-S06): the account that claimed it. Every enrolled endpoint is one
 * of the person's devices, so there are no owners, admins or roles to check.
 *
 * - Claim (MA-22, CC-06/CC-07, MR-49…MR-53): a CPace exchange bound to both Noise static keys (`enroll.claim.begin`),
 *   whose password is the console letters (`code`, `claim.ts`) or the card's `claimSecretHash` from `claim.json`
 *   (`card`, CT-66); then `enroll.claim` with the client's confirmation tag, checked in constant time first. A wrong
 *   tag is one failed guess (letters rotate under `code`; rolling-24 h backoff in the database). A match consumes the
 *   claim atomically in the transaction that creates the person's account, enrolls the claiming endpoint and
 *   signs `appliance.claimed`. Begins are rate limited per endpoint and overall (atomically), the overall limit
 *   lifted while a claim window is open (the manager's, or new letters asked for at the box's own screen); optionally
 *   only while one is open. One verdict at a time across all sessions (`oneVerdict`), none waiting on the database
 *   longer than `VERDICT_WAIT_MS`; a wrong try retires its letters before it is counted. On the box's own pages the
 *   proofs come first (`enroll.claim.local.prove`): the person is named only to a box that proved itself, and the
 *   proof is good only for the letters and the time of its exchange.
 *   `claimed` is then reported through the manager (retried until it succeeds). The claim no longer asks for a recovery
 *   kit (`recoveryKitRequired: false`, signin-at-box BX-01).
 * - Sign in at the box (signin-at-box BX-02…BX-07, `screen-signin.ts`): the box's screen shows six letters for a device,
 *   and the same CPace exchange bound to both Noise keys lets it in to the person's account (`enrolled_via 'screen'`).
 * - Pairing: a new endpoint shows a short code; an enrolled endpoint approves it for its own account.
 * - No invites (one-person.md OP-S04): the box is its claimer's; a new device joins that account only, from one of
 *   its devices (pairing, a device link), at the box's screen, with a passkey or the recovery kit.
 * - Recovery (MA-19a, CT-45): the person's recovery key (public half registered while none exists, or rotated with the
 *   current key's signature; pending until the kit is confirmed by a signature; the person's devices are told) signs a
 *   statement bound to this appliance and the new endpoint's PeerId that enrolls it into the kit owner's account (the
 *   account that registered or last rotated it).
 * - Revocation: marks the endpoint revoked, bumps the account's `authz_generation`, closes its sessions (bus
 *   `endpoint.revoked`, `authz.changed`) and is reported to control as metadata ("pending" until reported).
 * - Last-device protection (MA-19c): revoking an endpoint never leaves the person without a live one.
 * - Screens elsewhere (desk-display.md DK-146; `display.ts`): a tablet or computer the person made a screen is enrolled
 *   as a `display`. Its sessions act for no account (`identify`), see only the `screen` channel, never count as one of
 *   the person's devices, never get push and aren't listed with them; revoking one takes its screen with it.
 * Every change is a signed appliance audit event in the same transaction.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { DEFAULT_PREFERENCES, newId, normalizeLocaleTag } from '@whombat/core';
import {
  CLAIM_FAILURE_WINDOW_S,
  CLAIM_WINDOW_WRONG_PER_KEY,
  type ClaimMethod,
  ClaimPakeError,
  claimBackoffSeconds,
  claimConfirmEqual,
  claimPakeResponder,
  localClaimPakeResponder,
} from '@whombat/protocol/claim';
import {
  claimSecretHash,
  DEVICE_LINK_TTL_S,
  type DirectRoute,
  LOCAL_CLAIM_PROVE_MINOR,
  LOCAL_CLAIM_TTL_S,
  type LocalLinkKind,
  localLinkFor,
  normalizeClaimSecret,
  pairingFingerprint,
  RECOVERY_ENROLL_PURPOSE,
  RECOVERY_KIT_CONFIRM_PURPOSE,
  RECOVERY_ROTATE_PURPOSE,
  type RecoveryKitConfirmation,
  type RecoveryRotation,
  type RecoveryStatement,
  recoverySigningBytes,
} from '@whombat/protocol/session';
import { ClientFloor } from '@whombat/release';
import { and, asc, count, eq, gt, isNotNull, isNull, lte, max, ne, sql } from 'drizzle-orm';
import { readingBack } from '../commit/scope';
import { managedAppOrigin, managedPasskeyRelyingParty } from '../config';
import type { Tx } from '../db/client';
import {
  accounts,
  applianceClaimAttempts,
  applianceClaimFailures,
  applianceEndpoints,
  applianceEvents,
  applianceState,
  type EndpointPlatform,
  endpointDeviceLinks,
  endpointPairings,
  principals,
  screens,
} from '../db/schema/index';
import { configuredBoxLocale, notifyLocaleChanged } from '../i18n/locale';
import { errorForLog, withoutValues } from '../lib/db-errors';
import { ApiError, conflict, forbidden, notFound } from '../lib/errors';
import { safeEqual, sha256 } from '../lib/secrets';
import { personAccountId } from '../read/principals';
import type { Services } from '../services';
import { appendApplianceEvent, localId } from './audit';
import { BoxPasskeyService } from './box-passkeys';
import {
  CLAIM_BEGIN_TTL_MS,
  ClaimCeremony,
  type ClaimProof,
  type ClaimStatus,
  type ClaimWindow,
  type SessionScope,
} from './claim';
import { loadConsoleBurrows } from './console-burrows';
import type { SessionTransport } from './direct/transport';
import { DisplayRequests } from './display-requests';
import { verifyEd25519Strict } from './identity';
import { registeredAtControl } from './link/origin';
import type { OwnAddressService } from './own-address/state';
import { PasskeyService } from './passkeys';
import { COMMUNITY_TEXT, linkRuns } from './policy';
import type { ManagerPort } from './ports';
import type { ControlPush } from './push';
import { DbScreenSignInStore, SCREEN_FAILURE_METHOD, ScreenSignInService } from './screen-signin';
import { SECURITY_NOTICES, type SecurityNotice } from './security-push';
import { SessionOpError } from './session-error';

export type AccountRow = typeof accounts.$inferSelect;
export type EndpointRow = typeof applianceEndpoints.$inferSelect;

/** Who is at the other end of a session. */
export interface SessionPrincipal {
  peerId: string;
  /** Raw Ed25519 public key, hex. */
  publicKey: string;
  endpoint: EndpointRow | null;
  /** The person's account; null unenrolled, and for a screen's endpoint, which acts for nobody (`isScreenEndpoint`). */
  account: AccountRow | null;
  /** The account's `authz_generation` when the session was opened (0 unenrolled). */
  authzGeneration: number;
  /**
   * The session protocol's minor this session speaks (the lower of the app's and the box's); absent outside a session.
   * What an older app can't read is left out of its answers (desk-display.md DK-161).
   */
  protocolMinor?: number;
  /**
   * The assistant acting for `account` in a turn for them (docs/decisions/assistant-settings.md): no device and no
   * session of its own, so `endpoint` is null; ops that need a device refuse it (`requireEnrolled`), the settings it
   * may change take it (`requirePerson`).
   */
  assistant?: { agentId: string };
}

/** The principal the assistant's settings tools run an op as: the person's account, no device of its own. */
export function assistantPrincipal(account: AccountRow, agentId: string): SessionPrincipal {
  return {
    peerId: `assistant:${agentId}`,
    publicKey: '',
    endpoint: null,
    account,
    authzGeneration: account.authzGeneration,
    assistant: { agentId },
  };
}

export interface Identity {
  peerId: string;
  publicKey: string;
}

/** How a development enrolment is recorded (`enroll.dev`, HE-S187). */
export const DEVELOPMENT_ENROLLED_VIA: EndpointRow['enrolledVia'] = 'dev';

/** How a tablet or computer that became a screen is enrolled (desk-display.md DK-146). */
export const SCREEN_ENROLLED_VIA: EndpointRow['enrolledVia'] = 'display';

/** A screen's endpoint: it sees only its own screen, and is never one of the person's devices. */
export function isScreenEndpoint(row: Pick<EndpointRow, 'enrolledVia'> | null | undefined): boolean {
  return row?.enrolledVia === SCREEN_ENROLLED_VIA;
}

/** A session of a screen's endpoint. */
export function isScreenSession(p: Pick<SessionPrincipal, 'endpoint'>): boolean {
  return isScreenEndpoint(p.endpoint);
}

export const PAIRING_TTL_MS = 10 * 60_000;
export const KIT_CHALLENGE_TTL_MS = 30 * 60_000;
/** A recovery statement's `issuedAt` may be this far from the appliance's clock. */
export const RECOVERY_SKEW_MS = 5 * 60_000;
/** Claim attempts: per endpoint and overall, per hour. */
export const CLAIM_ATTEMPTS_PER_PEER = 5;
export const CLAIM_ATTEMPTS_TOTAL = 30;
/**
 * The longest a verdict on a claim's proof waits for the database. Verdicts run one after the other, and asking for
 * new letters at the box waits its turn among them: nothing there may wait for ever.
 */
export const VERDICT_WAIT_MS = 10_000;
/** Wrong tries the database didn't take, kept in memory at most (older ones go first). */
const UNCOUNTED_FAILURES_MAX = 64;

/** A verdict's database work took longer than a verdict waits. */
export class VerdictWaitError extends SessionOpError {
  constructor(readonly what: string) {
    super('unavailable', 'This Whombat is busy. Try again in a moment.', { code: 'claim_busy' });
  }
}
/** Pairing codes an account may look up or approve per window (review L-4, MR-32). */
export const PAIRING_TRIES_PER_ACCOUNT = 10;
export const PAIRING_TRIES_WINDOW_MS = 10 * 60_000;
/** Pending pairing codes appliance-wide. */
export const MAX_PENDING_PAIRINGS = 256;
const STATE_ID = 1;
/** The next authorization generation: appliance-wide, so no two accounts share one (review I-3, MR-36). */
const nextGeneration = sql<number>`nextval('authz_generation_seq')`;

/** The claim code's normalization and hash are the contracts' (CT-29, provisioning NX-24). */
export { claimSecretHash, normalizeClaimSecret };

/**
 * The page a box names among its ways in: an HTTPS one first (its Tailscale name with HTTPS), else the first (its address
 * on the local network), null without any. One choice for every box, so a screen never points at the local network
 * while a secure address already opens.
 */
export function bestWayPage(ways: readonly DirectRoute[]): string | null {
  return ways.find((w) => w.web?.startsWith('https://'))?.web ?? ways[0]?.web ?? null;
}

/** A pairing code as the protocol shows it: `1234-5678`. */
export function pairingCode(): string {
  const digits = Array.from({ length: 8 }, () => String(randomInt(0, 10))).join('');
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

/** The WebAuthn relying party passkeys are verified for, or null where none can run (HE-S230). */
export interface PasskeyRelyingParty {
  rpId: string;
  origins: string[];
}

/** An app from before the claim's proof round: it would name the person to a box that hasn't proved itself. */
const updateAppError = () =>
  new SessionOpError('unavailable', 'Update the Whombat app, then try again.', { code: 'claim_update_app' });

const backoffError = (retryAt: Date, now: Date) =>
  new SessionOpError(
    'rate_limited',
    `Too many wrong codes. Try again in ${Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 60_000))} min.`,
    { code: 'claim_backoff', retryAt: retryAt.toISOString() },
  );

/** A trust error: the session error code, and the application code in `details.code` (CT-21, APP_ERROR_CODES). */
const trustError = (
  code: 'forbidden' | 'conflict' | 'rate_limited' | 'expired' | 'not_found' | 'unauthorized',
  message: string,
  app?: string,
) => new ApiError(code, message, app ? { details: { code: app } } : {});

export class TrustService {
  /** The console letters, lookup lease and console file (CC-01, CC-03, CC-08). */
  readonly ceremony: ClaimCeremony;
  /** Called once a claim committed (the runtime starts the licence state, LC-09). */
  onClaimed: (() => Promise<void>) | null = null;
  /** Passkeys that open this Whombat (docs/decisions/passkeys.md). */
  readonly passkeys: PasskeyService;
  /** Passkeys for the box's own host (own-address.md). */
  readonly boxPasskeys: BoxPasskeyService;
  /** Sign in at the box: six letters on its screen let a device in (signin-at-box BX-02…BX-07). */
  readonly screen: ScreenSignInService;
  /** Devices waiting to become a screen, with the letters they show (desk-display.md DK-146): memory only. */
  readonly display = new DisplayRequests();
  /**
   * A box claimed on its own pages (hermes-engine.md HE-58; whombat-link.md LNK-01): every box but one control registered
   * before Link. Claimed on its own page (`enroll.claim.local*`), nothing reported to control, no hosted app.
   */
  readonly community: boolean;
  /** The box's direct ways, best first (the boot sets them; links need one, HE-S212). */
  ways: () => readonly DirectRoute[] = () => [];
  /**
   * Where passkeys are verified (PK-02): the hosted UI's name on a commercial box; on a community box its Tailscale name
   * while that has HTTPS, else none (the boot sets it, HE-S230).
   */
  relyingParty: () => PasskeyRelyingParty | null;
  /** The box's own address (own-address.md): the A3 flag and the claim link; null on a community box. */
  ownAddress: OwnAddressService | null = null;
  /** The last verdict on a claim's proof still being given: the next one waits for it (`oneVerdict`). */
  private verdicts: Promise<unknown> = Promise.resolve();
  /** How long a verdict waits for the database (`VERDICT_WAIT_MS`; tests shorten it). */
  verdictWaitMs = VERDICT_WAIT_MS;
  /** Wrong tries the database didn't take: they count toward the wait all the same, and are written when it works again. */
  private uncounted: { method: ClaimMethod; peerId: string; at: Date }[] = [];
  /**
   * New letters were asked for at the box (the runtime closes the sessions of devices nobody let in, so what held
   * their places before the person came holds none).
   */
  onNewLetters: (() => void) | null = null;

  constructor(
    private readonly services: Services,
    private readonly manager: ManagerPort,
    /** The appliance content PeerId (recovery statements and kit confirmations are bound to it). */
    readonly appliancePeerId: string,
    /** Push to the person's endpoints (security notices). */
    readonly push: Pick<ControlPush, 'forAccounts' | 'security'> | null = null,
  ) {
    this.community = !registeredAtControl(services.config);
    // A community box has none until the boot knows its Tailscale name (HE-S219).
    this.relyingParty = this.community ? () => null : () => managedPasskeyRelyingParty(services.config);
    this.ceremony = new ClaimCeremony(services);
    this.passkeys = new PasskeyService(services, this);
    this.boxPasskeys = new BoxPasskeyService(services, this, manager);
    this.screen = new ScreenSignInService(new DbScreenSignInStore(services, this), this.ceremony, {
      appliancePeerId,
      clock: () => services.clock(),
      log: services.log,
    });
  }

  private get db() {
    return this.services.db;
  }

  private now(): Date {
    return this.services.clock();
  }

  /* Principals ---------------------------------------------------------------------------------- */

  /**
   * The endpoint and account behind a Noise identity (revoked endpoints count as unknown: MA-04). `client`, the build a
   * session's hello named, is kept on the endpoint with when it was last seen.
   */
  async identify(
    peerId: string,
    publicKey: string,
    client?: { build: string },
  ): Promise<SessionPrincipal & { revoked: boolean }> {
    const none = { peerId, publicKey, endpoint: null, account: null, authzGeneration: 0 };
    const [endpoint] = await this.db
      .select()
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.peerId, peerId));
    if (!endpoint || endpoint.publicKey !== publicKey) return { ...none, revoked: false };
    if (endpoint.revokedAt) return { ...none, revoked: true };
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, endpoint.accountId));
    if (!account) return { ...none, revoked: true };
    await this.db
      .update(applianceEndpoints)
      .set({ lastSeenAt: this.now(), ...(client ? { appBuild: client.build } : {}) })
      .where(eq(applianceEndpoints.id, endpoint.id));
    return {
      peerId,
      publicKey,
      endpoint,
      // A screen acts for nobody: whatever reads the session's account to act for the person finds none, so a way in
      // that forgot to check the channel still refuses it.
      account: isScreenEndpoint(endpoint) ? null : account,
      authzGeneration: account.authzGeneration,
      revoked: false,
    };
  }

  /**
   * Re-checks a session's principal before each request (permission recheck at execution): the endpoint was
   * revoked, or the account's authorization generation moved.
   */
  async recheck(
    principal: SessionPrincipal,
  ): Promise<{ ok: true } | { ok: false; reason: 'revoked' | 'authz_changed'; generation: number }> {
    // Every enrolled endpoint, a screen's (which has no account on its session) too.
    if (!principal.endpoint) return { ok: true };
    const [row] = await this.db
      .select({ revokedAt: applianceEndpoints.revokedAt, gen: accounts.authzGeneration })
      .from(applianceEndpoints)
      .innerJoin(accounts, eq(accounts.id, applianceEndpoints.accountId))
      .where(eq(applianceEndpoints.id, principal.endpoint.id));
    if (!row || row.revokedAt) return { ok: false, reason: 'revoked', generation: row?.gen ?? 0 };
    if (row.gen !== principal.authzGeneration)
      return { ok: false, reason: 'authz_changed', generation: row.gen };
    return { ok: true };
  }

  /** The account as the protocol's `PrincipalSummary` names it (CT-16): the account and its burrow principals. */
  async principalSummary(account: AccountRow) {
    const rows = await this.db
      .select({ burrowId: principals.burrowId, principalId: principals.id })
      .from(principals)
      .where(and(eq(principals.accountId, account.id), eq(principals.kind, 'person')))
      .orderBy(asc(principals.createdAt))
      .limit(256);
    return {
      accountId: account.id,
      name: (account.name || account.email).slice(0, 120),
      principals: rows,
    };
  }

  /** @internal (re-enrollment) */
  endpointSummary(row: EndpointRow, current: string | null) {
    return {
      endpointId: row.id,
      peerId: row.peerId,
      label: row.label,
      platform: row.platform,
      accountId: row.accountId,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      current: row.id === current,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      // A community box has no control to tell: the box refusing the key is all there is (HE-S232).
      revocation: !row.revokedAt
        ? ('none' as const)
        : row.revocationReportedAt || this.community
          ? ('applied' as const)
          : ('pending' as const),
    };
  }

  /** `EnrolledOutput` for an endpoint that was just enrolled (the session's own). */
  /** @internal (re-enrollment) */
  async enrolledOutput(endpointId: string) {
    // The enrollment committed: this only reads it back (command-safety.md CS-12).
    readingBack();
    const [row] = await this.db
      .select()
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.id, endpointId));
    if (!row) throw new Error('enrolled endpoint missing');
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, row.accountId));
    if (!account) throw new Error('enrolled account missing');
    return {
      ...(await this.principalSummary(account)),
      endpoint: this.endpointSummary(row, row.id),
      authzGeneration: account.authzGeneration,
    };
  }

  /* Appliance state ----------------------------------------------------------------------------- */

  private async state(tx: Tx | Services['db'] = this.db) {
    await tx.insert(applianceState).values({ id: STATE_ID }).onConflictDoNothing();
    const [row] = await tx.select().from(applianceState).where(eq(applianceState.id, STATE_ID));
    if (!row) throw new Error('appliance state missing');
    return row;
  }

  /**
   * Provisioning's claim record (`/persist/identity/claim.json`, `WHOMBAT_CLAIM_FILE`): the device id and the
   * domain-separated hash of the card's one-use secret — the `card` method's PAKE password (CT-66) — or null for a
   * self-registered device without a card (CC-10: only `code` claims it). The runtime never sees the secret itself.
   */
  async provisionClaim(record: {
    deviceId: string;
    secretHash: string | null;
  }): Promise<'stored' | 'unchanged' | 'claimed'> {
    const state = await this.state();
    if (state.claimConsumedAt) return 'claimed';
    if (state.claimSecretHash === record.secretHash && state.claimDeviceId === record.deviceId) {
      await this.refreshClaimConsole();
      return 'unchanged';
    }
    await this.db
      .update(applianceState)
      .set({ claimDeviceId: record.deviceId, claimSecretHash: record.secretHash, updatedAt: this.now() })
      .where(and(eq(applianceState.id, STATE_ID), isNull(applianceState.claimConsumedAt)));
    await this.refreshLinks();
    await this.refreshClaimConsole();
    return 'stored';
  }

  /**
   * A backup restored onto another box (a reinstall gets a new device id from control): the database is claimed but
   * names the old box's device id. The box takes its own id, so the licences control issues for it verify and links
   * name its page. The old box's token goes, since it never verifies for this id, and the claim time becomes now:
   * the no-licence grace starts afresh until the manager pushes this box's first token. Runs before the licence
   * loads. Returns the old device id when it changed, else null. `beforeAdopt` runs first, each time the id is about
   * to change: what belonged to the old box goes before this one takes its id, so a stop in between does it again.
   */
  async adoptDeviceId(
    record: { deviceId: string; secretHash: string | null },
    options: { beforeAdopt?: (old: string) => Promise<void> } = {},
  ): Promise<string | null> {
    const state = await this.state();
    if (!state.claimConsumedAt || !state.claimDeviceId || state.claimDeviceId === record.deviceId)
      return null;
    await options.beforeAdopt?.(state.claimDeviceId);
    const now = this.now();
    await this.db
      .update(applianceState)
      .set({
        claimDeviceId: record.deviceId,
        claimSecretHash: record.secretHash,
        claimConsumedAt: now,
        licenceToken: null,
        updatedAt: now,
      })
      .where(eq(applianceState.id, STATE_ID));
    return state.claimDeviceId;
  }

  /* Client security floor (CT-53, MR-41) ------------------------------------------------------------- */

  /** The running release's client floor (null: none), as the manager last reported it. */
  clientFloor: ClientFloor | null = null;

  /** Reads the floor kept across restarts (before the first `hello`). */
  async loadClientFloor(): Promise<ClientFloor | null> {
    const parsed = ClientFloor.safeParse((await this.state()).clientFloor);
    this.clientFloor = parsed.success ? parsed.data : null;
    return this.clientFloor;
  }

  /**
   * The manager's facts (`POST /facts`): `update` present → its `clientFloor` (absent = the running tuple has none);
   * `update` null → no update facts, the last floor stays.
   */
  async setClientFloor(floor: ClientFloor | null | undefined): Promise<void> {
    if (floor === undefined) return;
    if (JSON.stringify(floor) === JSON.stringify(this.clientFloor)) return;
    this.clientFloor = floor;
    await this.state();
    await this.db
      .update(applianceState)
      .set({ clientFloor: floor, updatedAt: this.now() })
      .where(eq(applianceState.id, STATE_ID));
  }

  /** The manager's physical claim window (MA-04 §3): required or not, and open until when. */
  async setClaimWindow(input: { required: boolean; openUntil: Date | null }): Promise<void> {
    await this.state();
    await this.db
      .update(applianceState)
      .set({
        claimWindowRequired: input.required ? 1 : 0,
        claimWindowUntil: input.openUntil,
        updatedAt: this.now(),
      })
      .where(eq(applianceState.id, STATE_ID));
  }

  /**
   * Where the server's links point on this appliance (parity G-10, MR-45): the hosted UI at
   * `/appliances/<device id>` (provisioning's device id); the hosted UI's origin alone until provisioning names
   * the device. `WHOMBAT_APP_URL` is required (the server refuses to boot without it); there are no relative links.
   */
  async refreshLinks(): Promise<string | null> {
    const deviceId = (await this.state()).claimDeviceId;
    let app: string;
    try {
      app = managedAppOrigin(this.services.config);
    } catch (err) {
      // A community box before it knows its own page (HE-S202): no links yet; the boot reads them again.
      if (!this.community) throw err;
      this.services.links.managedBase = null;
      return null;
    }
    this.services.links.managedBase =
      deviceId && !this.community ? `${app}/appliances/${encodeURIComponent(deviceId)}` : app;
    return this.services.links.managedBase;
  }

  async isClaimed(): Promise<boolean> {
    return (await this.state()).claimConsumedAt !== null;
  }

  /* enroll.claim.begin / enroll.claim (CC-06, CC-07, MR-49…MR-51) ------------------------------------ */

  /**
   * The claim state the console shows (at start, after the claim record loaded, after a failure or the claim):
   * claimed, whether provisioning named the device, and the backoff from the failure counters.
   */
  async refreshClaimConsole(): Promise<ClaimStatus> {
    const state = await this.state();
    const status: ClaimStatus = {
      claimed: state.claimConsumedAt !== null,
      deviceReady: state.claimDeviceId !== null,
      retryAt: state.claimConsumedAt ? null : await this.claimBackoff(this.now()),
    };
    // Claimed: the file carries the burrows and owner's language from its first `claimed` write on (CT-116).
    if (status.claimed) {
      await this.refreshConsoleBurrows();
      await this.refreshConsoleLocale();
    }
    this.ceremony.setStatus(status);
    return status;
  }

  /** Reads the owner's language preference and hands it to the console file. */
  async refreshConsoleLocale(): Promise<void> {
    const locale = await configuredBoxLocale(this.services);
    this.ceremony.setLocale(locale);
  }

  private burrowsGeneration = 0;

  /**
   * Reads the burrows the claimed console shows (MR-78) and hands them to the ceremony, which rewrites the file when
   * they changed. Called after every commit that creates, renames or removes a burrow (`ManagedRuntime.start`);
   * overlapping calls keep the latest read. Never reported anywhere else: the names stay on the box.
   */
  async refreshConsoleBurrows(): Promise<void> {
    const generation = ++this.burrowsGeneration;
    const burrows = await loadConsoleBurrows(this.db);
    if (generation === this.burrowsGeneration) this.ceremony.setBurrows(burrows);
  }

  /**
   * When `enroll.claim.begin` is accepted again (CC-07): the failures in the rolling 24 h window give
   * `claimBackoffSeconds` after the latest one; null when a begin is accepted now. The screen sign-in's failures
   * (method `screen`, BX-S02) are its own counter.
   */
  async claimBackoff(now: Date, db: Pick<Tx, 'select' | 'insert'> = this.db): Promise<Date | null> {
    const since = new Date(now.getTime() - CLAIM_FAILURE_WINDOW_S * 1000);
    await this.writeUncounted(db, since);
    const [row] = await db
      .select({ n: count(), latest: max(applianceClaimFailures.at) })
      .from(applianceClaimFailures)
      .where(
        and(gt(applianceClaimFailures.at, since), ne(applianceClaimFailures.method, SCREEN_FAILURE_METHOD)),
      );
    return this.backoffAfter(row?.n ?? 0, row?.latest ? new Date(row.latest) : null, now);
  }

  /** The wait after `n` wrong tries in the window, the latest at `latest`, with the ones the database didn't take. */
  private backoffAfter(n: number, latest: Date | null, now: Date): Date | null {
    const since = now.getTime() - CLAIM_FAILURE_WINDOW_S * 1000;
    const extra = this.uncounted.filter((f) => f.at.getTime() > since);
    const all = n + extra.length;
    const last = Math.max(latest?.getTime() ?? 0, ...extra.map((f) => f.at.getTime()));
    if (!all || !last) return null;
    const retryAt = new Date(last + claimBackoffSeconds(all) * 1000);
    return retryAt > now ? retryAt : null;
  }

  /**
   * Writes the wrong tries the database didn't take when they happened. One that still can't be written stays in
   * memory and keeps counting (`backoffAfter`).
   */
  private async writeUncounted(db: Pick<Tx, 'insert'>, since: Date): Promise<void> {
    this.uncounted = this.uncounted.filter((f) => f.at > since);
    if (!this.uncounted.length) return;
    const rows = this.uncounted;
    try {
      await db.insert(applianceClaimFailures).values(rows);
      this.uncounted = this.uncounted.filter((f) => !rows.includes(f));
    } catch (err) {
      this.services.log.warn(
        { ...errorForLog(err), kept: rows.length },
        'claim: wrong tries are still counted in memory only',
      );
    }
  }

  /**
   * `enroll.claim.begin {claimId, method, share}` (CC-07): runs the CPace responder with the method's password and
   * keeps `{tags, claimId, method}` for this session for `ENROLL_CLAIM_BEGIN_TTL_S` (a new begin replaces it). Refused
   * when claimed, not ready, outside a required claim window, in backoff, over the MR-26 attempt limits, or for an
   * invalid share (not counted). A begin alone costs no guess: it reveals nothing about the password.
   */
  async claimBegin(
    identity: Identity,
    session: SessionScope | null,
    input: { claimId: string; method: ClaimMethod; share: string },
  ): Promise<{ share: string }> {
    if (!session) throw new SessionOpError('unavailable', 'Claim this appliance over a session.');
    this.refuseOnCommunity();
    this.refuseInsideA3();
    const now = this.now();
    const state = await this.state();
    if (state.claimConsumedAt)
      throw trustError('conflict', 'This appliance is already claimed.', 'claim_used');
    // The password and the generation it belongs to are taken together, before anything waits (MR-51).
    const code = input.method === 'code' ? this.ceremony.codePassword(now) : null;
    const password = input.method === 'code' ? code?.password : state.claimSecretHash;
    const generation = code?.generation ?? this.ceremony.generation;
    if (!state.claimDeviceId || !password)
      throw new SessionOpError(
        'unavailable',
        input.method === 'code'
          ? 'This Whombat isn’t showing a claim code yet. Wait until the code is on its screen.'
          : 'This Whombat has no claim card. Claim it with the code on its screen.',
        { code: 'claim_not_ready' },
      );
    const windowOpen = this.claimWindowOpen(state, now);
    this.requireClaimWindow(state, windowOpen);
    await this.refuseInBackoff(identity.peerId, now);
    let pake: ReturnType<typeof claimPakeResponder>;
    try {
      pake = claimPakeResponder(
        {
          method: input.method,
          password,
          deviceId: state.claimDeviceId,
          appliancePeerId: this.appliancePeerId,
          clientPeerId: identity.peerId,
          claimId: input.claimId,
        },
        input.share,
        (n) => new Uint8Array(randomBytes(n)),
      );
    } catch (err) {
      if (err instanceof ClaimPakeError && err.code === 'invalid_share')
        throw new SessionOpError('validation_failed', 'The claim share isn’t valid.', {
          code: 'claim_share_invalid',
        });
      throw err;
    }
    const attemptId = await this.recordClaimAttempt(identity.peerId, now, windowOpen, null);
    session.claimBegin = {
      claimId: input.claimId,
      method: input.method,
      tags: pake.tags,
      expiresAt: new Date(now.getTime() + CLAIM_BEGIN_TTL_MS),
      generation,
      attemptId,
    };
    return { share: pake.share };
  }

  /**
   * `enroll.claim {claimId, method, confirm, account, endpoint}` (CC-07). The session's live begin for the same claim
   * id and method is used up whatever happens; `confirm` is compared with its client tag in constant time before
   * anything else. A mismatch is one failed guess (`claim_invalid`, counted; the letters rotate under `code`). A match
   * consumes the claim in one transaction (the person's account, the claiming endpoint, `appliance.claimed`), answers
   * the appliance's tag, clears the failure counters and switches the console to `claimed`.
   */
  async claim(
    identity: Identity,
    session: SessionScope | null,
    input: {
      claimId: string;
      method: ClaimMethod;
      confirm: string;
      account: { name: string; email: string };
      endpoint: { label: string; platform: EndpointPlatform };
      locale?: string | undefined;
    },
  ) {
    this.refuseOnCommunity();
    this.refuseInsideA3();
    const begin = await this.oneVerdict(async () => {
      const begin = session?.claimBegin ?? null;
      if (session) session.claimBegin = null;
      const now = this.now();
      if (
        !begin ||
        begin.local ||
        begin.claimId !== input.claimId ||
        begin.method !== input.method ||
        begin.expiresAt <= now ||
        // The letters changed since this begin (a wrong try under `code`): it can't be confirmed any more.
        begin.generation !== this.ceremony.generation
      )
        throw trustError(
          'conflict',
          'This claim wasn’t started on this connection, or it ran out. Enter the code again.',
          'claim_begin_missing',
        );
      if (!claimConfirmEqual(begin.tags.client, input.confirm)) {
        await this.recordClaimFailure(identity.peerId, input.method, now);
        throw trustError(
          'forbidden',
          input.method === 'code'
            ? 'That code isn’t right. Your Whombat now shows a new one.'
            : 'That claim code isn’t right.',
          'claim_invalid',
        );
      }
      return begin;
    });
    const { endpointId, accountId, locale } = await this.commitClaim(identity, input, input.method);
    return {
      ...(await this.afterClaim(endpointId, begin.attemptId, accountId, locale)),
      confirm: begin.tags.appliance,
    };
  }

  /**
   * One verdict at a time, across every session: the check of a claim's proof, the count of a wrong one and the change
   * of letters that follows are one step, so two proofs can never both be tried against the same letters.
   */
  private oneVerdict<T>(verdict: () => Promise<T>): Promise<T> {
    const next = this.verdicts.then(verdict, verdict);
    this.verdicts = next.catch(() => undefined);
    return next;
  }

  /**
   * Database work inside a verdict, waited for `verdictWaitMs` at most (`VerdictWaitError` after that), so a database
   * that doesn't answer never holds up the next verdict or the person asking for new letters. Whatever a verdict
   * decides about the letters is decided in memory before it waits here. `gaveUp` runs when the wait ended first: the
   * work may still finish later.
   */
  private bounded<T>(work: Promise<T>, what: string, gaveUp?: () => void): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        gaveUp?.();
        reject(new VerdictWaitError(what));
      }, this.verdictWaitMs);
      timer.unref?.();
    });
    // Its own failure after the wait gave up was answered already.
    work.catch(() => undefined);
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  /** A transaction's own time limits for a verdict's statements: under the verdict's wait, so it ends first. */
  private verdictLimits(tx: Tx) {
    const limit = `${Math.max(1, Math.floor(this.verdictWaitMs / 2))}ms`;
    return tx.execute(
      sql`select set_config('statement_timeout', ${limit}, true), set_config('lock_timeout', ${limit}, true)`,
    );
  }

  /** A claim window is open: the manager's physical one, or new letters asked for at the box's own screen. */
  private claimWindowOpen(state: { claimWindowUntil: Date | null }, now: Date): boolean {
    return Boolean(state.claimWindowUntil && state.claimWindowUntil > now) || !!this.ceremony.liveWindow(now);
  }

  /** When the claim window open now ends (the later of the manager's and the box's own), or null without one. */
  private claimWindowEnd(state: { claimWindowUntil: Date | null }, now: Date): Date | null {
    const ends = [state.claimWindowUntil, this.ceremony.liveWindow(now)?.until ?? null].filter(
      (t): t is Date => t !== null && t > now,
    );
    return ends.length ? new Date(Math.max(...ends.map((t) => t.getTime()))) : null;
  }

  /** Where the manager says a claim needs a window, one must be open. */
  private requireClaimWindow(state: { claimWindowRequired: number }, windowOpen: boolean): void {
    if (state.claimWindowRequired && !windowOpen)
      throw trustError('forbidden', `${this.windowHow()}, then try again.`, 'claim_window_closed');
  }

  /**
   * How the person at the box opens a claim window: new letters on its own screen where the box shows letters of its
   * own; the manager's claim button on a box claimed through control.
   */
  private windowHow(): string {
    return this.ceremony.local
      ? 'Ask for new letters on your Whombat’s own screen'
      : 'Press the claim button on the appliance';
  }

  /**
   * The wait after wrong tries (`claim_backoff`). New letters asked for at the box set it aside while they show; there
   * a device that used its wrong tries on them waits for the next ones instead.
   */
  private async refuseInBackoff(peerId: string, now: Date): Promise<void> {
    if (this.ceremony.liveWindow(now)) {
      if (this.ceremony.windowSpent(peerId, now)) throw this.triesSpentError();
      return;
    }
    const retryAt = await this.claimBackoff(now);
    if (retryAt) throw backoffError(retryAt, now);
  }

  /** A device used its wrong tries on the letters asked for at the box: it waits for the next ones. */
  private triesSpentError() {
    return trustError(
      'rate_limited',
      `This device tried ${CLAIM_WINDOW_WRONG_PER_KEY} wrong codes. Ask for new letters on your Whombat’s own screen, then try again.`,
      'claim_rate_limited',
    );
  }

  /**
   * New letters, asked for at the box's own screen (the desk socket, which only the console reaches): fresh letters that
   * stay for `CLAIM_WINDOW_S`, with the wait after wrong tries and the hourly count of begun claims set aside meanwhile,
   * so nobody else on the network can keep the person at the box from claiming it. Null when the box shows no letters
   * of its own. It waits for a verdict being given, so the letters never change in the middle of one.
   */
  openClaimWindow(): Promise<Date | null> {
    return this.oneVerdict(async () => {
      const until = this.ceremony.openWindow(this.now());
      if (until) {
        this.services.log.info({ until: until.toISOString() }, 'claim: new letters asked for at the box');
        this.onNewLetters?.();
      }
      return until;
    });
  }

  /**
   * A confirmed claim's write (`enroll.claim`, `enroll.claim.local`): one transaction makes the person's account, the
   * claiming endpoint and `appliance.claimed` with `method`, under the ownership row's lock, where a required claim
   * window is checked once more. Its statements have the verdict's time limits. `abandoned` is asked last, before the
   * transaction ends: the caller stopped waiting, so nothing is claimed behind its back.
   */
  private async commitClaim(
    identity: Identity,
    input: {
      claimId: string;
      account: { name: string; email: string };
      endpoint: { label: string; platform: EndpointPlatform };
      locale?: string | undefined;
    },
    method: string,
    abandoned: () => boolean = () => false,
  ): Promise<{ endpointId: string; accountId: string; locale: string | null }> {
    const now = this.now();
    const initialLocale = normalizeLocaleTag(input.locale);
    return (
      this.services.pipeline
        .transactAccount(async (tx) => {
          await this.verdictLimits(tx);
          await this.state(tx);
          const [state] = await tx
            .select()
            .from(applianceState)
            .where(eq(applianceState.id, STATE_ID))
            .for('update');
          if (!state) throw new Error('appliance state missing');
          if (state.claimConsumedAt)
            throw trustError('conflict', 'This appliance is already claimed.', 'claim_used');
          this.requireClaimWindow(state, this.claimWindowOpen(state, now));
          const email = input.account.email.trim().toLowerCase();
          const [account] = await tx
            .insert(accounts)
            .values({
              id: newId('account'),
              email,
              name: input.account.name,
              ...(initialLocale ? { preferences: { ...DEFAULT_PREFERENCES, locale: initialLocale } } : {}),
              createdAt: now,
            })
            .onConflictDoNothing({ target: accounts.email })
            .returning();
          if (!account)
            throw trustError(
              'conflict',
              'An account with that email already exists on this appliance.',
              'account_exists',
            );
          const consumed = await tx
            .update(applianceState)
            .set({
              claimConsumedAt: now,
              claimedByAccountId: account.id,
              claimId: input.claimId,
              updatedAt: now,
            })
            .where(and(eq(applianceState.id, STATE_ID), isNull(applianceState.claimConsumedAt)))
            .returning({ id: applianceState.id });
          if (!consumed.length)
            throw trustError('conflict', 'This appliance is already claimed.', 'claim_used');
          const endpointId = await this.insertEndpoint(tx, {
            identity,
            accountId: account.id,
            endpoint: input.endpoint,
            via: 'claim',
            by: null,
            at: now,
          });
          await appendApplianceEvent(tx, this.services.custody, {
            type: 'appliance.claimed',
            actorAccountId: account.id,
            endpointId,
            payload: { accountId: account.id, peerId: identity.peerId, method },
            at: now,
          });
          if (abandoned()) throw new VerdictWaitError('write the claim');
          return { endpointId, accountId: account.id, locale: initialLocale };
        })
        // A statement that fails here carries the person's name and email: they stop here, out of every log.
        .catch((err) => {
          throw withoutValues(err);
        })
    );
  }

  /**
   * After a claim was written: its attempt is marked, the failure counters go, the console says the appliance is set
   * up, the claim link is used up. A commercial box then reports the claim to control; a community box has none.
   */
  private async afterClaim(
    endpointId: string,
    attemptId: number,
    accountId?: string,
    locale: string | null = null,
  ) {
    if (accountId && locale) notifyLocaleChanged(this.services, accountId, locale);
    await this.db
      .update(applianceClaimAttempts)
      .set({ ok: 1 })
      .where(eq(applianceClaimAttempts.id, attemptId));
    // Success clears the counters (CC-07); the console now says the appliance is set up.
    this.uncounted = [];
    await this.db
      .delete(applianceClaimFailures)
      .where(ne(applianceClaimFailures.method, SCREEN_FAILURE_METHOD));
    await this.refreshClaimConsole();
    await this.onClaimed?.();
    // Inside A3 the link carries the box to the account instead (`account.link`); the claim link is used up.
    this.ownAddress?.claimLink.rotate();
    if (!this.community && !this.sharedRouteOff) void this.reportPending();
    return {
      ...(await this.enrolledOutput(endpointId)),
      // No recovery kit at the claim any more (BX-01): the box's screen is the way back in (`enroll.screen`).
      recoveryKitRequired: false,
    };
  }

  /** A box inside A3 is never claimed through control (own-address.md): only on a page it served. */
  private refuseInsideA3(): void {
    if (this.sharedRouteOff)
      throw new ApiError(
        'not_allowed',
        'Set up this Whombat on its own page: open the address on its screen.',
        {
          details: { code: 'claim_here_unavailable' },
        },
      );
  }

  /** A commercial box's claim through control isn't a community box's (HE-S231): it is claimed on its own page. */
  private refuseOnCommunity(): void {
    if (this.community)
      throw new ApiError(
        'not_allowed',
        'This Whombat is set up on its own page: open its address and type the code on its screen.',
      );
  }

  /** Whether this box started with its own address only (A3, own-address.md): claimed and joined on its own pages. */
  get sharedRouteOff(): boolean {
    return this.ownAddress?.sharedRouteOff ?? false;
  }

  /**
   * `enroll.claim.local*` (CT-1302) on a community box, and on a box inside A3 over a session that reached it directly
   * (its own address, its local network, Tailscale): a page it served. Through the relay an A3 box refuses it
   * (`claim_here_unavailable`); any other commercial box is claimed through control.
   */
  private requireLocalClaim(transport: SessionTransport | undefined): void {
    if (this.community) return;
    if (this.sharedRouteOff) {
      if (transport?.via === 'direct') return;
      throw new ApiError(
        'not_allowed',
        'Set up this Whombat on its own page: open the address on its screen.',
        { details: { code: 'claim_here_unavailable' } },
      );
    }
    throw new ApiError(
      'not_allowed',
      'This Whombat is claimed through the Whombat app, not on its own page.',
      {
        details: { code: 'claim_local_unavailable' },
      },
    );
  }

  /**
   * At the own address, an unclaimed box takes a claim only with its claim link's secret (own-address.md): a wrong or
   * missing one is refused as `claim_link`. A wrong one is a try of the visitor's own address, counted apart: never in
   * the claim's backoff, and never against the link itself, which stays as the screen shows it. Asked of the session's
   * own start and again of its begin, so a start allowed on another way in never opens the door's.
   */
  private requireClaimLink(session: SessionScope, link: string | undefined): void {
    const transport = session.transport;
    if (transport?.via !== 'direct' || transport.network !== 'door') return;
    if (this.ownAddress?.claimLink.check(link, session.doorPeer ?? '')) return;
    throw trustError('forbidden', 'Open the address on your Whombat’s screen to set it up.', 'claim_link');
  }

  /**
   * `enroll.claim.local.start {}`: the box's own claim id for this session, for
   * `LOCAL_CLAIM_TTL_S` (a new start on the session replaces it), and whether a claim can start now (`claim_used`,
   * `claim_not_ready`, `claim_backoff`). It stays on the session that asked, with the claim link's secret it carried:
   * only that session begins the exchange. Memory only; costs no guess.
   */
  async localClaimStart(
    identity: Identity,
    session: SessionScope | null,
    input: { link?: string | undefined } = {},
    protocolMinor?: number,
  ): Promise<{ claimId: string; expiresAt: string }> {
    this.requireLocalClaim(session?.transport);
    if (!session) throw new SessionOpError('unavailable', 'Claim this Whombat over a session.');
    // An app from before the proof round would name the person before this box proved itself: it updates first.
    if (protocolMinor !== undefined && protocolMinor < LOCAL_CLAIM_PROVE_MINOR) throw updateAppError();
    const now = this.now();
    if (await this.isClaimed()) throw trustError('conflict', 'This Whombat is already set up.', 'claim_used');
    this.requireClaimLink(session, input.link);
    if (!this.ceremony.codePassword(now))
      throw new SessionOpError(
        'unavailable',
        'This Whombat isn’t showing a code yet. Try again in a moment.',
        {
          code: 'claim_not_ready',
        },
      );
    await this.refuseInBackoff(identity.peerId, now);
    const claimId = `lcl_${randomBytes(16).toString('base64url')}`;
    const expiresAt = new Date(now.getTime() + LOCAL_CLAIM_TTL_S * 1000);
    session.localStart = { claimId, expiresAt, link: input.link };
    return { claimId, expiresAt: expiresAt.toISOString() };
  }

  /**
   * `enroll.claim.local.begin {claimId, share}`: only on the session that started that claim id, whose claim
   * link is checked again here; the CPace responder with the console letters bound to both Noise keys and the claim id
   * (`localClaimPakeResponder`), kept for this session like `enroll.claim.begin` (one attempt counted). Refused
   * when claimed, in backoff, outside a claim window the manager requires, without the start (`claim_start_missing`) or
   * for an invalid share (not counted).
   */
  async localClaimBegin(
    identity: Identity,
    session: SessionScope | null,
    input: { claimId: string; share: string },
  ): Promise<{ share: string }> {
    this.requireLocalClaim(session?.transport);
    if (!session) throw new SessionOpError('unavailable', 'Claim this Whombat over a session.');
    const now = this.now();
    const state = await this.state();
    if (state.claimConsumedAt) throw trustError('conflict', 'This Whombat is already set up.', 'claim_used');
    const start = session.localStart ?? null;
    if (!start || start.claimId !== input.claimId || start.expiresAt <= now)
      throw trustError(
        'conflict',
        'This claim ran out. Start again with the code on the screen.',
        'claim_start_missing',
      );
    // The exchange begins where its start was allowed: at the own address that takes the claim link, on this session.
    this.requireClaimLink(session, start.link);
    // The letters, the generation they belong to and the window they were asked for in, taken together before anything
    // waits (MR-51): the exchange is counted on that very window, whatever the clock said when it was asked. The window
    // first: one that just ran out takes its letters with it.
    const window = this.ceremony.liveWindow(now);
    const code = this.ceremony.codePassword(now);
    if (!code)
      throw new SessionOpError(
        'unavailable',
        'This Whombat isn’t showing a code yet. Try again in a moment.',
        {
          code: 'claim_not_ready',
        },
      );
    const windowOpen = this.claimWindowOpen(state, now);
    this.requireClaimWindow(state, windowOpen);
    await this.refuseInBackoff(identity.peerId, now);
    let pake: ReturnType<typeof localClaimPakeResponder>;
    try {
      pake = localClaimPakeResponder(
        {
          password: code.password,
          appliancePeerId: this.appliancePeerId,
          clientPeerId: identity.peerId,
          claimId: input.claimId,
        },
        input.share,
        (n) => new Uint8Array(randomBytes(n)),
      );
    } catch (err) {
      if (err instanceof ClaimPakeError && err.code === 'invalid_share')
        throw new SessionOpError('validation_failed', 'The claim share isn’t valid.', {
          code: 'claim_share_invalid',
        });
      throw err;
    }
    // New letters asked for at the box give every device its tries again, whatever it began before.
    const attemptId = await this.recordClaimAttempt(identity.peerId, now, windowOpen, window);
    session.claimProof = null;
    session.claimBegin = {
      claimId: input.claimId,
      method: 'code',
      local: true,
      tags: pake.tags,
      expiresAt: new Date(now.getTime() + CLAIM_BEGIN_TTL_MS),
      generation: code.generation,
      attemptId,
    };
    return { share: pake.share };
  }

  /**
   * `enroll.claim.local.prove {claimId, confirm}`: the proofs alone, before the person is named. The session's live
   * local begin is used up whatever happens and `confirm` checked against it in constant time, one verdict at a time
   * across all sessions. A device that used its wrong tries on the letters showing is refused here too, untried,
   * however many exchanges it began before its first wrong one. A mismatch is one wrong guess (the letters rotate, the
   * backoff counts). A match answers the box's own tag and lets this session claim once (`enroll.claim.local`), with
   * the letters it proved and within the time its exchange had: a proof gets no time of its own.
   */
  async localClaimProve(
    identity: Identity,
    session: SessionScope | null,
    input: { claimId: string; confirm: string },
  ): Promise<{ confirm: string }> {
    this.requireLocalClaim(session?.transport);
    if (!session) throw new SessionOpError('unavailable', 'Claim this Whombat over a session.');
    return this.oneVerdict(async () => {
      const begin = session.claimBegin ?? null;
      session.claimBegin = null;
      session.claimProof = null;
      const now = this.now();
      // Letters asked for at the box that ran out a moment ago are gone before this proof is looked at.
      this.ceremony.liveWindow(now);
      if (
        !begin?.local ||
        begin.claimId !== input.claimId ||
        begin.expiresAt <= now ||
        // The letters changed since this begin: it can't be proved any more.
        begin.generation !== this.ceremony.generation
      )
        throw trustError(
          'conflict',
          'This claim wasn’t started on this connection, or it ran out. Enter the code again.',
          'claim_begin_missing',
        );
      const state = await this.bounded(this.state(), 'read the claim');
      if (state.claimConsumedAt)
        throw trustError('conflict', 'This Whombat is already set up.', 'claim_used');
      this.requireClaimWindow(state, this.claimWindowOpen(state, now));
      // Asked here again, in line with every other verdict: exchanges this device began before its first wrong try
      // don't give it more tries than a device has.
      if (this.ceremony.windowSpent(identity.peerId, now)) throw this.triesSpentError();
      if (!claimConfirmEqual(begin.tags.client, input.confirm)) {
        await this.recordClaimFailure(identity.peerId, 'code', now);
        throw trustError(
          'forbidden',
          'That code isn’t right. Check your Whombat’s screen and try again.',
          'claim_invalid',
        );
      }
      // Where a claim needs a window, the proof ends with the one it was made in: it never finishes in the next.
      const windowEnd = state.claimWindowRequired ? this.claimWindowEnd(state, now) : null;
      session.localStart = null;
      session.claimProof = {
        claimId: begin.claimId,
        expiresAt: windowEnd && windowEnd < begin.expiresAt ? windowEnd : begin.expiresAt,
        generation: begin.generation,
        attemptId: begin.attemptId,
      };
      return { confirm: begin.tags.appliance };
    });
  }

  /**
   * `enroll.claim.local {claimId, account, endpoint}`: once, on the session that proved it knows the
   * letters and was shown the box's proof (`claim_proof_missing` otherwise). It makes `account` the person's, with this
   * device (`via: 'claim'`, a signed `appliance.claimed` with method `local`), as `enroll.claim` does. The proof must
   * still stand: within the time of its exchange, and for the letters showing now. It is checked and the claim written
   * in line with the verdicts and with new letters asked for at the box, so letters the person retired never finish a
   * claim. The form that came with the client's tag and the account together is refused unread (`claim_update_app`).
   */
  async localClaim(
    identity: Identity,
    session: SessionScope | null,
    input: {
      claimId: string;
      confirm?: string | undefined;
      account: { name: string; email: string };
      endpoint: { label: string; platform: EndpointPlatform };
      locale?: string | undefined;
    },
  ) {
    this.requireLocalClaim(session?.transport);
    if (input.confirm !== undefined) {
      if (session) session.claimBegin = null;
      throw updateAppError();
    }
    const done = await this.oneVerdict(async () => {
      const proof = session?.claimProof ?? null;
      if (session) session.claimProof = null;
      const now = this.now();
      // Letters asked for at the box that ran out a moment ago take their proofs with them.
      this.ceremony.liveWindow(now);
      if (!this.proofStands(proof, input.claimId, now))
        throw trustError(
          'conflict',
          'This claim ran out. Enter the code on the screen again.',
          'claim_proof_missing',
        );
      // The wait for the write ends before the next verdict is due. Past it nothing is claimed behind the device's
      // back: the transaction asks last whether anyone still waits. Should it have ended already, the box is claimed
      // all the same, and says so when the write comes back.
      let gaveUp = false;
      const written = this.commitClaim(identity, input, 'local', () => gaveUp).then((claimed) => {
        this.ceremony.markClaimed();
        return claimed;
      });
      try {
        return {
          ...(await this.bounded(written, 'write the claim', () => {
            gaveUp = true;
          })),
          attemptId: proof.attemptId,
        };
      } catch (err) {
        if (gaveUp)
          void written
            .then(({ endpointId, accountId, locale }) =>
              this.afterClaim(endpointId, proof.attemptId, accountId, locale),
            )
            .catch(() => undefined);
        throw err;
      }
    });
    return this.afterClaim(done.endpointId, done.attemptId, done.accountId, done.locale);
  }

  /** Whether a session's proof is the one for `claimId`, in time, and for the letters showing now. */
  private proofStands(proof: ClaimProof | null, claimId: string, now: Date): proof is ClaimProof {
    return (
      proof !== null &&
      proof.claimId === claimId &&
      proof.expiresAt > now &&
      proof.generation === this.ceremony.generation
    );
  }

  /**
   * The link for a secret the box made (contracts `localLinkFor`, CT-1304; HE-S212): the box's page on its direct ways,
   * best first; undefined while it has none (no local-network address, Tailscale off).
   */
  localLink(kind: LocalLinkKind, secret: string): string | undefined {
    const routes = this.ways();
    // The own address first, while it serves its page (own-address.md): the link's base, `o=` in its fragment.
    const host = this.ownAddress?.serving() ? this.ownAddress.host() : null;
    const own = host ? `https://${host}/` : null;
    if (!routes.length && !own) return undefined;
    try {
      return localLinkFor({ kind, appliance: this.appliancePeerId, secret, routes: [...routes], own });
    } catch (err) {
      this.services.log.warn({ err: String(err), kind }, 'link: the box’s ways don’t make a link');
      return undefined;
    }
  }

  /**
   * `enroll.link.create {}` (CT-1305; HE-60, HE-S214): a one-time secret that lets one more device of this account in for
   * `DEVICE_LINK_TTL_S`, and its link. One live link per account (a new one replaces it); `link_unavailable` while the
   * box has no direct way to put in it.
   */
  async linkCreate(viewer: SessionPrincipal) {
    const { endpoint, account } = requireEnrolled(viewer);
    const now = this.now();
    const secret = randomBytes(24).toString('base64url');
    const link = this.localLink('device', secret);
    if (!link)
      throw new SessionOpError(
        'unavailable',
        'This Whombat has no address to put in a link right now. Connect it to your network, or turn on Tailscale.',
        { code: 'link_unavailable' },
      );
    const linkId = localId('dlink');
    const expiresAt = new Date(now.getTime() + DEVICE_LINK_TTL_S * 1000);
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx
        .update(endpointDeviceLinks)
        .set({ replacedAt: now })
        .where(
          and(
            eq(endpointDeviceLinks.accountId, account.id),
            isNull(endpointDeviceLinks.consumedAt),
            isNull(endpointDeviceLinks.replacedAt),
          ),
        );
      await tx.insert(endpointDeviceLinks).values({
        id: linkId,
        accountId: account.id,
        createdByEndpointId: endpoint.id,
        secretHash: sha256(secret),
        createdAt: now,
        expiresAt,
      });
    });
    return { linkId, secret, expiresAt: expiresAt.toISOString(), link };
  }

  /**
   * `enroll.link.accept {secret, endpoint}` (enrollment channel, CT-1305): this session's key joins the account that made
   * the link, enrolled by the device that made it (`via: 'link'`), and the link is used up. Refusals: `link_invalid`
   * (unknown, or the device that made it was removed), `link_used` (used or replaced), `link_expired`,
   * `endpoint_enrolled` (the key is another account's). A key already in the link's account answers as enrolled.
   */
  async linkAccept(
    identity: Identity,
    input: { secret: string; endpoint: { label: string; platform: EndpointPlatform } },
  ) {
    const now = this.now();
    const invalid = () =>
      trustError('forbidden', 'That link doesn’t work. Make a new one on your other device.', 'link_invalid');
    const endpointId = await this.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .select()
        .from(endpointDeviceLinks)
        .where(eq(endpointDeviceLinks.secretHash, sha256(input.secret.trim())))
        .for('update');
      if (!row) throw invalid();
      if (row.consumedAt || row.replacedAt)
        throw trustError('conflict', 'That link was used already, or a newer one replaced it.', 'link_used');
      if (row.expiresAt <= now)
        throw trustError('expired', 'That link’s five minutes are over. Make a new one.', 'link_expired');
      const [maker] = await tx
        .select()
        .from(applianceEndpoints)
        .where(eq(applianceEndpoints.id, row.createdByEndpointId));
      if (!maker || maker.revokedAt || maker.accountId !== row.accountId) throw invalid();
      // A device that is in this account already (a phone whose key the box kept from before, e.g. after a move to
      // another control) is let in again as it was: nothing new is enrolled, the link is used up. A key of another
      // account, or a revoked one, is still refused below.
      const [known] = await tx
        .select()
        .from(applianceEndpoints)
        .where(eq(applianceEndpoints.peerId, identity.peerId));
      if (known && !known.revokedAt && known.accountId === row.accountId) {
        await tx
          .update(endpointDeviceLinks)
          .set({ consumedAt: now, consumedByEndpointId: known.id })
          .where(eq(endpointDeviceLinks.id, row.id));
        return known.id;
      }
      const id = await this.insertEndpoint(tx, {
        identity,
        accountId: row.accountId,
        endpoint: input.endpoint,
        via: 'link',
        by: maker.id,
        at: now,
      });
      await tx
        .update(endpointDeviceLinks)
        .set({ consumedAt: now, consumedByEndpointId: id })
        .where(eq(endpointDeviceLinks.id, row.id));
      return id;
    });
    return this.enrolledOutput(endpointId);
  }

  /**
   * `enroll.dev` (contracts 1.0.0 CT-1257; hermes-engine.md HE-49, HE-S187; one-person.md OP-S12): a development runtime
   * lets the key of this session in as the Whombat's person. Once someone claimed it (a seeded world names its person)
   * that is their account, whatever email the device names; before that the account with `account.email` (created with
   * `account.name` when new) becomes the person and the Whombat is claimed (a signed `appliance.claimed` with method
   * `dev`). Refused outside development whoever calls (`dev_only`); the op also needs a direct loopback session.
   */
  async developmentEnrol(
    identity: Identity,
    input: {
      account: { name: string; email: string };
      endpoint: { label: string; platform: EndpointPlatform };
    },
  ) {
    if (this.services.config.NODE_ENV !== 'development')
      throw trustError('forbidden', 'Only a Whombat in development lets a device in this way.', 'dev_only');
    const now = this.now();
    const email = input.account.email.trim().toLowerCase();
    const result = await this.services.pipeline.transactAccount(async (tx) => {
      await this.state(tx);
      const [state] = await tx
        .select()
        .from(applianceState)
        .where(eq(applianceState.id, STATE_ID))
        .for('update');
      if (!state) throw new Error('appliance state missing');
      let [account] = state.claimedByAccountId
        ? await tx.select().from(accounts).where(eq(accounts.id, state.claimedByAccountId))
        : await tx.select().from(accounts).where(eq(accounts.email, email));
      if (!account)
        [account] = await tx
          .insert(accounts)
          .values({ id: newId('account'), email, name: input.account.name, createdAt: now })
          .returning();
      if (!account) throw new Error('development account not created');
      const claims = !state.claimConsumedAt;
      if (claims)
        await tx
          .update(applianceState)
          .set({ claimConsumedAt: now, claimedByAccountId: account.id, claimId: 'dev', updatedAt: now })
          .where(eq(applianceState.id, STATE_ID));
      const endpointId = await this.insertEndpoint(tx, {
        identity,
        accountId: account.id,
        endpoint: input.endpoint,
        via: DEVELOPMENT_ENROLLED_VIA,
        by: null,
        at: now,
      });
      if (claims)
        await appendApplianceEvent(tx, this.services.custody, {
          type: 'appliance.claimed',
          actorAccountId: account.id,
          endpointId,
          payload: { accountId: account.id, peerId: identity.peerId, method: 'dev' },
          at: now,
        });
      return { endpointId, claims };
    });
    if (result.claims) {
      await this.refreshClaimConsole();
      await this.onClaimed?.();
    }
    return this.enrolledOutput(result.endpointId);
  }

  /**
   * One failed confirmation, inside `oneVerdict`. What it was tried against goes first, in memory, where nothing can
   * fail or wait: every live begin ends and the letters rotate under `code`; while new letters asked for at the box
   * show, the window counts the try and its letters and other devices' exchanges stay, until its last wrong try. Then
   * the try is counted in the database (so a restart keeps the backoff; rows past the 24 h window go), within the
   * verdict's wait, and the console shows the new code or the backoff. A try the database didn't take is counted in
   * memory until it does, and ends a window too: letters are never left usable on a count that isn't kept. Nothing
   * here names the letters.
   */
  private async recordClaimFailure(peerId: string, method: ClaimMethod, now: Date): Promise<void> {
    let window = method === 'code' ? this.ceremony.windowFailed(peerId, now) : 'none';
    if (window !== 'open') this.ceremony.failed(method);
    let retryAt: Date | null;
    let counted = true;
    try {
      retryAt = await this.bounded(this.countClaimFailure(peerId, method, now), 'count a wrong try');
    } catch (err) {
      counted = false;
      this.uncounted.push({ method, peerId, at: now });
      this.uncounted.splice(0, Math.max(0, this.uncounted.length - UNCOUNTED_FAILURES_MAX));
      if (window === 'open') {
        this.ceremony.endWindow();
        this.ceremony.failed(method);
        window = 'ended';
      }
      // The wait this try gives by what memory knows; the next begin reads the database again.
      retryAt = this.backoffAfter(0, null, now);
      this.services.log.warn(
        { ...errorForLog(err), method },
        'claim: a wrong confirmation could not be counted in the database; counted in memory, the letters changed',
      );
    }
    this.ceremony.setRetryAt(retryAt);
    this.services.log.warn(
      { method, backoffUntil: retryAt?.toISOString() ?? null, window, counted },
      'claim: a wrong confirmation (one failed guess)',
    );
  }

  /**
   * Counts one wrong try in the database and reads the wait it gives, in one short transaction with the verdict's own
   * time limits. A claimed box counts none.
   */
  private countClaimFailure(peerId: string, method: ClaimMethod, now: Date): Promise<Date | null> {
    return this.db.transaction(async (tx) => {
      await this.verdictLimits(tx);
      const [state] = await tx
        .select({ consumed: applianceState.claimConsumedAt })
        .from(applianceState)
        .where(eq(applianceState.id, STATE_ID));
      if (state?.consumed) return null;
      await tx.insert(applianceClaimFailures).values({ method, peerId, at: now });
      await tx
        .delete(applianceClaimFailures)
        .where(lte(applianceClaimFailures.at, new Date(now.getTime() - CLAIM_FAILURE_WINDOW_S * 1000)));
      return this.claimBackoff(now, tx);
    });
  }

  /**
   * Claim attempts (review M-3/I-4, MR-26), counted at `enroll.claim.begin` since 0.7 (CC-07): at most
   * `CLAIM_ATTEMPTS_PER_PEER` per endpoint key and hour, and `CLAIM_ATTEMPTS_TOTAL` overall per hour — except while
   * a claim window is open (the manager's, or new letters asked for at the box's own screen), so strangers with
   * throwaway keys can't lock out the person at the appliance: every device keeps its own count there. Checked and
   * recorded atomically (one transaction under an advisory lock). An exchange begun with letters asked for at the box
   * is counted on that `window` itself, in memory with it, not by the clock: what a device began before those letters
   * doesn't count, and nothing begun with them is missed. Returns the attempt's id.
   */
  private async recordClaimAttempt(
    peerId: string,
    now: Date,
    windowOpen: boolean,
    /** The letters of this exchange were asked for at the box: its window. */
    window: ClaimWindow | null,
  ): Promise<number> {
    const hourAgo = new Date(now.getTime() - 3600_000);
    if (window && !this.ceremony.windowBegin(window, peerId, CLAIM_ATTEMPTS_PER_PEER))
      throw this.attemptsError('peer');
    let refused: number | 'peer' | 'total';
    try {
      refused = await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('whombat/claim-attempts'))`);
        if (!window) {
          const [peer] = await tx
            .select({ n: count() })
            .from(applianceClaimAttempts)
            .where(and(eq(applianceClaimAttempts.peerId, peerId), gt(applianceClaimAttempts.at, hourAgo)));
          if ((peer?.n ?? 0) >= CLAIM_ATTEMPTS_PER_PEER) return 'peer' as const;
        }
        if (!windowOpen) {
          const [all] = await tx
            .select({ n: count() })
            .from(applianceClaimAttempts)
            .where(gt(applianceClaimAttempts.at, hourAgo));
          if ((all?.n ?? 0) >= CLAIM_ATTEMPTS_TOTAL) return 'total' as const;
        }
        const [row] = await tx
          .insert(applianceClaimAttempts)
          .values({ peerId, at: now })
          .returning({ id: applianceClaimAttempts.id });
        if (!row) throw new Error('claim attempt not recorded');
        return row.id;
      });
    } catch (err) {
      if (window) this.ceremony.windowUnbegin(window, peerId);
      throw err;
    }
    if (typeof refused === 'number') return refused;
    if (window) this.ceremony.windowUnbegin(window, peerId);
    throw this.attemptsError(refused);
  }

  /** Too many claims begun: by this device, or on this box in the hour. */
  private attemptsError(which: 'peer' | 'total') {
    if (which === 'peer')
      return trustError(
        'rate_limited',
        this.ceremony.local
          ? `Too many claim attempts from this device. ${this.windowHow()}, or wait an hour.`
          : 'Too many claim attempts from this device. Wait an hour and try again.',
        this.ceremony.local ? 'claim_rate_limited' : undefined,
      );
    return trustError(
      'rate_limited',
      `Too many claim attempts on this appliance. ${this.windowHow()}, then try again.`,
      'claim_rate_limited',
    );
  }

  /** @internal (re-enrollment) */
  async insertEndpoint(
    tx: Tx,
    input: {
      identity: Identity;
      accountId: string;
      endpoint: { label: string; platform: EndpointPlatform };
      via: EndpointRow['enrolledVia'];
      by: string | null;
      at: Date;
      /** The passkey that enrolls it (`via: 'passkey'`, PK-05): stored, and named in `endpoint.enrolled`. */
      passkeyId?: string;
    },
  ): Promise<string> {
    const [existing] = await tx
      .select()
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.peerId, input.identity.peerId));
    if (existing?.revokedAt)
      throw forbidden(
        'This device key was revoked on this appliance. Reset the app’s storage to get a new key.',
      );
    if (existing) throw trustError('conflict', 'This device is already enrolled.', 'endpoint_enrolled');
    const id = localId('ep');
    await tx.insert(applianceEndpoints).values({
      id,
      peerId: input.identity.peerId,
      publicKey: input.identity.publicKey,
      accountId: input.accountId,
      label: input.endpoint.label,
      platform: input.endpoint.platform,
      enrolledVia: input.via,
      enrolledByEndpointId: input.by,
      createdAt: input.at,
      lastSeenAt: input.at,
      enrolledPasskeyId: input.passkeyId ?? null,
    });
    await appendApplianceEvent(tx, this.services.custody, {
      type: 'endpoint.enrolled',
      actorAccountId: input.accountId,
      endpointId: id,
      payload: {
        endpointId: id,
        accountId: input.accountId,
        peerId: input.identity.peerId,
        via: input.via,
        by: input.by,
        platform: input.endpoint.platform,
        // `PasskeyEnrolledAuditDetail` (CT-282).
        ...(input.passkeyId ? { credentialId: input.passkeyId } : {}),
      },
      at: input.at,
    });
    return id;
  }

  /* enroll.pair.* ------------------------------------------------------------------------------- */

  async pairRequest(
    identity: Identity,
    input: { endpoint: { label: string; platform: EndpointPlatform } },
    transport?: SessionTransport,
  ) {
    // A code shown on the new device proves nothing about the page that shows it (a server can fake a page's origin):
    // off on a box inside A3, and on its own address on any box (own-address.md).
    if (this.sharedRouteOff || (transport?.via === 'direct' && transport.network === 'door'))
      throw new ApiError(
        'not_allowed',
        'Add this device with a link from one of your devices, the letters on your Whombat’s screen, or your passkey.',
        { details: { code: 'pairing_off' } },
      );
    if (!(await this.isClaimed())) throw forbidden('Claim this appliance first.');
    const now = this.now();
    const hourAgo = new Date(now.getTime() - 3600_000);
    const [recent] = await this.db
      .select({ n: count() })
      .from(endpointPairings)
      .where(and(eq(endpointPairings.peerId, identity.peerId), gt(endpointPairings.createdAt, hourAgo)));
    if ((recent?.n ?? 0) >= 10) throw trustError('rate_limited', 'Too many pairing codes. Wait a while.');
    const [pending] = await this.db
      .select({ n: count() })
      .from(endpointPairings)
      .where(and(eq(endpointPairings.state, 'pending'), gt(endpointPairings.expiresAt, now)));
    if ((pending?.n ?? 0) >= MAX_PENDING_PAIRINGS)
      throw trustError(
        'rate_limited',
        'Too many devices are waiting to be paired. Try again in a few minutes.',
      );
    return this.services.pipeline.transactAccount(async (tx) => {
      // One pending code per endpoint: a new one replaces it.
      await tx
        .update(endpointPairings)
        .set({ state: 'rejected', decidedAt: now })
        .where(and(eq(endpointPairings.peerId, identity.peerId), eq(endpointPairings.state, 'pending')));
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = pairingCode();
        const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
        const pairingId = localId('pair');
        const inserted = await tx
          .insert(endpointPairings)
          .values({
            id: pairingId,
            code,
            peerId: identity.peerId,
            publicKey: identity.publicKey,
            label: input.endpoint.label,
            platform: input.endpoint.platform,
            createdAt: now,
            expiresAt,
          })
          .onConflictDoNothing()
          .returning({ id: endpointPairings.id });
        if (inserted.length) return { pairingId, code, expiresAt: expiresAt.toISOString() };
      }
      throw new Error('could not allocate a pairing code');
    });
  }

  /** The new endpoint polls its pairing (only its own). */
  async pairStatus(identity: Identity, input: { pairingId: string }) {
    const [pairing] = await this.db
      .select()
      .from(endpointPairings)
      .where(eq(endpointPairings.id, input.pairingId));
    if (!pairing || pairing.peerId !== identity.peerId) throw notFound('Pairing');
    const now = this.now();
    if (pairing.state === 'approved' && pairing.endpointId)
      return { state: 'approved' as const, enrolled: await this.enrolledOutput(pairing.endpointId) };
    if (pairing.state === 'rejected') return { state: 'denied' as const };
    return { state: pairing.expiresAt <= now ? ('expired' as const) : ('pending' as const) };
  }

  /**
   * Pairing codes an account tries (look-ups and approvals): `PAIRING_TRIES_PER_ACCOUNT` per window, so an account
   * can't sweep the 10⁸ codes for a pending device it didn't start (review L-4). In memory: one server per appliance.
   */
  private readonly pairingTries = new Map<string, number[]>();

  private takePairingTry(accountId: string): void {
    const now = this.now().getTime();
    const recent = (this.pairingTries.get(accountId) ?? []).filter(
      (at) => at > now - PAIRING_TRIES_WINDOW_MS,
    );
    if (recent.length >= PAIRING_TRIES_PER_ACCOUNT) {
      this.pairingTries.set(accountId, recent);
      throw trustError('rate_limited', 'Too many pairing codes tried. Wait ten minutes and try again.');
    }
    recent.push(now);
    this.pairingTries.set(accountId, recent);
    if (this.pairingTries.size > 10_000) this.pairingTries.clear();
  }

  /**
   * `enroll.pair.lookup` (CT-46): which device a code belongs to — label, platform and the short fingerprint its own
   * screen shows — before approving it.
   */
  async pairLookup(viewer: SessionPrincipal, input: { code: string }) {
    const { account } = requireEnrolled(viewer);
    this.takePairingTry(account.id);
    const [pairing] = await this.db
      .select()
      .from(endpointPairings)
      .where(and(eq(endpointPairings.code, input.code), eq(endpointPairings.state, 'pending')));
    if (!pairing) throw trustError('not_found', 'No pending pairing with that code.', 'pairing_code_invalid');
    if (pairing.expiresAt <= this.now())
      throw trustError('expired', 'That pairing code expired.', 'pairing_expired');
    return {
      pairingId: pairing.id,
      label: pairing.label,
      platform: pairing.platform,
      fingerprint: pairingFingerprint(pairing.peerId),
      expiresAt: pairing.expiresAt.toISOString(),
    };
  }

  /**
   * On a trusted endpoint: approve (for its own account) or deny the code shown on the new endpoint. The fingerprint
   * the person compared (from `enroll.pair.lookup`) must be the pairing device's (CT-46), so a mistyped or guessed
   * code can't bind a stranger's device.
   */
  async pairApprove(
    approver: SessionPrincipal,
    input: { code: string; approve: boolean; fingerprint: string },
  ) {
    const { endpoint, account } = requireEnrolled(approver);
    this.takePairingTry(account.id);
    const now = this.now();
    const endpointId = await this.services.pipeline.transactAccount(async (tx) => {
      const [pairing] = await tx
        .select()
        .from(endpointPairings)
        .where(and(eq(endpointPairings.code, input.code), eq(endpointPairings.state, 'pending')))
        .for('update');
      if (!pairing)
        throw trustError('not_found', 'No pending pairing with that code.', 'pairing_code_invalid');
      if (pairing.expiresAt <= now)
        throw trustError('expired', 'That pairing code expired.', 'pairing_expired');
      if (!safeEqual(pairingFingerprint(pairing.peerId), input.fingerprint))
        throw trustError(
          'forbidden',
          'That code belongs to a device with another fingerprint. Check the code and the device’s screen.',
          'pairing_fingerprint_mismatch',
        );
      if (!input.approve) {
        await tx
          .update(endpointPairings)
          .set({ state: 'rejected', decidedAt: now, decidedByEndpointId: endpoint.id })
          .where(eq(endpointPairings.id, pairing.id));
        await appendApplianceEvent(tx, this.services.custody, {
          type: 'pairing.rejected',
          actorAccountId: account.id,
          endpointId: endpoint.id,
          payload: { pairingId: pairing.id },
          at: now,
        });
        return null;
      }
      const id = await this.insertEndpoint(tx, {
        identity: { peerId: pairing.peerId, publicKey: pairing.publicKey },
        accountId: account.id,
        endpoint: { label: pairing.label, platform: pairing.platform },
        via: 'pairing',
        by: endpoint.id,
        at: now,
      });
      await tx
        .update(endpointPairings)
        .set({ state: 'approved', decidedAt: now, decidedByEndpointId: endpoint.id, endpointId: id })
        .where(eq(endpointPairings.id, pairing.id));
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'pairing.approved',
        actorAccountId: account.id,
        endpointId: endpoint.id,
        payload: { pairingId: pairing.id, endpointId: id },
        at: now,
      });
      return id;
    });
    if (!endpointId) return { state: 'denied' as const };
    const [row] = await this.db
      .select()
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.id, endpointId));
    return { state: 'approved' as const, endpoint: this.endpointSummary(row as EndpointRow, endpoint.id) };
  }

  /**
   * `recovery.kit.register` (CT-45): the person's client made a recovery key; while the appliance has **no** recovery
   * key yet, its public half becomes the pending key, and this account the kit's once the kit is confirmed.
   * Replacing an existing key is `recovery.kit.rotate` (signed by the current key): `recovery_key_exists`.
   */
  async kitRegister(viewer: SessionPrincipal, input: { recoveryPublicKey: string }) {
    const { endpoint, account } = requireEnrolled(viewer);
    return this.pendKit(endpoint, account, input.recoveryPublicKey, (state) => {
      if (state.recoveryPublicKey)
        throw trustError(
          'conflict',
          'This appliance already has a recovery key. Replace it with the current recovery kit (rotate).',
          'recovery_key_exists',
        );
    });
  }

  /**
   * `recovery.kit.rotate` (CT-45, MA-19a): replaces the recovery key only with the current key's signature over
   * `RecoveryRotation{purpose, appliance, newRecoveryPublicKey}`. The new key is pending until its kit is confirmed
   * (the current key keeps working until then); the rotating account becomes the kit's; the person is notified.
   */
  async kitRotate(
    viewer: SessionPrincipal,
    input: { newRecoveryPublicKey: string; currentKeySignature: string },
  ) {
    const { endpoint, account } = requireEnrolled(viewer);
    return this.pendKit(endpoint, account, input.newRecoveryPublicKey, (state) => {
      if (!state.recoveryPublicKey)
        throw trustError(
          'forbidden',
          'This appliance has no recovery key to replace.',
          'recovery_key_missing',
        );
      const rotation: RecoveryRotation = {
        purpose: RECOVERY_ROTATE_PURPOSE,
        appliance: this.appliancePeerId,
        newRecoveryPublicKey: input.newRecoveryPublicKey,
      };
      if (
        !verifyEd25519Strict(
          input.currentKeySignature,
          recoverySigningBytes(rotation),
          state.recoveryPublicKey,
        )
      )
        throw trustError(
          'forbidden',
          'That isn’t signed by this appliance’s current recovery kit.',
          'recovery_rotation_invalid',
        );
    });
  }

  /** Stores a pending recovery key and its confirmation challenge (register or rotate), signed and announced. */
  private async pendKit(
    endpoint: EndpointRow,
    account: AccountRow,
    publicKey: string,
    check: (state: typeof applianceState.$inferSelect) => void,
  ) {
    const now = this.now();
    const kitId = localId('kit');
    const challenge = randomBytes(16).toString('hex');
    const expiresAt = new Date(now.getTime() + KIT_CHALLENGE_TTL_MS);
    const rotation = await this.services.pipeline.transactAccount(async (tx) => {
      await this.state(tx);
      const [state] = await tx
        .select()
        .from(applianceState)
        .where(eq(applianceState.id, STATE_ID))
        .for('update');
      if (!state) throw new Error('appliance state missing');
      check(state);
      await tx
        .update(applianceState)
        .set({
          recoveryPendingPublicKey: publicKey,
          recoveryPendingOwnerAccountId: account.id,
          recoveryKitId: kitId,
          recoveryChallenge: challenge,
          recoveryChallengeExpiresAt: expiresAt,
          updatedAt: now,
        })
        .where(eq(applianceState.id, STATE_ID));
      const rotation = state.recoveryPublicKey !== null;
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'recovery.enrolled',
        actorAccountId: account.id,
        endpointId: endpoint.id,
        payload: { kitId, publicKey, rotation, pending: true },
        at: now,
      });
      return rotation;
    });
    // One subject for the kit's begin and confirm: the confirm's notification replaces this one on the phone.
    await this.notifyPerson(
      `recovery:${kitId}`,
      rotation ? SECURITY_NOTICES.recoveryRotating : SECURITY_NOTICES.recoveryStarted,
    );
    return { kitId, challenge, expiresAt: expiresAt.toISOString() };
  }

  /**
   * The person hears about a change of the recovery authority (MA-19a): the signed appliance event is the record, and
   * each of their endpoints with a push handle gets a `security` push saying what changed.
   */
  private async notifyPerson(what: string, notice: SecurityNotice): Promise<void> {
    try {
      const person = await this.personAccountId();
      if (person) await this.push?.security([person], what, notice);
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'the person was not notified of a recovery change');
    }
  }

  /** The person's account: the one that claimed the box (one-person.md OP-S02); null before the claim. */
  personAccountId(tx: Tx | Services['db'] = this.db): Promise<string | null> {
    return personAccountId(tx);
  }

  /**
   * `recovery.kit.confirm`: the pending kit's recovery key signed the confirmation, so the saved kit works (MA-04 §4):
   * the pending key becomes the recovery key, and the account that registered or rotated it the kit's (CT-45).
   */
  async kitConfirm(viewer: SessionPrincipal, input: { kitId: string; signature: string }) {
    const { endpoint, account } = requireEnrolled(viewer);
    const now = this.now();
    const replaced = await this.services.pipeline.transactAccount(async (tx) => {
      const [state] = await tx
        .select()
        .from(applianceState)
        .where(eq(applianceState.id, STATE_ID))
        .for('update');
      if (!state?.recoveryPendingPublicKey || !state.recoveryChallenge || state.recoveryKitId !== input.kitId)
        throw conflict('Register the recovery kit again.');
      if (!state.recoveryChallengeExpiresAt || state.recoveryChallengeExpiresAt <= now)
        throw trustError('expired', 'The confirmation expired. Register the recovery kit again.');
      const kitOwner = state.recoveryPendingOwnerAccountId;
      const [kitOwnerRow] = kitOwner ? await tx.select().from(accounts).where(eq(accounts.id, kitOwner)) : [];
      if (!kitOwnerRow)
        throw trustError(
          'forbidden',
          'The account that set up this kit is gone. Set up the recovery kit again.',
          'recovery_not_owner',
        );
      const confirmation: RecoveryKitConfirmation = {
        purpose: RECOVERY_KIT_CONFIRM_PURPOSE,
        appliance: this.appliancePeerId,
        kitId: input.kitId,
        challenge: state.recoveryChallenge,
      };
      if (
        !verifyEd25519Strict(
          input.signature,
          recoverySigningBytes(confirmation),
          state.recoveryPendingPublicKey,
        )
      )
        throw trustError(
          'forbidden',
          'That isn’t the recovery key this appliance knows. Check the kit you saved.',
          'recovery_signature_invalid',
        );
      await tx
        .update(applianceState)
        .set({
          recoveryPublicKey: state.recoveryPendingPublicKey,
          recoveryOwnerAccountId: kitOwnerRow.id,
          recoveryEnrolledAt: now,
          recoveryKitVerifiedAt: now,
          recoveryPendingPublicKey: null,
          recoveryPendingOwnerAccountId: null,
          recoveryChallenge: null,
          recoveryChallengeExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(applianceState.id, STATE_ID));
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'recovery.kit_verified',
        actorAccountId: account.id,
        endpointId: endpoint.id,
        payload: {
          kitId: input.kitId,
          publicKey: state.recoveryPendingPublicKey,
          kitOwnerAccountId: kitOwnerRow.id,
          replaced: state.recoveryPublicKey !== null,
        },
        at: now,
      });
      return state.recoveryPublicKey !== null;
    });
    await this.notifyPerson(
      `recovery:${input.kitId}`,
      replaced ? SECURITY_NOTICES.recoveryRotated : SECURITY_NOTICES.recoveryRegistered,
    );
    return { confirmed: true as const, confirmedAt: now.toISOString() };
  }

  /**
   * `recovery.enroll`: a statement signed by the recovery key, bound to this appliance, this session's endpoint key
   * and the account it recovers, fresh (±5 minutes) and used once, enrolls the endpoint for that account
   * (MA-04 §5c). The statement is the contract's `RecoveryStatement`, signed over its canonical JSON.
   */
  async recoveryEnroll(
    identity: Identity,
    input: {
      statement: RecoveryStatement;
      signature: string;
      endpoint: { label: string; platform: EndpointPlatform };
    },
  ) {
    const now = this.now();
    const { statement } = input;
    if (statement.purpose !== RECOVERY_ENROLL_PURPOSE) throw forbidden('That isn’t a recovery statement.');
    if (statement.appliance !== this.appliancePeerId)
      throw forbidden('That recovery statement is for another appliance.');
    if (statement.endpoint !== identity.peerId)
      throw forbidden('That recovery statement is for another device key.');
    if (Math.abs(now.getTime() - new Date(statement.issuedAt).getTime()) > RECOVERY_SKEW_MS)
      throw trustError(
        'expired',
        'The recovery statement is too old. Sign a new one (check the clock).',
        'recovery_statement_expired',
      );
    const state = await this.state();
    // A registered kit that was never confirmed recovers nothing (CT-45: `recovery_kit_unverified`); no kit at all
    // is `recovery_key_missing`.
    if (!state.recoveryPublicKey && state.recoveryPendingPublicKey)
      throw trustError(
        'forbidden',
        'The recovery kit was never confirmed, so it can’t add devices.',
        'recovery_kit_unverified',
      );
    if (!state.recoveryPublicKey)
      throw trustError('forbidden', 'This appliance has no recovery key.', 'recovery_key_missing');
    // Only a confirmed kit recovers (MA-19a), and only into the kit's account (CT-45).
    if (!state.recoveryKitVerifiedAt)
      throw trustError(
        'forbidden',
        'The recovery kit was never confirmed, so it can’t add devices.',
        'recovery_kit_unverified',
      );
    if (!verifyEd25519Strict(input.signature, recoverySigningBytes(statement), state.recoveryPublicKey))
      throw trustError(
        'forbidden',
        'The recovery signature doesn’t match this appliance’s recovery key.',
        'recovery_signature_invalid',
      );
    const statementHash = sha256(`${statement.nonce}\u0000${statement.endpoint}`);
    const endpointId = await this.services.pipeline.transactAccount(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('whombat/recovery'))`);
      const [used] = await tx
        .select({ seq: applianceEvents.seq })
        .from(applianceEvents)
        .where(
          and(
            eq(applianceEvents.type, 'recovery.used'),
            sql`${applianceEvents.payload}->>'statementHash' = ${statementHash}`,
          ),
        );
      if (used)
        throw trustError('conflict', 'This recovery statement was already used.', 'recovery_statement_used');
      // The kit's account, re-read under the lock (a rotation may have happened meanwhile).
      const [current] = await tx
        .select({ owner: applianceState.recoveryOwnerAccountId, key: applianceState.recoveryPublicKey })
        .from(applianceState)
        .where(eq(applianceState.id, STATE_ID));
      if (current?.key !== state.recoveryPublicKey)
        throw trustError(
          'forbidden',
          'The recovery signature doesn’t match this appliance’s recovery key.',
          'recovery_signature_invalid',
        );
      if (!current?.owner || statement.accountId !== current.owner)
        throw trustError(
          'forbidden',
          'A recovery kit adds devices only to the account that set it up.',
          'recovery_not_kit_owner',
        );
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, statement.accountId));
      if (!account)
        throw trustError(
          'forbidden',
          'Recovery enrolls devices for the kit’s account only.',
          'recovery_not_owner',
        );
      const id = await this.insertEndpoint(tx, {
        identity,
        accountId: account.id,
        endpoint: input.endpoint,
        via: 'recovery',
        by: null,
        at: now,
      });
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'recovery.used',
        actorAccountId: account.id,
        endpointId: id,
        payload: { statementHash, accountId: account.id, peerId: identity.peerId },
        at: now,
      });
      return id;
    });
    return this.enrolledOutput(endpointId);
  }

  /* endpoints.* -------------------------------------------------------------------------------- */

  /** The person's endpoints; screens are listed under Screens instead (`desk.screens`). */
  async endpointsList(viewer: SessionPrincipal) {
    const { account, endpoint } = requireEnrolled(viewer);
    const rows = await this.db
      .select()
      .from(applianceEndpoints)
      .where(
        and(
          eq(applianceEndpoints.accountId, account.id),
          ne(applianceEndpoints.enrolledVia, SCREEN_ENROLLED_VIA),
        ),
      )
      .orderBy(asc(applianceEndpoints.createdAt));
    return { endpoints: rows.map((r) => this.endpointSummary(r, endpoint.id)) };
  }

  async endpointsRename(viewer: SessionPrincipal, input: { endpointId: string; label: string }) {
    const { account, endpoint } = requireEnrolled(viewer);
    const now = this.now();
    await this.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .select()
        .from(applianceEndpoints)
        .where(eq(applianceEndpoints.id, input.endpointId));
      // A screen is named under Screens.
      if (!row || row.accountId !== account.id || isScreenEndpoint(row)) throw notFound('Device');
      await tx
        .update(applianceEndpoints)
        .set({ label: input.label })
        .where(eq(applianceEndpoints.id, row.id));
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'endpoint.renamed',
        actorAccountId: account.id,
        endpointId: endpoint.id,
        payload: { endpointId: row.id },
        at: now,
      });
    });
    return { ok: true as const };
  }

  /**
   * Revokes one of the person's endpoints: the account's generation moves, the endpoint's sessions close with a
   * clear-cache notice, and control hears about it (pending until reported, the runtime reports it at once). Never their
   * last live one (MA-19c); a screen's never counts as one, and its screen goes with it.
   */
  async endpointsRevoke(viewer: SessionPrincipal, input: { endpointId: string }) {
    const { account, endpoint } = requireEnrolled(viewer);
    const now = this.now();
    const result = await this.services.pipeline.transactAccount(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('whombat/endpoints'))`);
      const [row] = await tx
        .select()
        .from(applianceEndpoints)
        .where(eq(applianceEndpoints.id, input.endpointId))
        .for('update');
      if (!row || row.accountId !== account.id) throw notFound('Device');
      if (row.revokedAt) return { row, generation: account.authzGeneration, changed: false };
      if (!isScreenEndpoint(row) && !(await liveDeviceRemains(tx, account.id, row.id)))
        throw trustError(
          'conflict',
          'This is your last working device. Add another device first.',
          'last_endpoint',
        );
      return revokeEndpointIn(tx, this.services, {
        row,
        by: { accountId: account.id, endpointId: endpoint.id },
        now,
      });
    });
    if (result.changed) announceRevocation(this.services, result);
    return { endpoint: this.endpointSummary(result.row, endpoint.id), authzGeneration: result.generation };
  }

  /** `push.handles.set` / `.clear`: the endpoint's opaque control push handle (CT-11). */
  async setPushHandle(viewer: SessionPrincipal, handle: string | null) {
    const { endpoint } = requireEnrolled(viewer);
    // A handle the phone registered through its Whombat account (CT-11): taken while Whombat Link runs, the only time
    // control sends to it. A phone's own token goes through the box instead (`push.token.set`, whombat-link.md LNK-36).
    if (handle !== null && !linkRuns(this.services))
      throw new ApiError('not_allowed', COMMUNITY_TEXT.nativePush);
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx
        .update(applianceEndpoints)
        .set({ pushHandle: handle })
        .where(eq(applianceEndpoints.id, endpoint.id));
    });
    return { ok: true as const };
  }

  /* Status and reports ------------------------------------------------------------------------- */

  async applianceStatus() {
    const state = await this.state();
    const revoked = await this.db
      .select({ reported: applianceEndpoints.revocationReportedAt })
      .from(applianceEndpoints)
      .where(isNotNull(applianceEndpoints.revokedAt));
    return {
      clientFloor: this.clientFloor,
      claimed: state.claimConsumedAt !== null,
      claimReported: state.claimReportedAt !== null,
      recovery: {
        enrolled: state.recoveryPublicKey !== null || state.recoveryPendingPublicKey !== null,
        kitVerified: state.recoveryPublicKey !== null && state.recoveryKitVerifiedAt !== null,
        ownerAccountId: state.recoveryPublicKey ? state.recoveryOwnerAccountId : null,
        rotationPending: state.recoveryPublicKey !== null && state.recoveryPendingPublicKey !== null,
      },
      revocationsPending: this.community ? 0 : revoked.filter((r) => r.reported === null).length,
      revocationsApplied: this.community ? revoked.length : revoked.filter((r) => r.reported !== null).length,
    };
  }

  /** Reports `claimed` and revocations to control through the manager; what fails stays pending. */
  async reportPending(): Promise<{ claim: boolean; revocations: number }> {
    let claim = false;
    let revocations = 0;
    // A community box has no control to report to (HE-S232).
    if (this.community) return { claim, revocations };
    try {
      const state = await this.state();
      if (state.claimConsumedAt && !state.claimReportedAt && !this.sharedRouteOff) {
        await this.manager.reportClaimed({
          claimId: state.claimId ?? 'unknown-claim',
          claimedAt: state.claimConsumedAt.toISOString(),
        });
        await this.db
          .update(applianceState)
          .set({ claimReportedAt: this.now() })
          .where(eq(applianceState.id, STATE_ID));
        claim = true;
      }
      const rows = await this.db
        .select()
        .from(applianceEndpoints)
        .where(and(isNotNull(applianceEndpoints.revokedAt), isNull(applianceEndpoints.revocationReportedAt)));
      for (const row of rows) {
        await this.manager.reportRevocation({
          peerId: row.peerId,
          revokedAt: (row.revokedAt as Date).toISOString(),
        });
        await this.db
          .update(applianceEndpoints)
          .set({ revocationReportedAt: this.now() })
          .where(eq(applianceEndpoints.id, row.id));
        revocations++;
      }
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'appliance reports to control are pending');
    }
    return { claim, revocations };
  }
}

/**
 * The last-device invariant (MA-19c): after revoking `exceptEndpoint`, the person still holds a live (non-revoked)
 * endpoint that is one of their devices (a screen isn't: it can't sign anything in or out). Callers hold the
 * `whombat/endpoints` advisory lock, so two revocations can't each count on the other's device.
 */
async function liveDeviceRemains(tx: Tx, accountId: string, exceptEndpoint: string): Promise<boolean> {
  const [row] = await tx
    .select({ n: count() })
    .from(applianceEndpoints)
    .where(
      and(
        eq(applianceEndpoints.accountId, accountId),
        isNull(applianceEndpoints.revokedAt),
        ne(applianceEndpoints.id, exceptEndpoint),
        ne(applianceEndpoints.enrolledVia, SCREEN_ENROLLED_VIA),
      ),
    );
  return (row?.n ?? 0) > 0;
}

/** A revocation that committed: what its sessions and the person's other sessions are told. */
export interface Revocation {
  row: EndpointRow;
  generation: number;
  changed: boolean;
}

/**
 * Revokes `row` in `tx` (the caller holds the `whombat/endpoints` lock and checked who may): marked revoked without a
 * push handle, the account's generation moved, a signed `endpoint.revoked`. A revoked key keeps its row (the box refuses
 * the key by it), so the screen a `display` endpoint is doesn't go by the foreign key: it goes here, in the same commit,
 * so there is never a screen without its key nor a live screen key without its screen.
 */
export async function revokeEndpointIn(
  tx: Tx,
  services: Services,
  input: { row: EndpointRow; by: { accountId: string; endpointId: string | null }; now: Date },
): Promise<Revocation> {
  const { row, now } = input;
  const [revoked] = await tx
    .update(applianceEndpoints)
    .set({ revokedAt: now, revokedByAccountId: input.by.accountId, pushHandle: null })
    .where(eq(applianceEndpoints.id, row.id))
    .returning();
  await tx.delete(screens).where(eq(screens.endpointId, row.id));
  const [bumped] = await tx
    .update(accounts)
    .set({ authzGeneration: nextGeneration })
    .where(eq(accounts.id, row.accountId))
    .returning({ generation: accounts.authzGeneration });
  await appendApplianceEvent(tx, services.custody, {
    type: 'endpoint.revoked',
    actorAccountId: input.by.accountId,
    endpointId: input.by.endpointId,
    payload: { endpointId: row.id, accountId: row.accountId, peerId: row.peerId },
    at: now,
  });
  return { row: revoked ?? row, generation: bumped?.generation ?? 0, changed: true };
}

/**
 * After a revocation committed: the endpoint's sessions close at once, the person's other sessions learn their
 * generation moved, and the runtime reports it to control.
 */
export function announceRevocation(services: Services, r: Revocation): void {
  services.bus.control({
    type: 'endpoint.revoked',
    endpointId: r.row.id,
    accountId: r.row.accountId,
    generation: r.generation,
  });
  services.bus.control({ type: 'authz.changed', accountId: r.row.accountId, generation: r.generation });
}

/**
 * The person an op runs for: an enrolled device's account, or the assistant acting for them (`assistantPrincipal`).
 * For ops the assistant may run (assistant-settings.md); `agentId` names it in the signed event.
 */
export function requirePerson(p: SessionPrincipal): {
  account: AccountRow;
  endpointId: string | null;
  agentId: string | null;
} {
  if (isScreenSession(p)) throw new ApiError('forbidden', 'A screen shows its own screen and nothing else.');
  if (!p.account || (!p.endpoint && !p.assistant))
    throw new ApiError('unauthorized', 'Enroll this device first.');
  return { account: p.account, endpointId: p.endpoint?.id ?? null, agentId: p.assistant?.agentId ?? null };
}

export function requireEnrolled(p: SessionPrincipal): { endpoint: EndpointRow; account: AccountRow } {
  // Never reached through the session (a screen resolves only `screen` ops): a second wall all the same.
  if (isScreenSession(p)) throw new ApiError('forbidden', 'A screen shows its own screen and nothing else.');
  if (!p.endpoint || !p.account) throw new ApiError('unauthorized', 'Enroll this device first.');
  return { endpoint: p.endpoint, account: p.account };
}
