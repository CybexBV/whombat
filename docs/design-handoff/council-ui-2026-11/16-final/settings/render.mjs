// Chromium screenshot production and contrast measurements only. No application tests or CI.
import {readFile,writeFile,copyFile,mkdir,access} from 'node:fs/promises';
import {createRequire} from 'node:module';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const require=createRequire(resolve('apps/web/package.json'));const {chromium}=require('@playwright/test');
const root=resolve('docs/design-handoff/council-ui-2026-11/16-final'),shots=resolve('.whombat/shots');
const contrast=await readFile(resolve(root,'../01-groundwork/contrast.js'),'utf8');
const browser=await chromium.launch({args:['--disable-lcd-text']});const records=[];
const platforms=['desktop','phoneweb','ios','android'],screens=['settings','vault','files','usage'];
await mkdir(shots,{recursive:true});
async function render(screen,platform,theme,extra={}) {
 const width=platform==='desktop'?1440:390,height=platform==='desktop'?900:844;
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,locale:'en-GB',timezoneId:'Europe/Amsterdam',reducedMotion:'reduce'});const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.setFixedTime(new Date('2026-09-23T12:05:00.000Z'));
 await page.goto(pathToFileURL(resolve(root,screen,'mockup.html')).href+'?'+new URLSearchParams({platform,theme,...extra}));
 await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
 if(extra.scroll==='end')await page.locator('#main').evaluate(el=>el.scrollTop=el.scrollHeight);
 if(extra.scroll==='more')await page.locator('#usage-more').evaluate(el=>el.scrollIntoView({block:'start'}));
 const suffix=Object.values(extra).join('-')||'normal';const file=`final-after-${screen}-${platform}-${theme}-${suffix}.png`;
 await page.screenshot({path:resolve(shots,file),animations:'disabled',caret:'hide'});
 const measure=await page.evaluate(contrast+'\nmeasureContrast()');
 const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,fonts:document.fonts.check('400 16px "Bricolage Grotesque"')&&document.fonts.check('400 12px "DM Mono"'),smallTargets:[...document.querySelectorAll('button,a,summary')].filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.top<innerHeight&&(!el.closest('dialog')||el.closest('dialog').open)&&(r.height<(document.body.dataset.platform==='android'?48:44)||r.width<(document.body.dataset.platform==='android'?48:44))}).map(el=>({label:el.getAttribute('aria-label')||el.textContent.trim(),height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width}))}));
 records.push({screen,platform,theme,...extra,file,errors,geometry,contrast:{minimum:measure.minimum,failures:measure.failures,pairs:measure.pairs}});
 await context.close();return {file,width,height};
}
async function sheet(screen,theme,name,items) {
 const width=items[0].width;const context=await browser.newContext({viewport:{width:width*items.length,height:items[0].height+36},deviceScaleFactor:1});const page=await context.newPage();
 const html=`<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="${pathToFileURL(resolve('packages/tokens/tokens.css'))}"><link rel="stylesheet" href="${pathToFileURL(resolve('apps/web/src/app/fonts/fonts.css'))}"><style>*{box-sizing:border-box}body{margin:0;display:flex;background:var(--bg);color:var(--ink);font:14px var(--font-sans)}figure{margin:0;width:${width}px}figcaption{height:36px;padding:8px 16px;background:var(--sf2)}img{display:block;width:${width}px}</style></head><body>${items.map(item=>`<figure><figcaption>${item.label} · ${theme}</figcaption><img src="${pathToFileURL(resolve(shots,item.file))}" alt="${item.label}"></figure>`).join('')}</body></html>`;
 const source=resolve(shots,`${screen}-${name}-${theme}.html`);await writeFile(source,html);await page.goto(pathToFileURL(source).href);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));await page.screenshot({path:resolve(root,screen,'png',`${name}-${theme}.png`)});await context.close();
}
if(!process.argv.includes('--extras'))for(const screen of screens)for(const theme of ['light','dark']) {
 for(const platform of platforms){
  const result=await render(screen,platform,theme);await copyFile(resolve(shots,result.file),resolve(root,screen,`${platform}-${theme}.png`));
  const before=resolve(root,screen,'png',`before-${platform}-${theme}.png`);
  try{await copyFile(resolve(shots,`final-before-${screen}-${platform}-${theme}.png`),before);}catch(error){if(error.code!=='ENOENT')throw error;await access(before);} // Fresh checkouts keep the committed before evidence.
  const states=[];for(const state of ['loading','empty','failed'])states.push({...await render(screen,platform,theme,{state}),label:state==='failed'?'Couldn’t read':state});
  await sheet(screen,theme,`${platform}-states`,states);
 }
 const desktopLarge=await render(screen,'desktop',theme,{text:'largest'});await copyFile(resolve(shots,desktopLarge.file),resolve(root,screen,'png',`desktop-largest-${theme}.png`));
 const large=[];for(const platform of platforms.filter(p=>p!=='desktop'))large.push({...await render(screen,platform,theme,{text:'largest'}),label:platform==='phoneweb'?'Web · 200%':platform+' · 1.6×'});
 await sheet(screen,theme,'largest-text',large);
}
for(const theme of ['light','dark']){
 const brief=[];for(const platform of ['phoneweb','ios','android'])for(const [label,extra]of[['Search',{view:'search'}],['Evening brief',{view:'brief'}],['Change time',{view:'brief',dialog:'time'}]])brief.push({...await render('settings',platform,theme,extra),label:`${platform} · ${label}`});
 // Three platform rows, three task steps per row, kept at readable phone scale.
 for(let i=0;i<3;i++)await sheet('settings',theme,`${platforms[i+1]}-brief-task`,brief.slice(i*3,i*3+3));
 for(const extra of [{view:'brief'},{view:'search'},{view:'brief',dialog:'time'}]){const r=await render('settings','desktop',theme,extra);await copyFile(resolve(shots,r.file),resolve(root,'settings','png',`desktop-${Object.values(extra).join('-')}-${theme}.png`));}
 const additions=[];for(const platform of ['phoneweb','ios','android'])additions.push({...await render('vault',platform,theme,{text:'largest',dialog:'add'}),label:platform+' · Add to Vault · largest'});await sheet('vault',theme,'add-largest',additions);
 const windowPhones=[],windowDesktop=[];for(const platform of platforms)for(const window of ['week','month']){const r=await render('usage',platform,theme,{window});(platform==='desktop'?windowDesktop:windowPhones).push({...r,label:platform+' · '+window});}await sheet('usage',theme,'desktop-windows',windowDesktop);await sheet('usage',theme,'phone-windows',windowPhones);
 const more=[];for(const platform of ['phoneweb','ios','android'])more.push({...await render('usage',platform,theme,{more:'open',scroll:'more'}),label:platform+' · More'});await sheet('usage',theme,'provider-coverage',more);
}
const previous=process.argv.includes('--extras')?JSON.parse(await readFile(resolve(root,'settings/render.json'),'utf8')):[];
const merged=[...new Map([...previous,...records].map(r=>[r.file,r])).values()];
await writeFile(resolve(root,'settings/render.json'),JSON.stringify(merged,null,2)+'\n');
await browser.close();
console.log(JSON.stringify({viewports:records.length,errors:records.filter(r=>r.errors.length),contrastFailures:records.filter(r=>r.contrast.failures.length).map(r=>({file:r.file,failures:r.contrast.failures})),overflow:records.filter(r=>r.geometry.overflow),smallTargets:records.filter(r=>r.geometry.smallTargets.length).map(r=>({file:r.file,targets:r.geometry.smallTargets})),minimum:{light:Math.min(...records.filter(r=>r.theme==='light').map(r=>r.contrast.minimum)),dark:Math.min(...records.filter(r=>r.theme==='dark').map(r=>r.contrast.minimum))}},null,2));
