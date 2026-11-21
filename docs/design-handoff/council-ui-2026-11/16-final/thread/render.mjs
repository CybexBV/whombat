// Requested PNG production and static design observations only. No CI or application tests.
import{createRequire}from'node:module';import{readFile,writeFile,mkdir}from'node:fs/promises';import{resolve}from'node:path';import{pathToFileURL}from'node:url';
const{chromium}=createRequire(resolve('apps/web/package.json'))('@playwright/test');const{PNG}=createRequire(resolve('tools/visual/package.json'))('pngjs');
const dir=resolve('docs/design-handoff/council-ui-2026-11/16-final/thread');const shots=resolve('.whombat/shots/16-thread');await mkdir(shots,{recursive:true});await mkdir(resolve(dir,'png'),{recursive:true});
let previousCaptures=[];try{previousCaptures=JSON.parse(await readFile(resolve(dir,'captures.json'),'utf8'));}catch{/* First render has no existing crop manifest. */}
const sampler=await readFile(resolve(dir,'../../01-groundwork/contrast.js'),'utf8');const controls=await readFile(resolve(dir,'../colour-pairs.js'),'utf8');
const browser=await chromium.launch({args:['--disable-lcd-text']});const crops=[],observations=[];const errors=[];
async function ready(p){await p.evaluate(()=>document.fonts.ready);await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
async function observe(p){
 const geometry=await p.evaluate(()=>{
  const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {top:+r.top.toFixed(2),bottom:+r.bottom.toFixed(2),left:+r.left.toFixed(2),right:+r.right.toFixed(2),width:+r.width.toFixed(2),height:+r.height.toFixed(2)};};
  const main=document.querySelector('#main'),mainRect=rect(main),cta=document.querySelector('[data-handover],[data-read-answers],[data-plan-open],[data-plan-go]');
  const targets=[...document.querySelectorAll('button,a,summary,textarea,select,.task-choice')].filter(e=>e.getClientRects().length&&!e.closest('dialog:not([open])')&&!e.matches('.skip')).map(e=>({name:e.getAttribute('aria-label')||e.textContent.trim().slice(0,90),...rect(e)}));
  const minimum=document.body.dataset.platform==='android'?48:44;
  return{viewport:[innerWidth,innerHeight],main:mainRect,mainScrollTop:main.scrollTop,mainScrollHeight:main.scrollHeight,action:rect(cta),actionWithinFirstScreen:cta?rect(cta).top>=mainRect.top&&rect(cta).bottom<=mainRect.bottom:null,selected:[...document.querySelectorAll('.selected-tasks .task-choice')].map(e=>({text:e.textContent.trim(),checked:e.querySelector('input').checked,...rect(e)})),dependency:rect(document.querySelector('.dependency')),effectiveAI:rect(document.querySelector('.effective-ai')),header:document.querySelector('h1').textContent,ownVisibleNames:[...document.querySelectorAll('.own .message-meta strong,.own .assistant-face')].map(e=>e.textContent),cardExpansion:document.querySelector('.card-expansion')?.open??null,approvalAnswers:[...document.querySelectorAll('.decision-answers button')].map(e=>({text:e.textContent,...rect(e)})),delegationDetails:document.querySelector('.delegation-card')?.querySelectorAll('details').length??null,rawCouncilMarkdown:document.querySelector('.council-card')?.innerText.includes('**')??null,renderedStrong:document.querySelectorAll('.council-card .markdown strong').length,nativeTabs:document.querySelectorAll('.native-tabs').length,placesOpen:document.querySelector('#places-menu').open,documentOverflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),targets:{minimum,count:targets.length,undersized:targets.filter(t=>t.width<minimum-.1||t.height<minimum-.1)}};
 });
 const pairs=new Map(),low=new Map();const main=p.locator('#main');const first=await main.evaluate(e=>e.scrollTop);const height=await main.evaluate(e=>e.scrollHeight);const step=await main.evaluate(e=>Math.max(160,e.clientHeight-60));
 for(let y=0;y<height;y+=step){await main.evaluate((e,y)=>{e.scrollTop=y},y);const m=await p.evaluate(sampler+'\nmeasureContrast()');for(const r of m.pairs)pairs.set(JSON.stringify([r.foreground,r.background]),r);for(const r of m.failures)low.set(JSON.stringify([r.text,r.foreground,r.background]),r);}
 await main.evaluate((e,y)=>{e.scrollTop=y},first);
 return{geometry,colours:{minimum:Math.min(...[...pairs.values()].map(r=>r.ratio)),pairs:[...pairs.values()],below45:[...low.values()]},controls:await p.evaluate(controls+'\nmeasureControlPairs()'),visibleText:await p.locator('#main').innerText()};
}
async function atlas(name,items,width,height){
 const gap=16,cols=2,rows=Math.ceil(items.length/cols);const png=new PNG({width:width*cols+gap,height:height*rows+(rows-1)*gap});png.data.fill(0);
 for(let i=0;i<items.length;i++){const e=items[i],img=PNG.sync.read(e.buffer),x=(i%cols)*(width+gap),y=Math.floor(i/cols)*(height+gap);PNG.bitblt(img,png,0,0,img.width,img.height,x,y);crops.push({...e.meta,file:`png/${name}.png`,crop:{x,y,width:img.width,height:img.height}});}
 await writeFile(resolve(dir,`png/${name}.png`),PNG.sync.write(png,{deflateLevel:9,deflateStrategy:0}));
}
try{
for(const platform of ['desktop','phoneweb','ios','android'])for(const theme of ['light','dark']){
 const width=platform==='desktop'?1440:390,height=platform==='desktop'?900:844;
 const ctx=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,colorScheme:theme,locale:'en-GB',timezoneId:'Europe/Amsterdam',reducedMotion:'reduce'});const page=await ctx.newPage();page.on('pageerror',e=>errors.push({platform,theme,message:e.message}));await page.clock.setFixedTime(new Date('2026-09-23T12:05:00Z'));
 const entries=[];const variants=[...['normal','council','council-answers','delegation','delegation-working','delegation-records','plan','plan-open','plan-blocked','plan-blocked-open'].map(scene=>({scene,state:'normal'})),...['loading','empty','failed','saved-failed'].map(state=>({scene:'normal',state}))];
 for(const text of platform==='desktop'?['normal']:['normal','largest'])for(const v of variants){
  const url=pathToFileURL(resolve(dir,'mockup.html'));url.search=new URLSearchParams({platform,theme,text,...v});await page.goto(url.href);await ready(page);
  const buffer=await page.screenshot({animations:'disabled',caret:'hide'});const meta={platform,theme,text,...v,viewport:[width,height]};
  const local=resolve(shots,`after-${v.scene}-${v.state}-${platform}-${theme}-${text}.png`);await writeFile(local,PNG.sync.write(PNG.sync.read(buffer),{deflateLevel:9,deflateStrategy:0}));
  if(v.scene==='normal'&&v.state==='normal'&&text==='normal'){const file=`${platform}-${theme}.png`;await writeFile(resolve(dir,file),await readFile(local));crops.push({...meta,file,crop:{x:0,y:0,width,height}});}else if(v.scene.startsWith('plan')||(v.scene==='normal'&&v.state==='normal'&&text==='largest')){const file=`${platform}-${theme}-${v.scene==='normal'?'largest':v.scene+(text==='largest'?'-largest':'')}.png`;await writeFile(resolve(dir,file),await readFile(local));crops.push({...meta,file,crop:{x:0,y:0,width,height}});}else entries.push({buffer,meta});
  observations.push({...meta,...await observe(page)});
 }
 await atlas(`views-${platform}-${theme}`,entries,width,height);
 const before=[];
 for(const scene of ['council','council-answers','delegation','delegation-working','delegation-records']){
  try{before.push({buffer:await readFile(resolve(shots,`before-${scene}-${platform}-${theme}.png`)),meta:{platform,theme,scene,before:true,text:'normal',state:'normal',viewport:[width,height]}});}catch{ /* A fresh checkout keeps its committed before atlases. */ }
 }
 if(before.length===5)await atlas(`before-${platform}-${theme}`,before,width,height);
 else crops.push(...previousCaptures.filter(r=>r.before&&r.platform===platform&&r.theme===theme));
 await ctx.close();console.log(`Rendered ${platform} ${theme}: ${variants.length*(platform==='desktop'?1:2)} states and card views.`);
}
}finally{await browser.close();await writeFile(resolve(dir,'captures.json'),JSON.stringify(crops,null,2)+'\n');await writeFile(resolve(dir,'captures.js'),'window.THREAD_CAPTURES = '+JSON.stringify(crops)+';\n');await writeFile(resolve(dir,'observations.json'),JSON.stringify({kind:'Static design render and colour/geometry observations; not application checks',browser:browser.version(),frozen:'2026-09-23T12:05:00Z',observations,errors},null,2)+'\n');}
