/**
 * (o) Website feedback on a managed Whombat through the encrypted drop (contracts ≥ 0.13.0; Whombat feedback-drop
 * FD-01…FD-57, IN-55). Over the real client, relay, runtime, manager, control and the widget's embed origin:
 *
 * 1. The owner creates a site over the session and switches intake on; the runtime publishes its signed card through
 *    the manager, control serves it, and it verifies against the snippet's `data-key`.
 * 2. A visitor on another origin (a strict-CSP page carrying the snippet) sends a bug report with a screenshot
 *    through the real frame: sealed in the browser, stored by control, pulled through the manager, opened and filed
 *    by the runtime in the owner's Feedback room (`integration.conversationId`, Whombat one-agent.md OA-04, OA-16)
 *    under the reference the frame showed; control deletes it on the ack.
 * 3. With the runtime stopped, control holds the second report as ciphertext only: its envelope contains neither the
 *    text nor the screenshot in any encoding, its header is exactly `{kid, site, suite, v}`, and no log has the text.
 *    The runtime started again files it and control's row is gone.
 * 4. Refusals: a website the card doesn't allow, a card whose signature was tampered with, and a card re-signed with
 *    another key (control substituting the encryption key) all show “unavailable” and send nothing; a drop with
 *    another `Origin` is 404; intake off withdraws the card (GET and POST 404).
 * 5. (contracts ≥ 0.25.0, Whombat FR-04, FR-18, AP-427) The navigation trail: the pages visited on the site before
 *    reporting arrive with the report as `submitted.trail`, oldest first; a step on another origin is dropped.
 * 6. (contracts ≥ 0.25.0, FR-09, FR-10, CL-98…CL-101, MG-58) Reporter sign-in against the real control: the code from
 *    the mail in Mailpit, a report sent signed in is filed “Email verified”, the owner's status change reaches control
 *    through the manager (`feedback.reporters.publish`) and control's “Your reports” (and the frame's) say Fixed; a
 *    wrong code is `code_refused`.
 * 7. Signed out, a report with a typed address is still filed, unverified; the old session is `signed_out`.
 *
 * It stops the runtime, so it never runs against a public instance.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FEEDBACK_DROP_TEXT } from '@whombat/core/contracts';
import type { FeedbackSiteCard } from '@whombat/core/domain';
import {
  FEEDBACK_DROP_SUITE,
  generateDropKeyPair,
  generateSiteSigningKey,
  signSiteCard,
  verifySiteCard,
} from '@whombat/core/feedback/drop';
import { type Browser, type BrowserContext, chromium, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/dev/env.ts';
import { psql } from '../src/dev/postgres.ts';
import { startService, stopService } from '../src/dev/restart.ts';
import { CONTROL_DB } from '../src/dev/services.ts';
import { browserControlUrl, paths, publicUrls } from '../src/lib/paths.ts';
import { sleep } from '../src/lib/proc.ts';
import { contractsAtLeast } from '../src/manifest/version.ts';
import { type ApplianceSession, sessionOps } from '../src/scenario-kit/app-client.ts';
import { waitForMail } from '../src/scenario-kit/cloud.ts';
import {
  PAGES,
  plaintextNeedles,
  randomPng,
  startFeedbackSite,
  type TestSite,
} from '../src/scenario-kit/feedback-site.ts';
import { blocked, note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { api, ensureWorkspace, type Workspace } from '../src/scenario-kit/work.ts';

const enabled = contractsAtLeast('0.13.0');
/** The navigation trail and reporter sign-in (contracts 0.25.0, CT-160…CT-165). */
const reporters = contractsAtLeast('0.25.0');
const UNAVAILABLE = 'Feedback isn’t available on this site right now.';
const control = browserControlUrl();

interface Integration {
  id: string;
  siteId: string;
  intake: 'enabled' | 'disabled';
  allowedOrigins: string[];
  /** The room its reports land in: the Feedback room of the person who set it up (contracts 0.123.0). */
  conversationId: string;
}
interface Detail {
  integration: Integration;
  snippets: { basic: string; custom: string; csp: string };
  health: {
    publicUrl: string | null;
    warnings: { code: string; message: string }[];
    delivery: { mode: 'drop'; publishedAt: string | null; lastCollectedAt: string | null } | null;
  };
}
interface Report {
  id: string;
  reference: string;
  type: string;
  status: string;
  submitted: {
    description: string;
    reporter: { name: string | null; email: string | null; verified?: boolean };
    context: { page: { url: string } | null };
    trail?: { url: string; title: string | null; at: string }[];
    attachments: { name: string; mimeType?: string; contentType?: string }[];
  };
}
interface Msg {
  id: string;
  text: string;
  card: { kind: string; reportId?: string } | null;
}

let slice: SliceState;
let owner: ApplianceSession;
let w: Workspace;
let embed = '';
let site: TestSite;
let otherSite: TestSite;
let browser: Browser | null = null;
let skip: string | null = null;
let integration: Integration;
let siteKey = '';

async function reopenOwner(): Promise<void> {
  try {
    owner?.close('closed');
  } catch {
    // already closed
  }
  owner = (await ownerSession(slice)).session;
}

beforeAll(async () => {
  if (!enabled) return;
  const state = loadEnv();
  if (!state) throw new Error('no environment');
  if (publicUrls) {
    skip = `this environment is public (${publicUrls.web}); scenario o stops the runtime, run it in a harness environment of its own`;
    return;
  }
  if (!state.embed || state.services.embed?.status !== 'running') {
    skip = `the embed server isn’t running (${state.services.embed?.note ?? 'no embed service'}); dev/up with whombat-app ≥ 0.6.0`;
    return;
  }
  embed = state.embed.url;
  slice = await ensureSlice();
  await reopenOwner();
  w = await ensureWorkspace(owner, `Feedback ${randomBytes(3).toString('hex')}`);
  site = await startFeedbackSite(embed);
  otherSite = await startFeedbackSite(embed, 'Somebody else');
  browser = await chromium.launch({ headless: true });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  await otherSite?.close();
  try {
    owner?.close('closed');
  } catch {
    // already closed
  }
}, 60_000);

const detail = () =>
  api<Detail>(owner, 'feedback.getIntegration', 'GET', { params: { burrow: w.slug, id: integration.id } });

const cardUrl = () => `${control}/v1/feedback/sites/${integration.siteId}/card`;
const dropUrl = () => `${control}/v1/feedback/sites/${integration.siteId}/drops`;

async function waitUntil<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000) {
  const end = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(500);
  }
  throw new Error(
    `timed out waiting for ${what}${last ? ` (last error: ${String(last).slice(0, 300)})` : ''}`,
  );
}

/** The drop rows control holds for the site (`feedback_drops`). */
async function controlDrops(): Promise<{ id: string; origin: string; envelope: Buffer }[]> {
  const r = await psql(
    `select id || '|' || origin || '|' || encode(envelope, 'hex') from feedback_drops where site_id = '${integration.siteId}' order by received_at`,
    CONTROL_DB,
  );
  if (r.code !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [id, origin, hex] = l.split('|');
      return { id: id ?? '', origin: origin ?? '', envelope: Buffer.from(hex ?? '', 'hex') };
    });
}

/** Every harness log (`env/logs/*`) that contains `needle`. */
function logsContaining(needle: string): string[] {
  if (!existsSync(paths.logs)) return [];
  return readdirSync(paths.logs).filter((f) => readFileSync(join(paths.logs, f), 'latin1').includes(needle));
}

interface Visit {
  context: BrowserContext;
  page: Page;
  frame: Frame;
  /** POSTs the frame made to control's drop endpoint. */
  drops: string[];
  errors: string[];
}

/** Opens the site in a fresh context and the widget on it; `route` may intercept control's card. */
async function visit(
  origin: string,
  route?: (ctx: BrowserContext) => Promise<void>,
  walk?: (page: Page) => Promise<void>,
): Promise<Visit> {
  if (!browser) throw new Error('no browser');
  const context = await browser.newContext();
  if (route) await route(context);
  const page = await context.newPage();
  const drops: string[] = [];
  const errors: string[] = [];
  context.on('request', (r) => {
    // The drop's POSTs (the reporter routes, `…/reporter/…`, are not drops).
    if (r.method() === 'POST' && r.url().includes('/v1/feedback/sites/') && r.url().endsWith('/drops'))
      drops.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  if (walk) await walk(page);
  else await page.goto(`${origin}/`);
  await page.waitForFunction(() => 'WhombatFeedback' in window, undefined, { timeout: 15_000 });
  await page.evaluate(() =>
    (window as unknown as { WhombatFeedback: { open(): void } }).WhombatFeedback.open(),
  );
  const frame = await waitUntil(
    'the widget’s frame',
    async () => page.frames().find((f) => f.url().startsWith(`${embed}/embed/v1/frame.html`)),
    15_000,
  );
  return { context, page, frame, drops, errors };
}

/** Sends a bug report through the frame and returns the reference the receipt shows. */
async function sendReport(v: Visit, text: string, png: Buffer, email?: string): Promise<string> {
  const f = v.frame;
  await f.locator('#wb-description').waitFor({ state: 'visible', timeout: 15_000 });
  await waitUntil(
    'Send enabled after the loader’s message',
    () => f.locator('button[type=submit]').isEnabled(),
    15_000,
  );
  await f.locator('#wb-description').fill(text);
  if (email !== undefined) await f.locator('#wb-email').fill(email);
  await f
    .locator('input[type=file]')
    .setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: png });
  await f.locator('.file img').waitFor({ timeout: 15_000 });
  await f.locator('button[type=submit]').click();
  await f.locator('.receipt-title').waitFor({ timeout: 30_000 });
  return (await f.locator('.reference').innerText()).trim();
}

/** The report filed in the owner's Feedback room under `reference` (its root message carries the report card). */
async function filedReport(reference: string, ms = 90_000): Promise<{ report: Report; message: Msg }> {
  const message = await waitUntil(
    `the report ${reference} in the Feedback room`,
    async () => {
      const page = await api<{ messages: Msg[] }>(owner, 'messages.list', 'GET', {
        params: { burrow: w.slug, conversationId: integration.conversationId },
        query: { limit: 50 },
      });
      return page.messages.find((m) => m.text.includes(reference) && m.card?.kind === 'report');
    },
    ms,
  );
  const { report } = await api<{ report: Report }>(owner, 'feedback.getReport', 'GET', {
    params: { burrow: w.slug, id: message.card?.reportId },
  });
  return { report, message };
}

/** Control's reporter routes (`feedbackDropApi.reporter*`), as the frame calls them: from the embed origin. */
const reporterUrl = (what: 'code' | 'session' | 'reports') =>
  `${control}/v1/feedback/sites/${integration.siteId}/reporter/${what}`;

async function reporterCall(
  method: 'GET' | 'POST' | 'DELETE',
  what: 'code' | 'session' | 'reports',
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(reporterUrl(what), {
    method,
    headers: {
      origin: embed,
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

/** The frame's stored reporter session (`localStorage` `whombat-feedback:<site>`, AP-4xx), or null. */
async function frameSession(v: Visit): Promise<{ token: string; email: string } | null> {
  const raw = await v.frame.evaluate(
    (key) => window.localStorage.getItem(key),
    `whombat-feedback:${integration.siteId}`,
  );
  const s = raw ? (JSON.parse(raw) as { token?: string; email?: string }) : null;
  return s?.token && s.email ? { token: s.token, email: s.email } : null;
}

const needsReporters = (ctx: Parameters<typeof blocked>[0]) => {
  if (skip || !siteKey)
    blocked(ctx, 'whombat-appliance/o-feedback-environment', skip ?? 'no site from step 1');
};

let signedInEmail = '';
let signedInToken = '';

describe.skipIf(!enabled)('o website feedback through the encrypted drop', () => {
  it('1 the owner creates a site and switches intake on; control serves its card, pinned by the snippet’s key', async (ctx) => {
    if (skip) blocked(ctx, 'whombat-appliance/o-feedback-environment', skip);
    const created = await api<{ status: string; integration: Integration }>(
      owner,
      'feedback.createIntegration',
      'POST',
      {
        params: { burrow: w.slug },
        body: {
          name: 'Acme Billing',
          productLabel: 'Acme Billing',
          allowedOrigins: [site.origin],
          repoId: null,
          reportTypes: ['bug', 'feature'],
        },
      },
    );
    expect(created.status).toBe('ok');
    integration = created.integration;
    if (integration.intake !== 'enabled') {
      const on = await api<{ status: string; integration: Integration }>(
        owner,
        'feedback.setIntake',
        'POST',
        {
          params: { burrow: w.slug, id: integration.id },
          body: { enabled: true },
        },
      );
      expect(on.status).toBe('ok');
      integration = on.integration;
    }
    const d = await detail();
    note(ctx, 'snippet', { basic: d.snippets.basic, csp: d.snippets.csp, health: d.health });
    siteKey = /data-key="(fbk_[A-Za-z0-9_-]{22})"/.exec(d.snippets.basic)?.[1] ?? '';
    expect(siteKey).toMatch(/^fbk_/);
    expect(d.snippets.basic).toContain(`src="${embed}/embed/v1/widget.js"`);
    expect(d.snippets.basic).toContain(`data-site="${integration.siteId}"`);
    expect(d.snippets.csp).toContain(embed);
    expect(d.health.publicUrl).toBe(embed);
    expect(d.health.delivery?.mode).toBe('drop');
    expect(d.health.warnings.map((x) => x.code)).not.toContain('drop_unsupported');

    // Published: control serves the card, which verifies against the snippet's pin.
    const res = await waitUntil('the card at control', async () => {
      const r = await fetch(cardUrl(), { headers: { origin: embed } });
      return r.status === 200 ? r : null;
    });
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('access-control-allow-origin')).toBe(embed);
    const signed = await res.json();
    const verified = verifySiteCard(signed, siteKey, {
      site: integration.siteId,
      now: Math.floor(Date.now() / 1000),
    });
    note(ctx, 'card', { verified: verified.ok, card: verified.ok ? verified.card : signed });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.card.allowedOrigins).toEqual([site.origin]);
    expect(verified.card.encryption.suite).toBe(FEEDBACK_DROP_SUITE);
    const published = await waitUntil('health: published', async () => {
      const h = (await detail()).health;
      return h.delivery?.publishedAt ? h : null;
    });
    expect(published.warnings.map((x) => x.code)).not.toContain('drop_not_published');
    const status = (await sessionOps.applianceStatus(owner)) as {
      policy?: Record<string, { available: boolean; reason: string | null }>;
    };
    note(ctx, 'policy.feedbackIntake', { feedbackIntake: status.policy?.feedbackIntake });
    expect(status.policy?.feedbackIntake).toEqual({ available: true, reason: FEEDBACK_DROP_TEXT.policy });
    site.setSnippet(d.snippets.basic);
    otherSite.setSnippet(d.snippets.basic);
  });

  it('2 a visitor’s report goes sealed through frame, control, manager and runtime, filed under the frame’s reference', async (ctx) => {
    if (skip || !siteKey)
      blocked(ctx, 'whombat-appliance/o-feedback-environment', skip ?? 'no site from step 1');
    const canary = `canary-${randomBytes(6).toString('hex')} — the invoice total is off by one cent`;
    const png = randomPng();
    const v = await visit(site.origin);
    const t0 = Date.now();
    const reference = await sendReport(v, canary, png);
    expect(reference).toMatch(/^FB-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(v.drops).toEqual([dropUrl()]);
    expect(v.errors).toEqual([]);
    await v.context.close();
    const { report, message } = await filedReport(reference);
    note(ctx, 'filed', {
      reference,
      afterMs: Date.now() - t0,
      message: message.text,
      page: report.submitted.context.page,
      attachments: report.submitted.attachments,
    });
    expect(report.reference).toBe(reference);
    expect(report.type).toBe('bug');
    expect(report.submitted.description).toBe(canary);
    expect(report.submitted.attachments).toHaveLength(1);
    // Acknowledged: control deleted it.
    await waitUntil(
      'control’s row deleted after the ack',
      async () => (await controlDrops()).length === 0,
      30_000,
    );
    const h = (await detail()).health;
    expect(h.delivery?.lastCollectedAt).toBeTruthy();
    expect(logsContaining(canary)).toEqual([]);
  });

  it('3 with the runtime stopped control holds only ciphertext; started again, the runtime files it', async (ctx) => {
    if (skip || !siteKey)
      blocked(ctx, 'whombat-appliance/o-feedback-environment', skip ?? 'no site from step 1');
    const canary = `canary-${randomBytes(6).toString('hex')} — the export button does nothing`;
    const png = randomPng();
    await stopService('runtime');
    let reference = '';
    try {
      const v = await visit(site.origin);
      reference = await sendReport(v, canary, png);
      await v.context.close();
      const rows = await waitUntil('the drop at control', async () => {
        const r = await controlDrops();
        return r.length === 1 ? r : null;
      });
      const row = rows[0] as { id: string; origin: string; envelope: Buffer };
      const h = row.envelope.readUInt16BE(0);
      const header = JSON.parse(row.envelope.subarray(2, 2 + h).toString('utf8')) as Record<string, unknown>;
      const found = [...plaintextNeedles('text', canary), ...plaintextNeedles('screenshot', png)]
        .filter(([, needle]) => row.envelope.includes(needle))
        .map(([label]) => label);
      note(ctx, 'envelope at control', {
        dropId: row.id,
        origin: row.origin,
        bytes: row.envelope.length,
        header,
        plaintextFound: found,
      });
      expect(Object.keys(header).sort()).toEqual(['kid', 'site', 'suite', 'v']);
      expect(header).toMatchObject({ site: integration.siteId, suite: FEEDBACK_DROP_SUITE, v: 1 });
      expect(row.origin).toBe(embed);
      expect(found).toEqual([]);
      expect(logsContaining(canary)).toEqual([]);
    } finally {
      await startService('runtime');
    }
    await reopenOwner();
    const { report } = await filedReport(reference, 120_000);
    note(ctx, 'filed after the restart', { reference, report: report.id });
    expect(report.submitted.description).toBe(canary);
    await waitUntil(
      'control’s row deleted after the ack',
      async () => (await controlDrops()).length === 0,
      30_000,
    );
    expect(logsContaining(canary)).toEqual([]);
  });

  it('4 a website the card doesn’t allow, a tampered card and a card under another key are unavailable; nothing is sent', async (ctx) => {
    if (skip || !siteKey)
      blocked(ctx, 'whombat-appliance/o-feedback-environment', skip ?? 'no site from step 1');
    const unavailable = async (name: string, v: Visit) => {
      await v.frame.getByText(UNAVAILABLE).waitFor({ timeout: 15_000 });
      expect(await v.frame.locator('form').count(), name).toBe(0);
      expect(v.drops, name).toEqual([]);
      await v.context.close();
    };
    // The frame on a website the card doesn't list (the same snippet, copied elsewhere).
    await unavailable('wrong parent', await visit(otherSite.origin));
    // Control (or anything in between) changes the signed card: the signature no longer holds.
    const tamper =
      (edit: (signed: { card: Record<string, unknown>; sig: string }) => unknown) =>
      async (c: BrowserContext) => {
        await c.route(cardUrl(), async (route) => {
          const response = await route.fetch();
          const signed = (await response.json()) as { card: Record<string, unknown>; sig: string };
          await route.fulfill({ response, body: JSON.stringify(edit(signed)) });
        });
      };
    await unavailable(
      'bad signature',
      await visit(
        site.origin,
        tamper((s) => ({
          ...s,
          sig: `${s.sig.slice(0, 10)}${s.sig[10] === 'A' ? 'B' : 'A'}${s.sig.slice(11)}`,
        })),
      ),
    );
    // Control substitutes its own encryption key and signs the card with a key of its own: the pin refuses it.
    const mallory = generateSiteSigningKey();
    const theirs = generateDropKeyPair();
    await unavailable(
      'another signing key',
      await visit(
        site.origin,
        tamper((s) =>
          signSiteCard(
            {
              ...(s.card as unknown as FeedbackSiteCard),
              encryption: { suite: FEEDBACK_DROP_SUITE, kid: theirs.kid, publicKey: theirs.publicKeyB64 },
              signingKey: mallory.publicKey,
            },
            mallory.seed,
          ),
        ),
      ),
    );
    note(ctx, 'refused in the frame', { cases: ['wrong parent', 'bad signature', 'another signing key'] });
  });

  it.skipIf(!reporters)(
    '5 the pages visited before reporting arrive as the report’s trail; another origin’s step is dropped',
    async (ctx) => {
      needsReporters(ctx);
      const canary = `canary-${randomBytes(6).toString('hex')} — the settings page lost my VAT number`;
      const walked: string[] = [];
      const v = await visit(site.origin, undefined, async (page) => {
        await page.goto(`${site.origin}/settings`);
        await page.waitForFunction(() => 'WhombatFeedback' in window, undefined, { timeout: 15_000 });
        walked.push('/settings');
        // A step on another origin in the tab's trail (as a crafted page or an extension could leave it): the loader
        // passes what it stored, the runtime drops it (FR-18).
        await page.evaluate(() => {
          const key = 'whombat-feedback:trail';
          const trail = JSON.parse(window.sessionStorage.getItem(key) ?? '[]') as unknown[];
          trail.push({ url: 'https://evil.example/phish', title: 'Elsewhere', at: new Date().toISOString() });
          window.sessionStorage.setItem(key, JSON.stringify(trail));
        });
        for (const path of ['/invoices/2026-0917', '/']) {
          await page.goto(`${site.origin}${path}`);
          await page.waitForFunction(() => 'WhombatFeedback' in window, undefined, { timeout: 15_000 });
          walked.push(path);
        }
      });
      const stored = await v.page.evaluate(() => window.sessionStorage.getItem('whombat-feedback:trail'));
      const reference = await sendReport(v, canary, randomPng());
      expect(v.errors).toEqual([]);
      await v.context.close();
      const { report } = await filedReport(reference);
      note(ctx, 'trail', {
        walked,
        loader: stored ? JSON.parse(stored) : null,
        filed: report.submitted.trail,
      });
      const trail = report.submitted.trail ?? [];
      expect(trail.map((s) => s.url)).toEqual(walked.map((p) => `${site.origin}${p}`));
      expect(trail.map((s) => s.title)).toEqual(walked.map((p) => `${PAGES[p]} · Acme Billing`));
      for (const s of trail) expect(Number.isNaN(Date.parse(s.at))).toBe(false);
      expect(JSON.stringify(report.submitted)).not.toContain('evil.example');
      expect(report.submitted.reporter.verified ?? false).toBe(false);
    },
  );

  it.skipIf(!reporters)(
    '6 a reporter signs in with the mailed code; the report is verified and its status reaches control',
    async (ctx) => {
      needsReporters(ctx);
      const email = `reporter-${randomBytes(4).toString('hex')}@example.com`;
      const canary = `canary-${randomBytes(6).toString('hex')} — the PDF download times out`;
      const v = await visit(site.origin);
      const f = v.frame;
      await f.locator('#wb-signin-link').click({ timeout: 15_000 });
      const since = Date.now();
      await f.locator('#wb-signin-email').fill(email);
      await f.locator('button[type=submit][form=wb-signin]').click();
      await f.locator('#wb-signin-code').waitFor({ timeout: 15_000 });
      const mail = await waitForMail(email, since, 30_000, /^\d{6}$/m);
      const code = /^(\d{6})$/m.exec(mail.text)?.[1] ?? '';
      note(ctx, 'code mail', { to: email, text: mail.text.replace(code, '######') });
      expect(mail.text).toContain(`feedback window on ${new URL(site.origin).host}`);
      await f.locator('#wb-signin-code').fill(code);
      await f.locator('button[type=submit][form=wb-signin]').click();
      await f.locator('#wb-signed-in').waitFor({ timeout: 15_000 });
      const session = await frameSession(v);
      expect(session?.email).toBe(email);
      expect(session?.token).toMatch(/^fbrs_[A-Za-z0-9_-]{43}$/);
      signedInEmail = email;
      signedInToken = session?.token ?? '';
      // Signed in, the form has no email field: the session's address is sent.
      expect(await f.locator('#wb-email').count()).toBe(0);
      const reference = await sendReport(v, canary, randomPng());
      await f.getByText('You can follow it under Your reports.').waitFor({ timeout: 15_000 });
      expect(v.errors).toEqual([]);

      // A wrong code (the right one is used up): the one answer for every failure.
      const wrong = await reporterCall('POST', 'session', {
        body: { email, code: code === '000000' ? '000001' : '000000', parent: site.origin },
      });
      expect([wrong.status, (wrong.json?.error as { code?: string } | undefined)?.code]).toEqual([
        400,
        'code_refused',
      ]);

      const { report } = await filedReport(reference);
      note(ctx, 'filed signed in', { reference, reporter: report.submitted.reporter, status: report.status });
      expect(report.submitted.reporter).toMatchObject({ email, verified: true });

      // Control lists it for the reporter once the runtime published it (manager → feedback.reporters.publish).
      const listed = await waitUntil(
        'the report in control’s reporter list',
        async () => {
          const r = await reporterCall('GET', 'reports', { token: signedInToken });
          const rows = (r.json?.reports ?? []) as { reference: string; status: string; summary: unknown }[];
          return r.status === 200 && rows.some((x) => x.reference === reference) ? r.json : null;
        },
        90_000,
      );
      note(ctx, 'control lists', listed);
      expect(listed?.email).toBe(email);

      // The owner resolves it: control's list says fixed, and so does the frame's “Your reports”.
      const set = await api<{ status: string; report: Report }>(owner, 'feedback.setReportStatus', 'POST', {
        params: { burrow: w.slug, id: report.id },
        body: { status: 'resolved' },
      });
      expect(set.status).toBe('ok');
      const fixed = await waitUntil(
        'fixed at control',
        async () => {
          const r = await reporterCall('GET', 'reports', { token: signedInToken });
          const rows = (r.json?.reports ?? []) as { reference: string; status: string; summary: unknown }[];
          const row = rows.find((x) => x.reference === reference);
          return row?.status === 'fixed' ? row : null;
        },
        90_000,
      );
      note(ctx, 'fixed at control', fixed);
      expect(fixed.summary).toBeNull();
      await f.getByRole('button', { name: 'Your reports' }).click();
      const row = f.locator('li.report', { hasText: reference });
      await row.locator('.report-status[data-status="fixed"]').waitFor({ timeout: 15_000 });
      expect((await row.locator('.report-status').innerText()).trim()).toBe('Fixed');
      await v.context.close();
      expect(logsContaining(email)).toEqual([]);
    },
  );

  it.skipIf(!reporters)(
    '7 signed out, a report is still filed, unverified; the old session is signed out',
    async (ctx) => {
      needsReporters(ctx);
      if (!signedInToken) blocked(ctx, 'whombat-appliance/o-feedback-reporters', 'no session from step 6');
      const out = await reporterCall('DELETE', 'session', { token: signedInToken });
      expect(out.status).toBe(204);
      const gone = await reporterCall('GET', 'reports', { token: signedInToken });
      expect([gone.status, (gone.json?.error as { code?: string } | undefined)?.code]).toEqual([
        401,
        'signed_out',
      ]);
      const canary = `canary-${randomBytes(6).toString('hex')} — totals round the wrong way`;
      const v = await visit(site.origin);
      const reference = await sendReport(v, canary, randomPng(), signedInEmail);
      expect(v.errors).toEqual([]);
      await v.context.close();
      const { report } = await filedReport(reference);
      note(ctx, 'filed signed out', { reference, reporter: report.submitted.reporter });
      expect(report.submitted.reporter).toMatchObject({ email: signedInEmail, verified: false });
    },
  );

  it('8 a drop from another origin is 404; intake off withdraws the card', async (ctx) => {
    if (skip || !siteKey)
      blocked(ctx, 'whombat-appliance/o-feedback-environment', skip ?? 'no site from step 1');
    const body = Buffer.alloc(64, 1);
    const post = (origin: string | null) =>
      fetch(dropUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...(origin ? { origin } : {}) },
        body,
      });
    const evil = await post('https://evil.example');
    expect(evil.status).toBe(404);
    expect(((await evil.json()) as { error: { code: string } }).error.code).toBe('unavailable');
    expect((await post(null)).status).toBe(404);
    const off = await api<{ status: string; integration: Integration }>(owner, 'feedback.setIntake', 'POST', {
      params: { burrow: w.slug, id: integration.id },
      body: { enabled: false },
    });
    expect(off.integration.intake).toBe('disabled');
    const gone = await waitUntil('the card withdrawn', async () => {
      const r = await fetch(cardUrl(), { headers: { origin: embed } });
      return r.status === 404 ? r : null;
    });
    const postAfter = await post(embed);
    note(ctx, 'withdrawn', { card: gone.status, drop: postAfter.status });
    expect(postAfter.status).toBe(404);
    expect(await controlDrops()).toEqual([]);
  });
});
