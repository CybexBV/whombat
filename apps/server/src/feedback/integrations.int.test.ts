/**
 * Feedback configuration authority and the internal REST surface (docs/decisions/feedback.md FB-16 … FB-19, FB-25):
 * only the person configures; reports go to their own Feedback room with the agent (one-agent.md OA-16, OA-S31), whose
 * health says when the agent can't assess; switched-on repos only, optimistic revisions; a report is for the person
 * whose room it is in; removal clears content and screenshots and keeps the audit chain verifiable.
 */
import { api, buildPath, type FeedbackIntegration, type FeedbackReport } from '@whombat/core';
import { and, count, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBurrowChain } from '../audit/verify';
import {
  attachments,
  conversations,
  events,
  feedbackReports,
  messages,
  principals,
} from '../db/schema/index';
import { attachmentOf, filed, IDS, integrationSettings, submission } from '../test/feedback';
import { makePng } from '../test/files';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import {
  createFeedbackIntegration,
  setFeedbackAssessment,
  setFeedbackIntake,
  updateFeedbackIntegration,
} from './integrations';

const t = useTestServer({ seed: true, app: true });
const BURROW = 'burrow-hq';

function url(ep: { base: string; path: string }, params: Record<string, string>) {
  return `${ep.base}${buildPath(ep.path, { burrow: BURROW, ...params })}`;
}

let cookies: Record<'mara', string>;

async function commitError(actor: string, input: unknown) {
  return t
    .commit(actor, createFeedbackIntegration, input as never)
    .then(() => null)
    .catch((err: { code?: string; status?: number; extra?: { fields?: Record<string, string[]> } }) => err);
}

beforeAll(async () => {
  cookies = {
    mara: (await sessionFor(t.services, IDS.mara)).cookie,
  };
});

describe('configuration authority (FB-18)', () => {
  it('reports go to the saver’s own Feedback room, with the agent in it', async () => {
    const res = await t.commit(IDS.mara, createFeedbackIntegration, integrationSettings({ name: 'Where' }));
    if (res.status !== 'ok') throw new Error(res.status);
    expect(res.result.chat).toEqual({ id: res.result.conversationId });
    const [room] = await t.services.db
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(eq(conversations.id, res.result.conversationId));
    expect(room?.kind).toBe('dm');
  });

  it('an agent on a local model is saved, and the health says it can’t assess (one-agent.md OA-S31)', async () => {
    const [before] = await t.services.db
      .select({ runtime: principals.runtime })
      .from(principals)
      .where(eq(principals.id, IDS.dusty));
    const warningsWith = async (runtime: Record<string, string>) => {
      await t.services.db
        .update(principals)
        .set({ runtime: runtime as never })
        .where(eq(principals.id, IDS.dusty));
      const res = await t.commit(IDS.mara, createFeedbackIntegration, integrationSettings());
      if (res.status !== 'ok') throw new Error(res.status);
      const detail = await t.api.inject({
        method: 'GET',
        url: url(api.feedback.getIntegration, { id: res.result.id }),
        headers: { cookie: cookies.mara },
      });
      return detail.json().health.warnings.map((w: { code: string }) => w.code) as string[];
    };
    try {
      expect(await warningsWith({ provider: 'local' })).toContain('agent_unsupported_provider');
    } finally {
      await t.services.db
        .update(principals)
        .set({ runtime: before?.runtime as never })
        .where(eq(principals.id, IDS.dusty));
    }
  });

  it('a switched-off repository is refused', async () => {
    const err = await commitError(IDS.mara, integrationSettings({ repoId: 'rep_web' }));
    expect(err?.extra?.fields?.repoId?.[0]).toMatch(/switched on/);
  });

  it('an update from a stale revision is a 409; each change is a signed Keys event with the config hash', async () => {
    const res = await t.commit(IDS.mara, createFeedbackIntegration, integrationSettings());
    if (res.status !== 'ok') throw new Error(res.status);
    const created = res.result;
    expect(created.siteId).toMatch(/^fbs_[A-Za-z0-9]{24}$/);
    expect(created.revision).toBe(1);
    const next = await t.commit(IDS.mara, updateFeedbackIntegration, {
      integrationId: created.id,
      revision: 1,
      settings: integrationSettings({ productLabel: 'Lumio 2' }),
    });
    if (next.status !== 'ok') throw new Error(next.status);
    expect(next.result.revision).toBe(2);
    expect(next.result.configHash).not.toBe(created.configHash);
    const stale = await t
      .commit(IDS.mara, updateFeedbackIntegration, {
        integrationId: created.id,
        revision: 1,
        settings: integrationSettings(),
      })
      .catch((e: { status: number }) => e);
    expect((stale as { status: number }).status).toBe(409);
    const signed = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'feedback.integration_updated'));
    expect(signed.at(-1)?.kind).toBe('Keys');
    expect(signed.at(-1)?.payload).toMatchObject({
      integrationId: created.id,
      revision: 2,
      configHash: next.result.configHash,
    });
    expect(JSON.stringify(signed.at(-1)?.payload)).not.toContain('billing portal');
  });
});

describe('REST: integrations are the person’s (FB-17)', () => {
  let integration: FeedbackIntegration;

  beforeAll(async () => {
    const res = await t.api.inject({
      method: 'POST',
      url: url(api.feedback.createIntegration, {}),
      headers: { cookie: cookies.mara },
      payload: integrationSettings({ name: 'Via REST' }),
    });
    expect(res.statusCode).toBe(201);
    integration = res.json().integration;
  });

  it('the person lists and gets them with snippets and health', async () => {
    const list = await t.api.inject({
      method: 'GET',
      url: url(api.feedback.listIntegrations, {}),
      headers: { cookie: cookies.mara },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().can).toEqual({ manage: true });
    expect(list.json().integrations.map((i: { integration: { id: string } }) => i.integration.id)).toContain(
      integration.id,
    );
    const detail = await t.api.inject({
      method: 'GET',
      url: url(api.feedback.getIntegration, { id: integration.id }),
      headers: { cookie: cookies.mara },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.snippets.basic).toContain(`data-site="${integration.siteId}"`);
    expect(body.snippets.basic).toContain('/embed/v1/widget.js');
    expect(body.snippets.csp).toContain('frame-src');
    const codes = body.health.warnings.map((w: { code: string }) => w.code);
    // No runtime here to publish its site card through the manager.
    expect(codes).toContain('drop_not_published');
  });

  it('intake and assessment switches; health shows them', async () => {
    const off = await t.api.inject({
      method: 'POST',
      url: url(api.feedback.setIntake, { id: integration.id }),
      headers: { cookie: cookies.mara },
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().integration.intake).toBe('disabled');
    const paused = await t.api.inject({
      method: 'POST',
      url: url(api.feedback.setAssessment, { id: integration.id }),
      headers: { cookie: cookies.mara },
      payload: { active: false },
    });
    expect(paused.json().integration.assessment).toBe('paused');
    const detail = await t.api.inject({
      method: 'GET',
      url: url(api.feedback.getIntegration, { id: integration.id }),
      headers: { cookie: cookies.mara },
    });
    const codes = detail.json().health.warnings.map((w: { code: string }) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['intake_disabled', 'assessment_paused']));
  });

  it('pausing parks queued reports; resuming queues them again', async () => {
    const res = await t.commit(
      IDS.mara,
      createFeedbackIntegration,
      integrationSettings({ name: 'Pausable' }),
    );
    if (res.status !== 'ok') throw new Error(res.status);
    const live = res.result;
    const sent = await filed(t, live.siteId, submission());
    expect(sent.created).toBe(true);
    const ref = sent.reference;
    const state = async () =>
      (await t.services.db.select().from(feedbackReports).where(eq(feedbackReports.reference, ref)))[0]
        ?.assessmentState;
    expect(await state()).toBe('queued');
    await t.commit(IDS.mara, setFeedbackAssessment, { integrationId: live.id, active: false });
    expect(await state()).toBe('paused');
    const whilePaused = await filed(t, live.siteId, submission());
    const [row] = await t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.reference, whilePaused.reference));
    expect(row?.assessmentState).toBe('paused');
    await t.commit(IDS.mara, setFeedbackAssessment, { integrationId: live.id, active: true });
    expect(await state()).toBe('queued');
    const [after] = await t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.id, row?.id ?? ''));
    expect(after?.assessmentState).toBe('queued');
    await t.commit(IDS.mara, setFeedbackIntake, { integrationId: live.id, enabled: false });
  });

  it('retry and handoff answer like the other report endpoints (the workflow: assessment/handoff tests)', async () => {
    const [row] = await t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.assessmentState, 'queued'))
      .limit(1);
    for (const ep of [api.feedback.retryAssessment, api.feedback.requestHandoff]) {
      const post = (cookie: string) =>
        t.api.inject({
          method: 'POST',
          url: url(ep, { id: row?.id ?? 'fbr_x' }),
          headers: { cookie },
          payload: {},
        });
      // Not failed / not assessed yet: a conflict, never a silent success.
      expect((await post(cookies.mara)).statusCode).toBe(409);
    }
  });
});

describe('REST: a report is for the person whose Feedback room it is in', () => {
  let report: FeedbackReport;

  beforeAll(async () => {
    const res = await t.commit(IDS.mara, createFeedbackIntegration, integrationSettings({ name: 'Reports' }));
    if (res.status !== 'ok') throw new Error(res.status);
    const sent = await filed(
      t,
      res.result.siteId,
      submission({ attachments: [attachmentOf(makePng(16, 16), 'image/png')] }),
    );
    expect(sent.created).toBe(true);
    const [row] = await t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.reference, sent.reference));
    const got = await t.api.inject({
      method: 'GET',
      url: url(api.feedback.getReport, { id: row?.id ?? '' }),
      headers: { cookie: cookies.mara },
    });
    expect(got.statusCode).toBe(200);
    report = got.json().report;
    expect(got.json().can).toEqual({
      setStatus: true,
      retry: false,
      handoff: false,
      redact: true,
      decide: false,
    });
  });

  it('they get the report with what was submitted, kept apart from the assessment', async () => {
    expect(report.submitted.description).toBe('The invoice total is off by a cent.');
    expect(report.submitted.reporter).toEqual({
      name: 'Ada Visitor',
      email: 'ada@example.com',
      verified: false,
    });
    expect(report.submitted.attachments).toHaveLength(1);
    expect(report.assessment).toMatchObject({
      state: 'queued',
      attempts: 0,
      result: null,
    });
    expect(report.attempts).toEqual([]);
  });

  it('they change the status; the card follows', async () => {
    const res = await t.api.inject({
      method: 'POST',
      url: url(api.feedback.setReportStatus, { id: report.id }),
      headers: { cookie: cookies.mara },
      payload: { status: 'triaged' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.status).toBe('triaged');
    const msg = await t.api.inject({
      method: 'GET',
      url: url(api.messages.get, { messageId: report.rootMessageId }),
      headers: { cookie: cookies.mara },
    });
    expect(msg.json().message.card).toMatchObject({ kind: 'report', status: 'triaged' });
  });

  it('the person removes the content: text, contact, context and screenshots go; the audit chain still verifies', async () => {
    const fileId = report.submitted.attachments[0]?.id as string;
    const res = await t.api.inject({
      method: 'POST',
      url: url(api.feedback.redactReport, { id: report.id }),
      headers: { cookie: cookies.mara },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const after = res.json().report as FeedbackReport;
    expect(after.contentRemovedAt).not.toBeNull();
    expect(after.submitted).toMatchObject({
      description: '',
      expected: '',
      steps: '',
      reporter: { name: null, email: null },
      attachments: [],
    });
    expect(after.submitted.context.page).toBeNull();
    expect(after.reference).toBe(report.reference);
    expect(after.status).toBe('triaged');
    const [file] = await t.services.db
      .select({ n: count() })
      .from(attachments)
      .where(eq(attachments.id, fileId));
    expect(file?.n).toBe(0);
    const [root] = await t.services.db.select().from(messages).where(eq(messages.id, report.rootMessageId));
    expect(root?.attachmentIds).toEqual([]);
    expect(root?.text).toBe(`Bug report ${report.reference} · Lumio`);
    const download = await t.api.inject({
      method: 'GET',
      url: report.submitted.attachments[0]?.url as string,
      headers: { cookie: cookies.mara },
    });
    expect(download.statusCode).toBe(404);
    const msg = await t.api.inject({
      method: 'GET',
      url: url(api.messages.get, { messageId: report.rootMessageId }),
      headers: { cookie: cookies.mara },
    });
    expect(msg.json().message.card).toMatchObject({ contentRemoved: true, summary: '', attachments: 0 });
    const [redacted] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'feedback.report_redacted'), eq(events.burrowId, t.burrowId)));
    expect(redacted?.payload).toMatchObject({ reportId: report.id, reason: 'owner' });
    const chain = await verifyBurrowChain(t.services.db, t.burrowId);
    expect(chain.failures).toEqual([]);
    expect(chain.ok).toBe(true);
  });

  it('the retention sweep removes content once retentionDays passed, signed by the Feedback principal', async () => {
    const res = await t.commit(
      IDS.mara,
      createFeedbackIntegration,
      integrationSettings({ name: 'Retained', retentionDays: 7 }),
    );
    if (res.status !== 'ok') throw new Error(res.status);
    const fresh = await filed(t, res.result.siteId, submission());
    const old = await filed(t, res.result.siteId, submission());
    const [oldRow] = await t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.reference, old.reference));
    // Test setup only: age one report past the retention period.
    await t.services.db
      .update(feedbackReports)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 3_600_000) })
      .where(eq(feedbackReports.id, oldRow?.id ?? ''));
    expect(await t.services.feedback.sweepRetention()).toBe(1);
    const rows = await t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.integrationId, res.result.id));
    const byRef = new Map(rows.map((r) => [r.reference, r]));
    expect(byRef.get(old.reference)?.contentRemovedAt).not.toBeNull();
    expect(byRef.get(old.reference)?.description).toBe('');
    expect(byRef.get(fresh.reference)?.contentRemovedAt).toBeNull();
    const [signed] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'feedback.report_redacted'))
      .orderBy(events.seq);
    expect(signed).toBeTruthy();
    expect((await verifyBurrowChain(t.services.db, t.burrowId)).ok).toBe(true);
  });
});
