// Static proposals only. Existing before pictures remain in 01-groundwork/png.
// Run from the repository root: node --import tsx docs/design-handoff/council-ui-2026-11/07-phone-comfort/capture.mjs
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(resolve('apps/web/package.json'));
const { chromium } = require('@playwright/test');
const { PNG } = createRequire(resolve('tools/visual/package.json'))('pngjs');
const here = new URL('.', import.meta.url);
const dir = fileURLToPath(here);
const contrast = await readFile(new URL('../01-groundwork/contrast.js', here), 'utf8');
const browser = await chromium.launch({ args: ['--disable-lcd-text','--allow-file-access-from-files'] });
const records = [], interactions = [];
const failures = [];
function check(value, message) { if(!value) failures.push(message); }
const context = await browser.newContext({ locale:'en-GB', timezoneId:'Europe/Amsterdam', deviceScaleFactor:1, reducedMotion:'reduce' });
const page = await context.newPage();
await context.addInitScript(()=>{ const RealDate=Date; const now=RealDate.parse('2026-09-23T09:22:00Z'); window.Date=class extends RealDate { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }; });
page.on('pageerror', e=>failures.push(e.message));
page.on('requestfailed', r=>failures.push(`Asset did not load: ${r.url()}: ${r.failure()?.errorText}`));
const loaded = async () => {
  await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].every(f=>f.contentDocument?.readyState==='complete' && f.contentWindow.location.href===f.src));
  for(const frame of page.frames()) await frame.evaluate(async()=>{await Promise.all([document.fonts.load('600 24px "Bricolage Grotesque"'),document.fonts.load('400 12px "DM Mono"')]);await document.fonts.ready;});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
};
try {
  await mkdir(resolve('.whombat/shots'), {recursive:true});
  for(const theme of ['light','dark']) {
    for(const platform of ['ios','android','web']) {
      for(const variant of (platform==='web'?['main']:['main','raised'])) {
        const screens=platform==='web'?['chat']:['chat','thread','approval','council','delegation','side','desk'];
        for(const screen of screens) {
          await page.setViewportSize({width:390,height:844});
          const url = new URL(platform==='web'?`web.html?theme=${theme}`:`mockup.html?platform=${platform}&screen=${screen}&theme=${theme}&variant=${variant}`,here).href;
          await page.goto(url); await loaded();
          const metrics=await page.evaluate((platform)=>{
            const phone=document.querySelector('.phone') || document.body;
            const targets=[...document.querySelectorAll(platform==='web'?'[data-message],dialog[open] button':'button,a,summary')].filter(e=>e.getClientRects().length && !e.closest('dialog:not([open])'));
            const small=targets.filter(e=>{const r=e.getBoundingClientRect();return r.width<43.9||r.height<(phone.classList.contains('android')?47.9:43.9);}).map(e=>({name:e.textContent||e.getAttribute('aria-label'),rect:[e.getBoundingClientRect().width,e.getBoundingClientRect().height]}));
            return {viewport:[innerWidth,innerHeight],fontScale:getComputedStyle(phone).getPropertyValue('--scale').trim(),overflow:document.documentElement.scrollWidth>390,smallTargets:small,desk:document.querySelector('.desk-preview')?.getBoundingClientRect().toJSON(),fonts:document.fonts.check('600 24px "Bricolage Grotesque"') && document.fonts.check('400 12px "DM Mono"')};
          }, platform);
          check(!metrics.overflow,`${platform}/${screen}/${theme}/${variant}: horizontal overflow`);
          check(metrics.smallTargets.length===0,`${platform}/${screen}/${theme}/${variant}: small controls ${JSON.stringify(metrics.smallTargets)}`);
          check(metrics.fonts,`${platform}/${screen}: fonts missing`);
          const measure=await page.evaluate(contrast+'\nmeasureContrast()');
          check(measure.failures.length===0,`${platform}/${screen}/${theme}/${variant}: text contrast ${JSON.stringify(measure.failures)}`);
          // Measure all content after a deliberate scroll; fixed chrome remains in the viewport.
          await page.evaluate(()=>{const els=document.querySelectorAll('body *');for(const el of els)if(el.scrollHeight>el.clientHeight&&/auto|scroll/.test(getComputedStyle(el).overflowY))el.scrollTop=el.scrollHeight;});
          const below=await page.evaluate(contrast+'\nmeasureContrast()');
          check(below.failures.length===0,`${platform}/${screen}/${theme}/${variant}: lower text contrast`);
          await page.evaluate(()=>{const els=document.querySelectorAll('body *');for(const el of els)if(el.scrollHeight>el.clientHeight&&/auto|scroll/.test(getComputedStyle(el).overflowY))el.scrollTop=0;});
          const record={platform,screen,theme,variant,metrics,measure,below};
          records.push(record);
          await page.screenshot({path:resolve('.whombat/shots',`phone-comfort-${platform}-${screen}-${variant}-${theme}.png`),animations:'disabled'});
          if(platform!=='web' && ['council','approval','delegation'].includes(screen)) {
            for(const summary of await page.locator('details > summary').all()) {await summary.click();check(await summary.evaluate(e=>e===document.activeElement),'Expansion moved focus');}
            record.expanded=await page.evaluate(contrast+'\nmeasureContrast()');
            check(record.expanded.failures.length===0,`${platform}/${screen}/${theme}/${variant}: expanded contrast`);
            await page.screenshot({path:resolve('.whombat/shots',`phone-comfort-${platform}-${screen}-${variant}-${theme}-expanded.png`),animations:'disabled'});
          }
          if(platform==='web') {
            const button=page.locator('[data-message]').first();
            await button.focus(); await page.keyboard.press('Enter');
            check(await page.locator('dialog').evaluate(e=>e.open),'Message actions did not open');
            check(await page.evaluate(()=>document.activeElement.textContent==='Reply in thread'),'First action did not receive focus');
            const open=await page.evaluate(contrast+'\nmeasureContrast()');
            check(open.failures.length===0,'Open message sheet contrast');
            await page.keyboard.press('Escape');
            check(await button.evaluate(e=>e===document.activeElement),'Message focus did not return');
            await page.keyboard.press('Space');
            await page.getByRole('button',{name:'Close',exact:true}).click();
            check(await button.evaluate(e=>e===document.activeElement),'Close focus did not return');
            interactions.push({theme,variant,openedWithEnter:true,openedWithSpace:true,escapeReturns:true,closeReturns:true,contrast:open.minimum});
          }
        }
      }
    }
    for(const plate of ['ios-main','android-main','rows','web-actions','raised-cap']) {
      await page.setViewportSize({width:1440,height:900});
      await page.goto(new URL(`plates.html?plate=${plate}&theme=${theme}`,here).href); await loaded();
      const name=`${plate}-${theme}.png`;
      await page.screenshot({path:resolve(dir,'png',name),animations:'disabled'});
      const compressed = PNG.sync.write(PNG.sync.read(await readFile(resolve(dir,'png',name))),{deflateLevel:9,filterType:-1});
      await writeFile(resolve(dir,'png',name),compressed);
      await copyFile(resolve(dir,'png',name),resolve('.whombat/shots',`phone-comfort-${name}`));
    }
    await page.goto(new URL(`index.html?platform=web&screen=chat&theme=${theme}`,here).href); await loaded();
    check(await page.locator('#before img').count()===1,'Before comparison image missing');
    await page.locator('#platform').selectOption('ios'); await loaded();
    check(await page.locator('#before .gap').count()===1,'Native GAP missing');
    await page.screenshot({path:resolve('.whombat/shots',`phone-comfort-gallery-${theme}.png`),animations:'disabled'});
    const gallery=await page.evaluate(contrast+'\nmeasureContrast()');
    check(gallery.failures.length===0,'Gallery contrast');
  }
} finally {
  await writeFile(new URL('verification.json',here),JSON.stringify({clock:'2026-09-23T09:22:00Z',engine:'Playwright Chromium',records,interactions,failures},null,2)+'\n');
  await browser.close();
}
console.log(JSON.stringify({renders:records.length,interactions:interactions.length,failures},null,2));
if(failures.length) process.exitCode=1;
