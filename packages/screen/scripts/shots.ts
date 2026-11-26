/**
 * Pictures of the fixtures drawn by `@whombat/screen/react`, to compare with the mockups' `shots/` (desk-widgets):
 * `pnpm --filter @whombat/screen shots [name…]` writes PNGs to `$SCREEN_SHOTS` (default
 * `~/.cache/wb-tmp/screen-shots/`). The page is bundled with esbuild (CSS modules as local CSS) and photographed with
 * Playwright at each screen's own size: 1280×800 (the Z13), 1920×1080 (a monitor), 820×1180 (a portrait iPad).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const repo = resolve(pkg, '../..');
const out = process.env.SCREEN_SHOTS ?? join(homedir(), '.cache/wb-tmp/screen-shots');
const work = join(out, '.page');

/** Each shot: its screen's size, and what to touch before the picture. */
const SHOTS: Record<string, { width: number; height: number; act?: (page: Page) => Promise<void> }> = {
  'f-default': { width: 1280, height: 800 },
  'f-overview': { width: 1280, height: 800 },
  'f-media': { width: 1280, height: 800 },
  'f-house': { width: 1280, height: 800 },
  'f-problem': { width: 1280, height: 800 },
  'f-ask': {
    width: 1280,
    height: 800,
    act: (p) => p.getByRole('button', { name: 'Next' }).click(),
  },
  'f-ask-own': {
    width: 1280,
    height: 800,
    act: (p) => p.getByRole('button', { name: 'Next' }).click(),
  },
  'f-notnow': {
    width: 1280,
    height: 800,
    act: (p) => p.getByRole('button', { name: 'Not now' }).click(),
  },
  'f-monitor': { width: 1920, height: 1080 },
  'f-tablet': { width: 820, height: 1180 },
  'f-elsewhere-ask': {
    width: 820,
    height: 1180,
    act: (p) => p.getByRole('button', { name: 'Next' }).click(),
  },
  'f-big': {
    width: 1280,
    height: 800,
    act: (p) => p.getByRole('button', { name: 'Plex · Recently added' }).click(),
  },
  'f-locked': { width: 1280, height: 800 },
  'f-editing': { width: 1280, height: 800 },
  'f-larger': { width: 1280, height: 800 },
  'f-trying': { width: 1280, height: 800 },
  'f-kinds': { width: 1280, height: 800 },
  'f-doorbell': { width: 1280, height: 800 },
  'f-doorbell-locked': { width: 1280, height: 800 },
  'f-wide-chips': { width: 1280, height: 800 },
  'f-sizes': { width: 1600, height: 1480 },
  'f-servers': { width: 1900, height: 1700 },
  'f-photo-board': { width: 1900, height: 2600 },
  'f-weather-news': { width: 1900, height: 2700 },
};

async function bundle(): Promise<void> {
  mkdirSync(work, { recursive: true });
  await build({
    entryPoints: [join(here, 'shots-page.tsx')],
    bundle: true,
    format: 'iife',
    outdir: work,
    loader: { '.module.css': 'local-css' },
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  const href = (p: string) => pathToFileURL(p).href;
  writeFileSync(
    join(work, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${href(join(repo, 'packages/tokens/tokens.css'))}">
<link rel="stylesheet" href="${href(join(repo, 'apps/web/src/app/fonts/fonts.css'))}">
<link rel="stylesheet" href="shots-page.css">
<style>
html,body{margin:0;background:#0d0b09}
*{animation:none!important}
.sheet{background:var(--bg);color:var(--ink);font-family:var(--font-sans);padding:34px 40px 10px;width:max-content;min-width:1520px}
.sheet h2{font-size:24px;font-weight:650;margin:0 0 26px;letter-spacing:-.01em}
.srow{display:flex;gap:24px;align-items:flex-start;margin-bottom:30px}
.srow .tl{width:150px;flex:none;font-size:16px;font-weight:600;padding-top:30px}
.srow .tl span{display:block;font-weight:400;color:var(--mut);font-size:14px;margin-top:4px}
.sz{font-family:var(--font-mono);font-size:13px;color:var(--mut);margin-bottom:8px}
</style></head><body><div id="root"></div><script src="shots-page.js"></script></body></html>`,
  );
}

async function main() {
  const only = process.argv.slice(2);
  await bundle();
  const browser = await chromium.launch();
  const errors: string[] = [];
  try {
    for (const [name, shot] of Object.entries(SHOTS)) {
      if (only.length && !only.includes(name)) continue;
      const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } });
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
      });
      await page.goto(`${pathToFileURL(join(work, 'index.html')).href}#${name}`);
      await page.evaluate(() => document.fonts.ready);
      await shot.act?.(page);
      await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const file = join(out, `${name}.png`);
      if (['f-sizes', 'f-servers', 'f-photo-board', 'f-weather-news'].includes(name))
        await page.locator('.sheet').screenshot({ path: file });
      else await page.screenshot({ path: file });
      await page.close();
      console.log(file);
    }
  } finally {
    await browser.close();
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  }
}

await main();
