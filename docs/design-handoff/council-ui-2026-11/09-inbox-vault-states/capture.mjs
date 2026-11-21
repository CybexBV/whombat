import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, settle } from '../../../../apps/web/visual/support/harness.ts';
import { agentWords, theAgentOf } from '../../../../packages/client/src/agentName.ts';
import { needsYouListView } from '../../../../packages/client/src/home/needsYouList.ts';
const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const out = fileURLToPath(new URL('.', import.meta.url));
const browser = await chromium.launch({args:['--disable-lcd-text']});
await mkdir(resolve(out,'png'),{recursive:true});
await mkdir(resolve('.whombat/shots'),{recursive:true});
const capture = async (page,name) => {
  await page.screenshot({path:resolve(out,'png',name+'.png'),animations:'disabled'});
  await copyFile(resolve(out,'png',name+'.png'),resolve('.whombat/shots',name+'.png'));
};
try {
  let fixture;
  for (const theme of ['light','dark']) {
    const context = await browser.newContext({locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,reducedMotion:'reduce'});
    const page = await context.newPage();
    const base = process.env.CAPTURE_URL || 'http://127.0.0.1:5299';
    await openApp(page,{path:base+'/inbox',theme});
    await settle(page,0);
    await page.locator('[data-needs-you-group]').first().waitFor();
    const data = await page.evaluate(() => {
      const get = endpoint => window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({queryKey:['whombat',endpoint]}).find(q=>q.state.data)?.state.data;
      return {home:get('home.overview'),bootstrap:get('conversations.bootstrap'),inboxText:document.querySelector('[data-screen="inbox"]').innerText};
    });
    if (!fixture) {
      const words = agentWords(theAgentOf(data.bootstrap.principals)?.name);
      fixture = {...data,assistant:words.name,view:needsYouListView(data.home,{now:Date.parse('2026-09-23T09:22:00Z'),timeZone:'Europe/Amsterdam',assistant:words.name})};
    }
    await capture(page,`before-inbox-normal-${theme}`);
    await page.evaluate(() => {
      for (const q of window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({queryKey:['whombat','home.overview']})) q.setState({data:undefined,error:new Error('The fixture read did not answer.'),status:'error',fetchStatus:'idle'});
    });
    await page.getByText('The Inbox couldn’t load. Try again.').waitFor();
    await capture(page,`before-inbox-error-${theme}`);
    await page.goto(base+'/vault');
    await settle(page,0);
    await page.locator('[data-entry]').first().waitFor();
    if(theme==='light') fixture.vault = await page.evaluate(() => {
      const entries = window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({queryKey:['whombat','vault.list']}).find(q=>q.state.data)?.state.data;
      return {entries,text:document.querySelector('[data-screen="vault"]').innerText,rows:[...document.querySelectorAll('[data-entry]')].map(el=>({id:el.dataset.entry,text:el.innerText}))};
    });
    await capture(page,`before-vault-normal-${theme}`);
    await page.locator('[data-entry="vlt_grafana"] > button').click();
    await page.getByText('Read-only dashboards for billing-api. Use the “Billing” folder.').waitFor();
    if(theme==='light') fixture.entryText=await page.locator('[data-entry="vlt_grafana"]').innerText();
    await capture(page,`before-vault-open-${theme}`);
    await context.close();
  }
  await writeFile(resolve(out,'fixture.js'),'// Fixture snapshot; assistant obtained with the shared name helpers.\nconst FIXTURE = '+JSON.stringify(fixture,null,2)+';\n');
} finally {await browser.close();}
