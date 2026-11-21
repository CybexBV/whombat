// Fixture evidence only. Run from the repository root with Node 24.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, settle } from '../../../../apps/web/visual/support/harness.ts';
import { agentWords, theAgentOf } from '../../../../packages/client/src/agentName.ts';

const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const { PNG } = createRequire(resolve('tools/visual/package.json'))('pngjs');
const out = fileURLToPath(new URL('.', import.meta.url));
const app = process.env.CAPTURE_URL || 'http://127.0.0.1:5279';
const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
const contrast = await readFile(resolve(out, '../01-groundwork/contrast.js'), 'utf8');
const screens = [
  ['connection', '/things/connection%3Acon_home-assistant', 'More detail'],
  ['usage', '/settings?tab=advanced&part=spend', 'Spend'],
  ['settings', '/settings', 'Settle quiet threads'],
];
await mkdir(resolve(out, 'png'), { recursive: true });
await mkdir(resolve('.whombat/shots'), { recursive: true });
try {
  const records = [];
  let fixture;
  for (const platform of ['web', 'phone-web']) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/Amsterdam', deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem('whombat:fixture-looks', '1'));
    for (const [screen, path, ready] of screens) {
      await openApp(page, { path: app + path, theme, width: platform === 'web' ? 1440 : 390, height: platform === 'web' ? 900 : 844 });
      await page.waitForFunction(word => document.body.innerText.includes(word), ready);
      await page.waitForFunction(() => window.__WHOMBAT__?.services.queryClient.isFetching() === 0);
      await settle(page, 0);
      const data = await page.evaluate(() => {
        const queries = window.__WHOMBAT__.services.queryClient.getQueryCache();
        const find = endpoint => queries.findAll({ queryKey: ['whombat', endpoint] }).find(q => q.state.data)?.state.data;
        return { bootstrap: find('conversations.bootstrap'), thing: find('things.page'), spend: find('spend.overview') };
      });
      fixture ??= { assistant: agentWords(theAgentOf(data.bootstrap.principals)?.name).name, clock: '2026-09-23T09:22:00.000Z', timeZone: 'Europe/Amsterdam' };
      if (data.thing) fixture.thing = data.thing;
      if (data.spend) fixture.spend = data.spend;
      const file = `before-${platform}-${screen}-${theme}.png`;
      const bytes = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      await writeFile(resolve(out, 'png', file), PNG.sync.write(PNG.sync.read(bytes), { deflateLevel: 9, deflateStrategy: 0, filterType: -1 }));
      await copyFile(resolve(out, 'png', file), resolve('.whombat/shots', `10-${file}`));
      const measure = await page.evaluate(contrast + '\nmeasureContrast()');
      records.push({ platform, theme, screen, path, file, measure });
      console.log(`${file}: ${measure.minimum}:1`);
    }
    await context.close();
  }
  await writeFile(resolve(out, 'before.json'), JSON.stringify(records, null, 2) + '\n');
  await writeFile(resolve(out, 'fixture.js'), `// Frozen fixture response. The assistant value comes from agentWords(theAgentOf(principals)?.name).\nconst REVIEW_FIXTURE = ${JSON.stringify(fixture, null, 2)};\n`);
} finally {
  await browser.close();
}
