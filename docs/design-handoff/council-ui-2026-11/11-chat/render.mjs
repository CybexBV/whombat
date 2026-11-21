// Render the requested design pictures and record their colors. No app test suite.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=createRequire(resolve('apps/web/package.json'))('@playwright/test');
const {PNG}=createRequire(resolve('tools/visual/package.json'))('pngjs');
const dir=resolve('docs/design-handoff/council-ui-2026-11/11-chat');
const url=pathToFileURL(dir+'/mockup.html').href;
const contrast=await readFile(dir+'/../01-groundwork/contrast.js','utf8');
const browser=await chromium.launch({args:['--disable-lcd-text']});
const report={browser:browser.version(),kind:'Static mockup render and color measurements; no application tests',renders:[],errors:[]};
await mkdir(dir+'/png',{recursive:true});
async function compress(file){const png=PNG.sync.read(await readFile(file));await writeFile(file,PNG.sync.write(png,{deflateLevel:9}));}
async function pair(files,out){const sources=await Promise.all(files.map(async f=>PNG.sync.read(await readFile(f))));const target=new PNG({width:sources.reduce((n,s)=>n+s.width,0),height:Math.max(...sources.map(s=>s.height))});let x=0;for(const s of sources){PNG.bitblt(s,target,0,0,s.width,s.height,x,0);x+=s.width;}await writeFile(out,PNG.sync.write(target,{deflateLevel:9}));}
try{
for(const theme of ['light','dark']){
 for(const platform of ['desktop','phone-web','ios','android']){
  const width=platform==='desktop'?1440:390,height=platform==='desktop'?900:844;
  const context=await browser.newContext({viewport:{width,height},locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,colorScheme:theme,reducedMotion:'reduce'});
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push({platform,theme,error:e.message}));
  const files=[];
  for(const screen of ['chat','thread']){
   await page.goto(`${url}?platform=${platform}&theme=${theme}&screen=${screen}`);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const file=resolve(`.whombat/shots/11-after-${platform}-${screen}-${theme}.png`);
   await page.screenshot({path:file,animations:'disabled',caret:'hide'});await compress(file);files.push(file);
   if(platform==='desktop')await copyFile(file,`${dir}/png/desktop-${screen}-${theme}.png`);
   const sections=await page.evaluate(()=>{const s=document.querySelector('.stream');return s?[s.scrollHeight,s.clientHeight]:[0,0]});
   const measurements=[];
   for(let y=0;y<sections[0];y+=Math.max(200,sections[1]-100)){
    await page.evaluate(y=>{document.querySelector('.stream').scrollTop=y},y);
    measurements.push(await page.evaluate(contrast+'\nmeasureContrast()'));
   }
   report.renders.push({platform,theme,screen,state:'normal',viewport:[width,height],minimum:Math.min(...measurements.map(m=>m.minimum)),pairs:[...new Map(measurements.flatMap(m=>m.pairs).map(p=>[JSON.stringify([p.foreground,p.background]),p])).values()],failures:measurements.flatMap(m=>m.failures),text:await page.locator('body').innerText()});
   if(screen==='thread'){
    await page.goto(`${url}?platform=${platform}&theme=${theme}&screen=thread&text=largest`);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const stream=page.locator('.stream');await stream.evaluate(e=>e.scrollTop=e.scrollHeight);
    await page.screenshot({path:resolve(`.whombat/shots/11-largest-${platform}-thread-${theme}.png`),animations:'disabled',caret:'hide'});
    report.renders.push({platform,theme,screen:'thread',textSize:'largest',overflow:await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),measure:await page.evaluate(contrast+'\nmeasureContrast()')});
   }
  }
  if(platform!=='desktop')await pair(files,`${dir}/png/${platform}-pair-${theme}.png`);
  if(platform==='phone-web'){await page.goto(`${url}?platform=phone-web&theme=${theme}&menu=open`);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`${dir}/png/phone-web-actions-${theme}.png`,animations:'disabled',caret:'hide'});await compress(`${dir}/png/phone-web-actions-${theme}.png`);report.renders.push({platform,theme,screen:'message-actions',measure:await page.evaluate(contrast+'\nmeasureContrast()')});}
  // A phone read-failure picture is local evidence, alongside the shared state sheet.
  await page.goto(`${url}?platform=${platform}&theme=${theme}&screen=thread&state=error`);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.screenshot({path:resolve(`.whombat/shots/11-error-${platform}-thread-${theme}.png`),animations:'disabled',caret:'hide'});
  report.renders.push({platform,theme,screen:'thread',state:'error',measure:await page.evaluate(contrast+'\nmeasureContrast()')});
  await context.close();
 }
 for(const screen of ['states','stages']){
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>report.errors.push({theme,screen,error:e.message}));
  await page.goto(`${url}?screen=${screen}&theme=${theme}`);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.screenshot({path:`${dir}/png/${screen}-${theme}.png`,animations:'disabled',caret:'hide'});await compress(`${dir}/png/${screen}-${theme}.png`);
  report.renders.push({theme,screen,measure:await page.evaluate(contrast+'\nmeasureContrast()')});await page.close();
 }
 console.log(`Rendered ${theme} Chat, threads, large text, read failures and component sheets.`);
}
}finally{await browser.close();await writeFile(dir+'/renders.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({errors:report.errors,renders:report.renders.length}));
