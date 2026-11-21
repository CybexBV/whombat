/**
 * Each appliance independently verifies passkeys against its stored credential key. Registration and linking require
 * an enrolled session. Enrollment assertions are bound to the new endpoint; linking assertions also bind the target
 * appliance and its authenticated owner directory. Cloud sign-in alone grants no appliance access.
 * Failed enrollment checks share one refusal and a rate limit. Policy, counters and signed events are applied locally.
 */
import { randomBytes } from 'node:crypto';
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  type OwnerPasskeyRecord,
  PASSKEY_ENROLL_FAILURES_PER_HOUR,
  PASSKEY_REGISTER_BEGIN_TTL_S,
  PASSKEYS_PER_ACCOUNT_MAX,
  type PasskeySummary,
  parsePasskeyUserHandle,
  passkeyEnrollChallengeBase64url,
  passkeyLinkChallenge,
  passkeyRegisterChallengeBase64url,
  passkeyUserHandleBase64url,
  verifyOwnerPasskey,
  type WebAuthnAuthenticationResponse,
  type WebAuthnRegistrationResponse,
  type WebAuthnRequestOptions,
} from '@whombat/protocol/session';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { accounts, appliancePasskeys, applianceState } from '../db/schema/index';
import type { EndpointPlatform } from '../db/schema/managed';
import { ApiError, notFound } from '../lib/errors';
import type { Services } from '../services';
import { appendApplianceEvent } from './audit';
import { removeBackupKeysOf, removeBackupKeysOfAccount } from './backup-key-store';
import type { SessionScope } from './claim';
import { loadConsoleBurrows } from './console-burrows';
import { COMMUNITY_TEXT } from './policy';
import { SECURITY_NOTICES } from './security-push';
import { type Identity, requireEnrolled, type SessionPrincipal, type TrustService } from './trust';

export type PasskeyRow = typeof appliancePasskeys.$inferSelect;

/** A live `passkey.register.begin` of one session (PK-06): what `passkey.register` binds the challenge to. */
export interface PasskeyBegin {
  nonce: string;
  accountId: string;
  endpointId: string;
  expiresAt: Date;
  ownerHandle?: string;
}

export const PASSKEY_REGISTER_BEGIN_TTL_MS = PASSKEY_REGISTER_BEGIN_TTL_S * 1000;
const FAILURE_WINDOW_MS = 3600_000;
/** How long the browser or the phone may wait for the person's touch in a step-up (the begin lives 300 s). */
const STEP_UP_TIMEOUT_MS = 120_000;
const STATE_ID = 1;

/** The one answer to every failed passkey check (PK-05: no oracle). */
export const passkeyInvalid = () =>
  new ApiError(
    'forbidden',
    'That passkey didn’t open this Whombat. Try again, or set up this device another way.',
    {
      details: { code: 'passkey_invalid' },
    },
  );
const passkeyNotAllowed = () =>
  new ApiError(
    'not_allowed',
    'This Whombat accepts only passkeys that stay on one device, and this one can sync to other devices.',
    { details: { code: 'passkey_not_allowed' } },
  );
const passkeyLimit = () =>
  new ApiError(
    'conflict',
    `You already have ${PASSKEYS_PER_ACCOUNT_MAX} passkeys on this Whombat. Remove one first.`,
    { details: { code: 'passkey_limit' } },
  );

/** Thrown inside verification: answered as `passkey_invalid` and counted (the reason stays in the log). */
class PasskeyRefused extends Error {}

export class PasskeyService {
  /** Failed `enroll.passkey` attempts per peer (PK-05, PK-D06). In memory: one server per appliance. */
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly services: Services,
    private readonly trust: TrustService,
  ) {}

  private get db() {
    return this.services.db;
  }

  private now(): Date {
    return this.services.clock();
  }

  /**
   * The relying party (PK-02): the hosted UI's name on a commercial box; on a community box its Tailscale name while
   * that has HTTPS (HE-S230). None: no ceremony can run here (`passkeys_unavailable_here`).
   */
  private rp(): { rpId: string; origins: string[] } {
    const rp = this.trust.relyingParty();
    if (!rp)
      throw new ApiError('forbidden', COMMUNITY_TEXT.passkeys, {
        details: { code: 'passkeys_unavailable_here' },
      });
    return rp;
  }

  private async deviceBoundOnly(tx: Tx | Services['db'] = this.db): Promise<boolean> {
    const [row] = await tx
      .select({ on: applianceState.passkeysDeviceBoundOnly })
      .from(applianceState)
      .where(eq(applianceState.id, STATE_ID));
    return row?.on ?? false;
  }

  private async liveIds(accountId: string, tx: Tx | Services['db'] = this.db): Promise<string[]> {
    const rows = await tx
      .select({ id: appliancePasskeys.id })
      .from(appliancePasskeys)
      .where(and(eq(appliancePasskeys.accountId, accountId), isNull(appliancePasskeys.removedAt)))
      .orderBy(desc(appliancePasskeys.createdAt));
    return rows.map((r) => r.id);
  }

  summary(row: PasskeyRow, personName: string, viewer: SessionPrincipal | null): PasskeySummary {
    return {
      id: row.id,
      name: row.name,
      accountId: row.accountId,
      personName: personName.slice(0, 120) || 'Unknown',
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      synced: row.backupEligible,
      current: viewer?.endpoint?.enrolledPasskeyId === row.id,
      ...(row.ownerHandle
        ? { ownerHandle: row.ownerHandle, publicKey: row.publicKey.toString('base64url') }
        : {}),
      // A box passkey names its RP, the box's own host (own-address.md).
      ...(row.rpId ? { rpId: row.rpId } : {}),
    };
  }

  /* Registration (PK-06) ----------------------------------------------------------------------- */

  /**
   * `passkey.register.begin {}`: a fresh nonce kept in this session (a new begin replaces it), the RP ID, the PK-01
   * user and the account's live credential ids to exclude. `passkey_limit` at `PASSKEYS_PER_ACCOUNT_MAX`.
   */
  async registerBegin(
    viewer: SessionPrincipal,
    session: SessionScope | null,
    input: { ownerHandle?: string } = {},
  ) {
    const { account, endpoint } = requireEnrolled(viewer);
    if (!session) throw new ApiError('bad_request', 'Add a passkey over a session.');
    const ids = await this.liveIds(account.id);
    if (ids.length >= PASSKEYS_PER_ACCOUNT_MAX) throw passkeyLimit();
    const nonce = randomBytes(32).toString('hex');
    session.passkeyBegin = {
      nonce,
      ...(input.ownerHandle ? { ownerHandle: input.ownerHandle } : {}),
      accountId: account.id,
      endpointId: endpoint.id,
      expiresAt: new Date(this.now().getTime() + PASSKEY_REGISTER_BEGIN_TTL_MS),
    };
    const name = account.email.length <= 254 ? account.email : undefined;
    const displayName = (await loadConsoleBurrows(this.db))?.first;
    return {
      applianceNonce: nonce,
      endpoint: viewer.peerId,
      rpId: this.rp().rpId,
      user: {
        id: input.ownerHandle ?? passkeyUserHandleBase64url(this.trust.appliancePeerId),
        ...(name ? { name } : {}),
        ...(displayName ? { displayName } : {}),
      },
      excludeCredentialIds: input.ownerHandle ? [] : ids,
    };
  }

  /**
   * `passkey.register {controlNonce, response, name}`: uses up the session's begin whatever happens, verifies the
   * registration (RP ID, origin, `webauthn.create`, user verification, the challenge with its own nonce) and the PK-07
   * policy, then stores the credential for the caller's account. `passkey_invalid`, `passkey_not_allowed`,
   * `passkey_limit`; the same credential again is `conflict`.
   */
  async register(
    viewer: SessionPrincipal,
    session: SessionScope | null,
    input: { controlNonce: string; response: WebAuthnRegistrationResponse; name: string },
  ): Promise<PasskeySummary> {
    const { account, endpoint } = requireEnrolled(viewer);
    const begin = session?.passkeyBegin ?? null;
    if (session) session.passkeyBegin = null;
    const now = this.now();
    if (
      !begin ||
      begin.expiresAt <= now ||
      begin.accountId !== account.id ||
      begin.endpointId !== endpoint.id
    )
      throw passkeyInvalid();
    const { rpId, origins } = this.rp();
    let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo'];
    try {
      const verified = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: passkeyRegisterChallengeBase64url({
          controlNonce: input.controlNonce,
          applianceNonce: begin.nonce,
          appliance: this.trust.appliancePeerId,
        }),
        expectedOrigin: origins,
        expectedRPID: rpId,
        expectedType: 'webauthn.create',
        requireUserVerification: true,
      });
      if (!verified.verified || verified.registrationInfo.credential.id !== input.response.id)
        throw new PasskeyRefused('not verified');
      info = verified.registrationInfo;
    } catch (err) {
      this.services.log.info({ err: String(err) }, 'passkey: a registration did not verify');
      throw passkeyInvalid();
    }
    const backupEligible = info.credentialDeviceType === 'multiDevice';
    const row = await this.services.pipeline.transactAccount(async (tx) => {
      // One registration per account at a time: the limit is counted under the lock.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whombat/passkeys/${account.id}`}))`);
      if (backupEligible && (await this.deviceBoundOnly(tx))) throw passkeyNotAllowed();
      if ((await this.liveIds(account.id, tx)).length >= PASSKEYS_PER_ACCOUNT_MAX) throw passkeyLimit();
      const [inserted] = await tx
        .insert(appliancePasskeys)
        .values({
          id: info.credential.id,
          accountId: account.id,
          name: input.name,
          ownerHandle: begin.ownerHandle ?? null,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: info.credential.counter,
          transports: input.response.response.transports ?? info.credential.transports ?? [],
          backupEligible,
          backedUp: info.credentialBackedUp,
          createdByEndpointId: endpoint.id,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted)
        throw new ApiError('conflict', 'This passkey is already registered on this Whombat.', {
          details: { code: 'passkey_exists' },
        });
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'passkey.registered',
        actorAccountId: account.id,
        endpointId: endpoint.id,
        payload: {
          credentialId: inserted.id,
          accountId: account.id,
          byAccountId: account.id,
          synced: backupEligible,
        },
        at: now,
      });
      return inserted;
    });
    return this.summary(row, account.name || account.email, viewer);
  }

  /* enroll.passkey (PK-05) --------------------------------------------------------------------- */

  private recentFailures(peerId: string): number[] {
    const since = this.now().getTime() - FAILURE_WINDOW_MS;
    const recent = (this.failures.get(peerId) ?? []).filter((at) => at > since);
    if (recent.length) this.failures.set(peerId, recent);
    else this.failures.delete(peerId);
    return recent;
  }

  private recordFailure(peerId: string): void {
    const recent = this.recentFailures(peerId);
    recent.push(this.now().getTime());
    if (this.failures.size > 10_000) this.failures.clear();
    this.failures.set(peerId, recent);
  }

  /**
   * An account a passkey may still enroll devices into (PK-05 “exists and isn't disabled”, PK-D05): the person's, the
   * account that claimed the box (one-person.md OP-S02). The screen sign-in asks the same (signin-at-box BX-S06).
   */
  async accountActive(tx: Tx | Services['db'], accountId: string): Promise<boolean> {
    return accountId === (await this.trust.personAccountId(tx));
  }

  /**
   * `enroll.passkey {nonce, response, endpoint}` on the enrollment channel: verifies the assertion itself and enrolls
   * this session's endpoint into the passkey's account (`via: 'passkey'`), updating its counter and last use, then
   * tells the person's other devices (PK-09).
   */
  async enroll(
    identity: Identity,
    input: {
      nonce: string;
      response: WebAuthnAuthenticationResponse;
      endpoint: { label: string; platform: EndpointPlatform };
    },
  ) {
    if (this.recentFailures(identity.peerId).length >= PASSKEY_ENROLL_FAILURES_PER_HOUR)
      throw new ApiError(
        'rate_limited',
        'Too many passkey attempts from this device. Wait an hour and try again.',
      );
    const now = this.now();
    const { response } = input;
    let verified: { row: PasskeyRow; newCounter: number; synced: boolean };
    try {
      verified = await this.verifyAssertion(response, () =>
        passkeyEnrollChallengeBase64url({ nonce: input.nonce, endpoint: identity.peerId }),
      );
    } catch (err) {
      if (!(err instanceof PasskeyRefused)) throw err;
      this.recordFailure(identity.peerId);
      this.services.log.info({ reason: err.message }, 'passkey: an enroll did not verify');
      throw passkeyInvalid();
    }
    if (verified.synced && (await this.deviceBoundOnly())) throw passkeyNotAllowed();
    const endpointId = await this.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .select()
        .from(appliancePasskeys)
        .where(eq(appliancePasskeys.id, verified.row.id))
        .for('update');
      // Removed, or another enroll moved the counter meanwhile (a replay racing the original).
      const counterOk =
        verified.newCounter === 0 && (row?.counter ?? 0) === 0
          ? true
          : verified.newCounter > (row?.counter ?? 0);
      if (!row || row.removedAt || !counterOk || !(await this.accountActive(tx, row.accountId))) {
        this.recordFailure(identity.peerId);
        throw passkeyInvalid();
      }
      const id = await this.trust.insertEndpoint(tx, {
        identity,
        accountId: row.accountId,
        endpoint: input.endpoint,
        via: 'passkey',
        by: null,
        at: now,
        passkeyId: row.id,
      });
      await tx
        .update(appliancePasskeys)
        .set({ counter: verified.newCounter, lastUsedAt: now, lastEndpointId: id })
        .where(eq(appliancePasskeys.id, row.id));
      return id;
    });
    void this.notifyEnrolled(verified.row.accountId, endpointId);
    return this.trust.enrolledOutput(endpointId);
  }

  /**
   * Every PK-05 check before the write; any failure is a `PasskeyRefused` (one answer, counted). `challenge` is what the
   * ceremony was for (enrollment: the session's PeerId, PK-03; a step-up: the exact choice, remote-help-server.md
   * RH-S04), made inside the check so a malformed input is a refusal too.
   */
  private async verifyAssertion(response: WebAuthnAuthenticationResponse, challenge: () => string) {
    if (response.id !== response.rawId) throw new PasskeyRefused('id and rawId differ');
    const handle = response.response.userHandle;
    if (!handle) throw new PasskeyRefused('no user handle');
    const [row] = await this.db.select().from(appliancePasskeys).where(eq(appliancePasskeys.id, response.id));
    if (!row || row.removedAt) throw new PasskeyRefused('unknown or removed credential');
    // A box passkey is checked against the box's own RP only (`boxPasskey.*`, own-address.md).
    if (row.rpId) throw new PasskeyRefused('a box passkey');
    if (
      row.ownerHandle
        ? handle !== row.ownerHandle
        : parsePasskeyUserHandle(handle) !== this.trust.appliancePeerId
    )
      throw new PasskeyRefused('another user handle');
    if (!(await this.accountActive(this.db, row.accountId)))
      throw new PasskeyRefused('account gone or disabled');
    const { rpId, origins } = this.rp();
    let info: Awaited<ReturnType<typeof verifyAuthenticationResponse>>['authenticationInfo'];
    try {
      const result = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: challenge(),
        expectedOrigin: origins,
        expectedRPID: rpId,
        expectedType: 'webauthn.get',
        credential: {
          id: row.id,
          publicKey: new Uint8Array(row.publicKey),
          counter: row.counter,
          transports: row.transports,
        },
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error('not verified');
      info = result.authenticationInfo;
    } catch (err) {
      throw new PasskeyRefused(`assertion: ${String(err)}`);
    }
    return {
      row,
      newCounter: info.newCounter,
      synced: row.backupEligible || info.credentialDeviceType === 'multiDevice' || info.credentialBackedUp,
    };
  }

  /**
   * PK-09: the person's other enrolled devices hear of a device a passkey enrolled — a `security` push in fixed words
   * (MR-13: no label leaves the box; the app reads the new device from `endpoints.list`), PK-D08.
   */
  private async notifyEnrolled(accountId: string, endpointId: string): Promise<void> {
    try {
      await this.trust.push?.security(
        [accountId],
        `passkey-enrolled:${endpointId}`,
        SECURITY_NOTICES.passkeyEnrolled,
      );
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'passkey: the new-device notice was not pushed');
    }
  }

  /* Step-up: confirming a choice with a passkey (remote-help.md RH-04; remote-help-server.md RH-S04) ------------ */

  /** Whether the account has a live passkey on this Whombat (then a step-up needs one). */
  async hasPasskey(accountId: string): Promise<boolean> {
    // Under the hosted RP only, as `stepUpOptions` offers: a box passkey can't confirm there.
    const [row] = await this.db
      .select({ id: appliancePasskeys.id })
      .from(appliancePasskeys)
      .where(
        and(
          eq(appliancePasskeys.accountId, accountId),
          isNull(appliancePasskeys.removedAt),
          isNull(appliancePasskeys.rpId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * What `navigator.credentials.get` needs to confirm `challenge` with one of the account's live passkeys, or null when
   * it has none. The same RP ID the Whombat verifies against; user verification required.
   */
  async stepUpOptions(accountId: string, challenge: string): Promise<WebAuthnRequestOptions | null> {
    const rows = await this.db
      .select({ id: appliancePasskeys.id, transports: appliancePasskeys.transports })
      .from(appliancePasskeys)
      .where(
        and(
          eq(appliancePasskeys.accountId, accountId),
          isNull(appliancePasskeys.removedAt),
          // The hosted RP's step-up: a box passkey belongs to another RP ID.
          isNull(appliancePasskeys.rpId),
        ),
      )
      .orderBy(desc(appliancePasskeys.createdAt))
      .limit(PASSKEYS_PER_ACCOUNT_MAX);
    if (!rows.length) return null;
    return {
      challenge,
      rpId: this.rp().rpId,
      allowCredentials: rows.map((r) => ({
        type: 'public-key' as const,
        id: r.id,
        ...(r.transports.length ? { transports: r.transports.slice(0, 8) } : {}),
      })),
      userVerification: 'required',
      timeout: STEP_UP_TIMEOUT_MS,
    };
  }

  /**
   * A step-up: the assertion confirms `challenge` with a live passkey of `accountId` itself (not someone else's, not
   * removed), with every check of an enrollment (PK-05: signature, RP ID, origin, `webauthn.get`, user verification,
   * this Whombat's user handle), the person's PK-07 policy, and a counter that moves. The counter and the last use are
   * kept. False for every failure (the reason is logged), never an oracle.
   */
  async confirm(
    accountId: string,
    response: WebAuthnAuthenticationResponse,
    challenge: () => string,
  ): Promise<boolean> {
    let verified: { row: PasskeyRow; newCounter: number; synced: boolean };
    try {
      verified = await this.verifyAssertion(response, challenge);
      if (verified.row.accountId !== accountId) throw new PasskeyRefused('another account’s passkey');
      if (verified.synced && (await this.deviceBoundOnly()))
        throw new PasskeyRefused('synced under the policy');
    } catch (err) {
      if (!(err instanceof PasskeyRefused)) throw err;
      this.services.log.info({ reason: err.message }, 'passkey: a confirmation did not verify');
      return false;
    }
    const now = this.now();
    const ok = await this.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .select()
        .from(appliancePasskeys)
        .where(eq(appliancePasskeys.id, verified.row.id))
        .for('update');
      const counterOk =
        verified.newCounter === 0 && (row?.counter ?? 0) === 0
          ? true
          : verified.newCounter > (row?.counter ?? 0);
      if (!row || row.removedAt || row.accountId !== accountId || !counterOk) return false;
      await tx
        .update(appliancePasskeys)
        .set({ counter: verified.newCounter, lastUsedAt: now })
        .where(eq(appliancePasskeys.id, row.id));
      return true;
    });
    if (!ok) this.services.log.info('passkey: a confirmation lost its race (removed or replayed)');
    return ok;
  }

  /** Adding an existing shared passkey is possible only from an already enrolled session. */
  async link(
    viewer: SessionPrincipal,
    session: SessionScope | null,
    input: { record: OwnerPasskeyRecord; response: WebAuthnAuthenticationResponse; name: string },
  ): Promise<PasskeySummary> {
    const { account, endpoint } = requireEnrolled(viewer);
    const begin = session?.passkeyBegin;
    if (session) session.passkeyBegin = null;
    const now = this.now();
    if (
      !begin?.ownerHandle ||
      begin.expiresAt <= now ||
      begin.accountId !== account.id ||
      begin.endpointId !== endpoint.id
    )
      throw passkeyInvalid();
    const record = verifyOwnerPasskey(input.record, begin.ownerHandle);
    if (
      !record?.appliances.includes(this.trust.appliancePeerId) ||
      input.response.id !== record.credentialId ||
      input.response.rawId !== record.credentialId ||
      (input.response.response.userHandle !== undefined &&
        input.response.response.userHandle !== record.userHandle)
    )
      throw passkeyInvalid();
    const { rpId, origins } = this.rp();
    let info: Awaited<ReturnType<typeof verifyAuthenticationResponse>>['authenticationInfo'];
    try {
      const verified = await verifyAuthenticationResponse({
        response: input.response as AuthenticationResponseJSON,
        expectedChallenge: passkeyLinkChallenge({
          nonce: begin.nonce,
          appliance: this.trust.appliancePeerId,
          endpoint: viewer.peerId,
          record,
        }),
        expectedOrigin: origins,
        expectedRPID: rpId,
        requireUserVerification: true,
        credential: {
          id: record.credentialId,
          publicKey: new Uint8Array(Buffer.from(record.publicKey, 'base64url')),
          counter: 0,
        },
      });
      if (!verified.verified) throw passkeyInvalid();
      info = verified.authenticationInfo;
    } catch {
      throw passkeyInvalid();
    }
    const synced = info.credentialDeviceType === 'multiDevice';
    const row = await this.services.pipeline.transactAccount(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whombat/passkeys/${account.id}`}))`);
      if (synced && (await this.deviceBoundOnly(tx))) throw passkeyNotAllowed();
      const [existing] = await tx
        .select()
        .from(appliancePasskeys)
        .where(eq(appliancePasskeys.id, record.credentialId))
        .for('update');
      if (
        existing &&
        (existing.accountId !== account.id ||
          existing.ownerHandle !== record.userHandle ||
          existing.publicKey.toString('base64url') !== record.publicKey)
      )
        throw passkeyInvalid();
      if (existing && !existing.removedAt) return existing;
      if ((await this.liveIds(account.id, tx)).length >= PASSKEYS_PER_ACCOUNT_MAX) throw passkeyLimit();
      const values = {
        id: record.credentialId,
        accountId: account.id,
        name: input.name,
        ownerHandle: record.userHandle,
        publicKey: Buffer.from(record.publicKey, 'base64url'),
        counter: info.newCounter,
        transports: [] as string[],
        backupEligible: synced,
        backedUp: info.credentialBackedUp,
        createdByEndpointId: endpoint.id,
        createdAt: now,
        removedAt: null,
        removedByAccountId: null,
      };
      const [saved] = await tx
        .insert(appliancePasskeys)
        .values(values)
        .onConflictDoUpdate({ target: appliancePasskeys.id, set: values })
        .returning();
      if (!saved) throw passkeyInvalid();
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'passkey.registered',
        actorAccountId: account.id,
        endpointId: endpoint.id,
        payload: { credentialId: saved.id, accountId: account.id, name: saved.name, synced },
        at: now,
      });
      return saved;
    });
    return this.summary(row, account.name || account.email, viewer);
  }

  /* passkeys.list / passkey.remove / passkeys.policy (PK-07, PK-08) ------------------------------ */

  /** The person's live passkeys, newest first, and the policy. */
  async list(viewer: SessionPrincipal) {
    const { account } = requireEnrolled(viewer);
    const rows = await this.db
      .select({ passkey: appliancePasskeys, name: accounts.name, email: accounts.email })
      .from(appliancePasskeys)
      .innerJoin(accounts, eq(accounts.id, appliancePasskeys.accountId))
      .where(and(isNull(appliancePasskeys.removedAt), eq(appliancePasskeys.accountId, account.id)))
      .orderBy(desc(appliancePasskeys.createdAt))
      .limit(1_000);
    return {
      passkeys: rows.map((r) => this.summary(r.passkey, r.name || r.email, viewer)),
      policy: { deviceBoundOnly: await this.deviceBoundOnly() },
    };
  }

  /** `passkey.remove {id}`: one of the caller's own; it enrolls nothing any more. Devices it enrolled stay. */
  async remove(viewer: SessionPrincipal, input: { id: string }) {
    const { account, endpoint } = requireEnrolled(viewer);
    const now = this.now();
    await this.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .select()
        .from(appliancePasskeys)
        .where(and(eq(appliancePasskeys.id, input.id), isNull(appliancePasskeys.removedAt)))
        .for('update');
      if (!row || row.accountId !== account.id) throw notFound('Passkey');
      await tx
        .update(appliancePasskeys)
        .set({ removedAt: now, removedByAccountId: account.id })
        .where(eq(appliancePasskeys.id, row.id));
      // The backup key it gave this Whombat goes with it (backup-passkey.md).
      await removeBackupKeysOf(tx, row.id);
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'passkey.removed',
        actorAccountId: account.id,
        endpointId: endpoint.id,
        payload: {
          credentialId: row.id,
          accountId: row.accountId,
          byAccountId: account.id,
          synced: row.backupEligible,
        },
        at: now,
      });
    });
    // Control drops the envelopes of a box passkey that left the declared set (own-address.md).
    this.trust.boxPasskeys.declareSoon();
    return { ok: true as const };
  }

  /** `passkeys.policy {deviceBoundOnly}` (the person): signed when it changes. */
  async setPolicy(viewer: SessionPrincipal, input: { deviceBoundOnly: boolean }) {
    const { account, endpoint } = requireEnrolled(viewer);
    const now = this.now();
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx.insert(applianceState).values({ id: STATE_ID }).onConflictDoNothing();
      const [state] = await tx
        .select({ on: applianceState.passkeysDeviceBoundOnly })
        .from(applianceState)
        .where(eq(applianceState.id, STATE_ID))
        .for('update');
      if (state?.on === input.deviceBoundOnly) return;
      await tx
        .update(applianceState)
        .set({ passkeysDeviceBoundOnly: input.deviceBoundOnly, updatedAt: now })
        .where(eq(applianceState.id, STATE_ID));
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'passkeys.policy_changed',
        actorAccountId: account.id,
        endpointId: endpoint.id,
        payload: { deviceBoundOnly: input.deviceBoundOnly, byAccountId: account.id },
        at: now,
      });
    });
    return { ok: true as const };
  }

  /**
   * An account offboarded from this Whombat (EP-07, PK-08): its passkeys go with it, in the caller's transaction,
   * each a signed `passkey.removed` with `byAccountId: null`.
   */
  async removeForAccount(
    tx: Tx,
    accountId: string,
    actorAccountId: string | null,
    at: Date,
  ): Promise<number> {
    const rows = await tx
      .update(appliancePasskeys)
      .set({ removedAt: at, removedByAccountId: actorAccountId })
      .where(and(eq(appliancePasskeys.accountId, accountId), isNull(appliancePasskeys.removedAt)))
      .returning();
    await removeBackupKeysOfAccount(tx, accountId);
    for (const row of rows)
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'passkey.removed',
        actorAccountId,
        endpointId: null,
        payload: { credentialId: row.id, accountId, byAccountId: null, synced: row.backupEligible },
        at,
      });
    return rows.length;
  }
}
