// Fixture-only evidence. Never connects to a Whombat or sends a command.
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { openApp, settle, patchQueries } from '../../../../apps/web/visual/support/harness.ts';
import { agentWords, theAgentOf } from '../../../../packages/client/src/agentName.ts';

const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const out = new URL('.', import.meta.url);
const base = process.env.CAPTURE_URL || 'http://127.0.0.1:5283';
const frozen = '2026-09-23T09:22:00.000Z';
const browser = await chromium.launch({args:['--disable-lcd-text']});
const report = {frozen, captures:[], scenarios:{}, gaps:[]};
await mkdir('.whombat/shots/round2', {recursive:true});
let snapshot;
try {
  for (const theme of ['light','dark']) for (const width of [1440,390]) {
    const context = await browser.newContext({locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,reducedMotion:'reduce'});
    const page = await context.newPage();
    for (const [screen,path,endpoint,ready] of [
      ['overview','/connections','home.overview','blackbox'],
      ['server','/things/server%3Apve-02','hosts.getServer','Busiest machines'],
      ['automations','/automations','automations.list','Last run'],
    ]) {
      await openApp(page,{path:base+path,theme,width,height:width===390?844:900});
      await settle(page,0);
      await page.locator('main').first().getByText(ready,{exact:false}).first().waitFor();
      await patchQueries(page,'hosts.fleet',data=>({...data,servers:data.servers.map(s=>({...s,lastSeen:s.id==='the-falcon'?null:s.id==='blackbox'?'2026-09-23T09:10:00Z':s.id==='thetitan'?'2026-09-23T09:21:00Z':'2026-09-23T09:20:00Z'}))}),null);
      if (!snapshot) {
        snapshot = await page.evaluate(() => {
          const get = ep => window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({queryKey:['whombat',ep]}).find(q=>q.state.data)?.state.data;
          return {home:get('home.overview'),bootstrap:get('conversations.bootstrap'),fleet:get('hosts.fleet')};
        });
        snapshot.assistant=agentWords(theAgentOf(snapshot.bootstrap.principals)?.name).name;
        snapshot.frozen=frozen;
      }
      if(theme==='light'&&width===1440) {
        snapshot[screen]=await page.evaluate(ep=>window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({queryKey:['whombat',ep]}).find(q=>q.state.data)?.state.data,endpoint);
        if(screen==='server') snapshot.metrics=await page.evaluate(()=>window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({queryKey:['whombat','hosts.serverMetrics']}).find(q=>q.state.data)?.state.data);
        report.scenarios[screen]=await page.locator('main').first().innerText();
      }
      const name=`before-${width===390?'phone-web':'desktop'}-${screen}-${theme}`;
      const shot=new URL(`png/${name}.png`,out);
      await page.screenshot({path:shot.pathname,animations:'disabled'});
      await copyFile(shot,new URL(`../../../../.whombat/shots/round2/${name}.png`,out));
      report.captures.push({screen,theme,width,height:width===390?844:900,file:`png/${name}.png`,state:'normal'});
      // The failed read keeps the exact same cache. It is never a failed action.
      await page.evaluate(ep=>{
        for(const q of window.__WHOMBAT__.services.queryClient.getQueryCache().findAll({queryKey:['whombat',ep]})) q.setState({error:new Error('The fixture read did not answer.'),status:'error',fetchStatus:'idle'});
      },endpoint);
      report.scenarios[screen+'-read']=await page.locator('main').first().innerText();
      if(width===390) {
        const errorName=`before-phone-web-${screen}-read-${theme}`;
        await page.screenshot({path:new URL(`png/${errorName}.png`,out).pathname,animations:'disabled'});
        report.captures.push({screen,theme,width,height:844,file:`png/${errorName}.png`,state:'read'});
      }
    }
    await context.close();
  }
  const {assistant,frozen:moment,home,fleet,server,metrics,automations}=snapshot;
  await writeFile(new URL('web-fixture.json',out),JSON.stringify({assistant,frozen:moment,home:{summary:home.summary},fleet,server,metrics,automations},null,2)+'\n');
  await writeFile(new URL('before.json',out),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({pictures:report.captures.length,assistant:snapshot.assistant,servers:snapshot.fleet?.servers?.map(s=>({id:s.id,lastSeen:s.lastSeen})),serverKeys:Object.keys(snapshot.server??{})}));
} finally {await browser.close();}
