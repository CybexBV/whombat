// Picture rendering and design measurements only. No application/test suite is run.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=new URL('.',import.meta.url),dir=fileURLToPath(here);
const {chromium}=createRequire(resolve('apps/web/package.json'))('@playwright/test');
const {PNG}=createRequire(resolve('tools/visual/package.json'))('pngjs');
const contrast=await readFile(new URL('../01-groundwork/contrast.js',here),'utf8');
const browser=await chromium.launch({args:['--allow-file-access-from-files','--disable-lcd-text']});
const context=await browser.newContext({locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,reducedMotion:'reduce'});
const page=await context.newPage(),records=[],pictures=[],consoleErrors=[];
page.on('pageerror',err=>consoleErrors.push(err.message));
page.on('requestfailed',r=>consoleErrors.push(`${r.url()}: ${r.failure()?.errorText}`));
await mkdir(resolve('.whombat/shots'),{recursive:true});await mkdir(resolve(dir,'png'),{recursive:true});
const loaded=async()=>{for(const f of page.frames()){await f.waitForFunction(()=>document.readyState==='complete');await f.evaluate(()=>document.fonts.ready);await f.waitForFunction(()=>!document.querySelector('#app')||document.documentElement.dataset.ready==='true');}};
const save=async(path)=>{await page.screenshot({path,animations:'disabled'});const bytes=await readFile(path),small=PNG.sync.write(PNG.sync.read(bytes),{deflateLevel:9,filterType:-1});if(small.length<bytes.length)await writeFile(path,small);};
const draw=async(params,width=390,height=width===1440?900:844)=>{await page.setViewportSize({width,height});await page.goto(new URL(`mockup.html?${new URLSearchParams(params)}`,here).href);await loaded();};
const measure=async(params,width)=>{
  await draw(params,width);const observations=await page.evaluate(()=>({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,question:document.querySelector('.question')?.textContent,questionSize:document.querySelector('.question')&&getComputedStyle(document.querySelector('.question')).fontSize,questionWeight:document.querySelector('.question')&&getComputedStyle(document.querySelector('.question')).fontWeight,scale:getComputedStyle(document.querySelector('.approval')).getPropertyValue('--scale'),contentHeight:document.querySelector('.content').clientHeight,contentScrollHeight:document.querySelector('.content').scrollHeight,answers:[...document.querySelectorAll('.answers button,.answers a')].map(b=>({text:b.textContent.trim(),rect:b.getBoundingClientRect().toJSON()})),fonts:document.fonts.check('700 24px "Bricolage Grotesque"')}));
  const samples=[];
  for(const fraction of [0,.25,.5,.75,1]){await page.evaluate(f=>{const c=document.querySelector('.content');c.scrollTop=(c.scrollHeight-c.clientHeight)*f;},fraction);const sample=await page.evaluate(contrast+'\nmeasureContrast()');samples.push({fraction,minimum:sample.minimum,pairs:sample.pairs,failures:sample.failures});}
  records.push({params,observations,samples:samples.map(({fraction,minimum,failures})=>({fraction,minimum,failures})),pairs:[...new Map(samples.flatMap(s=>s.pairs).map(p=>[JSON.stringify([p.foreground,p.background]),p])).values()]});
};
try {
  // Reproduce the matching ordinary-state after pictures requested for delivery.
  // Before captures belong to the local review session, not to a fresh checkout.
  const manifest=JSON.parse(await readFile('.whombat/before-manifest.json','utf8').catch(error=>{if(error.code==='ENOENT')return '[]';throw error;}));
  for(const row of manifest){await draw({platform:row.surface==='phone'?row.platform:'web',surface:row.surface,kind:row.kind,theme:row.theme},row.width,row.height);row.after=row.before.replace('12-before-','12-after-');await save(row.after);pictures.push(row);}
  for(const theme of ['light','dark']){
    for(const platform of ['web','phone-web','ios','android']){
      for(const kind of ['everyday','command','deploy','mail','key']){
        const params={platform:platform.includes('web')?'web':platform,kind,theme};
        await measure(params,platform==='web'?1440:390);
        if(platform!=='web')await measure({...params,text:'largest'},390);
        if(platform.includes('web'))await measure({...params,surface:'details',...(kind==='mail'?{length:'long'}:{})},platform==='web'?1440:390);
      }
      for(const state of ['loading','load-error','answer-unknown','answer-refused'])await measure({platform:platform.includes('web')?'web':platform,kind:'command',state,theme},platform==='web'?1440:390);
    }
    for(const kind of ['command','mail'])await measure({platform:'web',surface:'details',kind,theme,text:'largest',length:'long'},390);
    for(const plate of ['browser-command','browser-mail','native','facts','kinds','states']){
      await page.setViewportSize({width:1440,height:900});await page.goto(new URL(`plates.html?plate=${plate}&theme=${theme}`,here).href);await loaded();
      const path=resolve(dir,'png',`${plate}-${theme}.png`);await save(path);await copyFile(path,resolve('.whombat/shots',`12-${plate}-${theme}.png`));
    }
    await draw({platform:'web',kind:'everyday',theme},1440,900);await save(resolve(dir,'png',`desktop-${theme}.png`));
    for(const platform of ['ios','android'])for(const kind of ['everyday','command','deploy','mail','key']){
      await draw({platform,kind,theme,text:'largest',...(kind==='mail'?{length:'long'}:{})});await save(resolve('.whombat/shots',`12-${platform}-${kind}-largest-${theme}.png`));
    }
  }
  await writeFile(resolve('.whombat/after-manifest.json'),JSON.stringify(pictures,null,2)+'\n');
} finally {await browser.close();}
await writeFile(new URL('render-measurements.json',here),JSON.stringify({engine:'Playwright Chromium',clock:windowClock(),scale:1,native:'HTML drawing, not an OS screenshot',records,consoleErrors},null,2)+'\n');
function windowClock(){return '2026-09-23T09:22:00.000Z';}
console.log(JSON.stringify({renders:records.length,pairedPictures:pictures.length,consoleErrors,lightMinimum:Math.min(...records.filter(r=>r.params.theme==='light').flatMap(r=>r.samples.map(s=>s.minimum??100))),darkMinimum:Math.min(...records.filter(r=>r.params.theme==='dark').flatMap(r=>r.samples.map(s=>s.minimum??100)))},null,2));
