// Static drawings; no API, storage, service control or messages are sent.
const q = new URLSearchParams(location.search);
const screen = q.get('screen') || 'connection';
const platform = q.get('platform') || 'web';
const theme = q.get('theme') || 'light';
const state = q.get('state') || 'normal';
const variant = q.get('variant') || 'folded';
const native = ['android','ios'].includes(platform);
const phoneWeb = platform === 'phone-web';
const F = REVIEW_FIXTURE;
const assistant = F.assistant;
const e = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const url = (s, extra = {}) => 'mockup.html?' + new URLSearchParams({ screen:s, platform, theme, ...extra });
document.documentElement.dataset.theme = theme;
document.body.className = `${native ? 'native ' + platform : phoneWeb ? 'web phone-web' : 'web'}${q.has('large') ? ' large' : ''}`;
document.title = `${screen === 'connection' ? 'Home Assistant' : screen === 'usage' ? 'Usage' : 'Settings'} · ${platform} · ${theme} · static drawing`;
const paths = {
  arrow:'M19 12H5m7-7-7 7 7 7', chevron:'m15 18-6-6 6-6', plug:'M9 3v5m6-5v5M7 8h10v4a5 5 0 0 1-10 0V8Zm5 9v4',
  log:'M4 6h16M4 12h12M4 18h8', info:'M12 8h.01M12 11v5M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  warn:'m12 3 10 18H2L12 3Zm0 6v4m0 4h.01', disk:'M4 6c0-4 16-4 16 0v12c0 4-16 4-16 0V6Zm0 0c0 4 16 4 16 0',
  chat:'M21 11a9 9 0 0 1-9 9H4l-3 2 2-6a9 9 0 1 1 18-5', inbox:'M4 4h16l2 12v4H2v-4L4 4Zm-2 12h6l2 3h4l2-3h6',
  grid:'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7', bolt:'m13 2-9 12h7l-1 8 10-13h-7l1-7', settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.info}"/></svg>`;
const button = (label, message, cls = '', name = '') => `<button class="${cls}" data-preview="${e(message)}"${name ? ` aria-label="${e(name)}"` : ''}>${e(label)}</button>`;
const ask = () => button(`Ask ${assistant}`, `Opens the existing Home Assistant conversation with ${assistant}. Back returns here with the same scroll position.`);
const review = text => `<aside class="review${text.includes('Decision for John') || text.startsWith('Keeps ') ? ' decision-note' : ''}" aria-label="Review annotation">${text}</aside>`;
const sidebar = () => `<aside class="sidebar" aria-label="Existing sidebar, retained as fixture pixels"><img src="png/before-web-${screen}-${theme}.png" alt="" aria-hidden="true"><a class="settings-link" href="${url('settings')}" ${screen !== 'connection' ? 'aria-current="page"' : ''} aria-label="Mara Okafor, Settings"><span class="avatar" aria-hidden="true">MO</span><span><b>Mara Okafor</b><small data-measure="settings-selected">Settings</small></span></a></aside>`;
const back = (label, dest) => `<a class="back" href="${dest}" aria-label="Back to ${label}">${icon(platform === 'android' ? 'arrow' : 'chevron')}${platform === 'android' ? '' : e(label)}</a>`;
const webChrome = () => `<header class="phone-web-bar"><img src="png/before-phone-web-${screen}-${theme}.png" alt="" aria-hidden="true"><button aria-label="Open navigation" data-preview="Opens the existing web navigation drawer."></button><button aria-label="7 things need you, open Inbox" data-preview="Opens the existing Inbox."></button></header>`;
const chrome = () => `<div class="phone-chrome" aria-hidden="true"><span>11:22</span><span>▰ ▰</span></div>`;
const tabs = selected => `<nav class="tabs" aria-label="Settings groups">${['You',assistant,'Connections','This Whombat','Advanced'].map(t => `<a href="${url('settings', { state:t === 'Advanced' ? 'advanced' : 'normal' })}" ${t === selected ? 'aria-current="page"' : ''}>${e(t)}</a>`).join('')}</nav>`;
function failure(scope, saved) {
  return `<section class="error" role="status" aria-label="${e(scope)} read problem"><h2>Couldn’t ${saved ? 'refresh' : 'read'} ${e(scope)}</h2><p>${saved ? (screen === 'connection' ? 'Showing the last readings from 11:10. They may be out of date.' : 'Showing the saved totals from 11:22. Newer work may be missing.') : 'There’s no saved copy to show on this device yet.'}</p><div class="actions"><button data-retry aria-label="Try reading ${e(scope)} again">Try again</button>${button(`Ask ${assistant}`, `Opens Chat with a draft question about reading ${scope}. No message is sent by this drawing.`)}</div><details><summary>More detail</summary><pre>${e(screen === 'connection' ? 'Home Assistant read did not answer.' : 'spend.overview did not answer.')}</pre></details></section>`;
}
const notices = F.thing.tabs[0].panels.find(p => p.kind === 'notices').items;
const byId = id => notices.find(n => n.id === id);
const now = ['integrations','log','repairs'].map(byId);
const soon = ['disk','update','recorder','zigbee','cert','backup-age'].map(byId);
function notice(n) {
  const action = n.link ? button(n.link.kind === 'ask' ? `Ask ${assistant}` : 'Show', `Opens the existing ${n.link.kind === 'ask' ? 'Home Assistant conversation' : 'Home Assistant Log tab'}. No service action is sent.`, '', `${n.link.kind === 'ask' ? 'Ask ' + assistant + ' about' : 'Show'} ${n.title}`) : '';
  return `<div class="notice-row"><span class="tile ${n.tone === 'bad' ? 'broken' : ''}" aria-hidden="true">${icon(n.icon)}</span><p>${state==='partial'&&n.id==='log'?'<span class="muted">Last saved log · </span>':''}<b>${e(n.title)}</b> ${e(n.detail || '')}${state==='partial'&&n.id==='log'?'<br><span class="muted">Couldn’t read the log this time.</span>':''}</p>${action}</div>`;
}
function connection() {
  const research = F.thing.research;
  const partial = state === 'partial';
  const stale = state === 'stale';
  const noCopy = state === 'no-copy';
  const keep = variant === 'keep';
  return `<main class="main">
    ${back(native ? 'Overview' : 'Connections','#').replace('href="#"','href="#" data-preview="Opens the existing Overview. This static drawing stays here."')}
    ${review(keep ? 'Keeps UIR-70 · two “SOON” heads-ups stay in sight. Contrast and read-recovery proposal only.' : 'Decision for John — reopens UIR-70 · heads-ups fold under one row, as QN-27 specifies.')}
    <header class="head"><span class="logo"><img src="../../../../packages/brand/assets/marks/homeassistant.svg" alt=""></span><div class="head-copy"><h1>Home Assistant</h1><div class="facts"><span class="pill" data-measure="pill"><i class="dot" aria-hidden="true"></i>Needs a look</span><span>Runs in <a href="#" data-preview="Opens homeassistant on pve-02, CT 131.">homeassistant on pve-02</a></span>${native ? '' : '<a href="#" data-preview="Opens the existing runs-on picker.">Change</a>'}<button data-preview="Copies the existing Home Assistant address. No network request." aria-label="Copy address 10.100.0.5:8123">10.100.0.5:8123</button><span>${stale || noCopy ? 'Last check unavailable' : 'Checked 2 min ago'}</span></div><details><summary>More detail</summary><p>Home Assistant 2026.10.2 · Docker<br>MariaDB 10.11 · Up 3 d 7 h</p></details></div><div class="actions">${ask().replace('class=""','class="primary"')}${button(native ? 'Open' : 'Open Home Assistant','Opens Home Assistant’s own page. This drawing stays here.','','Open Home Assistant')}${native ? '' : button('⋯','Opens the existing Home Assistant menu.','','More for Home Assistant')}</div></header>
    ${stale || noCopy ? failure('Home Assistant',!noCopy) : partial ? `<section class="error" role="status" aria-label="Partly read Home Assistant"><h2>Some readings couldn’t be read</h2><p>The log couldn’t be read. Other readings are from 11:22.</p><div class="actions"><button data-retry aria-label="Try reading Home Assistant again">Try again</button>${ask()}</div><details><summary>More detail</summary><p>Home Assistant’s log read did not answer.</p></details></section>` : state === 'refreshing' ? '<p class="refresh" role="status">Refreshing · keeping the last readings in place</p>' : ''}
    <nav class="tabs" aria-label="Home Assistant pages">${['Summary','Integrations','Log','Backups','Activity','Connection'].map((t,i)=>`<a href="#" ${!i ? 'aria-current="page"' : `data-preview="Opens the existing ${t} tab."`}>${t}${t==='Integrations'?'<small>102</small>':''}</a>`).join('')}</nav>
    ${noCopy ? '' : `<section class="research" aria-labelledby="research-title" data-measure="gradient"><h2 id="research-title"><i class="dot" aria-hidden="true"></i>${e(research.title)}</h2><div class="assistant-line"><img src="../../../../packages/avatars/svg/operator-head-small.svg" alt="${e(assistant)}"><p>${e(research.summary)}</p></div><div class="actions">${button(research.fix,'Opens the existing research thread for this proposed step. Existing approval and confirmation rules still apply.','primary')}${button(`Ask ${assistant}`,`Opens the same research thread with ${assistant}.`,'plain')}</div></section>
    <section class="panel" aria-label="Worth a look"><div class="band" aria-hidden="true">Worth a look</div>${now.map(notice).join('')}${keep ? `<p class="eyebrow soon">Soon</p>${soon.slice(0,2).map(notice).join('')}<details class="notice-fold"><summary>Show 4 more</summary>${soon.slice(2).map(notice).join('')}</details>` : `<details class="notice-fold" id="heads-ups"><summary>Show 6 heads-ups</summary>${soon.map(notice).join('')}</details>`}</section>
    <section class="panel pad context-rows" aria-label="Existing Home Assistant summary"><h2>In Home Assistant</h2>${F.thing.tabs[0].panels.find(p=>p.id==='inventory').items.map(n=>`<p>${e(n.title)}<b>${e(n.right)}</b></p>`).join('')}<p class="muted">${stale ? 'Last readings 11:10 · 12 min ago' : 'Readings from 11:22'}</p></section>`}
  </main>`;
}
function usage() {
  const keep = variant === 'keep';
  const name = keep ? 'Spend' : 'Usage';
  const noCopy = state === 'no-copy';
  const error = state === 'read' || noCopy;
  const tiles = [['today','Today','Since 00:00 today'],['week','7 days','16–23 September'],['month','30 days','24 August–23 September']];
  const tokens = n => n < 999500 ? Math.round(n/1000)+'k' : (n/1000000).toFixed(1)+'M';
  return `<main class="main settings-main">${native ? back('Advanced',url('settings',{state:'advanced'})) : `<h1>Settings</h1><p class="settings-intro">You, ${e(assistant)} and this Whombat. Expert settings are under Advanced.</p>${tabs('Advanced')}${back('Advanced',url('settings',{state:'advanced'}))}`}
    ${review(keep ? 'Keeps STG-03, STG-10, STG-12 · the destination is still called Spend.' : 'Decision for John — reopens STG-03, STG-10, STG-12 · one name, Usage, in Advanced and on this page. Existing addresses stay.')}
    <header class="usage-title">${native ? `<h1>${name}</h1>` : `<h2>${name}</h2>`}<p>AI work ${e(assistant)} recorded here.</p></header>
    ${error ? failure('usage',!noCopy) : state === 'refreshing' ? '<p class="refresh" role="status">Refreshing · keeping the saved totals in place</p>' : ''}
    ${noCopy ? '' : `<div class="freshness"><p>Totals prepared at 11:22 · 23 September 2026<br>Not live · Europe/Amsterdam</p><button data-retry aria-label="Refresh recorded usage">Refresh</button></div><div class="source-line"><span>All providers combined</span><span>Recorded tasks only · provider names aren’t included</span></div><section aria-label="Recorded usage totals"><p class="eyebrow">${name}</p><div class="totals">${tiles.map(([key,label,window])=>{const t=F.spend.totals[key];return `<article class="total" aria-label="${label}: ${tokens(t.inputTokens+t.outputTokens)} tokens, ${t.turns} tasks, about $${t.costUsd.toFixed(2)}"><h3>${label}</h3><div class="value">${tokens(t.inputTokens+t.outputTokens)} <small>tokens</small></div><p>${t.turns} tasks · about $${t.costUsd.toFixed(2)}</p><div class="window">${window}</div></article>`;}).join('')}</div><p class="hint">Estimates from what the AI providers report, not a bill; costs cover 111 of 177 tasks, and 2 tasks reported no usage.</p></section><details class="usage-more"><summary>More about these numbers</summary><p>Today starts at midnight in Europe/Amsterdam. The other totals cover the last 7 and 30 days, ending at 11:22 on 23 September. A task counts when it finishes.</p><p>These totals describe work recorded by this Whombat. They don’t show a provider’s whole account or its remaining allowance.</p></details>`}
    ${state === 'provider' ? review('<strong>Marked variant — needs new data</strong><br>Provider name: needs new data<br>Provider window: needs new data<br>Provider last successful read: needs new data<br>Remaining allowance: needs new data<br>No values are inferred from a sign-in or the totals above.') : ''}
  </main>`;
}
function settings() {
  const name = variant === 'keep' ? 'Spend' : 'Usage';
  const advanced = state === 'advanced';
  if (!native && !advanced) return `<main><img class="settings-baseline" src="png/before-${phoneWeb ? 'phone-web' : 'web'}-settings-${theme}.png" alt="Unchanged fixture Settings page, You group: profile and Settle quiet threads. Only the sidebar Settings sublabel is overlaid with ink2."><aside class="review settings-caption">${phoneWeb ? 'Phone-width web · sidebar closed<br><b>Retains the existing Settings page</b>' : 'Selected Settings sublabel<br><b>Same surface · opaque ink2</b>'}<p>The person’s name, selection and menu stay where they are.</p><a class="button" href="${url('settings',{state:'advanced'})}">Open Advanced</a></aside></main>`;
  return `<main class="main settings-main">${native ? (advanced ? back('Settings',url('settings')) : '') : ''}<h1>${advanced ? 'Advanced' : 'Settings'}</h1>${!native ? tabs('Advanced') : ''}${advanced ? `<p class="settings-intro">Settings for people who like to look under the hood. Nothing here needs changing for Whombat to work.</p>${review(name==='Usage' ? 'Decision for John — reopens STG-03, STG-10, STG-12 · the existing Spend row is named Usage.' : 'Keeps STG-03, STG-10, STG-12 · existing Spend name.')}<details class="panel" aria-label="${e(assistant)}’s AI" open><summary class="band">${e(assistant.toUpperCase())}’S AI</summary>${['Model and effort','AI on this Whombat',name].map(t=>`<a class="entry" href="${url(t===name ? 'usage' : 'settings',{state:t===name?'normal':'advanced',variant})}"><span>${t}${t===name?`<p>How much AI ${e(assistant)} used.</p>`:''}</span><span aria-hidden="true">›</span></a>`).join('')}</details>` : `<p class="settings-intro">You, ${e(assistant)} and this Whombat.</p><section class="panel" aria-label="Settings groups">${['You',assistant,'Connections','This Whombat','Advanced'].map(t=>`<a class="entry" href="${url('settings',{state:t==='Advanced'?'advanced':'normal'})}"><span>${e(t)}</span><span aria-hidden="true">›</span></a>`).join('')}</section><p class="review">Native drawing · keeps the five groups and tabs. The selected Settings words use ink2 at full opacity.</p><nav class="tabbar" aria-label="Main tabs">${[['Chat','chat'],['Inbox','inbox'],['Overview','grid'],['Automations','bolt'],['Settings','settings']].map(([t,i])=>`<a href="#" ${t==='Settings'?'aria-current="page"':`data-preview="Opens ${t}."`}>${icon(i)}${t}</a>`).join('')}</nav>`}</main>`;
}
document.querySelector('#app').innerHTML = (native ? chrome() : phoneWeb ? webChrome() : '') + (screen==='settings' && !native && state!=='advanced' ? '' : !native && !phoneWeb ? sidebar() : '') + (screen==='connection'?connection():screen==='usage'?usage():settings());
if(screen==='connection'&&state==='no-copy') {
  document.querySelector('.head .facts')?.remove();
  document.querySelector('.head details')?.remove();
  document.querySelector('.head > .actions')?.remove();
  document.querySelector('nav[aria-label="Home Assistant pages"]')?.remove();
}
// Settings retains the whole original page as pixels, with only its selected row overlaid.
if (screen==='settings' && !native && !phoneWeb && state!=='advanced') document.querySelector('#app').insertAdjacentHTML('beforeend',sidebar());
if (phoneWeb) document.querySelector('.tabs a[aria-current]')?.scrollIntoView({block:'nearest',inline:'nearest'});
const dialog = document.querySelector('dialog');
let opener;
document.addEventListener('click',event=>{
  const action = event.target.closest('[data-preview]');
  if (action) {
    event.preventDefault(); opener=action;
    document.querySelector('#preview-message').textContent=action.dataset.preview;
    dialog.showModal();
  }
  const retry = event.target.closest('[data-retry]');
  if (retry) {
    const old=retry.textContent;
    retry.textContent='Refreshing';
    const region=retry.closest('.error') || retry.closest('.freshness');
    region.setAttribute('aria-busy','true');
    region.setAttribute('role','status');
    // Deliberately no pretend successful response in a static mockup.
    retry.dataset.preview=`This repeats only the read. The drawing has no live response. Original label: ${old}.`;
  }
});
document.querySelector('#close-dialog').addEventListener('click',()=>dialog.close());
dialog.addEventListener('close',()=>opener?.focus());
