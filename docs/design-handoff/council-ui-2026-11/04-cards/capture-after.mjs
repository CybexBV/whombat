// Static-document review, not an app test suite. Node 24, repository root.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const { PNG } = createRequire(resolve('tools/visual/package.json'))('pngjs');
const dir = resolve('docs/design-handoff/council-ui-2026-11/04-cards');
const url = pathToFileURL(resolve(dir, 'mockup.html')).href;
const contrast = await readFile(resolve(dir, '../01-groundwork/contrast.js'), 'utf8');
const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
const report = { browser: browser.version(), clock: '2026-09-23T09:22:00.000Z', records: [], interactions: [], errors: [] };
async function compress(file) { const image = PNG.sync.read(await readFile(file)); await writeFile(file, PNG.sync.write(image, { deflateLevel: 9 })); }
async function ready(page) {
  await page.waitForLoadState('load'); await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}
async function measureAll(page) {
  const snapshots = [];
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 600) {
    await page.evaluate(y => window.scrollTo(0, y), y);
    snapshots.push(await page.evaluate(contrast + '\nmeasureContrast()'));
  }
  const pairs = [...new Map(snapshots.flatMap(s => s.pairs).map(p => [JSON.stringify([p.foreground, p.background]), p])).values()];
  const failures = snapshots.flatMap(s => s.failures);
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.card')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => el.dataset.cardId));
  const documentOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
  const touch = await page.evaluate(() => { const minimum = document.body.dataset.os === 'android' ? 48 : 44; const targets = [...document.querySelectorAll('.card button, .card summary, .task label')].map(el => ({ text: el.textContent.trim().slice(0, 80), width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })).filter(r => r.width && r.height); return { minimum, count: targets.length, failures: targets.filter(r => r.width < minimum - .1 || r.height < minimum - .1) }; });
  const text = await page.locator('body').innerText();
  return { minimum: Math.min(...snapshots.map(s => s.minimum).filter(Boolean)), failures, pairs, overflow, documentOverflow, touch, invalid: /undefined|\[object Object\]|NaN/.test(text), skipped: [...new Set(snapshots.flatMap(s => s.skipped))] };
}
try {
  for (const [platform, width, height] of [['web', 1440, 900], ['ios', 390, 844], ['android', 390, 844]]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'en-GB', timezoneId: 'Europe/Amsterdam', reducedMotion: 'reduce', colorScheme: theme });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push({ platform, theme, error: error.message }));
      await page.clock.setFixedTime(new Date(report.clock));
      await page.goto(`${url}?platform=${platform}&theme=${theme}`); await ready(page);
      const gallery = resolve(dir, `png/after-${platform}-${theme}.png`);
      await page.screenshot({ path: gallery, animations: 'disabled', caret: 'hide' }); await compress(gallery);
      const measurement = await measureAll(page);
      report.records.push({ page: 'gallery', platform, theme, viewport: [width, height], file: `png/after-${platform}-${theme}.png`, ...measurement });
      const ids = await page.evaluate(() => Cards.defs.map(d => d[0]));
      for (const id of ids) {
        await page.goto(`${url}?card=${id}&platform=${platform}&theme=${theme}`); await ready(page);
        const raw = resolve(`.whombat/shots/cards-${id}-${platform === 'web' ? 'web' : platform === 'ios' ? 'phone-web' : 'android'}-${theme}-after.png`);
        await page.screenshot({ path: raw, animations: 'disabled', caret: 'hide' });
      }
      await page.goto(`${url}?decisions=1&platform=${platform}&theme=${theme}&expanded=1`); await ready(page);
      await page.locator('[data-before] img').first().waitFor();
      const decisions = resolve(dir, `png/decisions-${platform}-${theme}.png`);
      await page.screenshot({ path: decisions, fullPage: true, animations: 'disabled', caret: 'hide' }); await compress(decisions);
      report.records.push({ page: 'decisions', platform, theme, viewport: [width, height], file: `png/decisions-${platform}-${theme}.png`, ...await measureAll(page) });
      await page.goto(`${url}?platform=${platform}&theme=${theme}&large=1`); await ready(page);
      report.records.push({ page: '200-percent-text', platform, theme, viewport: [width, height], ...await measureAll(page) });
      console.log(`${platform} ${theme}: minimum ${measurement.minimum}:1, ${measurement.failures.length} failures, ${measurement.overflow.length} card overflows`);
      if (platform === 'ios' && theme === 'light') {
        await page.goto(`${url}?card=research&platform=ios&theme=light`); await ready(page);
        const main = page.locator('[data-action="expand"]'); await main.focus(); await main.press('Enter');
        if (!await page.locator('.footer > details').evaluate(el => el.open)) throw new Error('Main action did not open Details');
        if (!await main.evaluate(el => el === document.activeElement)) throw new Error('Expansion lost focus');
        report.interactions.push('Fold opens in place with keyboard; focus stays on its main action.');
        await page.goto(`${url}?card=delegation-offer&platform=ios&theme=light`); await ready(page);
        const check = page.locator('[data-task-check="1"]'); await check.uncheck();
        if (await page.locator('[data-action="handover"]').innerText() !== 'Hand over 2') throw new Error('Selected count did not update');
        await page.locator('.task[data-task="2"] .ai').click();
        await page.locator('dialog select').selectOption('GPT 6.1 Sol · High · Fast'); await page.locator('[data-save-ai]').click();
        if (!(await page.locator('[data-picked-summary]').innerText()).includes('GPT 6.1 Sol · High · Fast')) throw new Error('AI choice hidden from commitment');
        await page.locator('[data-action="handover"]').click(); await page.locator('dialog').waitFor();
        await page.keyboard.press('Escape');
        if (!await page.locator('[data-action="handover"]').evaluate(el => el === document.activeElement)) throw new Error('Dialog lost return focus');
        report.interactions.push('Task tick updates selected work and Hand over count, without reordering; AI choice updates the visible commitment; dialog returns focus.');
      }
      await context.close();
    }
  }
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(pathToFileURL(resolve(dir, 'index.html')).href); await ready(page);
  if (await page.locator('#card option').count() !== 26) throw new Error('Inventory selector incomplete');
  await page.selectOption('#platform', 'android'); await page.click('#theme');
  report.interactions.push('Before/after selector, platform selector and theme toggle render without app access.');
  await context.close();
} finally {
  await browser.close(); await writeFile(resolve(dir, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
}
const failures = report.records.flatMap(r => r.failures);
if (failures.length || report.errors.length || report.records.some(r => r.invalid || r.overflow.length || r.documentOverflow || r.touch.failures.length)) {
  console.error(JSON.stringify({ failures, errors: report.errors, invalid: report.records.filter(r => r.invalid || r.overflow.length || r.documentOverflow).map(r => [r.page, r.platform, r.theme, r.overflow, r.documentOverflow, r.invalid]) }, null, 2));
  process.exitCode = 1;
}
