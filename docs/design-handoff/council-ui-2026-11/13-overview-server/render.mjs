// PNG rendering and color measurements only. This is not an application test runner.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require=createRequire(resolve('apps/web/package.json'));
const {chromium}=require('@playwright/test');
const root=new URL('.',import.meta.url);
const base=process.env.REVIEW_URL||'http://127.0.0.1:5383/docs/design-handoff/council-ui-2026-11/13-overview-server/';
const contrast=await readFile(new URL('../01-groundwork/contrast.js',root),'utf8');
const sheet=new URL('../../../../.whombat/shots/round2/',root);
await mkdir(sheet,{recursive:true});
const browser=await chromium.launch({args:['--disable-lcd-text']});
const report={purpose:'PNG rendering and sampled WCAG color measurements; no lint, typecheck, notices, tests or CI requested/run.',renders:[],console:[]};
const ratioScript=`(() => {
 const rgb=s=>s.match(/[\\d.]+/g).slice(0,3).map(Number);
 const l=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const bg=el=>{const stack=[];for(let p=el;p;p=p.parentElement)stack.unshift(getComputedStyle(p).backgroundColor);let out=[255,255,255];for(const s of stack){const parts=s.match(/[\\d.]+/g)?.map(Number);if(parts?.length>=3){const a=parts[3]??1;out=out.map((v,i)=>parts[i]*a+v*(1-a));}}return out;};
 return [...document.querySelectorAll('.badge,button,summary,.pill,.reading-time,.phone-top a,.tab-bar a')].filter(el=>el.getClientRects().length).map(el=>{const foreground=rgb(getComputedStyle(el).color),background=bg(el),a=l(foreground),b=l(background);return {element:el.className||el.tagName,text:el.innerText,foreground,background,ratio:+((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toFixed(3)};});
})()`;
async function render(page,{platform,screen,state,theme,large=false,width=390}) {
 const url=base+'mockup.html?'+new URLSearchParams({screen,state,platform:platform==='phone-web'||platform==='desktop'?'web':platform,theme,...large?{text:'large'}:{}});
 await page.setViewportSize({width,height:width===1440?900:844});
 await page.goto(url);await page.evaluate(()=>document.fonts.ready);
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const name=`after-${platform}-${screen}-${large?'large':state}-${theme}`;
 await page.screenshot({path:new URL(name+'.png',sheet).pathname,animations:'disabled'});
 const top=await page.evaluate(contrast+'\nmeasureContrast()');
 const controls=await page.evaluate(ratioScript);
 await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
 const bottom=await page.evaluate(contrast+'\nmeasureContrast()');
 report.renders.push({platform,screen,state,theme,large,width,height:width===1440?900:844,top,bottom,controls});
 return {name,image:(await readFile(new URL(name+'.png',sheet))).toString('base64')};
}
try {
 for(const theme of ['light','dark']) {
  const context=await browser.newContext({locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,reducedMotion:'reduce'});
  const page=await context.newPage();page.on('pageerror',e=>report.console.push(e.message));
  for(const screen of ['overview','server']) {
   const shot=await render(page,{platform:'desktop',screen,state:'normal',theme,width:1440});
   await copyFile(new URL(shot.name+'.png',sheet),new URL(`png/after-desktop-${screen}-${theme}.png`,root));
  }
  for(const platform of ['phone-web','ios','android']) {
   const cells=[];
   for(const state of ['normal','read','loading','empty','large']) for(const screen of ['overview','server','automations']) {
    const shot=await render(page,{platform,screen,state:state==='large'?'normal':state,theme,large:state==='large'});
    cells.push({screen,state,...shot});
   }
   // Three real 390×844 viewports per row, with review captions outside product pixels.
   await page.setViewportSize({width:1250,height:4515});
   const dark=theme==='dark';
   await page.setContent(`<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="${base}style.css"><style>body{padding:20px}.plate-title{font-size:20px;margin-bottom:16px}.plate-grid{display:grid;grid-template-columns:repeat(3,390px);gap:18px 20px}.plate-grid h2{font:500 13px var(--font-sans);height:22px}.plate-grid img{display:block;width:390px;height:844px;border:1px solid var(--line2)}</style></head><body><h1 class="plate-title">${platform} · ${theme} · static HTML drawings · ${dark?'dark':'light'}</h1><div class="plate-grid">${cells.map(c=>`<article><h2>${c.screen==='server'?'pve-02':c.screen} · ${c.state==='large'?(platform==='phone-web'?'200% text':'1.6× native cap'):c.state}</h2><img src="data:image/png;base64,${c.image}" alt="${c.screen}, ${c.state}"></article>`).join('')}</div></body></html>`);
   await page.evaluate(()=>document.fonts.ready);
   await page.screenshot({path:new URL(`png/after-${platform}-states-${theme}.png`,root).pathname,fullPage:true,animations:'disabled'});
   console.log(`Rendered ${platform} · ${theme}`);
  }
  await context.close();
 }
 await writeFile(new URL('render.json',root),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({rendered:report.renders.length,console:report.console}));
} finally {await browser.close();}
