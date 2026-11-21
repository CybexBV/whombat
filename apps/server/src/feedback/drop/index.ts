/**
 * The encrypted feedback drop of a managed Whombat (docs/decisions/feedback-drop.md): the runtime's keys, its site
 * cards published through the manager, and the pull loop that collects, files and acknowledges drops. Built by the
 * managed runtime (it needs the manager); `services.feedback.drop` points at it, so health, snippets and the policy
 * can ask whether the drop works. Self-hosted Whombat has none (`drop` stays null) and keeps its direct widget.
 *
 * Timers run only after `start()` (the server's `index.ts`, never in a read-only start); tests drive `syncNow` and
 * `pull` by hand.
 *
 * - Cards: a full-set sync at start (once claimed), on the claim, on every feedback config event (debounced), and
 *   when the hourly check finds a card with less than 7 of its 14 days left, a site not yet accepted, a withdrawn one
 *   or a key due for rotation (FD-11). Failures retry with backoff, 1 min → 1 h.
 * - Pulls: while a card is published or the last pull said drops are pending, every `nextPullS` (control's); paused
 *   while quarantined or drained (FD-22). Unreachable: backoff 1 min → 1 h.
 * - Unsupported (the manager answers 501, or 404 when older, FD-21, FD-38): `support = 'unsupported'`, shown as the
 *   `drop_unsupported` warning and the policy's reason, never logged as an error; retried at the backoff's pace.
 * - `WHOMBAT_FEEDBACK=off`: one empty sync withdraws every card; nothing is pulled (FD-25).
 */
import { FEEDBACK_CARD_REISSUE_S } from '@whombat/core/feedback/drop';
import { isNotNull } from 'drizzle-orm';
import { feedbackDropSites } from '../../db/schema/index';
import { Outage } from '../../lib/outage';
import { dropUnsupported, type ManagerPort, managerUnreachable } from '../../managed/ports';
import type { Services } from '../../services';
import { type SyncOutcome, syncCards, syncDue } from './cards';
import { DropKeys } from './keys';
import { publishReporterBatch, reportersPending } from './reporters';
import { type PullSummary, pullOnce, sweepOutcomes } from './worker';

/** Batches one publishing run sends before it yields to a fresh run (FR-10). */
const REPORTER_BATCHES_PER_RUN = 10;

export interface ReporterPublishSummary {
  updates: number;
  removals: number;
  batches: number;
}

export type DropSupport = 'unknown' | 'supported' | 'unsupported';

export interface DropTimings {
  /** Coalesces config events into one sync. */
  syncDebounceMs: number;
  /** Backoff after a failure: from `retryMinMs`, doubling, up to `retryMaxMs` (FD-11: 1 min → 1 h). */
  retryMinMs: number;
  retryMaxMs: number;
  /** How often a paused (quarantined, drained) or unclaimed runtime looks again. */
  recheckMs: number;
  /** The hourly check. */
  checkMs: number;
}

const DEFAULT_TIMINGS: DropTimings = {
  syncDebounceMs: 1_000,
  retryMinMs: 60_000,
  retryMaxMs: 3_600_000,
  recheckMs: 15_000,
  checkMs: 3_600_000,
};

export class FeedbackDropService {
  readonly keys: DropKeys;
  /** Whether the manager and control offer the drop; `unknown` until the first answer. */
  support: DropSupport = 'unknown';
  /** Why the last sync failed (not for `unsupported`), null after one succeeded. */
  syncError: string | null = null;
  readonly #timings: DropTimings;
  #started = false;
  #closed = false;
  #syncTimer: NodeJS.Timeout | null = null;
  #pullTimer: NodeJS.Timeout | null = null;
  #checkTimer: NodeJS.Timeout | null = null;
  #syncing: Promise<SyncOutcome | null> | null = null;
  #syncAgain = false;
  #syncBackoff = 0;
  #pulling: Promise<PullSummary | null> | null = null;
  #pullBackoff = 0;
  /** Pulls the manager or control can't answer now (a restart): one outage in the log, BH-09. */
  readonly #pullReach = new Outage({
    what: 'feedback drop: the control plane',
    log: () => this.services.log,
    graceMs: 5 * 60_000,
  });
  /** The last pull said drops are waiting: keep pulling even without a published card (FD-22). */
  #pendingLast = false;
  /** Whether the manager and control take reporter statuses (`feedback.reporters.publish`, FR-10). */
  reportersSupport: DropSupport = 'unknown';
  #reportersTimer: NodeJS.Timeout | null = null;
  #publishing: Promise<ReporterPublishSummary | null> | null = null;
  #publishAgain = false;
  #reportersBackoff = 0;
  /** The last publishing run failed: its backoff stands, a request during it doesn't cut it short. */
  #publishFailed = false;
  /**
   * Control accepted a card sync since this process started (FR-12): before that, control may have dropped a site
   * whose card expired during an outage, and publishing to it would be answered `ok` and lost.
   */
  #cardsSynced = false;

  constructor(
    private readonly services: Services,
    private readonly manager: ManagerPort,
    private readonly options: { claimed: () => Promise<boolean>; timings?: Partial<DropTimings> },
  ) {
    this.keys = new DropKeys(services);
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
  }

  /** `WHOMBAT_FEEDBACK=on`: the drop is this Whombat's intake (FD-25). */
  get enabled(): boolean {
    return this.services.config.WHOMBAT_FEEDBACK === 'on';
  }

  /** Owners may take reports: the module is on and the manager and control haven't said they can't deliver. */
  get available(): boolean {
    return this.enabled && this.support !== 'unsupported';
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.requestSync(0);
    if (!this.enabled) return;
    this.#checkTimer = setInterval(() => void this.check(), this.#timings.checkMs);
    this.#checkTimer.unref?.();
    this.#schedulePull(0);
    this.requestReporterPublish(0);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const t of [this.#syncTimer, this.#pullTimer, this.#reportersTimer]) if (t) clearTimeout(t);
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#syncTimer = this.#pullTimer = this.#checkTimer = this.#reportersTimer = null;
    await Promise.allSettled([this.#syncing, this.#pulling, this.#publishing]);
  }

  /** Something the cards carry changed (a config event, the claim): sync soon. A no-op before `start`. */
  requestSync(delayMs = this.#timings.syncDebounceMs): void {
    if (!this.#started || this.#closed) return;
    if (this.#syncTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.#syncTimer);
    }
    this.#syncTimer = setTimeout(() => {
      this.#syncTimer = null;
      void this.syncNow();
    }, delayMs);
    this.#syncTimer.unref?.();
  }

  #backoff(current: number): number {
    return current ? Math.min(current * 2, this.#timings.retryMaxMs) : this.#timings.retryMinMs;
  }

  /**
   * Publishes the full card set now (none while `WHOMBAT_FEEDBACK=off`); concurrent calls share one sync and a call
   * during a sync runs another after it. Null when there was nothing to do (not claimed) or it failed.
   */
  syncNow(): Promise<SyncOutcome | null> {
    if (this.#syncing) {
      this.#syncAgain = true;
      return this.#syncing;
    }
    this.#syncing = this.#sync().finally(() => {
      this.#syncing = null;
      if (this.#syncAgain) {
        this.#syncAgain = false;
        this.requestSync(0);
      }
    });
    return this.#syncing;
  }

  async #sync(): Promise<SyncOutcome | null> {
    try {
      if (!(await this.options.claimed())) return null;
      const outcome = await syncCards(this.services, this.manager, this.keys, { withdrawAll: !this.enabled });
      this.#supported();
      this.syncError = null;
      this.#syncBackoff = 0;
      if (outcome.accepted.length) this.#schedulePull(0);
      const first = !this.#cardsSynced;
      this.#cardsSynced = true;
      if (outcome.reportersMarked || first) this.requestReporterPublish(0);
      return outcome;
    } catch (err) {
      if (dropUnsupported(err)) this.#unsupported();
      else {
        this.syncError = String(err).slice(0, 200);
        this.services.log.warn({ err: this.syncError }, 'feedback drop: site cards not published; retrying');
      }
      this.#syncBackoff = this.#backoff(this.#syncBackoff);
      this.requestSync(this.#syncBackoff);
      return null;
    }
  }

  #supported(): void {
    if (this.support !== 'supported')
      this.services.log.info('feedback drop: the manager and control deliver feedback');
    this.support = 'supported';
  }

  #unsupported(): void {
    if (this.support !== 'unsupported')
      this.services.log.info(
        'feedback drop: the manager or control does not support it yet; intake stays unavailable',
      );
    this.support = 'unsupported';
  }

  /** One pull now (tests; the loop calls it). Throws the manager's error. */
  pull(): Promise<PullSummary> {
    return pullOnce(this.services, this.manager, this.keys).then((summary) => {
      this.#supported();
      this.#pendingLast = summary.pending > 0 || summary.retry > 0;
      return summary;
    });
  }

  #schedulePull(delayMs: number): void {
    if (!this.#started || this.#closed || !this.enabled) return;
    if (this.#pullTimer) clearTimeout(this.#pullTimer);
    this.#pullTimer = setTimeout(() => {
      this.#pullTimer = null;
      void this.#pullTick();
    }, delayMs);
    this.#pullTimer.unref?.();
  }

  async #pullTick(): Promise<void> {
    if (this.#pulling || this.#closed) return;
    // Look again later unless a step below decides otherwise, so a failed database read never ends the loop.
    let next: number | null = this.#timings.recheckMs;
    this.#pulling = (async () => {
      try {
        if (this.services.maintenance.paused || !(await this.options.claimed())) return null;
        // Idle without a published card and nothing pending: a sync that publishes one wakes the loop.
        if (!this.#pendingLast && !(await this.#hasPublished())) {
          next = null;
          return null;
        }
        const summary = await this.pull();
        this.#pullReach.ok();
        this.#pullBackoff = 0;
        next = summary.nextPullS * 1000;
        return summary;
      } catch (err) {
        if (dropUnsupported(err)) this.#unsupported();
        else if (managerUnreachable(err)) this.#pullReach.failed(err, { step: 'pull' });
        else
          this.services.log.warn({ err: String(err).slice(0, 200) }, 'feedback drop: pull failed; retrying');
        this.#pullBackoff = this.#backoff(this.#pullBackoff);
        next = this.#pullBackoff;
        return null;
      }
    })().finally(() => {
      this.#pulling = null;
      if (next !== null) this.#schedulePull(next);
    });
    await this.#pulling;
  }

  async #hasPublished(): Promise<boolean> {
    const [row] = await this.services.db
      .select({ site: feedbackDropSites.siteId })
      .from(feedbackDropSites)
      .where(isNotNull(feedbackDropSites.publishedAt))
      .limit(1);
    return !!row;
  }

  // --- Reporter statuses (FR-10) ----------------------------------------------------------------------------

  /** A report of a signed-in reporter changed: publish soon (debounced). A no-op before `start` or with the module off. */
  requestReporterPublish(delayMs = this.#timings.syncDebounceMs): void {
    if (!this.#started || this.#closed || !this.enabled) return;
    if (this.#reportersTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.#reportersTimer);
    }
    this.#reportersTimer = setTimeout(() => {
      this.#reportersTimer = null;
      void this.publishReportersNow();
    }, delayMs);
    this.#reportersTimer.unref?.();
  }

  /**
   * Publishes every marked report now, in batches (concurrent calls share one run; a call during a run runs another
   * after it). Null when there was nothing to do yet (not claimed, paused) or it failed; failures retry with backoff,
   * 1 min → 1 h, and an unsupported manager or control (501, 404) is retried at that pace too.
   */
  publishReportersNow(): Promise<ReporterPublishSummary | null> {
    if (this.#publishing) {
      this.#publishAgain = true;
      return this.#publishing;
    }
    this.#publishing = this.#publishReporters().finally(() => {
      this.#publishing = null;
      if (this.#publishAgain) {
        this.#publishAgain = false;
        // After a failure the backoff timer is already set: a change during the run waits for it.
        if (!this.#publishFailed) this.requestReporterPublish(0);
      }
    });
    return this.#publishing;
  }

  async #publishReporters(): Promise<ReporterPublishSummary | null> {
    this.#publishFailed = false;
    const summary: ReporterPublishSummary = { updates: 0, removals: 0, batches: 0 };
    try {
      // Unclaimed, nothing can have been filed; quarantined or drained, look again soon (like the pull).
      if (!(await this.options.claimed())) return null;
      // Not before control accepted this process's first card sync; that sync asks for a run.
      if (!this.#cardsSynced) return null;
      if (this.services.maintenance.paused) {
        this.requestReporterPublish(this.#timings.recheckMs);
        return null;
      }
      for (let i = 0; i < REPORTER_BATCHES_PER_RUN; i++) {
        const batch = await publishReporterBatch(this.services, this.manager);
        if (batch.updates + batch.removals === 0) break;
        summary.updates += batch.updates;
        summary.removals += batch.removals;
        summary.batches++;
        if (!batch.more) break;
        if (i === REPORTER_BATCHES_PER_RUN - 1) this.#publishAgain = true;
      }
      if (this.reportersSupport !== 'supported' && summary.batches)
        this.services.log.info('feedback reporters: control takes reporter statuses');
      if (summary.batches) this.reportersSupport = 'supported';
      this.#reportersBackoff = 0;
      return summary;
    } catch (err) {
      if (dropUnsupported(err)) {
        if (this.reportersSupport !== 'unsupported')
          this.services.log.info(
            'feedback reporters: the manager or control does not take reporter statuses yet; retrying later',
          );
        this.reportersSupport = 'unsupported';
      } else
        this.services.log.warn(
          { err: String(err).slice(0, 200) },
          'feedback reporters: statuses not published; retrying',
        );
      this.#publishFailed = true;
      this.#reportersBackoff = this.#backoff(this.#reportersBackoff);
      // The backoff replaces whatever a change asked for during the run (its report stays marked).
      if (this.#reportersTimer) clearTimeout(this.#reportersTimer);
      this.#reportersTimer = null;
      this.requestReporterPublish(this.#reportersBackoff);
      return null;
    }
  }

  /** The hourly check (FD-08, FD-11, FD-24): old keys and outcomes go; cards are re-issued when due. */
  async check(): Promise<void> {
    try {
      await this.keys.sweep();
      await sweepOutcomes(this.services);
      if (this.enabled && (await syncDue(this.services, this.keys, FEEDBACK_CARD_REISSUE_S)))
        this.requestSync(0);
      if (this.enabled && !this.#reportersTimer && (await reportersPending(this.services)))
        this.requestReporterPublish(0);
    } catch (err) {
      this.services.log.warn({ err: String(err).slice(0, 200) }, 'feedback drop: hourly check failed');
    }
  }
}
