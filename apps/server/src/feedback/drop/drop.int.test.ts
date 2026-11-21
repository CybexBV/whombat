/**
 * The encrypted feedback drop in a managed runtime (docs/decisions/feedback-drop.md FD-07 … FD-26, FD-34, FD-36):
 * keys sealed at rest and rotated, site cards published as a full set through the manager (withdrawn with intake,
 * caught up after `stale_seq`), sealed reports collected, opened, checked and filed through the one filing path,
 * every refusal code, duplicates and conflicts, a crash between commit and ack, the 5-attempt limit, quarantine,
 * expiry counts, health, snippets and the managed policy when the manager can't deliver.
 */
import { randomBytes } from 'node:crypto';
import type { FeedbackIntegration } from '@whombat/core';
import {
  dropEnvelopeCap,
  feedbackReferenceFor,
  generateDropKeyPair,
  sealDropEnvelope,
  verifySiteCard,
} from '@whombat/core/feedback/drop';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applianceState,
  events,
  feedbackDropKeys,
  feedbackDropOutcomes,
  feedbackDropSites,
  feedbackDropState,
  feedbackIntegrations,
  feedbackReports,
  messages,
} from '../../db/schema/index';
import { IDS } from '../../seed/test-world';
import {
  attachmentOf,
  createIntegration,
  integrationSettings,
  SITE_ORIGIN,
  submission,
} from '../../test/feedback';
import { makePng } from '../../test/files';
import { useManagedRuntime } from '../../test/managed';
import { setFeedbackIntake } from '../integrations';
import { integrationHealth, snippetsFor } from '../read';
import { bodyCapOf, publicConfigOf } from '../submission';
import { DropKeys, dropKeyAad } from './keys';

const EMBED = 'https://embed.whombat.test';
const m = useManagedRuntime({ seed: true, env: { WHOMBAT_EMBED_URL: EMBED } });
const drop = () => m.runtime.feedbackDrop;
const control = () => m.manager.feedback;

let integration: FeedbackIntegration;
let site: string;
let pin: string;

type Row = typeof feedbackIntegrations.$inferSelect;
async function rowOf(id: string): Promise<Row> {
  const [row] = await m.t.services.db
    .select()
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.id, id));
  if (!row) throw new Error('no integration');
  return row;
}

/** Seals a report to the site's published card, as the frame does. */
async function sealed(
  over: {
    submission?: Parameters<typeof submission>[0];
    frame?: Record<string, unknown>;
    plaintext?: unknown;
    site?: string;
    card?: (card: NonNullable<ReturnType<typeof publishedCard>>) => typeof card;
  } = {},
) {
  const signed = publishedCard(over.site ?? site);
  if (!signed) throw new Error('no card');
  const card = over.card ? over.card(signed) : signed;
  const sub = submission(over.submission);
  const plaintext = over.plaintext ?? {
    v: 1,
    submission: sub,
    frame: {
      bridgeOrigin: SITE_ORIGIN,
      ancestorOrigins: [SITE_ORIGIN],
      widget: '1.1.0',
      cardSeq: card.seq,
      ...over.frame,
    },
  };
  return { envelope: await sealDropEnvelope(card, JSON.stringify(plaintext)), sub };
}

function publishedCard(siteId: string) {
  return control().cards.get(siteId)?.card ?? null;
}

async function outcomeOf(dropId: string) {
  const [row] = await m.t.services.db
    .select()
    .from(feedbackDropOutcomes)
    .where(eq(feedbackDropOutcomes.dropId, dropId));
  return row ?? null;
}

async function reportsOf(submissionId: string) {
  return m.t.services.db.select().from(feedbackReports).where(eq(feedbackReports.submissionId, submissionId));
}

beforeAll(async () => {
  // Cards are published only once the appliance is claimed (FD-11).
  await m.t.services.db
    .insert(applianceState)
    .values({ id: 1, claimConsumedAt: new Date() })
    .onConflictDoUpdate({ target: applianceState.id, set: { claimConsumedAt: new Date() } });
  integration = await createIntegration(m.t, { reportTypes: ['bug'] });
  site = integration.siteId;
});

afterEach(() => {
  control().mode = 'ok';
  m.t.services.maintenance.quarantined = false;
  m.t.services.feedback.faults.beforeIntakeCommit = undefined;
});

describe('site cards', () => {
  it('publishes a signed card per site that takes reports, pinned by the snippet’s data-key', async () => {
    const snippets = await snippetsFor(m.t.services, await rowOf(integration.id));
    const key = /data-key="(fbk_[A-Za-z0-9_-]{22})"/.exec(snippets.basic)?.[1];
    expect(key).toBeDefined();
    pin = key as string;
    expect(snippets.basic).toContain(`src="${EMBED}/embed/v1/widget.js"`);
    expect(snippets.basic).toContain(`data-site="${site}"`);
    expect(snippets.csp).toContain(EMBED);
    expect(snippets.csp).not.toContain('app.whombat.test');

    const outcome = await drop().syncNow();
    expect(outcome).toMatchObject({ accepted: [site], refused: [] });
    const signed = control().cards.get(site);
    const verified = verifySiteCard(signed, pin, { site, now: Math.floor(Date.now() / 1000) });
    expect(verified.ok).toBe(true);
    const row = await rowOf(integration.id);
    expect(signed?.card.config).toEqual(publicConfigOf(row.settings, { mail: true }));
    expect(signed?.card.allowedOrigins).toEqual([SITE_ORIGIN]);
    expect(signed?.card.limits).toEqual({
      maxEnvelopeBytes: dropEnvelopeCap(bodyCapOf(row.settings)),
      reportsPerHour: row.settings.limits.reportsPerHour,
      reportsPerDay: row.settings.limits.reportsPerDay,
      perSourcePerHour: row.settings.limits.perSourcePerHour,
    });
    expect((signed?.card.expiresAt ?? 0) - (signed?.card.issuedAt ?? 0)).toBe(14 * 86_400);
    // The sync's seq is at least every card's.
    expect(control().syncs.at(-1)?.seq).toBeGreaterThanOrEqual(signed?.card.seq ?? Infinity);

    const health = await integrationHealth(m.t.services, row);
    expect(health.publicUrl).toBe(EMBED);
    expect(health.delivery).toMatchObject({ mode: 'drop', notFiled7d: 0, expired7d: 0 });
    expect(health.delivery?.publishedAt).not.toBeNull();
    expect(health.warnings.map((w) => w.code)).not.toContain('public_url_missing');
    expect(health.warnings.map((w) => w.code)).not.toContain('widget_not_built');
    expect(health.warnings.map((w) => w.code)).not.toContain('drop_not_published');
  });

  it('re-issues every card with a fresh seq on each sync', async () => {
    const before = publishedCard(site)?.seq ?? 0;
    await drop().syncNow();
    expect(publishedCard(site)?.seq).toBeGreaterThan(before);
  });

  it('catches up when control holds newer seqs (a restored replacement)', async () => {
    control().lastSyncSeq = 50_000;
    const outcome = await drop().syncNow();
    expect(outcome?.accepted).toEqual([site]);
    expect(outcome?.attempts).toBeGreaterThan(1);
    const [state] = await m.t.services.db.select().from(feedbackDropState);
    expect(state?.cardSeq).toBeGreaterThan(50_000);
  });

  it('withdraws the card when intake goes off, and publishes it again when it comes back', async () => {
    const other = await createIntegration(m.t, {
      name: 'Docs',
      allowedOrigins: ['https://docs.lumio.example'],
    });
    await drop().syncNow();
    expect(control().cards.has(other.siteId)).toBe(true);
    const off = await m.t.commit(IDS.mara, setFeedbackIntake, { integrationId: other.id, enabled: false });
    expect(off.status).toBe('ok');
    await drop().syncNow();
    expect(control().cards.has(other.siteId)).toBe(false);
    expect(control().cards.has(site)).toBe(true);
    const [row] = await m.t.services.db
      .select()
      .from(feedbackDropSites)
      .where(eq(feedbackDropSites.siteId, other.siteId));
    expect(row).toBeUndefined();
    const health = await integrationHealth(m.t.services, await rowOf(other.id));
    expect(health.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['intake_disabled']));
    expect(health.warnings.map((w) => w.code)).not.toContain('drop_not_published');
  });

  it('says so when control refuses a site (bound elsewhere), and keeps trying', async () => {
    const taken = await createIntegration(m.t, {
      name: 'Taken',
      allowedOrigins: ['https://taken.lumio.example'],
    });
    control().bindings.set(taken.siteId, 'fbk_AAAAAAAAAAAAAAAAAAAAAA');
    const outcome = await drop().syncNow();
    expect(outcome?.refused).toEqual([
      expect.objectContaining({ site: taken.siteId, code: 'site_bound_elsewhere' }),
    ]);
    const health = await integrationHealth(m.t.services, await rowOf(taken.id));
    expect(health.warnings).toContainEqual({
      code: 'drop_not_published',
      message:
        'Whombat’s cloud doesn’t have this site yet, so visitors can’t send reports. This Whombat keeps trying.',
    });
    await m.t.commit(IDS.mara, setFeedbackIntake, { integrationId: taken.id, enabled: false });
    await drop().syncNow();
  });
});

describe('collecting drops', () => {
  it('files a sealed report like a direct one, under the reference the frame showed, and acknowledges it', async () => {
    const png = makePng(4, 3);
    const { envelope, sub } = await sealed({
      submission: {
        description: 'Canary 7f3a: the total is off.',
        attachments: [attachmentOf(png, 'image/png')],
      },
    });
    const dropId = control().drop(site, envelope, EMBED);
    const summary = await drop().pull();
    expect(summary).toMatchObject({ received: 1, filed: 1, acked: 1, retry: 0 });
    expect(control().acked).toContain(dropId);
    expect(control().queue.find((d) => d.dropId === dropId)).toBeUndefined();

    const [report] = await reportsOf(sub.submissionId);
    expect(report?.reference).toBe(feedbackReferenceFor(site, sub.submissionId));
    expect(report?.description).toBe('Canary 7f3a: the total is off.');
    expect(report?.attachmentIds).toHaveLength(1);
    // Sanitized like a direct report: no query, no fragment, no id-like path segment, only allowlisted context.
    expect(report?.context?.page?.url).not.toContain('secret');
    expect(report?.context?.custom).toEqual({ plan: 'pro' });
    const [root] = await m.t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, report?.rootMessageId ?? ''));
    expect(root?.text).toBe(`Bug report ${report?.reference} · Lumio`);
    const received = await m.t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'feedback.report_received'));
    const payload = received
      .map((e) => e.payload as Record<string, unknown>)
      .find((p) => p.dropId === dropId);
    expect(payload).toMatchObject({ via: 'drop', dropId, reference: report?.reference });
    expect(JSON.stringify(payload)).not.toContain('Canary');
    expect(await outcomeOf(dropId)).toMatchObject({ outcome: 'filed', integrationId: integration.id });

    const health = await integrationHealth(m.t.services, await rowOf(integration.id));
    expect(health.delivery?.lastCollectedAt).not.toBeNull();
  });

  it('a crash between commit and ack: the redelivered drop is acked without a second report', async () => {
    const { envelope, sub } = await sealed();
    const dropId = control().drop(site, envelope, EMBED);
    control().failNextAck = true;
    expect(await drop().pull()).toMatchObject({ filed: 1, acked: 0 });
    expect(control().queue.some((d) => d.dropId === dropId)).toBe(true);
    control().expireLeases();
    expect(await drop().pull()).toMatchObject({ received: 1, filed: 1, acked: 1 });
    expect(await reportsOf(sub.submissionId)).toHaveLength(1);
    expect(control().queue.some((d) => d.dropId === dropId)).toBe(false);
  });

  it('the same submission sealed again is a duplicate; the same id with other content a conflict', async () => {
    const first = await sealed();
    control().drop(site, first.envelope, EMBED);
    const again = await sealed({ submission: { ...first.sub } });
    const dupId = control().drop(site, again.envelope, EMBED);
    const changed = await sealed({ submission: { ...first.sub, description: 'Something else entirely.' } });
    const conflictId = control().drop(site, changed.envelope, EMBED);
    expect(await drop().pull()).toMatchObject({ filed: 1, duplicate: 1, refused: 1, acked: 3 });
    expect(await outcomeOf(dupId)).toMatchObject({ outcome: 'duplicate' });
    expect(await outcomeOf(conflictId)).toMatchObject({ outcome: 'refused', code: 'conflict' });
    expect(await reportsOf(first.sub.submissionId)).toHaveLength(1);
  });

  it('refuses what it can’t open or doesn’t trust, with the right code, and acknowledges it', async () => {
    const other = generateDropKeyPair();
    const foreignSite = `fbs_${randomBytes(18).toString('base64url').replace(/[-_]/g, 'x').slice(0, 24)}`;
    const cases: [string, Promise<{ envelope: Uint8Array }>, { site?: string; origin?: string }][] = [
      [
        'unknown_key',
        sealed({
          card: (c) => ({
            ...c,
            encryption: { ...c.encryption, kid: other.kid, publicKey: other.publicKeyB64 },
          }),
        }),
        {},
      ],
      [
        'undecryptable',
        sealed().then(({ envelope }) => {
          const tampered = new Uint8Array(envelope);
          const last = tampered.length - 1;
          tampered[last] = (tampered[last] ?? 0) ^ 1;
          return { envelope: tampered };
        }),
        {},
      ],
      // The header names this site; the drop arrived for another: moved between sites.
      ['malformed', sealed(), { site: foreignSite }],
      ['unknown_site', sealed({ card: (c) => ({ ...c, site: foreignSite }) }), { site: foreignSite }],
      ['origin', sealed(), { origin: 'https://evil.example' }],
      [
        'origin',
        sealed({
          submission: { parentOrigin: 'https://evil.example' },
          frame: { bridgeOrigin: 'https://evil.example', ancestorOrigins: ['https://evil.example'] },
        }),
        {},
      ],
      ['origin', sealed({ frame: { bridgeOrigin: 'https://other.example' } }), {}],
      ['origin', sealed({ frame: { ancestorOrigins: ['https://framer.example', SITE_ORIGIN] } }), {}],
      ['invalid', sealed({ submission: { type: 'feature' } }), {}],
      ['invalid', sealed({ plaintext: { v: 1, submission: submission() } }), {}],
      ['invalid', sealed({ plaintext: { v: 2, submission: submission(), frame: {} } }), {}],
      ['invalid', sealed({ submission: { description: '   ' } }), {}],
    ];
    const ids: [string, string][] = [];
    for (const [code, made, where] of cases) {
      const { envelope } = await made;
      ids.push([code, control().drop(where.site ?? site, envelope, where.origin ?? EMBED)]);
    }
    const before = (await m.t.services.db.select().from(feedbackReports)).length;
    // Two pulls: at most 10 drops per pull (FD-22).
    const first = await drop().pull();
    expect(first).toMatchObject({ received: 10, refused: 10, acked: 10, pending: cases.length - 10 });
    expect(await drop().pull()).toMatchObject({ received: cases.length - 10, refused: cases.length - 10 });
    for (const [code, id] of ids)
      expect(await outcomeOf(id), code).toMatchObject({ outcome: 'refused', code });
    expect((await m.t.services.db.select().from(feedbackReports)).length).toBe(before);

    const health = await integrationHealth(m.t.services, await rowOf(integration.id));
    const notFiled = health.warnings.find((w) => w.code === 'drop_not_filed');
    expect(notFiled?.message).toMatch(/^\d+ reports from the last 7 days couldn’t be filed\.$/);
    expect(health.delivery?.notFiled7d).toBeGreaterThanOrEqual(cases.length - 2);
  });

  it('a drop that keeps failing transiently comes back, and is refused as internal after 5 attempts', async () => {
    const { envelope, sub } = await sealed();
    const dropId = control().drop(site, envelope, EMBED);
    m.t.services.feedback.faults.beforeIntakeCommit = () => {
      throw new Error('database went away');
    };
    for (let attempt = 1; attempt < 5; attempt++) {
      expect(await drop().pull()).toMatchObject({ retry: 1, acked: 0 });
      expect(await outcomeOf(dropId)).toMatchObject({ outcome: 'pending', attempts: attempt });
      control().expireLeases();
    }
    expect(await drop().pull()).toMatchObject({ refused: 1, acked: 1 });
    expect(await outcomeOf(dropId)).toMatchObject({ outcome: 'refused', code: 'internal', attempts: 5 });
    expect(await reportsOf(sub.submissionId)).toHaveLength(0);
  });

  it('files nothing while quarantined: the drop waits for its lease to run out', async () => {
    const { envelope, sub } = await sealed();
    const dropId = control().drop(site, envelope, EMBED);
    m.t.services.maintenance.quarantined = true;
    expect(await drop().pull()).toMatchObject({ received: 1, retry: 1, acked: 0 });
    expect(await outcomeOf(dropId)).toBeNull();
    m.t.services.maintenance.quarantined = false;
    control().expireLeases();
    expect(await drop().pull()).toMatchObject({ filed: 1, acked: 1 });
    expect(await reportsOf(sub.submissionId)).toHaveLength(1);
  });

  it('a drop accepted while intake was on is still filed after it went off (FD-19)', async () => {
    const { envelope, sub } = await sealed();
    control().drop(site, envelope, EMBED);
    await m.t.commit(IDS.mara, setFeedbackIntake, { integrationId: integration.id, enabled: false });
    try {
      expect(await drop().pull()).toMatchObject({ filed: 1 });
      expect(await reportsOf(sub.submissionId)).toHaveLength(1);
    } finally {
      await m.t.commit(IDS.mara, setFeedbackIntake, { integrationId: integration.id, enabled: true });
      await drop().syncNow();
    }
  });

  it('counts reports that expired unread in the cloud', async () => {
    control().expired = [{ site, count: 1 }];
    await drop().pull();
    const health = await integrationHealth(m.t.services, await rowOf(integration.id));
    expect(health.delivery?.expired7d).toBe(1);
    expect(health.warnings).toContainEqual({
      code: 'drop_expired',
      message: '1 report waited 7 days in Whombat’s cloud and was deleted before this Whombat collected it.',
    });
  });
});

describe('keys', () => {
  it('seals private keys with the master key, and a restored runtime opens them', async () => {
    const rows = await m.t.services.db.select().from(feedbackDropKeys);
    expect(rows.map((r) => r.kind).sort()).toEqual(['encryption', 'signing']);
    const enc = rows.find((r) => r.kind === 'encryption');
    const restored = new DropKeys(m.t.services);
    const key = await restored.privateKeyFor(enc?.kid ?? '');
    expect(key).toHaveLength(32);
    expect(enc?.privateSealed).toMatch(/^v1:/);
    expect(enc?.privateSealed).not.toContain(Buffer.from(key as Uint8Array).toString('base64url'));
    // Bound to its kid: the same ciphertext under another kid doesn't open.
    expect(() =>
      m.t.services.custody.open(dropKeyAad('fdk_AAAAAAAAAAAAAAAA'), enc?.privateSealed ?? ''),
    ).toThrow();
    expect((await restored.signingKey({ create: false }))?.fingerprint).toBe(pin);
  });

  it('rotates the encryption key after 30 days, keeps the old one 22 days, then deletes it', async () => {
    const services = m.t.services;
    const keys = drop().keys;
    const old = await keys.currentEncryptionKey();
    const clock = services.clock;
    const start = Date.now();
    try {
      services.clock = () => new Date(start + 29 * 86_400_000);
      expect((await keys.currentEncryptionKey()).kid).toBe(old.kid);
      services.clock = () => new Date(start + 31 * 86_400_000);
      expect(await keys.rotationDue()).toBe(true);
      const next = await keys.currentEncryptionKey();
      expect(next.kid).not.toBe(old.kid);
      const [retired] = await services.db
        .select()
        .from(feedbackDropKeys)
        .where(eq(feedbackDropKeys.kid, old.kid));
      expect(retired?.retiredAt).not.toBeNull();
      expect(retired?.deleteAfter?.getTime()).toBe(start + (31 + 22) * 86_400_000);
      expect(await keys.privateKeyFor(old.kid)).not.toBeNull();
      services.clock = () => new Date(start + (31 + 22) * 86_400_000 + 1000);
      expect(await keys.privateKeyFor(old.kid)).toBeNull();
      expect(await keys.sweep()).toBe(1);
      // The signing key is never rotated: snippets keep working.
      expect(await keys.fingerprint()).toBe(pin);
    } finally {
      services.clock = clock;
    }
    // New cards carry the new key.
    await drop().syncNow();
    expect(publishedCard(site)?.encryption.kid).not.toBe(old.kid);
  });
});

describe('when the manager or control can’t deliver', () => {
  it('reports unsupported in health and policy, and refuses to switch intake on or create sites until it can', async () => {
    const device = await m.enroll(IDS.mara);
    const c = await m.client(device);
    control().mode = 501;
    expect(await drop().syncNow()).toBeNull();
    expect(drop().support).toBe('unsupported');
    const unsupported = 'Feedback needs an update of this Whombat’s cloud connection.';
    const health = await integrationHealth(m.t.services, await rowOf(integration.id));
    expect(health.warnings).toContainEqual({ code: 'drop_unsupported', message: unsupported });
    const status = (await c.request('appliance.status', {})) as {
      output?: { policy?: Record<string, unknown> };
    };
    expect(status.output?.policy?.feedbackIntake).toEqual({ available: false, reason: unsupported });
    const refused = await c.request('feedback.setIntake', {
      params: { burrow: 'burrow-hq', id: integration.id },
      body: { enabled: true },
    });
    expect(refused).toMatchObject({
      t: 'error',
      code: 'not_allowed',
      details: { code: 'managed.feedback_intake' },
    });
    const create = await c.request('feedback.createIntegration', {
      params: { burrow: 'burrow-hq' },
      body: integrationSettings({ name: 'Blocked' }),
    });
    expect(create).toMatchObject({ t: 'error', code: 'not_allowed' });
    // Switching off stays possible.
    const off = await c.request('feedback.setIntake', {
      params: { burrow: 'burrow-hq', id: integration.id },
      body: { enabled: false },
    });
    expect(off).toMatchObject({ t: 'result' });

    // A pull answered 404 by an older manager is unsupported too.
    control().mode = 404;
    await expect(drop().pull()).rejects.toMatchObject({ status: 404 });

    control().mode = 'ok';
    await drop().syncNow();
    expect(drop().support).toBe('supported');
    const again = (await c.request('appliance.status', {})) as {
      output?: { policy?: Record<string, unknown> };
    };
    expect(again.output?.policy?.feedbackIntake).toEqual({
      available: true,
      reason:
        'Visitors’ reports are encrypted in their browser to this Whombat. Whombat’s cloud keeps them, unreadable, until this Whombat collects them.',
    });
    const on = await c.request('feedback.setIntake', {
      params: { burrow: 'burrow-hq', id: integration.id },
      body: { enabled: true },
    });
    expect(on).toMatchObject({ t: 'result' });
  });
});
