// PNG production and requested design observations only. No lint, tests, CI or app build.
import {readFile,writeFile,mkdir,copyFile,access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const here=resolve('docs/design-handoff/council-ui-2026-11/16-final'),shots=resolve('.whombat/shots/16-part2');
const {chromium}=createRequire(resolve('apps/web/package.json'))('@playwright/test');
const {PNG}=createRequire(resolve('tools/visual/package.json'))('pngjs');
const contrast=await readFile(resolve(here,'../01-groundwork/contrast.js'),'utf8');
const pairs=(await readFile(resolve(here,'colour-pairs.js'),'utf8')).replace(".send'", ".send,button,.button,.label,.wait'").replace("if(!el.getClientRects().length)continue;", "if(!el.getClientRects().length)continue;const dialog=document.querySelector('dialog[open]');if(dialog&&!dialog.contains(el))continue;");
const browser=await chromium.launch({args:['--allow-file-access-from-files','--disable-lcd-text']});
const evidence=Object.fromEntries(['approval','inbox'].map(s=>[s,{kind:'Static drawings, not native screenshots or tests',renders:[],pageErrors:[]}]));
await mkdir(shots,{recursive:true});
const compress=async file=>{const b=await readFile(file),p=PNG.sync.write(PNG.sync.read(b),{deflateLevel:9,filterType:-1});if(p.length<b.length)await writeFile(file,p);};
const ready=async page=>{for(const frame of page.frames()){await frame.evaluate(()=>document.fonts.ready);await frame.waitForFunction(()=>!document.querySelector('#app')||document.documentElement.dataset.ready==='true');await frame.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}};
async function observations(page,params){
 const samples=[];
 const outerScroll=await page.locator('dialog[open]').evaluateAll(ds=>ds.some(d=>getComputedStyle(d).overflowY==='auto'&&d.scrollHeight>d.clientHeight));
 const scroller=outerScroll?page.locator('dialog[open]'):page.locator('dialog[open] .primary-approval-content,dialog[open] .sheet-content,.native-approval .sheet-content,#main').last();
 const current=await scroller.evaluate(el=>el.scrollTop);
 for(const fraction of [0,.5,1]){
  await scroller.evaluate((el,f)=>el.scrollTop=(el.scrollHeight-el.clientHeight)*f,fraction);
  samples.push({fraction,colours:await page.evaluate(contrast+'\nmeasureContrast()')});
 }
 await scroller.evaluate((el,x)=>el.scrollTop=x,current);
 return {params,viewport:page.viewportSize(),samples:samples.map(({fraction,colours})=>({fraction,minimum:colours.minimum,count:colours.count,failures:colours.failures})),pairs:[...new Map(samples.flatMap(s=>s.colours.pairs).map(p=>[JSON.stringify([p.foreground,p.background,p.fontSize]),p])).values()],controlPairs:await page.evaluate(pairs+'\nmeasureControlPairs()'),geometry:await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,mainHeight:document.querySelector('#main').clientHeight,mainScrollHeight:document.querySelector('#main').scrollHeight,answers:[...document.querySelectorAll('dialog[open] .answer-buttons button,.native-approval .answer-buttons button,.row-answers button')].map(b=>({words:b.textContent,rect:b.getBoundingClientRect().toJSON()}))})),words:await page.locator('body').innerText()};
}
try{
 for(const screen of ['approval','inbox'])for(const platform of ['desktop','phoneweb','ios','android'])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:platform==='desktop'?1440:390,height:platform==='desktop'?900:844},locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,reducedMotion:'reduce',colorScheme:theme});
  const page=await context.newPage();await page.clock.install({time:new Date('2026-09-23T12:05:00.000Z')});page.on('pageerror',e=>evidence[screen].pageErrors.push({platform,theme,error:e.message}));page.on('requestfailed',r=>evidence[screen].pageErrors.push({platform,theme,url:r.url(),error:r.failure()?.errorText}));
  const draw=async(extra={})=>{const url=pathToFileURL(resolve(here,screen,'mockup.html'));url.search=new URLSearchParams({platform,theme,...extra});await page.goto(url.href);await ready(page);};
  const picture=async(name,extra={})=>{await draw(extra);const file=resolve(here,screen,`${name}-${theme}.png`);await page.screenshot({path:file,animations:'disabled',caret:'hide'});await compress(file);return file;};
  for(const state of ['normal','loading','empty','failed']){
   const file=await picture(`${platform}${state==='normal'?'':'-'+state}`,{state});
   evidence[screen].renders.push(await observations(page,{platform,theme,state}));
   if(state==='normal')await copyFile(file,resolve(shots,`after-${screen}-${platform}-${theme}.png`));
  }
  await draw({text:'largest',...(screen==='inbox'?{focus:'approval'}:{scroll:'end'})});
  await page.screenshot({path:resolve(shots,`${screen}-${platform}-largest-${theme}.png`),animations:'disabled'});evidence[screen].renders.push(await observations(page,{platform,theme,text:'largest'}));
  await draw({state:'saved-failed'});evidence[screen].renders.push(await observations(page,{platform,theme,state:'saved-failed'}));
  try{await access(resolve(shots,`before-${screen}-${platform}-${theme}.png`));await copyFile(resolve(shots,`before-${screen}-${platform}-${theme}.png`),resolve(here,screen,`before-${platform}-${theme}.png`));await compress(resolve(here,screen,`before-${platform}-${theme}.png`));}catch{}
  if(screen==='approval'){
   if(['desktop','phoneweb'].includes(platform)){await picture(`${platform}-card`,{surface:'card'});try{await copyFile(resolve(shots,`before-approval-${platform}-card-${theme}.png`),resolve(here,'approval',`before-${platform}-card-${theme}.png`));await compress(resolve(here,'approval',`before-${platform}-card-${theme}.png`));}catch{}}
   for(const kind of ['command','mail'])for(const surface of ['card','details']){
    const extra={kind,surface,length:'long',...(surface==='card'&&kind==='mail'?{technical:'open'}:{}),scroll:'end'};
    await draw(extra);evidence[screen].renders.push(await observations(page,{platform,theme,...extra}));
    if(platform==='phoneweb'){const file=resolve(here,screen,`${platform}-${kind}-${surface}-${theme}.png`);await page.screenshot({path:file,animations:'disabled'});await compress(file);}
    if(['ios','android'].includes(platform)&&surface==='details'){await draw({...extra,text:'largest'});await page.screenshot({path:resolve(shots,`${platform}-${kind}-largest-${theme}.png`)});evidence[screen].renders.push(await observations(page,{platform,theme,...extra,text:'largest'}));}
   }
   for(const state of ['answer-unknown','answer-never-sent']){await draw({state,kind:'command'});evidence[screen].renders.push(await observations(page,{platform,theme,kind:'command',state}));}
  }
  await context.close();console.log(`Rendered ${screen}: ${platform} ${theme}.`);
 }
 for(const screen of ['approval','inbox'])for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width:1440,height:900},locale:'en-GB',timezoneId:'Europe/Amsterdam'});await page.goto(pathToFileURL(resolve(here,'approval/proof.html')).href+`?screen=${screen}&theme=${theme}`);await ready(page);const file=resolve(here,screen,`reading-proof-${theme}.png`);await page.screenshot({path:file,animations:'disabled'});await compress(file);await page.close();
 }
 for(const screen of ['approval','inbox'])for(const theme of ['light','dark']){const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(pathToFileURL(resolve(here,screen,'index.html')).href+'?theme='+theme);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:resolve(shots,`review-${screen}-${theme}.png`)});await page.close();}
}finally{
 await browser.close();for(const [screen,result]of Object.entries(evidence))await writeFile(resolve(here,screen,'renders.json'),JSON.stringify(result,null,2)+'\n');
}
for(const [screen,result]of Object.entries(evidence))console.log(JSON.stringify({screen,renderObservations:result.renders.length,pageErrors:result.pageErrors,minimum:Math.min(...result.renders.flatMap(r=>r.samples.map(s=>s.minimum??100)))}));
