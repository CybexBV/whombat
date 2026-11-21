// Matching review captures and shared-shell design observations only. No app tests or service.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=createRequire(resolve('apps/web/package.json'))('@playwright/test');
const {PNG}=createRequire(resolve('tools/visual/package.json'))('pngjs');
const base=resolve('docs/design-handoff/council-ui-2026-11/16-final'),out=resolve('.whombat/shots/round-four');
await mkdir(out,{recursive:true});
const phase=process.argv.includes('--before')?'before':'after';
const browser=await chromium.launch({args:['--allow-file-access-from-files','--disable-lcd-text']});
const records=[],errors=[];
async function capture(page,screen,platform,theme,extra={}) {
 const u=pathToFileURL(resolve(base,screen==='gallery'?'index.html':screen+'/mockup.html'));u.search=new URLSearchParams({platform,theme,...extra});
 await page.goto(u.href);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const suffix=Object.values(extra).join('-'),id=`${screen}-${platform}-${theme}${suffix?'-'+suffix:''}`,file=resolve(out,`${phase}-${id}.png`);
 const buffer=await page.screenshot({animations:'disabled',caret:'hide'});await writeFile(file,PNG.sync.write(PNG.sync.read(buffer),{deflateLevel:9}));
 records.push({screen,platform,theme,extra,id,file,view:`${screen==='chat-list'?'Chat':screen[0].toUpperCase()+screen.slice(1)} · ${platform} · ${theme}${suffix?' · '+suffix:''}`,observations:screen==='gallery'?{}:await page.evaluate(()=>({nativeBack:document.querySelector('.native-back')?.getAttribute('aria-label'),nativeTopLevelBars:document.querySelectorAll('.native-places-bar').length,settled:document.querySelector('[data-settled-count]')?.textContent,timeInput:document.querySelector('#brief-time')?{type:document.querySelector('#brief-time').type,value:document.querySelector('#brief-time').value}:null,chatActionGap:document.querySelector('.chat-tools')?getComputedStyle(document.querySelector('.chat-tools')).gap:null,healthDot:document.querySelector('.subject .stage-dot')?getComputedStyle(document.querySelector('.subject .stage-dot')).backgroundColor:null,waitingDot:document.querySelector('.waiting-chip .stage-dot,.thread-stage.wait .stage-dot')?getComputedStyle(document.querySelector('.waiting-chip .stage-dot,.thread-stage.wait .stage-dot')).backgroundColor:null,documentOverflow:document.documentElement.scrollWidth-innerWidth}))});
}
try {
 for(const platform of ['desktop','phoneweb','ios','android'])for(const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width:platform==='desktop'?1440:390,height:platform==='desktop'?900:844},locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push({platform,theme,error:error.message}));await page.clock.setFixedTime(new Date('2026-09-23T12:05:00Z'));
  for(const screen of ['chat-list','thread','approval','inbox','overview','connection','server','automations','settings','vault','files','usage'])await capture(page,screen,platform,theme);
  if(platform!=='desktop')await capture(page,'chat-list',platform,theme,{places:'open'});
  await capture(page,'settings',platform,theme,{view:'brief'});await capture(page,'settings',platform,theme,{view:'brief',dialog:'time'});
  if(platform==='desktop')await capture(page,'gallery',platform,theme);
  if(phase==='after'&&platform!=='desktop') {
   const u=pathToFileURL(resolve(base,'chat-list/mockup.html'));u.search=new URLSearchParams({platform,theme,places:'open',placesScroll:'things'});await page.goto(u.href);await page.evaluate(()=>document.fonts.ready);
   await page.screenshot({path:resolve(base,`png/${platform}-places-things-${theme}.png`),animations:'disabled',caret:'hide'});
  }
  await page.close();console.log(`${phase}: ${platform} ${theme}`);
 }
} finally {await browser.close();await writeFile(resolve(out,`${phase}-manifest.json`),JSON.stringify(records,null,2)+'\n');await writeFile(resolve(out,`${phase}-errors.json`),JSON.stringify(errors,null,2)+'\n');}
console.log(JSON.stringify({captures:records.length,errors}));
