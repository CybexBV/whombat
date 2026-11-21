// PNG production and design measurements only. No application checks or test suite.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(resolve('apps/web/package.json'));
const {chromium}=require('@playwright/test');
const {PNG}=createRequire(resolve('tools/visual/package.json'))('pngjs');
const dir=resolve('docs/design-handoff/council-ui-2026-11/15-native-cards');
const url=pathToFileURL(resolve(dir,'mockup.html')).href;
const contrast=await readFile(resolve(dir,'../01-groundwork/contrast.js'),'utf8');
const browser=await chromium.launch({args:['--disable-lcd-text']});
const manifest=[];
const report={kind:'Static design measurements, not native implementation verification or application tests',browser:browser.version(),viewport:[390,844],fixtureMoment:'2026-09-23T12:05:00Z',records:[],renderErrors:[]};
async function ready(p){await p.evaluate(()=>document.fonts.ready);await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
async function measurements(p){
  const pairs=new Map(), low=new Map();
  await p.evaluate(()=>document.querySelectorAll('.tab-badge').forEach(e=>e.removeAttribute('aria-hidden')));
  const height=await p.evaluate(()=>document.documentElement.scrollHeight);
  for(let y=0;y<height;y+=700){
    await p.evaluate(y=>scrollTo(0,y),y);
    const m=await p.evaluate(contrast+'\nmeasureContrast()');
    for(const row of m.pairs)pairs.set(JSON.stringify([row.foreground,row.background]),row);
    for(const row of m.failures)low.set(JSON.stringify([row.text,row.foreground,row.background]),row);
  }
  const targets=await p.evaluate(()=>{
    const min=document.body.dataset.os==='android'?48:44;
    const rows=[...document.querySelectorAll('.phone button,.phone summary,.phone a,.phone textarea,.phone input:not([type="checkbox"]),.phone select,.phone .task label')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {name:e.getAttribute('aria-label')||e.textContent.trim().slice(0,90),width:+r.width.toFixed(2),height:+r.height.toFixed(2)}});
    const host=document.querySelector('.host-link')?.getBoundingClientRect();
    return {minimum:min,count:rows.length,small:rows.filter(r=>r.width<min-.1||r.height<min-.1),host:host?{width:host.width,height:host.height}:null};
  });
  const overflow=await p.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth));
  await p.evaluate(()=>scrollTo(0,0));
  return {minimum:Math.min(...[...pairs.values()].map(p=>p.ratio)),pairs:[...pairs.values()],below45:[...low.values()],targets,horizontalOverflow:overflow};
}
async function atlas(name,entries){
  const columns=3,gap=16,cell=390;
  let y=0,images=[];
  for(let i=0;i<entries.length;i+=columns){
    const row=entries.slice(i,i+columns).map(e=>({...e,image:PNG.sync.read(e.buffer)}));
    for(let j=0;j<row.length;j++)images.push({...row[j],x:j*(cell+gap),y});
    y+=Math.max(...row.map(r=>r.image.height))+gap;
  }
  const out=new PNG({width:columns*cell+(columns-1)*gap,height:y-gap});out.data.fill(0);
  for(const e of images){PNG.bitblt(e.image,out,0,0,e.image.width,e.image.height,e.x,e.y);manifest.push({...e.meta,atlas:`png/${name}.png`,crop:{x:e.x,y:e.y,width:e.image.width,height:e.image.height}});}
  await writeFile(resolve(dir,`png/${name}.png`),PNG.sync.write(out,{deflateLevel:9,deflateStrategy:0}));
}
try{
 for(const platform of ['phone-web','ios','android'])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,colorScheme:theme,locale:'en-GB',timezoneId:'Europe/Amsterdam',reducedMotion:'reduce'});
  const p=await context.newPage();p.on('pageerror',e=>report.renderErrors.push({platform,theme,message:e.message}));
  await p.clock.setFixedTime(new Date(report.fixtureMoment));
  await p.goto(`${url}?platform=${platform}&theme=${theme}&capture=1`);await ready(p);
  const ids=await p.evaluate(()=>Cards.defs.map(d=>d[0]).concat('council-round'));
  const cards=[];
  for(const id of ids)for(const expanded of [false,true]){
   await p.goto(`${url}?platform=${platform}&theme=${theme}&screen=card&card=${id}&expanded=${expanded?1:0}&document=1&capture=1`);await ready(p);
   const m=await measurements(p);
   report.records.push({platform,theme,screen:'card',id,expanded,...m});
   cards.push({buffer:await p.locator('#app').screenshot({animations:'disabled',caret:'hide'}),meta:{platform,theme,screen:'card',id,expanded,large:false}});
  }
  await atlas(`cards-${platform}-${theme}`,cards);
  console.log(`Rendered ${platform} ${theme}: ${cards.length} card views`);
  if(platform!=='phone-web'){
   const native=[];
   for(const screen of ['chat-list','inbox','overview','automations','settings','connection']){
    await p.goto(`${url}?platform=${platform}&theme=${theme}&screen=${screen}&document=1&capture=1`);await ready(p);
    const m=await measurements(p);report.records.push({platform,theme,screen,...m});
    await p.goto(`${url}?platform=${platform}&theme=${theme}&screen=${screen}&capture=1`);await ready(p);
    native.push({buffer:await p.locator('.phone').screenshot({animations:'disabled',caret:'hide'}),meta:{platform,theme,screen,large:false}});
    if(screen==='connection'){
     await p.evaluate(()=>document.getElementById('heads-ups').scrollIntoView({block:'center'}));
     native.push({buffer:await p.locator('.phone').screenshot({animations:'disabled',caret:'hide'}),meta:{platform,theme,screen:'connection-heads',large:false}});
     await p.locator('#heads-ups').evaluate(e=>e.open=true);
     await p.evaluate(()=>document.getElementById('heads-ups').scrollIntoView({block:'start'}));
     native.push({buffer:await p.locator('.phone').screenshot({animations:'disabled',caret:'hide'}),meta:{platform,theme,screen:'connection-open',large:false}});
    }
   }
   await atlas(`native-${platform}-${theme}`,native);
  }
  const large=[];
  for(const [screen,id] of [['card','delegation-offer'],['card','council-done'],['connection',null],['overview',null]]){
   await p.goto(`${url}?platform=${platform}&theme=${theme}&screen=${screen}${id?'&card='+id:''}&large=1&document=1&capture=1`);await ready(p);
   const m=await measurements(p);report.records.push({platform,theme,screen,id,large:true,...m});
   large.push({buffer:await p.locator('#app').screenshot({animations:'disabled',caret:'hide'}),meta:{platform,theme,screen,id,large:true,expanded:false}});
  }
  await atlas(`large-${platform}-${theme}`,large);
  await context.close();
 }
}finally{
 await browser.close();
 await writeFile(resolve(dir,'captures.json'),JSON.stringify(manifest,null,2)+'\n');
 await writeFile(resolve(dir,'captures.js'),'window.NATIVE_CARD_CAPTURES = '+JSON.stringify(manifest)+';\n');
 await writeFile(resolve(dir,'measurements.json'),JSON.stringify(report,null,2)+'\n');
}
