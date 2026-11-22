/**
 * `pnpm shots`: every demo fixture → .visual/<size>/<fixture>.png, plus .visual/index.html to page through them
 * (CG-17): the installer and claim screens at 1024×768 and 1920×1080, the desk's (`desk-*`, CG-38), the Wi-Fi
 * ones (`wifi-*`, `installer-wifi*`, CG-110) and the Bluetooth ones (`bt-*`, CG-211) at 1280×800, 2560×1600 (the Z13)
 * and 1024×768, the sign-in panel over
 * the desk (`desk-signin*`, CG-153) at 1920×1080 too. Runs the Vite dev server (fixtures are dev-only) on a free port
 * and Playwright's Chromium.
 *
 *   pnpm shots                      all fixtures, both sizes
 *   pnpm shots console-claimed …    only these
 *   pnpm shots --size=1440x900 --theme=light desk-idle …
 *                                   at one size instead (→ .visual/1440x900/), light (→ .visual/1440x900-light/);
 *                                   the console is dark (CG-02), light is for comparing with the app's references
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import type { Fixture } from '../src/demo/fixtures.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}.visual`;
const SIZES = [
  { width: 1024, height: 768 },
  { width: 1920, height: 1080 },
];
const DESK_SIZES = [
  { width: 1280, height: 800 },
  { width: 2560, height: 1600 },
  { width: 1024, height: 768 },
];
/** The sign-in panel over the desk (CG-153) at the desk's sizes and the claim screens' 1920×1080 too. */
const DESK_SIGNIN_SIZES = [...DESK_SIZES, { width: 1920, height: 1080 }];
/** The screen of widgets at the Z13's own size (the mockups' 1280×800 at 200 %) and at 1280×800. */
const GRID_SIZES = [
  { width: 2560, height: 1600 },
  { width: 1280, height: 800 },
];
/** A monitor beside the Z13: the window over both outputs, as cage makes it (the Z13 and a 1080p monitor). */
const MONITOR_SIZES = [{ width: 4480, height: 1600 }];
const sizesOf = (name: string) =>
  name.startsWith('desk-grid-monitor')
    ? MONITOR_SIZES
    : name.startsWith('desk-grid')
      ? GRID_SIZES
      : name.startsWith('desk-signin')
        ? DESK_SIGNIN_SIZES
        : ['desk-', 'wifi-', 'installer-wifi', 'bt-'].some((p) => name.startsWith(p))
          ? DESK_SIZES
          : SIZES;
const ALL_SIZES = [...SIZES, ...DESK_SIZES, ...MONITOR_SIZES].filter(
  (s, i, all) => all.findIndex((o) => o.width === s.width && o.height === s.height) === i,
);

/** What to do on a fixture before the picture (typing, clicking, waiting for a timeline). */
const PREPARE: Record<string, (page: Page) => Promise<void>> = {
  'installer-erase-typed': async (p) => {
    await p.keyboard.type('sda');
  },
  'installer-checks-ok-details': async (p) => {
    await p.getByRole('button', { name: 'Details' }).click();
  },
  // Enter on the focused button, with nothing typed: an empty disk needs no name.
  'installer-erase-empty-refused': async (p) => {
    await p.keyboard.press('Enter');
    await p.waitForTimeout(400);
  },
  'installer-erase-refused': async (p) => {
    await p.keyboard.type('sda');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(400);
  },
  'installer-installing-details': async (p) => {
    await p.keyboard.press('Enter');
    await p.waitForTimeout(300);
  },
  // The first scan finds three more after 1.5 s (DF-10): they fade in, the newest edged while it looks.
  'desk-found-live': async (p) => {
    await p.waitForTimeout(1800);
  },
  // A new ask arrives after 2 s and its card opens by itself (DK-60).
  'desk-popup-live': async (p) => {
    await p.waitForTimeout(2600);
  },
  // The assistant's step (CG-376): pressed, the demo takes it and the hero says “I’m on it.”; refused, the card says why.
  'desk-calm-look-live': async (p) => {
    await p.getByRole('button', { name: 'Restart Zigbee' }).click();
    await p.waitForTimeout(800);
  },
  'desk-look-research-not-allowed': async (p) => {
    await p
      .getByRole('region', { name: /Zigbee/ })
      .getByRole('button', { name: 'Restart Zigbee' })
      .click();
    await p.waitForTimeout(400);
  },
  'console-celebrate': async (p) => {
    await p.waitForTimeout(2600);
  },
  'console-away': async (p) => {
    await p.waitForTimeout(12_500);
  },
  connecting: async (p) => {
    await p.waitForTimeout(11_000);
  },
  'desk-restart': async (p) => {
    await p.waitForTimeout(12_500);
  },
  'desk-restart-night': async (p) => {
    await p.waitForTimeout(12_500);
  },
  'desk-ask-relock': async (p) => {
    await p.waitForTimeout(2500);
  },
  'desk-away-unlocked': async (p) => {
    await p.waitForTimeout(12_500);
  },
  'desk-live': async (p) => {
    await p.waitForTimeout(3600);
  },
  'desk-ask-gone': async (p) => {
    await p.waitForTimeout(1600);
  },
  'wifi-password-symbols': async (p) => {
    await p.getByRole('button', { name: 'Symbols' }).click();
  },
  // The PIN for a wider choice the ask no longer offers (TF-14): the sheet says so.
  'desk-ask-choice-not-offered': async (p) => {
    await p.keyboard.type('123456');
    await p.waitForTimeout(400);
  },
  // Ignore refused (QN-20): the card says why.
  'desk-look-quiet-not-allowed': async (p) => {
    await p.getByRole('button', { name: /^Ignore/ }).click();
    await p.waitForTimeout(400);
  },
  // The screen locks 1.5 s in (TF-18): no words while locked.
  'desk-talk-relock': async (p) => {
    await p.waitForTimeout(2500);
  },
  'desk-unlock-wrong': async (p) => {
    await p.keyboard.type('111111');
    await p.waitForTimeout(300);
  },
  'console-signin-gone': async (p) => {
    await p.waitForTimeout(2600);
  },
  'desk-signin-pin': async (p) => {
    // Typed behind the panel: nothing reaches the pad.
    await p.keyboard.type('3456');
    await p.mouse.click(200, 200);
    await p.waitForTimeout(300);
  },
  // A connect runs (the demo takes 1.5 s).
  'desk-bt-connecting': async (p) => {
    await p.getByRole('button', { name: 'Connect WH-1000XM5' }).click();
    await p.waitForTimeout(400);
  },
  // The scan's minute (2 s in the fixture) is over.
  'desk-bt-found-ended': async (p) => {
    await p.waitForTimeout(2600);
  },
  'desk-bt-nothing': async (p) => {
    await p.waitForTimeout(1600);
  },
  // The screen of widgets' second page, touched (DK-133).
  'desk-grid-media': async (p) => {
    await p.getByRole('button', { name: 'Media' }).first().click();
    await p.waitForTimeout(400);
  },
  'desk-unlock-four-typed': async (p) => {
    await p.keyboard.type('2580');
    await p.waitForTimeout(1600);
  },
};

const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { port: 0, strictPort: false },
});
await server.listen();
const { FIXTURES } = (await server.ssrLoadModule('/src/demo/fixtures.ts')) as {
  FIXTURES: Record<string, Fixture>;
};
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = args.filter((a) => !a.startsWith('--'));
const theme = flag('theme') === 'light' ? 'light' : 'dark';
const sized = flag('size')?.match(/^(\d+)x(\d+)$/);
const one = sized ? { width: Number(sized[1]), height: Number(sized[2]) } : null;
const names = Object.keys(FIXTURES).filter((n) => only.length === 0 || only.includes(n));
const base = server.resolvedUrls?.local[0];
if (!base) throw new Error('vite: no local URL');

const browser = await chromium.launch();
try {
  for (const size of one ? [one] : ALL_SIZES) {
    const dir = `${out}/${size.width}x${size.height}${theme === 'light' ? '-light' : ''}`;
    const here = one
      ? names
      : names.filter((n) => sizesOf(n).some((o) => o.width === size.width && o.height === size.height));
    if (here.length === 0) continue;
    await mkdir(dir, { recursive: true });
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
    await Promise.all(
      here.map(async (name) => {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        await page.goto(`${base}?demo=${name}#t=demo-token-0123456789`, { waitUntil: 'networkidle' });
        if (theme === 'light') await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(900);
        await PREPARE[name]?.(page);
        // What the page told the runtime about its outputs (the demo keeps it), for the monitor's fixtures.
        const sizes = name.startsWith('desk-grid-monitor')
          ? await page.evaluate(() => document.documentElement.dataset.sizeReport ?? 'none')
          : null;
        const overflow = await page.evaluate(() => {
          const s = document.querySelector('.stage');
          if (!s) return [];
          const box = s.getBoundingClientRect();
          return [...s.querySelectorAll<HTMLElement>('*')]
            .filter((e) => {
              if (e.closest('[data-overflow-ok]')) return false;
              const r = e.getBoundingClientRect();
              return r.width > 0 && (r.right > box.right + 1 || r.bottom > box.bottom + 1);
            })
            .slice(0, 3)
            .map((e) => `${e.tagName.toLowerCase()}.${e.className}`);
        });
        await page.screenshot({ path: `${dir}/${name}.png` });
        await page.close();
        const notes = [
          ...errors,
          ...overflow.map((o) => `overflows the screen: ${o}`),
          ...(sizes ? [`size reported: ${sizes}`] : []),
        ];
        console.log(
          `${size.width}x${size.height} ${name}${notes.length ? `\n  ! ${notes.join('\n  ! ')}` : ''}`,
        );
      }),
    );
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

if (one) {
  // One size: the pictures only; the gallery stays the full run's.
  console.log(
    `\n${names.length} screenshots in ${out}/${one.width}x${one.height}${theme === 'light' ? '-light' : ''}/`,
  );
  process.exit(0);
}
const rows = names
  .map(
    (n) =>
      `<h2>${n} <small>${FIXTURES[n]?.note ?? ''}</small></h2><div>${sizesOf(n)
        .map((s) => `<img src="${s.width}x${s.height}/${n}.png" width="${Math.min(s.width / 2, 640)}">`)
        .join('')}</div>`,
  )
  .join('\n');
await writeFile(
  `${out}/index.html`,
  `<!doctype html><meta charset="utf-8"><title>Console UI shots</title><style>body{background:#111;color:#ddd;font:14px system-ui;margin:24px}img{margin:0 12px 24px 0;border:1px solid #333;vertical-align:top}small{color:#888;font-weight:400}</style>${rows}`,
);
console.log(`\n${names.reduce((n, f) => n + sizesOf(f).length, 0)} screenshots in ${out}/`);
