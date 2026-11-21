/**
 * The drain gate (docs/decisions/managed-runtime.md MR-15; `@whombat/control-contracts/local` `DrainRequest`).
 *
 * - scope `all` (updates, network changes): no new agent turn is handed to a runner, no approved action starts
 *   executing, the automation engine starts no step, the GitHub poller rests; session commands answer
 *   `unavailable` (reads still work). Everything waiting is already durable (dispatches, approvals, automation
 *   runs, jobs), so resuming picks it up where it was.
 * - scope `writes` (a backup checkpoint): a write barrier. New write transactions wait at the commit pipeline,
 *   the ones in flight finish, file-moving workers pause; running turns continue (their writes wait too).
 *
 * The caller holds it with a lease: without a renewal (the same request id) the gate opens again by itself, so a
 * crashed manager or backup service never leaves the runtime drained.
 */
import type { LicenceStatusResult } from '@whombat/protocol/licence';
import { ApiError } from './errors';

export type DrainScope = 'all' | 'writes';

export interface DrainHold {
  requestId: string;
  scope: DrainScope;
  reason: string;
  since: Date;
  leaseUntil: Date;
}

/** How long an update's question about running work counts as an update waiting (`MaintenanceGate.updateWaits`). */
export const UPDATE_WAITS_MS = 2 * 60_000;

export class MaintenanceGate {
  #hold: DrainHold | null = null;
  /**
   * Quarantine (a restored replacement, appliance BK-13; `WHOMBAT_QUARANTINE_FILE` exists): no schedules,
   * automations, runner turns, approved executions, poller or outbound effects until the person releases it.
   */
  quarantined = false;
  #leaseTimer: NodeJS.Timeout | null = null;
  #barrierWaiters: (() => void)[] = [];
  /** Write transactions in flight (the commit pipeline counts them). */
  activeWrites = 0;
  /**
   * How long a person's command waits for a drain to end before it is turned away: while an update waits for running
   * work, the manager drains only for the moment it takes to ask, and a command sent then must not fail.
   */
  settleMs = 5_000;
  readonly #listeners = new Set<(draining: boolean) => void>();
  /** When an update last asked what still runs and found work it waits for (`noteUpdateWaits`). */
  #updateWaitsAt: number | null = null;

  /**
   * An update asked what still runs and some of it holds the update: a turn that only waits for a T3 Code thread hands
   * that wait to Whombat (`updateWaits`), so the update needn't wait for the whole fix.
   */
  noteUpdateWaits(now: Date): void {
    this.#updateWaitsAt = now.getTime();
  }

  /** Whether an update waited for running work in the last `UPDATE_WAITS_MS` (it asks again every few seconds). */
  updateWaits(now: Date): boolean {
    return this.#updateWaitsAt !== null && now.getTime() - this.#updateWaitsAt < UPDATE_WAITS_MS;
  }

  /** Scope `all` is held: no new turns, executions, automation steps or session commands. */
  get draining(): boolean {
    return this.#hold?.scope === 'all';
  }

  /** Background effects must wait: drained (scope `all`) or quarantined. */
  get paused(): boolean {
    return this.draining || this.quarantined;
  }

  /** Any drain (either scope) is held. */
  get held(): DrainHold | null {
    return this.#hold;
  }

  get since(): Date | null {
    return this.#hold?.since ?? null;
  }

  get reason(): string | null {
    return this.#hold?.reason ?? null;
  }

  /** Whether the gate is open, or opens within `settleMs`. */
  async opened(): Promise<boolean> {
    if (!this.draining) return true;
    return new Promise((resolve) => {
      const done = (open: boolean) => {
        clearTimeout(timer);
        off();
        resolve(open);
      };
      const timer = setTimeout(() => done(false), this.settleMs);
      timer.unref?.();
      const off = this.onChange((draining) => {
        if (!draining) done(true);
      });
    });
  }

  /** New write transactions wait here while a `writes` (or `all`) barrier is held. */
  async writeBarrier(): Promise<void> {
    while (this.#hold?.scope === 'writes')
      await new Promise<void>((resolve) => this.#barrierWaiters.push(resolve));
  }

  /**
   * Takes or renews a hold. Returns `busy` when another request id holds it. A simple `drain(reason, now)` (tests,
   * scripts) holds scope `all` without a lease.
   */
  drain(
    reason: string,
    now: Date,
    options: { requestId?: string; scope?: DrainScope; leaseMs?: number } = {},
  ): 'held' | 'busy' {
    const requestId = options.requestId ?? 'local';
    if (this.#hold && this.#hold.requestId !== requestId) return 'busy';
    const leaseMs = options.leaseMs ?? 24 * 3600_000;
    const wasDraining = this.draining;
    this.#hold = {
      requestId,
      scope: options.scope ?? this.#hold?.scope ?? 'all',
      reason,
      since: this.#hold?.since ?? now,
      leaseUntil: new Date(now.getTime() + leaseMs),
    };
    if (this.#leaseTimer) clearTimeout(this.#leaseTimer);
    this.#leaseTimer = setTimeout(() => this.resume(), leaseMs);
    this.#leaseTimer.unref?.();
    if (wasDraining !== this.draining) for (const l of this.#listeners) l(this.draining);
    return 'held';
  }

  /** Opens the gate (`requestId` must match the holder when given). */
  resume(requestId?: string): 'resumed' | 'busy' {
    if (!this.#hold) return 'resumed';
    if (requestId !== undefined && this.#hold.requestId !== requestId && this.#hold.requestId !== 'local')
      return 'busy';
    const wasDraining = this.draining;
    this.#hold = null;
    if (this.#leaseTimer) clearTimeout(this.#leaseTimer);
    this.#leaseTimer = null;
    for (const w of this.#barrierWaiters.splice(0)) w();
    if (wasDraining) for (const l of this.#listeners) l(false);
    return 'resumed';
  }

  onChange(listener: (draining: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/* The licence gate (LC-10, MR-58) ------------------------------------------------------------------------------ */

/** What a plan limits on adding (LC-11; one-person.md OP-S10: no members to count). */
export type LicenceLimitKind = 'connectors';

/** LC-14: the refusal the person sees while the licence is lapsed. */
export const LICENCE_LAPSED_MESSAGE =
  'Your Whombat’s subscription has ended, so agents and automations are paused. You can still read and export everything.';

const LIMIT_NOUNS: Record<LicenceLimitKind, [string, string]> = {
  connectors: ['connector', 'connectors'],
};

/** `licence.lapsed` (`not_allowed`, CT-77). */
export function licenceLapsed(): ApiError {
  return new ApiError('not_allowed', LICENCE_LAPSED_MESSAGE, { details: { code: 'licence.lapsed' } });
}

/** `licence.limit` (`not_allowed`, `details` = `LicenceLimitDetails`, CT-77); LC-14's copy. */
export function licenceLimit(limit: LicenceLimitKind, allowed: number): ApiError {
  const [one, many] = LIMIT_NOUNS[limit];
  return new ApiError(
    'not_allowed',
    `Your plan allows ${allowed} ${allowed === 1 ? one : many}. Remove one or change your plan.`,
    { details: { code: 'licence.limit', limit, allowed } },
  );
}

/**
 * Where the licence was enforced (LC-10), next to the drain gate. **Inert since Whombat Link** (whombat-link.md LNK-04):
 * every box runs without a licence, so the gate always allows — `lapsed` is never true and nothing is refused, whatever
 * state a pushed token would give. The state stays readable (`status`) and its callers stay in place until phase 2
 * deletes them, so a rollback to the release before still finds its columns and ops.
 */
export class LicenceGate {
  #source: (() => LicenceStatusResult | null) | null = null;

  /** The managed runtime's licence state (null: an unclaimed box, nothing enforced). */
  enforce(source: () => LicenceStatusResult | null): void {
    this.#source = source;
  }

  release(): void {
    this.#source = null;
  }

  /** The current state; null when nothing is enforced (self-hosted, unclaimed). */
  get status(): LicenceStatusResult | null {
    return this.#source?.() ?? null;
  }

  /** Never: the licence is inert (LNK-04). */
  get lapsed(): boolean {
    return false;
  }

  /** A new agent turn: always allowed (LNK-04). */
  assertNotLapsed(): void {}

  /** Adding one more `kind`: always allowed, at any count (LNK-04). */
  async assertCanAdd(_kind: LicenceLimitKind, _count: () => Promise<number>): Promise<void> {}
}
