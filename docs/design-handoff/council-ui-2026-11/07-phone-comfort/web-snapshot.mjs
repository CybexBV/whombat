// Snapshot the fixture app to static markup; change only the phone's message action access.
// Start Vite with the exact flags recorded in NOTES.md, then run with node --import tsx.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openApp, settle } from '../../../../apps/web/visual/support/harness.ts';
const { chromium } = createRequire(resolve('apps/web/package.json'))('@playwright/test');
const here = new URL('.', import.meta.url);
const browser = await chromium.launch({args:['--disable-lcd-text']});
try {
  const page = await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('whombat:fixture-looks','1'));
  await openApp(page,{path:(process.env.CAPTURE_URL||'http://localhost:5279')+'/chat',theme:'light',width:390,height:844});
  await page.waitForFunction(()=>window.__WHOMBAT__?.services.queryClient.isFetching()===0);
  await settle(page,0);
  await page.evaluate(()=>{for(const el of document.querySelectorAll('body *'))if(el.scrollHeight>el.clientHeight&&/auto|scroll/.test(getComputedStyle(el).overflowY))el.scrollTop=0;});
  await page.screenshot({path:resolve('.whombat/shots/phone-comfort-before-web-light.png'),animations:'disabled'});
  const css = await page.evaluate(()=>[...document.styleSheets].map(s=>{try{return [...s.cssRules].map(r=>r.cssText).join('\n');}catch{return '';}}).join('\n'));
  const sourceCss = css.replace(/url\(["']?\/src\/app\/fonts\/([^"')]+)["']?\)/g,'url("../../../../apps/web/src/app/fonts/$1")');
  await writeFile(new URL('web-snapshot.css',here), '/* Static fixture styles, extracted without changing app sources. Regenerate with web-snapshot.mjs. */\n'+sourceCss+'\n');
  await page.evaluate(()=>{
    for(const e of document.querySelectorAll('script,link[rel="modulepreload"]'))e.remove();
    for(const el of document.querySelectorAll('[data-message-toolbar]')) {
      const row=el.closest('[data-message-row]');
      const author=row.querySelector('[class*="_name_"]')?.textContent || el.getAttribute('aria-label').replace('Actions for ','').replace('’s message','');
      const time=row.querySelector('time')?.textContent || '';
      const canSettle=!!el.querySelector('[data-settle-tool]');
      const person=author==='Mara Okafor';
      const actions=[...(canSettle?['Settle thread']:[]),'Reply in thread','Add reaction','Copy link',...(person?['Edit message']:[]),'Pin to this conversation','Delete message'];
      el.innerHTML='';
      const b=document.createElement('button');b.setAttribute('data-message','');b.setAttribute('aria-label',`Actions for ${author}’s message at ${time}`);b.setAttribute('aria-haspopup','dialog');b.setAttribute('aria-expanded','false');b.setAttribute('aria-controls','message-actions');b.dataset.actions=JSON.stringify(actions);b.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';el.append(b);
      const meta=row.querySelector('time')?.parentElement;if(meta)meta.setAttribute('data-action-meta','');
    }
    // Prevent the static snapshot from navigating into app routes.
    for(const a of document.querySelectorAll('a'))a.removeAttribute('href');
    document.querySelector('vite-error-overlay')?.remove();
  });
  const html = (await page.locator('body').innerHTML()).replaceAll(new URL(page.url()).origin+'/@fs'+resolve('.')+'/', '../../../../');
  await writeFile(new URL('web.html',here),`<!doctype html>\n<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Whombat · phone web message actions · static fixture snapshot</title><link rel="stylesheet" href="web-snapshot.css"><link rel="stylesheet" href="web.css"></head><body>${html}\n<dialog id="message-actions" aria-labelledby="actions-title"><div class="actions-head"><h2 id="actions-title">Message actions</h2><button aria-label="Close" data-close>×</button></div><div id="actions-list"></div></dialog><script src="web.js"></script></body></html>\n`);
  await page.evaluate(()=>{localStorage.setItem('whombat:theme','dark');document.documentElement.dataset.theme='dark';});
  await page.screenshot({path:resolve('.whombat/shots/phone-comfort-before-web-dark.png'),animations:'disabled'});
} finally { await browser.close(); }
