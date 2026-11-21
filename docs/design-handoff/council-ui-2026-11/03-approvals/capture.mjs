// From the repo root, Node 24:
// node --import tsx docs/design-handoff/council-ui-2026-11/03-approvals/capture.mjs before|after
// before: this checkout's fixture Vite on :5297. after: repo-root static server on :5397.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, settle, patchQueries } from '../../../../apps/web/visual/support/harness.ts';
import { buildFixtures } from './build-fixtures.mjs';
const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const dir = fileURLToPath(new URL('.', import.meta.url));
const root = '/docs/design-handoff/council-ui-2026-11/03-approvals/';
const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
const phase = process.argv[2] ?? 'after';
const records = [];
const contrast = await readFile(resolve(dir, '../01-groundwork/contrast.js'), 'utf8');
await mkdir(resolve(dir, 'png'), { recursive: true });
await mkdir(resolve('.whombat/shots'), { recursive: true });
try {
  let fixture;
  if (phase === 'before') {
    const seed = await browser.newPage({ locale: 'en-GB', timezoneId: 'Europe/Amsterdam' });
    await openApp(seed, { path: (process.env.CAPTURE_URL ?? 'http://127.0.0.1:5297') + '/chat?approval=902', theme: 'light' });
    await seed.locator('[data-screen="approval"]').waitFor();
    await settle(seed, 0);
    const captured = await seed.evaluate(() => ({ queries: window.__WHOMBAT__.services.queryClient.getQueryCache().findAll()
      .filter((q) => ['approvals.get', 'conversations.bootstrap', 'changeWindow.get'].includes(q.queryKey[1]))
      .map((q) => ({ key: q.queryKey, data: q.state.data })) }));
    await writeFile(resolve('.whombat/fixture-light.json'), JSON.stringify(captured, null, 2) + '\n');
    fixture = await buildFixtures(captured);
    await seed.close();
  } else fixture = JSON.parse(await readFile(resolve(dir, 'fixture-world.json'), 'utf8'));
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/Amsterdam',
      deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme });
    const page = await context.newPage();
    if (phase === 'before') {
      for (const kind of Object.keys(fixture.worlds)) {
        for (const surface of ['card', 'details']) {
          const path = surface === 'card' ? '/chat?thread=msg_chat-pve-memory' : '/chat?approval=902';
          await openApp(page, { path: (process.env.CAPTURE_URL ?? 'http://127.0.0.1:5297') + path, theme });
          await page.locator(surface === 'card' ? '[data-card="approval"]' : '[data-screen="approval"]').waitFor();
          await settle(page, 0);
          const approval = fixture.worlds[kind].approval;
          if (surface === 'details') await patchQueries(page, 'approvals.get', (d, a) => ({ ...d, approval: a }), approval);
          else await page.evaluate((a) => {
            const qc = window.__WHOMBAT__.services.queryClient;
            const replace = (x) => {
              if (!x || typeof x !== 'object') return x;
              if (x.id === 'apr_zfs-cache' && x.action && x.conditions) return a;
              if (Array.isArray(x)) return x.map(replace);
              return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, replace(v)]));
            };
            for (const q of qc.getQueryCache().findAll()) if (q.state.data && JSON.stringify(q.state.data).includes('apr_zfs-cache')) qc.setQueryData(q.queryKey, replace(q.state.data));
          }, approval);
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          await shot(page, `before-${surface}-${kind}-${theme}.png`, { kind, surface, theme, fixturePatch: kind !== 'everyday' });
        }
      }
    } else {
      const shots = [
        ['after-card-everyday', 'surface=card&kind=everyday', 1440, 900],
        ['after-web-code-command', 'surface=web-board&group=code', 1440, 900],
        ['after-web-mail-key', 'surface=web-board&group=mail', 1440, 900],
        ['after-details-everyday', 'surface=details&kind=everyday', 1440, 900],
        ['after-phones-general', 'surface=phones', 1440, 900],
        ['after-phone-command', 'surface=phone&kind=command', 390, 844],
        ['after-phone-mail', 'surface=phone&kind=mail', 390, 844],
        ['after-open-message-variant', 'surface=variants&group=mail', 1440, 900],
        ['after-new-data-variant', 'surface=variants&group=data', 1440, 900],
        ['after-answered-states', 'surface=states', 1440, 900],
        ['after-android-large', 'surface=phone&kind=mail&platform=android&large=1', 390, 844],
      ];
      for (const [name, query, width, height] of shots) {
        await page.setViewportSize({ width, height });
        await page.goto((process.env.MOCKUP_URL ?? 'http://127.0.0.1:5397') + root + 'approvals.html?' + query + '&theme=' + theme);
        await page.waitForSelector('html[data-ready="true"]');
        await page.evaluate(() => document.fonts.ready);
        if (name === 'after-phone-mail') await page.evaluate(() => {
          const scroll = document.querySelector('.scroll');
          const message = document.querySelector('.mail-body');
          scroll.scrollTop = message.offsetTop - scroll.offsetTop - 64;
        });
        await shot(page, `${name}-${theme}.png`, { theme, query });
      }
    }
    await context.close();
  }
  await writeFile(resolve(dir, `${phase}-capture.json`), JSON.stringify(records, null, 2) + '\n');
} finally { await browser.close(); }
async function shot(page, file, meta) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const measure = await page.evaluate(contrast + '\nmeasureContrast()');
  await page.screenshot({ path: resolve(dir, 'png', file), animations: 'disabled', caret: 'hide', scale: 'css' });
  await copyFile(resolve(dir, 'png', file), resolve('.whombat/shots', file));
  records.push({ file, ...meta, viewport: page.viewportSize(), measure, errors });
  console.log(`${file}: ${measure.minimum}:1; ${measure.failures.length} below 4.5`);
}
