/**
 * Shared harness for the visual suite (`pnpm visual`, see tools/visual/README.md).
 *
 * - `test` routes unpkg and Google Fonts through the disk cache with retries (tools/visual `network.ts`).
 * - `openApp` opens the web app (fixture mode) deterministically: theme in localStorage, macOS platform
 *   (B-03: the ⌘K hint), clock frozen at 2026-09-23 11:22 Europe/Amsterdam, fixed viewport.
 * - `settle` waits for network idle, the web fonts (not a fallback) and two frames.
 * - `patchQueries` / `neutraliseWorld` patch the cached fixture data where the fixture world differs from
 *   the mock's hard-coded seed (documented per call site, never a mask).
 * - `deviationMasks` returns the only masks the suite allows: Lucide icons in the mock's glyph slots
 *   (TP-14) and agent avatars (AV-02, compared on their own in `avatars.spec.ts`).
 * - `mainRegion` is what a comparison with the desktop mock covers on a screen with the sidebar: the mock's sidebar is
 *   the crew's, the app's the one agent's shell (Whombat one-agent.md OA-03; hermes-engine-app.md AP-5100).
 * - `renameInReference` gives the mock's crew the fixture world's names: its agents are the one agent (Neo, OA-08).
 * - `expectMatch` crops, masks, diffs, writes `tmp/visual/<name>-{reference,mine,diff}.png` and asserts
 *   the budget.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test as base, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  assetCacheDir,
  cacheExternalAssets,
  cropPng,
  diffPng,
  FROZEN_NOW,
  maskPng,
  REPO_ROOT,
  type Rect,
  waitForWebFonts,
} from '@whombat/visual-tools';

export type { Rect };
export { expect };

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

export const OUT = resolve(REPO_ROOT, 'tmp/visual');
export const SIDEBAR_WIDTH = 256;
export const HEIGHT = 900;

/** Playwright `test` with third-party assets served from the disk cache. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await cacheExternalAssets(context, assetCacheDir(REPO_ROOT));
    await use(context);
  },
});

export interface OpenOptions {
  path: string;
  theme: Theme;
  width?: number;
  height?: number;
}

/** Open the app at `path` with the stored theme, the macOS shortcut hint and the frozen clock. */
export async function openApp(page: Page, { path, theme, width = 1440, height = HEIGHT }: OpenOptions) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((t) => {
    localStorage.setItem('whombat:theme', t);
    // B-03: the reference shows ⌘K; the app shows ⌘K on Apple platforms and Ctrl K elsewhere.
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  }, theme);
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.goto(path);
}

/** Network idle, web fonts loaded, two animation frames and a short settle. */
export async function settle(page: Page, ms = 250): Promise<void> {
  await page.waitForLoadState('networkidle');
  await waitForWebFonts(page);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(ms);
}

/**
 * Replace the cached data of every query of `endpoint` with `patch(data, arg)`. `patch` runs in the page:
 * it must be self-contained (no closures); pass values through `arg`.
 */
export async function patchQueries<A>(
  page: Page,
  endpoint: string,
  // biome-ignore lint/suspicious/noExplicitAny: cached query data is untyped here
  patch: (data: any, arg: A) => unknown,
  arg: A,
): Promise<number> {
  return page.evaluate(
    ({ endpoint, source, arg }) => {
      const app = window.__WHOMBAT__;
      if (!app) throw new Error('window.__WHOMBAT__ is only set in dev builds');
      const qc = app.services.queryClient;
      const fn = new Function(`return (${source})`)() as (data: unknown, arg: unknown) => unknown;
      let n = 0;
      for (const q of qc.getQueryCache().findAll({ queryKey: ['whombat', endpoint] })) {
        if (q.state.data === undefined) continue;
        qc.setQueryData(q.queryKey, fn(q.state.data, arg));
        n++;
      }
      return n;
    },
    { endpoint, source: patch.toString(), arg },
  );
}

/**
 * Give every cached query of `endpoint` this data, loaded or not: for reads the fixture world does not
 * serve (they 404 there), on screens that are baselined rather than compared with a mock.
 */
export async function seedQueries(page: Page, endpoint: string, data: unknown): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ endpoint, data }) => {
          const qc = window.__WHOMBAT__?.services.queryClient;
          if (!qc) throw new Error('window.__WHOMBAT__ is only set in dev builds');
          const queries = qc.getQueryCache().findAll({ queryKey: ['whombat', endpoint] });
          for (const q of queries) qc.setQueryData(q.queryKey, data);
          return queries.length;
        },
        { endpoint, data },
      ),
    )
    .toBeGreaterThan(0);
}

/**
 * Data patches every screen gets, so a baseline doesn't move with the fixture world's unread state:
 * - The needs-you count is set to 0 (the sidebar's and Home's, which the Inbox's badge shows): the mock world at 11:22
 *   has one pending approval.
 * - Unread rooms are bold with a count badge (AP-97); the fixture world's unread Chat is set to read.
 */
export async function neutraliseWorld(page: Page): Promise<void> {
  await expect
    .poll(() =>
      patchQueries(
        page,
        'conversations.bootstrap',
        (boot) => ({
          ...boot,
          sidebar: {
            ...boot.sidebar,
            counts: { ...boot.sidebar.counts, needsYou: 0 },
            dms: boot.sidebar.dms.map((d: Record<string, unknown>) => ({ ...d, unread: 0, mentions: 0 })),
          },
        }),
        null,
      ),
    )
    .toBeGreaterThan(0);
  // The Inbox's badge is Home's count.
  await expect
    .poll(() =>
      patchQueries(
        page,
        'home.overview',
        (home) => ({ ...home, summary: { ...home.summary, needsYou: 0 } }),
        null,
      ),
    )
    .toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: /^Inbox, / })).toHaveCount(0);
  await hideAdditions(page);
}

/**
 * Controls the app has and the mock doesn't, hidden so the rest is compared as drawn (work supervision, AP-85…AP-88):
 * the conversation header's “Plans” (before the mock's own actions), the plan card's “Open plan” (after “Open plan
 * canvas”) and the run page's ACTIVITY section (under the two columns); the thread pane's expand button
 * (docs/decisions/ui-improvements.md AP-304); a message's hover toolbar, the header's
 * “Pinned · N” and the search filters (essentials-messages.md AP-452); the header's bell and More menu
 * (essentials-conversations.md AP-476); an approval's “Always allow Neo to deploy” (resourceful-agents.md AP-680:
 * between Approve and Details on the card, the row above Decline · Approve in the modal); the header's “Files”
 * (files-space.md AP-778); the unread divider and its pill (web-messages.md WX-07). The
 * sidebar's own additions don't matter: comparisons leave the sidebar out (`mainRegion`, AP-5100).
 */
export async function hideAdditions(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      '[data-header-plans],[data-plan-open],[data-run-activity],[data-header-files],[data-thread-expand],' +
      '[data-message-toolbar],[data-header-pins],[data-search-filters],' +
      '[data-header-bell],[data-header-more],[data-always-allow],' +
      '[data-unread-divider],[data-new-messages]{display:none !important}',
  });
}

export interface MaskOptions {
  /** Lucide icons in the mock's placeholder-glyph slots (docs/decisions/tokens-primitives.md TP-14). */
  icons?: boolean;
  /** Agent avatars (docs/decisions/avatars.md AV-02; compared on their own in avatars.spec.ts). */
  avatars?: boolean;
  /** The Whombat logo in the mock's ellipse slots (docs/decisions/brand.md BR-01). */
  logos?: boolean;
  /** Extra padding around each box in px. Default 1. */
  pad?: number;
}

/** Element boxes as the page sees them, with whether each is on top at its centre. */
interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  onTop: boolean;
}

/** Boxes of the elements `locator` matches, with whether each is on top at its centre. */
function boxesOf(locator: Locator): Promise<ElementBox[]> {
  return locator.evaluateAll((els) =>
    els
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .map(({ el, r }) => {
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const onTop = !!hit && (hit === el || el.contains(hit));
        return { x: r.x, y: r.y, width: r.width, height: r.height, onTop };
      }),
  );
}

/** `a` minus `b`: up to four rectangles. */
function subtract(a: Rect, b: Rect): Rect[] {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  if (b.x >= ax2 || bx2 <= a.x || b.y >= ay2 || by2 <= a.y) return [a];
  const out: Rect[] = [];
  if (b.y > a.y) out.push({ x: a.x, y: a.y, width: a.width, height: b.y - a.y });
  if (by2 < ay2) out.push({ x: a.x, y: by2, width: a.width, height: ay2 - by2 });
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(ay2, by2);
  if (b.x > a.x) out.push({ x: a.x, y: top, width: b.x - a.x, height: bottom - top });
  if (bx2 < ax2) out.push({ x: bx2, y: top, width: ax2 - bx2, height: bottom - top });
  return out;
}

/**
 * Padded whole-pixel masks for element boxes, relative to `region`. An element under a modal (not on top
 * at its centre) keeps its mask outside the dialogs only, so it never hides part of the dialog.
 */
async function toMasks(page: Page, boxes: ElementBox[], region: Rect, pad: number): Promise<Rect[]> {
  const dialogs: Rect[] = boxes.some((b) => !b.onTop)
    ? await page.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            x: Math.floor(r.x),
            y: Math.floor(r.y),
            width: Math.ceil(r.width) + 1,
            height: Math.ceil(r.height) + 1,
          };
        }),
      )
    : [];
  const masks: Rect[] = [];
  for (const b of boxes) {
    const x = Math.floor(b.x) - pad;
    const y = Math.floor(b.y) - pad;
    let parts: Rect[] = [
      { x, y, width: Math.ceil(b.x + b.width) + pad - x, height: Math.ceil(b.y + b.height) + pad - y },
    ];
    if (!b.onTop) for (const d of dialogs) parts = parts.flatMap((p) => subtract(p, d));
    masks.push(...parts);
  }
  return masks
    .map((r) => ({ ...r, x: r.x - region.x, y: r.y - region.y }))
    .filter((r) => r.x + r.width > 0 && r.y + r.height > 0 && r.x < region.width && r.y < region.height);
}

/**
 * The documented deviation masks within `region` (page coordinates), relative to the region: the boxes
 * of `svg.lucide` icons, `[data-avatar]` agent avatars (the five agents' static images, FA-06; the desktop mock
 * draws the retired family) and `svg[data-logo]` Whombat logos rendered by the app. The same rectangles are painted
 * on the reference, whose placeholder glyphs / CSS avatars / ellipse logo sit in the same slots.
 */
export async function deviationMasks(page: Page, region: Rect, options: MaskOptions = {}): Promise<Rect[]> {
  const { icons = true, avatars = true, logos = true, pad = 1 } = options;
  const selectors = [icons && 'svg.lucide', avatars && '[data-avatar]', logos && 'svg[data-logo]']
    .filter(Boolean)
    .join(', ');
  return selectors ? await toMasks(page, await boxesOf(page.locator(selectors)), region, pad) : [];
}

/**
 * The elements `locator` matches, each widened to its parent's right edge (padded, relative to `region`): a line whose
 * words differ from the mock's (another name, a room that is gone) and so end elsewhere than the mock's.
 */
export async function lineMasks(locator: Locator, region: Rect): Promise<Rect[]> {
  const boxes = await locator.evaluateAll((els) =>
    els
      .map((el) => ({ el, r: el.getBoundingClientRect(), p: el.parentElement?.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .map(({ el, r, p }) => {
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const right = Math.max(r.x + r.width, p ? p.x + p.width : 0);
        return { x: r.x, y: r.y, width: right - r.x, height: r.height, onTop: !!hit && el.contains(hit) };
      }),
  );
  return toMasks(locator.page(), boxes, region, 1);
}

/**
 * The desktop mock's crew by the fixture world's names (Whombat one-agent.md OA-01, OA-08): its Dusty, the agent that
 * asks for the deploy, and Banjo, whose run it is, are the one agent (Neo); what another crew member did is a person's
 * there (Hazel's review is Mara's). Every text node of the reference, in either case (“DUSTY IS ASKING”), now and as
 * the mock renders more (a live tick, a state patch). Data, not a mask: the words then take the app's widths.
 */
/**
 * The mock's words for a crew's approvals said by the app for one person (Whombat one-person.md OP-01; contracts CT-1518;
 * app one-person.md AP-5725): the person says yes, not “a person” or “you or Joris”. Data for `renameInReference`.
 */
export const ONE_PERSON_WORDS: Readonly<Record<string, string>> = {
  'A person says yes': 'You say yes',
  'you or Joris': 'you',
  'when a person approves': 'when you approve',
};

export async function renameInReference(page: Page, names: Readonly<Record<string, string>>): Promise<void> {
  // After a state patch's render (`setReferenceState` doesn't wait for it).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.evaluate((pairs) => {
    const rules = pairs.flatMap(([from, to]) => [
      [new RegExp(`\\b${from}\\b`, 'g'), to] as const,
      [new RegExp(`\\b${from.toUpperCase()}\\b`, 'g'), to.toUpperCase()] as const,
    ]);
    const rename = (node: Node) => {
      const before = node.nodeValue ?? '';
      let text = before;
      for (const [pattern, to] of rules) text = text.replace(pattern, to);
      if (text !== before) node.nodeValue = text;
    };
    const walk = (root: Node) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) rename(node);
    };
    walk(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') rename(r.target);
        for (const added of r.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) rename(added);
          else walk(added);
        }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, Object.entries(names));
}

/** Masks (padded, relative to `region`) for the elements matched by `locator`: documented one-offs. */
export async function elementMasks(locator: Locator, region: Rect, pad = 1): Promise<Rect[]> {
  return toMasks(locator.page(), await boxesOf(locator), region, pad);
}

/** Box of a locator on the page, rounded outwards to whole pixels. */
export async function boxOf(locator: Locator, pad = 0): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element not on screen');
  const x = Math.floor(box.x) - pad;
  const y = Math.floor(box.y) - pad;
  return {
    x,
    y,
    width: Math.ceil(box.x + box.width) + pad - x,
    height: Math.ceil(box.y + box.height) + pad - y,
  };
}

export interface MatchOptions {
  /** File stem under tmp/visual/. */
  name: string;
  reference: Buffer;
  mine: Buffer;
  /** Compared region in page coordinates. Default: the whole shot. */
  region?: Rect;
  /** Region of `mine` when it sits elsewhere than the reference's (same size). Default: `region`. */
  mineRegion?: Rect;
  /** Masks relative to the region (`deviationMasks`, or documented extra rectangles). */
  masks?: Rect[];
  /** Allowed mismatch in percent of the region's pixels. */
  budget: number;
  /** pixelmatch per-pixel colour threshold (0–1). Default 0.1. */
  threshold?: number;
}

/** Diff `mine` against `reference`, keep the artifacts and assert size and budget. */
export async function expectMatch(testInfo: TestInfo, options: MatchOptions): Promise<number> {
  const { name, budget, threshold = 0.1, masks = [] } = options;
  const crop = (png: Buffer, region = options.region) => (region ? cropPng(png, region) : png);
  const reference = maskPng(crop(options.reference), masks);
  const mine = maskPng(crop(options.mine, options.mineRegion), masks);
  const result = diffPng(reference, mine, threshold);
  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, `${name}-reference.png`), reference);
  await writeFile(resolve(OUT, `${name}-mine.png`), mine);
  await writeFile(resolve(OUT, `${name}-diff.png`), result.diff);
  const line = `${name}: ${result.percent.toFixed(3)}% (${result.mismatched} px, budget ${budget}%)`;
  console.log(line);
  testInfo.annotations.push({ type: 'mismatch', description: line });
  if (result.percent >= budget || !result.sizeMatches) {
    await testInfo.attach(`${name}-diff.png`, { body: result.diff, contentType: 'image/png' });
    await testInfo.attach(`${name}-reference.png`, { body: reference, contentType: 'image/png' });
    await testInfo.attach(`${name}-mine.png`, { body: mine, contentType: 'image/png' });
  }
  expect(result.sizeMatches, `${name}: size differs`).toBe(true);
  expect(result.percent, line).toBeLessThan(budget);
  return result.percent;
}

/** The main column right of the sidebar at a viewport width. */
export const mainRegion = (width = 1440, height = HEIGHT): Rect => ({
  x: SIDEBAR_WIDTH,
  y: 0,
  width: width - SIDEBAR_WIDTH,
  height,
});
