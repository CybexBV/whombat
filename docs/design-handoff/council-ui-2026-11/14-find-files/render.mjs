// Render static design evidence, not a test runner. Run from repository root.
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const require=createRequire(resolve('apps/web/package.json'));const {chromium}=require('@playwright/test');
const out=resolve('docs/design-handoff/council-ui-2026-11/14-find-files');const shots=resolve('.whombat/shots');
const contrast=await readFile(resolve(out,'../01-groundwork/contrast.js'),'utf8');
const browser=await chromium.launch({args:['--disable-lcd-text']});const records=[];
await mkdir(shots,{recursive:true});
async function render(screen,platform,theme,extra={}){
 const width=platform==='web'?1440:390,height=platform==='web'?900:844;
 const context=await browser.newContext({viewport:{width,height},locale:'en-GB',timezoneId:'Europe/Amsterdam',reducedMotion:'reduce',deviceScaleFactor:1});const page=await context.newPage();
 await page.clock.setFixedTime(new Date('2026-09-23T09:22:00.000Z'));
 await page.goto(pathToFileURL(resolve(out,platform==='phone'&&['inbox','vault'].includes(screen)?'phone-states.html':'mockup.html')).href+'?'+new URLSearchParams({screen,platform,theme,...extra}));
 await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
 await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))));
 const suffix=extra.state||extra.q||extra.text||'ready';const name=`14-after-${platform}-${screen}-${suffix}-${theme}.png`;
 await page.screenshot({path:resolve(shots,name),animations:'disabled',caret:'hide'});
 const measure=await page.evaluate(contrast+'\nmeasureContrast()');
 records.push({screen,platform,theme,...extra,file:name,measure});
 if(platform==='web')await copyFile(resolve(shots,name),resolve(out,'png',`after-web-${screen}-${theme}.png`));
 await context.close();return name;
}
async function sheet(name,theme,items){
 const context=await browser.newContext({viewport:{width:390*items.length,height:880},deviceScaleFactor:1});const page=await context.newPage();
 const html=`<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="${pathToFileURL(resolve('packages/tokens/tokens.css'))}"><link rel="stylesheet" href="${pathToFileURL(resolve('apps/web/src/app/fonts/fonts.css'))}"><style>*{box-sizing:border-box}body{margin:0;display:flex;background:var(--bg);color:var(--ink);font:14px var(--font-sans)}figure{margin:0;width:390px}figcaption{height:36px;padding:8px 16px;background:var(--sf2)}img{display:block;width:390px;height:844px}</style></head><body>${items.map(([label,file])=>`<figure><figcaption>${label} · ${theme}</figcaption><img src="${pathToFileURL(resolve(shots,file))}" alt="${label}"></figure>`).join('')}</body></html>`;
 const file=resolve(shots,`14-${name}-${theme}.html`);await writeFile(file,html);await page.goto(pathToFileURL(file).href);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));await page.screenshot({path:resolve(out,'png',`after-${name}-${theme}.png`),animations:'disabled'});await context.close();
}
for(const theme of ['light','dark']){
 for(const screen of ['search','usage'])await render(screen,'web',theme);
 for(const platform of ['phone','ios','android']){
  const states=[];for(const state of ['ready','loading','empty','failed'])states.push([state,await render('files',platform,theme,{state})]);await sheet(`${platform}-files-states`,theme,states);
 }
 const phone=[];for(const screen of ['search','usage','inbox','vault','settings'])phone.push([screen,await render(screen,'phone',theme)]);await sheet('phone-pages',theme,phone);
 for(const screen of ['search','usage']){const items=[];for(const platform of ['ios','android'])items.push([`${platform} · ${screen}`,await render(screen,platform,theme)]);await sheet(`native-${screen}`,theme,items);}
 const local=[];for(const [label,q,state]of[['Settings · Vault','vault','ready'],['Things · home','home','ready'],['Things · unavailable','home','unloaded']])local.push([label,await render('search','ios',theme,{q,state})]);await sheet('local-search',theme,local);
 const nav=[];for(const platform of ['phone','ios','android'])nav.push([`${platform} · Chat`,await render('chat',platform,theme)]);await sheet('navigation',theme,nav);
 const task=[];for(const screen of ['automations','automation','run','brief-request'])task.push([screen,await render(screen,'ios',theme)]);await sheet('find-tasks',theme,task);
 const large=[];for(const screen of ['search','files','usage','inbox','vault'])large.push([screen+' · 200%',await render(screen,'phone',theme,{text:'largest'})]);await sheet('largest-text',theme,large);
}
await writeFile(resolve(out,'render.json'),JSON.stringify(records.map(r=>({...r,measure:{minimum:r.measure.minimum,failures:r.measure.failures,pairs:r.measure.pairs}})),null,2)+'\n');
await browser.close();
