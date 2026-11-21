/**
 * Regression tests for docs/implementation/feedback/review-1.md (security review 1): each finding's
 * proof-of-concept scenario, asserting the fixed behaviour. Findings tested elsewhere name their tests in the
 * review's “Resolution” section.
 */
import { performance } from 'node:perf_hooks';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachments, feedbackReports } from '../db/schema/index';
import type { Services } from '../services';
import {
  attachmentOf,
  createIntegration,
  filed,
  fileReport,
  jpegClaiming,
  makeJpeg,
  newSubmissionId,
  submission,
} from '../test/feedback';
import { makePng } from '../test/files';
import { useTestServer } from '../test/harness';
import { FeedbackService } from './service';

const t = useTestServer({ seed: true });
let site: string;
const generousLimits = { reportsPerHour: 1000, reportsPerDay: 10_000, perSourcePerHour: 100 };

beforeAll(async () => {
  // Default attachment limits (3 × 3 MB → a ~12.6 MB body cap); generous rate limits so the tests don't trip them.
  site = (
    await createIntegration(t, {
      limits: { reportsPerHour: 1000, reportsPerDay: 10_000, perSourcePerHour: 100 },
    })
  ).siteId;
});

describe('R1-1: a hostile submission is refused by its structure before the schema sees it', () => {
  const head = () => ({
    submissionId: newSubmissionId(),
    parentOrigin: 'https://app.lumio.example',
    type: 'bug',
    description: 'x',
  });

  it('a few references too many name the field, as the schema would', async () => {
    const res = await fileReport(
      t,
      site,
      submission({ context: { references: ['a', 'b', 'c', 'd', 'e', 'f'] } }),
    );
    expect(res).toEqual({ outcome: 'refused', code: 'invalid', fields: ['context.references'] });
  });

  it('100k references, deep nesting, many keys and long strings are refused, in well under a second', async () => {
    for (const extra of [
      { context: { references: new Array(100_000).fill(0) } },
      { context: { custom: { a: JSON.parse(`${'['.repeat(10)}${']'.repeat(10)}`) } } },
      { context: { custom: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 1])) } },
      { steps: 'x'.repeat(20_000) },
    ]) {
      const started = performance.now();
      const res = await fileReport(t, site, { ...head(), ...extra });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(res).toMatchObject({ outcome: 'refused', code: 'invalid' });
    }
  });

  it('an ordinary submission still goes through', async () => {
    expect((await fileReport(t, site, submission())).outcome).toBe('filed');
  });
});

describe('R1-2: a retry of the same submission gets its receipt whenever it was sent', () => {
  it('the same submissionId with a later sentAt is a duplicate with the same receipt', async () => {
    const submissionId = newSubmissionId();
    const first = submission({ submissionId });
    const firstRes = await fileReport(t, site, {
      ...first,
      context: { ...first.context, sentAt: '2026-09-25T10:00:00.000Z' },
    });
    expect(firstRes.outcome).toBe('filed');
    // The receipt was lost; the visitor presses “Try again” 31 s later (an older widget builds sentAt again).
    const retry = await fileReport(t, site, {
      ...first,
      context: { ...first.context, sentAt: '2026-09-25T10:00:31.000Z' },
    });
    expect(retry).toEqual({ ...firstRes, outcome: 'duplicate' });
    // Different content under the same id is still a conflict.
    const edited = await fileReport(t, site, { ...first, description: 'Something else entirely.' });
    expect(edited).toMatchObject({ outcome: 'refused', code: 'conflict' });
  });
});

describe('R1-3: image work off the event loop, the daily cap before decoding', () => {
  afterEach(() => vi.restoreAllMocks());
  const generous = { reportsPerHour: 1000, reportsPerDay: 10_000, perSourcePerHour: 100 };
  const withShot = () => submission({ attachments: [attachmentOf(makePng(4, 4), 'image/png')] });

  it('a 16 MP screenshot is decoded while the event loop keeps running', async () => {
    const png = makePng(4000, 4000);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = performance.now();
    const res = await fileReport(t, site, submission({ attachments: [attachmentOf(png, 'image/png')] }));
    const elapsed = performance.now() - started;
    clearInterval(timer);
    expect(res.outcome).toBe('filed');
    // Blocked, a 10 ms timer fires about once; free, about elapsed / 10 times.
    expect(ticks).toBeGreaterThan((elapsed / 10) * 0.4);
  }, 60_000);

  it('once the daily cap is reached, a report with screenshots is refused before any image work', async () => {
    const capped = await createIntegration(t, {
      name: 'Daily cap',
      limits: { ...generous, reportsPerDay: 1 },
    });
    expect((await fileReport(t, capped.siteId, submission())).outcome).toBe('filed');
    const run = vi.spyOn(t.services.feedback.images, 'run');
    const res = await fileReport(t, capped.siteId, withShot());
    expect(res).toEqual({ outcome: 'refused', code: 'rate_limited', retryAfter: 3600 });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('R1-5: every JPEG the header check admits (up to 16 MP) decodes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a 5120×2880 (14.7 MP) JPEG screenshot is accepted and re-encoded', async () => {
    const jpg = makeJpeg(5120, 2880);
    expect(jpg.length).toBeLessThan(3 * 1024 * 1024);
    const res = await filed(
      t,
      site,
      submission({ attachments: [attachmentOf(jpg, 'image/jpeg', 'screen.jpg')] }),
    );
    const [row] = await t.services.db
      .select({ ids: feedbackReports.attachmentIds })
      .from(feedbackReports)
      .where(eq(feedbackReports.reference, res.reference));
    const [file] = await t.services.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, row?.ids[0] ?? ''));
    expect(file).toMatchObject({
      contentType: 'image/jpeg',
      width: 5120,
      height: 2880,
      name: 'screenshot-1.jpg',
    });
  }, 60_000);

  it('a JPEG over 16 MP (4200×4100) is refused from its header, before anything is decoded', async () => {
    const run = vi.spyOn(t.services.feedback.images, 'run');
    const res = await fileReport(
      t,
      site,
      submission({ attachments: [attachmentOf(jpegClaiming(makeJpeg(16, 16), 4200, 4100), 'image/jpeg')] }),
    );
    expect(res).toEqual({ outcome: 'refused', code: 'unsupported_attachment', fields: ['attachments.0'] });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('R1-4: WHOMBAT_FEEDBACK=off stops intake, not the retention sweep', () => {
  it('start() with the module off still removes content past retentionDays', async () => {
    const retained = await createIntegration(t, { name: 'Retained while off', retentionDays: 7 });
    const res = await filed(t, retained.siteId, submission());
    // Test setup only: age the report past its retention period.
    await t.services.db
      .update(feedbackReports)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 3_600_000) })
      .where(eq(feedbackReports.reference, res.reference));
    const off = new FeedbackService({
      ...t.services,
      config: { ...t.services.config, WHOMBAT_FEEDBACK: 'off' },
    } as Services);
    off.start();
    // close() waits for the sweep start() began.
    await off.close();
    const [row] = await t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.reference, res.reference));
    expect(row?.contentRemovedAt).not.toBeNull();
    expect(row?.description).toBe('');
  });
});

describe('R1-7: a refusal at the daily cap reveals neither the limits nor other reports’ timing', () => {
  it('the daily cap answers a fixed hour, however long ago the oldest report arrived', async () => {
    const capped = await createIntegration(t, {
      name: 'Daily',
      limits: { ...generousLimits, reportsPerDay: 1 },
    });
    const first = await filed(t, capped.siteId, submission());
    // Test setup only: the only report of the window arrived 23 h 59 min ago (it would free up in a minute).
    await t.services.db
      .update(feedbackReports)
      .set({ createdAt: new Date(Date.now() - (24 * 60 - 1) * 60_000) })
      .where(eq(feedbackReports.reference, first.reference));
    const plain = await fileReport(t, capped.siteId, submission());
    const withShot = await fileReport(
      t,
      capped.siteId,
      submission({ attachments: [attachmentOf(makePng(4, 4), 'image/png')] }),
    );
    for (const res of [plain, withShot])
      expect(res).toEqual({ outcome: 'refused', code: 'rate_limited', retryAfter: 3600 });
  });
});
