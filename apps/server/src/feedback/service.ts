/**
 * Whombat Feedback's long-lived parts in the server process (docs/decisions/feedback.md): the image worker, the
 * assessment worker's wake-up (`nudge`) and the hourly retention sweep.
 */
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { feedbackIntegrations, feedbackReports } from '../db/schema/index';
import type { Services } from '../services';
import { FeedbackAssessor, type PassResult } from './assessor';
import type { FeedbackDropService } from './drop/index';
import { handoffGuard, reconcileHandoff, START_HANDOFF } from './handoff';
import { ImagePool } from './image-pool';
import { feedbackPrincipal } from './principal';
import { redactFeedbackReport } from './reports';

const RETENTION_INTERVAL_MS = 3_600_000;

export class FeedbackService {
  /** One image decode at a time in this process, in a worker thread (FB-08, FB-F02). */
  readonly images = new ImagePool({
    onWorkerFailure: (info) => this.services.log.warn(info, 'feedback image worker failed'),
  });
  /**
   * Test seams: `beforeIntakeCommit` runs inside the intake transaction after everything is written (a throw rolls
   * it back, as a crash would).
   */
  readonly faults: {
    beforeIntakeCommit?: () => void | Promise<void>;
    /** Runs inside the start of an assessment, after the dispatch and the attempt are written. */
    beforeAssessmentStartCommit?: () => void | Promise<void>;
  } = {};
  #timer: NodeJS.Timeout | null = null;
  #sweeping: Promise<number> | null = null;
  /** The assessment worker (FB-20): starts queued assessments and settles ended ones. */
  readonly assessor: FeedbackAssessor;
  /**
   * The encrypted drop that delivers widget reports (docs/decisions/feedback-drop.md), set by the managed runtime;
   * null until it is, and in tests that don't need it.
   */
  drop: FeedbackDropService | null = null;

  constructor(readonly services: Services) {
    this.assessor = new FeedbackAssessor(services);
    // The development handoff (FB-24): revalidated right before an approved one runs; a crash mid-run is reconciled.
    services.approvals.addGuard(handoffGuard);
    services.approvals.setReconciler(START_HANDOFF, (_approval, row) => reconcileHandoff(services, row));
  }

  /**
   * Starts the background work (the server's `index.ts`; tests drive it by hand). The retention sweep runs even with
   * `WHOMBAT_FEEDBACK=off` (FB-F05): turning the module off stops the public surface, never the removal of content
   * already stored.
   */
  start(): void {
    // The assessment worker: a pass every 15 s and soon after every nudge. It runs whatever WHOMBAT_FEEDBACK says
    // (FB-01, review-2 F8): `off` closes only the public surface, and assessments already queued or running must
    // still be started, settled and timed out.
    if (!this.onNudge) {
      this.onNudge = () => this.assessor.kick();
      this.assessor.start();
    }
    // Connected systems (FBS-03): polled with the rest of Feedback's background work, never in a read-only start.
    if (this.#timer) return;
    const run = () =>
      void this.sweepRetention().catch((err) =>
        this.services.log.warn({ err: String(err) }, 'feedback retention sweep failed'),
      );
    this.#timer = setInterval(run, RETENTION_INTERVAL_MS);
    this.#timer.unref?.();
    run();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.onNudge = null;
    await this.assessor.close();
    await this.images.close();
    await this.#sweeping?.catch(() => {});
  }

  /** One pass of the assessment worker now (tests; the server runs them from `start`). */
  runPending(): Promise<PassResult> {
    return this.assessor.pass();
  }

  /** An assessment's dispatch ended for good (the runtime's `afterFinal`): settle its report now. */
  dispatchEnded(
    dispatchId: string,
    state: 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'cancelled',
    error: string | undefined,
    refusal: string | undefined,
  ): Promise<void> {
    return this.assessor.dispatchEnded(dispatchId, state, error, refusal);
  }

  /** Something may be ready to assess (a report arrived, assessment resumed). The assessment worker listens. */
  nudge(): void {
    this.onNudge?.();
  }

  /** The assessment worker's wake-up, set by `start` (tests run passes by hand with `runPending`). */
  onNudge: (() => void) | null = null;

  /** An integration was created or changed (after the commit): a managed Whombat re-publishes its cards (FD-11). */
  configChanged(): void {
    this.drop?.requestSync();
  }

  /** A report of a signed-in reporter changed (after the commit): a managed Whombat tells control soon (FR-10). */
  reportersChanged(): void {
    this.drop?.requestReporterPublish();
  }

  // --- Retention (FB-25) -----------------------------------------------------------------------------------

  /** Removes the content of every report past its integration's `retentionDays` (one pass; concurrent calls share it). */
  sweepRetention(): Promise<number> {
    this.#sweeping ??= this.#sweepRetention().finally(() => {
      this.#sweeping = null;
    });
    return this.#sweeping;
  }

  async #sweepRetention(): Promise<number> {
    const db = this.services.db;
    const now = this.services.clock();
    const due = await db
      .select({ id: feedbackReports.id, burrowId: feedbackReports.burrowId })
      .from(feedbackReports)
      .innerJoin(feedbackIntegrations, eq(feedbackIntegrations.id, feedbackReports.integrationId))
      .where(
        and(
          isNull(feedbackReports.contentRemovedAt),
          isNotNull(sql`${feedbackIntegrations.settings}->'retentionDays'`),
          sql`jsonb_typeof(${feedbackIntegrations.settings}->'retentionDays') = 'number'`,
          lt(
            feedbackReports.createdAt,
            sql`${now.toISOString()}::timestamptz - make_interval(days => (${feedbackIntegrations.settings}->>'retentionDays')::int)`,
          ),
        ),
      )
      .limit(500);
    let removed = 0;
    for (const report of due) {
      const actorId = await feedbackPrincipal(this.services, report.burrowId);
      const res = await this.services.pipeline.commit(
        redactFeedbackReport,
        { reportId: report.id },
        { burrowId: report.burrowId, actorId },
      );
      if (res.status === 'ok' && res.result.removed) removed++;
    }
    if (removed) this.services.log.info({ removed }, 'feedback retention removed report content');
    return removed;
  }
}
