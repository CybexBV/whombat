// Static mockups only: node docs/design-handoff/council-ui-2026-11/06-findability/capture.mjs
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const out = fileURLToPath(new URL('.', import.meta.url));
const shots = resolve('.whombat/shots');
const contrast = await readFile(resolve(out,'../01-groundwork/contrast.js'),'utf8');
const browser = await chromium.launch({ args: ['--disable-lcd-text'] });
const records = [];
const interactions = [];
await mkdir(shots,{recursive:true});
function url(screen,platform,theme,variant='main',extra={}) {
  return pathToFileURL(resolve(out,'mockup.html')).href+'?'+new URLSearchParams({screen,platform,theme,variant,...extra});
}
async function pageFor(screen,platform,theme,variant='main',extra={}) {
  const context = await browser.newContext({locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,reducedMotion:'reduce',viewport:platform==='web'?{width:1440,height:900}:{width:390,height:844}});
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-09-23T09:22:00.000Z')});
  await page.goto(url(screen,platform,theme,variant,extra));
  await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))));
  if(errors.length)throw new Error(errors.join('\n'));
  return {context,page};
}
async function capture(screen,platform,theme,variant='main') {
  const {page,context}=await pageFor(screen,platform,theme,variant);
  const file=`after-${platform==='web'?'web':platform}-${screen}-${theme}.png`;
  const measure=await page.evaluate(contrast+'\nmeasureContrast()');
  const checks=await page.evaluate(()=>({fonts:document.fonts.check('400 16px "Bricolage Grotesque"')&&document.fonts.check('400 12px "DM Mono"'),horizontalOverflow:document.documentElement.scrollWidth>innerWidth,brokenImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src),touch:[...document.querySelectorAll('.phone a,.phone button')].filter(n=>n.getBoundingClientRect().height>0&&n.getBoundingClientRect().height<44).map(n=>({name:n.getAttribute('aria-label')||n.textContent,height:n.getBoundingClientRect().height}))}));
  await page.screenshot({path:resolve(shots,file),animations:'disabled',caret:'hide'});
  if(platform==='web')await copyFile(resolve(shots,file),resolve(out,'png',file));
  records.push({screen,platform,theme,variant,file,checks,measure});
  console.log(`${file}: ${measure.minimum}:1; ${measure.failures.length} text failures; ${checks.touch.length} small touch targets`);
  await context.close();
}
async function sheet(theme,name,screens) {
  const context=await browser.newContext({viewport:{width:390*screens.length,height:880},deviceScaleFactor:1});
  const page=await context.newPage();
  const html=`<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="${pathToFileURL(resolve('packages/tokens/tokens.css'))}"><link rel="stylesheet" href="${pathToFileURL(resolve('apps/web/src/app/fonts/fonts.css'))}"><style>*{box-sizing:border-box}body{margin:0;display:flex;background:var(--bg);color:var(--ink);font:13px var(--font-sans)}figure{margin:0;width:390px}figcaption{height:36px;padding:8px 16px;background:var(--sf2)}img{display:block;width:390px;height:844px}</style></head><body>${screens.map(([platform,screen,label])=>`<figure><figcaption>${label} · ${theme} · static proposal</figcaption><img src="${pathToFileURL(resolve(shots,`after-${platform}-${screen}-${theme}.png`))}" alt="${label}"></figure>`).join('')}</body></html>`;
  const path=resolve(shots,`contact-${name}-${theme}.html`);
  await writeFile(path,html);await page.goto(pathToFileURL(path).href);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
  await page.screenshot({path:resolve(out,'png',`after-phone-${name}-${theme}.png`),animations:'disabled'});await context.close();
}
try {
  for(const theme of ['light','dark']) {
    for(const screen of ['chat','files','vault','settings','search','overview'])await capture(screen,'web',theme,screen==='search'?'search':screen==='overview'?'overview':'main');
    for(const screen of ['chat','files','vault','settings','search','overview'])await capture(screen,'ios',theme,screen==='search'?'search':screen==='overview'?'overview':'main');
    for(const screen of ['files','settings'])await capture(screen,'android',theme);
    await sheet(theme,'main',[['ios','chat','iOS Chat'],['ios','settings','iOS Settings'],['ios','files','iOS Files'],['ios','vault','iOS Vault']]);
    await sheet(theme,'android',[['android','settings','Android Settings'],['android','files','Android Files']]);
    await sheet(theme,'variants',[['ios','search','AP-2645 · Search'],['ios','overview','CN-11 / AP-2564 · Overview']]);
    const {page,context}=await pageFor('settings','ios',theme,'main',{text:'largest'});
    await page.screenshot({path:resolve(shots,`largest-settings-${theme}.png`)});
    interactions.push({theme,check:'200% content text',horizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),scrolls:await page.locator('.phone-body').evaluate(e=>e.scrollHeight>e.clientHeight)});
    await context.close();
  }
  const {page,context}=await pageFor('settings','ios','light');
  await page.locator('.tile').filter({has:page.getByText('Vault',{exact:true})}).click();
  await page.waitForURL(/screen=vault/);
  interactions.push({check:'Vault remembers Settings origin',back:await page.locator('.backbar a').getAttribute('aria-label')});
  await page.getByRole('link',{name:'Back to Settings'}).click();await page.waitForURL(/screen=settings/);
  interactions.push({check:'Vault back restores link focus',returns:await page.locator('.tile').filter({has:page.getByText('Vault',{exact:true})}).evaluate(e=>e===document.activeElement)});
  await page.locator('[data-brief]').click();
  interactions.push({check:'Evening brief is an unsent editable question',focused:await page.locator('textarea').evaluate(e=>e===document.activeElement),value:await page.locator('textarea').inputValue(),sends:await page.getByRole('button',{name:/send/i}).count()});
  await page.keyboard.press('Escape');
  interactions.push({check:'Brief dialog returns focus',returns:await page.locator('[data-brief]').evaluate(e=>e===document.activeElement)});
  await page.goto(url('chat','ios','light'));await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await page.getByRole('button',{name:'More in Chat'}).click();
  interactions.push({check:'Main phone More has no Search',labels:await page.locator('dialog a').allTextContents()});
  await page.keyboard.press('Escape');
  interactions.push({check:'More returns focus',returns:await page.getByRole('button',{name:'More in Chat'}).evaluate(e=>e===document.activeElement)});
  await page.goto(url('search','ios','light','search'));await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await page.getByRole('button',{name:'Plans 0',exact:true}).click();
  interactions.push({check:'Zero-match filter',text:await page.locator('#results').innerText()});
  await page.goto(url('chat','ios','light','search'));await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await page.getByRole('button',{name:'More in Chat'}).click();
  interactions.push({check:'Phone Search only in decision variant',labels:await page.locator('dialog a').allTextContents()});
  await page.goto(url('chat','web','light'));await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await page.keyboard.press('Control+k');await page.waitForURL(/screen=search/);
  interactions.push({check:'Main keyboard Search keeps decision',variant:new URL(page.url()).searchParams.get('variant'),visibleSearchLinks:await page.getByRole('link',{name:'Search',exact:true}).count()});
  await page.keyboard.press('Escape');await page.waitForURL(/screen=chat/);
  interactions.push({check:'Escape returns from Search',screen:new URL(page.url()).searchParams.get('screen')});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'More in Chat'}).click();
  interactions.push({check:'Narrow web uses shipped phone retention',menu:await page.locator('dialog a').allTextContents(),settledVisible:await page.getByRole('button',{name:'Settled',exact:true}).isVisible()});
  await context.close();
  const gallery=await browser.newPage({viewport:{width:1440,height:900}});
  const galleryErrors=[];gallery.on('pageerror',e=>galleryErrors.push(e.message));
  await gallery.goto(pathToFileURL(resolve(out,'index.html')).href);await gallery.evaluate(()=>document.fonts.ready);
  await gallery.locator('#theme').click();
  interactions.push({check:'Gallery dark theme',theme:await gallery.locator('html').getAttribute('data-theme'),errors:galleryErrors,brokenImages:await gallery.evaluate(()=>[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src))});
} finally {
  await writeFile(resolve(out,'capture.json'),JSON.stringify({records,interactions},null,2)+'\n');
  await browser.close();
}
