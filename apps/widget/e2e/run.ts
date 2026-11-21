/**
 * Browser check of the built widget with real Chromium: a website on one origin (strict CSP), the Whombat stub on
 * another (servers.ts). Scenarios: one global, launcher and keyboard opening, declarative and API triggers,
 * the full form with a screenshot and “What will be sent”, receipt, validation, retry with the same submission
 * id, unknown site, unreachable Whombat, duplicate script, themes, phone sheets at 390/360/320 px, axe-core
 * inside the frame; the navigation trail (and `data-trail="off"`), reporter sign-in (code, “Your reports”, sign-out,
 * an ended session) and an older runtime without either.
 *
 *   pnpm --filter @whombat/widget build
 *   pnpm --filter @whombat/widget e2e [--shots] [--host-port 4651] [--stub-port 4652]
 *
 * `--shots` writes apps/widget/screenshots/*.png. Playwright comes from apps/web (the widget package has no
 * browser dependency of its own). Helpers for driving the widget (closed shadow root, frame) are in browser.ts,
 * for end-to-end tests against a real server.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { WhombatFeedbackApi } from '@whombat/core/feedback';
import type { SubmissionBody } from '../src/frame/draft';
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
} from './browser';
import { STUB_CODE, type Stub, startHost, startStub, WIDGET_ROOT } from './servers';

const require = createRequire(join(WIDGET_ROOT, '..', 'web', 'package.json'));
const { chromium } = require('@playwright/test') as typeof import('@playwright/test');

const { values: args } = parseArgs({
  options: {
    shots: { type: 'boolean' },
    'host-port': { type: 'string', default: '4651' },
    'stub-port': { type: 'string', default: '4652' },
  },
});
type FeedbackWindow = { WhombatFeedback: WhombatFeedbackApi };
const SHOTS = join(WIDGET_ROOT, 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

// A tiny valid PNG (1×1) for the screenshot input.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let host: { origin: string; close(): Promise<void> };
let stub: Stub;
let browser: Browser;
const results: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    results.push(`ok   ${name} (${Date.now() - started} ms)`);
    process.stdout.write(`ok   ${name}\n`);
  } catch (err) {
    results.push(`FAIL ${name}`);
    process.stdout.write(`FAIL ${name}\n`);
    throw err;
  }
}

async function open(
  query: Record<string, string>,
  opts: {
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    mobile?: boolean;
  } = {},
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({
    viewport: opts.viewport ?? DESKTOP,
    colorScheme: opts.colorScheme ?? 'light',
    deviceScaleFactor: 1,
    ...(opts.mobile ? { hasTouch: true, isMobile: true } : {}),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  // Global names before the widget runs, to prove it adds exactly one.
  await page.addInitScript(() => {
    (window as unknown as { __names: string[] }).__names = Object.getOwnPropertyNames(window);
  });
  // An id-like path segment, a query and a fragment: none of them may reach the report.
  await page.goto(
    `${host.origin}/orders/10423577/items?${new URLSearchParams({ ...query, token: 'secret' })}#frag`,
  );
  await page.waitForFunction(() => 'WhombatFeedback' in window);
  return { context, page, errors };
}

const ANN_REPORTS = [
  {
    reference: 'FB-7K3Q-9M2X',
    type: 'bug' as const,
    status: 'needs_info',
    receivedAt: '2026-09-29T09:12:00.000Z',
    updatedAt: '2026-09-29T11:40:00.000Z',
    summary: 'The invoice total on the orders page is off by one cent.',
  },
  {
    reference: 'FB-4H8N-2QWE',
    type: 'feature' as const,
    status: 'confirmed',
    receivedAt: '2026-09-27T15:02:00.000Z',
    updatedAt: '2026-09-28T08:00:00.000Z',
    summary: 'Export the order history as a CSV file.',
  },
  {
    reference: 'FB-9ZX1-7MKP',
    type: 'bug' as const,
    status: 'fixed',
    receivedAt: '2026-09-22T10:30:00.000Z',
    updatedAt: '2026-09-26T16:00:00.000Z',
    summary: 'Search results are empty after filtering by date.',
  },
  {
    reference: 'FB-3RTY-5VBN',
    type: 'bug' as const,
    status: 'reviewing',
    receivedAt: '2026-09-18T12:00:00.000Z',
    updatedAt: '2026-09-18T12:05:00.000Z',
    summary: null,
  },
  {
    reference: 'FB-2PQR-8HJK',
    type: 'feature' as const,
    status: 'closed',
    receivedAt: '2026-08-30T12:00:00.000Z',
    updatedAt: '2026-09-02T12:00:00.000Z',
    summary: 'A dark theme for the invoices.',
  },
];

/** A few page views in this tab before the widget is opened (the trail): two loads and an SPA navigation. */
async function browse(page: Page, query: Record<string, string> = {}): Promise<void> {
  const q = new URLSearchParams(query);
  for (const path of ['/', '/products/garden-chairs']) {
    await page.goto(`${host.origin}${path}?${q}`);
    await page.waitForFunction(() => 'WhombatFeedback' in window);
  }
  await page.goto(
    `${host.origin}/orders/10423577/items?${new URLSearchParams({ ...query, token: 'secret' })}`,
  );
  await page.waitForFunction(() => 'WhombatFeedback' in window);
  await page.evaluate(() => history.pushState(null, '', '/account/orders/10423577?tab=invoices'));
  await page.waitForTimeout(1_200);
}

/** Clicks a frame button by its text. */
async function press(page: Page, text: string): Promise<void> {
  const f = await frameOf(page);
  await f.locator('button', { hasText: text }).first().click();
}

async function signInThroughFrame(page: Page, email: string): Promise<void> {
  const f = await frameOf(page);
  await f.locator('#wb-signin-email').fill(email);
  await f.locator('button[type=submit]', { hasText: 'Send code' }).click();
  await f.locator('#wb-signin-code').waitFor();
  await f.locator('#wb-signin-code').fill(STUB_CODE);
  await f.locator('button[type=submit]', { hasText: 'Sign in' }).click();
}

async function shot(page: Page, name: string): Promise<void> {
  if (!args.shots) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function main(): Promise<void> {
  host = await startHost(Number(args['host-port']), `http://127.0.0.1:${args['stub-port']}`);
  stub = await startStub(Number(args['stub-port']), host.origin);
  browser = await chromium.launch();
  try {
    await step('one global, a launcher, no errors under a strict CSP', async () => {
      const { context, page, errors } = await open({});
      const added = await page.evaluate(() => {
        const before = new Set((window as unknown as { __names: string[] }).__names);
        return Object.getOwnPropertyNames(window).filter((n) => !before.has(n) && n !== '__names');
      });
      assert.deepEqual(added, ['WhombatFeedback']);
      assert.equal(await page.locator('whombat-feedback').count(), 1);
      assert.equal(await page.evaluate(() => document.styleSheets.length), 1); // the site's own
      await until('the launcher', () => exists(page, 'button.launcher'));
      assert.equal(await attrOf(page, 'button.launcher', 'aria-expanded'), 'false');
      assert.equal(await textOf(page, 'button.launcher'), 'Feedback');
      const box = await rectOf(page, 'button.launcher');
      assert.ok(box && box.height >= 44 && box.width >= 44, `launcher target ${JSON.stringify(box)}`);
      assert.ok(box && box.x + box.width > DESKTOP.width - 40, 'bottom-right');
      assert.equal(await exists(page, 'iframe'), false, 'no frame before open');
      await shot(page, 'desktop-light-launcher');
      assert.deepEqual(errors, []);
      await context.close();
    });

    await step(
      'an existing site trigger replaces the floating launcher, even with duplicate scripts',
      async () => {
        const { context, page } = await open({ trigger: '1', twice: '1' });
        assert.equal((await rectOf(page, 'button.launcher'))?.width, 0);
        await page.locator('#help').click();
        const f = await waitForForm(page);
        assert.equal(await f.locator('#wb-type-feature').isChecked(), true);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !(window as unknown as FeedbackWindow).WhombatFeedback.isOpen());
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'help');
        await page.locator('#help').evaluate((el) => el.remove());
        await until(
          'floating fallback after removing the trigger',
          async () => ((await rectOf(page, 'button.launcher'))?.width ?? 0) > 0,
        );
        await context.close();
      },
    );

    await step('launcher opens the form; fill, attach, preview, send, receipt', async () => {
      const { context, page, errors } = await open({});
      await clickShadow(page, 'button.launcher');
      const f = await waitForForm(page);
      assert.equal(await attrOf(page, 'button.launcher', 'aria-expanded'), 'true');
      assert.equal(
        await attrOf(page, 'iframe', 'sandbox'),
        'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
      );
      assert.equal(
        await f.locator('#wb-type-bug').evaluate((el) => el === document.activeElement),
        true,
        'focus in the frame',
      );
      await shot(page, 'desktop-light-form');
      assert.equal(await f.locator('#wb-steps').count(), 0, 'no steps to reproduce');
      await f.locator('#wb-description').fill('The invoice total on the orders page is off by one cent.');
      await f.locator('#wb-expected').fill('The total matches the sum of the items.');
      await f.locator('#wb-name').fill('Ann');
      await f.locator('#wb-email').fill('ann@example.com');
      await f
        .locator('input[type=file]')
        .setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: PNG });
      await f.locator('.file img').waitFor();
      await f.locator('.preview summary').click();
      const preview = await f.locator('.preview-list').innerText();
      assert.match(preview, /http:\/\/localhost:\d+\/orders\/:id\/items/);
      assert.doesNotMatch(preview, /token|secret|frag/);
      assert.match(preview, /invoice\.png/);
      await f.locator('.body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await shot(page, 'desktop-light-filled');
      assert.deepEqual(await axeFrame(page), []);
      await f.locator('button[type=submit]').dblclick();
      await f.locator('.receipt-title').waitFor();
      assert.equal(stub.reports.length, 1, 'a double click sends once');
      const report = stub.reports[0];
      assert.equal(report?.origin, stub.origin, 'same-origin request from the frame');
      const body = report?.body as unknown as SubmissionBody;
      assert.equal(body.parentOrigin, host.origin);
      assert.equal(body.type, 'bug');
      assert.match(body.submissionId, /^[A-Za-z0-9_-]{22}$/);
      assert.match(body.context.page.url, /^http:\/\/localhost:\d+\/orders\/:id\/items$/);
      assert.equal(body.context.page.title, 'Orders · Acme Shop');
      assert.deepEqual(Object.keys(body.context).sort(), [
        'app',
        'browser',
        'custom',
        'page',
        'references',
        'sentAt',
        'trail',
      ]);
      assert.equal(body.steps, '', 'no steps to reproduce');
      assert.equal(report?.authorization, undefined, 'no bearer when signed out');
      assert.equal(body.attachments[0].name, 'invoice.png');
      assert.equal(body.attachments[0].data, PNG.toString('base64'));
      assert.equal(await f.locator('.reference').innerText(), 'FB-7K3Q-9M2X');
      assert.equal(await f.locator('.receipt a').count(), 0, 'the receipt links nowhere');
      await shot(page, 'desktop-light-receipt');
      await f.locator('.reference-row button').click();
      await f
        .locator('.copy-status')
        .filter({ hasText: /Copied|Selected/ })
        .waitFor();
      process.stdout.write(`     copy: ${await f.locator('.copy-status').innerText()}\n`);
      await f.locator('.foot button', { hasText: 'Close' }).click();
      await page.waitForFunction(() => !(window as unknown as FeedbackWindow).WhombatFeedback.isOpen());
      assert.ok(await focusInWidget(page), 'focus back on the launcher');
      assert.deepEqual(errors, []);
      await context.close();
    });

    await step('keyboard: Tab to the launcher, Enter opens, Escape closes and focus returns', async () => {
      const { context, page } = await open({ position: 'bottom-left' });
      await page.locator('#plain').focus();
      await page.keyboard.press('Tab');
      assert.ok(await focusInWidget(page), 'the launcher is in the tab order');
      await page.keyboard.press('Enter');
      const f = await waitForForm(page);
      await f.locator('#wb-type-bug').evaluate((el) => {
        if (el !== document.activeElement) throw new Error('focus not in the frame');
      });
      await page.keyboard.press('ArrowRight');
      assert.equal(await f.locator('#wb-type-feature').isChecked(), true, 'arrow keys pick the type');
      assert.equal(
        await f.locator('#wb-expected').isVisible(),
        false,
        'bug-only fields hidden for a feature',
      );
      // Tab through everything and around: focus stays in the dialog.
      for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
      assert.ok(
        await f.locator('body').evaluate(() => document.activeElement !== document.body),
        'focus stays inside',
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !(window as unknown as FeedbackWindow).WhombatFeedback.isOpen());
      assert.ok(await focusInWidget(page), 'focus back on the launcher');
      const box = await rectOf(page, 'button.launcher');
      assert.ok(box && box.x < 40, 'bottom-left');
      await context.close();
    });

    await step(
      'custom launcher: no floating button, the site’s trigger opens it as a feature request',
      async () => {
        const { context, page } = await open({ launcher: 'custom', theme: 'light' });
        assert.equal(await page.locator('whombat-feedback').count(), 0);
        await page.locator('#help').click();
        const f = await waitForForm(page);
        assert.equal(await f.locator('#wb-type-feature').isChecked(), true);
        assert.equal(await exists(page, 'button.launcher'), false);
        await shot(page, 'desktop-light-custom-feature');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !(window as unknown as FeedbackWindow).WhombatFeedback.isOpen());
        assert.equal(
          await page.evaluate(() => document.activeElement?.id),
          'help',
          'focus back on the site’s button',
        );
        // The API from the page.
        await page.evaluate(() => {
          const wf = (window as unknown as FeedbackWindow).WhombatFeedback;
          wf.setContext({
            app: { version: '1.4.2', environment: 'production' },
            custom: { plan: 'pro', secret: 'x' },
            references: ['req_9'],
          });
          wf.open({ type: 'bug' });
        });
        await f.locator('#wb-type-bug:checked').waitFor({ state: 'attached' });
        await f.locator('.preview summary').click();
        const preview = await f.locator('.preview-list').innerText();
        assert.match(preview, /version 1\.4\.2 · production/);
        assert.match(preview, /plan\s+pro/);
        assert.doesNotMatch(preview, /secret/);
        assert.match(preview, /req_9/);
        await page.evaluate(() => (window as unknown as FeedbackWindow).WhombatFeedback.destroy());
        assert.equal(await page.locator('whombat-feedback').count(), 0);
        await context.close();
      },
    );

    await step('validation and a failed send keep the draft; retry uses the same id', async () => {
      const { context, page } = await open({ theme: 'light' });
      await page.evaluate(() => (window as unknown as FeedbackWindow).WhombatFeedback.open());
      const f = await waitForForm(page);
      await f.locator('button[type=submit]').click();
      assert.equal(await f.locator('#wb-description').getAttribute('aria-invalid'), 'true');
      assert.ok(await f.locator('#wb-description').evaluate((el) => el === document.activeElement));
      await shot(page, 'desktop-light-invalid');
      stub.answers.push({ status: 503, body: { error: { code: 'internal', message: 'x' } } });
      await f.locator('#wb-description').fill('Checkout button does nothing.');
      const before = stub.reports.length;
      await f.locator('button[type=submit]').click();
      await f.locator('.alert', { hasText: 'Something went wrong on our side' }).waitFor();
      await shot(page, 'desktop-light-error');
      await f.locator('.alert button', { hasText: 'Try again' }).click();
      await f.locator('.receipt-title').waitFor();
      const ids = stub.reports.slice(before).map((r) => r.body.submissionId);
      assert.equal(ids.length, 2);
      assert.equal(ids[0], ids[1]);
      await context.close();
    });

    await step(
      'the navigation trail: shown in “What will be sent”, sent sanitized, oldest first',
      async () => {
        const { context, page, errors } = await open({});
        await browse(page);
        assert.match(
          (await page.evaluate(() => sessionStorage.getItem('whombat-feedback:trail'))) ?? '',
          /account\/orders\/:id/,
        );
        await clickShadow(page, 'button.launcher');
        const f = await waitForForm(page);
        await f.locator('.preview summary').click();
        await f.locator('.trail-preview').waitFor();
        const urls = await f.locator('.trail-url').allInnerTexts();
        assert.deepEqual(
          urls.map((u) => new URL(u).pathname),
          ['/orders/:id/items', '/', '/products/garden-chairs', '/orders/:id/items', '/account/orders/:id'],
        );
        assert.match(
          await f.locator('.trail-preview').innerText(),
          /Pages you visited on this site before reporting/,
        );
        assert.match(
          await f.locator('.preview-body > .hint').innerText(),
          /^Nothing else from the page is sent: no cookies, stored data or form contents\.$/,
        );
        await f.locator('.trail-preview').scrollIntoViewIfNeeded();
        await shot(page, 'desktop-light-trail');
        assert.deepEqual(await axeFrame(page), []);
        await f.locator('#wb-description').fill('Checkout total is wrong.');
        const before = stub.reports.length;
        await f.locator('button[type=submit]').click();
        await f.locator('.receipt-title').waitFor();
        const body = stub.reports[before]?.body as unknown as SubmissionBody;
        const trail = body.context.trail ?? [];
        assert.equal(trail.at(-1)?.url, `${host.origin}/account/orders/:id`);
        assert.equal(trail.at(-2)?.title, 'Orders · Acme Shop');
        assert.doesNotMatch(JSON.stringify(trail), /token|secret|tab=|invoices/);
        assert.ok(trail.every((t) => /^\d{4}-\d\d-\d\dT/.test(t.at)));
        assert.deepEqual(errors, []);
        await context.close();
      },
    );

    await step('data-trail="off": nothing recorded, nothing sent', async () => {
      const { context, page } = await open({ trail: 'off' });
      await page.evaluate(() => history.pushState(null, '', '/elsewhere'));
      await page.waitForTimeout(1_200);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('whombat-feedback:trail')), null);
      await clickShadow(page, 'button.launcher');
      const f = await waitForForm(page);
      assert.equal(await f.locator('.trail-preview').isHidden(), true);
      await f.locator('#wb-description').fill('No trail please.');
      const before = stub.reports.length;
      await f.locator('button[type=submit]').click();
      await f.locator('.receipt-title').waitFor();
      assert.equal(
        (stub.reports[before]?.body.context as Record<string, unknown> | undefined)?.trail,
        undefined,
      );
      await context.close();
    });

    await step('an older runtime (no trail, no sign-in in its config) gets the plain form', async () => {
      const { context, page } = await open({ site: 'fbs_e2eOldRuntime00000000000' });
      await browse(page, { site: 'fbs_e2eOldRuntime00000000000' });
      await clickShadow(page, 'button.launcher');
      const f = await waitForForm(page);
      assert.equal(await f.locator('.tabs').isHidden(), true);
      assert.equal(await f.locator('#wb-signin-link').count(), 0);
      assert.equal(await f.locator('#wb-email').count(), 1);
      await f.locator('#wb-description').fill('Old runtime.');
      const before = stub.reports.length;
      await f.locator('button[type=submit]').click();
      await f.locator('.receipt-title').waitFor();
      assert.equal(
        (stub.reports[before]?.body.context as Record<string, unknown> | undefined)?.trail,
        undefined,
      );
      await context.close();
    });

    await step(
      'reporter sign-in: code, a verified report, “Your reports”, sign-out, an ended session',
      async () => {
        stub.reporters.reports.set('ann@example.com', ANN_REPORTS);
        const { context, page, errors } = await open({});
        await clickShadow(page, 'button.launcher');
        const f = await waitForForm(page);
        assert.equal(await f.locator('.tab[aria-pressed="true"]').innerText(), 'New report');
        await f.locator('#wb-name').fill('Ann');
        await f.locator('#wb-signin-link').click();
        assert.ok(await f.locator('#wb-signin-email').evaluate((el) => el === document.activeElement));
        assert.deepEqual(await axeFrame(page), []);
        await f.locator('#wb-signin-email').fill('Ann@Example.com');
        await f.locator('button[type=submit]', { hasText: 'Send code' }).click();
        await f.locator('#wb-signin-code').waitFor();
        assert.deepEqual(stub.reporters.codes.at(-1), { email: 'ann@example.com', parent: host.origin });
        assert.ok(await f.locator('#wb-signin-code').evaluate((el) => el === document.activeElement));
        assert.deepEqual(await axeFrame(page), []);
        await f.locator('#wb-signin-code').fill('654321');
        await f.locator('button[type=submit]', { hasText: 'Sign in' }).click();
        await f.locator('#wb-signin-code-error', { hasText: 'That code didn’t work.' }).waitFor();
        await f.locator('#wb-signin-code').fill(STUB_CODE);
        await f.locator('button[type=submit]', { hasText: 'Sign in' }).click();
        await f.locator('#wb-signed-in').waitFor();
        assert.equal(await f.locator('#wb-email').count(), 0, 'the email field is gone');
        assert.equal(await f.locator('#wb-name').inputValue(), 'Ann');
        await f.locator('#wb-description').fill('Signed-in report.');
        const before = stub.reports.length;
        await f.locator('button[type=submit]').click();
        await f.locator('.receipt .follow', { hasText: 'You can follow it under Your reports.' }).waitFor();
        const report = stub.reports[before];
        assert.equal(
          stub.reporters.emailOf(report?.authorization),
          'ann@example.com',
          'the bearer is the session',
        );
        assert.equal(
          (report?.body as unknown as SubmissionBody | undefined)?.reporter.email,
          'ann@example.com',
        );
        await press(page, 'Your reports');
        await f.locator('.report').first().waitFor();
        const statuses = await f.locator('.report-status').allInnerTexts();
        assert.deepEqual(statuses, ['Needs more information', 'Noted', 'Fixed', 'Being looked at', 'Closed']);
        assert.deepEqual(await axeFrame(page), []);
        await press(page, 'Refresh');
        await f.locator('.report').first().waitFor();
        // The stub forgets the session: the next load says it ended.
        stub.reporters.sessions.clear();
        await press(page, 'Refresh');
        await f.locator('.alert', { hasText: 'Your sign-in has ended. Sign in again.' }).waitFor();
        assert.equal(await f.locator('#wb-signin-email').count(), 1);
        await signInThroughFrame(page, 'ann@example.com');
        await f.locator('.report').first().waitFor();
        await press(page, 'Sign out');
        await f.locator('#wb-signin-email').waitFor();
        assert.ok(stub.reporters.signOuts.at(-1)?.startsWith('fbrs_'), 'DELETE with the token');
        assert.equal(await f.evaluate(() => localStorage.length), 0, 'signed out, the frame keeps nothing');
        // The refused code (400) and the ended session (401) are logged by the browser, nothing else.
        assert.deepEqual(
          errors.filter((e) => !/status of 40[01]/.test(e)),
          [],
        );
        await context.close();
      },
    );

    await step('a server without the reporter routes hides sign-in', async () => {
      stub.reporters.off = true;
      try {
        const { context, page } = await open({});
        await clickShadow(page, 'button.launcher');
        const f = await waitForForm(page);
        await f.locator('#wb-signin-link').click();
        await f.locator('#wb-signin-email').fill('ann@example.com');
        await f.locator('button[type=submit]', { hasText: 'Send code' }).click();
        await f
          .locator('.alert', { hasText: 'Signing in isn’t available on this site right now.' })
          .waitFor();
        assert.equal(await f.locator('.tabs').isHidden(), true);
        await press(page, 'Back');
        assert.equal(await f.locator('#wb-signin-link').count(), 0);
        await context.close();
      } finally {
        stub.reporters.off = false;
      }
    });

    for (const scheme of ['light', 'dark'] as const)
      for (const [label, viewport, mobile] of [
        ['desktop', DESKTOP, false],
        ['mobile', MOBILE, true],
      ] as const)
        await step(`reporter screens (${label}, ${scheme})`, async () => {
          stub.reporters.reports.set('ann@example.com', ANN_REPORTS);
          stub.reporters.reports.set('new@example.com', []);
          const { context, page, errors } = await open(
            { theme: scheme === 'dark' ? 'auto' : 'light' },
            { viewport, colorScheme: scheme, mobile },
          );
          await browse(page, { theme: scheme === 'dark' ? 'auto' : 'light' });
          await clickShadow(page, 'button.launcher');
          const f = await waitForForm(page);
          const name = (what: string) => `${label}-${scheme}-${what}`;
          await f.locator('#wb-description').fill('The invoice total on the orders page is off by one cent.');
          await f.locator('.preview summary').click();
          await f.locator('.trail-preview').scrollIntoViewIfNeeded();
          await shot(page, name('trail'));
          await press(page, 'Your reports');
          await f.locator('#wb-signin-email').fill('new@example.com');
          await shot(page, name('signin-email'));
          await f.locator('button[type=submit]', { hasText: 'Send code' }).click();
          await f.locator('#wb-signin-code').waitFor();
          await f.locator('#wb-signin-code').fill('1234');
          await shot(page, name('signin-code'));
          await f.locator('#wb-signin-code').fill(STUB_CODE);
          await f.locator('button[type=submit]', { hasText: 'Sign in' }).click();
          await f.locator('.empty').waitFor();
          await shot(page, name('reports-empty'));
          await press(page, 'Sign out');
          await signInThroughFrame(page, 'ann@example.com');
          await f.locator('.report').first().waitFor();
          await shot(page, name('reports'));
          await press(page, 'New report');
          await f.locator('#wb-name').fill('Ann');
          await f.locator('#wb-signed-in').scrollIntoViewIfNeeded();
          await shot(page, name('signed-in-form'));
          await f.locator('button[type=submit]').click();
          await f.locator('.receipt .follow').waitFor();
          await shot(page, name('receipt-signed-in'));
          if (mobile) {
            const small = await f.locator('body').evaluate(() =>
              [...document.querySelectorAll('button, .segment, summary')]
                .filter((el) => (el as HTMLElement).offsetParent !== null)
                .filter((el) => el.getBoundingClientRect().height < 44)
                .map((el) => el.className || el.textContent),
            );
            assert.deepEqual(small, [], 'touch targets');
          }
          assert.deepEqual(errors, []);
          await context.close();
        });

    await step('an unknown site and an unreachable Whombat leave the page usable', async () => {
      {
        stub.sites.set('fbs_e2eNoConfig0000000000000', {});
        const { context, page } = await open({ site: 'fbs_e2eNoConfig0000000000000' });
        await clickShadow(page, 'button.launcher');
        await until('the frame', () => exists(page, '.panel[data-state="ready"]'));
        await (await frameOf(page))
          .locator('.notice', { hasText: 'Feedback isn’t available on this site right now.' })
          .waitFor();
        await shot(page, 'desktop-light-site-unavailable');
        await context.close();
      }
      {
        // An unknown site: frame.html refuses to be framed, so the frame never says ready.
        const { context, page } = await open({ site: 'fbs_e2eUnknown00000000000000' });
        await clickShadow(page, 'button.launcher');
        await until('the notice', () => exists(page, '.panel[data-state="unavailable"]'), 12_000);
        assert.match((await textOf(page, '.notice')) ?? '', /Feedback is unavailable right now\./);
        assert.equal(
          await shadow<boolean>(
            page,
            'button.close',
            'function () { return this.getRootNode().activeElement === this; }',
          ),
          true,
          'focus on Close',
        );
        await page.locator('#plain').click();
        await shot(page, 'desktop-light-unreachable');
        await clickShadow(page, 'button.close');
        assert.equal(
          await page.evaluate(() => (window as unknown as FeedbackWindow).WhombatFeedback.isOpen()),
          false,
        );
        await context.close();
      }
    });

    await step('the script included twice gives one launcher and one warning', async () => {
      const { context, page } = await open({ twice: '1' });
      const warnings: string[] = [];
      page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
      await page.reload();
      await page.waitForFunction(() => 'WhombatFeedback' in window);
      await page.waitForTimeout(100);
      assert.equal(await page.locator('whombat-feedback').count(), 1);
      assert.equal(warnings.filter((w) => w.includes('more than once')).length, 1);
      await context.close();
    });

    for (const scheme of ['light', 'dark'] as const) {
      await step(`dark and light themes (${scheme}), desktop and mobile`, async () => {
        for (const [label, viewport, mobile] of [
          ['desktop', DESKTOP, false],
          ['mobile', MOBILE, true],
        ] as const) {
          const { context, page } = await open(
            { theme: scheme === 'dark' ? 'auto' : 'light' },
            { viewport, colorScheme: scheme, mobile },
          );
          if (label === 'mobile' && scheme === 'light') await shot(page, 'mobile-light-launcher');
          await clickShadow(page, 'button.launcher');
          const f = await waitForForm(page);
          const theme = await f.locator('html').getAttribute('data-theme');
          assert.equal(theme, scheme);
          if (label === 'mobile') {
            const box = await rectOf(page, 'iframe');
            assert.ok(
              box && box.width === MOBILE.width && box.height === MOBILE.height,
              `sheet ${JSON.stringify(box)}`,
            );
          }
          await shot(page, `${label}-${scheme}-form`);
          await f.locator('#wb-description').fill('Search results are empty after filtering by date.');
          await f.locator('button[type=submit]').click();
          await f.locator('.receipt-title').waitFor();
          await shot(page, `${label}-${scheme}-receipt`);
          await context.close();
        }
      });
    }

    await step('320 and 360 px wide: no horizontal overflow, 44px targets on touch', async () => {
      for (const width of [320, 360]) {
        const { context, page } = await open({}, { viewport: { width, height: 740 }, mobile: true });
        await clickShadow(page, 'button.launcher');
        const f = await waitForForm(page);
        await f.locator('input[type=file]').setInputFiles({
          name: 'a-very-long-file-name-for-a-screenshot-of-the-page.png',
          mimeType: 'image/png',
          buffer: PNG,
        });
        await f.locator('.preview summary').click();
        const overflow = await f.locator('body').evaluate(() => {
          const els = [document.documentElement, ...document.querySelectorAll('.body *')];
          return els
            .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
            .map((el) => el.className || el.tagName);
        });
        assert.deepEqual(overflow, [], `overflow at ${width}px`);
        const small = await f.locator('body').evaluate(() =>
          [...document.querySelectorAll('button, .segment, summary')]
            .filter((el) => (el as HTMLElement).offsetParent !== null)
            .filter((el) => el.getBoundingClientRect().height < 44)
            .map((el) => el.className || el.textContent),
        );
        assert.deepEqual(small, [], `touch targets at ${width}px`);
        if (width === 360) await shot(page, 'mobile-360-filled');
        await context.close();
      }
    });
  } finally {
    await browser.close();
    await stub.close();
    await host.close();
  }
}

main().then(
  () => process.stdout.write(`\n${results.length} checks passed\n`),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
