// Run from the repo root with Node 24: node --import tsx <this file>.
// CAPTURE_URL points at this checkout's VITE_FIXTURES=1 Vite (see NOTES.md).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { openApp, settle } from '../../../../apps/web/visual/support/harness.ts';
import { agentWords, theAgentOf } from '../../../../packages/client/src/agentName.ts';
const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const { PNG } = createRequire(resolve('tools/visual/package.json'))('pngjs');
const dir = resolve('docs/design-handoff/council-ui-2026-11/04-cards');
const base = process.env.CAPTURE_URL || 'http://localhost:5274';
const states = ['plan', 'plan-go-ahead', 'plan-deployed', 'run', 'run-done', 'run-failed', 'run-paused', 'research', 'review', 'commits', 'pill', 'answer', 'digest', 'guide-provider', 'guide-provider-done', 'guide-connect', 'guide-result'];
const threads = [
  ['delegation-offer', 'msg_chat-delegation-files', 'delegation'],
  ['delegation-working', 'msg_chat-delegation-settings', 'delegation'],
  ['delegation-done', 'msg_chat-delegation-inbox', 'delegation'],
  ['council-live', 'msg_chat-council-nas', 'council'],
  ['council-done', 'msg_chat-council-settings', 'council'],
  ['council-mixed', 'msg_chat-council-inbox', 'council'],
  ['research-go', 'msg_look-pve-01', 'look_plan'],
  ['care-plan', 'msg_care-pve-03', 'look_plan'],
  ['secret', 'msg_chat-connect', 'guide'],
  ['secret-done', 'msg_chat-grafana', 'guide'],
];
await mkdir(resolve(dir, 'png'), { recursive: true });
await mkdir(resolve('.whombat/shots'), { recursive: true });
const exclude = (await import('node:child_process')).execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim();
const oldExclude = await readFile(exclude, 'utf8');
if (!oldExclude.includes('.whombat/')) await writeFile(exclude, oldExclude + '\n.whombat/\n');
const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
const onlyPlatform = process.env.CAPTURE_PLATFORM;
const records = onlyPlatform ? JSON.parse(await readFile(resolve(dir, 'before.json'), 'utf8')).filter(r => r.platform !== onlyPlatform) : [];
const fixture = onlyPlatform ? JSON.parse(await readFile(resolve(dir, 'fixture.json'), 'utf8')) : { states: {}, threads: {}, assistantName: null };
try {
  for (const [platform, width, height] of [['web', 1440, 900], ['phone-web', 390, 844]]) {
    if (onlyPlatform && onlyPlatform !== platform) continue;
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/Amsterdam', deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme });
      const page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem('whombat:fixture-looks', '1'));
      const images = [];
      let y = 0;
      for (const id of [...states, ...threads.map(t => t[0])]) {
        const recordId = id === 'guide-provider-done' ? 'question-done' : id;
        const thread = threads.find(t => t[0] === id);
        const path = thread ? `/chat?thread=${thread[1]}` : `/visual/cards.html?theme=${theme}&states=${id}&width=${width < 500 ? 358 : 762}`;
        await openApp(page, { path: base + path, theme, width, height });
        const selector = thread ? `[data-card="${thread[2]}"]` : `[data-state="${id}"]`;
        try { await page.locator(selector).first().waitFor({ timeout: 20000 }); }
        catch { await page.reload(); await page.locator(selector).first().waitFor({ timeout: 60000 }); }
        await settle(page, 0);
        const el = id === 'secret' ? page.locator('[data-card="guide"]').filter({ hasText: 'UniFi' }).first() : page.locator(selector).first();
        await el.scrollIntoViewIfNeeded();
        const raw = `.whombat/shots/cards-${recordId}-${platform}-${theme}-before.png`;
        await page.screenshot({ path: raw, animations: 'disabled', caret: 'hide' });
        const png = PNG.sync.read(await el.screenshot({ animations: 'disabled', caret: 'hide' }));
        images.push({ png, y });
        const record = { id: recordId, platform, theme, path, viewport: [width, height], raw, atlas: `png/before-${platform}-${theme}.png`, crop: { x: 0, y, width: png.width, height: png.height }, text: await el.innerText() };
        records.push(record);
        y += png.height + 24;
        if (platform === 'web' && theme === 'light') {
          if (!thread) fixture.states[recordId] = await page.evaluate(async (id) => (await import('/src/features/cards/cardStates.ts')).CARD_STATES[id], id);
          else fixture.threads[id] = await page.evaluate(() => {
            const qc = window.__WHOMBAT__.services.queryClient;
            return qc.getQueryCache().getAll().filter(q => q.state.data !== undefined && /messages|thread/i.test(JSON.stringify(q.queryKey))).map(q => ({ key: q.queryKey, data: q.state.data }));
          });
          if (!fixture.assistantName) {
            const principals = await page.evaluate(() => window.__CARDS__.services.queryClient.getQueryCache().findAll({ queryKey: ['whombat', 'conversations.bootstrap'] }).find(q => q.state.data)?.state.data.principals);
            fixture.assistantName = agentWords(theAgentOf(principals)?.name).name;
          }
        }
        console.log(`${id} ${platform} ${theme}: ${png.width}×${png.height}`);
      }
      const atlas = new PNG({ width: Math.max(...images.map(i => i.png.width)), height: y - 24 });
      atlas.data.fill(0);
      for (const { png, y } of images) PNG.bitblt(png, atlas, 0, 0, png.width, png.height, 0, y);
      await writeFile(resolve(dir, `png/before-${platform}-${theme}.png`), PNG.sync.write(atlas, { deflateLevel: 9 }));
      await context.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(resolve(dir, 'before.json'), JSON.stringify(records, null, 2) + '\n');
  for (const key of Object.keys(fixture.threads)) {
    const found = new Map();
    const visit = value => { if (!value || typeof value !== 'object') return; if (value.card && ['council', 'delegation', 'look_plan', 'guide'].includes(value.card.kind)) found.set(value.id, { id: value.id, createdAt: value.createdAt, card: value.card }); for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child); };
    visit(fixture.threads[key]); fixture.threads[key] = [...found.values()];
  }
  await writeFile(resolve(dir, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n');
  await writeFile(resolve(dir, 'fixture.js'), `window.CARD_FIXTURE = ${JSON.stringify(fixture)};\nwindow.CARD_PICTURE = "png/fixture-settings.png";\n`);
  await writeFile(resolve(dir, 'evidence.js'), `window.CARD_EVIDENCE = ${JSON.stringify(records)};\n`);
}
