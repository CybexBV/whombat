// Fresh web before capture; native before is the unchanged step 08 evidence.
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {openApp,settle} from '../../../../apps/web/visual/support/harness.ts';
const {chromium}=createRequire(resolve('apps/web/package.json'))('@playwright/test');
const browser=await chromium.launch({args:['--disable-lcd-text']});
const records=[];
try{
for(const [platform,width,height] of [['desktop',1440,900],['phone-web',390,844]])for(const theme of ['light','dark'])for(const [screen,path] of [['chat','/chat'],['thread','/chat?thread=msg_chat-pve-memory']]){
 const context=await browser.newContext({locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,reducedMotion:'reduce'});
 const page=await context.newPage();
 await page.addInitScript(()=>localStorage.setItem('whombat:fixture-looks','1'));
 await openApp(page,{path:(process.env.CAPTURE_URL||'http://127.0.0.1:5307')+path,theme,width,height});
 await page.waitForFunction(()=>window.__WHOMBAT__?.services.queryClient.isFetching()===0);
 await settle(page,0);
 await page.evaluate(()=>{for(const el of document.querySelectorAll('body *'))if(el.scrollHeight>el.clientHeight&&/auto|scroll/.test(getComputedStyle(el).overflowY))el.scrollTop=0;});
 const file=`.whombat/shots/11-before-${platform}-${screen}-${theme}.png`;
 await page.screenshot({path:file,animations:'disabled',caret:'hide'});
 const queries=await page.evaluate(()=>window.__WHOMBAT__.services.queryClient.getQueryCache().getAll().map(q=>({key:q.queryKey,data:q.state.data})).filter(q=>q.data));
 records.push({platform,theme,screen,file,queries,text:await page.locator('body').innerText()});
 console.log(file);await context.close();
}
for(const platform of ['ios','android'])for(const theme of ['light','dark'])for(const screen of ['chat','thread']){
 const source=`docs/design-handoff/council-ui-2026-11/08-native-capture/png/${platform}-${screen==='chat'?'chat-list':'thread'}-${theme}.png`;
 await copyFile(source,`.whombat/shots/11-before-${platform}-${screen}-${theme}.png`);
}
await writeFile('.whombat/chat-before.json',JSON.stringify(records,null,2)+'\n');
}finally{await browser.close();}
