/**
 * The appliance licence on the runtime side (the appliance's licence.md LC-06…LC-11; contracts CT-76, CT-77;
 * docs/decisions/managed-runtime.md MR-55…MR-61). `WHOMBAT_LICENCE=off` (development, tests, the community edition;
 * hermes-engine.md HE-24, HE-49) runs without one: no state, nothing enforced, as on an unclaimed box.
 *
 * - **Trust.** Tokens verify against the key set pinned in the image (`WHOMBAT_LICENCE_KEYS_FILE`, LC-03) and this
 *   appliance's device id (provisioning's `claim.json`). Nothing here talks to control: the manager renews and pushes.
 * - **Storage** (`appliance_state`, LC-07): the latest verified token, the manager's high-water mark (only ever goes
 *   up) and the runtime's own clock mark, raised hourly and at every push to the local clock; a newer token resets
 *   it to the high-water mark, so control's time wins. Effective time = max(clock, high water, clock mark).
 * - **Push** (`POST /licence` on the admin socket, CT-77): verify (400 `bad_request`), refuse an older `iat`
 *   (409 `stale`), store, answer `LocalLicenceStatus` (null while unclaimed). `token: null` keeps the stored token.
 * - **State** (LC-09): the contracts' `licenceStatus`, computed in memory and cached for 60 s; null while unclaimed.
 *   Every change of state or reason is a signed `licence.state_changed` appliance event, checked every minute
 *   too, so licensed → grace at `exp` is recorded without traffic. The last recorded state is the chain's.
 * - **Enforcement** goes through `services.licence` (`LicenceGate`, `lib/maintenance.ts`), which reads `status()`.
 * - **Check now** (`licence.refresh`): the manager's `POST /v1/licence/renew`, then the fresh view.
 */

import {
  type LicenceClaims,
  type LicenceKeySet,
  type LicenceReason,
  type LicenceState,
  type LicenceStatusResult,
  licenceStatus,
  verifyLicenceToken,
} from '@whombat/protocol/licence';
import type { LicenceStatusView } from '@whombat/protocol/session';
import { desc, eq, sql } from 'drizzle-orm';
import { externalEffect, outsideCommandScope } from '../commit/scope';
import { LICENCE_DEV_ENVS, readLicenceKeySet } from '../config';
import type { Db, Tx } from '../db/client';
import { applianceEvents, applianceState } from '../db/schema/index';
import { licenceUsage } from '../domain/licence-usage';
import type { Services } from '../services';
import { APPLIANCE_AUDIT_LOCK, appendApplianceEvent } from './audit';
import { ManagerCallError, type ManagerPort } from './ports';
import { SessionOpError } from './session-error';
import { requireEnrolled, type SessionPrincipal } from './trust';

/** How long a computed state is reused (LC-09). */
export const LICENCE_CACHE_MS = 60_000;
/** The transition check without traffic (licensed → grace at `exp`, grace → lapsed). */
export const LICENCE_CHECK_MS = 60_000;
/** The clock mark is raised this often (and at every push, LC-07). */
export const LICENCE_CLOCK_MARK_MS = 3_600_000;
const STATE_ID = 1;

export interface LicenceOptions {
  /** No licence at all (`WHOMBAT_LICENCE=off`): no state, nothing enforced. */
  off?: boolean;
  /** The pinned key set; null with the licence off, or in suites that never push a token. */
  keySet: LicenceKeySet | null;
  /** Dev and test key sets only (MR-60): the grace instead of `LICENCE_GRACE_S`. */
  graceS?: number | undefined;
  /** Dev and test key sets only (MR-60): seconds added to the local clock the licence sees. */
  clockOffsetS?: number | undefined;
}

/** The state and reason a `licence.state_changed` event records (null: no licence state). */
export type LicenceMark = { state: LicenceState; reason: LicenceReason } | null;

/** What `POST /licence` answers. */
export type LicencePushOutcome =
  | { ok: true; licence: LocalLicenceStatus | null }
  | { ok: false; status: number; code: string; message: string };

export interface LocalLicenceStatus {
  state: LicenceState;
  reason: LicenceReason;
  plan: string | null;
  expiresAt: string | null;
  graceEndsAt: string | null;
  effectiveAt: string;
}

interface Inputs {
  claims: LicenceClaims | null;
  highWater: number;
  clockMark: number;
  claimedAt: number | null;
}

const secs = (d: Date | null | undefined): number | null => (d ? Math.floor(d.getTime() / 1000) : null);
const date = (s: number): Date => new Date(s * 1000);
const iso = (s: number | null): string | null => (s === null ? null : date(s).toISOString());
const markOf = (r: LicenceStatusResult | null): LicenceMark =>
  r ? { state: r.state, reason: r.reason } : null;
const sameMark = (a: LicenceMark, b: LicenceMark): boolean =>
  a === null || b === null ? a === b : a.state === b.state && a.reason === b.reason;

export class LicenceService {
  #token: string | null = null;
  #claims: LicenceClaims | null = null;
  #highWater = 0;
  #clockMark = 0;
  #claimedAt: number | null = null;
  #deviceId: string | null = null;
  #cache: { at: number; result: LicenceStatusResult | null } | null = null;
  /** The last recorded state (the chain's latest `licence.state_changed`); undefined until loaded. */
  #recorded: LicenceMark | undefined = undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #checking = false;
  #timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly services: Services,
    private readonly manager: ManagerPort,
    readonly options: LicenceOptions,
  ) {
    const devOnly = options.graceS !== undefined || options.clockOffsetS !== undefined;
    if (devOnly && options.keySet && !LICENCE_DEV_ENVS.has(options.keySet.env))
      throw new Error(
        `the licence's dev overrides need a local, dev or test key set (this one is ${options.keySet.env})`,
      );
  }

  /**
   * The runtime's licence: always off since Whombat Link (whombat-link.md LNK-04), whatever `WHOMBAT_LICENCE` says. A
   * token the manager still pushes is verified and kept (`POST /licence`), so a rollback finds it, but no state is
   * computed, shown or enforced, and nothing tells the person about a lapse.
   */
  static fromConfig(services: Services, manager: ManagerPort): LicenceService {
    const cfg = services.config;
    const read = cfg.WHOMBAT_LICENCE_KEYS_FILE ? readLicenceKeySet(cfg) : null;
    return new LicenceService(services, manager, {
      off: true,
      keySet: read?.ok ? read.keySet : null,
    });
  }

  /** The local clock as the licence sees it, epoch seconds (with the dev offset, MR-60). */
  localNow(): number {
    return Math.floor(this.services.clock().getTime() / 1000) + (this.options.clockOffsetS ?? 0);
  }

  /** Reads the stored state, installs the gate, raises the clock mark and records a changed state. */
  async load(): Promise<void> {
    const row = await ensureRow(this.services.db);
    this.#deviceId = row.claimDeviceId;
    this.#claimedAt = secs(row.claimConsumedAt);
    this.#highWater = secs(row.licenceHighWater) ?? 0;
    this.#clockMark = secs(row.licenceClockMark) ?? 0;
    this.#token = row.licenceToken;
    this.#claims = this.verifyStored();
    this.#recorded = await lastRecorded(this.services.db);
    this.#cache = null;
    this.services.licence.enforce(() => this.status());
    // Enforcement already follows the stored state; a failed write here (a read-only start) only delays the mark.
    await this.advanceClockMark().catch((err) =>
      this.services.log.warn({ err: String(err) }, 'licence: clock mark not raised at start'),
    );
  }

  /** The transition check every minute and the hourly clock mark (LC-07, LC-09). */
  start(): void {
    const log = (what: string) => (err: unknown) =>
      this.services.log.warn({ err: String(err) }, `licence: ${what} failed`);
    const check = setInterval(() => {
      this.#cache = null;
      this.status();
    }, LICENCE_CHECK_MS);
    const mark = setInterval(
      () => void this.advanceClockMark().catch(log('clock mark')),
      LICENCE_CLOCK_MARK_MS,
    );
    for (const t of [check, mark]) t.unref?.();
    this.#timers.push(check, mark);
  }

  close(): void {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    this.services.licence.release();
  }

  /** The stored token, if it still verifies (a later release may have dropped its key). */
  private verifyStored(): LicenceClaims | null {
    const keySet = this.options.keySet;
    if (!this.#token || !keySet || !this.#deviceId) return null;
    const verified = verifyLicenceToken(this.#token, {
      keySet,
      device: this.#deviceId,
      now: Math.max(this.localNow(), this.#highWater, this.#clockMark),
    });
    if (verified.ok) return verified.claims;
    this.services.log.warn(
      { error: verified.error },
      'licence: the stored token no longer verifies; ignored',
    );
    return null;
  }

  private compute(inputs: Inputs): LicenceStatusResult | null {
    // An unclaimed box has no licence state (LC-09), whatever it was pushed, nor has one without a licence (HE-24):
    // nothing is enforced.
    if (this.options.off || inputs.claimedAt === null) return null;
    return licenceStatus({
      claims: inputs.claims,
      now: this.localNow(),
      highWater: inputs.highWater,
      clockMark: inputs.clockMark,
      claimedAt: inputs.claimedAt,
      ...(this.options.graceS !== undefined ? { graceS: this.options.graceS } : {}),
    });
  }

  private get inputs(): Inputs {
    return {
      claims: this.#claims,
      highWater: this.#highWater,
      clockMark: this.#clockMark,
      claimedAt: this.#claimedAt,
    };
  }

  /**
   * The licence state now (cached for 60 s; null while unclaimed). A state that differs from the last recorded one
   * gets its `licence.state_changed` event in the background.
   */
  status(): LicenceStatusResult | null {
    const now = this.services.clock().getTime();
    const cached = this.#cache;
    if (cached && now >= cached.at && now < cached.at + LICENCE_CACHE_MS) return cached.result;
    const result = this.compute(this.inputs);
    this.#cache = { at: now, result };
    if (this.#recorded !== undefined && !sameMark(markOf(result), this.#recorded)) this.recordSoon();
    return result;
  }

  /** When `status()` was computed (`LicenceStatusView.checkedAt`). */
  get checkedAt(): Date {
    return new Date(this.#cache?.at ?? this.services.clock().getTime());
  }

  private recordSoon(): void {
    if (this.#checking) return;
    this.#checking = true;
    outsideCommandScope(() => {
      void this.serial(() => this.persist({}))
        .catch((err) => this.services.log.warn({ err: String(err) }, 'licence: recording the state failed'))
        .finally(() => {
          this.#checking = false;
        });
    });
  }

  /** Records a changed state now (the timer, tests). */
  async checkTransition(): Promise<LicenceMark> {
    this.#cache = null;
    await this.serial(() => this.persist({}));
    return markOf(this.status());
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => {});
    return next;
  }

  /**
   * Writes `changes` (token, high water, clock mark) and, in the same transaction, the `licence.state_changed`
   * event when the state they give differs from the chain's last one. Memory follows once it committed.
   */
  private async persist(changes: {
    token?: string | null;
    claims?: LicenceClaims | null;
    highWater?: number;
    clockMark?: number;
  }): Promise<void> {
    const next: Inputs = {
      claims: changes.claims !== undefined ? changes.claims : this.#claims,
      highWater: changes.highWater ?? this.#highWater,
      clockMark: changes.clockMark ?? this.#clockMark,
      claimedAt: this.#claimedAt,
    };
    const writes = Object.keys(changes).length > 0;
    const result = this.compute(next);
    if (!writes && this.#recorded !== undefined && sameMark(markOf(result), this.#recorded)) return;
    const at = this.services.clock();
    const recorded = await outsideCommandScope(() =>
      this.services.pipeline.transactAccount(async (tx) => {
        if (writes) {
          await ensureRow(tx);
          await tx
            .update(applianceState)
            .set({
              ...(changes.token !== undefined ? { licenceToken: changes.token } : {}),
              licenceHighWater: next.highWater ? date(next.highWater) : null,
              licenceClockMark: next.clockMark ? date(next.clockMark) : null,
              updatedAt: at,
            })
            .where(eq(applianceState.id, STATE_ID));
        }
        return this.record(tx, result, next.claims, at);
      }),
    );
    if (changes.token !== undefined) this.#token = changes.token;
    this.#claims = next.claims;
    this.#highWater = next.highWater;
    this.#clockMark = next.clockMark;
    this.#cache = { at: at.getTime(), result };
    const before = this.#recorded;
    this.#recorded = recorded;
    if (before !== undefined && !sameMark(before, recorded)) this.transitioned(before, recorded);
  }

  /** Appends `licence.state_changed` when `result` differs from the chain's last recorded state; returns it. */
  private async record(
    tx: Tx,
    result: LicenceStatusResult | null,
    claims: LicenceClaims | null,
    at: Date,
  ): Promise<LicenceMark> {
    // The chain lock first, so two writers can't both see the old state.
    await tx.execute(sql`select pg_advisory_xact_lock(${APPLIANCE_AUDIT_LOCK})`);
    const last = await lastRecorded(tx);
    const to = markOf(result);
    if (sameMark(last, to)) return last;
    await appendApplianceEvent(tx, this.services.custody, {
      type: 'licence.state_changed',
      actorAccountId: null,
      endpointId: null,
      payload: { from: last, to, plan: result?.plan ?? null, jti: claims?.jti ?? null },
      at,
    });
    return to;
  }

  private transitioned(from: LicenceMark, to: LicenceMark): void {
    this.services.log[to?.state === 'lapsed' ? 'warn' : 'info'](
      { from, to },
      to?.state === 'lapsed'
        ? 'licence lapsed: new agent turns, automations and additions are paused (reads, exports and human writes continue)'
        : 'licence state changed',
    );
    // Restored: held dispatches go to the runner on its next poll; automations pick up at once.
    if (from?.state === 'lapsed' && to?.state !== 'lapsed') this.services.automations.nudge();
  }

  /** Raises the clock mark to the local clock (hourly and at start, LC-07). */
  async advanceClockMark(): Promise<void> {
    await this.serial(async () => {
      const local = this.localNow();
      await this.persist(local > this.#clockMark ? { clockMark: local } : {});
    });
  }

  /** The claim happened (`enroll.claim`): the licence state starts (grace `no_licence` until a token arrives). */
  async claimed(): Promise<void> {
    await this.serial(async () => {
      const row = await ensureRow(this.services.db);
      this.#deviceId = row.claimDeviceId;
      this.#claimedAt = secs(row.claimConsumedAt);
      this.#claims = this.verifyStored();
      this.#cache = null;
      await this.persist({});
    });
  }

  /**
   * `POST /licence` (CT-77): the manager's token (or null: it holds none yet) and its high-water mark. Refused tokens
   * change nothing; `highWater` only ever goes up; a newer token resets the clock mark to it (LC-07).
   */
  push(input: { token: string | null; highWater: string }): Promise<LicencePushOutcome> {
    return this.serial(async (): Promise<LicencePushOutcome> => {
      const pushed = Date.parse(input.highWater);
      if (!Number.isFinite(pushed))
        return { ok: false, status: 400, code: 'bad_request', message: 'highWater is not a time' };
      const row = await ensureRow(this.services.db);
      this.#deviceId = row.claimDeviceId;
      this.#claimedAt = secs(row.claimConsumedAt);
      const local = this.localNow();
      const highWater = Math.max(this.#highWater, Math.floor(pushed / 1000));
      const changes: Parameters<LicenceService['persist']>[0] = {
        highWater,
        clockMark: Math.max(this.#clockMark, local),
      };
      if (input.token !== null) {
        const keySet = this.options.keySet;
        if (!keySet)
          return {
            ok: false,
            status: 503,
            code: 'unavailable',
            message: 'no licence key set is configured',
          };
        if (!row.claimDeviceId)
          return {
            ok: false,
            status: 409,
            code: 'no_device',
            message: 'provisioning has not named this device yet',
          };
        const verified = verifyLicenceToken(input.token, {
          keySet,
          device: row.claimDeviceId,
          now: Math.max(local, highWater, this.#clockMark),
        });
        if (!verified.ok)
          return {
            ok: false,
            status: 400,
            code: 'bad_request',
            message: `the licence token does not verify (${verified.error})`,
          };
        const held = this.#claims;
        if (held && verified.claims.iat < held.iat)
          return {
            ok: false,
            status: 409,
            code: 'stale',
            message: 'this token is older than the one the runtime holds',
          };
        changes.token = input.token;
        changes.claims = verified.claims;
        // A renewed token: control's time wins, so a clock that once ran ahead heals (LC-07).
        if (!held || verified.claims.iat > held.iat) changes.clockMark = highWater;
      }
      await this.persist(changes);
      return { ok: true, licence: localStatus(this.status()) };
    });
  }

  /** `licence.status` and `appliance.status.licence` (CT-77): null while unclaimed. */
  async view(): Promise<LicenceStatusView | null> {
    const result = this.status();
    if (!result) return null;
    return {
      state: result.state,
      reason: result.reason,
      plan: result.plan,
      limits: result.limits,
      renewedAt: iso(result.renewedAt),
      expiresAt: iso(result.expiresAt),
      graceEndsAt: iso(result.graceEndsAt),
      effectiveAt: date(result.effectiveAt).toISOString(),
      usage: await licenceUsage(this.services.db),
      checkedAt: this.checkedAt.toISOString(),
    };
  }

  /**
   * `licence.refresh` (“Check again”): the manager renews now and pushes the new token before it answers
   * (LC-08). A renewal that didn't happen is `licence.renew_failed` (`unavailable`, CT-77); within 60 s of the last
   * one the manager answers 429, which is `rate_limited` here.
   */
  async refresh(principal: SessionPrincipal): Promise<{ licence: LicenceStatusView | null }> {
    requireEnrolled(principal);
    let reason: string;
    try {
      // Harmless to repeat (the manager limits renewals to one a minute): observed only (CS-01).
      const answer = await externalEffect('manager.licence.renew', () => this.manager.renewLicence(), {
        idempotent: true,
      });
      if (answer.renewed) {
        this.#cache = null;
        return { licence: await this.view() };
      }
      reason = answer.error ?? 'unknown';
    } catch (err) {
      if (err instanceof ManagerCallError && err.status === 429)
        throw new SessionOpError(
          'rate_limited',
          'Your Whombat checked its subscription a moment ago. Try again in a minute.',
        );
      this.services.log.warn({ err: String(err) }, 'licence: the manager could not renew');
      reason = 'unreachable';
    }
    throw new SessionOpError('unavailable', renewFailedMessage(reason), {
      code: 'licence.renew_failed',
      reason: reason.slice(0, 64),
    });
  }
}

function renewFailedMessage(reason: string): string {
  switch (reason) {
    case 'device_revoked':
      return 'This Whombat was removed from your organization, so its subscription can’t be checked.';
    case 'device_unclaimed':
      return 'Whombat doesn’t know this Whombat as claimed yet. Try again in a few minutes.';
    case 'devices_allowed_reached':
      return 'Your plan covers fewer Whombats than your organization has. Remove one or change your plan.';
    case 'rate_limited':
      return 'Your Whombat checked its subscription too often. Try again later.';
    default:
      return 'Your Whombat couldn’t check its subscription just now. Try again later.';
  }
}

/** `LocalLicenceStatus` (RFC 3339) for the manager's log. */
export function localStatus(result: LicenceStatusResult | null): LocalLicenceStatus | null {
  if (!result) return null;
  return {
    state: result.state,
    reason: result.reason,
    plan: result.plan,
    expiresAt: iso(result.expiresAt),
    graceEndsAt: iso(result.graceEndsAt),
    effectiveAt: date(result.effectiveAt).toISOString(),
  };
}

async function ensureRow(db: Db) {
  await db.insert(applianceState).values({ id: STATE_ID }).onConflictDoNothing();
  const [row] = await db.select().from(applianceState).where(eq(applianceState.id, STATE_ID));
  if (!row) throw new Error('appliance state missing');
  return row;
}

/** The chain's last recorded licence state (`to` of the latest `licence.state_changed`), null before any. */
async function lastRecorded(db: Db): Promise<LicenceMark> {
  const [row] = await db
    .select({ payload: applianceEvents.payload })
    .from(applianceEvents)
    .where(eq(applianceEvents.type, 'licence.state_changed'))
    .orderBy(desc(applianceEvents.seq))
    .limit(1);
  const to = (row?.payload as { to?: LicenceMark } | undefined)?.to ?? null;
  return to && typeof to.state === 'string' && typeof to.reason === 'string'
    ? { state: to.state, reason: to.reason }
    : null;
}
