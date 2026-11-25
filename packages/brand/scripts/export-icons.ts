/**
 * Writes the app's icons from the logo package (`assets/`) and the geometry in `src/`:
 *
 * - apps/web/public: favicon.ico, favicon.svg, apple-touch-icon.png, icon-192/512.png (+ manifest),
 *   badge-96.png (web push badge), whombat-og-1200x630.png (link previews);
 * - apps/mobile/assets: icon.png (the Ink tile, its face smaller than the package's), adaptive-icon.png (Android foreground and monochrome),
 *   splash-icon.png / splash-icon-dark.png, notification-icon.png;
 * - the Android status-bar vector drawable of modules/whombat-live.
 *
 * Tiles the package ships are copied; transparent marks at app-specific sizes are rendered with the repo's
 * Playwright Chromium.
 *
 *   pnpm --filter @whombat/brand export-icons
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { brandColors, themeColors } from '@whombat/tokens';
import { chromium } from 'playwright';
import { androidSmallIconXml, faviconSvg, webManifest } from '../src/files';
import { buildLogo, renderLogoSvg } from '../src/index';

const brand = resolve(import.meta.dirname, '..');
const repo = resolve(brand, '../..');
const assets = join(brand, 'assets');
const web = join(repo, 'apps/web/public');
const mobile = join(repo, 'apps/mobile');

const say = (file: string) => console.log(`wrote ${relative(repo, file)}`);
function copy(from: string, to: string) {
  copyFileSync(join(assets, from), to);
  say(to);
}
function write(to: string, text: string) {
  writeFileSync(to, text);
  say(to);
}

// Web ----------------------------------------------------------------------------------------------------
copy('favicon/favicon.ico', join(web, 'favicon.ico'));
write(join(web, 'favicon.svg'), faviconSvg(brandColors));
copy('app-icon/apple-touch-icon-180.png', join(web, 'apple-touch-icon.png'));
copy('app-icon/android-chrome-192.png', join(web, 'icon-192.png'));
copy('app-icon/whombat-app-icon-ink-512.png', join(web, 'icon-512.png'));
copy('social/whombat-og-1200x630.png', join(web, 'whombat-og-1200x630.png'));
write(join(web, 'manifest.webmanifest'), webManifest({ background: themeColors.light.bg }));

// Mobile -------------------------------------------------------------------------------------------------
write(
  join(mobile, 'modules/whombat-live/android/src/main/res/drawable/whombat_live_small.xml'),
  androidSmallIconXml(),
);

/** The full-face symbol from the package (`ink` / `paper`), without its content-credential metadata. */
const packageSymbol = (tone: 'ink' | 'paper') =>
  readFileSync(join(assets, `svg/whombat-symbol-${tone}.svg`), 'utf8').replace(
    /<metadata>.*?<\/metadata>/s,
    '',
  );

interface Render {
  file: string;
  /** Square canvas, px. */
  size: number;
  /** Symbol width as a share of the canvas. */
  width: number;
  svg: string;
  /** A solid ground (the iPhone's icon has no transparency); transparent without. */
  ground?: string;
}

const renders: Render[] = [
  // The app icon (the iPhone's, and Android's before adaptive icons): the Ink tile, the face 60% of its width. The
  // package's tile fills two thirds of it, which looked too big beside other apps on a home screen.
  {
    file: join(mobile, 'assets/icon.png'),
    size: 1024,
    width: 0.6,
    svg: packageSymbol('paper'),
    ground: brandColors.ink,
  },
  // Android adaptive foreground (also the themed-icon monochrome): paper on the Ink background colour. Launchers show
  // about the middle 72 of its 108 dp, Samsung's One UI less (about 56): the face is 38 dp wide, half of the usual tile
  // and two thirds of Samsung's, like the apps beside it. At 61 dp and then 48 it still filled a Samsung tile.
  { file: join(mobile, 'assets/adaptive-icon.png'), size: 1024, width: 0.35, svg: packageSymbol('paper') },
  // Splash: ink on the light `bg`, paper on the dark one.
  { file: join(mobile, 'assets/splash-icon.png'), size: 1024, width: 0.56, svg: packageSymbol('ink') },
  { file: join(mobile, 'assets/splash-icon-dark.png'), size: 1024, width: 0.56, svg: packageSymbol('paper') },
  // Notification icons: the small symbol, white on transparent (Android and browsers use the alpha only).
  ...[join(mobile, 'assets/notification-icon.png'), join(web, 'badge-96.png')].map((file) => ({
    file,
    size: 96,
    width: 0.84,
    svg: renderLogoSvg(buildLogo({ height: 32, color: '#ffffff' })),
  })),
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const r of renders) {
    await page.setViewportSize({ width: r.size, height: r.size });
    const svg = r.svg.replace(/ width="[\d.]+" height="[\d.]+"/, '').replace('<svg ', '<svg width="100%" ');
    await page.setContent(
      `<!doctype html><html><body style="margin:0;width:${r.size}px;height:${r.size}px;display:flex;align-items:center;justify-content:center;background:${r.ground ?? 'transparent'}">
<div style="width:${Math.round(r.size * r.width)}px;line-height:0">${svg}</div></body></html>`,
    );
    await page.screenshot({ path: r.file, omitBackground: !r.ground });
    say(r.file);
  }
} finally {
  await browser.close();
}
