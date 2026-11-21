// Static PNG production and design measurements only. No CI or app checks.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=createRequire(resolve('apps/web/package.json'))('@playwright/test');
const {PNG}=createRequire(resolve('tools/visual/package.json'))('pngjs');
const root=resolve('docs/design-handoff/council-ui-2026-11/16-final'),dir=resolve(root,'search');
const shots=resolve('.whombat/shots/round-four');await mkdir(shots,{recursive:true});
const contrast=await readFile(resolve(root,'../01-groundwork/contrast.js'),'utf8');
const browser=await chromium.launch({args:['--allow-file-access-from-files','--disable-lcd-text']});
const record={kind:'Static mockup renders, not application tests',browser:browser.version(),renders:[],errors:[]};
const ready=async page=>{await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));};
try {
 for(const platform of ['desktop','phoneweb','ios','android'])for(const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width:platform==='desktop'?1440:390,height:platform==='desktop'?900:844},deviceScaleFactor:1,locale:'en-GB',timezoneId:'Europe/Amsterdam',colorScheme:theme,reducedMotion:'reduce'});
  page.on('pageerror',error=>record.errors.push({platform,theme,error:error.message}));
  for(const [name,params] of [['normal',{}],['empty',{state:'empty'}],['loading',{state:'loading'}],['no-results',{state:'no-results'}],['failed',{state:'failed'}],['largest',{text:'largest'}],['settings',{q:'Evening brief'}],['things',{q:'pve'}],['places',{q:'Files'}],['groups',{q:'e',focus:'Settings'}],...(['phoneweb','ios','android'].includes(platform)?['empty','loading','no-results','failed'].map(state=>['largest-'+state,{state,text:'largest'}]):[])]) {
   const url=pathToFileURL(resolve(dir,'mockup.html'));url.search=new URLSearchParams({platform,theme,...params});await page.goto(url.href);await ready(page);
   if(params.focus)await page.locator(`.result-group[aria-label="${params.focus}"]`).scrollIntoViewIfNeeded();
   const file=`${platform}-${theme}${name==='normal'?'':'-'+name}.png`;
   const buffer=await page.screenshot({animations:'disabled',caret:'hide'});await writeFile(resolve(dir,file),PNG.sync.write(PNG.sync.read(buffer),{deflateLevel:9}));
   const samples=[];
   for(const fraction of [0,.5,1]){await page.locator('#main').evaluate((el,f)=>el.scrollTop=(el.scrollHeight-el.clientHeight)*f,fraction);const c=await page.evaluate(contrast+'\nmeasureContrast()');samples.push({fraction,minimum:c.minimum,failures:c.failures});}
   record.renders.push({platform,theme,name,params,file,samples,geometry:await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,nativeBars:document.querySelectorAll('.native-places-bar').length,back:document.querySelector('.native-back')?.getAttribute('aria-label'),smallTargets:[...document.querySelectorAll('a,button,input')].filter(el=>el.getClientRects().length&&!el.closest('dialog:not([open])')&&!el.classList.contains('skip')).map(el=>({name:el.getAttribute('aria-label')||el.textContent.trim().slice(0,50),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})).filter(r=>r.width<(document.body.dataset.platform==='android'?48:44)||r.height<(document.body.dataset.platform==='android'?48:44))}))});
  }
  // Opening a real result: the saved Evening brief schedule, with Search as its previous title.
  const url=pathToFileURL(resolve(dir,'mockup.html'));url.search=new URLSearchParams({platform,theme,q:'Evening brief'});await page.goto(url.href);await ready(page);
  await page.getByRole('link',{name:'Evening brief Weekdays at 18:00 · Amsterdam'}).click();await ready(page);
  await page.screenshot({path:resolve(dir,`${platform}-${theme}-opened.png`),animations:'disabled',caret:'hide'});
  record.renders.push({platform,theme,name:'opened-result',url:page.url(),back:await page.locator('.native-back').count()?await page.locator('.native-back').getAttribute('aria-label'):null,text:await page.locator('#main').innerText()});
  await page.close();console.log(`Search: ${platform} ${theme}, states, largest text and opened result`);
 }
} finally {await browser.close();await writeFile(resolve(dir,'renders.json'),JSON.stringify(record,null,2)+'\n');}
console.log(JSON.stringify({errors:record.errors,below45:record.renders.flatMap(r=>(r.samples||[]).flatMap(s=>s.failures.map(f=>({file:r.file,...f})))),overflow:record.renders.filter(r=>r.geometry?.overflow),smallTargets:record.renders.filter(r=>r.geometry?.smallTargets.length)}));
