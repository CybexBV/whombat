/**
 * Whombat Feedback fixtures: every value parses against its core schema, and `createFixtureFetch()` serves
 * `api.feedback.*` as the contracts describe (reads validate, writes commit, stale revisions conflict).
 */
import { api, FeedbackIntegrationHealth } from '@whombat/core/contracts';
import { FeedbackIntegration, FeedbackReport, reportCardLabel, reportCardState } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_REPORTS,
  feedbackDropNotPublishedWarning,
  feedbackHealth,
  feedbackIntegration,
  feedbackManagedHealth,
  reportCardOf,
  reportFailed,
  reportFeature,
  reportLikelyBug,
  reportRemoved,
} from './feedback.js';
import { createFixtureFetch } from './fetch.js';

const BASE = 'http://fixtures.local/api/v1/burrows/burrow-hq/feedback';

async function call(fetchFn: typeof fetch, path: string, method = 'GET', body?: unknown) {
  const res = await fetchFn(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function settingsOf(integration: FeedbackIntegration) {
  const {
    id: _id,
    siteId: _siteId,
    intake: _intake,
    assessment: _assessment,
    revision: _revision,
    configHash: _configHash,
    createdById: _createdById,
    createdAt: _createdAt,
    updatedById: _updatedById,
    updatedAt: _updatedAt,
    ...settings
  } = integration;
  return settings;
}

describe('feedback fixtures', () => {
  it('parse, and every report went to Mara’s Feedback room', () => {
    for (const r of FEEDBACK_REPORTS) {
      expect(FeedbackReport.parse(r).conversationId).toBe('cnv_feedback-mara');
      expect(r.intake.conversationId).toBe('cnv_feedback-mara');
    }
    expect(FeedbackIntegration.parse(feedbackIntegration)).toMatchObject({
      conversationId: 'cnv_feedback-mara',
      chat: { id: 'cnv_feedback-mara' },
      handoff: 'on',
    });
  });

  it('give each report state its card line', () => {
    expect(FEEDBACK_REPORTS.map((r) => reportCardState(reportCardOf(r)))).toEqual([
      'Burrow Billing · Triaged · Likely bug',
      'Burrow Billing · New · Assessment queued',
      'Burrow Billing · New · Assessment failed',
      'Burrow Billing · Closed · Likely bug',
      'Burrow Billing · New · Feature request',
    ]);
    expect(reportCardLabel(reportCardOf(reportLikelyBug))).toBe('BUG REPORT · FB-7K3Q-9M2X');
    expect(reportCardOf(reportRemoved)).toMatchObject({ contentRemoved: true, summary: '', attachments: 0 });
  });
});

describe('createFixtureFetch() feedback endpoints', () => {
  it('reads validate against the contracts; unknown ids 404', async () => {
    const f = createFixtureFetch();
    const list = await call(f, '/integrations');
    expect(() => api.feedback.listIntegrations.response.parse(list.body)).not.toThrow();
    const detail = await call(f, `/integrations/${feedbackIntegration.id}`);
    expect(() => api.feedback.getIntegration.response.parse(detail.body)).not.toThrow();
    const report = await call(f, `/reports/${reportLikelyBug.id}`);
    expect(() => api.feedback.getReport.response.parse(report.body)).not.toThrow();
    expect((await call(f, '/reports/fbr_nope')).status).toBe(404);
    expect((await call(f, '/integrations/fbi_nope')).status).toBe(404);
  });

  it('creates an integration and refuses invalid settings with field paths', async () => {
    const f = createFixtureFetch();
    const bad = await call(f, '/integrations', 'POST', {
      ...settingsOf(feedbackIntegration),
      allowedOrigins: ['https://ok.example', 'ftp://nope'],
    });
    expect(bad.status).toBe(400);
    expect(Object.keys((bad.body.error as { fields: object }).fields)).toEqual(['allowedOrigins.1']);
    const ok = await call(f, '/integrations', 'POST', { ...settingsOf(feedbackIntegration), name: 'Docs' });
    expect(ok.status).toBe(201);
    // Reports of a new integration land in Mara's Feedback room.
    expect(ok.body.integration).toMatchObject({
      conversationId: 'cnv_feedback-mara',
      chat: { id: 'cnv_feedback-mara' },
    });
    const list = await call(f, '/integrations');
    expect((list.body.integrations as unknown[]).length).toBe(2);
  });

  it('updates with the revision the editor started from, and conflicts on a stale one', async () => {
    const f = createFixtureFetch();
    const path = `/integrations/${feedbackIntegration.id}`;
    const settings = { ...settingsOf(feedbackIntegration), name: 'Billing' };
    const stale = await call(f, path, 'PUT', { revision: 1, settings });
    expect(stale.status).toBe(409);
    const ok = await call(f, path, 'PUT', { revision: feedbackIntegration.revision, settings });
    expect(ok.status).toBe(200);
    expect(ok.body.integration).toMatchObject({
      name: 'Billing',
      revision: feedbackIntegration.revision + 1,
    });
  });

  it('changes status, retries a failed assessment, asks for a handoff and removes content', async () => {
    const f = createFixtureFetch();
    const status = await call(f, `/reports/${reportLikelyBug.id}/status`, 'POST', { status: 'resolved' });
    expect(status.body.report).toMatchObject({ status: 'resolved' });
    expect((await call(f, `/reports/${reportLikelyBug.id}/retry`, 'POST', {})).status).toBe(409);
    const retry = await call(f, `/reports/${reportFailed.id}/retry`, 'POST', {});
    expect(retry.body.report).toMatchObject({ assessment: { state: 'queued' } });
    const handoff = await call(f, `/reports/${reportLikelyBug.id}/handoff`, 'POST', { note: '' });
    expect(handoff.body.report).toMatchObject({ handoff: { approvalNumber: 13 } });
    const assessed = await call(f, `/reports/${reportFeature.id}`);
    expect(assessed.body.can).toMatchObject({ handoff: true });
    const removed = await call(f, `/reports/${reportLikelyBug.id}/redact`, 'POST', {});
    const report = FeedbackReport.parse(removed.body.report);
    expect(report.contentRemovedAt).not.toBeNull();
    expect(report.submitted.description).toBe('');
    expect(report.submitted.attachments).toEqual([]);
  });
});

describe('building fixes (handoff)', () => {
  it('is refused while the integration has it switched off', async () => {
    const f = createFixtureFetch();
    const path = `/integrations/${feedbackIntegration.id}`;
    const settings = { ...settingsOf(feedbackIntegration), handoff: 'off' };
    const off = await call(f, path, 'PUT', { revision: feedbackIntegration.revision, settings });
    expect(off.body.integration).toMatchObject({ handoff: 'off', conversationId: 'cnv_feedback-mara' });
    const report = await call(f, `/reports/${reportLikelyBug.id}`);
    expect(report.body.can).toMatchObject({ handoff: false });
    const refused = await call(f, `/reports/${reportLikelyBug.id}/handoff`, 'POST', { note: '' });
    expect(refused.status).toBe(409);
  });
});

describe('managed feedback health (drop mode)', () => {
  it('parses, and self-hosted health has no delivery', () => {
    expect(FeedbackIntegrationHealth.parse(feedbackHealth).delivery).toBeNull();
    expect(FeedbackIntegrationHealth.parse(feedbackManagedHealth).delivery?.expired7d).toBe(2);
    expect(
      FeedbackIntegrationHealth.parse({
        ...feedbackManagedHealth,
        warnings: [feedbackDropNotPublishedWarning],
      }).warnings[0]?.code,
    ).toBe('drop_not_published');
  });
});
