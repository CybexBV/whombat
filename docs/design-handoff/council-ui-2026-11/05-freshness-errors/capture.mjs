// Run from the repo root with Node 24: node --import tsx <this file> before|after.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, settle, patchQueries } from '../../../../apps/web/visual/support/harness.ts';
import { agentWords, theAgentOf } from '../../../../packages/client/src/agentName.ts';

const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const out = fileURLToPath(new URL('.', import.meta.url));
const mode = process.argv[2] || 'after';
const app = process.env.CAPTURE_URL || 'http://127.0.0.1:5267';
const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
await mkdir(resolve(out, 'png'), { recursive: true });
await mkdir(resolve('.whombat/shots'), { recursive: true });
try {
  if (mode === 'before') {
    let fixture;
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/Amsterdam', reducedMotion: 'reduce', deviceScaleFactor: 1 });
      const page = await context.newPage();
      await openApp(page, { path: app + '/connections?tab=pinned', theme });
      await settle(page, 0);
      await page.waitForFunction(() => !!document.querySelector('[data-widget]'));
      // Same fixture values, deliberately aged: newest point and last saved readings at 11:10, clock 11:22.
      await patchQueries(page, 'home.overview', data => ({ ...data, widgets: data.widgets.map(w => ({ ...w, points: w.points.map(p => ({ ...p, t: new Date(Date.parse(p.t) - 300_000).toISOString() })), updatedAt: '2026-09-23T09:10:00.000Z', problem:'Couldn’t refresh the heat pump readings.' })) }), null);
      const data = await page.evaluate(() => {
        const qc = window.__WHOMBAT__.services.queryClient;
        const find = endpoint => qc.getQueryCache().findAll({ queryKey: ['whombat', endpoint] }).find(q => q.state.data)?.state.data;
        return { home: find('home.overview'), bootstrap: find('conversations.bootstrap') };
      });
      if (!fixture) fixture = { assistant: agentWords(theAgentOf(data.bootstrap.principals)?.name).name, widget: data.home.widgets[0], summary: data.home.summary, clock: '2026-09-23T09:22:00.000Z', timeZone: 'Europe/Amsterdam' };
      await page.screenshot({ path: resolve(out, `png/before-pinned-${theme}.png`), animations: 'disabled' });
      await copyFile(resolve(out, `png/before-pinned-${theme}.png`), resolve(`.whombat/shots/before-pinned-${theme}.png`));
      await page.goto(app + '/automations');
      await settle(page, 0);
      await page.waitForFunction(() => document.body.innerText.includes('Last run'));
      // Scenario: use an existing event-triggered fixture automation, changing only its newest run to failed.
      await patchQueries(page, 'automations.list', data => ({ ...data, automations: data.automations.map(a => a.id !== 'aut_suspected-bug' ? a : { ...a, lastRun: { ...a.lastRun, status: 'failed' }, recentRuns: a.recentRuns.map((r, i) => i ? r : { ...r, status: 'failed' }) }) }), null);
      await page.getByText('Last run 10:43, failed', { exact: true }).waitFor();
      if (theme === 'light') fixture.automationRows = await page.evaluate(() => {
        const data = window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({ queryKey: ['whombat','automations.list'] }).find(q => q.state.data).state.data;
        return [...document.querySelectorAll('[data-automation-row]')].map(el => {
          const a = data.automations.find(a => a.id === el.dataset.automationRow);
          const text = name => el.querySelector(`[class*="${name}"]`).textContent.trim();
          return { id:a.id, name:text('listName'), when:text('listWhen'), label:text('stateLabel'), line:text('stateText'), accessibilityLabel:el.getAttribute('aria-label'), source:a.glance?.source || 'message', lastStatus:a.lastRun?.status, bars:[...el.querySelectorAll('[class*="bars"] i')].map(i => ['Ok','Bad','Warn','Brand','Quiet'].find(t => i.className.includes('bar' + t))?.toLowerCase()) };
        });
      });
      await page.screenshot({ path: resolve(out, `png/before-automation-failed-${theme}.png`), animations: 'disabled' });
      await copyFile(resolve(out, `png/before-automation-failed-${theme}.png`), resolve(`.whombat/shots/before-automation-failed-${theme}.png`));
      await page.goto(app + '/connections');
      await settle(page, 0);
      await page.waitForFunction(() => document.body.innerText.includes('blackbox'));
      await page.evaluate(() => {
        const q = window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({ queryKey: ['whombat', 'home.overview'] }).find(q => q.state.data);
        q.setState({ error: new Error('No route for GET /api/v1/burrows/bur_fixture/home'), status: 'error', fetchStatus: 'idle' });
      });
      await page.screenshot({ path: resolve(out, `png/before-overview-error-${theme}.png`), animations: 'disabled' });
      await copyFile(resolve(out, `png/before-overview-error-${theme}.png`), resolve(`.whombat/shots/before-overview-error-${theme}.png`));
      await page.goto(app + '/things/server%3Apve-02');
      await settle(page, 0);
      await page.waitForFunction(() => document.body.innerText.includes('Busiest machines'));
      await page.evaluate(() => {
        const q = window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({ queryKey: ['whombat', 'hosts.getServer'] }).find(q => q.state.data);
        q.setState({ data: undefined, error: new Error('No route for GET /api/v1/burrows/bur_fixture/hosts/servers/pve-02'), status: 'error', fetchStatus: 'idle' });
      });
      await page.getByText('No route for GET', { exact: false }).first().waitFor();
      await page.screenshot({ path: resolve(out, `png/before-server-error-${theme}.png`), animations: 'disabled' });
      await copyFile(resolve(out, `png/before-server-error-${theme}.png`), resolve(`.whombat/shots/before-server-error-${theme}.png`));
      await context.close();
    }
    await writeFile(resolve(out, 'fixture.js'), `// Captured from the fixture app through the shared assistant name helper.\nconst REVIEW_FIXTURE = ${JSON.stringify(fixture, null, 2)};\n`);
    console.log('Before pictures and fixture data captured.');
  } else {
    const base = process.env.REVIEW_URL || 'http://127.0.0.1:5367/docs/design-handoff/council-ui-2026-11/05-freshness-errors/';
    const contrast = await readFile(resolve(out, '../01-groundwork/contrast.js'), 'utf8');
    const report = { renders: [], interactions: [], errors: [] };
    for (const platform of ['web','android','ios']) for (const theme of ['light','dark']) {
      const context = await browser.newContext({ locale:'en-GB', timezoneId:'Europe/Amsterdam', reducedMotion:'reduce', deviceScaleFactor:1, viewport:{ width:platform === 'web' ? 1440 : 390, height:platform === 'web' ? 900 : 844 } });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      await page.clock.setFixedTime(new Date('2026-09-23T09:22:00.000Z'));
      for (const screen of ['overview','pinned','server','automations']) {
        const states = screen === 'server' ? ['read','refreshing','loading','empty','no-copy','action','completed','refused','machines-empty'] : screen === 'automations' ? ['normal','read','refreshing','loading','empty','no-copy'] : screen === 'pinned' ? ['normal','read','refreshing','loading','empty'] : ['read','refreshing','loading','empty','no-copy'];
        for (const state of states) {
          const url = base + 'mockup.html?' + new URLSearchParams({screen,state,platform,theme});
          await page.goto(url);
          await page.evaluate(() => document.fonts.ready);
          const measure = await page.evaluate(contrast + '\nmeasureContrast()');
          const check = await page.evaluate(() => ({ horizontalOverflow: document.documentElement.scrollWidth > innerWidth, placeholder: [...document.querySelectorAll('input')].map(el => ({ color:getComputedStyle(el,'::placeholder').color, background:getComputedStyle(el.closest('.composer')).backgroundColor })), text:document.body.innerText }));
          if (check.horizontalOverflow) report.errors.push(`Overflow: ${platform}/${screen}/${state}/${theme}`);
          if (measure.failures.length) report.errors.push(`Contrast: ${platform}/${screen}/${state}/${theme}: ${JSON.stringify(measure.failures)}`);
          if (['action','completed','refused'].includes(state) && check.text.includes('Try again')) report.errors.push('Unsafe action retry: ' + url);
          if (state === 'refreshing' && !check.text.includes('Refreshing')) report.errors.push('Missing refresh status: ' + url);
          if (state === 'read' && !check.text.includes('Couldn’t')) report.errors.push('Missing read error: ' + url);
          if (state === 'read' && !['pinned','overview'].includes(screen) && check.text.includes('No route for GET')) report.errors.push('Unfolded raw error: ' + url);
          if (screen === 'pinned' && state !== 'loading' && state !== 'empty' && !check.text.includes('12 min ago')) report.errors.push('Missing actual point age: ' + url);
          const primary = state === (screen === 'automations' || screen === 'pinned' && platform !== 'web' ? 'normal' : screen === 'server' ? 'no-copy' : 'read');
          const extraAction = screen === 'server' && state === 'action' && platform !== 'ios';
          const save = (platform !== 'ios' || screen === 'server') && (primary || extraAction);
          const file = save ? `after-${platform}-${screen}${extraAction ? '-action' : ''}-${theme}.png` : null;
          if (file) {
            // Native before evidence is a GAP. These viewport drawings show the relevant chart/row after scrolling.
            if (platform !== 'web' && ['pinned','automations'].includes(screen)) await page.evaluate(() => scrollTo(0, 220));
            await page.screenshot({path:resolve(out,'png',file),animations:'disabled',caret:'hide'});
            await copyFile(resolve(out,'png',file),resolve('.whombat/shots',file));
          }
          report.renders.push({ platform,theme,screen,state,file,minimum:measure.minimum,pairs:measure.pairs,skipped:measure.skipped,placeholder:check.placeholder });
        }
        await page.goto(base + 'mockup.html?' + new URLSearchParams({screen,state:screen === 'automations' ? 'normal' : 'read',platform,theme,text:'large'}));
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        report.interactions.push({ name:`200% text: ${platform}/${screen}/${theme}`, pass:!overflow });
        if (overflow) report.errors.push(`200% text overflow: ${platform}/${screen}/${theme}`);
      }
      await page.goto(base + `mockup.html?screen=server&state=action&platform=${platform}&theme=${theme}`);
      const detail = page.locator('summary').first();
      await detail.click();
      const rawVisible = await page.getByText('unknown_outcome', {exact:false}).isVisible();
      const opener = page.getByRole('button',{name:/Ask .* to check/}).first();
      await opener.click();
      await page.getByRole('button',{name:'Back to the page'}).click();
      const focusReturned = await opener.evaluate(el => document.activeElement === el);
      report.interactions.push({name:`More detail and dialog focus: ${platform}/${theme}`,pass:rawVisible && focusReturned});
      if (!rawVisible || !focusReturned) report.errors.push('Detail/focus failed: ' + platform + '/' + theme);
      await context.close();
    }
    const context = await browser.newContext({viewport:{width:1440,height:900}});
    const page = await context.newPage();
    for (const theme of ['light','dark']) {
      await page.goto(base + `states.html?theme=${theme}`);
      await Promise.all(page.frames().map(frame => frame.evaluate(() => document.fonts.ready)));
      await page.screenshot({path:resolve(out,`png/after-states-${theme}.png`),animations:'disabled'});
      await copyFile(resolve(out,`png/after-states-${theme}.png`),resolve(`.whombat/shots/after-states-${theme}.png`));
      await page.goto(base + `index.html?theme=${theme}`);
      await page.evaluate(() => document.fonts.ready);
      const measure = await page.evaluate(contrast + '\nmeasureContrast()');
      if (measure.failures.length) report.errors.push('Gallery contrast: ' + theme);
      await page.selectOption('#platform','ios');
      const gap = await page.locator('#native-gap').isVisible();
      await page.selectOption('#screen','automations');
      const frame = page.frameLocator('#after-frame');
      await frame.getByText('Suspected bug',{exact:true}).waitFor();
      report.interactions.push({name:`Gallery switching and native GAP: ${theme}`,pass:gap});
      if (!gap) report.errors.push('Native evidence gap missing');
    }
    await context.close();
    await writeFile(resolve(out,'verification.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({renders:report.renders.length,interactions:report.interactions.length,errors:report.errors},null,2));
    if (report.errors.length) process.exitCode = 1;
  }
} finally { await browser.close(); }
