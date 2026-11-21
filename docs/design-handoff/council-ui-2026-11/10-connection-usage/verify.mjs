// Render/contrast evidence for static mockups, not an application test suite.
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const { PNG } = createRequire(resolve('tools/visual/package.json'))('pngjs');
const out=fileURLToPath(new URL('.',import.meta.url));
const base=process.env.REVIEW_URL||'http://127.0.0.1:5379/docs/design-handoff/council-ui-2026-11/10-connection-usage/';
const contrast=await readFile(resolve(out,'../01-groundwork/contrast.js'),'utf8');
const browser=await chromium.launch({args:['--disable-lcd-text']});
const report={ renders:[], interactions:[], errors:[] };
const states={ connection:['normal','partial','stale','refreshing','no-copy'], usage:['normal','read','no-copy','refreshing','provider'], settings:['normal','advanced'] };
try {
  for (const platform of ['web','phone-web','android','ios']) for (const theme of ['light','dark']) {
    const context=await browser.newContext({locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,reducedMotion:'reduce',viewport:{width:platform==='web'?1440:390,height:platform==='web'?900:844}});
    const page=await context.newPage();
    page.on('pageerror',error=>report.errors.push(error.message));
    page.on('response',res=>{if(res.status()>=400)report.errors.push(`${res.status()}: ${res.url()}`);});
    for (const [screen,list] of Object.entries(states)) for (const state of list) for (const variant of state==='normal'&&screen!=='settings'?['folded','keep']:['folded']) {
      await page.goto(base+'mockup.html?'+new URLSearchParams({screen,state,platform,theme,variant}));
      await page.evaluate(()=>document.fonts.ready);
      const measure=await page.evaluate(contrast+'\nmeasureContrast()');
      const detail=await page.evaluate(()=>{
        const color=s=>{
          const n=s.match(/[\d.]+/g).map(Number);
          const scale=s.startsWith('color(srgb ')?255:1;
          return [n[0]*scale,n[1]*scale,n[2]*scale,n[3]??1];
        };
        const luminance=rgb=>rgb.slice(0,3).map(v=>{const c=v/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((s,c,i)=>s+c*[.2126,.7152,.0722][i],0);
        const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
        const gradient=document.querySelector('.research');
        let gradientReport=null;
        if(gradient){
          const swatch=document.createElement('span'); gradient.append(swatch);
          swatch.style.background='color-mix(in srgb,var(--warn) 9%,var(--sf))'; const top=color(getComputedStyle(swatch).backgroundColor);
          swatch.style.background='color-mix(in srgb,var(--warn) 3%,var(--sf))'; const bottom=color(getComputedStyle(swatch).backgroundColor);
          swatch.remove();
          const pairs=[...gradient.querySelectorAll('h2,p,.plain')].map(el=>{const fg=color(getComputedStyle(el).color);const samples=Array.from({length:257},(_,i)=>{const bg=top.map((v,k)=>v+(bottom[k]-v)*i/256);return ratio(fg,bg);});return {text:el.textContent.trim(),foreground:fg,minimum:+Math.min(...samples).toFixed(3)};});
          gradientReport={top,bottom,steps:257,minimum:Math.min(...pairs.map(p=>p.minimum)),pairs};
        }
        const target=document.querySelector('[data-measure="pill"]');
        const selected=document.querySelector('[data-measure="settings-selected"]');
        return {overflow:document.documentElement.scrollWidth>innerWidth,gradient:gradientReport,pill:target?{foreground:getComputedStyle(target).color,background:getComputedStyle(target).backgroundColor}:null,selected:selected?{foreground:getComputedStyle(selected).color,background:getComputedStyle(selected.closest('a')).backgroundColor,surface:getComputedStyle(selected.closest('aside')).backgroundColor}:null};
      });
      if(detail.overflow)report.errors.push(`Overflow ${platform}/${screen}/${state}/${variant}/${theme}`);
      if(measure.failures.length)report.errors.push(`Contrast ${platform}/${screen}/${state}/${theme}: ${JSON.stringify(measure.failures)}`);
      if(detail.gradient?.minimum<4.5)report.errors.push(`Gradient ${platform}/${theme}`);
      const targetSizes=await page.evaluate(()=>[...document.querySelectorAll('button,summary,.entry,.tabbar a,.tabs a,.back')].filter(el=>el.getClientRects().length&&!el.closest('dialog:not([open])')).map(el=>({name:el.getAttribute('aria-label')||el.textContent.trim(),height:+el.getBoundingClientRect().height.toFixed(1)})));
      if(['android','ios'].includes(platform)&&targetSizes.some(t=>t.height<(platform==='ios'?44:48)))report.errors.push(`Small target ${platform}/${screen}/${state}/${theme}`);
      const save=state==='normal' && (variant==='folded'||platform==='web');
      const file=save?`after-${platform}-${screen}${variant==='keep'?'-keep':''}-${theme}.png`:null;
      if(file){
        const bytes=await page.screenshot({animations:'disabled',caret:'hide'});
        const png=PNG.sync.read(bytes);
        await writeFile(resolve(out,'png',file),PNG.sync.write(png,{deflateLevel:9,deflateStrategy:0}));
        await copyFile(resolve(out,'png',file),resolve('.whombat/shots',`10-${file}`));
      }
      report.renders.push({platform,screen,state,variant,theme,file,minimum:measure.minimum,pairs:measure.pairs,skipped:measure.skipped,targetSizes,...detail});
    }
    // Largest-text drawing check: 200% CSS root text at 390; native OS text is still a GAP.
    if(platform!=='web')for(const screen of ['connection','usage','settings']){
      await page.goto(base+'mockup.html?'+new URLSearchParams({screen,platform,theme,large:'1'}));
      await page.evaluate(()=>document.fonts.ready);
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
      report.interactions.push({platform,theme,screen,kind:'200% drawing text',overflow});
      if(overflow)report.errors.push(`Large text overflow ${platform}/${theme}/${screen}`);
    }
    await page.goto(base+'mockup.html?'+new URLSearchParams({screen:'connection',platform,theme}));
    const fold=page.locator('#heads-ups summary');await fold.focus();await fold.press('Enter');
    const opened=await page.locator('#heads-ups').getAttribute('open');
    await fold.press('Enter');
    const returned=await fold.evaluate(el=>document.activeElement===el);
    await fold.press('Enter');
    const expandedMeasures=[];
    for(let y=0;y<await page.evaluate(()=>document.documentElement.scrollHeight);y+=600){
      await page.evaluate(y=>scrollTo(0,y),y);
      const measure=await page.evaluate(contrast+'\nmeasureContrast()');
      expandedMeasures.push({y,minimum:measure.minimum,failures:measure.failures});
      if(measure.failures.length)report.errors.push(`Expanded contrast ${platform}/${theme}/${y}`);
    }
    await page.evaluate(()=>scrollTo(0,0));
    const ask=page.getByRole('button',{name:`Ask `,exact:false}).first();
    await ask.click(); await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
    const dialogReturn=await ask.evaluate(el=>document.activeElement===el);
    report.interactions.push({platform,theme,kind:'fold and dialog focus',opened:opened!==null,returned,dialogReturn,expandedMeasures});
    if(opened===null||!returned||!dialogReturn)report.errors.push(`Focus ${platform}/${theme}`);
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(resolve(out,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(`${report.renders.length} static renders; ${report.interactions.length} interaction/layout checks; ${report.errors.length} errors.`);
for(const error of report.errors)console.error(error);
if(report.errors.length)process.exitCode=1;
