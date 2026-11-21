/**
 * Writes to a tracker by a step marked running (report-trackers.md TA-11…TA-13, TA-25…TA-28): an assessment and
 * priority, or a reply to the customer, each with the step's request id, which the tracker replays — so a step a
 * crashed process left running is simply sent again.
 */
import { type AutomationStep, trackerNothingToWriteText } from '@whombat/core';
import { externalEffect } from '../../commit/scope';
import { tokenRefused, trackerConnectionRow, trackerWords } from '../../trackers/connection';
import { SourceProblem, TrackerNotFound, TrackerRefusal } from '../../trackers/errors';
import { fixUnderWay, sendReply } from '../../trackers/reply';
import { sendWrite } from '../../trackers/write';
import { keyDecision, publisherCheck } from '../authority';
import { stepRoomsCheck } from '../steps';
import type { AutomationStepRow } from '../store';
import { approvedBranchRequest } from '../workspace';
import { failure, type LeasedRun } from './step-ops';

/**
 * A `tracker_update` step marked running (report-trackers.md TA-11…TA-13): the authority once more (the publisher,
 * the rooms, the automation's “Update reports” for the connection — or the approval a person gave for this
 * attempt), then the write with the step's request id. Values the tracker already has aren't sent (nothing to send
 * skips the step; after an earlier send they count as written). A 4xx fails the step with the tracker's words — a
 * 401/403 also marks the connection (TA-03) — and no answer or a 5xx is retried as the step's limits say: the same
 * request id is replayed.
 */
export async function writeToTracker(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: Extract<AutomationStep, { kind: 'tracker_update' }>,
  resend: boolean,
): Promise<void> {
  const { services, run } = lease;
  const db = services.db;
  const out = row.output as {
    connectionId?: string;
    connection?: string;
    reportId?: string;
    number?: number;
    write?: { assessment?: string | null; priority?: string | null };
    requestId?: string;
    writeApprovalId?: string;
    agent?: string;
  };
  const refuse = (error: string) =>
    lease.commit({ op: 'settle', idx: row.idx, state: 'blocked', error, from: ['running'] });
  const who = await publisherCheck(db, run.burrowId, run.publishedById);
  if (!who.ok) return void (await refuse(who.reason));
  const rooms = await stepRoomsCheck(db, run, row.idx, who.publisher);
  if (!rooms.ok) return void (await refuse(rooms.reason));
  const decision = await keyDecision(db, await lease.principal(), who.publisher, 'report.update', {
    connection: step.connectionId,
  });
  const approved =
    decision.outcome === 'allow' ||
    (decision.outcome === 'ask' &&
      !!out.writeApprovalId &&
      (await approvedBranchRequest(db, out.writeApprovalId, run.id, step, row.attempt)));
  const label = out.connection ?? 'the tracker';
  if (!approved || !out.reportId || !out.requestId || !out.write)
    return void (await refuse(`It may no longer write to ${label}.`));
  const connection = await trackerConnectionRow(db, run.burrowId, step.connectionId);
  if (!connection) return void (await refuse('Its tracker connection is gone.'));
  const write = {
    assessment: (out.write.assessment ?? null) as
      | 'likely_bug'
      | 'feature_request'
      | 'needs_information'
      | 'duplicate'
      | null,
    priority: (out.write.priority ?? null) as 'urgent' | 'high' | 'normal' | 'low' | null,
  };
  const target = {
    connectionId: connection.id,
    connection: connection.label,
    reportId: out.reportId,
    number: out.number ?? 0,
  };
  try {
    const done = await externalEffect(
      'tracker.write',
      () =>
        sendWrite(
          services.tracker.driverFor(connection),
          out.reportId as string,
          write,
          out.requestId as string,
          resend,
        ),
      { idempotent: true },
    );
    if ('unchanged' in done) {
      const reason = trackerNothingToWriteText(
        'unchanged',
        out.agent ?? 'The agent',
        trackerWords(services, connection).product,
      );
      await lease.commit({
        op: 'settle',
        idx: row.idx,
        state: 'skipped',
        error: reason,
        output: { ...target, wrote: false, reason },
        from: ['running'],
      });
      return;
    }
    await lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'succeeded',
      output: { ...target, wrote: true, assessment: done.sent.assessment, priority: done.sent.priority },
      from: ['running'],
    });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 900);
    if (err instanceof SourceProblem && err.code === 'refused') {
      // The token is refused (TA-03): the connection is marked when its check is refused too. Not retried.
      await tokenRefused(services, connection.id);
      await lease.commit({
        op: 'settle',
        idx: row.idx,
        state: 'failed',
        error: message,
        from: ['running'],
      });
      return;
    }
    if (err instanceof TrackerRefusal || err instanceof TrackerNotFound) {
      await lease.commit({
        op: 'settle',
        idx: row.idx,
        state: 'failed',
        error: `${label} refused it: ${message}`.slice(0, 1000),
        from: ['running'],
      });
      return;
    }
    // No answer, a 5xx or a second 409: retried with the same request id, which the tracker replays if it got there.
    await lease.commit(failure(row, step, message));
  }
}

/**
 * A `tracker_reply` step marked running (report-trackers.md TA-25…TA-28): the authority once more (the publisher, the
 * rooms, the automation's “Reply to customers” for the connection — or the approval a person gave for this attempt,
 * which a reply with something to check and a test run's always need), then the reply with the step's request id and
 * the status `trackerReplyStatus` gives against the tracker's status now. A 4xx fails the step with the tracker's words
 * — a 401/403 also marks the connection (TA-03) — and no answer or a 5xx is retried as the step's limits say: the same
 * request id is replayed, so the customer gets it once.
 */
export async function replyOnTracker(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: Extract<AutomationStep, { kind: 'tracker_reply' }>,
): Promise<void> {
  const { services, run } = lease;
  const db = services.db;
  const out = row.output as {
    connection?: string;
    reportId?: string;
    number?: number;
    message?: string;
    asks?: boolean;
    closes?: boolean;
    solved?: boolean;
    duplicateOf?: string;
    decisionStatus?: string;
    mustAsk?: boolean;
    requestId?: string;
    replyApprovalId?: string;
  };
  const refuse = (error: string) =>
    lease.commit({ op: 'settle', idx: row.idx, state: 'blocked', error, from: ['running'] });
  const who = await publisherCheck(db, run.burrowId, run.publishedById);
  if (!who.ok) return void (await refuse(who.reason));
  const rooms = await stepRoomsCheck(db, run, row.idx, who.publisher);
  if (!rooms.ok) return void (await refuse(rooms.reason));
  const label = out.connection ?? 'the tracker';
  if (!out.reportId || !out.requestId || typeof out.message !== 'string')
    return void (await refuse(`It may no longer reply to customers in ${label}.`));
  const decision = await keyDecision(db, await lease.principal(), who.publisher, 'report.reply', {
    connection: step.connectionId,
  });
  const approved =
    !!out.replyApprovalId &&
    decision.outcome !== 'deny' &&
    (await approvedBranchRequest(db, out.replyApprovalId, run.id, step, row.attempt));
  // Without a person's yes, only a reply the key lets go on its own, with nothing to check, outside a test run (the
  // step noted which when it planned it: `mustAsk`).
  const unasked = decision.outcome === 'allow' && out.mustAsk === false;
  if (!approved && !unasked) return void (await refuse(`It may no longer reply to customers in ${label}.`));
  const connection = await trackerConnectionRow(db, run.burrowId, step.connectionId);
  if (!connection) return void (await refuse('Its tracker connection is gone.'));
  const target = {
    connectionId: connection.id,
    connection: connection.label,
    reportId: out.reportId,
    number: out.number ?? 0,
  };
  // Closing is decided again as it goes out (TA-54): a fix that started meanwhile keeps the report open.
  const closes =
    out.closes === true &&
    !(await fixUnderWay(
      db,
      connection.id,
      out.reportId,
      run.id,
      typeof out.number === 'number' ? out.number : 0,
    ));
  try {
    const done = await externalEffect(
      'tracker.write',
      () =>
        sendReply(
          services.tracker.driverFor(connection),
          out.reportId as string,
          {
            message: out.message as string,
            asks: out.asks === true,
            closes,
            solved: closes && out.solved === true,
            ...(out.duplicateOf && closes ? { duplicateOf: out.duplicateOf } : {}),
            ...(out.decisionStatus ? { status: out.decisionStatus } : {}),
          },
          out.requestId as string,
        ),
      { idempotent: true },
    );
    await lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'succeeded',
      output: { ...target, sent: true, message: out.message, status: done.status },
      from: ['running'],
    });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 900);
    if (err instanceof SourceProblem && err.code === 'refused') {
      // The token is refused (TA-03): the connection is marked when its check is refused too. Not retried.
      await tokenRefused(services, connection.id);
      await lease.commit({
        op: 'settle',
        idx: row.idx,
        state: 'failed',
        error: message,
        from: ['running'],
      });
      return;
    }
    if (err instanceof TrackerRefusal || err instanceof TrackerNotFound) {
      await lease.commit({
        op: 'settle',
        idx: row.idx,
        state: 'failed',
        error: `${label} refused it: ${message}`.slice(0, 1000),
        from: ['running'],
      });
      return;
    }
    // No answer, a 5xx or a second 409: retried with the same request id, which the tracker replays if it got there.
    await lease.commit(failure(row, step, message));
  }
}
