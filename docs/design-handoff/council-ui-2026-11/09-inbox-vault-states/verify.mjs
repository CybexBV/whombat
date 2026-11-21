// Mockup-only render audit; does not add application tests or change visual baselines.
import { readFile,writeFile,copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require=createRequire(resolve('apps/web/package.json'));
const {chromium}=require('@playwright/test');
const out=fileURLToPath(new URL('.',import.meta.url));
const base=process.env.REVIEW_URL||'http://127.0.0.1:5399/docs/design-handoff/council-ui-2026-11/09-inbox-vault-states/';
const contrast=await readFile(resolve(out,'../01-groundwork/contrast.js'),'utf8');
const states={inbox:['normal','empty','loading','error','handling','headsups','settle'],vault:['normal','closed','locked','empty','loading','open','entry-loading','entry-error','reveal-error','copied']};
const report={renders:[],interactions:[],errors:[]};
const browser=await chromium.launch({args:['--disable-lcd-text']});
const check=(name,pass)=>{report.interactions.push({name,pass});if(!pass)report.errors.push(name);};
try{
  for(const platform of ['web','ios','android'])for(const theme of ['light','dark']){
    const context=await browser.newContext({viewport:{width:platform==='web'?1440:390,height:platform==='web'?900:844},locale:'en-GB',timezoneId:'Europe/Amsterdam',deviceScaleFactor:1,reducedMotion:'reduce'});
    const page=await context.newPage();
    page.on('pageerror',e=>report.errors.push(e.message));
    page.on('response',r=>{if(r.status()>=400)report.errors.push('HTTP '+r.status()+' '+r.url());});
    for(const [screen,list]of Object.entries(states))for(const state of list){
      const url=base+'mockup.html?'+new URLSearchParams({screen,state,platform,theme});
      await page.goto(url);await page.evaluate(async()=>{await document.fonts.ready;await document.fonts.load('12px "DM Mono"');await document.fonts.load('16px "Bricolage Grotesque"');});
      const fonts=await page.evaluate(()=>document.fonts.check('16px "Bricolage Grotesque"')&&document.fonts.check('12px "DM Mono"'));
      const measure=await page.evaluate(contrast+'\nmeasureContrast()');
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
      if(measure.failures.length)report.errors.push(`${platform}/${theme}/${screen}/${state}: contrast ${JSON.stringify(measure.failures)}`);
      if(overflow||!fonts)report.errors.push(`${platform}/${theme}/${screen}/${state}: overflow/font`);
      const save=platform==='web'?screen==='inbox'?['normal','error','settle'].includes(state):['normal','open','entry-error'].includes(state):screen==='inbox'?state==='settle':state==='entry-error';
      const file=save?`after-${platform}-${screen}-${state}-${theme}.png`:null;
      if(file){await page.screenshot({path:resolve(out,'png',file),animations:'disabled'});await copyFile(resolve(out,'png',file),resolve('.whombat/shots',file));}
      await page.locator('.scroll').evaluate(el=>el.scrollTop=el.scrollHeight);
      const bottom=await page.evaluate(contrast+'\nmeasureContrast()');
      if(bottom.failures.length)report.errors.push(`${platform}/${theme}/${screen}/${state}: bottom contrast ${JSON.stringify(bottom.failures)}`);
      report.renders.push({platform,theme,screen,state,file,fonts,overflow,minimum:Math.min(measure.minimum,bottom.minimum),pairs:measure.pairs,bottomPairs:bottom.pairs,text:await page.locator('.page').innerText()});
      await page.goto(url+'&text=large');await page.evaluate(async()=>{await document.fonts.ready;await document.fonts.load('12px "DM Mono"');await document.fonts.load('16px "Bricolage Grotesque"');});
      const largeOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.querySelector('.scroll').scrollWidth>document.querySelector('.scroll').clientWidth);
      check(`200% text: ${platform}/${theme}/${screen}/${state}`,!largeOverflow);
    }
    await page.goto(base+`mockup.html?screen=inbox&state=normal&platform=${platform}&theme=${theme}`);
    if(platform==='web'){
      await page.locator('[data-action="settle:ny_alert-blackbox"]').click();
      check(`Settle focus: ${platform}/${theme}`,await page.evaluate(()=>document.activeElement.closest('[data-row]')?.dataset.row==='ny_approval-901'));
      await page.getByRole('button',{name:'Undo',exact:true}).click();
      check(`Undo focus: ${platform}/${theme}`,await page.evaluate(()=>document.activeElement.dataset.action==='settle:ny_alert-blackbox'));
    }else{
      const opener=page.locator('[data-row="ny_alert-blackbox"] .row-open');
      await opener.click();await page.getByRole('button',{name:'Close item'}).click();
      check(`Native sheet focus: ${platform}/${theme}`,await opener.evaluate(el=>el===document.activeElement));
      await opener.click();await page.locator('[data-action="sheet-settle:ny_alert-blackbox"]').click();
      check(`Native Settle row return: ${platform}/${theme}`,await page.evaluate(()=>document.activeElement.closest('[data-row]')?.dataset.row==='ny_approval-901'));
      await page.getByRole('button',{name:'Undo',exact:true}).click();
      check(`Native Undo row return: ${platform}/${theme}`,await page.evaluate(()=>document.activeElement.closest('[data-row]')?.dataset.row==='ny_alert-blackbox'));
    }
    await page.locator('[data-action="heads"]').click();
    check(`Heads-ups expansion/focus: ${platform}/${theme}`,await page.evaluate(()=>document.activeElement.dataset.action==='heads'&&document.activeElement.getAttribute('aria-expanded')==='true'&&!document.querySelector('#heads-rows').hidden));
    await page.locator('[data-action="settled"]').click();
    check(`Empty Settled opens: ${platform}/${theme}`,await page.locator('#settled-rows').isVisible());
    await page.goto(base+`mockup.html?screen=vault&state=entry-error&platform=${platform}&theme=${theme}`);
    await page.getByRole('button',{name:platform==='web'?'Close entry':'Back to Vault',exact:true}).last().click();
    check(`Entry close focus: ${platform}/${theme}`,await page.evaluate(()=>document.activeElement.id==='vlt_grafana'));
    await page.goto(base+`mockup.html?screen=vault&state=entry-error&platform=${platform}&theme=${theme}`);
    const retry=page.getByRole('button',{name:'Try reading this Vault entry again'});
    await retry.click();
    check(`Read retry retains focus: ${platform}/${theme}`,await retry.evaluate(el=>el===document.activeElement));
    await page.locator('summary').first().click();
    check(`Diagnostics fold: ${platform}/${theme}`,await page.getByText('The fixture read did not answer.',{exact:true}).isVisible());
    await page.goto(base+`mockup.html?screen=vault&state=reveal-error&platform=${platform}&theme=${theme}`);
    check(`Reveal has exit, no unsafe retry: ${platform}/${theme}`,await page.getByRole('button',{name:platform==='web'?'Close entry':'Back to Vault',exact:true}).last().isVisible()&&await page.getByRole('button',{name:/Try reading/}).count()===0);
    if(platform!=='web'){
      await page.goto(base+`mockup.html?screen=inbox&state=settle&platform=${platform}&theme=${theme}`);
      check(`Native Inbox count: ${platform}/${theme}`,await page.locator('.tabbar .badge').textContent()==='5');
    }
    await context.close();
  }
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  for(const theme of ['light','dark']){
    await page.goto(base+'index.html?theme='+theme);await page.evaluate(async()=>{await document.fonts.ready;await document.fonts.load('12px "DM Mono"');await document.fonts.load('16px "Bricolage Grotesque"');});
    const measure=await page.evaluate(contrast+'\nmeasureContrast()');
    check('Gallery contrast '+theme,!measure.failures.length);
    await page.selectOption('#platform','ios');
    check('Native GAP '+theme,await page.locator('#gap').isVisible());
    await page.selectOption('#screen','vault');await page.selectOption('#state','reveal-error');
    check('Reveal keeps-decision sibling '+theme,await page.locator('#decision').isVisible());
    report.galleryMinimum??={};report.galleryMinimum[theme]=measure.minimum;
  }
  await writeFile(resolve(out,'verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({renders:report.renders.length,interactions:report.interactions.length,minima:Object.fromEntries(['light','dark'].map(t=>[t,Math.min(...report.renders.filter(r=>r.theme===t).map(r=>r.minimum))])),errors:report.errors},null,2));
  if(report.errors.length)process.exitCode=1;
}finally{await browser.close();}
