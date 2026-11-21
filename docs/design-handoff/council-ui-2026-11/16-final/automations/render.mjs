// Static drawings and design measurements only. No application tests or CI.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = createRequire(resolve('apps/web/package.json'))('@playwright/test');
const { PNG } = createRequire(resolve('tools/visual/package.json'))('pngjs');
const base = resolve('docs/design-handoff/council-ui-2026-11/16-final');
const dir = resolve(base, 'automations');
const shots = resolve('.whombat/shots/automations-round-four');
const before = process.argv.includes('--before');
const contrast = await readFile(resolve(base, '../01-groundwork/contrast.js'), 'utf8');
const controlColours = await readFile(resolve(base, 'colour-pairs.js'), 'utf8');
const platforms = ['desktop', 'phoneweb', 'ios', 'android'];
const scenes = [
  ['normal', {}], ['loading', { state: 'loading' }], ['empty', { state: 'empty' }],
  ['failed', { state: 'failed' }], ['saved-failed', { state: 'saved-failed' }],
  ['lower', { focus: 'later', expand: 'all' }], ['largest', { text: 'largest' }],
  ['largest-lower', { text: 'largest', focus: 'later', expand: 'all' }],
  ['worked', { view: 'run', run: 'arn_41' }],
  ['run-failed', { view: 'run', run: 'arn_26' }],
  ['skipped', { view: 'run', automation: 'aut_suspected-bug', run: 'arn_38' }],
  ['waiting', { view: 'run', automation: 'aut_fix-web', run: 'arn_48' }],
  ['history', { view: 'detail' }], ['schedules', { focus: 'later' }],
];
const evidence = { purpose: 'Mockup PNG production and geometry/contrast observations; no tests', phase: before ? 'before' : 'after', renders: [], errors: [] };
const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
const atlases = new Map();
await mkdir(shots, { recursive: true });
try {
  for (const platform of platforms) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: platform === 'desktop' ? 1440 : 390, height: platform === 'desktop' ? 900 : 844 },
      locale: 'en-GB', timezoneId: 'Europe/Amsterdam', deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.on('pageerror', e => evidence.errors.push({ platform, theme, error: e.message }));
    await page.clock.setFixedTime(new Date('2026-09-23T12:05:00.000Z'));
    for (const [scene, params] of scenes) {
      const url = pathToFileURL(resolve(dir, 'mockup.html'));
      url.search = new URLSearchParams({ platform, theme, ...params });
      await page.goto(url.href);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      // Fonts can change the lower page's height after the drawing first positions its scroller.
      if (params.focus === 'later') await page.locator('#main').evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight; });
      const file = `${platform}-${theme}${scene === 'normal' ? '' : '-' + scene}.png`;
      const buffer = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      const compressed = PNG.sync.write(PNG.sync.read(buffer), { deflateLevel: 9 });
      await writeFile(resolve(shots, `${before ? 'before' : 'after'}-${file}`), compressed);
      if (!before) await writeFile(resolve(dir, file), compressed);
      const colours = await page.evaluate(contrast + '\nmeasureContrast()');
      delete colours.text;
      const geometry = await page.evaluate(() => {
        const main = document.getElementById('main'), viewport = main.getBoundingClientRect();
        const rows = [...document.querySelectorAll('.auto-row')].map(el => {
          const r = el.getBoundingClientRect();
          return { height: +r.height.toFixed(2), fullyVisible: r.top >= viewport.top && r.bottom <= viewport.bottom, name: el.querySelector('.compact-name,.auto-title')?.textContent };
        });
        const tools = [...document.querySelectorAll('.composer button')].map(el => {
          const r = el.getBoundingClientRect();
          return { name: el.getAttribute('aria-label'), top: +r.top.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
        });
        const minimum = document.body.dataset.platform === 'android' ? 48 : 44;
        const smallTargets = [...document.querySelectorAll('button,a,summary,textarea')].filter(el => !el.closest('dialog:not([open])') && !el.classList.contains('skip')).flatMap(el => {
          const r = el.getBoundingClientRect();
          return r.width && r.height && (r.width < minimum || r.height < minimum) ? [{ name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 80), width: +r.width.toFixed(2), height: +r.height.toFixed(2) }] : [];
        });
        return { pageOverflow: document.documentElement.scrollWidth - innerWidth, mainOverflow: main.scrollWidth - main.clientWidth, fullyVisibleRows: rows.filter(r => r.fullyVisible).length, rows, composerTools: tools, smallTargets, fonts: document.fonts.check('16px "Bricolage Grotesque"') };
      });
      evidence.renders.push({ platform, theme, scene, file, params, geometry, colours, controlColours: await page.evaluate(controlColours + '\nmeasureControlPairs()') });
      if (!before) {
        const states = ['loading', 'empty', 'failed', 'saved-failed', 'lower'];
        const runs = ['worked', 'run-failed', 'skipped', 'waiting', 'history', 'schedules'];
        const group = states.includes(scene) ? 'states' : runs.includes(scene) ? 'runs' : null;
        if (group) {
          const key = `${group}-${theme}`;
          if (!atlases.has(key)) atlases.set(key, []);
          atlases.get(key).push({ platform, row: (group === 'states' ? states : runs).indexOf(scene), buffer });
        }
      }
    }
    await context.close();
    console.log(`Rendered ${platform} ${theme}: ${scenes.length} ${evidence.phase} scenes.`);
  }
  // Retain the established atlas filenames for links from the common gallery.
  if (!before) for (const [name, items] of atlases) {
    const atlas = new PNG({ width: 2690, height: (Math.max(...items.map(i => i.row)) + 1) * 948 + 16 });
    atlas.data.fill(0);
    for (const item of items) {
      const src = PNG.sync.read(item.buffer);
      PNG.bitblt(src, atlas, 0, 0, src.width, src.height, [16, 1472, 1878, 2284][platforms.indexOf(item.platform)], 48 + item.row * 948);
    }
    await writeFile(resolve(dir, 'png', `${name}.png`), PNG.sync.write(atlas, { deflateLevel: 9 }));
  }
} finally {
  await browser.close();
  await writeFile(before ? resolve(shots, 'before-renders.json') : resolve(dir, 'renders.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify({ scenes: evidence.renders.length, errors: evidence.errors, normal: evidence.renders.filter(r => r.scene === 'normal').map(r => ({ platform: r.platform, theme: r.theme, visible: r.geometry.fullyVisibleRows, heights: r.geometry.rows.map(r => r.height) })), contrastMinimum: { light: Math.min(...evidence.renders.filter(r => r.theme === 'light').map(r => r.colours.minimum)), dark: Math.min(...evidence.renders.filter(r => r.theme === 'dark').map(r => r.colours.minimum)) }, overflow: evidence.renders.filter(r => r.geometry.pageOverflow || r.geometry.mainOverflow).map(r => r.file), smallTargets: evidence.renders.filter(r => r.geometry.smallTargets.length).map(r => ({ file: r.file, targets: r.geometry.smallTargets })) }, null, 2));
