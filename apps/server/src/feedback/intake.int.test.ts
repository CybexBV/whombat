/**
 * Whombat Feedback intake end to end (docs/decisions/feedback.md FB-02, FB-08 … FB-15; feedback-drop.md FD-23): a
 * submission filed as an opened drop is filed (`fileReport`) becomes one report, one root message by the Feedback
 * principal and its screenshots — re-encoded, readable only in the person's Feedback room — with nothing else created
 * and nothing the visitor wrote able to mention, dispatch or leak.
 */
import { randomBytes } from 'node:crypto';
import { api, buildPath, type FeedbackIntegration, type Message } from '@whombat/core';
import { count, eq } from 'drizzle-orm';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  accounts,
  attachments,
  dispatches,
  events,
  feedbackReports,
  messages,
  principals,
} from '../db/schema/index';
import {
  attachmentOf,
  createIntegration,
  type Filing,
  filed,
  fileReport,
  GIF,
  HTML,
  IDS,
  makeJpeg,
  newSubmissionId,
  pngClaiming,
  pngWithMetadata,
  SITE_ORIGIN,
  SVG,
  submission,
} from '../test/feedback';
import { makePng } from '../test/files';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { findFeedbackPrincipal } from './principal';

const t = useTestServer({ seed: true });

let integration: FeedbackIntegration;
let site: string;
let mara: string;

async function counts() {
  const db = t.services.db;
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  return {
    accounts: await n(db.select({ n: count() }).from(accounts)),
    people: await n(db.select({ n: count() }).from(principals).where(eq(principals.kind, 'person'))),
    principals: await n(db.select({ n: count() }).from(principals)),
    dispatches: await n(db.select({ n: count() }).from(dispatches)),
    reports: await n(db.select({ n: count() }).from(feedbackReports)),
  };
}

async function report(reference: string) {
  const [row] = await t.services.db
    .select()
    .from(feedbackReports)
    .where(eq(feedbackReports.reference, reference));
  if (!row) throw new Error(`no report ${reference}`);
  return row;
}

async function rootMessage(messageId: string, cookie: string): Promise<Message> {
  const res = await t.api.inject({
    method: 'GET',
    url: `${api.messages.get.base}${buildPath(api.messages.get.path, { burrow: 'burrow-hq', messageId })}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { message: Message }).message;
}

/** A refusal's details. */
function refusal(res: Filing) {
  if (res.outcome !== 'refused') throw new Error(`not refused: ${res.outcome}`);
  return res;
}

beforeAll(async () => {
  integration = await createIntegration(t);
  site = integration.siteId;
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

describe('script-free intake', () => {
  it('a bug with a PNG: one report, one root message by the Feedback principal, a screenshot only members read', async () => {
    const before = await counts();
    const png = pngWithMetadata(makePng(40, 30), 'SECRET-PNG-METADATA');
    const receipt = await filed(
      t,
      site,
      submission({ attachments: [attachmentOf(png, 'image/png', '../../etc/passwd.png')] }),
    );
    expect(receipt.created).toBe(true);

    const row = await report(receipt.reference);
    expect(row.type).toBe('bug');
    expect(row.assessmentState).toBe('queued');
    expect(row.intake).toMatchObject({
      revision: 1,
      configHash: integration.configHash,
      conversationId: integration.conversationId,
      repoId: 'rep_billing',
      configuredById: IDS.mara,
    });
    // Server-side sanitizing: no query or fragment, `/customers/*` redacted, only allowlisted custom keys.
    expect(row.context?.page?.url).toBe(`${SITE_ORIGIN}/customers/:id/invoices`);
    expect(row.context?.custom).toEqual({ plan: 'pro' });
    expect(row.reporterEmail).toBe('ada@example.com');

    const feedbackId = await findFeedbackPrincipal(t.services.db, t.burrowId);
    expect(feedbackId).toBeTruthy();
    const root = await rootMessage(row.rootMessageId, mara);
    expect(root.authorId).toBe(feedbackId);
    expect(root.text).toBe(`Bug report ${receipt.reference} · Lumio`);
    expect(root.mentions).toEqual([]);
    expect(root.card).toMatchObject({
      kind: 'report',
      reportId: row.id,
      reference: receipt.reference,
      product: 'Lumio',
      type: 'bug',
      summary: 'The invoice total is off by a cent.',
      status: 'new',
      assessment: { state: 'queued', outcome: null, summary: null },
      attachments: 1,
      contentRemoved: false,
    });
    expect(root.attachments).toHaveLength(1);
    const shot = root.attachments[0];
    expect(shot).toMatchObject({
      name: 'screenshot-1.png',
      contentType: 'image/png',
      kind: 'image',
      width: 40,
    });

    // Readable in the Feedback room; not without a session.
    const url = shot?.url as string;
    const ok = await t.api.inject({ method: 'GET', url, headers: { cookie: mara } });
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.includes(Buffer.from('SECRET-PNG-METADATA'))).toBe(false);
    expect(ok.rawPayload.includes(Buffer.from('<script>'))).toBe(false);
    const decoded = PNG.sync.read(ok.rawPayload);
    expect([decoded.width, decoded.height]).toEqual([40, 30]);
    expect((await t.api.inject({ method: 'GET', url })).statusCode).not.toBe(200);

    // Only the Feedback principal was added: no accounts, people or dispatches.
    const after = await counts();
    expect(after.accounts).toBe(before.accounts);
    expect(after.people).toBe(before.people);
    expect(after.principals).toBe(before.principals + 1);
    expect(after.dispatches).toBe(before.dispatches);
    expect(after.reports).toBe(before.reports + 1);

    // The signed receipt carries ids, sizes and hashes, never the visitor's words.
    const [signed] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'feedback.report_received'));
    const payload = JSON.stringify(signed?.payload);
    expect(payload).toContain(row.id);
    expect(payload).not.toContain('off by a cent');
    expect(payload).not.toContain('ada@example.com');
    expect(payload).not.toContain('Ada Visitor');
  });

  it('a screenshot over 1 MiB is filed', async () => {
    const noise = new PNG({ width: 700, height: 700 });
    noise.data.set(randomBytes(noise.data.length));
    const bytes = PNG.sync.write(noise);
    expect(bytes.length).toBeGreaterThan(1024 * 1024);
    const res = await fileReport(t, site, submission({ attachments: [attachmentOf(bytes, 'image/png')] }));
    expect(res.outcome).toBe('filed');
  });
});

describe('idempotency (FB-10)', () => {
  it('the same submission retried gets the same receipt: one report, one message, no dispatch', async () => {
    const body = submission({ attachments: [attachmentOf(makePng(8, 8), 'image/png')] });
    const first = await fileReport(t, site, body);
    expect(first.outcome).toBe('filed');
    const before = await counts();
    const [messagesBefore] = await t.services.db.select({ n: count() }).from(messages);
    const again = await fileReport(t, site, body);
    expect(again).toEqual({ ...first, outcome: 'duplicate' });
    const after = await counts();
    expect(after).toEqual(before);
    const [messagesAfter] = await t.services.db.select({ n: count() }).from(messages);
    expect(messagesAfter?.n).toBe(messagesBefore?.n);
  });

  it('the same submission id with different content is a conflict without detail', async () => {
    const body = submission();
    expect((await fileReport(t, site, body)).outcome).toBe('filed');
    const res = await fileReport(t, site, { ...body, description: 'Something else entirely.' });
    expect(res).toEqual({ outcome: 'refused', code: 'conflict' });
  });

  it('five concurrent identical submissions make one report', async () => {
    const body = submission({ attachments: [attachmentOf(makePng(12, 12), 'image/png')] });
    const results = await Promise.all(Array.from({ length: 5 }, () => fileReport(t, site, body)));
    expect(results.map((r) => r.outcome).sort()).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
      'filed',
    ]);
    const references = new Set(results.map((r) => (r.outcome === 'refused' ? null : r.reference)));
    expect(references.size).toBe(1);
    const rows = await t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.submissionId, body.submissionId));
    expect(rows).toHaveLength(1);
    const files = await t.services.db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, rows[0]?.rootMessageId as string));
    expect(files).toHaveLength(1);
  });
});

describe('strict submissions (FB-09)', () => {
  it('routing or authorization fields are refused as invalid', async () => {
    for (const field of ['channelId', 'agentId', 'burrowId', 'repoId', 'approved']) {
      const res = await fileReport(t, site, { ...submission(), [field]: field === 'approved' ? true : 'x' });
      expect(res, field).toMatchObject({ outcome: 'refused', code: 'invalid' });
    }
    const nested = await fileReport(t, site, {
      ...submission(),
      context: { ...submission().context, channelId: IDS.general },
    });
    expect(nested).toMatchObject({ outcome: 'refused', code: 'invalid' });
    const missing = await fileReport(t, site, { ...submission(), description: '' });
    expect(missing).toMatchObject({ outcome: 'refused', code: 'invalid' });
    expect(refusal(missing).fields).toContain('description');
  });
});

describe('screenshots are PNG or JPEG, decoded and re-encoded (FB-08)', () => {
  const refused = (bytes: Buffer, type: 'image/png' | 'image/jpeg', name = 'shot.png') =>
    fileReport(t, site, submission({ attachments: [attachmentOf(bytes, type, name)] }));

  it.each([
    ['SVG', SVG, 'image/png'],
    ['HTML', HTML, 'image/png'],
    ['GIF', GIF, 'image/png'],
    ['a truncated PNG', makePng(64, 64).subarray(0, 60), 'image/png'],
    ['a PNG whose header claims 30000×30000', pngClaiming(makePng(1, 1), 30_000, 30_000), 'image/png'],
    ['a PNG over 16 megapixels', pngClaiming(makePng(1, 1), 8000, 8000), 'image/png'],
    ['a JPEG saved as .png', makeJpeg(8, 8), 'image/png'],
    ['a truncated JPEG', makeJpeg(64, 64).subarray(0, 200), 'image/jpeg'],
  ] as const)('%s is refused', async (_what, bytes, type) => {
    const before = await counts();
    const res = await refused(bytes, type);
    expect(res).toEqual({ outcome: 'refused', code: 'unsupported_attachment', fields: ['attachments.0'] });
    expect((await counts()).reports).toBe(before.reports);
  });

  it('a screenshot over the integration’s byte limit is too large', async () => {
    const small = await createIntegration(t, {
      name: 'Small screenshots',
      limits: { maxAttachmentBytes: 64 * 1024, reportsPerHour: 1000, perSourcePerHour: 100 },
    });
    const big = Buffer.concat([makePng(4, 4), Buffer.alloc(70 * 1024)]);
    const res = await fileReport(
      t,
      small.siteId,
      submission({ attachments: [attachmentOf(big, 'image/png')] }),
    );
    expect(res).toMatchObject({ outcome: 'refused', code: 'too_large' });
  });

  it('non-canonical base64 is invalid', async () => {
    const res = await fileReport(
      t,
      site,
      submission({ attachments: [{ name: 'a.png', contentType: 'image/png', data: 'iVBO$$$$' }] }),
    );
    expect(res).toEqual({ outcome: 'refused', code: 'invalid', fields: ['attachments.0.data'] });
  });
});

describe('limits (FB-12)', () => {
  it('the durable daily cap refuses the next report', async () => {
    const capped = await createIntegration(t, {
      name: 'Capped',
      limits: { reportsPerDay: 1, reportsPerHour: 1000, perSourcePerHour: 100 },
    });
    expect((await fileReport(t, capped.siteId, submission())).outcome).toBe('filed');
    const res = await fileReport(t, capped.siteId, submission());
    // Fixed (FB-F07): when the window frees up would reveal when the oldest report arrived.
    expect(res).toEqual({ outcome: 'refused', code: 'rate_limited', retryAfter: 3600 });
  });
});

describe('the visitor’s words are data (FB-15)', () => {
  it('a submission id is never reused across integrations', async () => {
    const other = await createIntegration(t, { name: 'Other' });
    const id = newSubmissionId();
    const a = await filed(t, site, submission({ submissionId: id }));
    const b = await filed(t, other.siteId, submission({ submissionId: id }));
    expect([a.created, b.created]).toEqual([true, true]);
    expect(a.reference).not.toBe(b.reference);
  });
});
