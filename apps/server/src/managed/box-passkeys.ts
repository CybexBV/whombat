/**
 * Box passkeys (docs/decisions/own-address.md; contracts 4.3 `session/box-passkeys.ts`): passkeys whose relying party is
 * the box's own host, so no page Cybex serves can use them. They live beside the hosted RP's in `appliance_passkeys`
 * (`rp_id` set, `user_handle` the account's box handle) and open the box the same way.
 *
 * - `boxPasskey.register.begin {}` / `.register {nonce, response, name}` (the person, on the own address or in the
 *   Android app): the box's own nonce for this session, the RP ID, the account's 32-byte user handle (one per account per
 *   box, so two people's passkeys in one browser don't replace each other), the box's name, and a challenge bound to the
 *   nonce, this box and its host.
 * - `boxPasskey.enroll.begin {}` / `.enroll {nonce, response, endpoint}` (any session): a join bound to the new device's
 *   key (`passkeyEnrollChallenge` with this session's PeerId). Every failed check is one answer, `passkey_invalid`.
 *
 * Origins: the box's own address and the Android release app's. Once a box passkey is added or removed, and at start,
 * the box declares the full set to control (`kit.credentials.declare`), retried until control acknowledges it, so control
 * keeps the backup envelopes of exactly these.
 */
import { randomBytes } from 'node:crypto';
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { ownAddressOrigin } from '@whombat/protocol/own-address';
import {
  BOX_PASSKEY_TIMEOUT_MS,
  boxPasskeyRegisterChallengeBase64url,
  PASSKEY_ANDROID_ORIGINS,
  PASSKEY_ENROLL_FAILURES_PER_HOUR,
  PASSKEYS_PER_ACCOUNT_MAX,
  type PasskeySummary,
  passkeyEnrollChallengeBase64url,
  type WebAuthnAuthenticationResponse,
  type WebAuthnRegistrationResponse,
} from '@whombat/protocol/session';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { appliancePasskeys, applianceState, boxPasskeyUsers } from '../db/schema/index';
import type { EndpointPlatform } from '../db/schema/managed';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { appendApplianceEvent } from './audit';
import { ownNameOf } from './backup-key';
import type { SessionScope } from './claim';
import { type PasskeyRow, passkeyInvalid } from './passkeys';
import { linkRuns } from './policy';
import { ManagerCallError, type ManagerPort, managerUnreachable } from './ports';
import { SECURITY_NOTICES } from './security-push';
import { type Identity, requireEnrolled, type SessionPrincipal, type TrustService } from './trust';

const STATE_ID = 1;
const BEGIN_TTL_MS = 300_000;
const FAILURE_WINDOW_MS = 3_600_000;
/** A declaration control didn't take is tried again after this, doubling up to `DECLARE_RETRY_MAX_MS`. */
const DECLARE_RETRY_MS = 60_000;
const DECLARE_RETRY_MAX_MS = 30 * 60_000;

/** A live box-passkey begin of one session: its nonce, used once. */
export interface BoxPasskeyBegin {
  nonce: string;
  rpId: string;
  expiresAt: Date;
  /** Registration only: whose and from which device. */
  accountId?: string;
  endpointId?: string;
}

/** Thrown inside verification: answered as `passkey_invalid` (the reason stays in the log). */
class Refused extends Error {}

const passkeyLimit = () =>
  new ApiError(
    'conflict',
    `You already have ${PASSKEYS_PER_ACCOUNT_MAX} passkeys on this Whombat. Remove one first.`,
    { details: { code: 'passkey_limit' } },
  );
const passkeyNotAllowed = () =>
  new ApiError(
    'not_allowed',
    'This Whombat accepts only passkeys that stay on one device, and this one can sync to other devices.',
    { details: { code: 'passkey_not_allowed' } },
  );

export class BoxPasskeyService {
  private readonly failures = new Map<string, number[]>();
  private declaring: Promise<void> | null = null;
  private retry: NodeJS.Timeout | null = null;
  private retryMs = DECLARE_RETRY_MS;

  constructor(
    private readonly services: Services,
    private readonly trust: TrustService,
    private readonly manager: ManagerPort,
  ) {}

  private get db() {
    return this.services.db;
  }

  private now(): Date {
    return this.services.clock();
  }

  /** The box's RP: its own host and the origins a box passkey may carry; none while it has no own address. */
  private rp(): { rpId: string; origins: string[] } {
    const host = this.trust.ownAddress?.host();
    if (!host)
      throw new ApiError('unavailable', 'This Whombat has no address of its own yet.', {
        details: { code: 'own_address_unavailable' },
      });
    return { rpId: host, origins: [ownAddressOrigin(host), ...PASSKEY_ANDROID_ORIGINS] };
  }

  /** The account's box user handle (32 random bytes, base64url), made the first time. */
  private async userHandle(accountId: string): Promise<string> {
    const made = randomBytes(32).toString('base64url');
    await this.db.insert(boxPasskeyUsers).values({ accountId, userHandle: made }).onConflictDoNothing();
    const [row] = await this.db
      .select({ handle: boxPasskeyUsers.userHandle })
      .from(boxPasskeyUsers)
      .where(eq(boxPasskeyUsers.accountId, accountId));
    if (!row) throw new Error('box passkey user handle missing');
    return row.handle;
  }

  private async liveIds(accountId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: appliancePasskeys.id })
      .from(appliancePasskeys)
      .where(and(eq(appliancePasskeys.accountId, accountId), isNull(appliancePasskeys.removedAt)))
      .orderBy(desc(appliancePasskeys.createdAt));
    return rows.map((r) => r.id);
  }

  private async deviceBoundOnly(): Promise<boolean> {
    const [row] = await this.db
      .select({ on: applianceState.passkeysDeviceBoundOnly })
      .from(applianceState)
      .where(eq(applianceState.id, STATE_ID));
    return row?.on ?? false;
  }

  /* Registration ------------------------------------------------------------------------------------------------- */

  async registerBegin(viewer: SessionPrincipal, session: SessionScope | null) {
    const { account, endpoint } = requireEnrolled(viewer);
    if (!session) throw new ApiError('bad_request', 'Add a passkey over a session.');
    const { rpId } = this.rp();
    const ids = await this.liveIds(account.id);
    if (ids.length >= PASSKEYS_PER_ACCOUNT_MAX) throw passkeyLimit();
    const nonce = randomBytes(32).toString('hex');
    session.boxPasskeyRegister = {
      nonce,
      rpId,
      accountId: account.id,
      endpointId: endpoint.id,
      expiresAt: new Date(this.now().getTime() + BEGIN_TTL_MS),
    };
    // The name the person gave the box; the password manager lists the passkey under it.
    const name = ((await ownNameOf(this.services)) ?? 'Whombat').slice(0, 120);
    return {
      nonce,
      rpId,
      user: {
        id: await this.userHandle(account.id),
        name,
        displayName: `${name} · your Whombat`.slice(0, 160),
      },
      excludeCredentialIds: ids,
      challenge: boxPasskeyRegisterChallengeBase64url({ nonce, appliance: this.trust.appliancePeerId, rpId }),
    };
  }

  async register(
    viewer: SessionPrincipal,
    session: SessionScope | null,
    input: { nonce: string; response: WebAuthnRegistrationResponse; name: string },
  ): Promise<PasskeySummary> {
    const { account, endpoint } = requireEnrolled(viewer);
    const begin = session?.boxPasskeyRegister ?? null;
    if (session) session.boxPasskeyRegister = null;
    const now = this.now();
    if (
      !begin ||
      begin.nonce !== input.nonce ||
      begin.expiresAt <= now ||
      begin.accountId !== account.id ||
      begin.endpointId !== endpoint.id
    )
      throw passkeyInvalid();
    const { rpId, origins } = this.rp();
    if (rpId !== begin.rpId) throw passkeyInvalid();
    let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo'];
    try {
      const verified = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: boxPasskeyRegisterChallengeBase64url({
          nonce: begin.nonce,
          appliance: this.trust.appliancePeerId,
          rpId,
        }),
        expectedOrigin: origins,
        expectedRPID: rpId,
        expectedType: 'webauthn.create',
        requireUserVerification: true,
      });
      if (!verified.verified || verified.registrationInfo.credential.id !== input.response.id)
        throw new Refused('not verified');
      info = verified.registrationInfo;
    } catch (err) {
      this.services.log.info({ err: String(err) }, 'box passkey: a registration did not verify');
      throw passkeyInvalid();
    }
    const backupEligible = info.credentialDeviceType === 'multiDevice';
    const handle = await this.userHandle(account.id);
    const row = await this.services.pipeline.transactAccount(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whombat/passkeys/${account.id}`}))`);
      if (backupEligible && (await this.deviceBoundOnly())) throw passkeyNotAllowed();
      const live = await tx
        .select({ id: appliancePasskeys.id })
        .from(appliancePasskeys)
        .where(and(eq(appliancePasskeys.accountId, account.id), isNull(appliancePasskeys.removedAt)));
      if (live.length >= PASSKEYS_PER_ACCOUNT_MAX) throw passkeyLimit();
      const [inserted] = await tx
        .insert(appliancePasskeys)
        .values({
          id: info.credential.id,
          accountId: account.id,
          name: input.name,
          ownerHandle: null,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: info.credential.counter,
          transports: input.response.response.transports ?? info.credential.transports ?? [],
          backupEligible,
          backedUp: info.credentialBackedUp,
          createdByEndpointId: endpoint.id,
          createdAt: now,
          rpId,
          userHandle: handle,
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
    this.declareSoon();
    return this.trust.passkeys.summary(row, account.name || account.email, viewer);
  }

  /* Joining ------------------------------------------------------------------------------------------------------ */

  /** `boxPasskey.enroll.begin {}`: the box's nonce for this session's join, and the RP ID. */
  async enrollBegin(session: SessionScope | null) {
    if (!session) throw new ApiError('bad_request', 'Sign in over a session.');
    const { rpId } = this.rp();
    const nonce = randomBytes(32).toString('hex');
    session.boxPasskeyEnroll = { nonce, rpId, expiresAt: new Date(this.now().getTime() + BEGIN_TTL_MS) };
    return { nonce, rpId, timeoutMs: BOX_PASSKEY_TIMEOUT_MS };
  }

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
   * `boxPasskey.enroll {nonce, response, endpoint}`: this session's nonce, the box's RP and origins, user verification,
   * the challenge bound to this session's key, a live box passkey of this host with its user handle, a counter that
   * moves, the person's policy, and joins open (`joinsAllowed`). Then this device joins the passkey's account.
   */
  async enroll(
    identity: Identity,
    session: SessionScope | null,
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
    const begin = session?.boxPasskeyEnroll ?? null;
    if (session) session.boxPasskeyEnroll = null;
    const now = this.now();
    let verified: { row: PasskeyRow; newCounter: number; synced: boolean };
    try {
      if (!begin || begin.nonce !== input.nonce || begin.expiresAt <= now)
        throw new Refused('not this session’s nonce');
      if (!(this.trust.ownAddress?.joinsAllowed() ?? false)) throw new Refused('joins are shut');
      verified = await this.verifyAssertion(input.response, begin.rpId, () =>
        passkeyEnrollChallengeBase64url({ nonce: input.nonce, endpoint: identity.peerId }),
      );
    } catch (err) {
      if (!(err instanceof Refused) && !(err instanceof ApiError)) throw err;
      this.recordFailure(identity.peerId);
      this.services.log.info({ reason: String(err) }, 'box passkey: a join did not verify');
      throw passkeyInvalid();
    }
    if (verified.synced && (await this.deviceBoundOnly())) throw passkeyNotAllowed();
    const endpointId = await this.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .select()
        .from(appliancePasskeys)
        .where(eq(appliancePasskeys.id, verified.row.id))
        .for('update');
      const counterOk =
        verified.newCounter === 0 && (row?.counter ?? 0) === 0
          ? true
          : verified.newCounter > (row?.counter ?? 0);
      if (
        !row ||
        row.removedAt ||
        !counterOk ||
        !(await this.trust.passkeys.accountActive(tx, row.accountId))
      ) {
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
    void this.trust.push
      ?.security([verified.row.accountId], `passkey-enrolled:${endpointId}`, SECURITY_NOTICES.passkeyEnrolled)
      .catch((err) => this.services.log.warn({ err: String(err) }, 'box passkey: the notice was not pushed'));
    return this.trust.enrolledOutput(endpointId);
  }

  private async verifyAssertion(
    response: WebAuthnAuthenticationResponse,
    rpId: string,
    challenge: () => string,
  ): Promise<{ row: PasskeyRow; newCounter: number; synced: boolean }> {
    const rp = this.rp();
    if (rp.rpId !== rpId) throw new Refused('the address changed since the begin');
    if (response.id !== response.rawId) throw new Refused('id and rawId differ');
    const handle = response.response.userHandle;
    if (!handle) throw new Refused('no user handle');
    const [row] = await this.db.select().from(appliancePasskeys).where(eq(appliancePasskeys.id, response.id));
    if (!row || row.removedAt) throw new Refused('unknown or removed credential');
    // Only a passkey made for this box's own host: one under the hosted app's RP never joins here.
    if (row.rpId !== rpId || !row.userHandle || handle !== row.userHandle)
      throw new Refused('not a box passkey of this host');
    if (!(await this.trust.passkeys.accountActive(this.db, row.accountId)))
      throw new Refused('account gone or disabled');
    let info: Awaited<ReturnType<typeof verifyAuthenticationResponse>>['authenticationInfo'];
    try {
      const result = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: challenge(),
        expectedOrigin: rp.origins,
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
      throw new Refused(`assertion: ${String(err)}`);
    }
    return {
      row,
      newCounter: info.newCounter,
      synced: row.backupEligible || info.credentialDeviceType === 'multiDevice' || info.credentialBackedUp,
    };
  }

  /* Declaring them to control ------------------------------------------------------------------------------------ */

  /** The live box passkeys' credential ids, sorted. */
  async declaredSet(): Promise<string[]> {
    const rows = await this.db
      .select({ id: appliancePasskeys.id })
      .from(appliancePasskeys)
      .where(and(isNotNull(appliancePasskeys.rpId), isNull(appliancePasskeys.removedAt)));
    return rows.map((r) => r.id).sort();
  }

  /** Declares the set now (and again later while control can't take it). One at a time. */
  declareSoon(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.declaring ??= this.declare()
      .then((outcome) => {
        if (outcome === 'done') {
          this.retryMs = DECLARE_RETRY_MS;
          return;
        }
        this.retry = setTimeout(() => this.declareSoon(), this.retryMs);
        this.retry.unref?.();
        this.retryMs = Math.min(this.retryMs * 2, DECLARE_RETRY_MAX_MS);
      })
      .catch((err) => this.services.log.warn({ err: String(err) }, 'box passkeys: not declared'))
      .finally(() => {
        this.declaring = null;
      });
  }

  /** Stops retrying (the runtime's close). */
  stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  /** Waits for a running declaration (tests). */
  async settled(): Promise<void> {
    await this.declaring;
  }

  /**
   * Sends the full set when it differs from what control last acknowledged. Only a box linked to an account: control
   * keeps envelopes for linked boxes alone (`device_unlinked` otherwise, then the link declares), and only while Whombat
   * Link runs (whombat-link.md LNK-05: kit envelope copies are a Link feature; Link starting declares again).
   */
  async declare(): Promise<'done' | 'later'> {
    const send = this.manager.kitCredentials?.bind(this.manager);
    if (!send || !linkRuns(this.services)) return 'done';
    const [state] = await this.db
      .select({ linkedAt: applianceState.accountLinkedAt, declared: applianceState.kitDeclaredIds })
      .from(applianceState)
      .where(eq(applianceState.id, STATE_ID));
    const ids = await this.declaredSet();
    if (!state?.linkedAt && !ids.length) return 'done';
    if (state?.declared && state.declared.join(',') === ids.join(',')) return 'done';
    try {
      await send({ credentialIds: ids });
    } catch (err) {
      if (err instanceof ManagerCallError && /\bdevice_unlinked\b/.test(`${err.code} ${err.message}`))
        return 'done';
      if (err instanceof ManagerCallError && (err.status === 404 || err.status === 501)) return 'done';
      if (!managerUnreachable(err))
        this.services.log.warn({ err: String(err) }, 'box passkeys: control didn’t take the set');
      return 'later';
    }
    await this.db
      .update(applianceState)
      .set({ kitDeclaredIds: ids, kitDeclaredAt: this.now() })
      .where(eq(applianceState.id, STATE_ID));
    return 'done';
  }
}

/** The session ops (`boxPasskey.*`). */
export const BOX_PASSKEY_SESSION_HANDLERS = {
  'boxPasskey.enroll.begin': (c: { trust: TrustService; session: SessionScope | null }) =>
    c.trust.boxPasskeys.enrollBegin(c.session),
  'boxPasskey.enroll': (
    c: { trust: TrustService; session: SessionScope | null; principal: SessionPrincipal },
    input: Parameters<BoxPasskeyService['enroll']>[2],
  ) =>
    c.trust.boxPasskeys.enroll(
      { peerId: c.principal.peerId, publicKey: c.principal.publicKey },
      c.session,
      input,
    ),
  'boxPasskey.register.begin': (c: {
    trust: TrustService;
    session: SessionScope | null;
    principal: SessionPrincipal;
  }) => c.trust.boxPasskeys.registerBegin(c.principal, c.session),
  'boxPasskey.register': (
    c: { trust: TrustService; session: SessionScope | null; principal: SessionPrincipal },
    input: Parameters<BoxPasskeyService['register']>[2],
  ) => c.trust.boxPasskeys.register(c.principal, c.session, input),
} as const;
