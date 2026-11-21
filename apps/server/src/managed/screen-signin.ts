/**
 * Sign in at the box (docs/decisions/signin-at-box.md BX-02…BX-07, BX-S01…): a device that isn't let in asks the box to
 * show a code on its own screen (`enroll.screen.request {endpoint}`), the person at the box types the six letters on the
 * device, and a CPace exchange bound to both Noise keys like the claim's (CC-06, CC-07) lets it in to the person's
 * account (one-person.md OP-S11): `enroll.screen.begin {signinId, share}`, then `enroll.screen {signinId, confirm}`.
 * One of the person's devices that is in already may sign in too: the letters prove this box to it, which a box restored
 * from a backup needs (the device knows the old box's identity), and it keeps its endpoint.
 *
 * - **One live sign-in per box**, in memory: the requesting key, the account, what the screen shows (name, device), the
 *   letters, the expiry (`SCREEN_SIGNIN_TTL_S`) and a generation. A new request replaces it. The letters are never in
 *   the database, a log, a diagnostic bundle or control: only in the console file, while the sign-in is live.
 * - **Begins** only from the requesting key, kept per session (`SessionScope.screenBegin`, like `claimBegin`) with the
 *   generation of the letters they used, for `ENROLL_CLAIM_BEGIN_TTL_S`.
 * - **`enroll.screen`** uses the session's begin up whatever happens and compares the tag in constant time before
 *   anything else. A mismatch is one failed guess: counted in `appliance_claim_failures` under the method `screen`
 *   (BX-S02), the letters rotate at once (every live begin ends; the sign-in stays until it runs out), and when the
 *   claim's backoff policy starts refusing, the person gets one content-free `security` push (BX-S05). A match lets the
 *   device in (`enrolled_via 'screen'`, signed `endpoint.enrolled`) in one transaction, clears the counter, ends the
 *   sign-in and tells the person.
 * - **Requests** are counted in memory, per key and per box per hour (BX-05, BX-S03).
 *
 * `ScreenSignInStore` is everything it needs from the database (`DbScreenSignInStore` below), so the rules are tested
 * with a fake (`screen-signin.test.ts`) and the real store over sessions (`claim-code.int.test.ts`).
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import type { ConsoleSignIn } from '@whombat/control-contracts/local';
import {
  CLAIM_FAILURE_WINDOW_S,
  CLAIM_FREE_FAILURES,
  type ClaimConfirmTags,
  ClaimPakeError,
  claimBackoffSeconds,
  claimConfirmEqual,
  generateScreenSignInLetters,
  screenSignInPakeResponder,
} from '@whombat/protocol/claim';
import {
  SCREEN_SIGNIN_ERROR_STATUS,
  SCREEN_SIGNIN_REQUESTS_PER_KEY,
  SCREEN_SIGNIN_REQUESTS_TOTAL,
  SCREEN_SIGNIN_TTL_S,
  type ScreenSignInErrorCode,
  type SessionErrorCode,
} from '@whombat/protocol/session';
import { and, count, eq, gt, lte, max } from 'drizzle-orm';
import type { EndpointPlatform } from '../db/schema/index';
import { accounts, applianceClaimFailures, applianceEndpoints, applianceState } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { CLAIM_BEGIN_TTL_MS, type SessionScope } from './claim';
import { consoleDisplayName } from './console-burrows';
import { SECURITY_NOTICES, type SecurityNotice } from './security-push';
import { SessionOpError } from './session-error';
import type { Identity, TrustService } from './trust';

/** The `appliance_claim_failures.method` of a wrong screen sign-in code (BX-S02). */
export const SCREEN_FAILURE_METHOD = 'screen';
const HOUR_MS = 3600_000;

/** A live `enroll.screen.begin` of one session: what `enroll.screen` checks its confirmation against. */
export interface ScreenBegin {
  signinId: string;
  tags: ClaimConfirmTags;
  expiresAt: Date;
  /** The sign-in's generation when its letters were taken (a wrong guess since then ends this begin). */
  generation: number;
}

/** A new device as it asked to be let in. */
export interface ScreenEndpoint {
  label: string;
  platform: EndpointPlatform;
}

/** What the screen sign-in needs from the database (and the push), so its rules can be tested without one. */
export interface ScreenSignInStore {
  /** The box's device id once it is claimed (the PAKE's `deviceId`); null before the claim. */
  claimedDeviceId(): Promise<string | null>;
  /** This key's endpoint here, if it is one already (revoked or not), and whose it is. */
  endpointState(peerId: string): Promise<{ accountId: string; revoked: boolean } | null>;
  /** The person's account (the claimer's, one-person.md OP-S02), or null before the claim. */
  account(): Promise<{ id: string; name: string; email: string } | null>;
  /** The wrong screen codes in the rolling window and the latest one. */
  failures(now: Date): Promise<{ n: number; latest: Date | null }>;
  /** Counts one wrong code (and drops what left the window). */
  recordFailure(peerId: string, now: Date): Promise<void>;
  clearFailures(): Promise<void>;
  /**
   * Lets the device in to the account in one transaction; returns the endpoint's id. A key that is the account's
   * endpoint already keeps it: nothing new is let in.
   */
  enroll(identity: Identity, accountId: string, endpoint: ScreenEndpoint, now: Date): Promise<string>;
  /** `EnrolledOutput` for the endpoint. */
  enrolledOutput(endpointId: string): Promise<Record<string, unknown>>;
  /** A `security` push to the person's devices: `what` names the event, `notice` says it. */
  notify(what: string, notice: SecurityNotice): Promise<void>;
}

/** What shows the sign-in: the console file (`ClaimCeremony`). */
export interface ScreenSignInScreen {
  readonly showsScreen: boolean;
  setSignIn(signIn: ConsoleSignIn | undefined): void;
}

interface LiveSignIn {
  signinId: string;
  /** The requesting key: only it may begin and confirm. */
  peerId: string;
  accountId: string;
  deviceId: string;
  endpoint: ScreenEndpoint;
  /** What the screen shows (`ConsoleDisplayText`). */
  name: string;
  device: string;
  letters: string;
  expiresAt: Date;
  /** Bumped by every wrong guess (the letters rotate): a begin from before can't be confirmed. */
  generation: number;
}

/** When a begin is accepted again: the claim's policy over the screen's own failures (BX-05); null now. */
export function screenBackoff(failures: { n: number; latest: Date | null }, now: Date): Date | null {
  if (!failures.n || !failures.latest) return null;
  const retryAt = new Date(failures.latest.getTime() + claimBackoffSeconds(failures.n) * 1000);
  return retryAt > now ? retryAt : null;
}

/** A screen sign-in refusal: the application code in `details.code` and its session code from the contracts. */
const screenError = (app: ScreenSignInErrorCode, message: string, extra: Record<string, unknown> = {}) =>
  new SessionOpError(SCREEN_SIGNIN_ERROR_STATUS[app] as SessionErrorCode, message, { code: app, ...extra });

const unavailable = () => screenError('screen_unavailable', 'This Whombat has no screen to show a code on.');
const signinMissing = () => screenError('screen_signin_missing', 'That code ran out. Show a new one.');

function backoffError(retryAt: Date, now: Date): SessionOpError {
  const min = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 60_000));
  return screenError('screen_backoff', `Too many wrong codes. Try again in ${min} min.`, {
    retryAt: retryAt.toISOString(),
  });
}

/** The device line when its label has nothing the screen can show (BX-S07). */
const PLATFORM_NAMES: Record<EndpointPlatform, string> = {
  web: 'Web browser',
  android: 'Android',
  ios: 'iPhone or iPad',
  desktop: 'Desktop app',
  cli: 'Command line',
};

export class ScreenSignInService {
  private live: LiveSignIn | null = null;
  /** Accepted requests in the last hour, per key and for the box (BX-S03). */
  private readonly perKey = new Map<string, number[]>();
  private total: number[] = [];

  constructor(
    private readonly store: ScreenSignInStore,
    private readonly screen: ScreenSignInScreen,
    private readonly options: {
      appliancePeerId: string;
      clock: () => Date;
      log: Pick<Services['log'], 'info' | 'warn'>;
      randomBytes?: (n: number) => Uint8Array;
    },
  ) {}

  private now(): Date {
    return this.options.clock();
  }

  private random(n: number): Uint8Array {
    return this.options.randomBytes?.(n) ?? new Uint8Array(nodeRandomBytes(n));
  }

  /** The live sign-in, or null once it ran out (the console file was rewritten then by its own timer). */
  private current(now: Date): LiveSignIn | null {
    if (this.live && this.live.expiresAt <= now) this.live = null;
    return this.live;
  }

  /** The live sign-in of this key with this id, or `screen_signin_missing`. */
  private mine(identity: Identity, signinId: string, now: Date): LiveSignIn {
    const live = this.current(now);
    if (!live || live.signinId !== signinId || live.peerId !== identity.peerId) throw signinMissing();
    return live;
  }

  private show(): void {
    const live = this.live;
    this.screen.setSignIn(
      live
        ? {
            code: live.letters,
            name: live.name,
            device: live.device,
            expiresAt: live.expiresAt.toISOString(),
          }
        : undefined,
    );
  }

  private async backoff(now: Date): Promise<Date | null> {
    return screenBackoff(await this.store.failures(now), now);
  }

  /** One request of this key, or `screen_rate_limited` (BX-05): 5 per key and 30 per box in an hour. */
  private takeRequest(peerId: string, now: Date): void {
    const since = now.getTime() - HOUR_MS;
    this.total = this.total.filter((at) => at > since);
    const mine = (this.perKey.get(peerId) ?? []).filter((at) => at > since);
    if (mine.length >= SCREEN_SIGNIN_REQUESTS_PER_KEY || this.total.length >= SCREEN_SIGNIN_REQUESTS_TOTAL)
      throw screenError('screen_rate_limited', 'Too many codes asked for. Wait a little and try again.');
    if (this.perKey.size > 10_000) this.perKey.clear();
    this.perKey.set(peerId, [...mine, now.getTime()]);
    this.total.push(now.getTime());
  }

  /**
   * `enroll.screen.request {endpoint}`: the screen shows six new letters for this device for five minutes, replacing any
   * sign-in it showed; the device joins the person's account, or keeps its endpoint there. Refused without a screen or
   * before the claim (`screen_unavailable`), for a revoked key or another account's endpoint, in backoff and over the
   * request limits.
   */
  async request(identity: Identity, input: { endpoint: ScreenEndpoint }) {
    if (!this.screen.showsScreen) throw unavailable();
    const deviceId = await this.store.claimedDeviceId();
    if (!deviceId) throw unavailable();
    const known = await this.store.endpointState(identity.peerId);
    if (known?.revoked)
      throw new ApiError(
        'forbidden',
        'This device key was revoked on this appliance. Reset the app’s storage to get a new key.',
      );
    const account = await this.store.account();
    if (!account) throw unavailable();
    if (known && known.accountId !== account.id)
      throw new SessionOpError('conflict', 'This device is already enrolled.', { code: 'endpoint_enrolled' });
    const now = this.now();
    const retryAt = await this.backoff(now);
    if (retryAt) throw backoffError(retryAt, now);
    this.takeRequest(identity.peerId, now);
    const signinId = Buffer.from(this.random(18)).toString('base64url');
    const expiresAt = new Date(now.getTime() + SCREEN_SIGNIN_TTL_S * 1000);
    const replaced = this.current(now) !== null;
    this.live = {
      signinId,
      peerId: identity.peerId,
      accountId: account.id,
      deviceId,
      endpoint: input.endpoint,
      name: consoleDisplayName(account.name) ?? consoleDisplayName(account.email) ?? 'Someone',
      device: consoleDisplayName(input.endpoint.label) ?? PLATFORM_NAMES[input.endpoint.platform],
      letters: generateScreenSignInLetters((n) => this.random(n)),
      expiresAt,
      generation: 0,
    };
    this.show();
    // Never the letters.
    this.options.log.info(
      { peer: identity.peerId.slice(-8), replaced },
      'screen sign-in: the screen shows a code for a device',
    );
    return { signinId, expiresAt: expiresAt.toISOString(), device: deviceId };
  }

  /**
   * `enroll.screen.begin {signinId, share}`: the CPace responder with the letters showing now, kept for this session
   * (a new begin replaces it). Only the requesting key, not in backoff; an invalid share is refused and costs nothing.
   */
  async begin(
    identity: Identity,
    session: SessionScope | null,
    input: { signinId: string; share: string },
  ): Promise<{ share: string }> {
    if (!session) throw new SessionOpError('unavailable', 'Sign in at the box over a session.');
    const now = this.now();
    this.mine(identity, input.signinId, now);
    const retryAt = await this.backoff(now);
    if (retryAt) throw backoffError(retryAt, now);
    // The letters and their generation are taken together, after the last wait (MR-51).
    const live = this.mine(identity, input.signinId, now);
    let pake: ReturnType<typeof screenSignInPakeResponder>;
    try {
      pake = screenSignInPakeResponder(
        {
          password: live.letters,
          deviceId: live.deviceId,
          appliancePeerId: this.options.appliancePeerId,
          clientPeerId: identity.peerId,
          signinId: live.signinId,
        },
        input.share,
        (n) => this.random(n),
      );
    } catch (err) {
      if (err instanceof ClaimPakeError && err.code === 'invalid_share')
        throw screenError('screen_share_invalid', 'The sign-in share isn’t valid.');
      throw err;
    }
    session.screenBegin = {
      signinId: live.signinId,
      tags: pake.tags,
      expiresAt: new Date(now.getTime() + CLAIM_BEGIN_TTL_MS),
      generation: live.generation,
    };
    return { share: pake.share };
  }

  /**
   * `enroll.screen {signinId, confirm}`: the session's begin is used up whatever happens; the tag is compared in
   * constant time first. A mismatch is one failed guess (`screen_code_invalid`; new letters on the screen). A match
   * ends the sign-in, lets the device in and answers the box's tag.
   */
  async confirm(
    identity: Identity,
    session: SessionScope | null,
    input: { signinId: string; confirm: string },
  ) {
    const begin = session?.screenBegin ?? null;
    if (session) session.screenBegin = null;
    const now = this.now();
    const live = this.mine(identity, input.signinId, now);
    if (
      !begin ||
      begin.signinId !== input.signinId ||
      begin.expiresAt <= now ||
      // A wrong guess since this begin rotated the letters it used.
      begin.generation !== live.generation
    )
      throw screenError(
        'screen_begin_missing',
        'This sign-in wasn’t started on this connection, or it ran out. Type the code again.',
      );
    if (!claimConfirmEqual(begin.tags.client, input.confirm)) {
      await this.failed(identity, live, now);
      throw screenError('screen_code_invalid', 'That isn’t it. Your Whombat now shows new letters.');
    }
    // Used: off the screen before anything waits, so a second confirm finds nothing.
    this.live = null;
    this.show();
    const endpointId = await this.store.enroll(identity, live.accountId, live.endpoint, now);
    await this.store.clearFailures();
    this.options.log.info({ peer: identity.peerId.slice(-8) }, 'screen sign-in: a device was let in');
    void this.store.notify(`screen-enrolled:${endpointId}`, SECURITY_NOTICES.screenEnrolled);
    return { ...(await this.store.enrolledOutput(endpointId)), confirm: begin.tags.appliance };
  }

  /**
   * One wrong guess: counted in the database (a restart keeps the backoff), the letters rotate at once while the
   * sign-in is live (every begin ends), and the person hears once when the backoff starts (BX-S05). Never the letters.
   */
  private async failed(identity: Identity, live: LiveSignIn, now: Date): Promise<void> {
    // At once, before anything waits: no begin can take the guessed letters after this one failed.
    if (this.live === live) {
      live.letters = generateScreenSignInLetters((n) => this.random(n));
      live.generation += 1;
      this.show();
    }
    await this.store.recordFailure(identity.peerId, now);
    const failures = await this.store.failures(now);
    const retryAt = screenBackoff(failures, now);
    this.options.log.warn(
      { backoffUntil: retryAt?.toISOString() ?? null },
      'screen sign-in: a wrong code (one failed guess)',
    );
    if (failures.n === CLAIM_FREE_FAILURES + 1)
      void this.store.notify(`screen-backoff:${now.getTime()}`, SECURITY_NOTICES.screenBackoff);
  }
}

/** The screen sign-in's database and push (`TrustService`'s). */
export class DbScreenSignInStore implements ScreenSignInStore {
  constructor(
    private readonly services: Services,
    private readonly trust: TrustService,
  ) {}

  private get db() {
    return this.services.db;
  }

  async claimedDeviceId(): Promise<string | null> {
    const [row] = await this.db
      .select({ consumed: applianceState.claimConsumedAt, deviceId: applianceState.claimDeviceId })
      .from(applianceState)
      .where(eq(applianceState.id, 1));
    return row?.consumed && row.deviceId ? row.deviceId : null;
  }

  async endpointState(peerId: string): Promise<{ accountId: string; revoked: boolean } | null> {
    const [row] = await this.db
      .select({ accountId: applianceEndpoints.accountId, revokedAt: applianceEndpoints.revokedAt })
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.peerId, peerId));
    return row ? { accountId: row.accountId, revoked: row.revokedAt !== null } : null;
  }

  async account() {
    const person = await this.trust.personAccountId();
    if (!person) return null;
    const [row] = await this.db
      .select({ id: accounts.id, name: accounts.name, email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, person));
    return row ?? null;
  }

  async failures(now: Date): Promise<{ n: number; latest: Date | null }> {
    const since = new Date(now.getTime() - CLAIM_FAILURE_WINDOW_S * 1000);
    const [row] = await this.db
      .select({ n: count(), latest: max(applianceClaimFailures.at) })
      .from(applianceClaimFailures)
      .where(
        and(eq(applianceClaimFailures.method, SCREEN_FAILURE_METHOD), gt(applianceClaimFailures.at, since)),
      );
    return { n: row?.n ?? 0, latest: row?.latest ? new Date(row.latest) : null };
  }

  async recordFailure(peerId: string, now: Date): Promise<void> {
    await this.db.insert(applianceClaimFailures).values({ method: SCREEN_FAILURE_METHOD, peerId, at: now });
    await this.db
      .delete(applianceClaimFailures)
      .where(
        and(
          eq(applianceClaimFailures.method, SCREEN_FAILURE_METHOD),
          lte(applianceClaimFailures.at, new Date(now.getTime() - CLAIM_FAILURE_WINDOW_S * 1000)),
        ),
      );
  }

  async clearFailures(): Promise<void> {
    await this.db
      .delete(applianceClaimFailures)
      .where(eq(applianceClaimFailures.method, SCREEN_FAILURE_METHOD));
  }

  enroll(identity: Identity, accountId: string, endpoint: ScreenEndpoint, now: Date): Promise<string> {
    return this.services.pipeline.transactAccount(async (tx) => {
      // Another account since the request (a restore): as if the box had no screen to sign in at.
      if (!(await this.trust.passkeys.accountActive(tx, accountId))) throw unavailable();
      const [existing] = await tx
        .select({
          id: applianceEndpoints.id,
          accountId: applianceEndpoints.accountId,
          revokedAt: applianceEndpoints.revokedAt,
        })
        .from(applianceEndpoints)
        .where(eq(applianceEndpoints.peerId, identity.peerId));
      if (existing && !existing.revokedAt && existing.accountId === accountId) return existing.id;
      return this.trust.insertEndpoint(tx, {
        identity,
        accountId,
        endpoint,
        via: 'screen',
        by: null,
        at: now,
      });
    });
  }

  enrolledOutput(endpointId: string) {
    return this.trust.enrolledOutput(endpointId);
  }

  async notify(what: string, notice: SecurityNotice): Promise<void> {
    try {
      const person = await this.trust.personAccountId();
      if (person) await this.trust.push?.security([person], what, notice);
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'screen sign-in: the notice was not pushed');
    }
  }
}
