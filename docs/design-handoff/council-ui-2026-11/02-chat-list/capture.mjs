// Static mockup verification, not an app test suite. No server or device is used.
// Run from the repository root: node --import tsx docs/design-handoff/council-ui-2026-11/02-chat-list/capture.mjs
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const out = fileURLToPath(new URL('.', import.meta.url));
const contrast = await readFile(resolve(out, '../01-groundwork/contrast.js'), 'utf8');
const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
const records = [];
await mkdir(resolve(out, 'png'), { recursive: true });
await mkdir('.whombat/shots', { recursive: true });
try {
  for (const theme of ['light', 'dark']) {
    for (const [platform, width, height] of [['desktop', 1440, 900], ['phone-web', 390, 844], ['ios', 390, 844], ['android', 390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'en-GB', timezoneId: 'Europe/Amsterdam', deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.clock.setFixedTime('2026-09-23T09:22:00.000Z');
      const url = pathToFileURL(resolve(out, 'mockup.html'));
      url.search = new URLSearchParams({ theme, platform: ['ios', 'android'].includes(platform) ? platform : 'web' }).toString();
      await page.goto(url.href);
      await page.evaluate(() => document.fonts.ready);
      const fonts = await page.evaluate(() => ({ sans: document.fonts.check('600 16px "Bricolage Grotesque"'), mono: document.fonts.check('400 12px "DM Mono"') }));
      if (!fonts.sans || !fonts.mono) throw new Error('Bundled fonts did not load');
      const measured = await page.evaluate(contrast + '\nmeasureContrast()');
      const rowBounds = await page.locator('#thread-list .thread-row').evaluateAll((els) => els.map((el) => ({ id: el.closest('li').dataset.root, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
      const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
      const file = `${platform}-${theme}.png`;
      await page.screenshot({ path: resolve(out, 'png', file), animations: 'disabled', caret: 'hide', scale: 'css' });
      await copyFile(resolve(out, 'png', file), resolve('.whombat/shots', `chat-list-${platform}-${theme}-after.png`));

      // A real keyboard activation and Escape must restore the same row.
      const row = page.locator('#thread-list .thread-row').first();
      await row.focus();
      await page.keyboard.press('Enter');
      if (!(await page.locator('#thread-detail').evaluate((el) => el.open))) throw new Error('Thread preview did not open');
      await page.keyboard.press('Escape');
      const focusReturned = await row.evaluate((el) => document.activeElement === el);
      if (!focusReturned) throw new Error('Focus did not return to its row');

      // All overlapping flag combinations use the stated precedence, including unset flags.
      const overlap = await page.evaluate(() => {
        const { stage } = window.CHAT_STUDY;
        return Array.from({ length: 16 }, (_, mask) => {
          const flags = { waiting: !!(mask & 8), working: !!(mask & 4), handedOver: !!(mask & 2), settled: mask & 1 ? { at: '', how: 'person' } : null };
          const expected = flags.waiting ? 'waiting' : flags.working ? 'working' : flags.handedOver ? 'handed-over' : flags.settled ? 'settled' : null;
          return { mask, actual: stage(flags)?.key ?? null, expected };
        });
      });
      if (overlap.some((entry) => entry.actual !== entry.expected)) throw new Error('Stage precedence mismatch');
      // Largest-text layout in this HTML study; this does not certify native Dynamic Type.
      await page.evaluate(() => document.body.classList.add('large-text'));
      const large = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, listWidth: document.querySelector('.mock-surface').clientWidth, listScrollWidth: document.querySelector('.mock-surface').scrollWidth, rowWidth: document.querySelector('.thread-row').getBoundingClientRect().width }));
      if (large.scrollWidth > large.viewport || large.listScrollWidth > large.listWidth) throw new Error(`Text overflow: ${JSON.stringify(large)}`);
      records.push({ platform, theme, file, fonts, dimensions, rowBounds, contrast: measured, focusReturned, overlap, large, errors });
      if (errors.length || measured.failures.length) throw new Error(`Render/contrast failed: ${platform} ${theme}`);
      await context.close();
    }
    for (const pageName of ['states', 'variant']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.clock.setFixedTime('2026-09-23T09:22:00.000Z');
      await page.goto(pathToFileURL(resolve(out, `${pageName}.html`)).href + `?theme=${theme}`);
      if (pageName === 'states') await page.waitForFunction(() => document.body.dataset.ready === 'true');
      await page.evaluate(() => document.fonts.ready);
      if (pageName === 'states') {
        const longLength = await page.evaluate(() => window.createChatRows(window.CHAT_FIXTURE.examples).localScenarios.find((t) => t.rootId === 'msg_study-long-question').text.length);
        if (longLength > 200) throw new Error(`Long question exceeds contract: ${longLength}`);
      }
      const measured = await page.evaluate(contrast + '\nmeasureContrast()');
      if (errors.length || measured.failures.length) throw new Error(`Specimen render/contrast failed: ${pageName} ${theme}`);
      await page.screenshot({ path: resolve(out, 'png', `${pageName}-${theme}.png`), animations: 'disabled', caret: 'hide', scale: 'css' });
      records.push({ page: pageName, theme, contrast: measured, errors });
      await page.close();
    }
  }
  const gallery = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await gallery.goto(pathToFileURL(resolve(out, 'index.html')).href);
  await gallery.selectOption('#platform', 'ios');
  await gallery.selectOption('#theme', 'dark');
  if (!(await gallery.locator('#native-gap').isVisible())) throw new Error('Native capture GAP is hidden');
  if ((await gallery.evaluate(() => document.documentElement.scrollWidth)) > 390) throw new Error('Gallery overflows phone width');
  await gallery.close();
  await writeFile(resolve(out, 'verification.json'), JSON.stringify(records, null, 2) + '\n');
  console.log(JSON.stringify(records.map(({ platform, page, theme, contrast, errors }) => ({ view: platform || page, theme, contrast: contrast.minimum, errors })), null, 2));
} finally { await browser.close(); }
