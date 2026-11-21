/**
 * The assessment worker (docs/decisions/feedback.md FB-20, FB-23), driven by `FeedbackService`: an interval, plus a
 * pass soon after every `nudge` (a report arrived, a retry, assessment resumed, an assessment turn ended).
 *
 * Each pass
 * 1. settles running assessments whose dispatch ended (done without an assessment, failed, refused, cancelled), passed
 *    the integration's `assessmentTimeoutMinutes` since a runner first claimed it, or waited `QUEUE_DEADLINE_MS`
 *    without any claim (the dispatch is stopped, like an automation step's deadline) — `feedback.settle_assessment`,
 *    compare-and-set on the report's dispatch id;
 * 2. starts due queued reports: a short lease on the report (`FOR UPDATE SKIP LOCKED` on
 *    `assessment_lease_expires_at`, like `memory_jobs`), then `feedback.start_assessment` as the burrow's Feedback
 *    principal, which re-checks everything under the burrow lock. Two server processes never start the same
 *    assessment: the lease keeps them off each other's report, and the start command only starts a report that is
 *    still `queued` (in one transaction with its dispatch).
 *
 * A crash leaves at most a lease, which expires (`LEASE_MS`); a start that failed releases its lease at once.
 */
import { and, asc, eq, inArray, isNull, lte, notInArray, or } from 'drizzle-orm';
import { outsideCommandScope } from '../commit/scope';
import { dispatches, feedbackAssessments, feedbackIntegrations, feedbackReports } from '../db/schema/index';
import type { Services } from '../services';
import {
  failureReason,
  NO_SUBMISSION_REASON,
  parseRefusedError,
  QUEUE_DEADLINE_MS,
  QUEUE_TIMEOUT_ERROR,
  QUEUE_TIMEOUT_REASON,
  type RefusedOutcome,
  STOPPED_REASON,
  settleAssessment,
  startAssessment,
  TIMEOUT_ERROR,
  timeoutReason,
} from './assessment';
import { feedbackPrincipal } from './principal';

/** How long a worker holds a queued report while it starts it. */
export const LEASE_MS = 60_000;
/** How often the worker passes without a nudge. */
export const PASS_MS = 15_000;
/** Reports started per pass (the rest wait for the next one). */
const STARTS_PER_PASS = 50;

export interface PassResult {
  started: number;
  blocked: number;
  settled: number;
}

type DispatchState = (typeof dispatches.$inferSelect)['state'];

export class FeedbackAssessor {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<PassResult> | null = null;
  #again = false;
  #closed = false;

  constructor(private readonly services: Services) {}

  start(intervalMs = PASS_MS): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => this.kick(), intervalMs);
    this.#timer.unref?.();
    this.kick();
  }

  /** A pass soon (another one after the current, when one is running). Only once started: tests pass by hand. */
  kick(): void {
    if (this.#closed || !this.#timer) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    void this.pass().catch((err) =>
      this.services.log.warn({ err: String(err) }, 'feedback assessment pass failed'),
    );
  }

  /**
   * One pass (concurrent callers share it). Outside any command scope: `kick` comes from commands' `after` hooks, and a
   * pass is the worker's own work, never part of that command (managed-runtime.md MR-06).
   */
  pass(): Promise<PassResult> {
    this.#running ??= outsideCommandScope(() => this.#pass()).finally(() => {
      this.#running = null;
      if (this.#again && !this.#closed) {
        this.#again = false;
        this.kick();
      }
    });
    return this.#running;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => {});
  }

  async #pass(): Promise<PassResult> {
    const settled = await this.reconcileRunning();
    const { started, blocked } = await this.startQueued();
    return { started, blocked, settled };
  }

  // --- Running assessments -------------------------------------------------------------------------------------

  /** Settles running assessments whose turn ended or ran out of time. Returns how many it settled. */
  async reconcileRunning(): Promise<number> {
    const db = this.services.db;
    const now = this.services.clock();
    const rows = await db
      .select({
        report: feedbackReports,
        dispatch: dispatches,
        startedAt: feedbackAssessments.startedAt,
        claimedAt: feedbackAssessments.claimedAt,
        settings: feedbackIntegrations.settings,
      })
      .from(feedbackReports)
      .leftJoin(dispatches, eq(dispatches.id, feedbackReports.assessmentDispatchId))
      .leftJoin(feedbackAssessments, eq(feedbackAssessments.dispatchId, feedbackReports.assessmentDispatchId))
      .leftJoin(feedbackIntegrations, eq(feedbackIntegrations.id, feedbackReports.integrationId))
      .where(eq(feedbackReports.assessmentState, 'running'))
      .orderBy(asc(feedbackReports.assessmentUpdatedAt))
      .limit(200);
    let settled = 0;
    for (const { report, dispatch, startedAt, claimedAt, settings } of rows) {
      const dispatchId = report.assessmentDispatchId;
      if (!dispatchId) continue;
      let reason: string | null = null;
      let cancel = false;
      let cancelError = TIMEOUT_ERROR;
      const refused = parseRefusedError(dispatch?.error);
      if (refused && dispatch && (dispatch.state === 'failed' || dispatch.state === 'cancelled')) {
        if (
          await this.#settle(report.burrowId, report.id, dispatchId, refused.reason, false, refused.outcome)
        )
          settled++;
        continue;
      }
      if (!dispatch) reason = 'The assessment’s turn is gone.';
      else if (dispatch.state === 'done' || dispatch.state === 'failed' || dispatch.state === 'cancelled')
        reason = endedReason(dispatch.state, dispatch.error, null, settings?.limits.assessmentTimeoutMinutes);
      else if (claimedAt) {
        // The timeout counts from the turn's first claim, not from queueing (review-2 F6).
        const minutes = settings?.limits.assessmentTimeoutMinutes ?? 30;
        if (claimedAt.getTime() + minutes * 60_000 <= now.getTime()) {
          reason = timeoutReason(minutes);
          cancel = true;
        }
      } else if (dispatch.state === 'queued') {
        // Never claimed: waiting behind the agent's other turns in the channel, or no runner takes it. (A claimed
        // turn whose context isn't built yet is neither: the settle command re-checks `queued` under its lock.)
        const since = startedAt ?? report.assessmentUpdatedAt;
        if (since.getTime() + QUEUE_DEADLINE_MS <= now.getTime()) {
          reason = QUEUE_TIMEOUT_REASON;
          cancel = true;
          cancelError = QUEUE_TIMEOUT_ERROR;
        }
      }
      if (!reason) continue;
      if (await this.#settle(report.burrowId, report.id, dispatchId, reason, cancel, 'failed', cancelError))
        settled++;
    }
    return settled;
  }

  /**
   * An assessment's dispatch ended for good (`RunnerRuntime.afterFinal`): settle the report now, with the runner's
   * refusal when there was one, instead of at the next pass.
   */
  async dispatchEnded(
    dispatchId: string,
    state: DispatchState,
    error: string | null | undefined,
    refusal: string | null | undefined,
  ): Promise<void> {
    const [row] = await this.services.db
      .select({ report: feedbackReports, settings: feedbackIntegrations.settings })
      .from(feedbackReports)
      .leftJoin(feedbackIntegrations, eq(feedbackIntegrations.id, feedbackReports.integrationId))
      .where(eq(feedbackReports.assessmentDispatchId, dispatchId));
    const refused = parseRefusedError(error);
    if (row && row.report.assessmentState === 'running' && refused)
      await this.#settle(
        row.report.burrowId,
        row.report.id,
        dispatchId,
        refused.reason,
        false,
        refused.outcome,
      );
    else if (row && row.report.assessmentState === 'running') {
      const reason = endedReason(
        state,
        error ?? null,
        refusal ?? null,
        row.settings?.limits.assessmentTimeoutMinutes,
      );
      if (reason) await this.#settle(row.report.burrowId, row.report.id, dispatchId, reason, false);
    }
    this.kick();
  }

  async #settle(
    burrowId: string,
    reportId: string,
    dispatchId: string,
    reason: string,
    cancel: boolean,
    outcome: 'failed' | RefusedOutcome = 'failed',
    cancelError: string = TIMEOUT_ERROR,
  ) {
    const actorId = await feedbackPrincipal(this.services, burrowId);
    const res = await this.services.pipeline.commit(
      settleAssessment,
      {
        reportId,
        dispatchId,
        reason: reason.slice(0, 600),
        outcome,
        cancelDispatch: cancel,
        cancelError,
        // A runner may have claimed it since this pass read it: never cancel a claimed turn as unclaimed.
        onlyIfQueued: cancel && cancelError === QUEUE_TIMEOUT_ERROR,
      },
      { burrowId, actorId },
    );
    return res.status === 'ok' && res.result.settled;
  }

  // --- Queued reports ------------------------------------------------------------------------------------------

  /**
   * Leases the next due queued report, skipping integrations already at their concurrency limit and reports whose
   * start failed in this pass (they are tried again on the next one).
   */
  async #lease(busy: readonly string[], failed: readonly string[]) {
    const now = this.services.clock();
    return this.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .select({
          id: feedbackReports.id,
          burrowId: feedbackReports.burrowId,
          integrationId: feedbackReports.integrationId,
        })
        .from(feedbackReports)
        .where(
          and(
            eq(feedbackReports.assessmentState, 'queued'),
            or(isNull(feedbackReports.assessmentNotBefore), lte(feedbackReports.assessmentNotBefore, now)),
            or(
              isNull(feedbackReports.assessmentLeaseExpiresAt),
              lte(feedbackReports.assessmentLeaseExpiresAt, now),
            ),
            busy.length ? notInArray(feedbackReports.integrationId, [...busy]) : undefined,
            failed.length ? notInArray(feedbackReports.id, [...failed]) : undefined,
          ),
        )
        .orderBy(asc(feedbackReports.createdAt), asc(feedbackReports.id))
        .limit(1)
        .for('update', { skipLocked: true, of: feedbackReports });
      if (!row) return null;
      const lease = new Date(now.getTime() + LEASE_MS);
      await tx
        .update(feedbackReports)
        .set({ assessmentLeaseExpiresAt: lease })
        .where(eq(feedbackReports.id, row.id));
      return { ...row, lease };
    });
  }

  async #release(reportId: string, lease: Date): Promise<void> {
    await this.services.pipeline.transactAccount((tx) =>
      tx
        .update(feedbackReports)
        .set({ assessmentLeaseExpiresAt: null })
        .where(
          and(
            eq(feedbackReports.id, reportId),
            eq(feedbackReports.assessmentLeaseExpiresAt, lease),
            inArray(feedbackReports.assessmentState, ['queued']),
          ),
        ),
    );
  }

  /** Starts (or blocks, pauses, defers) due queued reports. */
  async startQueued(): Promise<{ started: number; blocked: number }> {
    const busy: string[] = [];
    const failed: string[] = [];
    let started = 0;
    let blocked = 0;
    for (let i = 0; i < STARTS_PER_PASS && !this.#closed; i++) {
      const leased = await this.#lease(busy, failed);
      if (!leased) break;
      try {
        const actorId = await feedbackPrincipal(this.services, leased.burrowId);
        const res = await this.services.pipeline.commit(
          startAssessment,
          { reportId: leased.id, lease: leased.lease.toISOString() },
          { burrowId: leased.burrowId, actorId },
        );
        if (res.status !== 'ok') continue;
        const outcome = res.result.outcome;
        if (outcome === 'started') started++;
        else if (outcome === 'blocked') blocked++;
        else if (outcome === 'busy') busy.push(leased.integrationId);
      } catch (err) {
        // Nothing was written (the start is one transaction): the next pass tries it again at once.
        failed.push(leased.id);
        this.services.log.warn(
          { err: String(err), reportId: leased.id },
          'could not start a feedback assessment',
        );
        await this.#release(leased.id, leased.lease).catch(() => {});
      }
    }
    return { started, blocked };
  }
}

/** Why an ended assessment dispatch left no assessment (null: it isn't over). */
function endedReason(
  state: DispatchState,
  error: string | null,
  refusal: string | null,
  timeoutMinutes: number | undefined,
): string | null {
  switch (state) {
    case 'done':
      return NO_SUBMISSION_REASON;
    case 'failed':
      return failureReason(error, refusal);
    case 'cancelled':
      if (error === QUEUE_TIMEOUT_ERROR) return QUEUE_TIMEOUT_REASON;
      return error === TIMEOUT_ERROR ? timeoutReason(timeoutMinutes ?? 30) : STOPPED_REASON;
    default:
      return null;
  }
}
