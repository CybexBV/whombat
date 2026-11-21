// PNG production and requested colour measurements only. No CI or application tests.
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const {chromium}=createRequire(resolve('apps/web/package.json'))('@playwright/test');
const {PNG}=createRequire(resolve('tools/visual/package.json'))('pngjs');
const dir=resolve('docs/design-handoff/council-ui-2026-11/16-final');
const shots=resolve('.whombat/shots/16-final');
const contrast=await readFile(resolve(dir,'../01-groundwork/contrast.js'),'utf8');
const controlColours=await readFile(resolve(dir,'colour-pairs.js'),'utf8');
const browser=await chromium.launch({args:['--disable-lcd-text']});
const evidence={kind:'Static mockup PNG rendering and colour observations; no tests',browser:browser.version(),renders:[],pageErrors:[]};
await mkdir(shots,{recursive:true});
const compress=async file=>writeFile(file,PNG.sync.write(PNG.sync.read(await readFile(file)),{deflateLevel:9}));
async function ready(page) {await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
try {
 for(const platform of ['desktop','phoneweb','ios','android'])for(const theme of ['light','dark']) {
  const context=await browser.newContext({viewport:{width:platform==='desktop'?1440:390,height:platform==='desktop'?900:844},locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,colorScheme:theme,reducedMotion:'reduce'});
  const page=await context.newPage();page.on('pageerror',e=>evidence.pageErrors.push({platform,theme,error:e.message}));
  await page.clock.install({time:new Date('2026-09-23T12:05:00.000Z')});
  const url=pathToFileURL(dir+'/chat-list/mockup.html');
  const render=async(state,extra={})=>{url.search=new URLSearchParams({platform,theme,state,...extra});await page.goto(url.href);await ready(page);};
  for(const state of ['normal','loading','empty','failed','saved-failed']) {
   await render(state);
   const file=resolve(dir,'chat-list',`${platform}${state==='normal'?'':'-'+state}-${theme}.png`);
   await page.screenshot({path:file,animations:'disabled',caret:'hide'});await compress(file);
   if(state==='normal')await copyFile(file,resolve(shots,`after-chat-list-${platform}-${theme}.png`));
   evidence.renders.push({platform,theme,state,viewport:page.viewportSize(),file:file.slice(dir.length+1),colours:await page.evaluate(contrast+'\nmeasureContrast()'),controlPairs:await page.evaluate(controlColours+'\nmeasureControlPairs()'),geometry:await page.evaluate(()=>({pageOverflow:document.documentElement.scrollWidth-innerWidth,mainClientHeight:document.querySelector('#main').clientHeight,mainScrollHeight:document.querySelector('#main').scrollHeight}))});
  }
  await render('normal',{text:'largest'});
  await page.screenshot({path:resolve(shots,`largest-${platform}-${theme}.png`),animations:'disabled',caret:'hide'});
  evidence.renders.push({platform,theme,state:'normal',text:'largest',colours:await page.evaluate(contrast+'\nmeasureContrast()'),controlPairs:await page.evaluate(controlColours+'\nmeasureControlPairs()'),geometry:await page.evaluate(()=>({pageOverflow:document.documentElement.scrollWidth-innerWidth}))});
  await render('normal');
  if(platform!=='desktop') {
   await page.locator('[data-open-places]').click();await ready(page);
   const file=resolve(dir,`png/${platform}-places-${theme}.png`);await page.screenshot({path:file,animations:'disabled',caret:'hide'});await compress(file);
   await copyFile(file,resolve(shots,`after-shell-${platform}-${theme}.png`));
   evidence.renders.push({platform,theme,state:'places-open',colours:await page.evaluate(contrast+'\nmeasureContrast()'),controlPairs:await page.evaluate(controlColours+'\nmeasureControlPairs()'),focus:await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),order:await page.locator('#places-menu nav a').allTextContents()});
  } else {await page.screenshot({path:resolve(shots,`after-shell-${platform}-${theme}.png`),animations:'disabled',caret:'hide'});}
  try {await access(resolve(shots,`before-chat-list-${platform}-${theme}.png`));await copyFile(resolve(shots,`before-chat-list-${platform}-${theme}.png`),resolve(dir,`chat-list/before-${platform}-${theme}.png`));await compress(resolve(dir,`chat-list/before-${platform}-${theme}.png`));} catch { /* Re-rendering a fresh checkout retains its committed before evidence. */ }
  await context.close();
  console.log(`Rendered ${platform} ${theme}: Chat and four read states, largest text and shared shell.`);
 }
 for(const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto(pathToFileURL(resolve(dir,'../index.html')).href);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await ready(page);await page.screenshot({path:resolve(shots,`after-gallery-${theme}.png`)});
  await page.goto(pathToFileURL(resolve(dir,'index.html')).href+'?theme='+theme);await ready(page);await page.screenshot({path:resolve(shots,`final-gallery-${theme}.png`)});await page.close();
 }
} finally {await browser.close();await writeFile(resolve(dir,'renders.json'),JSON.stringify(evidence,null,2)+'\n');}
console.log(JSON.stringify({renderObservations:evidence.renders.length,pageErrors:evidence.pageErrors}));
