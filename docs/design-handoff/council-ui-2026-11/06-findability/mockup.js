/* Static review prototype. It reads fixture snapshots only and never contacts a Whombat. */
const D = window.FINDABILITY_FIXTURE;
const params = new URLSearchParams(location.search);
const platform = params.get('platform') || 'web';
const phone = platform !== 'web';
const theme = params.get('theme') || 'light';
const screen = params.get('screen') || (phone ? 'settings' : 'chat');
const variant = params.get('variant') || 'main';
document.documentElement.dataset.theme = theme;
document.documentElement.classList.toggle('large', params.get('text') === 'largest');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const A = esc(D.assistant);
const paths = {
  chat:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  inbox:'m4 4-3 10v6h22v-6L20 4ZM1 14h6l2 3h6l2-3h6',
  overview:'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  automations:'m13 2-10 12h8l-1 8 11-12h-8Z',
  files:'M3 7V4h6l2 3h10v13H3ZM3 7h18',
  vault:'M5 10h14v11H5ZM8 10V7a4 4 0 0 1 8 0v3',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  moon:'M20 13A8 8 0 0 1 11 3a9 9 0 1 0 9 10',
  arrow:'m12 5-7 7 7 7M5 12h15',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.settings}"/></svg>`;
function href(to,extra={}) {
  const q = new URLSearchParams({platform,theme,screen:to,variant:variant==='search'?'search':'main',...extra});
  if (params.has('text')) q.set('text',params.get('text'));
  return `mockup.html?${q}`;
}
const existing = (title,body='') => `data-existing="${esc(title)}" data-body="${esc(body)}"`;
const nav = (id,label,extra='') => `<a href="${href(id,id === 'search' ? {variant:'search'} : {})}" ${screen===id?'aria-current="page"':''} class="${id==='overview'?'gap':''}">${icon(id)}<span>${label}</span>${extra}</a>`;
function sidebar(){
  return `<aside class="sidebar" aria-label="Whombat navigation"><a class="burrow" ${existing('Burrow HQ')} href="#"> <img src="../../../../apps/web/public/favicon.svg" alt="">Burrow HQ</a><nav class="nav" aria-label="Whombat">
    ${variant==='search'?nav('search','Search','<span class="key">⌘K</span>'):''}
    ${nav('chat','Chat')}${`<a href="#" ${existing('Inbox')} >${icon('inbox')}Inbox<span class="badge">7</span></a>`}${nav('overview','Overview')}${`<a href="#" ${existing('Automations')}>${icon('automations')}Automations</a>`}${nav('files','Files')}${nav('vault','Vault')}
    </nav><div class="kept-lists"><img src="png/before-web-chat-${theme}.png" alt="Unchanged server and connection navigation: thetitan, pve-01, pve-02, blackbox, the-falcon, Home Assistant, UniFi. Status marks retain the captured fixture state."></div>
    <a class="account" href="${href('settings')}" aria-label="Mara Okafor, Settings" ${screen==='settings'?'aria-current="page"':''}><img src="png/before-web-chat-${theme}.png" alt=""></a></aside>`;
}
function tabs(){
  return `<nav class="tabbar" aria-label="Main tabs">${['chat','inbox','overview','automations','settings'].map((id)=>`<a href="${['inbox','automations','overview'].includes(id)?'#':href(id)}" ${['inbox','automations','overview'].includes(id)?existing(id==='inbox'?'Inbox':id==='overview'?'Overview':'Automations',id==='overview'?'Servers · Connections · Pinned':''):''} ${screen===id?'aria-current="page"':''} ${id==='inbox'?'aria-label="Inbox, 7 things need you, something is not working"':''}><span class="tab-icon">${icon(id)}${id==='inbox'?'<span class="tab-badge" aria-hidden="true">7</span>':''}</span>${id==='chat'?'Chat':id==='inbox'?'Inbox':id==='overview'?'Overview':id==='automations'?'Automations':'Settings'}</a>`).join('')}</nav>`;
}
function back(to='settings',label='Settings'){
  const origin=JSON.parse(sessionStorage.getItem('findability-origin:'+screen)||'null');
  const previous=origin?.screen||to;
  const words=previous==='chat'?'Chat':previous==='settings'?'Settings':label;
  return `<div class="backbar"><a href="${origin?.href||href(to)}" data-back="${esc(origin?.label||'')}" aria-label="Back to ${words}">${platform==='android'?icon('arrow'):`<span aria-hidden="true">‹</span> ${words}`}</a></div>`;
}
const flag = (id,description) => `<div class="review-flag" role="note"><b>Decision for John — reopens ${id}</b>${description}</div>`;
function tile(id,title,description,attrs=''){
  return `<a class="tile" href="${id==='brief'?'#':href(id)}" ${id==='brief'?'data-brief=""':attrs}>${icon(id==='brief'?'moon':id==='notifications'?'bell':id)}<span><b>${title}</b>${description?`<small>${description}</small>`:''}</span><span class="chevron" aria-hidden="true">›</span></a>`;
}
function settings(){
  const lines = ['Profile · notifications','Name and face · AI sign-in','Sign-ins','Backups · updates','Model · keys · skills · spend'];
  const quick = `<section class="section"><h2 class="kicker">Quick links</h2><div class="quick ${phone?'card':''}">${tile('notifications','Notifications','You → Notifications',existing('Notifications','You → Notifications'))}${tile('brief','Evening brief',`Ask ${A} to change its time`)}</div></section>`;
  const pair = `<section class="section"><h2 class="kicker">Your things</h2><div class="quick ${phone?'card':''}">${tile('files','Files',phone?'':'Files shared in your conversations')}${tile('vault','Vault',phone?'':`What ${A} can sign in to`)}</div></section>`;
  const groups = `<section class="section"><h2 class="kicker">Settings groups</h2><div class="groups ${phone?'card':''}">${D.groups.map((g,i)=>`<a class="group" href="#" ${existing(g.label,lines[i])}><b>${esc(g.label)}</b><small>${lines[i]}</small></a>`).join('')}</div></section>`;
  return `<h1>Settings</h1>${phone?'':`<p class="subtitle">You, ${A} and this Whombat. Expert settings are under Advanced.</p>`}${quick}${pair}${groups}${phone?`<a class="quiet-link" href="#" ${existing('Theme','System · Light · Dark')}>Theme · ${theme==='light'?'Light':'Dark'}</a>`:''}`;
}
function files(){
  return `${back()}<h1>Files</h1><p class="subtitle">Files shared in your conversations. You see the ones in conversations you’re in.</p><div class="card">${[['feat/invoice-pdf','4 files · 136 MB','11:20'],['Chat','3 files · 488 bytes','11:04']].map(([name,count,time])=>`<a class="file-row" href="#" ${existing(name,'Files shared in this conversation.')} aria-label="${esc(name)}, ${count}, ${time}">${icon('files')}<span><b>${name}</b><small>${count} · ${time}</small></span><span class="chevron" aria-hidden="true">›</span></a>`).join('')}</div>`;
}
function vault(){
  const entries=[['Grafana','Sign-in key · grafana.example.com','Used 09:12'],['Home Assistant','Connection · 192.168.1.10:8123','Used 10:48'],['Printer admin','Password','The password stopped working.'],['Weather API key','Secret · nothing uses it','']];
  return `${back()}<h1>Vault</h1><p class="subtitle">What ${A} can sign in to when it works for you.</p><div class="card">${entries.map(([name,kind,line])=>`<a class="vault-row" href="#" ${existing(name,kind)} aria-label="${esc([name,kind,line].filter(Boolean).join('. '))}">${icon('vault')}<span><b>${name}</b><small>${kind}</small>${line?`<small ${name==='Printer admin'?'class="problem"':''}>${line}</small>`:''}</span><span class="chevron" aria-hidden="true">›</span></a>`).join('')}</div><a href="#" class="quiet-link" ${existing('Add to Vault')}>Add to Vault</a>`;
}
function header(){
  // Same SHOWN_ORDER as shipped native Chat; retention priority is separate (AP-7460).
  return `<header class="${phone?'room-head':'chat-head'}"><h1>Chat</h1>${phone?'':`<p>You and ${A} · every question gets its own thread</p>`}<div class="head-actions">${phone?'':`<a href="#" ${existing(`What ${D.assistant} did`)}>What ${A} did</a><a href="${href('files')}">Files</a>`}<button type="button" ${existing('Settled')}>Settled</button><button type="button" class="${phone?'':'web-more'}" data-more="" aria-label="More in Chat" aria-haspopup="dialog">⋯</button></div></header>`;
}
function chat(){
  return `<article class="message"><div class="author">Mara Okafor <small>09:41</small></div><p>Why is pve-02 using so much memory?</p><a href="#" class="replies" ${existing('Why is pve-02 using so much memory?')} aria-label="3 replies, Waiting for you, open the thread">3 replies · Waiting for you <span class="chevron" aria-hidden="true">›</span></a></article><article class="message"><div class="author">Mara Okafor <small>10:12</small></div><p>Is there new firmware for the access points?</p><p class="meta" style="margin-top:18px">${A} is looking into it</p></article><article class="message"><div class="author">${A} <small>10:58</small></div><p>pve-02 is running warm. I’m looking into it.</p></article>`;
}
function scope(){
  return `<aside class="card scope" aria-label="Review note: result sources"><h2>Search’s reach</h2><p>Today’s search returns messages, threads, patches, runs, canvases, plans, decisions and automations. Messages count under Threads.</p><p>This query has five results. Plans, decisions and automations have no matching fixture result.</p><dl><dt>Connections</dt><dd>Name matches could use the Overview list already loaded: home.overview.things.</dd><dt>Servers</dt><dd>Name matches could use the fleet list already loaded: hosts.fleet.</dd><dt>Settings</dt><dd>Labels could use the bundled list: SETTINGS_GROUP_TEXT and SETTINGS_GROUPS.</dd><dt>Actions</dt><dd><strong>needs new data</strong> · no searchable action list or execution route is supplied.</dd></dl><p>These local lists are separate possible name lookups. None is returned by today’s global search. If a list is absent or not loaded, that category needs new data; never infer an empty result from a missing list.</p></aside>`;
}
function search(){
  return `${phone?back('chat','Chat'):''}<h1>Search</h1><form class="search-box" id="search-form">${icon('search')}<input aria-label="Search your conversations and work" value="${esc(D.query)}"><button type="submit" aria-label="Search">${icon('search')}</button></form><div class="search-layout"><div><div class="filters" aria-label="Result type">${[['all','All',5],['threads','Threads',2],['patches','Patches',1],['runs','Runs',1],['canvases','Canvases',1],['plans','Plans',0],['decisions','Decisions',0],['automations','Automations',0]].map(([id,label,count])=>`<button type="button" data-filter="${id}" aria-pressed="${id==='all'}">${label} ${count}</button>`).join('')}</div><p class="search-status" role="status">5 results · existing search index</p><div id="results"></div></div>${scope()}</div>`;
}
function overview(){
  const W=D.widget;
  const chart=`<svg class="widget-chart" viewBox="0 0 600 130" preserveAspectRatio="none" role="img" aria-label="Heat pump temperatures from the fixture’s recorded points: room, water to radiators and outside. Latest values are given above.">${W.series.map((s,i)=>`<path style="stroke:var(--chart${i+1})" d="${W.points.map((p,n)=>`${n?'L':'M'}${(n*600/(W.points.length-1)).toFixed(2)},${(124-p.values[s.key]*3).toFixed(2)}`).join(' ')}"/>`).join('')}</svg>`;
  return `<h1>Overview</h1><p class="subtitle">Your Inbox and the widgets you pinned.</p><section class="section"><h2 class="kicker">Inbox · 7</h2><a class="card inbox-link" href="#" ${existing('Inbox')}><span class="broken" aria-hidden="true">${icon('inbox')}</span><span><b>The disk array on blackbox has failed.</b><small>6 other things need you · Open Inbox</small></span><span class="chevron" aria-hidden="true">›</span></a></section><nav class="overview-tabs" aria-label="Overview sections"><a href="#pinned" aria-current="page">Pinned · 1</a><a href="#" ${existing('Servers','5 servers')}>Servers · 5</a><a href="#" ${existing('Connections','5 connections')}>Connections · 5</a></nav><section class="widget card" id="pinned"><h2>${esc(W.title)}</h2><small>${esc(W.subtitle)}</small><div class="figures">${W.latest.map(v=>`<div><b>${v.value} ${esc(v.unit)}</b><small>${esc(W.series.find(s=>s.key===v.key).label)}</small></div>`).join('')}</div>${chart}<p class="freshness">Updated 11:22 · Europe/Amsterdam</p><a class="quiet-link" href="#" ${existing(W.title)}>Open its conversation <span aria-hidden="true"> ›</span></a></section>`;
}
const keep = (id) => `<div class="retained"><img src="png/before-web-${id}-${theme}.png" alt="Unchanged shipped ${id} content from the fixture world. See the adjacent before picture for its complete text.">${id==='chat'?header()+`<a class="kept-action" style="left:907px;width:106px" href="#" ${existing(`What ${D.assistant} did`)} aria-label="What ${A} did"></a><a class="kept-action" style="left:1024px;width:52px" href="${href('files')}" aria-label="Files"></a><a class="kept-action" style="left:1089px;width:68px" href="#" ${existing('Settled')} aria-label="Settled"></a>`:''}${id==='search'&&variant==='search'?`<div class="search-review">${flag('AP-2274','A visible Search link in the web navigation. Existing search content stays as shipped.')}${scope()}</div>`:''}${id==='files'?`<a class="page-hotspot" style="top:123px;height:90px" href="#" ${existing('feat/invoice-pdf','4 files · 136 MB · 11:20')} aria-label="feat/invoice-pdf, 4 files, 136 MB"></a><a class="page-hotspot" style="top:215px;height:90px" href="#" ${existing('Chat','3 files · 488 bytes · 11:04')} aria-label="Chat, 3 files, 488 bytes"></a>`:''}</div>`;
const review = variant==='search'&&(phone||screen!=='search')?flag(phone?'AP-2645':'AP-2274',phone?'A native Search screen. The five main tabs stay.':'A visible Search link in the web navigation.') : screen==='overview'&&variant==='overview'?flag('CN-11 / AP-2564; SBT-01 kept','Overview opens on an Inbox link and Pinned, rather than its server/connection tabs. The Inbox remains the one list that acts.') : '';
const renderers = {settings,files,vault,chat,search,overview};
const content = (renderers[screen] || settings)();
const retainWeb = ['chat','files','vault'].includes(screen) || (screen==='overview'&&variant!=='overview') || (screen==='search'&&(variant==='main'||!phone));
document.querySelector('#app').innerHTML = phone?`<div class="phone ${platform==='android'?'android':'ios'}"><div class="status-bar"><span>11:22</span><span aria-hidden="true">▰ ▰ ▰</span></div>${review}${screen==='chat'?header():''}<main class="phone-body" id="main">${content}</main>${screen==='chat'?`<label class="composer"><input aria-label="Ask ${A} anything" placeholder="Ask ${A} anything">${icon('files')}</label>`:''}${tabs()}</div>`:`<div class="shell">${sidebar()}<main id="main">${review}${retainWeb?keep(screen):`<div class="page">${content}</div>`}</main></div>`;
const dialog = document.querySelector('#destination');
let opener;
function showDialog(title,body){
  opener=document.activeElement;
  document.querySelector('#destination-title').textContent=title;
  document.querySelector('#destination-body').innerHTML=body;
  dialog.showModal();
}
document.querySelector('#close-destination').addEventListener('click',()=>dialog.close());
dialog.addEventListener('close',()=>opener?.focus());
document.addEventListener('click',(event)=>{
  const navigation=event.target.closest('a[href*="mockup.html?"]');
  if(navigation){
    const next=new URL(navigation.href).searchParams.get('screen');
    if(navigation.hasAttribute('data-back'))sessionStorage.setItem('findability-focus',JSON.stringify({screen:next,label:navigation.dataset.back}));
    else if(['files','vault','search'].includes(next))sessionStorage.setItem('findability-origin:'+next,JSON.stringify({screen,href:location.href,label:navigation.textContent.trim()}));
  }
  const link=event.target.closest('[data-existing],[data-brief],[data-more]');
  if(!link)return;
  event.preventDefault();
  if(link.hasAttribute('data-brief')){
    showDialog(`Ask ${D.assistant}`,`<label for="brief-question">Evening brief</label><textarea id="brief-question">Where can I change my evening brief’s time?</textarea><p>The question is ready to edit.</p>`);
    dialog.querySelector('textarea').focus();
  }else if(link.hasAttribute('data-more')){
    showDialog('More in Chat',`<a href="#" ${existing(`What ${D.assistant} did`)}>What ${A} did</a><a href="${href('files')}">Files</a>${variant==='search'?`<a href="${href('search',{variant:'search'})}">Search</a>`:''}`);
  }else{
    const title=link.dataset.existing;
    const text=link.dataset.body;
    showDialog(title,text?`<p>${esc(text)}</p>`:'');
  }
});
document.addEventListener('keydown',(event)=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!phone){event.preventDefault();sessionStorage.setItem('findability-search-origin',location.href);location.href=href('search',{variant:variant==='search'?'search':'main'});}
  if(event.key==='Escape'&&!dialog.open&&screen==='search')location.href=sessionStorage.getItem('findability-search-origin')||href('chat');
});
function results(filter='all',query=D.query){
  const matching=D.results.filter(r=>filter==='all'||({THREAD:'threads',MESSAGE:'threads',PATCH:'patches',RUN:'runs',CANVAS:'canvases',PLAN:'plans',DECISION:'decisions',AUTOMATION:'automations'}[r.type])===filter);
  // Fixture query only: another query is explicitly a prototype state, never a fabricated answer.
  const same=query.trim().toLowerCase()===D.query.toLowerCase();
  document.querySelector('#results').innerHTML=!same?'<p class="empty">This static preview contains only the captured invoice query.</p>':matching.length?matching.map(r=>`<a class="result" href="#" ${existing(r.where,r.snippet)}><span class="kicker">${r.type}</span><b>${esc(r.where)}</b><p>${esc(r.snippet)}</p></a>`).join(''):'<p class="empty">No matching fixture results.</p>';
  document.querySelector('.search-status').textContent=same?`${matching.length} results · existing search index`:'Preview query changed';
}
if(screen==='search'&&!retainWeb){
  results();
  document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));results(b.dataset.filter,document.querySelector('.search-box input').value);}));
  document.querySelector('#search-form').addEventListener('submit',e=>{e.preventDefault();results(document.querySelector('[data-filter][aria-pressed=true]').dataset.filter,document.querySelector('.search-box input').value);});
}
const returnFocus=JSON.parse(sessionStorage.getItem('findability-focus')||'null');
if(returnFocus?.screen===screen){
  [...document.querySelectorAll('a')].find(a=>a.textContent.trim()===returnFocus.label)?.focus();
  sessionStorage.removeItem('findability-focus');
}
Promise.all([
  document.fonts.load('400 16px "Bricolage Grotesque"'),
  document.fonts.load('400 12px "DM Mono"'),
]).then(()=>document.fonts.ready).then(()=>{document.documentElement.dataset.ready='true';});
