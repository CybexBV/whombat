/**
 * `harness/demo` — the scripted acceptance demonstration of vertical slice B (R-75, assignment §15), run by
 * vitest only for its module resolution (the real `@whombat/client` from the pinned whombat-app). Two parts, each
 * on a freshly provisioned appliance (a claim is one use):
 *
 *   1. narrated: every step of slice B through the real client, printed as it happens;
 *   2. browser: headless Chromium (Playwright) drives the real web app as a person does (Whombat whombat-link.md
 *      LNK-13) — on the account site (:5190) the Link code from the box's screen and an email, the mailed link, the
 *      terms and “Link it”; then on the box's own page (:4621) the four letters from its screen, who you are, how it
 *      is reached (Whombat Link, already on), burrow onboarding, a task to the agent, and the approval of an agent's
 *      request — with a screenshot per step. No recovery kit is asked at the claim (Whombat BX-01).
 *
 * Output: `harness/reports/demo-<timestamp>/` (narration.md, demo.json, screenshots/). A step that could not be
 * demonstrated is reported as such with its screenshot, never as done.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pairingFingerprint } from '@whombat/protocol/session';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { stopAll } from '../dev/down.ts';
import { loadEnv } from '../dev/env.ts';
import { accountSitePage } from '../dev/services.ts';
import { parseLive } from '../dev/sources.ts';
import { up } from '../dev/up.ts';
import { acquireEnvLock } from '../lib/lock.ts';
import { REPORTS_DIR } from '../lib/paths.ts';
import { sleep } from '../lib/proc.ts';
import { openSession, sessionOps, whenOpen, whenState } from '../scenario-kit/app-client.ts';
import { applianceBox, lettersOf, waitForConsole } from '../scenario-kit/boxes.ts';
import { clientTicket, devices, sessionInfo, signIn, waitForMail } from '../scenario-kit/cloud.ts';
import { claimAppliance, ownerSession } from '../scenario-kit/slice.ts';
import {
  api,
  chatOf,
  collect,
  createApprovalAutomation,
  ensureWorkspace,
  eventType,
  theAgent,
  type Workspace,
} from '../scenario-kit/work.ts';

acquireEnvLock('harness/demo');
/** The onboarding's first step: “Name your Whombat” (Whombat AP-5673); “Name your burrow” before. */
const NAME_STEP = /^Name your (Whombat|burrow)$/;
const runId = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
const dir = join(REPORTS_DIR, `demo-${runId}`);
const shots = join(dir, 'screenshots');
mkdirSync(shots, { recursive: true });
const lines: string[] = [`# Acceptance demonstration ${runId}`, ''];
const steps: {
  part: string;
  step: string;
  outcome: 'done' | 'not demonstrated';
  detail?: string;
  screenshot?: string;
}[] = [];
const t0 = Date.now();

function say(text: string): void {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${text}`;
  process.stdout.write(`${line}\n`);
  lines.push(`- ${line}`);
}

function save(): void {
  writeFileSync(join(dir, 'narration.md'), `${lines.join('\n')}\n`);
  writeFileSync(
    join(dir, 'demo.json'),
    `${JSON.stringify({ runId, steps, environment: loadEnv()?.sources ?? null }, null, 2)}\n`,
  );
}

async function freshEnvironment(): Promise<void> {
  if (process.env.WB_DEMO_REUSE === '1') return;
  say('Fresh environment: stopping, removing the harness state and starting again (a claim is one use)');
  await stopAll({ purge: true, quiet: true });
  const r = await up({
    live: process.env.WB_DEMO_LIVE ? parseLive(process.env.WB_DEMO_LIVE) : null,
    lockfileDrift: false,
    without: new Set(),
    reset: false,
    quiet: true,
  });
  if (r.failures.length) throw new Error(`dev/up: ${r.failures.join('; ')}`);
  const e = loadEnv();
  say(
    `Environment up: control ${e?.control?.url}, relay ${e?.relay?.url}, web ${e?.web?.url}; appliance ${e?.appliance?.deviceId} (fingerprint ${e?.appliance?.fingerprint})`,
  );
}

afterAll(() => {
  lines.push('', '## Steps', '', '| Part | Step | Outcome | Detail |', '|---|---|---|---|');
  for (const s of steps)
    lines.push(
      `| ${s.part} | ${s.step} | ${s.outcome} | ${(s.detail ?? '').replace(/\|/g, '/')}${s.screenshot ? ` ![](screenshots/${s.screenshot})` : ''} |`,
    );
  save();
  process.stdout.write(`\nDemo report: ${join(dir, 'narration.md')}\n`);
});

describe('acceptance demo', () => {
  it('part 1: slice B, narrated, through the real client', async () => {
    lines.push('## Part 1 — slice B through the real client', '');
    await freshEnvironment();
    const part = 'narrated';
    const r = await claimAppliance({
      ownerKey: `demo-${runId.toLowerCase()}`,
      ownerName: 'Ada Owner',
      narrate: (step, d) => {
        say(`${step}${d ? ` ${JSON.stringify(d)}` : ''}`);
        steps.push({ part, step, outcome: 'done' });
      },
    });
    const { session, info } = await ownerSession(r.state, { backoff: { baseMs: 100, maxMs: 1000 } });
    say(
      `Connected on the app channel as ${info.account?.name}, protocol ${info.protocol.major}.${info.protocol.minor}`,
    );
    const w = await ensureWorkspace(session, `Demo ${randomBytes(2).toString('hex')}`);
    say(`The burrow “${w.slug}” with its agent ${w.agent.name}; your Chat ${w.conversationId}`);
    steps.push({ part, step: 'burrow, agent and Chat ready', outcome: 'done' });

    const events = collect(session, [`burrow:${w.burrowId}`, `conv:${w.conversationId}`]);
    const sent = await api<{ message: { id: string } }>(session, 'messages.send', 'POST', {
      params: { burrow: w.slug, conversationId: w.conversationId },
      body: { text: `@${w.agent.name} can you look at the release notes?` },
    });
    say(`Task sent to ${w.agent.name} (message ${sent.message.id}); waiting for “is thinking”`);
    await events.waitFor((e) => eventType(e) === 'typing', 15_000, 'thinking');
    const sockets = (session as unknown as { __sockets?: unknown[] }).__sockets;
    void sockets;
    say('Dropping the connection mid-stream (the relay connection is closed under the session)');
    const e = loadEnv();
    const relayRestart = await import('../dev/restart.ts');
    await relayRestart.restartService('relay');
    say('Relay restarted; the session reconnects and resumes from its cursor');
    await whenOpen(session, 60_000);
    const reply = await events.waitFor(
      (x) => {
        const m = (x.event as { message?: { author?: { id: string }; authorId?: string; text?: string } })
          .message;
        return eventType(x) === 'message.created' && (m?.author?.id ?? m?.authorId) === w.agent.id ? m : null;
      },
      60_000,
      'reply',
    );
    say(`${w.agent.name} answered: “${(reply as { text?: string }).text}”`);
    say(
      `Resumed without duplicates: duplicate cursors ${events.duplicateCursors().length}, duplicate messages ${events.duplicateMessages().length}, subscriptions ${JSON.stringify(events.readies)}`,
    );
    expect(events.duplicateMessages()).toEqual([]);
    steps.push({
      part,
      step: 'task answered after a relay restart, resumed from the cursor, no duplicates',
      outcome: 'done',
    });

    const auto = await createApprovalAutomation(session, w, 'release 1.4');
    await api(session, 'automations.runNow', 'POST', {
      params: { burrow: w.slug, id: auto.id },
      body: { test: false },
    });
    say('Started a run that asks the agent, then asks a person to approve');
    const approval = await events.waitFor(
      (x) => {
        const a = (x.event as { approval?: { number: number; state: string; title?: string } }).approval;
        return eventType(x) === 'approval.updated' && a?.state === 'pending' ? a : null;
      },
      90_000,
      'approval',
    );
    say(`Approval #${approval.number} asked: “${approval.title ?? ''}”; approving it`);
    await api(session, 'approvals.decide', 'POST', {
      params: { burrow: w.slug, number: approval.number },
      body: { decision: 'approve' },
    });
    await events.waitFor(
      (x) =>
        ((x.event as { message?: { text?: string } }).message?.text ?? '').includes(
          'Approved and published: release 1.4',
        ) || null,
      90_000,
      'posted',
    );
    say('Approved; the run posted its result');
    steps.push({ part, step: 'agent request approved; result posted', outcome: 'done' });
    events.close();
    session.close('closed');
    void e;
    save();
  }, 600_000);

  it('part 2: the web app in a browser (Whombat Link → claim → connect → task → approve)', async () => {
    lines.push('', '## Part 2 — the web app in headless Chromium', '');
    await freshEnvironment();
    const e = loadEnv();
    const box = applianceBox();
    // The account site (app.whombat.com on a real box) and the box's own page (its HTTPS address on a real box).
    const site = (e?.web?.url ?? 'http://localhost:5190').replace('127.0.0.1', 'localhost');
    const web = box.directUrl
      .replace(/^ws/, 'http')
      .replace(/\/v1\/direct$/, '')
      .replace('127.0.0.1', 'localhost');
    const email = `demo-browser-${runId.toLowerCase()}@harness.whombat.local`;
    const part = 'browser';
    let browser: Browser | null = null;
    let n = 0;
    const shot = async (page: Page, name: string) => {
      const file = `${String(++n).padStart(2, '0')}-${name}.png`;
      await page.screenshot({ path: join(shots, file), fullPage: false });
      return file;
    };
    const step = async (page: Page, name: string, fn: () => Promise<string | undefined>) => {
      try {
        const detail = await fn();
        const file = await shot(page, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
        steps.push({ part, step: name, outcome: 'done', ...(detail ? { detail } : {}), screenshot: file });
        say(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
        return true;
      } catch (err) {
        const file = await shot(page, `not-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(
          () => undefined,
        );
        const detail = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
        steps.push({
          part,
          step: name,
          outcome: 'not demonstrated',
          ...(detail ? { detail } : {}),
          ...(file ? { screenshot: file } : {}),
        });
        say(`✗ ${name} — not demonstrated: ${detail}`);
        return false;
      }
    };
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        acceptDownloads: true,
      });
      const page = await context.newPage();
      let slug = '';
      let burrowless = false;
      const ok1 = await step(
        page,
        'the account site: the code from the box’s screen and an email; the link as mailed',
        async () => {
          const shown = await waitForConsole(
            box,
            (x) => x.link?.state === 'starting' && !!x.link.code,
            'a Whombat Link code',
            120_000,
          );
          const code = shown.link?.code ?? '';
          // A fresh Vite dev server optimizes dependencies on the first load and then reloads the page: load it,
          // let it settle, then start from a clean load. The page is the one the screen names (`…/link`).
          const linkPage = accountSitePage(shown.link?.url ?? `${site}/link`);
          await page.goto(linkPage);
          await page.getByRole('heading', { name: 'Link your Whombat' }).waitFor({ timeout: 120_000 });
          await page.waitForLoadState('networkidle');
          await sleep(3000);
          await page.goto(linkPage);
          await page.getByRole('heading', { name: 'Link your Whombat' }).waitFor({ timeout: 60_000 });
          const since = Date.now();
          await page.getByLabel('Code from its screen').fill(code);
          await page.getByLabel('Email').fill(email);
          await page.getByRole('button', { name: 'Email me a link' }).click();
          await page.getByRole('heading', { name: 'Check your email' }).waitFor();
          const mailText = (await waitForMail(email, since)).text;
          const link = /https?:\/\/\S+\/auth\/verify\S+/.exec(mailText)?.[0] ?? '';
          // Exactly as mailed (`#token=…`, and back to the code's page), on the address the site answers at here.
          await page.goto(accountSitePage(link));
          await page
            .getByRole('heading', { name: /^Add .+ to Whombat Link\?$/ })
            .waitFor({ timeout: 30_000 });
          if (!(await page.getByText(code).first().isVisible()))
            throw new Error(`the page doesn’t say which Whombat: the code ${code} isn’t on it`);
          return `screen shows ${code} · ${linkPage} · ${link.replace(/token=[^&]+/, 'token=…')}`;
        },
      );
      const ok2 =
        ok1 &&
        (await step(
          page,
          'terms ticked; linked: the free month starts and the box’s Link is on',
          async () => {
            // “Link it” stays disabled until the Subscription Terms are ticked.
            const terms = page.getByRole('checkbox', { name: /I agree to the/ });
            if (!(await page.getByRole('button', { name: 'Link it' }).isDisabled()))
              throw new Error('“Link it” is enabled before the terms are ticked');
            await terms.check();
            await page.getByRole('button', { name: 'Link it' }).click();
            await page.getByRole('heading', { name: /is linked$/ }).waitFor({ timeout: 30_000 });
            await waitForConsole(box, (x) => x.link?.state === 'on', 'Whombat Link on', 60_000);
            await page.getByRole('button', { name: 'Your Whombats' }).click();
            await page
              .getByText(/^Free month/)
              .first()
              .waitFor({ timeout: 30_000 });
            return 'the account lists the Whombat in its free month';
          },
        ));
      const ok3 =
        ok2 &&
        (await step(
          page,
          'the box’s own page: the letters from its screen, who you are; claimed; reach says Whombat Link is on',
          async () => {
            const c = await waitForConsole(box, (x) => x.state === 'claimable' && !!x.code, 'a claim code');
            const typed = lettersOf(c.code ?? '');
            // The page the screen names; its first load settles like the account site's.
            const own = c.url.replace(/\/$/, '');
            if (own !== web) throw new Error(`the screen names ${c.url}, the box’s page is ${web}`);
            await page.goto(web);
            await page.getByRole('heading', { name: 'Claim your Whombat' }).waitFor({ timeout: 120_000 });
            await page.waitForLoadState('networkidle');
            await page.locator('#setup-letters').fill(typed);
            await page.getByRole('button', { name: 'Continue' }).click();
            await page.getByRole('heading', { name: 'Who are you?' }).waitFor({ timeout: 30_000 });
            await page.locator('#setup-name').fill('Bea Browser');
            await page.locator('#setup-email').fill(email);
            await page.getByRole('button', { name: 'Claim it' }).click();
            // No recovery kit at the claim (Whombat BX-01). Next: how the box is reached, which Link already answers.
            await page.getByRole('heading', { name: 'Reach it from anywhere' }).waitFor({ timeout: 30_000 });
            await page.getByText('Whombat Link is on').waitFor({ timeout: 30_000 });
            if (
              await page
                .getByRole('heading', { name: 'Save your recovery kit' })
                .isVisible()
                .catch(() => false)
            )
              throw new Error('the claim asked for a recovery kit');
            await page.getByRole('button', { name: 'Continue' }).click();
            // “Protect your Whombat” (AP-260) only for a box without a backup destination; it can be skipped.
            const protect = page.getByRole('heading', { name: 'Protect your Whombat' });
            const burrow = page.getByRole('heading', { name: NAME_STEP });
            await protect.or(burrow).first().waitFor({ timeout: 30_000 });
            const said = [`screen shows ${typed} · ${c.url}`];
            if (await protect.isVisible().catch(() => false)) {
              await page.getByRole('button', { name: 'Skip for now' }).click();
              said.push('“Protect your Whombat”: “Skip for now”');
            }
            return said.join('; ');
          },
        ));
      const ok4 =
        ok3 &&
        (await step(page, 'connected: burrow onboarding over the secure session', async () => {
          await page.getByRole('heading', { name: NAME_STEP }).waitFor({ timeout: 30_000 });
          // App ≥ 0.3.1 (AP-75): the name starts as the organization's.
          const started = await page.locator('#onboarding-burrow-name').inputValue();
          await page
            .locator('#onboarding-burrow-name')
            .fill(`Demo Browser ${randomBytes(2).toString('hex')}`);
          const skipped: string[] = [];
          for (let i = 0; i < 8; i++) {
            const next = page.locator('footer button, [class*=footer] button').last();
            const label = (await next.textContent())?.trim() ?? '';
            if (/^Open/i.test(label)) {
              await next.click();
              break;
            }
            // “Set up your AI” keeps “Continue” off until an AI is picked and signed in. Nobody signs in here (the
            // scripted Hermes answers without one), so that step is skipped, as a person may.
            if (await next.isDisabled()) {
              skipped.push(
                (await page.getByRole('heading', { level: 1 }).first().textContent())?.trim() ?? '',
              );
              await page.getByRole('button', { name: 'Skip for now' }).click();
            } else await next.click();
            await sleep(700);
          }
          await page.waitForURL((u) => !u.pathname.includes('onboarding'), { timeout: 30_000 });
          // App ≥ 0.13.0 (AP-361): burrow-less paths (`/chat`); the open burrow is remembered in the tab's storage
          // (`whombat.burrow[.<appliance>]`), so the slug comes from there and the paths drop it (IN-124).
          const remembered = await page.evaluate(() => {
            for (let i = 0; i < sessionStorage.length; i++) {
              const k = sessionStorage.key(i);
              if (k?.startsWith('whombat.burrow')) return sessionStorage.getItem(k) ?? '';
            }
            return '';
          });
          const first = new URL(page.url()).pathname.split('/')[1] ?? '';
          burrowless = !!remembered && first !== remembered;
          slug = remembered || first;
          if (!slug) throw new Error('no burrow in the URL or remembered in the tab');
          return `burrow /${slug}${started ? ` (the name started as “${started}”)` : ''}${skipped.length ? `; skipped for now: ${skipped.join(', ')}` : ''}`;
        }));
      const ok5 =
        ok4 &&
        (await step(page, 'a task to the agent in the Chat; its reply streams in', async () => {
          // The person's Chat with the Whombat's one agent (Whombat one-agent.md OA-04): every message reaches it.
          await page.goto(`${web}${burrowless ? '' : `/${slug}`}/chat`);
          const box = page.getByRole('textbox').last();
          await box.click();
          await box.fill('Please summarize the release notes');
          await page.keyboard.press('Enter');
          await page
            .getByText(/On it\./)
            .first()
            .waitFor({ timeout: 60_000 });
          return 'reply shown';
        }));
      // Approval: the harness joins as a second device of the same account (the browser lets it in), starts a
      // run that asks for approval, and the person approves it in the browser.
      ok5 &&
        (await step(page, 'an agent asks for approval; approved in the browser', async () => {
          // The same person, signed in separately; tickets come under the account's Whombat Link org (it holds the box).
          const signed = await signIn(e?.control?.url ?? '', email);
          const info = await sessionInfo(e?.control?.url ?? '', signed.session.token);
          let org = '';
          for (const o of info.orgs) {
            const d = await devices(e?.control?.url ?? '', signed.session.token, o.orgId);
            if (d.devices.some((x) => x.device === box.deviceId)) org = o.orgId;
          }
          if (!org) throw new Error('no org of this account holds the appliance');
          const p = { session: signed.session, org };
          const identity = await (await import('../scenario-kit/app-client.ts')).newEndpointIdentity();
          const enroll = openSession({
            tickets: async (r) => {
              const t = await clientTicket(
                e?.control?.url ?? '',
                p.session.token,
                p.org,
                box.deviceId,
                'enroll',
                r.class,
              );
              return { ticket: t.ticket, relayUrl: t.relay.url };
            },
            identity,
            appliance: { peerId: box.peerId },
            channel: 'enroll',
            expect: 'any',
          });
          await whenOpen(enroll);
          // The account is the ticket's (one person's Whombat): the request names only the device.
          const req = (await sessionOps.pairRequest(enroll, {
            endpoint: { label: 'Demo harness', platform: 'cli' },
          })) as { code: string; pairingId: string };
          await page.goto(`${web}${burrowless ? '' : `/${slug}`}/settings?tab=devices`);
          // Devices offers a phone and a computer first; the code field is behind “Have a code already?”.
          const codeField = page.getByLabel('Code shown on the new device');
          const haveCode = page.getByRole('button', { name: 'Have a code already?' });
          await codeField.or(haveCode).first().waitFor({ timeout: 30_000 });
          if (!(await codeField.isVisible().catch(() => false))) await haveCode.click();
          await codeField.fill(req.code);
          // Contracts 0.5.2 (CT-46): the browser looks the code up and shows the asking device's fingerprint, which
          // must be the one this device shows, before it lets it in.
          await page.getByRole('button', { name: 'Continue' }).click();
          const shown = page.getByTestId('pairing-fingerprint');
          await shown.waitFor({ timeout: 20_000 });
          const expected = pairingFingerprint(identity.peerId);
          if (!(await shown.innerText()).includes(expected))
            throw new Error(`the browser shows ${await shown.innerText()}, this device ${expected}`);
          await shot(page, 'pairing-fingerprint');
          await page.getByRole('button', { name: 'Let it in' }).click();
          await page.getByText('Let in.').waitFor({ timeout: 20_000 });
          enroll.close('closed');
          const harness = openSession({
            tickets: async (r) => {
              const t = await clientTicket(
                e?.control?.url ?? '',
                p.session.token,
                p.org,
                box.deviceId,
                'app',
                r.class,
              );
              return { ticket: t.ticket, relayUrl: t.relay.url };
            },
            identity,
            appliance: { peerId: box.peerId },
            channel: 'app',
          });
          await whenOpen(harness);
          const agent = await theAgent(harness, slug);
          const w: Workspace = {
            burrowId: '',
            slug,
            agent: { id: agent.id, handle: agent.handle, name: agent.name },
            conversationId: await chatOf(harness, slug),
            mePrincipalId: '',
          };
          const auto = await createApprovalAutomation(harness, w, 'browser demo');
          await api(harness, 'automations.runNow', 'POST', {
            params: { burrow: slug, id: auto.id },
            body: { test: false },
          });
          await page.goto(`${web}${burrowless ? '' : `/${slug}`}/chat`);
          // The Chat is a list of threads (Whombat chat-inbox CIB): the run asks in its own thread, opened here.
          const asked = page.getByText(/I need a person to say/).first();
          await asked.waitFor({ timeout: 90_000 });
          await asked.click();
          // The card's answers: “Yes, now”, “Yes, tonight”, “No” (Whombat approval-card.md); “Approve” before.
          const approve = page.getByRole('button', { name: /^(Yes, now|Approve)/ }).first();
          await approve.waitFor({ timeout: 90_000 });
          await shot(page, 'approval-card');
          await approve.click();
          // The run goes on with the decision: its result is posted in the same thread.
          await page.getByText('Approved and published: browser demo').first().waitFor({ timeout: 90_000 });
          harness.close('closed');
          return 'approved in the UI; the run posted its result';
        }));
    } finally {
      await browser?.close();
      save();
    }
    const missing = steps.filter((x) => x.part === part && x.outcome !== 'done').map((x) => x.step);
    expect(missing, 'browser steps not demonstrated').toEqual([]);
    void whenState;
  }, 900_000);
});
