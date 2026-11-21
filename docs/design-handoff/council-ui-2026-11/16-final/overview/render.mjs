// Static PNG production and design measurements only. No CI or application tests.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const deps=resolve(process.env.WHOMBAT_RENDER_DEPS||'.');
const {chromium}=createRequire(resolve(deps,'apps/web/package.json'))('@playwright/test');
const {PNG}=createRequire(resolve(deps,'tools/visual/package.json'))('pngjs');
const base=resolve('docs/design-handoff/council-ui-2026-11/16-final');
const shots=resolve('.whombat/shots');await mkdir(shots,{recursive:true});
const contrast=await readFile(resolve(base,'../01-groundwork/contrast.js'),'utf8');
const controls=await readFile(resolve(base,'colour-pairs.js'),'utf8');
const platforms=['desktop','phoneweb','ios','android'],screens=['overview','server','connection'];
const evidence={purpose:'Round four static rendering, contrast and geometry observations. No application tests.',frozen:'2026-09-23T12:05:00.000Z',renders:[],errors:[],atlases:[]};
const browser=await chromium.launch({args:['--disable-lcd-text']});evidence.browser=browser.version();
const groups=new Map();
const add=(group,platform,row,buffer,label)=>{if(!groups.has(group))groups.set(group,[]);groups.get(group).push({platform,row,buffer,label});};
const compress=(file,buffer)=>writeFile(file,PNG.sync.write(PNG.sync.read(buffer),{deflateLevel:9}));
try{
 for(const platform of platforms)for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:platform==='desktop'?1440:390,height:platform==='desktop'?900:844},deviceScaleFactor:1,locale:'en-GB',timezoneId:'Europe/Amsterdam',colorScheme:theme,reducedMotion:'reduce'});
  const page=await context.newPage();page.on('pageerror',e=>evidence.errors.push({platform,theme,message:e.message}));
  await page.clock.install({time:new Date(evidence.frozen)});
  for(const screen of screens){
   async function render(label,params={}){
    const u=pathToFileURL(resolve(base,screen,'mockup.html'));u.search=new URLSearchParams({platform,theme,...params});await page.goto(u.href);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const buffer=await page.screenshot({animations:'disabled',caret:'hide'}),file=resolve(base,screen,`${platform}-${theme}${label==='normal'?'':'-'+label}.png`);await compress(file,buffer);
    const shot=resolve(shots,`after-${screen}-${platform}-${theme}${label==='normal'?'':'-'+label}.png`);await copyFile(file,shot);
    const colours=await page.evaluate(contrast+'\nmeasureContrast()');delete colours.text;delete colours.pairs;
    const detail=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,fonts:document.fonts.check('16px "Bricolage Grotesque"'),missingImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src),targets:[...document.querySelectorAll('button,a,summary,textarea')].filter(el=>!el.closest('dialog:not([open])')&&el.getClientRects().length&&!el.classList.contains('skip')&&getComputedStyle(el).visibility==='visible').map(el=>({name:el.getAttribute('aria-label')||el.textContent.trim().slice(0,90),width:Math.round(el.getBoundingClientRect().width),height:Math.round(el.getBoundingClientRect().height)}))}));
    const min=platform==='android'?48:44;detail.targetCount=detail.targets.length;detail.undersizedTargets=detail.targets.filter(t=>t.width<min||t.height<min);delete detail.targets;
    const observation={screen,platform,theme,label,params,file:`${screen}/${platform}-${theme}${label==='normal'?'':'-'+label}.png`,colours,controlPairs:await page.evaluate(controls+'\nmeasureControlPairs()'),...detail};evidence.renders.push(observation);
    return buffer;
   }
   await render('normal');
   if(process.env.RENDER_PROBE)continue;
   for(const [row,state] of ['loading','empty','failed','saved-failed'].entries())add(`${screen}/png/states-${theme}.png`,platform,row,await render(state,{state}),state);
   add(`${screen}/png/states-${theme}.png`,platform,4,await render('lower',{focus:'later',expand:'all'}),'lower page, disclosures open');
   add(`overview/png/largest-${theme}.png`,platform,screens.indexOf(screen),await render('largest',{text:'largest'}),`${screen}, largest text`);
   await render('largest-lower',{text:'largest',focus:'later',expand:'all'});
   if(screen==='overview'){
    for(const section of ['connections','pinned'])for(const [label,extra] of [['',{}],['-loading',{state:'loading'}],['-empty',{state:'empty'}],['-failed',{state:'failed'}],['-saved-failed',{state:'saved-failed'}],['-largest',{text:'largest'}]])await render(section+label,{section,...extra});
   }
   if(screen==='overview'){await render('pinned-widget',{section:'pinned',focus:'pinned'});await render('pinned-widget-saved-failed',{section:'pinned',focus:'pinned',state:'saved-failed'});}
   if(screen==='server'){
    for(const [row,[label,params]] of [['blackbox',{server:'blackbox'}],['unknown',{server:'the-falcon'}],['facts',{server:'pve-02',expand:'all'}],['blackbox-saved',{server:'blackbox',state:'saved-failed'}]].entries())add(`server/png/story-${theme}.png`,platform,row,await render(label,params),label);
    for(const id of ['pve-01','thetitan'])await render(id,{server:id});
    for(const tab of ['machines','backups','history']){await render(tab,{tab});await render(tab+'-largest',{tab,text:'largest'});}
   }
   if(screen==='connection')for(const [row,[label,params]] of [['controls',{focus:'controls'}],['heads-ups',{expand:'all',focus:'later'}]].entries())add(`connection/png/expanded-${theme}.png`,platform,row,await render(label,params),label);
  }
  await context.close();console.log(`Rendered ${platform} ${theme}: Overview, server and connection${process.env.RENDER_PROBE?'':', states, tabs, history and largest text'}.`);
 }
 for(const [file,items] of groups){
  const isLargest=file.includes('/largest-'),rowHeight=948,width=2690,columnX=[16,1472,1878,2284];
  const atlas=new PNG({width,height:(isLargest?4:Math.max(...items.map(i=>i.row))+1)*rowHeight+16});atlas.data.fill(0);
  // The prior atlas also includes the separately owned Automations drawing. Keep its pixels.
  if(isLargest){const old=PNG.sync.read(await readFile(resolve(base,file)));if(old.height>=atlas.height)PNG.bitblt(old,atlas,0,3*rowHeight,width,rowHeight+16,0,3*rowHeight);}
  const coordinates=[];
  for(const item of items){const source=PNG.sync.read(item.buffer),x=columnX[platforms.indexOf(item.platform)],y=48+item.row*rowHeight;PNG.bitblt(source,atlas,0,0,source.width,source.height,x,y);coordinates.push({platform:item.platform,row:item.row,x,y,width:source.width,height:source.height,label:item.label});}
  await writeFile(resolve(base,file),PNG.sync.write(atlas,{deflateLevel:9}));evidence.atlases.push({file,columns:platforms,coordinates});
 }
}finally{await browser.close();await writeFile(resolve(base,'overview/renders.json'),JSON.stringify(evidence,null,2)+'\n');}
console.log(JSON.stringify({observations:evidence.renders.length,pageErrors:evidence.errors,overflow:evidence.renders.filter(r=>r.overflow),undersized:evidence.renders.filter(r=>r.undersizedTargets.length),missingImages:evidence.renders.filter(r=>r.missingImages.length)}));
