import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import { assetCacheDir, cacheExternalAssets } from './network';
import { readPropsMeta, rewriteDataProps } from './props';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const REFERENCE_DIR = join(REPO_ROOT, 'docs/design-handoff/design');

export const REFERENCE_FILES = {
  desktop: 'Whombat Desktop.dc.html',
  mobile: 'Whombat Mobile.dc.html',
  avatar: 'WhombatAvatar.dc.html',
  avatarSystem: 'Whombat Avatar System.dc.html',
} as const;
export type ReferenceFile = keyof typeof REFERENCE_FILES;

/**
 * The desktop mock's screens the app still has, or still holds what is compared (`channel`: the chat cards, the
 * approval modal and the toasts). Its DM and roster went with one agent (Whombat one-agent.md OA-03, OA-04).
 */
export const SCREENS = ['channel', 'branch', 'run', 'search', 'canvas', 'log', 'onboarding'] as const;
export type Screen = (typeof SCREENS)[number];

/**
 * Chromium flags for every visual run (references and the app): grayscale text anti-aliasing. Whether
 * Chromium draws subpixel (LCD) text depends on the machine's fontconfig and on compositing, so without
 * this the same page renders differently on Debian and in the Ubuntu CI image.
 */
export const CHROMIUM_ARGS = ['--disable-lcd-text'];

/** The moment the mock world captures (Europe/Amsterdam, CEST). */
export const FROZEN_NOW = new Date('2026-09-23T11:22:00+02:00');

const DEFAULT_VIEWPORT: Record<ReferenceFile, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 1000, height: 1000 },
  avatar: { width: 240, height: 240 },
  avatarSystem: { width: 1440, height: 900 },
};

export function referencePath(file: ReferenceFile): string {
  return join(REFERENCE_DIR, REFERENCE_FILES[file]);
}

/**
 * The crew's handoff (app docs/decisions/crew.md): `reference/crew-reference.html` draws every agent at 160, 64, 40,
 * 32, 24 and 16 px on light (`#sizes-light`) and dark (`#sizes-dark`) from the `svg/` beside it. A plain page, not a
 * DC component: no props, no React, no web fonts.
 */
export const CREW_REFERENCE_DIR = join(REPO_ROOT, 'docs/design-handoff/whombat-crew');
export const CREW_REFERENCE = 'reference/crew-reference.html';

export interface ReferenceShotOptions {
  file: ReferenceFile;
  /** Prop defaults to rewrite in `data-props` (e.g. `{start: 'run', theme: 'dark'}`). */
  props?: Record<string, string>;
  /**
   * Theme for files without a `theme` prop (mobile renders both phones): the shot is clipped to
   * the `[data-screen-label="Mobile <theme>"]` phone and clicks are scoped to it.
   */
  phone?: 'light' | 'dark';
  /** Visible texts to click, in order. */
  clicks?: string[];
  width?: number;
  height?: number;
  /** Extra settle time in ms after render and after the last click. Default 500. */
  wait?: number;
  fullPage?: boolean;
  /** Freeze Date to 2026-09-23 11:22 Europe/Amsterdam. Default true. */
  freezeClock?: boolean;
  /**
   * Runs after the first render and before the clicks, e.g. to put the mock in a state no click reaches
   * (its thread link has no handler) or to hide regions that are compared separately.
   */
  prepare?: (page: Page) => Promise<void>;
  /**
   * A JavaScript expression evaluated in the page (polled every 50 ms, up to 60 s) after render and
   * clicks; the shot is taken as soon as it is truthy. Use it to capture a later live tick exactly, e.g.
   * `document.body.innerText.includes('+232')` for the run screen at tick 3 (one tick every 2.6 s).
   */
  waitFor?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Serve a directory over a local static HTTP server on a random free port. */
export async function serveDirectory(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      const file = normalize(join(root, pathname));
      if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

async function waitForRender(page: Page, settle: number): Promise<void> {
  await page.waitForFunction(() => (document.getElementById('dc-root')?.childElementCount ?? 0) > 0, null, {
    timeout: 30_000,
  });
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await waitForWebFonts(page);
  await page.waitForTimeout(settle);
}

/**
 * JS expression (a promise): true once Bricolage Grotesque and DM Mono are available as web fonts, not a
 * fallback. `document.fonts.load()` fetches a family's face (fonts load lazily, a page may not use both
 * yet) and resolves empty when no `@font-face` matches, i.e. the Google Fonts stylesheet is missing. Pages
 * that do not link Google Fonts (the avatar reference) pass.
 */
export const WEB_FONTS_LOADED = `(async () => {
  if (!document.querySelector('link[href*="fonts.googleapis.com"]')) return true;
  const faces = await Promise.all(
    ["400 16px 'Bricolage Grotesque'", "400 16px 'DM Mono'"].map((font) => document.fonts.load(font)),
  );
  await document.fonts.ready;
  return faces.every((f) => f.length > 0);
})()`;

/** Wait until the web fonts are in (`WEB_FONTS_LOADED`), polling; throws after 30 s. */
export async function waitForWebFonts(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await page.evaluate(WEB_FONTS_LOADED))) {
    if (Date.now() > deadline) throw new Error('web fonts (Bricolage Grotesque, DM Mono) did not load');
    await page.waitForTimeout(100);
  }
}

async function findClickTarget(scope: Page | Locator, text: string): Promise<Locator> {
  const candidates = [
    scope.getByRole('button', { name: text, exact: true }),
    scope.getByText(text, { exact: true }),
    scope.getByRole('button', { name: text }),
    scope.getByText(text),
  ];
  for (const candidate of candidates) {
    const visible = candidate.locator('visible=true');
    if ((await visible.count()) > 0) return visible.first();
  }
  throw new Error(`--click: no visible element with text "${text}"`);
}

/** Attempts per reference shot: a CDN hiccup that survives the asset retries re-renders from scratch. */
const SHOT_ATTEMPTS = 3;

/**
 * Render a design reference in Playwright chromium and return a PNG screenshot. unpkg and Google Fonts
 * go through the disk cache (`network.ts`); a render that still fails is retried from scratch.
 */
export async function shootReference(opts: ReferenceShotOptions): Promise<Buffer> {
  return withRetries(() => shootReferenceOnce(opts, captureScreen(opts)));
}

/**
 * Like `shootReference`, but screenshots every element matching `selector` (in document order, each its own
 * PNG) instead of the viewport — e.g. each avatar `<img>` of the five agents' reference. Each shot is the element's
 * box on the full page, its origin rounded to the pixel Chromium paints it at (a replaced element is snapped to the
 * pixel grid; an element screenshot would take the extra row and column of a fractional box).
 */
export async function shootReferenceElements(
  opts: ReferenceShotOptions,
  selector: string,
): Promise<Buffer[]> {
  return withRetries(() => shootReferenceOnce(opts, (page) => shootElements(page, selector)));
}

/**
 * Every `selector` element of the crew's reference (`CREW_REFERENCE`, e.g. `#sizes-dark img`), each its own PNG at
 * its painted pixel origin as in `shootReferenceElements`, once every image on the page has loaded.
 */
export async function shootCrewReferenceElements(
  selector: string,
  viewport = { width: 1440, height: 900 },
): Promise<Buffer[]> {
  const server = await serveDirectory(CREW_REFERENCE_DIR);
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-GB' });
    const page = await context.newPage();
    await page.goto(`${server.url}/${CREW_REFERENCE}`, { waitUntil: 'load' });
    await page.waitForFunction(() =>
      [...document.images].every((img) => img.complete && img.naturalWidth > 0),
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return await shootElements(page, selector);
  } finally {
    await browser.close();
    await server.close();
  }
}

/** Each matching element's box on the full page, its origin rounded to the pixel Chromium paints a replaced element at. */
async function shootElements(page: Page, selector: string): Promise<Buffer[]> {
  const boxes = await page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    }),
  );
  if (boxes.length === 0) throw new Error(`No reference element matches ${selector}`);
  const shots: Buffer[] = [];
  for (const b of boxes) {
    const clip = {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
    };
    shots.push(await page.screenshot({ fullPage: true, clip, animations: 'disabled' }));
  }
  return shots;
}

type Capture<T> = (page: Page) => Promise<T>;

function captureScreen(opts: ReferenceShotOptions): Capture<Buffer> {
  return async (page) => {
    const phone = opts.phone ? page.locator(`[data-screen-label="Mobile ${opts.phone}"]`) : undefined;
    if (phone) return await phone.screenshot({ animations: 'disabled' });
    return await page.screenshot({ fullPage: opts.fullPage ?? false, animations: 'disabled' });
  };
}

async function withRetries<T>(shoot: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SHOT_ATTEMPTS; attempt++) {
    try {
      return await shoot();
    } catch (err) {
      lastError = err;
      if (!(err instanceof ReferenceRenderError) || attempt === SHOT_ATTEMPTS) throw err;
      console.warn(`[visual] reference render failed (attempt ${attempt}): ${err.message}`);
    }
  }
  throw lastError;
}

class ReferenceRenderError extends Error {}

async function shootReferenceOnce<T>(opts: ReferenceShotOptions, capture: Capture<T>): Promise<T> {
  const source = referencePath(opts.file);
  const html = rewriteDataProps(await readFile(source, 'utf8'), opts.props ?? {});

  const preview = readPropsMeta(html).$preview as { width?: number; height?: number } | undefined;
  const base =
    opts.file === 'avatar' && preview?.width
      ? { width: preview.width, height: preview.height ?? preview.width }
      : DEFAULT_VIEWPORT[opts.file];
  const viewport = { width: opts.width ?? base.width, height: opts.height ?? base.height };
  const settle = opts.wait ?? 500;

  const dir = await mkdtemp(join(tmpdir(), 'whombat-ref-'));
  const server = await serveDirectory(dir);
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  try {
    // Copy the whole design directory: references load sibling components (e.g. WhombatAvatar) by name.
    await cp(REFERENCE_DIR, dir, { recursive: true });
    const entry = REFERENCE_FILES[opts.file];
    await writeFile(join(dir, entry), html);

    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      timezoneId: 'Europe/Amsterdam',
      locale: 'en-GB',
    });
    await cacheExternalAssets(context, assetCacheDir(REPO_ROOT));
    const page = await context.newPage();
    if (opts.freezeClock ?? true) await page.clock.setFixedTime(FROZEN_NOW);
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(`${server.url}/${encodeURIComponent(entry)}`, { waitUntil: 'load' });
    // Files with a `$preview` size (the avatar) expect the host frame to size them: fill the viewport.
    if (preview) {
      await page.addStyleTag({
        content: 'html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}',
      });
    }
    try {
      await waitForRender(page, settle);
    } catch (err) {
      throw new ReferenceRenderError(
        `Reference did not render: ${errors.join('; ') || (err as Error).message}`,
      );
    }

    if (opts.prepare) {
      await opts.prepare(page);
      await waitForRender(page, settle);
    }

    const phone = opts.phone ? page.locator(`[data-screen-label="Mobile ${opts.phone}"]`) : undefined;
    if (phone && (await phone.count()) === 0) throw new Error(`No phone labelled "Mobile ${opts.phone}"`);
    const scope = phone ?? page;

    for (const text of opts.clicks ?? []) {
      await (await findClickTarget(scope, text)).click();
      await page.waitForTimeout(250);
    }
    if (opts.clicks?.length) await waitForRender(page, settle);
    if (opts.waitFor) {
      await page.waitForFunction(opts.waitFor, null, { timeout: 60_000, polling: 50 });
    }

    return await capture(page);
  } finally {
    await browser.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Patches the state of the reference's DC component (its host is found through React's fiber tree), for mock states
 * that no click reaches — e.g. `{pane: 'thread'}`: the mock's thread link has no handler. Use it from
 * `prepare`. Throws when no component state holds every patched key.
 */
export async function setReferenceState(page: Page, patch: Record<string, unknown>): Promise<void> {
  // A string, not a function: tsx/esbuild would inject `__name` helpers the page does not have.
  const found = await page.evaluate(`(() => {
    const patch = ${JSON.stringify(patch)};
    const keys = Object.keys(patch);
    const root = document.getElementById('dc-root');
    const elements = root ? [root, ...root.querySelectorAll('*')] : [];
    for (const el of elements) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      let fiber = key ? el[key] : null;
      while (fiber) {
        // DC components keep their state on the host's \`logic\` instance (support.js).
        const node = fiber.stateNode && fiber.stateNode.logic;
        if (node && node.state && typeof node.setState === 'function' && keys.every((k) => k in node.state)) {
          node.setState(patch);
          return true;
        }
        fiber = fiber.return;
      }
    }
    return false;
  })()`);
  if (!found) throw new Error(`No reference component state holds ${Object.keys(patch).join(', ')}`);
}
