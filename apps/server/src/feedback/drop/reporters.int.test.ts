/**
 * Signed-in reporters on a managed Whombat (docs/decisions/feedback-reporters.md FR-09, FR-10): control's attestation on
 * a drop marks the report verified only when the sealed address matches its digest; every change of such a report is
 * published to control through the manager in batches, flags cleared only when the row didn't change meanwhile;
 * removed content is a removal; an unsupported manager or control is backed off and retried; a site control holds
 * again gets all its reporters' entries again; the card carries the switches.
 */
import type { FeedbackIntegration } from '@whombat/core';
import { sealDropEnvelope } from '@whombat/core/feedback/drop';
import { newReporterId, reporterEmailDigest } from '@whombat/core/feedback/reporters';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applianceState, feedbackDropSites, feedbackReports } from '../../db/schema/index';
import { ManagerCallError, type ManagerPort } from '../../managed/ports';
import { IDS } from '../../seed/test-world';
import { createIntegration, SITE_ORIGIN, submission } from '../../test/feedback';
import { useManagedRuntime } from '../../test/managed';
import { setFeedbackIntake } from '../integrations';
import { redactFeedbackReport, setFeedbackReportStatus } from '../reports';
import { FeedbackDropService } from './index';
import { publishReporterBatch } from './reporters';

const EMBED = 'https://embed.whombat.test';
const m = useManagedRuntime({ seed: true, env: { WHOMBAT_EMBED_URL: EMBED } });
const drop = () => m.runtime.feedbackDrop;
const control = () => m.manager.feedback;

let integration: FeedbackIntegration;
let site: string;
const reporterId = newReporterId();

async function dropped(
  over: Parameters<typeof submission>[0],
  reporter?: { id: string; emailDigest: string },
) {
  const card = control().cards.get(site)?.card;
  if (!card) throw new Error('no card');
  const sub = submission(over);
  const plaintext = {
    v: 1,
    submission: sub,
    frame: { bridgeOrigin: SITE_ORIGIN, ancestorOrigins: [SITE_ORIGIN], widget: '1.2.0', cardSeq: card.seq },
  };
  control().drop(site, await sealDropEnvelope(card, JSON.stringify(plaintext)), EMBED, reporter);
  expect(await drop().pull()).toMatchObject({ filed: 1 });
  const [row] = await m.t.services.db
    .select()
    .from(feedbackReports)
    .where(eq(feedbackReports.submissionId, sub.submissionId));
  if (!row) throw new Error('not filed');
  return row;
}

async function rowOf(id: string) {
  const [row] = await m.t.services.db.select().from(feedbackReports).where(eq(feedbackReports.id, id));
  if (!row) throw new Error('no report');
  return row;
}

const attestation = (email: string, id = reporterId) => ({
  id,
  emailDigest: reporterEmailDigest(site, email),
});

beforeAll(async () => {
  await m.t.services.db
    .insert(applianceState)
    .values({ id: 1, claimConsumedAt: new Date() })
    .onConflictDoUpdate({ target: applianceState.id, set: { claimConsumedAt: new Date() } });
  integration = await createIntegration(m.t, { reportTypes: ['bug'] });
  site = integration.siteId;
  expect(await drop().syncNow()).toMatchObject({ accepted: [site] });
});

afterEach(() => {
  control().mode = 'ok';
  control().reportersMode = 'ok';
});

describe('the card (FR-03)', () => {
  it('carries the trail and reporter sign-in switches', () => {
    expect(control().cards.get(site)?.card.config).toMatchObject({ trail: true, reporters: true });
  });
});

describe('control’s attestation (FR-09)', () => {
  it('a drop whose sealed address matches the digest is verified and marked for publishing', async () => {
    const row = await dropped(
      { reporter: { name: 'Ada', email: 'Ada@Example.com' } },
      attestation('ada@example.com'),
    );
    expect(row).toMatchObject({
      reporterId,
      reporterVerified: true,
      reporterEmail: 'ada@example.com',
      reporterDirty: true,
    });
  });

  it('a digest of another address, or none, files the report unverified', async () => {
    const other = await dropped(
      { reporter: { name: 'Ada', email: 'ada@example.com' } },
      attestation('mallory@example.com'),
    );
    expect(other).toMatchObject({ reporterId: null, reporterVerified: false, reporterDirty: false });
    const none = await dropped({ reporter: { name: '', email: 'ada@example.com' } });
    expect(none).toMatchObject({ reporterId: null, reporterVerified: false });
    const noEmail = await dropped({ reporter: { name: '', email: '' } }, attestation(''));
    expect(noEmail).toMatchObject({ reporterId: null, reporterVerified: false });
  });
});

describe('publishing statuses (FR-10)', () => {
  it('sends what control keeps (never text) and clears the flags', async () => {
    const summary = await drop().publishReportersNow();
    expect(summary).toMatchObject({ updates: 1, removals: 0, batches: 1 });
    const [sent] = control().reporterPublishes.slice(-1);
    const [row] = await m.t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.reporterId, reporterId));
    expect(sent).toEqual({
      updates: [
        {
          site,
          reporterId,
          reference: row?.reference,
          type: 'bug',
          status: 'received',
          receivedAt: Math.floor((row?.createdAt.getTime() ?? 0) / 1000),
          updatedAt: Math.floor((row?.updatedAt.getTime() ?? 0) / 1000),
        },
      ],
      removals: [],
    });
    expect(JSON.stringify(sent)).not.toContain('invoice');
    expect(row).toMatchObject({ reporterDirty: false });
    expect(row?.reporterPublishedAt).not.toBeNull();
    expect(await drop().publishReportersNow()).toMatchObject({ batches: 0 });
  });

  it('a status change is published; removed content is a removal', async () => {
    const [row] = await m.t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.reporterId, reporterId));
    const id = row?.id ?? '';
    expect(
      (await m.t.commit(IDS.mara, setFeedbackReportStatus, { reportId: id, status: 'triaged' })).status,
    ).toBe('ok');
    expect((await rowOf(id)).reporterDirty).toBe(true);
    await drop().publishReportersNow();
    expect(control().reporterEntries.get(`${site}|${row?.reference}`)).toMatchObject({ status: 'confirmed' });

    expect((await m.t.commit(IDS.mara, redactFeedbackReport, { reportId: id })).status).toBe('ok');
    expect(await drop().publishReportersNow()).toMatchObject({ updates: 0, removals: 1 });
    expect(control().reporterPublishes.at(-1)?.removals).toEqual([{ site, reference: row?.reference }]);
    expect(control().reporterEntries.has(`${site}|${row?.reference}`)).toBe(false);
  });

  it('a report changed while its batch was on the way stays marked', async () => {
    const row = await dropped({}, attestation('ada@example.com'));
    const fake = m.manager;
    const original = fake.feedbackReporters.bind(fake);
    fake.feedbackReporters = async (request) => {
      await m.t.commit(IDS.mara, setFeedbackReportStatus, { reportId: row.id, status: 'in_progress' });
      return original(request);
    };
    try {
      await publishReporterBatch(m.t.services, m.manager);
    } finally {
      fake.feedbackReporters = original;
    }
    expect((await rowOf(row.id)).reporterDirty).toBe(true);
    await drop().publishReportersNow();
    expect((await rowOf(row.id)).reporterDirty).toBe(false);
    expect(control().reporterEntries.get(`${site}|${row.reference}`)).toMatchObject({
      status: 'in_progress',
    });
  });

  it('batches: at most the maximum per request, the rest in the next', async () => {
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(await dropped({}, attestation('ada@example.com')));
    const first = await publishReporterBatch(m.t.services, m.manager, 2);
    expect(first).toEqual({ updates: 2, removals: 0, more: true });
    expect(control().reporterPublishes.at(-1)?.updates).toHaveLength(2);
    const second = await publishReporterBatch(m.t.services, m.manager, 2);
    expect(second).toEqual({ updates: 1, removals: 0, more: false });
    const left = await m.t.services.db
      .select({ dirty: feedbackReports.reporterDirty })
      .from(feedbackReports)
      .where(
        inArray(
          feedbackReports.id,
          rows.map((r) => r.id),
        ),
      );
    expect(left.every((r) => !r.dirty)).toBe(true);
  });

  it('an unsupported manager or control is backed off; the reports stay marked until it takes them', async () => {
    const row = await dropped({}, attestation('ada@example.com'));
    for (const mode of [501, 404] as const) {
      control().reportersMode = mode;
      expect(await drop().publishReportersNow()).toBeNull();
      expect(drop().reportersSupport).toBe('unsupported');
      expect((await rowOf(row.id)).reporterDirty).toBe(true);
    }
    control().reportersMode = 503;
    expect(await drop().publishReportersNow()).toBeNull();
    expect((await rowOf(row.id)).reporterDirty).toBe(true);
    control().reportersMode = 'ok';
    expect(await drop().publishReportersNow()).toMatchObject({ updates: 1 });
    expect(drop().reportersSupport).toBe('supported');
    expect((await rowOf(row.id)).reporterDirty).toBe(false);
  });

  it('a site control holds again gets every reporter entry again', async () => {
    const off = await m.t.commit(IDS.mara, setFeedbackIntake, {
      integrationId: integration.id,
      enabled: false,
    });
    expect(off.status).toBe('ok');
    await drop().syncNow();
    expect(control().cards.has(site)).toBe(false);
    // Control deletes a withdrawn site's entries (control).
    for (const key of [...control().reporterEntries.keys()])
      if (key.startsWith(`${site}|`)) control().reporterEntries.delete(key);

    await m.t.commit(IDS.mara, setFeedbackIntake, { integrationId: integration.id, enabled: true });
    const outcome = await drop().syncNow();
    expect(outcome?.accepted).toEqual([site]);
    expect(outcome?.reportersMarked).toBeGreaterThan(0);
    await drop().publishReportersNow();
    const live = await m.t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.reporterId, reporterId));
    const kept = live.filter((r) => !r.contentRemovedAt);
    for (const r of kept) expect(control().reporterEntries.has(`${site}|${r.reference}`)).toBe(true);
    // A sync that only re-issues the card marks nothing.
    expect((await drop().syncNow())?.reportersMarked).toBe(0);
  });

  it('a site whose last card expired before this sync gets every reporter entry again (FR-12)', async () => {
    await drop().publishReportersNow();
    await m.t.services.db
      .update(feedbackDropSites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(feedbackDropSites.siteId, site));
    const outcome = await drop().syncNow();
    expect(outcome?.accepted).toEqual([site]);
    expect(outcome?.reportersMarked).toBeGreaterThan(0);
    expect(await drop().publishReportersNow()).toMatchObject({ batches: 1 });
  });
});

describe('a fresh process (FR-12, FR-19)', () => {
  it('publishes nothing before control accepted its first card sync', async () => {
    await dropped({}, attestation('ada@example.com'));
    const fresh = new FeedbackDropService(m.t.services, m.manager, { claimed: async () => true });
    const before = control().reporterPublishes.length;
    try {
      expect(await fresh.publishReportersNow()).toBeNull();
      expect(control().reporterPublishes.length).toBe(before);
      expect(await fresh.syncNow()).toMatchObject({ accepted: [site] });
      expect(await fresh.publishReportersNow()).toMatchObject({ updates: 1 });
    } finally {
      await fresh.close();
    }
  });

  it('a change during a failed run doesn’t cut the backoff short', async () => {
    const calls: number[] = [];
    let fresh: FeedbackDropService | null = null;
    const manager: ManagerPort = Object.assign(Object.create(Object.getPrototypeOf(m.manager)), m.manager, {
      feedbackReporters: async () => {
        calls.push(Date.now());
        fresh?.requestReporterPublish();
        throw new ManagerCallError(
          '/v1/runtime/feedback/reporters',
          503,
          'unavailable',
          'control unreachable',
        );
      },
    });
    fresh = new FeedbackDropService(m.t.services, manager, {
      claimed: async () => true,
      timings: { syncDebounceMs: 10, retryMinMs: 60_000, recheckMs: 60_000, checkMs: 3_600_000 },
    });
    await dropped({}, attestation('ada@example.com'));
    try {
      fresh.start();
      await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
      // With the backoff cut short a second attempt would follow within the debounce.
      await new Promise((r) => setTimeout(r, 300));
      expect(calls).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });
});
