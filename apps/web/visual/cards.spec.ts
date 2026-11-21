/**
 * Chat cards against the reference (`Whombat Desktop.dc.html`), light and dark, clock frozen at
 * 2026-09-23 11:22 Europe/Amsterdam. Each card is cropped from the reference screen it appears on
 * (channel: plan, research, run, approval; branch: commits, pill, review; #incidents: receipts) and from
 * the cards harness (`/visual/cards.html`, fixture mode) at the same 640px width, then diffed.
 *
 * The reference's timers are faked (`page.clock.install`), so the live run stays at tick 0 until the
 * spec plays it forward: 8 ticks of 2.6s give RUN · DONE, the finished plan and — once approved —
 * DEPLOYED. Approval states come from clicking the mock ("Approve in advance", Details → Decline).
 *
 * Known, deliberate differences:
 * - The ✓ in met conditions is a Lucide check instead of the glyph (TP-14): those marks are masked.
 * - An approval's answers are all outlined, in the card's order (approval-card.md ACD-04): its answer row is masked.
 * - DEPLOYED shows no Undo (B-02: undo only until the action has executed); only the part above the
 *   mock's Undo row is compared.
 * - Avatars at 22px differ by anti-aliasing (AV-02); the tolerance covers it.
 * - The plan and run cards follow the final design's one card layout (docs/decisions/chat-threads-cards.md CTC-08,
 *   CTC-10, CTC-13), not this mock: they are baselines of their own here (`the cards' one layout`), light and dark.
 * - A live run that changed something, a decided approval and a finished plan show as their line in the app (card-settle.md
 *   AP-730, AP-733); the line is opened and the card under it compared (AP-5107).
 * - The mock's crew has the fixture world's names (`renameInReference`): its Dusty and Banjo are the one agent, Neo,
 *   and Hazel's review is Mara's; its staging address is the fixture world's example domain; a declined approval tells nobody (the person declined it); the receipts are the
 *   contracts' fixture answer (Dusty's), whose first source is the branch room the mock's #incidents became (AP-5107).
 * The thread pane's compact receipts cannot be captured: the mock's "5 replies" button does not open
 * its pane (the template binds an undefined `openThread`).
 * The fixture world differs from the mock in one run detail (the mock's tick-0 run shows the first LIVE
 * line, "Editing billing/pdf/format.ts"); the harness states in `cardStates.ts` use the mock's values.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import {
  assetCacheDir,
  cacheExternalAssets,
  cropPng,
  diffPng,
  FROZEN_NOW,
  maskPng,
  REFERENCE_DIR,
  REFERENCE_FILES,
  REPO_ROOT,
  type Rect,
  rewriteDataProps,
  serveDirectory,
  waitForWebFonts,
} from '@whombat/visual-tools';
import { expect, hideAdditions, ONE_PERSON_WORDS, renameInReference, test } from './support/harness';

const OUT = resolve(import.meta.dirname, '../../../tmp/visual/cards');
const VIEWPORT = { width: 1440, height: 2400 };
/** Live ticks until the mock's run is done (`LIVE.length`). */
const TICKS = 8;
const TICK_MS = 2600;

type Theme = 'light' | 'dark';

/** A reference card: which text identifies it on the reference screen. */
interface RefCard {
  state: string;
  /** Text the card contains (the mock has no ids). */
  text: string;
  /** `pill`: the status pill span. */
  selector?: 'card' | 'pill';
}

interface Shot {
  png: Buffer;
  /** Check marks to mask, relative to the card. */
  masks: Rect[];
  /** Sub-pixel offset of the card on the page (text and borders snap differently at .5px). */
  frac: { x: number; y: number };
}

type Box = { x: number; y: number; width: number; height: number };

/** Screenshot of a box on the viewport, widened to whole pixels. */
async function shootBox(page: Page, box: Box): Promise<Buffer> {
  const x = Math.floor(box.x);
  const y = Math.floor(box.y);
  return page.screenshot({
    clip: { x, y, width: Math.ceil(box.x + box.width) - x, height: Math.ceil(box.y + box.height) - y },
    animations: 'disabled',
  });
}

/* Reference ------------------------------------------------------------------------------------- */

/**
 * The mock's crew by the fixture world's names: its agent is the one agent, Hazel's review is Mara's (AP-5107); one
 * person's words (AP-5725).
 */
const CREW_NAMES = {
  Dusty: 'Neo',
  Banjo: 'Neo',
  Hazel: 'Mara',
  ...ONE_PERSON_WORDS,
};

async function openReference(
  browser: Browser,
  start: string,
  theme: Theme,
  names: Readonly<Record<string, string>> = CREW_NAMES,
) {
  const dir = await mkdtemp(join(tmpdir(), 'whombat-cards-ref-'));
  await cp(REFERENCE_DIR, dir, { recursive: true });
  const entry = REFERENCE_FILES.desktop;
  const html = rewriteDataProps(await readFile(join(REFERENCE_DIR, entry), 'utf8'), { start, theme });
  await writeFile(join(dir, entry), html);
  const server = await serveDirectory(dir);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    timezoneId: 'Europe/Amsterdam',
    locale: 'en-GB',
  });
  await cacheExternalAssets(context, assetCacheDir(REPO_ROOT));
  const page = await context.newPage();
  await page.clock.install({ time: FROZEN_NOW });
  await page.goto(`${server.url}/${encodeURIComponent(entry)}`);
  await expect
    .poll(() => page.evaluate(() => document.getElementById('dc-root')?.childElementCount ?? 0), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await renameInReference(page, names);
  return {
    page,
    close: async () => {
      await context.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Element screenshot of the mock card containing `text`, plus the met-condition marks to mask. */
async function referenceCard(page: Page, card: RefCard): Promise<Shot> {
  const handle = await page.evaluateHandle(
    ({ text, selector }) => {
      const all = [...document.querySelectorAll<HTMLElement>('div, span')];
      const isCard = (el: HTMLElement) =>
        selector === 'pill'
          ? el.tagName === 'SPAN' && el.style.alignSelf === 'flex-start' && el.style.borderRadius === '999px'
          : el.style.maxWidth === '640px';
      const found = all.find((el) => isCard(el) && el.textContent?.includes(text));
      if (!found) throw new Error(`reference card with "${text}" not found`);
      return found;
    },
    { text: card.text, selector: card.selector ?? 'card' },
  );
  const el = handle.asElement();
  if (!el) throw new Error('not an element');
  if (card.state === 'plan')
    // A step's owner (its avatar or initials and name) left of its state; the state stays (AP-5103).
    await el.evaluate((root) => {
      for (const name of root.querySelectorAll<HTMLElement>('span')) {
        const owner = name.parentElement;
        if (name.style.fontSize !== '13.5px' || !owner) continue;
        for (const part of owner.children)
          if (part !== owner.lastElementChild && part instanceof HTMLElement) part.style.display = 'none';
      }
    });
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const { box, masks } = await el.evaluate((root) => {
    const b = root.getBoundingClientRect();
    const marks = [...root.querySelectorAll<HTMLElement>('span')]
      .filter((s) => s.textContent === '✓' && s.style.borderRadius === '50%')
      .map((s) => {
        const r = s.getBoundingClientRect();
        return { x: Math.round(r.x - b.x), y: Math.round(r.y - b.y), width: r.width, height: r.height };
      });
    return { box: { x: b.x, y: b.y, width: b.width, height: b.height }, masks: marks };
  });
  return { png: await shootBox(page, box), masks, frac: { x: box.x % 1, y: box.y % 1 } };
}

async function playRun(page: Page) {
  for (let i = 0; i < TICKS; i++) await page.clock.runFor(TICK_MS);
  await page.waitForTimeout(100);
}

/* Mine ------------------------------------------------------------------------------------------ */

async function openHarness(page: Page, theme: Theme, states: string[], { additions = false } = {}) {
  await page.setViewportSize(VIEWPORT);
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.goto(`/visual/cards.html?theme=${theme}&states=${states.join(',')}`);
  await page.locator('[data-state] [data-card]').first().waitFor();
  // A baseline shows the card whole; only a comparison with the mock hides what the app adds to it.
  if (!additions) await hideAdditions(page);
  await waitForWebFonts(page);
  await page.waitForTimeout(300);
}

/**
 * My card, placed at the reference card's sub-pixel offset. A card the app draws as its live or settled line (a live run
 * that changed something, a decided approval, a finished plan: card-settle.md AP-730, AP-733) is compared as the card
 * that line opens in place, which is the mock's card (hermes-engine-app.md AP-5107).
 */
async function mine(page: Page, state: string, like: Shot): Promise<Shot> {
  const opener = page.locator(`[data-state="${state}"] [data-variant] button[aria-expanded="false"]`).first();
  if (await opener.count()) {
    await opener.click();
    await page.locator(`[data-state="${state}"] [data-card]:not([data-variant])`).first().waitFor();
    await page.mouse.move(0, 0);
  }
  const card = page.locator(`[data-state="${state}"] [data-card]:not([data-variant])`).first();
  await card.evaluate((el, frac) => {
    const wrapper = el.parentElement as HTMLElement;
    wrapper.style.paddingTop = '0px';
    wrapper.style.paddingLeft = '0px';
    const r = el.getBoundingClientRect();
    const dx = (((frac.x - (r.x % 1)) % 1) + 1) % 1;
    const dy = (((frac.y - (r.y % 1)) % 1) + 1) % 1;
    wrapper.style.paddingLeft = `${dx}px`;
    wrapper.style.paddingTop = `${dy}px`;
  }, like.frac);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(50);
  const { box, masks } = await card.evaluate((root) => {
    const b = root.getBoundingClientRect();
    // An approval's answers are outlined alike and in the card's order (approval-card.md ACD-04): its row is masked.
    const marks = [...root.querySelectorAll('[data-met="true"] > span:first-child, [data-answers]')].map(
      (s) => {
        const r = s.getBoundingClientRect();
        return { x: Math.round(r.x - b.x), y: Math.round(r.y - b.y), width: r.width, height: r.height };
      },
    );
    return { box: { x: b.x, y: b.y, width: b.width, height: b.height }, masks: marks };
  });
  return { png: await shootBox(page, box), masks, frac: { x: box.x % 1, y: box.y % 1 } };
}

/* Compare --------------------------------------------------------------------------------------- */

const results: string[] = [];

async function compare(
  name: string,
  ref: Shot,
  me: Shot,
  options: { maxPercent?: number; topOnly?: boolean } = {},
) {
  const refSize = await pngSize(ref.png);
  const mySize = await pngSize(me.png);
  let refPng = ref.png;
  let myPng = me.png;
  if (options.topOnly) {
    const height = Math.min(refSize.height, mySize.height) - 20;
    refPng = cropPng(refPng, { x: 0, y: 0, width: refSize.width, height });
    myPng = cropPng(myPng, { x: 0, y: 0, width: mySize.width, height });
  }
  const masks = [...ref.masks, ...me.masks];
  const result = diffPng(maskPng(refPng, masks), maskPng(myPng, masks));
  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, `${name}-reference.png`), refPng);
  await writeFile(resolve(OUT, `${name}-mine.png`), myPng);
  await writeFile(resolve(OUT, `${name}-diff.png`), result.diff);
  const line = `${name}: ${result.percent.toFixed(3)}% (${refSize.width}×${refSize.height} vs ${mySize.width}×${mySize.height})`;
  results.push(line);
  console.log(line);
  expect(result.sizeMatches, `${name} size ${line}`).toBe(true);
  expect(result.percent, line).toBeLessThan(options.maxPercent ?? 0.1);
}

async function pngSize(png: Buffer) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, 'results.txt'), `${results.join('\n')}\n`);
});

for (const theme of ['light', 'dark'] as const) {
  test(`channel cards match the reference (${theme})`, async ({ browser, page }) => {
    test.setTimeout(240_000);
    const ref = await openReference(browser, 'channel', theme);
    try {
      const research = await referenceCard(ref.page, { state: 'research', text: 'RESEARCH ·' });
      const approval = await referenceCard(ref.page, { state: 'approval', text: 'staging · billing-api' });
      await ref.page.getByRole('button', { name: 'Approve in advance' }).click();
      const waiting = await referenceCard(ref.page, { state: 'approval', text: 'staging · billing-api' });
      await playRun(ref.page);
      const deployed = await referenceCard(ref.page, { state: 'approval', text: 'staging · billing-api' });

      await openHarness(page, theme, ['research', 'approval', 'approval-waiting', 'approval-deployed']);
      await compare(`research-${theme}`, research, await mine(page, 'research', research));
      await compare(`approval-${theme}`, approval, await mine(page, 'approval', approval));
      await compare(`approval-waiting-${theme}`, waiting, await mine(page, 'approval-waiting', waiting));
      await compare(`approval-deployed-${theme}`, deployed, await mine(page, 'approval-deployed', deployed), {
        topOnly: true,
      });
    } finally {
      await ref.close();
    }
  });

  test(`declined approval matches the reference (${theme})`, async ({ browser, page }) => {
    test.setTimeout(180_000);
    const ref = await openReference(browser, 'channel', theme);
    try {
      await ref.page.getByRole('button', { name: 'Details', exact: true }).click();
      await ref.page.getByRole('button', { name: 'Decline', exact: true }).click();
      // The person declined it themselves: nobody else is told (the contracts' `toldSentence`; AP-5107, AP-5725).
      await ref.page.evaluate(() => {
        // The deepest element holding the sentence (document order puts ancestors first).
        const line = [...document.querySelectorAll<HTMLElement>('div, p, span')]
          .filter((el) => (el.textContent ?? '').includes(' Neo and Mara have been told.'))
          .at(-1);
        if (line) line.textContent = (line.textContent ?? '').replace(' Neo and Mara have been told.', '');
      });
      const declined = await referenceCard(ref.page, { state: 'approval', text: 'staging · billing-api' });
      await openHarness(page, theme, ['approval-declined']);
      await compare(`approval-declined-${theme}`, declined, await mine(page, 'approval-declined', declined));
    } finally {
      await ref.close();
    }
  });

  test(`ready approval matches the reference (${theme})`, async ({ browser, page }) => {
    test.setTimeout(180_000);
    const ref = await openReference(browser, 'channel', theme);
    try {
      await playRun(ref.page);
      const ready = await referenceCard(ref.page, { state: 'approval', text: 'staging · billing-api' });
      await openHarness(page, theme, ['approval-ready']);
      await compare(`approval-ready-${theme}`, ready, await mine(page, 'approval-ready', ready));
    } finally {
      await ref.close();
    }
  });

  test(`branch room cards match the reference (${theme})`, async ({ browser, page }) => {
    test.setTimeout(180_000);
    const ref = await openReference(browser, 'branch', theme);
    try {
      const commits = await referenceCard(ref.page, { state: 'commits', text: 'signed by' });
      const pill = await referenceCard(ref.page, {
        state: 'pill',
        text: '38 of 41 passed',
        selector: 'pill',
      });
      const review = await referenceCard(ref.page, { state: 'review', text: 'REVIEW ·' });
      await openHarness(page, theme, ['commits', 'pill', 'review']);
      await compare(`commits-${theme}`, commits, await mine(page, 'commits', commits));
      await compare(`pill-${theme}`, pill, await mine(page, 'pill', pill));
      await compare(`review-${theme}`, review, await mine(page, 'review', review));
    } finally {
      await ref.close();
    }
  });

  test(`receipts match the reference (${theme})`, async ({ browser, page }) => {
    test.setTimeout(180_000);
    // The receipts are the contracts' fixture answer: Dusty's, its first source the branch room the mock's #incidents
    // became (no channels, Whombat one-agent.md OA-04; AP-5107), whose commit is Mara's (the world is hers alone,
    // contracts CT-1516; AP-5725).
    const ref = await openReference(browser, 'channel', theme, { 'Tom Beck': 'Mara Okafor' });
    try {
      await ref.page.getByText('incidents', { exact: true }).first().click();
      await ref.page.getByText('RECEIPTS').first().waitFor();
      await ref.page.evaluate(() => {
        const source = [...document.querySelectorAll<HTMLElement>('div, p, span')]
          .filter((el) => (el.textContent ?? '').startsWith('#incidents · '))
          .at(-1);
        if (source)
          source.textContent = (source.textContent ?? '').replace('#incidents', 'fix/credit-note-vat');
      });
      const answer = await referenceCard(ref.page, { state: 'answer', text: 'RECEIPTS' });
      await openHarness(page, theme, ['answer']);
      await compare(`answer-${theme}`, answer, await mine(page, 'answer', answer));
    } finally {
      await ref.close();
    }
  });

  // The final design's one card layout (chat-threads-cards.md): no mock of the app's own, so baselines. Each card as it
  // first shows, then the Details of the failed run opened.
  test(`the cards' one layout (${theme})`, async ({ page }) => {
    const states = ['plan', 'plan-go-ahead', 'plan-all-markers', 'run', 'run-failed', 'run-taken-over'];
    await openHarness(page, theme, states, { additions: true });
    for (const state of states) {
      const card = page.locator(`[data-state="${state}"] [data-card]`).first();
      await expect.soft(card).toHaveScreenshot(`card-frame-${state}-${theme}.png`);
    }
    const failed = page.locator('[data-state="run-failed"] [data-card]').first();
    await failed.getByText('Details', { exact: true }).click();
    await page.mouse.move(0, 0);
    await expect.soft(failed).toHaveScreenshot(`card-frame-run-failed-details-${theme}.png`);
  });
}
