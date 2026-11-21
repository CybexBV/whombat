/**
 * An assessment through the real runner (in process, the scripted Hermes, over HTTP): the scripted agent has no
 * assessment to give, so its turn ends with its canned reply — posted inert in the report thread through the
 * restricted `reply_in_thread` — and the report fails honestly (docs/decisions/feedback.md FB-21, FB-23).
 */
import { CANNED_REPLY } from '@whombat/agent-runtime/testing/hermes';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatches, feedbackReports, messages } from '../db/schema/index';
import { createIntegration, IDS, submitReport } from '../test/feedback';
import { useTestServer } from '../test/harness';
import { startTestRunner, type TestRunner, waitFor } from '../test/runner';
import { SCRIPTED_ENV } from '../test/scripted';
import { NO_SUBMISSION_REASON } from './assessment';
import { inertReply } from './render';

// Turns on the scripted Hermes run without a sign-in, as `pnpm dev` allows (HE-S174).
const t = useTestServer({ seed: true, listen: true, env: { ...SCRIPTED_ENV } });
let runner: TestRunner;
let site: string;

beforeAll(async () => {
  site = (await createIntegration(t)).siteId;
  runner = await startTestRunner(t.baseUrl, { thinkMs: 20 });
});

afterAll(async () => {
  await runner?.stop();
});

async function settled(reportId: string) {
  return waitFor(
    async () => {
      const [row] = await t.services.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.id, reportId));
      return row && row.assessmentState !== 'running' && row.assessmentState !== 'queued' ? row : null;
    },
    15_000,
    'the assessment to settle',
  );
}

async function thread(rootId: string) {
  return t.services.db
    .select()
    .from(messages)
    .where(eq(messages.threadRootId, rootId))
    .orderBy(asc(messages.ord));
}

describe('the scripted Hermes', () => {
  it('ends without an assessment: its reply stays in the thread, inert, and the report fails honestly', async () => {
    const report = await submitReport(t, site);
    expect((await t.services.feedback.runPending()).started).toBe(1);
    const row = await settled(report.id);
    expect(row).toMatchObject({
      assessmentState: 'failed',
      assessmentReason: NO_SUBMISSION_REASON,
      assessment: null,
    });
    const [d] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, row.assessmentDispatchId as string));
    expect(d).toMatchObject({ state: 'done', trigger: 'feedback' });
    const replies = await thread(report.rootMessageId);
    const reply = replies.find((m) => m.authorId === IDS.dusty);
    expect(reply).toMatchObject({ mentions: [], threadRootId: report.rootMessageId });
    // Inert plain text, marked as the assessor's output (review-2 F1, F2).
    expect(reply?.text).toBe(inertReply(CANNED_REPLY));
    expect(reply?.provenance).toBe('feedback_assessment');
    // The runner's outcome: done, posted through the restricted tool, no push.
    const outcome = await waitFor(
      () => runner.outcomes.find((o) => o.dispatchId === d?.id)?.outcome,
      5000,
      'the runner’s outcome',
    );
    expect(outcome).toMatchObject({ outcome: 'done', posted: true });
    expect(outcome?.pushes).toBeUndefined();
  });
});
