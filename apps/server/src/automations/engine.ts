/**
 * The automations engine (docs/decisions/bp-automations.md BP-C05, BP-C10). One loop per server process, active only
 * while it holds a session-level `pg_try_advisory_lock` (a second process stays passive and retries). The lock dies with
 * its session: the active engine checks it every `lockCheckMs` and steps down at once when it's gone (CS-11,
 * docs/decisions/command-safety.md). Each tick:
 *
 *   1. triggers — reads each burrow's signed `events` after its durable cursor, turns matching events into runs
 *      (deduped by automation + version + event) and moves the cursor, in one transaction (`engine/triggers.ts`);
 *   2. schedules — fires due schedules (`next_fire_at`) under their missed-run and overlap policies
 *      (`engine/schedules.ts`);
 *   3. runs — advances every active run under a lease with a fencing token: each step's effect and its new
 *      state commit together (steps.ts); external effects are marked first and reconciled after a crash
 *      (`engine/run-advance.ts`, `engine/external.ts`);
 *   4. periodically, and at boot, the approvals engine's recovery (stuck executions, approved-but-unexecuted).
 *
 * Its guard re-checks an automation's approval as it executes (`engine/approval-guard.ts`). Nothing here depends on
 * in-memory post-commit hooks: a crash at any point is picked up from the database.
 */
import { randomBytes } from 'node:crypto';
import { outsideCommandScope } from '../commit/scope';
import type { BusFrame } from '../realtime/bus';
import type { Services } from '../services';
import { cleanUpMergedBranches } from './cleanup';
import { approvalGuard, reconcileContinue } from './engine/approval-guard';
import { type LockSession, lockHeld, takeLock, unlock } from './engine/lock';
import { DEFAULT_ENGINE_OPTIONS, type EngineOptions } from './engine/options';
import { activeRunIds, RunAdvancer } from './engine/run-advance';
import { Schedules } from './engine/schedules';
import { eventBurrows, scanBurrow, skipEventCursors } from './engine/triggers';
import { CONTINUE_STEP } from './steps';

export { ENGINE_LOCK } from './engine/lock';
export { DEFAULT_ENGINE_OPTIONS, type EngineOptions } from './engine/options';
export { newestFires } from './engine/schedules';

export class AutomationEngine {
  readonly options: EngineOptions;
  /** This process's engine id (the owner of the leases it takes). */
  readonly id = `eng_${randomBytes(6).toString('hex')}`;
  private active = false;
  private closed = false;
  /** The next pass (a timeout, SV-03) and when it is due (`performance.now()`). */
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  /** What the last pass saw: a live run, a live automation that reads events (the next schedule fire: `schedules`). */
  private running = false;
  private listening = false;
  private offBus: (() => void) | null = null;
  private lockTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private checking = false;
  /** It held the lock and lost it: passes do nothing until it holds it again (tests tick engines never started). */
  private lost = false;
  private reserved: LockSession | null = null;
  private ticking: Promise<void> | null = null;
  private again = false;
  /** `performance.now()` of the last approval recovery: cadences use the monotonic clock, not the wall clock. */
  private lastRecover = Number.NEGATIVE_INFINITY;
  /** When merged pull requests' branches were last looked at (AR-42), and branches GitHub couldn't be asked about. */
  private lastCleanup = Number.NEGATIVE_INFINITY;
  private readonly cleanupRetry = new Map<string, number>();
  /** The live automations' schedules, with when the next one fires. */
  private readonly schedules: Schedules;
  /** The runs, advanced under this engine's leases. */
  private readonly runs: RunAdvancer;

  constructor(
    private readonly services: Services,
    options: Partial<EngineOptions> = {},
  ) {
    this.options = { ...DEFAULT_ENGINE_OPTIONS, ...options };
    // Both read `this.options` as it is at each use (tests change it on a running engine).
    this.schedules = new Schedules(services, this.options);
    this.runs = new RunAdvancer(services, this.id, this.options);
    services.approvals.addGuard((ctx, _approval, row) => approvalGuard(ctx, row));
    services.approvals.setReconciler(CONTINUE_STEP, (_approval, row) => reconcileContinue(services.db, row));
  }

  /* Lifecycle ------------------------------------------------------------------------------------- */

  /** Becomes the active engine when it gets the lock (else retries), then ticks until closed. */
  start(): void {
    if (this.closed || this.lockTimer || this.active) return;
    // Its own work from the start, whoever starts it (see `tickIn`).
    outsideCommandScope(() => void this.attempt());
  }

  private async attempt(): Promise<void> {
    this.lockTimer = null;
    if (this.closed || this.active || this.reserved) return;
    try {
      const reserved = await takeLock(this.services.sql);
      if (reserved) {
        this.reserved = reserved;
        // Handover (CS-11): an engine whose session just ended may not have noticed yet — it checks every
        // `lockCheckMs`. Holding the lock two checks long before acting means it has stepped down by then.
        await new Promise((resolve) => setTimeout(resolve, this.options.lockCheckMs * 2).unref?.());
        // Closed meanwhile: `close()` gave the lock back.
        if (this.closed) return;
        if (!(await lockHeld(reserved).catch(() => false))) {
          if (this.closed) return;
          // Lost within the handover: a dead reservation's release() does nothing (PGG-02).
          reserved.release();
          this.reserved = null;
          this.retryLater();
          return;
        }
        this.active = true;
        this.lost = false;
        this.services.log.info({ engine: this.id }, 'automations engine is active');
        // The lock lives as long as its session: checked on its own timer, so a long pass doesn't hide a lost one.
        this.checkTimer = setInterval(() => void this.checkLock(), this.options.lockCheckMs);
        this.checkTimer.unref?.();
        await this.bootRecovery();
        if (!this.active) return;
        // Kicked by the commits that may bring it work; otherwise the next fire or the safety tick (SV-03).
        this.offBus = this.services.bus.onFrame((frame) => this.onFrame(frame));
        void this.tick();
        return;
      }
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'automations engine could not take the lock');
    }
    this.retryLater();
  }

  private retryLater(): void {
    if (this.closed || this.lockTimer) return;
    this.lockTimer = setTimeout(() => void this.attempt(), this.options.lockRetryMs);
    this.lockTimer.unref?.();
  }

  /**
   * Whether the session holding the lock still holds it (CS-11). A session the server ended (a failover, a restart,
   * `pg_terminate_backend`) took the lock with it, and its queries now reject (pg-guard PGG-03): this engine stops being
   * active at once and tries to take the lock again like a passive one.
   */
  async checkLock(): Promise<boolean> {
    const reserved = this.reserved;
    if (!this.active || !reserved || this.checking) return this.active;
    this.checking = true;
    let held = false;
    try {
      held = await lockHeld(reserved);
    } catch (err) {
      this.services.log.warn(
        { err: String(err), engine: this.id },
        'automations engine lost its lock session',
      );
    } finally {
      this.checking = false;
    }
    if (!held && this.reserved === reserved) this.stepDown();
    return held;
  }

  /** No longer the active engine: stop ticking, give the (dead) session back, and try for the lock again. */
  private stepDown(): void {
    if (!this.active) return;
    this.active = false;
    this.lost = true;
    this.stopTicking();
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
    // A dead reservation's release() does nothing (PGG-02); a live one without the lock goes back to the pool.
    this.reserved?.release();
    this.reserved = null;
    this.services.log.warn({ engine: this.id }, 'automations engine stepped down: its lock is gone');
    this.retryLater();
  }

  get isActive(): boolean {
    return this.active;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopTicking();
    if (this.lockTimer) clearTimeout(this.lockTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.lockTimer = null;
    this.checkTimer = null;
    await this.ticking?.catch(() => {});
    if (this.reserved) {
      await unlock(this.reserved);
      this.reserved.release();
      this.reserved = null;
    }
    this.active = false;
  }

  /** Something changed (a dispatch finished, an approval was decided): tick soon, if this engine is active. */
  nudge(): void {
    if (!this.active || this.closed) return;
    this.tickIn(10);
  }

  /**
   * A pass in `ms` unless one comes sooner. The timer starts outside any command scope (`nudge` is called from a
   * command's `after` hook): a pass is never part of that command, so its transactions don't consult (and get rolled
   * back by) a receipt the command settles meanwhile.
   */
  private tickIn(ms: number): void {
    if (!this.active || this.closed) return;
    const at = performance.now() + ms;
    if (this.timer && at >= this.timerAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = outsideCommandScope(() =>
      setTimeout(() => {
        this.timer = null;
        this.timerAt = Number.POSITIVE_INFINITY;
        void this.tick();
      }, ms),
    );
    this.timer.unref?.();
  }

  private stopTicking(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Number.POSITIVE_INFINITY;
    this.offBus?.();
    this.offBus = null;
  }

  /**
   * After a pass (SV-03): the safety tick — `tickMs` while there is work, `idleTickMs` without — or the next schedule
   * fire when that comes first.
   */
  private scheduleNext(): void {
    let ms = this.running || this.listening ? this.options.tickMs : this.options.idleTickMs;
    const nextFire = this.schedules.nextFire;
    if (nextFire !== null) ms = Math.min(ms, Math.max(0, nextFire - this.services.clock().getTime()) + 50);
    this.tickIn(ms);
  }

  /**
   * A frame that may bring work while there is some: a signed event (a trigger, a step's reply in its thread), a
   * dispatch or an approval changing. Many in a row make one pass (`kickMs`).
   */
  private onFrame(frame: BusFrame): void {
    if (!this.running && !this.listening) return;
    const type = frame.event.type;
    if (frame.eventId || type === 'dispatch.updated' || type === 'approval.updated')
      this.tickIn(this.options.kickMs);
  }

  /**
   * One pass of the loop. Safe to call any time (tests call it directly); overlapping calls coalesce. It runs outside
   * any command scope, whoever calls it: its commits are the engine's own, never a command's (MR-06).
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = outsideCommandScope(async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && !this.closed);
    }).finally(() => {
      this.ticking = null;
      this.scheduleNext();
    });
    return this.ticking;
  }

  private async pass(): Promise<void> {
    // Draining (MR-15): no trigger fires and no step starts; the runs and their cursors are durable.
    if (this.services.maintenance.paused) return;
    const log = this.services.log;
    const step = async (what: string, fn: () => Promise<unknown>) => {
      // An engine that stepped down mid-pass (CS-11) starts nothing more; another may be active now.
      if (this.lost) return;
      try {
        await fn();
      } catch (err) {
        log.error({ err: String(err), stack: (err as Error)?.stack }, `automations: ${what} failed`);
      }
    };
    if (this.services.licence.lapsed) {
      // A lapsed licence (LC-10): automations are paused. Schedules and triggers that come due meanwhile are
      // skipped, not caught up once the box is licensed again; started runs wait where they are. Approved actions
      // still execute (recovery below).
      await step('skip while lapsed', () => this.skipWhileLapsed());
    } else {
      await step('trigger scan', () => this.scanEvents());
      await step('schedules', () => this.scanSchedules());
      await step('runs', () => this.advanceAll());
      // After the work is done (AR-42): at most once a minute, the merged pull requests' branches.
      if (this.active && performance.now() - this.lastCleanup > this.options.recoverEveryMs) {
        this.lastCleanup = performance.now();
        await step('branch cleanup', () =>
          cleanUpMergedBranches(this.services, this.services.clock(), this.cleanupRetry),
        );
      }
    }
    // Monotonic: a wall clock stepped back (an NTP correction) must not hold periodic recovery off until it
    // catches up again.
    const now = performance.now();
    if (this.active && now - this.lastRecover > this.options.recoverEveryMs) {
      this.lastRecover = now;
      await step('approval recovery', () => this.services.approvals.recover());
    }
  }

  /**
   * While the licence is lapsed (LC-10): every schedule that came due moves to its next fire after now without a run,
   * and every burrow's trigger cursor moves past the events so far, so nothing missed meanwhile runs later. Returns
   * how many schedules and cursors moved.
   */
  async skipWhileLapsed(): Promise<number> {
    const now = this.services.clock();
    const moved = (await this.schedules.skipDue(now)) + (await skipEventCursors(this.services, now));
    if (moved) this.services.log.info({ moved }, 'automations: skipped while the licence is lapsed');
    return moved;
  }

  /** At boot (as the active engine): stuck approval executions, approvals decided before a crash, runs. */
  async bootRecovery(): Promise<void> {
    this.lastRecover = performance.now();
    // Only the lock holder gets here: leases of earlier engines belong to processes that are gone.
    await this.runs.releaseOthers();
    try {
      const r = await this.services.approvals.recover({ staleMs: 0 });
      if (r.settled || r.reevaluated) this.services.log.info(r, 'approvals recovered at boot');
    } catch (err) {
      this.services.log.error({ err: String(err) }, 'approval recovery at boot failed');
    }
  }

  /* The work of a pass ---------------------------------------------------------------------------- */

  /** New events in each burrow a live automation listens to, as runs (`engine/triggers.ts`). */
  async scanEvents(): Promise<number> {
    let created = 0;
    const burrows = await eventBurrows(this.services.db);
    this.listening = burrows.length > 0;
    for (const burrowId of burrows) created += await scanBurrow(this.services, this.options, burrowId);
    return created;
  }

  /** The due schedules, fired (`engine/schedules.ts`). */
  async scanSchedules(): Promise<number> {
    return this.schedules.scan();
  }

  /** Schedule timers a clock that went backwards left later than their next fire, pulled back. */
  async realignTimers(now: Date): Promise<number> {
    return this.schedules.realignTimers(now);
  }

  /** Every active run, oldest first, as far as it can go now (`engine/run-advance.ts`). */
  async advanceAll(): Promise<void> {
    const ids = await activeRunIds(this.services.db);
    this.running = ids.length > 0;
    for (const id of ids) {
      try {
        await this.advanceRun(id);
      } catch (err) {
        this.services.log.error(
          { err: String(err), stack: (err as Error)?.stack, runId: id },
          'automation run did not advance',
        );
      }
    }
  }

  /** Moves a run as far as it can go now (bounded), one committed transition at a time. */
  async advanceRun(runId: string): Promise<void> {
    return this.runs.advance(runId);
  }
}
