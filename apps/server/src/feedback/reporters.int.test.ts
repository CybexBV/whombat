/**
 * The navigation trail and the integration's visitor switches (docs/decisions/feedback-reporters.md FR-03, FR-04): the
 * switches are stored and published in the site card's config, the trail is kept sanitized with the integration's
 * `redactPaths` (or dropped when switched off, refused above 10) and answered as `submitted.trail`. Reporter sign-in
 * runs through control (`drop/reporters.int.test.ts`).
 */
import { api, buildPath, type FeedbackIntegration, type FeedbackReport } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { feedbackIntegrations, feedbackReports } from '../db/schema/index';
import {
  createIntegration,
  filed,
  fileReport,
  IDS,
  integrationSettings,
  SITE_ORIGIN,
  submission,
} from '../test/feedback';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { updateFeedbackIntegration } from './integrations';
import { publicConfigOf } from './submission';

const t = useTestServer({ seed: true });

let integration: FeedbackIntegration;
let site: string;
let other: FeedbackIntegration;
let mara: string;

/** The config the site card carries to the widget (`drop/cards.ts`). */
async function configOf(id: string) {
  const [row] = await t.services.db
    .select()
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.id, id));
  if (!row) throw new Error('no integration');
  return publicConfigOf(row.settings, { mail: true });
}

async function reportRow(reference: string) {
  const [row] = await t.services.db
    .select()
    .from(feedbackReports)
    .where(eq(feedbackReports.reference, reference));
  if (!row) throw new Error(`no report ${reference}`);
  return row;
}

async function getReport(id: string): Promise<FeedbackReport> {
  const res = await t.api.inject({
    method: 'GET',
    url: `${api.feedback.getReport.base}${buildPath(api.feedback.getReport.path, { burrow: 'burrow-hq', id })}`,
    headers: { cookie: mara },
  });
  expect(res.statusCode).toBe(200);
  return res.json().report;
}

async function setSettings(id: string, over: Parameters<typeof integrationSettings>[0]) {
  const [row] = await t.services.db
    .select()
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.id, id));
  const res = await t.commit(IDS.mara, updateFeedbackIntegration, {
    integrationId: id,
    revision: row?.revision ?? 0,
    settings: integrationSettings({ ...over }),
  });
  expect(res.status).toBe('ok');
}

const TRAIL = [
  { url: `${SITE_ORIGIN}/pricing?utm=mail#plans`, title: 'Pricing', at: '2026-09-30T10:00:00.000Z' },
  { url: `${SITE_ORIGIN}/customers/acme/invoices`, title: 'Invoices\u0007', at: '2026-09-30T10:05:00.000Z' },
  { url: 'javascript:alert(1)', title: 'Nope', at: '2026-09-30T10:06:00.000Z' },
  {
    url: `${SITE_ORIGIN}/orders/550e8400-e29b-41d4-a716-446655440000`,
    title: null,
    at: '2026-09-30T10:08:00.000Z',
  },
];

beforeAll(async () => {
  integration = await createIntegration(t);
  site = integration.siteId;
  other = await createIntegration(t, { name: 'Docs', allowedOrigins: ['https://docs.lumio.example'] });
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

describe('the integration’s switches and the card’s config (FR-03)', () => {
  it('both default to on, are stored and published', async () => {
    expect(integration).toMatchObject({ trail: 'on', reporterSignIn: 'on' });
    expect(await configOf(integration.id)).toMatchObject({ trail: true, reporters: true });
  });

  it('settings saved before contracts 0.25 (no switches) read as on', async () => {
    const [row] = await t.services.db
      .select()
      .from(feedbackIntegrations)
      .where(eq(feedbackIntegrations.id, other.id));
    if (!row) throw new Error('no integration');
    const { trail: _t, reporterSignIn: _r, ...old } = row.settings;
    await t.services.db
      .update(feedbackIntegrations)
      .set({ settings: old as typeof row.settings })
      .where(eq(feedbackIntegrations.id, other.id));
    expect(await configOf(other.id)).toMatchObject({ trail: true, reporters: true });
  });

  it('switched off, the config says so', async () => {
    await setSettings(other.id, {
      name: 'Docs',
      allowedOrigins: ['https://docs.lumio.example'],
      trail: 'off',
      reporterSignIn: 'off',
    });
    expect(await configOf(other.id)).toMatchObject({ trail: false, reporters: false });
  });
});

describe('the navigation trail (FR-04)', () => {
  it('is kept sanitized with the integration’s redactPaths and answered as submitted.trail', async () => {
    const sub = submission({
      context: { ...submission().context, sentAt: '2026-09-30T10:10:00.000Z', trail: TRAIL },
    });
    const res = await filed(t, site, sub);
    const row = await reportRow(res.reference);
    expect(row.context?.trail).toEqual([
      { url: `${SITE_ORIGIN}/pricing`, title: 'Pricing', at: '2026-09-30T10:00:00.000Z' },
      { url: `${SITE_ORIGIN}/customers/:id/invoices`, title: 'Invoices', at: '2026-09-30T10:05:00.000Z' },
      { url: `${SITE_ORIGIN}/orders/:id`, title: null, at: '2026-09-30T10:08:00.000Z' },
    ]);
    const report = await getReport(row.id);
    expect(report.submitted.trail).toEqual(row.context?.trail);
    // Never inside `context`: a 0.24 client parses it strictly and would refuse the whole report.
    expect(Object.keys(report.submitted.context)).not.toContain('trail');
    expect(report.submitted.reporter.verified).toBe(false);
  });

  it('a report without one answers an empty trail', async () => {
    const res = await filed(t, site, submission());
    const report = await getReport((await reportRow(res.reference)).id);
    expect(report.submitted.trail).toEqual([]);
  });

  it('is dropped when the integration’s trail is off', async () => {
    const res = await filed(
      t,
      other.siteId,
      submission({
        parentOrigin: 'https://docs.lumio.example',
        context: { ...submission().context, trail: TRAIL },
      }),
    );
    const row = await reportRow(res.reference);
    expect(row.context).not.toHaveProperty('trail');
  });

  it('more than 10 steps are refused before the schema', async () => {
    const steps = Array.from({ length: 11 }, (_, i) => ({
      url: `${SITE_ORIGIN}/p${i}`,
      title: null,
      at: '2026-09-30T10:00:00.000Z',
    }));
    const res = await fileReport(t, site, submission({ context: { ...submission().context, trail: steps } }));
    expect(res).toEqual({ outcome: 'refused', code: 'invalid', fields: ['context.trail'] });
  });
});
