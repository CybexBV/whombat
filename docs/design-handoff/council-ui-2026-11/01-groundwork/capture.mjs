// Run from the repository root: node --import tsx docs/design-handoff/council-ui-2026-11/01-groundwork/capture.mjs
// Start this checkout's Vite first, with VITE_FIXTURES=1 VITE_FIXTURE_HOSTS=1
// VITE_FIXTURE_DASHBOARDS=1 VITE_FIXTURE_FILES=1 VITE_FIXTURE_AUTOMATIONS=1 and a free WEB_PORT.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openApp, settle } from '../../../../apps/web/visual/support/harness.ts';
import { agentWords, theAgentOf } from '../../../../packages/client/src/agentName.ts';
const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const out = fileURLToPath(new URL('.', import.meta.url));
const base = process.env.CAPTURE_URL || 'http://127.0.0.1:5197';
export const screens = [
  ['chat-list', 'Chat list', '/chat', 'Last night’s backups'],
  ['thread', 'A thread with its cards', '/chat?thread=msg_chat-pve-memory', 'Technical details'],
  ['approval', 'An approval', '/chat?approval=902', 'Limit the ZFS cache'],
  ['inbox', 'Inbox', '/inbox', 'Needs you'],
  ['overview', 'Overview', '/connections', 'blackbox'],
  ['connection', 'A connection page', '/things/connection%3Acon_home-assistant', 'More detail'],
  ['server', 'A server page', '/things/server%3Apve-02', 'Busiest machines'],
  ['automations', 'Automations', '/automations', 'Last run'],
  ['settings', 'Settings', '/settings', 'Settle quiet threads'],
  ['vault', 'Vault', '/vault', 'Vault'],
  ['files', 'Files', '/files', 'Files shared in your conversations'],
  ['usage', 'Usage (shipped Spend page)', '/settings?tab=advanced&part=spend', 'Spend'],
];
const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
const contrast = await readFile(resolve(out, 'contrast.js'), 'utf8');
const onlyPlatform = process.env.CAPTURE_PLATFORM;
const records = onlyPlatform ? JSON.parse(await readFile(resolve(out, 'capture.json'), 'utf8')).filter((r) => r.platform !== onlyPlatform) : [];
try {
  await mkdir(resolve(out, 'png'), { recursive: true });
  await mkdir(resolve('.whombat/shots'), { recursive: true });
  for (const [platform, width, height] of [['desktop', 1440, 900], ['phone-web', 390, 844]]) {
    if (onlyPlatform && platform !== onlyPlatform) continue;
    for (const theme of ['light', 'dark']) {
      for (const [id, name, path, ready] of screens) {
        const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/Amsterdam', deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme });
        const page = await context.newPage();
        await page.addInitScript(() => localStorage.setItem('whombat:fixture-looks', '1'));
        await openApp(page, { path: base + path, theme, width, height });
        await page.waitForFunction((word) => document.body.innerText.includes(word), ready);
        await settle(page, 0);
        await page.waitForFunction(() => window.__WHOMBAT__?.services.queryClient.isFetching() === 0);
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('body *')) {
            if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = 0;
          }
        });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const measure = await page.evaluate(contrast + '\nmeasureContrast()');
        const principals = await page.evaluate(() => window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({ queryKey: ['whombat', 'conversations.bootstrap'] }).find(q => q.state.data)?.state.data.principals);
        const assistantName = agentWords(theAgentOf(principals)?.name).name;
        const file = `${platform}-${id}-${theme}.png`;
        await page.screenshot({ path: resolve(out, 'png', file), animations: 'disabled', caret: 'hide', scale: 'css' });
        await copyFile(resolve(out, 'png', file), resolve('.whombat/shots', file));
        records.push({ id, name, path, platform, theme, file, assistantName, measure });
        await writeFile(resolve(out, 'capture.json'), JSON.stringify(records, null, 2) + '\n');
        console.log(`${file}: ${measure.minimum}:1, ${measure.failures.length} below 4.5`);
        await context.close();
      }
    }
  }
} finally { await browser.close(); }
