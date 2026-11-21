/**
 * Drop mode end to end in real Chromium (Whombat `docs/decisions/feedback-drop.md` FD-27 … FD-31): the **built embed
 * tree** served as a static site with its own `_headers` (what the appliance harness does for `embed.whombat.com`),
 * a fake control with a signed card and the drop, and a website with a strict CSP embedding the managed snippet.
 *
 *   pnpm --filter @whombat/widget e2e:drop [--host-port 4661] [--embed-port 4662] [--control-port 4663]
 *
 * Scenarios: a report sealed in the browser reaches control as ciphertext only and opens to the submission with the
 * frame's evidence and the derived reference; a retry after a failure sends the identical bytes; the frame never
 * touches storage but its one reporter key; reporter sign-in through control (code, session, a drop attested with the
 * bearer token, “Your reports” with the frame's own summaries, sign-out); a website the card doesn't allow, and a
 * snippet pinning another key, get “unavailable” and send nothing; no CSP violation anywhere.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { parseArgs } from 'node:util';
import type { Browser, Page } from '@playwright/test';
import type { FeedbackSiteCard } from '@whombat/core/domain';
import {
  dropEnvelopeCap,
  FEEDBACK_DROP_SUITE,
  feedbackReferenceFor,
  generateDropKeyPair,
  generateSiteSigningKey,
  openDropEnvelope,
  signSiteCard,
} from '@whombat/core/feedback/drop';
import { buildWidget } from '../scripts/build';
import { clickShadow, exists, frameOf, until, waitForForm } from './browser';
import { STUB_CODE, STUB_CONFIG, StubReporters, startHost, WIDGET_ROOT } from './servers';

const require = createRequire(join(WIDGET_ROOT, '..', 'web', 'package.json'));
const { chromium } = require('@playwright/test') as typeof import('@playwright/test');

const { values: args } = parseArgs({
  options: {
    'host-port': { type: 'string', default: '4661' },
    'embed-port': { type: 'string', default: '4662' },
    'control-port': { type: 'string', default: '4663' },
    'other-port': { type: 'string', default: '4664' },
  },
});

const SITE = 'fbs_e2eSite00000000000000000';
const CANARY = 'canary-7f3c1e — the invoice total is off by one cent';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function listen(server: Server, port: number): Promise<void> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
}
const closer = (server: Server) => () => new Promise<void>((ok) => server.close(() => ok()));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

/** `_headers` blocks: every block whose pattern matches the path applies (`/*` and `/embed/v1/assets/*` style). */
function parseHeaders(text: string): { pattern: string; headers: [string, string][] }[] {
  const blocks: { pattern: string; headers: [string, string][] }[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) blocks.push({ pattern: line.trim(), headers: [] });
    else {
      const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
      if (m?.[1] && m[2] !== undefined) blocks.at(-1)?.headers.push([m[1].trim().toLowerCase(), m[2].trim()]);
    }
  }
  return blocks;
}
const matches = (pattern: string, path: string) =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern;

/** The embed tree as a static site: its files with `_headers` applied, 404 for anything else. */
async function startEmbed(root: string, port: number) {
  const blocks = parseHeaders(readFileSync(join(root, '_headers'), 'utf8'));
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
    const file = join(root, path);
    if (
      req.method !== 'GET' ||
      path === '/_headers' ||
      !file.startsWith(root) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = {};
    for (const b of blocks) if (matches(b.pattern, path)) for (const [k, v] of b.headers) headers[k] = v;
    res.writeHead(200, { ...headers, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await listen(server, port);
  return { origin: `http://127.0.0.1:${port}`, close: closer(server) };
}

interface ControlDrop {
  origin: string | undefined;
  referer: string | undefined;
  cookie: string | undefined;
  authorization: string | undefined;
  bytes: Buffer;
}

/**
 * Control's public card, drop and reporter routes (FD-17, CT-164): CORS for the embed origin only (GET, POST, DELETE;
 * content-type and authorization; no credentials), answers queued by the scenarios.
 */
async function startControl(port: number, embedOrigin: string, card: () => unknown) {
  const drops: ControlDrop[] = [];
  const reporters = new StubReporters();
  const answers: { status: number; body: unknown }[] = [];
  const cors = (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.origin === embedOrigin) {
      res.setHeader('access-control-allow-origin', embedOrigin);
      res.setHeader('vary', 'Origin');
    }
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, DELETE',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && path === `/v1/feedback/sites/${SITE}/card`) return json(res, 200, card());
    const reporter = new RegExp(`^/v1/feedback/sites/${SITE}/reporter/([a-z]+)$`).exec(path);
    if (reporter) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const answer = reporters.handle(
          reporter[1] ?? '',
          req.method ?? 'GET',
          Buffer.concat(chunks).toString('utf8'),
          req.headers.authorization,
        );
        if (!answer) return json(res, 404, { error: { code: 'unavailable', message: 'Not available.' } });
        if (answer.body === undefined) {
          res.writeHead(answer.status);
          res.end();
          return;
        }
        json(res, answer.status, answer.body);
      });
      return;
    }
    if (req.method === 'POST' && path === `/v1/feedback/sites/${SITE}/drops`) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        drops.push({
          origin: req.headers.origin,
          referer: req.headers.referer,
          cookie: req.headers.cookie,
          authorization: req.headers.authorization,
          bytes: Buffer.concat(chunks),
        });
        const answer = answers.shift() ?? { status: 202, body: { receivedAt: new Date().toISOString() } };
        json(res, answer.status, answer.body);
      });
      return;
    }
    json(res, 404, { error: { code: 'unavailable', message: 'Not available.' } });
  });
  await listen(server, port);
  return { origin: `http://127.0.0.1:${port}`, drops, answers, reporters, close: closer(server) };
}

/**
 * Records any use of storage in every frame (the widget's frame included), before any script runs. A string, so
 * the bundler's helpers (`__name`) don't leak into the page. `localStorage` stays usable but records every key (the
 * frame may use exactly one, AP-429); everything else is refused and recorded.
 */
const STORAGE_TRAP = `(() => {
  const used = [];
  const keys = [];
  window.__storageUsed = used;
  window.__storageKeys = keys;
  const trap = (target, name) => {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        get() { used.push(name); return undefined; },
        set() { used.push(name); },
      });
    } catch {}
  };
  for (const name of ['sessionStorage', 'indexedDB', 'caches']) trap(window, name);
  trap(Document.prototype, 'cookie');
  trap(Navigator.prototype, 'serviceWorker');
  try {
    const real = window.localStorage;
    const wrapped = {
      getItem(k) { keys.push(k); return real.getItem(k); },
      setItem(k, v) { keys.push(k); real.setItem(k, v); },
      removeItem(k) { keys.push(k); real.removeItem(k); },
      get length() { used.push('localStorage.length'); return real.length; },
      key() { used.push('localStorage.key'); return null; },
      clear() { used.push('localStorage.clear'); },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { return wrapped; } });
  } catch {}
})();`;

const results: string[] = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(`ok   ${name}`);
    process.stdout.write(`ok   ${name}\n`);
  } catch (err) {
    process.stdout.write(`FAIL ${name}\n`);
    throw err;
  }
}

async function main(): Promise<void> {
  const signing = generateSiteSigningKey();
  const other = generateSiteSigningKey();
  const encryption = generateDropKeyPair();
  const hostOrigin = `http://localhost:${args['host-port']}`;
  const cardOf = (): FeedbackSiteCard =>
    ({
      purpose: 'whombat-feedback-site-card',
      v: 1,
      site: SITE,
      seq: 3,
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 14 * 86_400,
      allowedOrigins: [hostOrigin],
      config: STUB_CONFIG,
      limits: {
        maxEnvelopeBytes: dropEnvelopeCap(10 * 1024 * 1024),
        reportsPerHour: 30,
        reportsPerDay: 200,
        perSourcePerHour: 5,
      },
      encryption: { suite: FEEDBACK_DROP_SUITE, kid: encryption.kid, publicKey: encryption.publicKeyB64 },
      signingKey: signing.publicKey,
    }) as FeedbackSiteCard;

  const dir = mkdtempSync(join(tmpdir(), 'wb-embed-e2e-'));
  const controlOrigin = `http://127.0.0.1:${args['control-port']}`;
  await buildWidget(dir, { control: controlOrigin });
  const embed = await startEmbed(dir, Number(args['embed-port']));
  const control = await startControl(Number(args['control-port']), embed.origin, () =>
    signSiteCard(cardOf(), signing.seed),
  );
  const host = await startHost(Number(args['host-port']), embed.origin);
  const otherHost = await startHost(Number(args['other-port']), embed.origin);
  const browser: Browser = await chromium.launch();

  const open = async (origin: string, key = signing.fingerprint) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript({ content: STORAGE_TRAP });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(`${origin}/orders?${new URLSearchParams({ site: SITE, key })}`);
    await page.waitForFunction(() => 'WhombatFeedback' in window);
    await until('the launcher', () => exists(page, 'button.launcher'));
    await clickShadow(page, 'button.launcher');
    return { context, page, errors };
  };
  const storageUsed = async (page: Page) => {
    const frame = await frameOf(page);
    const used = await frame.evaluate('window.__storageUsed');
    const keys = (await frame.evaluate('window.__storageKeys')) as string[];
    assert.ok(Array.isArray(used), 'the storage trap is installed in the frame');
    assert.deepEqual(
      [...new Set(keys)].filter((k) => k !== `whombat-feedback:${SITE}`),
      [],
      'one key only',
    );
    return used;
  };

  try {
    await step('the embed tree serves the frame with its headers', async () => {
      const res = await fetch(`${embed.origin}/embed/v1/frame.html?site=${SITE}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors \*/);
      assert.match(
        res.headers.get('content-security-policy') ?? '',
        new RegExp(`connect-src ${controlOrigin}`),
      );
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.equal(res.headers.get('x-frame-options'), null);
      assert.equal((await fetch(`${embed.origin}/embed/v1/sites/${SITE}/config`)).status, 404);
    });

    await step(
      'a report is sealed in the browser; control gets ciphertext only; the reference is derived',
      async () => {
        const { context, page, errors } = await open(host.origin);
        const f = await waitForForm(page);
        await until('Send enabled after the loader’s message', async () =>
          f.locator('button[type=submit]').isEnabled(),
        );
        await f.locator('#wb-description').fill(CANARY);
        await f
          .locator('input[type=file]')
          .setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: PNG });
        await f.locator('.file img').waitFor();
        await f.locator('button[type=submit]').click();
        await f.locator('.receipt-title').waitFor();
        assert.equal(control.drops.length, 1);
        const drop = control.drops[0] as ControlDrop;
        assert.equal(drop.origin, embed.origin, 'the frame, on the embed origin, posts');
        assert.equal(drop.referer, undefined, 'no referrer');
        assert.equal(drop.cookie, undefined, 'no cookies');
        for (const needle of [CANARY, 'canary-7f3c1e', PNG.toString('base64'), hostOrigin])
          assert.equal(drop.bytes.includes(Buffer.from(needle)), false, `envelope contains ${needle}`);
        const opened = await openDropEnvelope(new Uint8Array(drop.bytes), (kid) =>
          kid === encryption.kid ? encryption.privateKey : null,
        );
        const pt = JSON.parse(opened.plaintextJson);
        assert.equal(pt.submission.description, CANARY);
        assert.equal(pt.submission.parentOrigin, host.origin);
        assert.equal(pt.submission.attachments[0].data, PNG.toString('base64'));
        assert.deepEqual(pt.frame.ancestorOrigins, [host.origin]);
        assert.equal(pt.frame.bridgeOrigin, host.origin);
        assert.equal(pt.frame.cardSeq, 3);
        assert.equal(
          await f.locator('.reference').innerText(),
          feedbackReferenceFor(SITE, pt.submission.submissionId),
        );
        assert.deepEqual(await storageUsed(page), []);
        assert.deepEqual(errors, []);
        await context.close();
      },
    );

    await step('a retry after a failure sends the identical bytes', async () => {
      control.drops.length = 0;
      control.answers.push({ status: 503, body: {} });
      const { context, page, errors } = await open(host.origin);
      const f = await waitForForm(page);
      await until('Send enabled', async () => f.locator('button[type=submit]').isEnabled());
      await f.locator('#wb-description').fill('Retry me');
      await f.locator('button[type=submit]').click();
      await f.locator('.alert').filter({ hasText: 'Something went wrong on our side' }).waitFor();
      await f.locator('.alert button').click();
      await f.locator('.receipt-title').waitFor();
      assert.equal(control.drops.length, 2);
      assert.ok(control.drops[0]?.bytes.equals(control.drops[1]?.bytes as Buffer), 'identical envelopes');
      assert.deepEqual(await storageUsed(page), []);
      assert.deepEqual(
        errors.filter((e) => !/503/.test(e)),
        [],
      );
      await context.close();
    });

    await step(
      'reporter sign-in through control: an attested drop and “Your reports” with local summaries',
      async () => {
        control.drops.length = 0;
        const { context, page, errors } = await open(host.origin);
        const f = await waitForForm(page);
        await until('Send enabled', async () => f.locator('button[type=submit]').isEnabled());
        await f.locator('#wb-signin-link').click();
        await f.locator('#wb-signin-email').fill('ann@example.com');
        await f.locator('button[type=submit]', { hasText: 'Send code' }).click();
        await f.locator('#wb-signin-code').fill(STUB_CODE);
        await f.locator('button[type=submit]', { hasText: 'Sign in' }).click();
        await f.locator('#wb-signed-in').waitFor();
        assert.deepEqual(control.reporters.codes.at(-1), { email: 'ann@example.com', parent: host.origin });
        await f.locator('#wb-description').fill('A signed-in drop');
        await f.locator('button[type=submit]').click();
        await f.locator('.receipt .follow').waitFor();
        const drop = control.drops[0] as ControlDrop;
        assert.equal(
          control.reporters.emailOf(drop.authorization),
          'ann@example.com',
          'the drop carries the bearer',
        );
        const pt = JSON.parse(
          (
            await openDropEnvelope(new Uint8Array(drop.bytes), (kid) =>
              kid === encryption.kid ? encryption.privateKey : null,
            )
          ).plaintextJson,
        );
        assert.equal(pt.submission.reporter.email, 'ann@example.com');
        const reference = await f.locator('.reference').innerText();
        // Control lists it once the Whombat collected and published it; its summary is always null.
        control.reporters.reports.set('ann@example.com', [
          {
            reference,
            type: 'bug',
            status: 'reviewing',
            receivedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            summary: null,
          },
        ]);
        await f.locator('.tab', { hasText: 'Your reports' }).click();
        await f.locator('.report').waitFor();
        assert.equal(await f.locator('.report-summary').innerText(), 'A signed-in drop');
        assert.equal(await f.locator('.report-status').innerText(), 'Being looked at');
        await f.locator('.signed-in button', { hasText: 'Sign out' }).click();
        await f.locator('#wb-signin-email').waitFor();
        assert.ok(control.reporters.signOuts.at(-1)?.startsWith('fbrs_'));
        assert.deepEqual(await storageUsed(page), []);
        assert.deepEqual(errors, []);
        await context.close();
      },
    );

    await step('a website the card doesn’t allow gets “unavailable” and sends nothing', async () => {
      control.drops.length = 0;
      const { context, page } = await open(otherHost.origin);
      const f = await frameOf(page);
      await f.getByText('Feedback isn’t available on this site right now.').waitFor();
      assert.equal(await f.locator('form').count(), 0);
      assert.equal(control.drops.length, 0);
      await context.close();
    });

    await step('a snippet pinning another key gets “unavailable”', async () => {
      const { context, page } = await open(host.origin, other.fingerprint);
      const f = await frameOf(page);
      await f.getByText('Feedback isn’t available on this site right now.').waitFor();
      assert.equal(await f.locator('form').count(), 0);
      assert.equal(control.drops.length, 0);
      await context.close();
    });
  } finally {
    await browser.close();
    await Promise.all([host.close(), otherHost.close(), embed.close(), control.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(`\n${results.length} scenarios passed\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
