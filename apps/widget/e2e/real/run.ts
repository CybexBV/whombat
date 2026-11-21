/**
 * Whombat Feedback end to end against a **real** Whombat: the server in production mode on a
 * throwaway database with the seed world, an integration created through the internal API by the seeded owner,
 * websites on other origins under strict Content-Security-Policies, and real Chromium. Nothing on the server side
 * is stubbed: reports are checked in Postgres and through the internal API as a channel member and an outsider.
 *
 *   pnpm --filter @whombat/widget e2e:real [--shots] [--base-port 4910] [--only <text>]
 *
 * Ports: Whombat on `http://localhost:<base>`, websites on `http://127.0.0.1:<base+1…+5>` (a different origin), a
 * relay on +6, a dead port +7 and the `WHOMBAT_FEEDBACK=off` server on +8. The widget is built first (and the web
 * app when `apps/web/dist` is missing). `--shots` writes `apps/widget/screenshots/real/*.png`. The database is
 * dropped and every server stopped however the run ends. Logs: `tmp/e2e-feedback/`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Browser, BrowserContext, Frame, Page, Request } from '@playwright/test';
import {
  attrOf,
  axeFrame,
  clickShadow,
  exists,
  focusInWidget,
  frameOf,
  rectOf,
  shadow,
  textOf,
  until,
  waitForForm,
} from '../browser';
import { WIDGET_ROOT } from '../servers';
import { type Site, startRelay, startSite } from './site';
import {
  createDatabase,
  type Database,
  LOG_DIR,
  newSecrets,
  productionEnv,
  REPO,
  SERVER_REPO,
  type Session,
  Whombat,
} from './whombat';

const requireWeb = createRequire(join(WIDGET_ROOT, '..', 'web', 'package.json'));
const { chromium } = requireWeb('@playwright/test') as typeof import('@playwright/test');
const { PNG } = createRequire(join(SERVER_REPO, 'apps/server/package.json'))(
  'pngjs',
) as typeof import('pngjs');
const { exampleServer } = (await import(join(REPO, 'examples/feedback/serve.mjs'))) as {
  exampleServer(example: string, options: { whombat: string; site: string }): import('node:http').Server;
};

const { values: args } = parseArgs({
  options: {
    shots: { type: 'boolean' },
    'base-port': { type: 'string', default: '4910' },
    only: { type: 'string' },
    /** An unpacked release (`pnpm package`, then tar -x): its server instead of the checkout's. */
    'app-dir': { type: 'string' },
  },
});
const APP_DIR = args['app-dir'] ? resolve(args['app-dir']) : null;
const BASE = Number(args['base-port']);
const PORT = {
  whombat: BASE,
  host: BASE + 1,
  foreign: BASE + 2,
  plain: BASE + 3,
  spa: BASE + 4,
  lumio: BASE + 5,
  relay: BASE + 6,
  dead: BASE + 7,
  off: BASE + 8,
};
const SHOTS = join(WIDGET_ROOT, 'screenshots', 'real');
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const BURROW = 'burrow-hq';
const PRODUCT = 'Acme Shop';
const REPORTS_PATH = /\/embed\/v1\/sites\/fbs_[A-Za-z0-9]{24}\/reports$/;
const THIRD_PARTY_COOKIE_FLAG = '--test-third-party-cookie-phaseout';
type FeedbackWindow = { WhombatFeedback: import('@whombat/core/feedback').WhombatFeedbackApi };

// ------------------------------------------------------------------------------------------------------------
// State and cleanup

const cleanups: (() => Promise<void>)[] = [];
let cleaning: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    for (const fn of cleanups.reverse()) await fn().catch((err: unknown) => console.error('cleanup:', err));
  })();
  return cleaning;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void cleanup().then(() => process.exit(130));
  });

let whombat: Whombat;
let db: Database;
let owner: Session;
let member: Session;
let outsider: Session;
let channelId: string;
let siteId: string;
let snippets: { basic: string; custom: string; csp: string };
let host: Site;
let foreign: Site;
const examples: Record<'plain' | 'spa' | 'lumio', string> = { plain: '', spa: '', lumio: '' };
let browser: Browser;

const results: string[] = [];
const failures: string[] = [];

async function step(name: string, fn: (track: (c: BrowserContext) => BrowserContext) => Promise<void>) {
  if (args.only && !name.toLowerCase().includes(args.only.toLowerCase())) return;
  const contexts: BrowserContext[] = [];
  const started = Date.now();
  try {
    await fn((c) => {
      contexts.push(c);
      return c;
    });
    results.push(`ok   ${name} (${Date.now() - started} ms)`);
    process.stdout.write(`ok   ${name} (${Date.now() - started} ms)\n`);
  } catch (err) {
    results.push(`FAIL ${name}`);
    failures.push(`${name}\n${err instanceof Error ? err.stack : String(err)}`);
    process.stdout.write(`FAIL ${name}\n${err instanceof Error ? err.stack : String(err)}\n`);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
}

function note(line: string): void {
  process.stdout.write(`     ${line}\n`);
}

// ------------------------------------------------------------------------------------------------------------
// Helpers

/** A 640×400 PNG with a few shapes (a plausible screenshot, and a thumbnail worth looking at). */
function screenshotPng(): Buffer {
  const png = new PNG({ width: 640, height: 400 });
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      const bar = y < 48;
      const card = x > 40 && x < 600 && y > 80 && y < 180;
      png.data[i] = bar ? 40 : card ? 255 : 245;
      png.data[i + 1] = bar ? 37 : card ? 255 : 240;
      png.data[i + 2] = bar ? 33 : card ? 255 : 232;
      png.data[i + 3] = 255;
      if (x > 60 && x < 300 && y > 110 && y < 126) png.data[i] = 200;
    }
  return PNG.sync.write(png);
}
const SCREENSHOT = screenshotPng();

interface Opened {
  context: BrowserContext;
  page: Page;
  errors: string[];
  requests: Request[];
}

async function open(
  track: (c: BrowserContext) => BrowserContext,
  url: string,
  opts: {
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    mobile?: boolean;
    in?: Browser;
    context?: BrowserContext;
  } = {},
): Promise<Opened> {
  const context =
    opts.context ??
    track(
      await (opts.in ?? browser).newContext({
        viewport: opts.viewport ?? DESKTOP,
        colorScheme: opts.colorScheme ?? 'light',
        deviceScaleFactor: 1,
        ...(opts.mobile ? { hasTouch: true, isMobile: true } : {}),
      }),
    );
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: Request[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('request', (r) => requests.push(r));
  await page.goto(url);
  return { context, page, errors, requests };
}

async function shot(page: Page, name: string): Promise<void> {
  if (!args.shots) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const isReportPost = (r: Request) => r.method() === 'POST' && REPORTS_PATH.test(new URL(r.url()).pathname);

async function openByLauncher(page: Page): Promise<Frame> {
  await until('the launcher', () => exists(page, 'button.launcher'));
  await clickShadow(page, 'button.launcher');
  return waitForForm(page);
}

async function fillBug(f: Frame, description: string, withScreenshot = false): Promise<void> {
  await f.locator('#wb-type-bug').check();
  await f.locator('#wb-description').fill(description);
  await f.locator('#wb-expected').fill('The total matches the sum of the items.');
  await f.locator('#wb-name').fill('Ann Visitor');
  await f.locator('#wb-email').fill('ann@example.com');
  if (withScreenshot) {
    await f
      .locator('input[type=file]')
      .setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: SCREENSHOT });
    await f.locator('.file img').waitFor();
  }
}

interface Sent {
  reference: string;
  status: number;
  body: Record<string, unknown>;
  request: Request;
}

/** Clicks Send (or runs `send`) and waits for the receipt; returns what the server answered. */
async function sendForReceipt(page: Page, f: Frame, send?: () => Promise<void>): Promise<Sent> {
  const response = page.waitForResponse((r) => isReportPost(r.request()), { timeout: 30_000 });
  await (send ? send() : f.locator('button[type=submit]').click());
  const res = await response;
  await f.locator('.receipt-title').waitFor();
  const reference = await f.locator('#wb-reference').innerText();
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.reference, reference, 'the receipt shows the server’s reference');
  return { reference, status: res.status(), body, request: res.request() };
}

async function counts() {
  const [row] = await db.sql<
    { accounts: number; people: number; principals: number; members: number; feedback: number }[]
  >`select
      (select count(*)::int from accounts) as accounts,
      (select count(*)::int from principals where kind = 'person') as people,
      (select count(*)::int from principals) as principals,
      (select count(*)::int from conversation_members) as members,
      (select count(*)::int from principals where system = 'feedback') as feedback`;
  return row as NonNullable<typeof row>;
}

async function reportCount(): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from feedback_reports`;
  return row?.n ?? 0;
}

async function reportsWithSubmission(submissionId: string) {
  return db.sql<
    { reference: string }[]
  >`select reference from feedback_reports where submission_id = ${submissionId}`;
}

interface ApiMessage {
  id: string;
  authorId: string;
  text: string;
  mentions: string[];
  card: { kind: string; reportId?: string; reference?: string; summary?: string } | null;
  attachments: { id: string; url: string; contentType: string }[];
}
interface ApiReport {
  id: string;
  reference: string;
  type: 'bug' | 'feature';
  rootMessageId: string;
  conversationId: string;
  submitted: {
    description: string;
    reporter: { name: string | null; email: string | null };
    context: {
      page: { url: string; title: string | null } | null;
      browser: { name: string } | null;
      app: { version: string | null; environment: string | null } | null;
      custom: Record<string, unknown>;
      references: string[];
    };
    attachments: { id: string; url: string; contentType: string; name: string }[];
  };
  assessment: { state: string };
}

/** The report as a member of its channel sees it: the root message in the channel (with its card) and the detail. */
async function internalReport(reference: string): Promise<{ message: ApiMessage; report: ApiReport }> {
  const list = await member.get<{ messages: ApiMessage[] }>(
    `/burrows/${BURROW}/conversations/${channelId}/messages?limit=50`,
  );
  const message = list.messages.find((m) => m.card?.kind === 'report' && m.card.reference === reference);
  assert.ok(message, `the root message of ${reference} is in the channel`);
  const [principal] = await db.sql<{ id: string }[]>`select id from principals where system = 'feedback'`;
  assert.equal(message.authorId, principal?.id, 'posted by the Feedback principal');
  assert.deepEqual(message.mentions, [], 'mentions nobody');
  const { report } = await member.get<{ report: ApiReport }>(
    `/burrows/${BURROW}/feedback/reports/${message.card?.reportId}`,
  );
  assert.equal(report.reference, reference);
  assert.equal(report.rootMessageId, message.id);
  assert.equal(report.conversationId, channelId);
  assert.equal(
    message.text,
    `${report.type === 'bug' ? 'Bug report' : 'Feature request'} ${reference} · ${PRODUCT}`,
  );
  return { message, report };
}

async function assertOutsiderBlind(report: ApiReport): Promise<void> {
  const r = await outsider.call('GET', `/burrows/${BURROW}/feedback/reports/${report.id}`);
  assert.equal(r.status, 404, 'a non-member gets 404 for the report');
  const m = await outsider.call('GET', `/burrows/${BURROW}/messages/${report.rootMessageId}`);
  assert.ok(m.status === 404 || m.status === 403, `a non-member can’t read the root message (${m.status})`);
}

async function previewText(f: Frame): Promise<string> {
  const details = f.locator('details.preview');
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
    await f.locator('.preview summary').click();
  // The frame asks the loader for fresh context when it opens; give the answer a moment.
  await f.waitForTimeout(300);
  return f.locator('.preview-list').innerText();
}

const closed = (page: Page) =>
  page.waitForFunction(() => !(window as unknown as FeedbackWindow).WhombatFeedback.isOpen());

async function frameActive(f: Frame): Promise<string> {
  return f.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'body';
    const text = (a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 24);
    return `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}${text ? ` “${text}”` : ''}`;
  });
}

/** Presses Tab until the frame's Send button has focus (keyboard-only sending). */
async function tabToSend(page: Page, f: Frame): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (await f.evaluate(() => document.activeElement?.matches('button[type=submit]') ?? false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Send never got focus');
}

function instanceOf(src: string | null): string {
  const instance = new URLSearchParams((src ?? '').split('#')[1] ?? '').get('instance');
  assert.ok(instance, 'the frame URL carries an instance nonce');
  return instance;
}

// ------------------------------------------------------------------------------------------------------------
// Setup

function build(): void {
  const widget = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build.ts'], {
    cwd: WIDGET_ROOT,
    stdio: 'inherit',
  });
  if (widget.status !== 0) throw new Error('the widget build failed');
  if (!existsSync(join(REPO, 'apps/web/dist/index.html'))) {
    const web = spawnSync('pnpm', ['--filter', '@whombat/web', 'build:prod'], {
      cwd: REPO,
      stdio: 'inherit',
    });
    if (web.status !== 0) throw new Error('the web build failed');
  }
}

async function setup(): Promise<void> {
  if (!APP_DIR) build();
  const secrets = newSecrets();
  cleanups.push(async () => rmSync(secrets.home, { recursive: true, force: true }));
  const bootstrapEnv = productionEnv(PORT.whombat, '', secrets);
  db = await createDatabase(bootstrapEnv);
  cleanups.push(() => db.drop());
  note(`database ${db.name}`);
  whombat = new Whombat(PORT.whombat, productionEnv(PORT.whombat, db.url, secrets, APP_DIR), APP_DIR);
  cleanups.push(() => whombat.stop());
  await whombat.start();
  note(
    `Whombat (NODE_ENV=production${APP_DIR ? `, release ${APP_DIR}` : ''}) on ${whombat.origin}, log ${whombat.logFile}`,
  );

  // The server serves exactly the build it should (the release's widget/, or the checkout's apps/widget/dist).
  const dist = join(APP_DIR ? join(APP_DIR, 'widget') : join(WIDGET_ROOT, 'dist'), 'v1');
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as {
    frame: { js: string; css: string };
  };
  for (const [path, file, type, corp] of [
    ['widget.js', 'widget.js', 'application/javascript; charset=utf-8', 'cross-origin'],
    [manifest.frame.js, manifest.frame.js, 'application/javascript; charset=utf-8', 'same-origin'],
    [manifest.frame.css, manifest.frame.css, 'text/css; charset=utf-8', 'same-origin'],
  ] as const) {
    const res = await fetch(`${whombat.origin}/embed/v1/${path}`);
    assert.equal(res.status, 200, path);
    assert.ok(
      Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(dist, file))),
      `${path}: the built bytes`,
    );
    assert.equal(res.headers.get('content-type'), type);
    assert.equal(res.headers.get('cross-origin-resource-policy'), corp);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
      res.headers.get('cache-control'),
      path === 'widget.js' ? 'public, max-age=300' : 'public, max-age=31536000, immutable',
    );
  }
  note(
    `served ${dist}: widget.js, ${manifest.frame.js}, ${manifest.frame.css} (bytes, types, caching checked)`,
  );
  const [channel] = await db.sql<{ id: string }[]>`
    select id from conversations where slug = 'billing-v2' and kind = 'channel'`;
  assert.ok(channel, 'the seed world has #billing-v2');
  channelId = channel.id;
  const membership = await db.sql<{ email: string; member: boolean }[]>`
    select a.email, exists(select 1 from conversation_members m where m.conversation_id = ${channelId}
      and m.principal_id = p.id) as member
    from principals p join accounts a on a.id = p.account_id
    where a.email in ('mara@burrowhq.example', 'priya@burrowhq.example', 'tom@burrowhq.example') order by a.email`;
  assert.deepEqual(
    membership.map((m) => [m.email, m.member]),
    [
      ['mara@burrowhq.example', true],
      ['priya@burrowhq.example', true],
      ['tom@burrowhq.example', false],
    ],
    'mara (owner) and priya are in #billing-v2, tom isn’t',
  );
  owner = await whombat.signIn('mara@burrowhq.example');
  member = await whombat.signIn('priya@burrowhq.example');
  outsider = await whombat.signIn('tom@burrowhq.example');
}

const origins = () => ({
  host: `http://127.0.0.1:${PORT.host}`,
  plain: `http://127.0.0.1:${PORT.plain}`,
  spa: `http://127.0.0.1:${PORT.spa}`,
  lumio: `http://127.0.0.1:${PORT.lumio}`,
});

async function createIntegration(): Promise<void> {
  const o = origins();
  const created = await owner.call<{ status: string; integration: { id: string; siteId: string } }>(
    'POST',
    `/burrows/${BURROW}/feedback/integrations`,
    {
      name: 'Acme Shop website',
      productLabel: PRODUCT,
      allowedOrigins: [o.host, o.plain, o.spa, o.lumio],
      channelId,
      agentId: null,
      repoId: null,
      reportTypes: ['bug', 'feature'],
      privacyUrl: 'https://example.com/privacy',
      redactPaths: ['/orders/*'],
      contextKeys: ['page'],
      // Every request of this suite comes from 127.0.0.1: the per-source default (5/h) would stop it.
      limits: { reportsPerHour: 1000, reportsPerDay: 10_000, perSourcePerHour: 100 },
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.status, 'ok');
  siteId = created.json.integration.siteId;
  const detail = await owner.get<{ snippets: typeof snippets }>(
    `/burrows/${BURROW}/feedback/integrations/${created.json.integration.id}`,
  );
  snippets = detail.snippets;
  assert.ok(snippets.basic.includes(`src="${whombat.origin}/embed/v1/widget.js"`), snippets.basic);
  assert.equal(snippets.csp, `script-src ${whombat.origin}; frame-src ${whombat.origin};`);
  note(`integration ${created.json.integration.id}, site ${siteId}`);
}

async function startSites(): Promise<void> {
  const customScript = () => {
    const custom = snippets.custom;
    return custom.slice(custom.indexOf('<script'), custom.indexOf('</script>') + '</script>'.length);
  };
  host = await startSite({
    port: PORT.host,
    whombat: whombat.origin,
    foreign: `http://127.0.0.1:${PORT.foreign}`,
    snippet: () => snippets.basic,
    customScript,
    siteId: () => siteId,
  });
  cleanups.push(() => host.close());
  foreign = await startSite({
    port: PORT.foreign,
    whombat: whombat.origin,
    snippet: () => snippets.basic,
    customScript,
    siteId: () => siteId,
  });
  cleanups.push(() => foreign.close());
  for (const name of ['plain', 'spa', 'lumio'] as const) {
    const dir = name === 'plain' ? 'plain-html' : name;
    const server = exampleServer(dir, { whombat: whombat.origin, site: siteId });
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(PORT[name], '127.0.0.1', () => ok());
    });
    cleanups.push(
      () =>
        new Promise((ok) => {
          server.closeAllConnections();
          server.close(() => ok());
        }),
    );
    examples[name] = `http://127.0.0.1:${PORT[name]}`;
  }
}

// ------------------------------------------------------------------------------------------------------------
// Scenarios

async function scenarios(): Promise<void> {
  const before = await counts();
  await createIntegration();
  await startSites();
  const W = whombat.origin;

  await step(
    '1 script-only setup: generated snippet under a strict CSP, mouse and keyboard, bug with screenshot and feature request',
    async (track) => {
      const { page, errors, requests } = await open(track, `${host.origin}/plain`);
      const raw = await (await page.request.get(`${host.origin}/plain`)).text();
      assert.ok(raw.includes(snippets.basic), 'the page carries the generated snippet verbatim');
      const csp = await (await page.request.get(`${host.origin}/plain`)).headers()['content-security-policy'];
      assert.equal(
        csp,
        `default-src 'self'; script-src ${W}; frame-src ${W}; style-src 'self'; img-src 'self'`,
      );
      await until('the launcher', () => exists(page, 'button.launcher'));
      assert.equal(await textOf(page, 'button.launcher'), 'Feedback');
      assert.equal(await exists(page, 'iframe'), false, 'no frame before the first open');

      // Mouse: a bug report with a screenshot.
      const f = await openByLauncher(page);
      await fillBug(f, 'The invoice total on the orders page is off by one cent.', true);
      const bug = await sendForReceipt(page, f);
      assert.equal(bug.status, 201);
      note(`bug report ${bug.reference}`);

      // (3) The receipt reveals nothing: exactly reference and receivedAt; no cookies, no CORS, no links.
      assert.deepEqual(Object.keys(bug.body).sort(), ['receivedAt', 'reference']);
      const response = await bug.request.response();
      const resHeaders = (await response?.allHeaders()) ?? {};
      assert.equal(resHeaders['set-cookie'], undefined, 'no cookie set');
      assert.equal(resHeaders['access-control-allow-origin'], undefined, 'no CORS');
      const reqHeaders = await bug.request.allHeaders();
      assert.equal(reqHeaders.cookie, undefined, 'no cookie sent');
      assert.equal(reqHeaders.origin, W, 'sent by the frame, same-origin');
      const frameDom = await f.evaluate(() => ({
        html: document.documentElement.outerHTML,
        links: [...document.querySelectorAll('a')].map((a) => a.href),
      }));
      assert.deepEqual(frameDom.links, [], 'the receipt links nowhere');
      assert.doesNotMatch(
        frameDom.html,
        /\/api\/v1|burrow-hq|billing-v2|\b(fbr|fbi|msg|att|cnv|prn)_[A-Za-z0-9_-]{4,}/,
      );

      await f.locator('.foot button', { hasText: 'Close' }).click();
      await closed(page);
      assert.ok(await focusInWidget(page), 'focus back on the launcher');

      // Keyboard only: Tab from the page to the launcher, Enter, arrow to “Suggest an idea”, type, Tab to Send.
      await page.locator('#host-input').focus();
      await page.keyboard.press('Tab');
      assert.ok(await focusInWidget(page), 'the launcher follows the page in the tab order');
      await page.keyboard.press('Enter');
      const f2 = await waitForForm(page);
      assert.equal(await f2.locator('#wb-description').inputValue(), '', 'a fresh form after a receipt');
      await until('focus on the type', async () => (await frameActive(f2)).startsWith('input#wb-type-bug'));
      await page.keyboard.press('ArrowRight');
      assert.equal(await f2.locator('#wb-type-feature').isChecked(), true);
      await page.keyboard.press('Tab');
      assert.equal(await frameActive(f2), 'textarea#wb-description');
      await page.keyboard.type('Please add a CSV export of the order history.');
      await tabToSend(page, f2);
      const feature = await sendForReceipt(page, f2, () => page.keyboard.press('Enter'));
      note(`feature request ${feature.reference}`);
      assert.equal(
        requests.filter(isReportPost).length,
        2,
        'one POST per report (no preflight, nothing else)',
      );

      // Internally: the root messages with their report cards, the details, the screenshot.
      const { message, report } = await internalReport(bug.reference);
      assert.equal(report.type, 'bug');
      assert.equal(report.submitted.description, 'The invoice total on the orders page is off by one cent.');
      assert.deepEqual(report.submitted.reporter, { name: 'Ann Visitor', email: 'ann@example.com' });
      assert.equal(report.submitted.context.page?.url, `${host.origin}/plain`);
      assert.equal(report.submitted.context.page?.title, 'Orders · Acme Shop');
      assert.equal(report.assessment.state, 'not_configured');
      assert.equal(message.card?.summary?.startsWith('The invoice total'), true);
      assert.equal(report.submitted.attachments.length, 1);
      assert.deepEqual(
        message.attachments.map((a) => a.id),
        report.submitted.attachments.map((a) => a.id),
        'the screenshot is on the root message',
      );
      const attachment = report.submitted.attachments[0] as ApiReport['submitted']['attachments'][number];
      const got = await member.fetchRaw(attachment.url);
      assert.equal(got.status, 200, 'a member reads the screenshot');
      assert.equal(got.headers.get('content-type'), 'image/png');
      const decoded = PNG.sync.read(Buffer.from(await got.arrayBuffer()));
      assert.deepEqual([decoded.width, decoded.height], [640, 400], 're-encoded, same picture');
      // Stored like any attachment, so `whombat backup` (every public table, and every `ready` attachment's blob
      // checked against its hash) carries it.
      const [blob] = await db.sql<{ state: string; sha256: string | null; blob_key: string | null }[]>`
        select state, sha256, blob_key from attachments where id = ${attachment.id}`;
      assert.equal(blob?.state, 'ready');
      assert.ok(blob?.sha256 && blob.blob_key, 'a stored blob with its hash');
      assert.ok(
        existsSync(join(whombat.env.WHOMBAT_HOME as string, 'files', blob.blob_key)),
        'the bytes are under files/ of this run’s home',
      );
      const denied = await outsider.fetchRaw(attachment.url);
      assert.equal(denied.status, 404, 'a non-member gets 404 for the screenshot');
      const anonymous = await fetch(new URL(attachment.url, W));
      assert.ok(anonymous.status === 401 || anonymous.status === 404, `no public read (${anonymous.status})`);
      await assertOutsiderBlind(report);
      const featureReport = await internalReport(feature.reference);
      assert.equal(featureReport.report.type, 'feature');
      assert.equal(
        featureReport.report.submitted.description,
        'Please add a CSV export of the order history.',
      );
      assert.deepEqual(errors, []);
    },
  );

  await step('1b the plain-html example (examples/feedback) works as shipped', async (track) => {
    const { page, errors } = await open(track, `${examples.plain}/`);
    const f = await openByLauncher(page);
    await f.locator('#wb-description').fill('Sent from the plain example.');
    const sent = await sendForReceipt(page, f);
    const { report } = await internalReport(sent.reference);
    assert.equal(report.submitted.context.page?.url, `${examples.plain}/`);
    assert.deepEqual(errors, []);
  });

  await step('3 receipt replay: the same submission answers 200 with the same two fields only', async () => {
    // Straight at the public endpoint (a non-browser caller): replaying a stored submission.
    const [row] = await db.sql<{ submission_id: string }[]>`
      select submission_id from feedback_reports order by created_at limit 1`;
    assert.ok(row);
    const res = await fetch(`${W}/embed/v1/sites/${siteId}/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: W },
      body: JSON.stringify({
        submissionId: row.submission_id,
        parentOrigin: host.origin,
        type: 'bug',
        description: 'A different text for the same submission id.',
      }),
    });
    assert.equal(res.status, 409, 'same id, different content: conflict without detail');
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'conflict');
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  });

  await step(
    '4 retries: double click, a lost request, a lost response, offline then online',
    async (track) => {
      const { context, page, requests } = await open(track, `${host.origin}/plain`);
      // Double click.
      let f = await openByLauncher(page);
      await f.locator('#wb-description').fill('Double-clicked Send.');
      let n = await reportCount();
      const dbl = await sendForReceipt(page, f, () => f.locator('button[type=submit]').dblclick());
      await page.waitForTimeout(500);
      assert.equal(await reportCount(), n + 1, 'a double click stores one report');
      assert.equal(requests.filter(isReportPost).length, 1, 'and sends once');
      assert.equal(dbl.status, 201);

      // A request that never reaches the server.
      await f.locator('.foot button', { hasText: 'Send another' }).click();
      await f.locator('#wb-description').fill('The first attempt is lost on the way.');
      await f
        .locator('input[type=file]')
        .setInputFiles({ name: 'lost.png', mimeType: 'image/png', buffer: SCREENSHOT });
      await f.locator('.file img').waitFor();
      let calls = 0;
      await context.route(REPORTS_PATH, async (route) =>
        calls++ === 0 ? route.abort('failed') : route.continue(),
      );
      n = await reportCount();
      await f.locator('button[type=submit]').click();
      await f
        .locator('.alert', { hasText: 'Your report wasn’t sent. Check your connection and try again.' })
        .waitFor();
      assert.equal(await f.locator('#wb-description').inputValue(), 'The first attempt is lost on the way.');
      assert.equal(await f.locator('.file').count(), 1, 'the screenshot is still attached');
      assert.equal(await reportCount(), n, 'nothing stored');
      const lost = await sendForReceipt(page, f, () =>
        f.locator('.alert button', { hasText: 'Try again' }).click(),
      );
      await context.unrouteAll();
      const lostIds = requests
        .filter(isReportPost)
        .slice(-2)
        .map((r) => r.postDataJSON().submissionId as string);
      assert.equal(lostIds[0], lostIds[1], 'the retry reuses the submission id');
      assert.deepEqual(
        (await reportsWithSubmission(lostIds[0] as string)).map((r) => r.reference),
        [lost.reference],
      );
      assert.equal(await reportCount(), n + 1);

      // A response that never comes back: the server committed, the browser saw a network error.
      await f.locator('.foot button', { hasText: 'Send another' }).click();
      await f.locator('#wb-description').fill('The answer to the first attempt is lost.');
      calls = 0;
      let committed: { status: number; reference: string } | null = null;
      await context.route(REPORTS_PATH, async (route) => {
        if (calls++ > 0) return route.continue();
        const upstream = await route.fetch();
        committed = {
          status: upstream.status(),
          reference: ((await upstream.json()) as Sent['body']).reference as string,
        };
        await route.abort('failed');
      });
      n = await reportCount();
      await f.locator('button[type=submit]').click();
      await f.locator('.alert', { hasText: 'Check your connection' }).waitFor();
      assert.equal(committed?.status, 201, 'the first attempt was stored');
      assert.equal(await reportCount(), n + 1);
      const replay = await sendForReceipt(page, f, () =>
        f.locator('.alert button', { hasText: 'Try again' }).click(),
      );
      await context.unrouteAll();
      assert.equal(replay.status, 200, 'the retry is answered as a replay');
      assert.equal(replay.reference, committed?.reference, 'with the stored report’s reference');
      assert.deepEqual(Object.keys(replay.body).sort(), ['receivedAt', 'reference']);
      assert.equal(await reportCount(), n + 1, 'still one report');

      // Offline, then online.
      await f.locator('.foot button', { hasText: 'Send another' }).click();
      await f.locator('#wb-description').fill('Sent while the train was in a tunnel.');
      n = await reportCount();
      await context.setOffline(true);
      await f.locator('button[type=submit]').click();
      await f.locator('.alert', { hasText: 'Check your connection' }).waitFor();
      assert.equal(await f.locator('#wb-description').inputValue(), 'Sent while the train was in a tunnel.');
      assert.equal(await reportCount(), n);
      await context.setOffline(false);
      const online = await sendForReceipt(page, f, () =>
        f.locator('.alert button', { hasText: 'Try again' }).click(),
      );
      assert.equal(online.status, 201);
      assert.equal(await reportCount(), n + 1);
      f = await frameOf(page);
      await internalReport(online.reference);
    },
  );

  await step(
    '5 custom launcher: the site’s trigger and WhombatFeedback.open(), setContext in the preview and the report',
    async (track) => {
      const { page, errors } = await open(track, `${host.origin}/custom`);
      await page.waitForFunction(() => 'WhombatFeedback' in window);
      assert.equal(
        await page.locator('whombat-feedback').count(),
        0,
        'no floating launcher, nothing mounted yet',
      );
      const api = await page.evaluate(() => {
        const wf = (window as unknown as FeedbackWindow).WhombatFeedback;
        return { version: wf.version, isOpen: wf.isOpen(), keys: Object.keys(wf).sort() };
      });
      assert.deepEqual(api.keys, ['close', 'destroy', 'isOpen', 'open', 'ready', 'setContext', 'version']);
      assert.equal(api.isOpen, false);
      await page.locator('#suggest').click();
      let f = await waitForForm(page);
      assert.equal(await f.locator('#wb-type-feature').isChecked(), true, 'data-whombat-feedback="feature"');
      const preview = await previewText(f);
      assert.match(preview, /version 2\.3\.1 · staging/);
      assert.match(preview, /req_123/);
      await page.keyboard.press('Escape');
      await closed(page);
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        'suggest',
        'focus back on the trigger',
      );

      // The site's own script calls WhombatFeedback.open().
      await page.locator('#menu-feedback').click();
      f = await waitForForm(page);
      await f.locator('#wb-description').fill('Dark mode for the settings page, please.');
      const sent = await sendForReceipt(page, f);
      const { report } = await internalReport(sent.reference);
      assert.deepEqual(report.submitted.context.app, {
        version: '2.3.1',
        environment: 'staging',
        build: null,
      });
      assert.deepEqual(report.submitted.context.references, ['req_123']);
      assert.equal(report.submitted.context.page?.url, `${host.origin}/custom`);
      await f.locator('.foot button', { hasText: 'Close' }).click();
      await closed(page);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'menu-feedback');
      assert.deepEqual(errors, []);
    },
  );

  await step(
    '5b the Lumio example: own Feedback button, page name and request id, no resource ids',
    async (track) => {
      const { page, errors } = await open(track, `${examples.lumio}/computers`);
      await page.getByRole('link', { name: 'WS-0142 (Windows 11)' }).click();
      await page.locator('#refresh').click();
      assert.equal(await page.locator('whombat-feedback').count(), 0);
      await page.locator('#feedback-button').click();
      const f = await waitForForm(page);
      const preview = await previewText(f);
      assert.match(preview, new RegExp(`${examples.lumio}/computers/:id`));
      assert.match(preview, /page\s+computers/);
      assert.match(preview, /version 2\.3\.1 · staging/);
      assert.match(preview, /req_[a-z0-9]{4,}/);
      assert.doesNotMatch(preview, /3f2a9c1e/);
      await f.locator('#wb-description').fill('The computer page shows the wrong OS version.');
      const sent = await sendForReceipt(page, f);
      const { report } = await internalReport(sent.reference);
      assert.equal(report.submitted.context.page?.url, `${examples.lumio}/computers/:id`);
      assert.deepEqual(report.submitted.context.custom, { page: 'computers' });
      assert.equal(report.submitted.context.references.length, 1);
      assert.match(report.submitted.context.references[0] as string, /^req_[a-z0-9]+$/);
      // The menu item opens a feature request.
      await f.locator('.foot button', { hasText: 'Close' }).click();
      await closed(page);
      await page.locator('#suggest').click();
      await until('feature preselected', () =>
        frameOf(page).then((fr) => fr.locator('#wb-type-feature').isChecked()),
      );
      assert.deepEqual(errors, []);
    },
  );

  await step(
    '6 SPA example: the report has the current route, no query or fragment, /orders/123 redacted',
    async (track) => {
      const { page, errors } = await open(track, `${examples.spa}/`);
      await page.getByRole('link', { name: 'Order 123' }).click();
      assert.equal(new URL(page.url()).pathname, '/orders/123');
      const f = await openByLauncher(page);
      let preview = await previewText(f);
      assert.match(preview, new RegExp(`Page\\s+${examples.spa}/orders/:id\\n`));
      assert.doesNotMatch(preview, /\/orders\/123/);
      assert.match(preview, /version 1\.4\.2 · production/);
      // Navigate while the panel is open.
      await page.getByRole('link', { name: 'Settings' }).click();
      assert.equal(page.url(), `${examples.spa}/settings?token=secret#notifications`);
      await f.locator('.preview summary').click(); // close…
      preview = await previewText(f); // …and reopen: fresh context
      assert.match(preview, new RegExp(`Page\\s+${examples.spa}/settings\\n`));
      assert.match(preview, /Page title\s+Settings · Acme Shop/);
      assert.doesNotMatch(preview, /token|secret|notifications/);
      await f.locator('#wb-description').fill('The settings page forgets my choice.');
      const settings = await sendForReceipt(page, f);
      assert.equal(
        (await internalReport(settings.reference)).report.submitted.context.page?.url,
        `${examples.spa}/settings`,
      );
      // Back to /orders/123 (popstate) without closing the panel; the poll picks it up.
      await f.locator('.foot button', { hasText: 'Send another' }).click();
      await page.goBack();
      assert.equal(new URL(page.url()).pathname, '/orders/123');
      await page.waitForTimeout(1300);
      await f.locator('#wb-description').fill('Order 123 shows the wrong address.');
      const order = await sendForReceipt(page, f);
      const stored = (await internalReport(order.reference)).report.submitted.context;
      assert.equal(stored.page?.url, `${examples.spa}/orders/:id`);
      assert.deepEqual(stored.app, { version: '1.4.2', environment: 'production', build: null });
      const [row] = await db.sql<{ context: string }[]>`
      select context::text as context from feedback_reports where reference = ${order.reference}`;
      assert.doesNotMatch(row?.context ?? '', /123|token|secret|notifications/);
      assert.deepEqual(errors, []);
    },
  );

  await step(
    '7 keyboard and focus: tab order, focus in and contained, Escape returns focus, axe',
    async (track) => {
      const { page, errors } = await open(track, `${host.origin}/plain`);
      await until('the launcher', () => exists(page, 'button.launcher'));
      await page.locator('#host-link').focus();
      await page.keyboard.press('Tab');
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        'host-input',
        'the page’s own order first',
      );
      await page.keyboard.press('Tab');
      assert.ok(await focusInWidget(page), 'then the launcher, last');
      await page.keyboard.press('Enter');
      const f = await waitForForm(page);
      await until('focus in the dialog', async () => (await frameActive(f)).startsWith('input#wb-type-bug'));
      const order: string[] = [await frameActive(f)];
      for (let i = 0; i < 24; i++) {
        await page.keyboard.press('Tab');
        assert.ok(await focusInWidget(page), `Tab ${i + 1} left the widget`);
        order.push(await frameActive(f));
      }
      note(`tab order: ${[...new Set(order)].join(' → ')}`);
      assert.ok(!order.includes('body'), 'focus never falls out to the frame body');
      assert.ok(order.filter((o) => o.startsWith('input#wb-type-bug')).length >= 2, 'Tab wraps around');
      for (const expected of [
        'textarea#wb-description',
        'input#wb-name',
        'input#wb-email',
        'button “Send”',
        'button “Cancel”',
      ])
        assert.ok(
          order.some((o) => o.startsWith(expected)),
          `${expected} is in the tab order`,
        );
      await page.keyboard.press('Shift+Tab');
      assert.ok(await focusInWidget(page), 'Shift+Tab stays inside too');
      await f.locator('.preview summary').click();
      assert.deepEqual(await axeFrame(page), [], 'axe: the form');
      await page.keyboard.press('Escape');
      await closed(page);
      assert.ok(await focusInWidget(page), 'Escape returns focus to the launcher');
      assert.equal(await attrOf(page, 'button.launcher', 'aria-expanded'), 'false');
      // Invalid form and receipt through axe too.
      await page.keyboard.press('Enter');
      const g = await waitForForm(page);
      await g.locator('button[type=submit]').click();
      assert.equal(await g.locator('#wb-description').getAttribute('aria-invalid'), 'true');
      assert.equal(await frameActive(g), 'textarea#wb-description', 'focus on the first problem');
      assert.deepEqual(await axeFrame(page), [], 'axe: validation errors');
      await g.locator('#wb-description').fill('Checking the receipt with axe.');
      await sendForReceipt(page, g);
      assert.equal((await frameActive(g)).startsWith('h2'), true, 'focus on the receipt heading');
      assert.deepEqual(await axeFrame(page), [], 'axe: the receipt');
      assert.deepEqual(errors, []);
    },
  );

  await step('8 themes and sizes: light, dark, auto, forced, 360×740; screenshots', async (track) => {
    const colours: Record<string, string> = {};
    for (const scheme of ['light', 'dark'] as const)
      for (const [label, viewport, mobile] of [
        ['desktop', DESKTOP, false],
        ['mobile', MOBILE, true],
      ] as const) {
        const { page, errors } = await open(track, `${host.origin}/plain`, {
          viewport,
          colorScheme: scheme,
          mobile,
        });
        await until('the launcher', () => exists(page, 'button.launcher'));
        await shot(page, `${label}-${scheme}-launcher`);
        const f = await openByLauncher(page);
        assert.equal(await f.locator('html').getAttribute('data-theme'), scheme, 'auto follows the system');
        colours[`${label}-${scheme}`] = await f.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        );
        const launcherBg = await shadow<string>(
          page,
          'button.launcher',
          'function () { return getComputedStyle(this).backgroundColor; }',
        );
        colours[`${label}-${scheme}-launcher`] = launcherBg ?? '';
        if (mobile) {
          const box = await rectOf(page, 'iframe');
          assert.deepEqual(
            box && [box.x, box.y, box.width, box.height],
            [0, 0, MOBILE.width, MOBILE.height],
            'a full-screen sheet',
          );
        } else {
          const box = await rectOf(page, '.panel');
          assert.ok(
            box && box.width === 400 && box.x + box.width === DESKTOP.width - 20,
            `panel ${JSON.stringify(box)}`,
          );
        }
        await fillBug(f, 'Search results are empty after filtering by date.', true);
        await f.locator('.body').evaluate((el) => el.scrollTo(0, 0));
        await shot(page, `${label}-${scheme}-form`);
        await f.locator('.preview summary').click();
        await f.locator('.body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await shot(page, `${label}-${scheme}-preview`);
        await sendForReceipt(page, f);
        await shot(page, `${label}-${scheme}-receipt`);
        assert.deepEqual(errors, []);
      }
    assert.notEqual(colours['desktop-light'], colours['desktop-dark'], 'the frame follows the theme');
    assert.notEqual(
      colours['desktop-light-launcher'],
      colours['desktop-dark-launcher'],
      'so does the launcher',
    );
    note(`frame background light ${colours['desktop-light']}, dark ${colours['desktop-dark']}`);

    // A forced theme wins over the system: data-theme="dark" on a light system and the reverse.
    for (const [forced, system] of [
      ['dark', 'light'],
      ['light', 'dark'],
    ] as const) {
      const { page } = await open(track, `${host.origin}/plain?theme=${forced}`, { colorScheme: system });
      const f = await openByLauncher(page);
      assert.equal(await f.locator('html').getAttribute('data-theme'), forced);
      assert.equal(
        await f.evaluate(() => getComputedStyle(document.body).backgroundColor),
        colours[`desktop-${forced}`],
      );
    }

    // 360 × 740: no horizontal overflow, 44 px targets.
    const { page } = await open(track, `${host.origin}/plain`, {
      viewport: { width: 360, height: 740 },
      mobile: true,
    });
    const f = await openByLauncher(page);
    await fillBug(f, 'Narrow phone.', true);
    await f.locator('.preview summary').click();
    const box = await rectOf(page, 'iframe');
    assert.deepEqual(box && [box.width, box.height], [360, 740]);
    const overflow = await f.evaluate(() =>
      [document.documentElement, ...document.querySelectorAll('.body *')]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
        .map((el) => el.className || el.tagName),
    );
    assert.deepEqual(overflow, [], 'no horizontal overflow at 360 px');
    const small = await f.evaluate(() =>
      [...document.querySelectorAll('button, .segment, summary')]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .filter((el) => el.getBoundingClientRect().height < 44)
        .map((el) => el.className || el.textContent),
    );
    assert.deepEqual(small, [], '44 px touch targets');
    await shot(page, 'mobile-360-filled');
  });

  await step(
    '9 restrictive host styles: the widget works, the page’s styles are untouched',
    async (track) => {
      const probe = () =>
        [
          ...document.querySelectorAll('html, body, main, h1, p, a, button, .overlay-top, .overlay-corner'),
        ].map((el) => {
          const s = getComputedStyle(el);
          return [
            el.tagName,
            el.className,
            s.display,
            s.position,
            s.zIndex,
            s.color,
            s.fontSize,
            s.margin,
            s.visibility,
            s.width,
            s.height,
            s.backgroundColor,
          ].join('|');
        });
      const without = await open(track, `${host.origin}/hostile?widget=0`);
      const expected = await without.page.evaluate(probe);
      const sheetsWithout = await without.page.evaluate(() => document.styleSheets.length);

      const { page, errors } = await open(track, `${host.origin}/hostile`);
      await page.waitForFunction(() => 'WhombatFeedback' in window);
      await until('the launcher', () => exists(page, 'button.launcher'));
      assert.deepEqual(await page.evaluate(probe), expected, 'the widget changed no host style');
      assert.equal(
        await page.evaluate(() => document.styleSheets.length),
        sheetsWithout,
        'no stylesheet added',
      );
      assert.equal(
        await page.evaluate(() => document.adoptedStyleSheets.length),
        0,
        'none adopted by the document',
      );
      const launcher = await rectOf(page, 'button.launcher');
      assert.ok(
        launcher && launcher.width >= 44 && launcher.height >= 44,
        `launcher ${JSON.stringify(launcher)}`,
      );
      const hit = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x as number, y as number)?.tagName,
        [(launcher?.x ?? 0) + (launcher?.width ?? 0) / 2, (launcher?.y ?? 0) + (launcher?.height ?? 0) / 2],
      );
      assert.equal(hit, 'WHOMBAT-FEEDBACK', 'the launcher is on top of the site’s overlay (z-index 999999)');
      const hostStyle = await page.evaluate(() => {
        const s = getComputedStyle(document.querySelector('whombat-feedback') as Element);
        return [s.display, s.position, s.visibility].join('|');
      });
      assert.equal(
        hostStyle,
        'block|static|visible',
        '`whombat-feedback { display: none !important }` loses to CSSOM',
      );
      const f = await openByLauncher(page); // a real mouse click at the launcher's centre
      const panel = await rectOf(page, '.panel');
      const frame = await rectOf(page, 'iframe');
      assert.ok(panel && panel.width === 400 && panel.height > 400, `panel ${JSON.stringify(panel)}`);
      assert.ok(frame && frame.width > 390 && frame.height > 400, `iframe ${JSON.stringify(frame)}`);
      await f.locator('#wb-description').fill('Sent from a page that resets everything.');
      const sent = await sendForReceipt(page, f);
      await internalReport(sent.reference);
      assert.deepEqual(await page.evaluate(probe), expected, 'still untouched with the panel open');
      await shot(page, 'desktop-light-hostile-css');
      assert.deepEqual(errors, []);
    },
  );

  await step(
    '10 hostile embedding: foreign origin refused, spoofed parent blocked, forged and malformed messages ignored',
    async (track) => {
      // (a) The same snippet on an origin that isn't allowed.
      {
        const { page, errors } = await open(track, `${foreign.origin}/plain`);
        const frameResponse = page.waitForResponse((r) => r.url().includes('/embed/v1/frame.html'));
        await until('the launcher', () => exists(page, 'button.launcher'));
        await clickShadow(page, 'button.launcher');
        const res = await frameResponse;
        assert.equal(res.status(), 404);
        assert.equal(res.headers()['content-security-policy']?.endsWith("frame-ancestors 'none'"), true);
        assert.equal(res.headers()['x-frame-options'], 'DENY');
        await until('the unavailable notice', () => exists(page, '.panel[data-state="unavailable"]'), 15_000);
        assert.equal(await textOf(page, '.notice p'), 'Feedback is unavailable right now.');
        for (const fr of page.frames().filter((x) => x !== page.mainFrame()))
          assert.equal(
            await fr
              .locator('#wb-root, .refused')
              .count()
              .catch(() => 0),
            0,
            `nothing rendered in ${fr.url()}`,
          );
        await page.locator('#host-input').fill('still typing');
        assert.equal(await page.locator('#host-input').inputValue(), 'still typing', 'the page stays usable');
        await clickShadow(page, 'button.close');
        await closed(page);
        assert.deepEqual(
          errors.filter((e) => e.startsWith('pageerror')),
          [],
        );
        note(`console on the refused page: ${errors.join(' | ') || '(nothing)'}`);
        // The server says the same for config and submissions naming that origin.
        const config = await fetch(
          `${W}/embed/v1/sites/${siteId}/config?parent=${encodeURIComponent(foreign.origin)}`,
        );
        assert.equal(config.status, 404);
        const post = await fetch(`${W}/embed/v1/sites/${siteId}/reports`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: W },
          body: JSON.stringify({
            submissionId: 'AAAAAAAAAAAAAAAAAAAAAA',
            parentOrigin: foreign.origin,
            type: 'bug',
            description: 'x',
          }),
        });
        assert.equal(post.status, 404, 'a submission naming a parent that isn’t allowed is refused');
        // And a page calling the API directly (its own Origin) is not the widget.
        const direct = await fetch(`${W}/embed/v1/sites/${siteId}/reports`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: host.origin },
          body: JSON.stringify({
            submissionId: 'BBBBBBBBBBBBBBBBBBBBBB',
            parentOrigin: host.origin,
            type: 'bug',
            description: 'x',
          }),
        });
        assert.equal(direct.status, 404, 'a browser Origin other than Whombat’s is refused');
      }
      // (b) frame.html framed directly with a spoofed parent.
      for (const [pageOrigin, parent, status] of [
        [foreign.origin, host.origin, 200],
        [host.origin, foreign.origin, 404],
      ] as const) {
        const { page, requests, errors } = await open(
          track,
          `${pageOrigin}/direct?parent=${encodeURIComponent(parent)}`,
        );
        await page.waitForTimeout(1000);
        const request = requests.find((r) => r.url().includes('/embed/v1/frame.html'));
        const res = await request?.response();
        assert.equal(res?.status(), status, 'what the server answered the frame request');
        const ancestors = res?.headers()['content-security-policy']?.match(/frame-ancestors (\S+)$/)?.[1];
        assert.equal(ancestors, status === 200 ? parent : "'none'");
        assert.ok(
          errors.some((e) => e.includes('frame-ancestors')),
          `the browser refused it: ${errors.join(' | ')}`,
        );
        const fr = page.frames().find((x) => x !== page.mainFrame());
        const rendered = fr
          ? await fr
              .locator('#wb-root, form, .refused')
              .count()
              .catch(() => 0)
          : 0;
        assert.equal(
          rendered,
          0,
          `a ${pageOrigin} page framing frame.html with parent=${parent} gets nothing`,
        );
        note(
          `direct frame from ${pageOrigin} claiming ${parent}: HTTP ${res?.status()}, frame-ancestors ${ancestors}, frame URL ${fr?.url()}`,
        );
      }
      // frame.html opened as a page of its own (not framed): it refuses to run.
      {
        const { context, page } = await open(track, `${host.origin}/plain`);
        const url = `${W}/embed/v1/frame.html?site=${siteId}&parent=${encodeURIComponent(host.origin)}#instance=${'C'.repeat(22)}`;
        const [popup] = await Promise.all([
          context.waitForEvent('page'),
          page.evaluate((u) => void window.open(u), url),
        ]);
        await popup.waitForLoadState('load');
        await popup.locator('.refused').waitFor();
        assert.equal(
          await popup.locator('.refused').innerText(),
          'Feedback isn’t available on this site right now.',
        );
        assert.equal(await popup.locator('form, textarea, input').count(), 0, 'no form outside a frame');
      }
      // (c) Forged messages to the loader, and (d) to the frame.
      {
        const { page, errors } = await open(track, `${host.origin}/forge`);
        const f = await openByLauncher(page);
        const instance = instanceOf(await attrOf(page, 'iframe', 'src'));
        const same = page.frames().find((x) => x.url() === `${host.origin}/child`);
        const other = page.frames().find((x) => x.url() === `${foreign.origin}/child`);
        assert.ok(same && other, 'both child frames loaded');
        const forged = (type: string, payload: unknown = {}) => ({
          wb: 'whombat-feedback/1',
          instance,
          type,
          payload,
        });
        const isOpen = () =>
          page.evaluate(() => (window as unknown as FeedbackWindow).WhombatFeedback.isOpen());
        const compact = () =>
          shadow<string | undefined>(page, '.panel', 'function () { return this.dataset.size; }');
        for (const [who, target] of [
          ['a same-origin child frame', same],
          ['another-origin child frame', other],
          ['the page itself', page.mainFrame()],
        ] as const) {
          for (const type of ['close', 'unavailable', 'submitted', 'ready'])
            await target.evaluate(
              ([m]) => window.parent.postMessage(m, '*'),
              [forged(type, type === 'submitted' ? { reference: 'FB-AAAA-AAAA' } : {})],
            );
          await page.waitForTimeout(300);
          assert.equal(await isOpen(), true, `a forged close from ${who} is ignored`);
          assert.equal(await compact(), undefined, `a forged unavailable from ${who} is ignored`);
        }
        // The real frame with the wrong nonce: ignored; with the right one: obeyed (the check above can fail).
        await f.evaluate(
          ([m]) => window.parent.postMessage(m, '*'),
          [{ ...forged('close'), instance: 'A'.repeat(22) }],
        );
        await page.waitForTimeout(300);
        assert.equal(await isOpen(), true, 'a wrong nonce is ignored');
        await f.evaluate(([m]) => window.parent.postMessage(m, '*'), [forged('close')]);
        await closed(page);
        await clickShadow(page, 'button.launcher');
        await f.locator('#wb-description').waitFor({ state: 'visible' });

        // To the frame. The preview is open, so accepted context shows at once.
        await previewText(f);
        const ctx = (version: string) => ({
          page: { url: 'https://evil.example/phish', title: 'Forged' },
          browser: null,
          app: { version, environment: null, build: null },
          custom: {},
          references: [],
        });
        // The frame's window isn't in window.frames (its iframe is in a closed shadow root): a page script can only
        // get it as event.source of the frame's own messages. The harness hands the page that same reference.
        assert.equal(
          await page.evaluate(() => window.frames.length),
          2,
          'window.frames: the two children only',
        );
        await shadow(page, 'iframe', 'function () { window.__wbFrame = this.contentWindow; return true; }');
        type Handle = { __wbFrame: Window };
        // A same-origin child: the parent's origin, but not the parent window.
        await same.evaluate(
          ([m, target]) => (window.parent as unknown as Handle).__wbFrame.postMessage(m, target as string),
          [forged('context', { context: ctx('FORGED-SAME') }), W],
        );
        // Another origin's child can't even reach it: no handle through the parent, and not among its frames.
        const reach = await other.evaluate(() => {
          let handle = 'none';
          try {
            handle = typeof (window.parent as unknown as Handle).__wbFrame;
          } catch (e) {
            handle = (e as Error).name;
          }
          return { handle, frames: window.parent.frames.length };
        });
        assert.deepEqual(reach, { handle: 'SecurityError', frames: 2 });
        await other.evaluate(
          ([m, target]) => {
            for (let i = 0; i < window.parent.frames.length; i++)
              window.parent.frames[i]?.postMessage(m, target as string);
          },
          [forged('context', { context: ctx('FORGED-OTHER') }), W],
        );
        const postFromPage = ([m, target]: [unknown, string]) =>
          (window as unknown as Handle).__wbFrame.postMessage(m, target);
        // The real parent with a wrong nonce.
        await page.evaluate(postFromPage, [
          { ...forged('context', { context: ctx('FORGED-NONCE') }), instance: 'B'.repeat(22) },
          W,
        ] as [unknown, string]);
        // Malformed, from the right window with the right nonce.
        const malformed: unknown[] = [
          null,
          'close',
          42,
          [],
          { wb: 'whombat-feedback/1' },
          { wb: 'whombat-feedback/2', instance, type: 'context', payload: { context: ctx('FORGED-TAG') } },
          forged('context', null),
          forged('context', { context: 'nope' }),
          forged('context', {
            context: { ...ctx('FORGED-EXTRA'), page: { url: 'javascript:alert(1)', title: 1 } },
          }),
          forged('open', { type: '<img src=x onerror=alert(1)>', context: ctx('FORGED-OPEN') }),
          forged('eval', { code: 'alert(1)' }),
          forged('close', { extra: true }),
          forged('context', { context: { ...ctx('x'.repeat(100_000)) } }),
        ];
        for (const m of malformed) await page.evaluate(postFromPage, [m, W] as [unknown, string]);
        // An own `__proto__` key (made in the page: it wouldn't survive the trip from here).
        await page.evaluate(
          ([json, target]) =>
            (window as unknown as Handle).__wbFrame.postMessage(JSON.parse(json as string), target as string),
          [
            JSON.stringify(forged('context', { context: ctx('FORGED-PROTO') })).replace(
              '{',
              '{"__proto__":{"polluted":true},',
            ),
            W,
          ],
        );
        await page.waitForTimeout(500);
        let preview = await f.locator('.preview-list').innerText();
        assert.doesNotMatch(preview, /FORGED|evil\.example|javascript:|x{100}/, preview);
        note(
          `after forged and malformed messages the preview still reads: ${preview.split('\n').slice(0, 2).join(' ')}`,
        );
        // Positive control: the real parent, right nonce, well-formed: accepted (so the checks above can fail).
        await page.evaluate(postFromPage, [forged('context', { context: ctx('PARENT-OK') }), W] as [
          unknown,
          string,
        ]);
        await until('the parent’s context', async () =>
          /PARENT-OK/.test(await f.locator('.preview-list').innerText()),
        );
        preview = await f.locator('.preview-list').innerText();
        note(`positive control: ${preview.split('\n').slice(0, 2).join(' ')}`);
        // (The site itself may say anything about its page: context is unverified evidence.) Reopening the preview
        // asks the loader again, which answers with the real page.
        await f.locator('.preview summary').click();
        await previewText(f);
        await until('the real page again', async () =>
          (await f.locator('.preview-list').innerText()).includes(`${host.origin}/forge`),
        );
        // The frame still works.
        await f.locator('#wb-description').fill('After the forged messages.');
        const sent = await sendForReceipt(page, f);
        const stored = (await internalReport(sent.reference)).report.submitted.context;
        assert.equal(stored.page?.url, `${host.origin}/forge`, 'the stored page is the real one');
        assert.deepEqual(
          errors.filter((e) => e.startsWith('pageerror')),
          [],
        );
      }
    },
  );

  await step(
    '11 third-party cookies blocked, owner signed in in another tab: no cookie on the submission',
    async (track) => {
      const restricted = await chromium.launch({ args: [THIRD_PARTY_COOKIE_FLAG] });
      cleanups.push(() => restricted.close());
      try {
        const context = track(await restricted.newContext({ viewport: DESKTOP }));
        // Chromium 153 ignores the flag on its own; DevTools' cookie controls are what really block them.
        const restrict = async (p: Page) => {
          const cdp = await context.newCDPSession(p);
          await cdp.send('Network.enable');
          await cdp.send('Network.setCookieControls', {
            enableThirdPartyCookieRestriction: true,
            disableThirdPartyCookieMetadata: true,
            disableThirdPartyCookieHeuristics: true,
          });
        };
        // Tab 1: the owner signs in to Whombat's web app with a host sign-in link.
        const app = await context.newPage();
        await restrict(app);
        await app.goto(await whombat.loginLink('mara@burrowhq.example'));
        await app.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
        const cookies = await context.cookies(W);
        assert.ok(cookies.length > 0, 'the owner has a Whombat session cookie in this browser');
        note(
          `Whombat cookies in the context: ${cookies.map((c) => `${c.name} (httpOnly ${c.httpOnly}, sameSite ${c.sameSite}, secure ${c.secure})`).join(', ')}`,
        );
        await app.evaluate(() => {
          // biome-ignore lint/suspicious/noDocumentCookie: a probe cookie, readable where third-party cookies are allowed.
          document.cookie = 'fbprobe=1; SameSite=None; Secure; Path=/';
        });
        assert.match(await app.evaluate(() => document.cookie), /fbprobe=1/, 'first-party cookies work');
        // Tab 2: the website.
        const site = await context.newPage();
        await restrict(site);
        const errors: string[] = [];
        site.on('pageerror', (e) => errors.push(e.message));
        await site.goto(`${host.origin}/plain`);
        const f = await openByLauncher(site);
        assert.equal(
          await f.evaluate(() => document.cookie),
          '',
          'third-party cookies are blocked in the frame',
        );
        await fillBug(f, 'Sent with third-party cookies blocked.', true);
        const sent = await sendForReceipt(site, f);
        const headers = await sent.request.allHeaders();
        assert.equal(headers.cookie, undefined, 'the submission carries no cookie');
        assert.equal(sent.status, 201);
        const { report } = await internalReport(sent.reference);
        assert.equal(report.submitted.attachments.length, 1);
        assert.deepEqual(errors, []);

        // Control in the default browser: the probe cookie does reach the frame there, the submission still omits it.
        const normal = track(await browser.newContext({ viewport: DESKTOP }));
        const t1 = await normal.newPage();
        await t1.goto(await whombat.loginLink('mara@burrowhq.example'));
        await t1.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
        await t1.evaluate(() => {
          // biome-ignore lint/suspicious/noDocumentCookie: a probe cookie, readable where third-party cookies are allowed.
          document.cookie = 'fbprobe=1; SameSite=None; Secure; Path=/';
        });
        const t2 = await normal.newPage();
        await t2.goto(`${host.origin}/plain`);
        const g = await openByLauncher(t2);
        assert.match(
          await g.evaluate(() => document.cookie),
          /fbprobe=1/,
          'control: third-party cookies reach the frame by default',
        );
        await g.locator('#wb-description').fill('Sent with third-party cookies allowed.');
        const sent2 = await sendForReceipt(t2, g);
        assert.equal(
          (await sent2.request.allHeaders()).cookie,
          undefined,
          'credentials: omit — no cookie either way',
        );
      } finally {
        await restricted.close();
      }
    },
  );

  await step(
    '12 Whombat unreachable: a dead address, and Whombat going away after the page loaded',
    async (track) => {
      const dead = `http://localhost:${PORT.dead}`;
      {
        const { page, errors } = await open(
          track,
          `${host.origin}/plain?whombat=${encodeURIComponent(dead)}`,
        );
        await page.waitForLoadState('load');
        assert.equal(await page.evaluate(() => 'WhombatFeedback' in window), false, 'no loader, no global');
        assert.equal(await page.locator('whombat-feedback').count(), 0);
        await page.locator('#host-input').fill('works');
        assert.equal(await page.locator('#host-input').inputValue(), 'works');
        assert.deepEqual(
          errors.filter((e) => e.startsWith('pageerror')),
          [],
          'nothing thrown into the page',
        );
        note(`console with a dead Whombat: ${errors.join(' | ')}`);
      }
      {
        const relay = await startRelay(PORT.relay, W);
        cleanups.push(() => relay.close());
        const { page, errors } = await open(
          track,
          `${host.origin}/plain?whombat=${encodeURIComponent(relay.origin)}`,
        );
        await until('the launcher', () => exists(page, 'button.launcher'));
        await relay.close(); // Whombat goes away.
        await clickShadow(page, 'button.launcher');
        assert.equal(await textOf(page, '.status'), 'Loading…');
        await until('the unavailable notice', () => exists(page, '.panel[data-state="unavailable"]'), 15_000);
        assert.equal(await textOf(page, '.notice p'), 'Feedback is unavailable right now.');
        assert.equal(
          await shadow<boolean>(
            page,
            'button.close',
            'function () { return this.getRootNode().activeElement === this; }',
          ),
          true,
          'focus on Close',
        );
        await shot(page, 'desktop-light-unreachable');
        await page.keyboard.press('Escape');
        await closed(page);
        await page.locator('#host-input').fill('still fine');
        assert.deepEqual(
          errors.filter((e) => e.startsWith('pageerror')),
          [],
          'nothing thrown into the page',
        );
      }
    },
  );

  await step(
    '2 no customer identity: accounts, people, principals and members unchanged but for one Feedback principal',
    async () => {
      const after = await counts();
      note(
        `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}, reports ${await reportCount()}`,
      );
      assert.equal(after.accounts, before.accounts, 'no account');
      assert.equal(after.people, before.people, 'no person principal');
      assert.equal(after.feedback, 1, 'one Feedback principal');
      assert.equal(after.principals, before.principals + 1 - before.feedback, 'and nothing else');
      assert.equal(after.members, before.members, 'no conversation member');
      const [feedback] = await db.sql<{ kind: string; name: string; handle: string }[]>`
      select kind, name, handle from principals where system = 'feedback'`;
      note(`the Feedback principal: ${JSON.stringify(feedback)}`);
    },
  );

  await step('13 WHOMBAT_FEEDBACK=off: no /embed, the web app and health still work', async (track) => {
    await whombat.stop();
    const off = new Whombat(
      PORT.off,
      {
        ...whombat.env,
        PORT: String(PORT.off),
        PUBLIC_URL: `http://localhost:${PORT.off}`,
        WHOMBAT_FEEDBACK: 'off',
      },
      APP_DIR,
    );
    cleanups.push(() => off.stop());
    await off.start();
    for (const path of [
      '/embed/v1/widget.js',
      `/embed/v1/frame.html?site=${siteId}&parent=${encodeURIComponent(host.origin)}`,
      `/embed/v1/sites/${siteId}/config?parent=${encodeURIComponent(host.origin)}`,
    ])
      assert.equal((await fetch(`${off.origin}${path}`)).status, 404, path);
    const post = await fetch(`${off.origin}/embed/v1/sites/${siteId}/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(post.status, 404);
    const health = (await (await fetch(`${off.origin}/api/v1/health`)).json()) as { ok: boolean };
    assert.equal(health.ok, true);
    const index = await fetch(`${off.origin}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await index.text(), /<div id="root">|<script type="module"/);
    const { page, errors } = await open(
      track,
      `${host.origin}/plain?whombat=${encodeURIComponent(off.origin)}`,
    );
    await page.waitForLoadState('load');
    assert.equal(await page.evaluate(() => 'WhombatFeedback' in window), false);
    assert.deepEqual(
      errors.filter((e) => e.startsWith('pageerror')),
      [],
    );
    const app = await open(track, `${off.origin}/login`);
    await app.page.getByRole('heading').first().waitFor();
    note(`web app with the module off: ${await app.page.title()}`);
    await off.stop();
  });
}

// ------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  try {
    await setup();
    browser = await chromium.launch();
    cleanups.push(() => browser.close());
    await scenarios();
  } finally {
    await cleanup();
  }
  process.stdout.write(`\n${results.join('\n')}\n`);
  if (failures.length) {
    process.stdout.write(`\n${failures.length} failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\n${results.length} checks passed\n`);
}

main().catch(async (err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  await cleanup();
  process.exit(1);
});
