// Static fixture drawings. No API calls, writes, polling, clocks or automatic sorting.
const q=new URLSearchParams(location.search);
const screen=['overview','server','automations'].includes(q.get('screen'))?q.get('screen'):'overview';
const state=q.get('state')||'normal';
const platform=q.get('platform')||'web';
const native=platform==='ios'||platform==='android';
const theme=q.get('theme')==='dark'?'dark':'light';
const data=native?FIXTURE.native:FIXTURE.web;
const assistant=data.assistant;
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const paths={overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',server:'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6h.01M7 17h.01"/>',chat:'<path d="M21 11a9 9 0 0 1-13 8l-5 2 2-5A9 9 0 1 1 21 11z"/>',inbox:'<path d="M4 4h16l2 12v4H2v-4zM2 14h6l2 3h4l2-3h6"/>',automations:'<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',settings:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',back:'<path d="m14 5-7 7 7 7"/>',arrow:'<path d="M20 12H4m7-7-7 7 7 7"/>',chevron:'<path d="m9 5 7 7-7 7"/>',plus:'<path d="M12 4v16M4 12h16"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',send:'<path d="M12 21V3m-7 7 7-7 7 7"/>',file:'<path d="m20 11-8 8a5 5 0 0 1-7-7L15 2a3 3 0 0 1 4 4L9 16"/>',vault:'<rect x="4" y="9" width="16" height="12" rx="2"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>'};
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.server}</svg>`;
const link=(page,extra='')=>`mockup.html?screen=${page}&platform=${platform}&theme=${theme}${extra}`;
const button=(label,description,extra='')=>`<button type="button" data-preview="${esc(description)}" ${extra}>${label}</button>`;
const ask=(check=false)=>button(`Ask ${esc(assistant)}${check?' to check':''}`,check?'Open the existing conversation about pve-02 and ask whether the restart happened. Do not send another restart.':`Open the existing conversation about ${screen==='server'?'pve-02':screen==='overview'?'these readings':'automations'}. Return here with the same scroll position.`);
const ago=at=>{const age=at?(Date.parse(data.frozen)-Date.parse(at))/60_000:NaN;return !Number.isFinite(age)||age<0?'Reading time unknown':age<1?'Read less than 1 min ago':`Read ${Math.floor(age)} min ago`;};
const clock=at=>new Date(at).toLocaleTimeString('en-GB',{timeZone:'Europe/Amsterdam',hour:'2-digit',minute:'2-digit'});
const reading=(at,cls='')=>`<p class="reading-time ${cls}">${icon('clock')}${at?`<time datetime="${esc(at)}" aria-label="${ago(at)}. 23 September 2026, ${clock(at)}, Europe/Amsterdam" title="23 September 2026, ${clock(at)} Europe/Amsterdam">${ago(at)}</time>`:'Reading time unknown'}</p>`;
const savedAt=new Date(Date.parse(data.frozen)-12*60_000).toISOString();
const serverAt=state==='unknown'||state==='empty'?null:state==='read'?savedAt:data.cards.find(c=>c.id==='pve-02').sampleAt;
const title=screen==='server'?'pve-02':screen==='overview'?'Overview':'Automations';
document.documentElement.dataset.theme=theme;
document.documentElement.style.fontSize=q.get('text')==='large'?(native?'160%':'200%'):'';
document.body.className=`${native?'native ':''}${platform} ${screen}${q.get('text')==='large'?' largest':''}`;

function sidebar() {
 const entries=[['search','Search'],['chat','Chat'],['inbox','Inbox'],['overview','Overview'],['automations','Automations'],['file','Files'],['vault','Vault']];
 return `<aside class="sidebar" aria-label="Sidebar"><a class="brand" href="index.html"><img src="../../../../apps/web/public/favicon.svg" alt="">Burrow HQ</a><nav aria-label="Whombat">${entries.map(([key,label])=>`<a href="${key==='overview'||key==='automations'?link(key):'#'+key}" ${key===screen?'aria-current="page"':''} ${!['overview','automations'].includes(key)?`data-preview="Open the existing ${label} destination; this drawing sends nothing."`:''}>${icon(key)}${label}${key==='inbox'?`<span class="badge broken">${data.summary.needsYou}</span>`:''}</a>`).join('')}</nav><div class="server-nav"><p class="eyebrow">Servers · Connections</p>${data.cards.map(c=>`<a href="${link('server')}">${icon('server')}${esc(c.name)}</a>`).join('')}</div><a href="#usage" class="back" data-preview="Open Usage, outside Advanced.">${icon('clock')}Usage</a><a class="account" href="#settings" data-preview="Open Settings.">Mara Okafor · Settings</a></aside>`;
}
function phoneTop() {
 return `<div class="phone-top"><button id="drawer" aria-label="Open navigation" aria-expanded="false">${icon('menu')}</button><div><a href="#search" data-preview="Open Search. AP-2274 stays intact: no search box is added to the shell.">Search</a><a href="#inbox" data-preview="Open Inbox."><span class="badge broken">${data.summary.needsYou}</span><span class="sr-only"> things need you</span></a></div></div>`;
}
function tabBar() {
 return `<nav class="tab-bar" aria-label="Main tabs">${[['chat','Chat'],['inbox','Inbox'],['overview','Overview'],['automations','Automations'],['settings','Settings']].map(([key,label])=>`<a href="${link(key==='automations'?key:'overview')}" ${key===(screen==='automations'?'automations':'overview')?'aria-current="page"':''} ${!['overview','automations'].includes(key)?`data-preview="Open ${label}."`:''} aria-label="${label}${key==='inbox'?`, ${data.summary.needsYou} things need you`:key==='chat'?', 1 unread thread':''}">${icon(key)}${key==='chat'?'<span class="badge" aria-hidden="true">1</span>':key==='inbox'?`<span class="badge broken" aria-hidden="true">${data.summary.needsYou}</span>`:''}<span>${label}</span></a>`).join('')}</nav>`;
}
function heading() {
 const status=state==='loading'||state==='empty'||state==='no-copy'?'':screen==='overview'?`<a class="bad" href="#inbox" data-preview="Open blackbox’s existing Inbox item.">${native?'blackbox’s disk array failed.':'The disk array on blackbox has failed.'}</a> ${data.summary.needsYou-1} other things need you.${native?'':button(`Ask ${esc(assistant)} to handle it`,'Open the existing handle action for the blackbox Inbox item.')}`:screen==='automations'?`What ${esc(assistant)} does on its own. To make one or change one, tell ${esc(assistant)}.`:'';
 return `<header class="title-row"><div><h1 tabindex="-1">${title}</h1>${status?`<p>${status}</p>`:''}</div>${screen==='overview'&&!native?button(`${icon('plus')}Add a connection`,'Open Add a connection. No connection is created in this document.') :''}</header>`;
}
function tabs(server=false) {
 const items=server?['Summary','Machines','Backups']:['Servers','Connections','Pinned'];
 return `<nav class="tabs" aria-label="${server?'pve-02 sections':'Overview sections'}">${items.map((word,i)=>`<a href="#${word.toLowerCase()}" ${i===0?'aria-current="page"':''} ${!server&&word==='Connections'?'data-connections="1"':''} data-preview="${word==='Connections'?'Connection cards keep their Used today foot (UIR-17). No reading time is added to them.':`Open the existing ${word} section.`}">${word}${!server&&!['empty','loading','no-copy'].includes(state)?` <small>${i===2?1:5}</small>`:''}</a>`).join('')}</nav>`;
}
function errorBlock(action=false) {
 const noCopy=state==='no-copy';
 let fallback=screen==='server'?`Showing readings from ${clock(savedAt)}.`:screen==='overview'?'Showing saved readings. Each server’s reading time is shown below.':'Showing the last saved automations list.';
 if(noCopy) fallback='There’s no saved copy to show on this device yet.';
 if(q.get('variant')==='snapshot'&&screen==='overview') fallback='Showing readings from 11:10.';
 return `<section class="notice" role="status" aria-labelledby="error-title">${icon('info')}<div><h2 id="error-title">${action?'The restart may have happened.':`Couldn’t ${screen==='overview'?'refresh Overview':screen==='server'?'read the readings for pve-02':'read the automations'}.`}</h2><p>${action?'Whombat didn’t get an answer from pve-02. Check what happened before starting another restart.':fallback}</p><div class="actions">${action?ask(true):button('Try again','Repeat only this read. Keep focus here and say Refreshing; retain older values until the read succeeds.',`aria-label="Try reading ${esc(title)} again"`)+ask()}</div><details><summary>More detail</summary><pre>${action?'unknown_outcome · The command may have acted; its answer was not recorded.':'The fixture read did not answer.\n'+(screen==='overview'?'home.overview':screen==='server'?'hosts.getServer':'automations.list')}</pre></details></div></section>`;
}
function refreshLine() {return `<p class="refresh-line" role="status">${icon('clock')}<span>Refreshing<br>Keeping the last saved values in view.</span></p>`;}
function loading() {
 const blocks=screen==='overview'?`<div class="grid">${[1,2].map(()=>`<div class="panel server-card"><div class="skeleton title"></div><div class="skeleton small"></div><div class="figures">${[1,2,3,4].map(()=>'<div class="figure"><div class="skeleton small"></div><div class="skeleton title"></div></div>').join('')}</div><div class="skeleton small" style="margin-top:16px"></div></div>`).join('')}</div>`:screen==='server'?`<div class="panel metric-strip">${[1,2,3,4].map(()=>'<div class="metric"><div class="skeleton small"></div><div class="skeleton title"></div><div class="skeleton graph"></div></div>').join('')}</div><div class="panel pad"><div class="skeleton title"></div><div class="skeleton"></div></div>`:`<div class="panel">${[1,2,3].map(()=>'<div class="skeleton-row"><div class="tile"></div><div class="skeleton-body"><div class="skeleton title"></div><div class="skeleton"></div><div class="skeleton small"></div></div></div>').join('')}</div>`;
 return `<section aria-label="Loading ${title}" role="status"><p class="loading-label">Loading ${title}…</p><div aria-hidden="true">${blocks}</div></section>`;
}
function empty() {
 const lines={overview:['Your servers and connections will appear here.',`Connect a server or a service to see its readings. You can ask ${assistant} to help.`,button('Add a connection','Open Add a connection.','class="primary"')],server:['No readings from pve-02 yet.',`Its readings will appear after its first report. Ask ${assistant} to check the connection if you’re waiting.`,ask()],automations:['What runs on its own will appear here.',`Tell ${assistant} what you’d like to happen and when. You’ll review its plan in Chat before it starts.`,button('Describe an automation','Focus the existing automation request field. A request is reviewed in Chat before it starts.','class="primary"')]}[screen];
 return `<section class="panel empty"><div class="tile" aria-hidden="true">${icon(screen==='automations'?'automations':'server')}</div><h2>${lines[0]}</h2><p>${esc(lines[1])}</p><div class="actions">${lines[2]}</div></section>`;
}
function serverCard(card) {
 const tone=card.pill.tone;
 const head=`<a class="card-title" href="${link('server')}" aria-label="Open ${esc(card.name)}">${esc(card.name)}</a>`;
 const pill=`<span class="pill ${tone==='warn'?'warn':tone==='bad'?'bad':'ok'}"><i class="dot ${tone==='bad'?'broken':tone==='ok'?'green':''}" aria-hidden="true"></i>${esc(card.pill.word)}</span>`;
 const at=state==='unknown'&&card.id==='pve-02'?null:card.sampleAt;
 return `<article class="panel server-card" aria-label="${esc(card.name)}, ${ago(at)}"><div class="server-head"><div class="tile" aria-hidden="true">${icon('server')}</div><div class="head-copy"><h2>${head}</h2>${native?pill:''}<p class="muted">${esc(card.osLine)}</p></div>${native?'':pill}</div>${!native&&card.cpu?`<p class="hardware">${esc(card.cpu.name)}<br><small>${esc(card.cpu.detail)}</small></p>`:''}${native?'':reading(at,'card-reading')}<div class="figures">${card.tiles.map(tile=>`<a class="figure" href="${link('server')}" aria-label="${esc(tile.spoken)}, ${ago(at)}"><span class="eyebrow">${esc(tile.label)}</span><strong class="${tile.tone==='warn'?'warn':''}">${esc(tile.value)}<small>${esc(tile.unit)}</small></strong><div class="meter" aria-hidden="true"><i style="width:${Math.min(100,Math.max(0,(tile.share??0)*100))}%"></i></div><small>${esc(tile.sub)}</small></a>`).join('')}</div><div class="server-foot"><span><b>${esc(card.foot.strong)}</b>${esc(card.foot.text)}</span>${native?reading(at):''}</div></article>`;
}
function overview() {
 const variant=q.get('variant')==='snapshot'?'<aside class="reading-variant"><strong>Needs new data · review variant</strong><br>A timestamp describing the saved readings as a whole is not supplied. 11:10 below is an assumed example, never the fetch time. <a href="'+link('overview','&state=read')+'">Keep the existing-data version</a></aside>':'';
 return variant+heading()+tabs()+(state==='loading'?loading():state==='empty'?empty():state==='no-copy'?errorBlock():`${state==='read'?errorBlock():state==='refreshing'?refreshLine():''}${native?'':`<p class="summary-line">${data.cards.length} servers · Readings reported by each server</p>`}<div class="grid">${data.cards.map(serverCard).join('')}</div>`);
}
function spark(values) {
 const nums=values.filter(v=>typeof v==='number');
 if(nums.length<2) return '';
 const min=Math.min(...nums),max=Math.max(...nums),span=Math.max(1,max-min);
 const pts=nums.map((n,i)=>`${i/(nums.length-1)*200},${27-(n-min)/span*20}`).join(' ');
 return `<svg class="spark" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>`;
}
function serverContent() {
 const panels=data.dashboard.panels;
 const figures=panels.find(p=>p.kind==='kpis');
 const notices=panels.find(p=>p.kind==='notices');
 const current=(notices?.items||[]).filter(i=>i.nature!=='fyi');
 const heads=(notices?.items||[]).filter(i=>i.nature==='fyi');
 const busy=panels.find(p=>p.id==='guests');
 const noticeRows=items=>items.map(item=>`<div class="notice-row"><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p>${item.link?`<div class="actions">${button(esc(item.link.label),'Open the existing destination for this notice. This navigation does not repeat a command.')}</div>`:''}</div>`).join('');
 return `<section class="panel metric-strip" aria-label="pve-02 readings">${figures.items.map(f=>`<div class="metric"><span class="eyebrow">${esc(f.label)}</span><strong>${esc(f.value)}</strong><span>${esc(f.sub)}</span>${f.spark?.length?spark(f.spark):f.meter!=null?`<div class="meter" aria-hidden="true"><i style="width:${f.meter*100}%"></i></div>`:''}</div>`).join('')}</section><div class="server-columns"><section class="panel notices"><div class="panel-head"><h2>Worth a look</h2><small>${current.length||''}</small></div>${noticeRows(current)}${heads.length?`<details><summary>Show ${heads.length} ${heads.length===1?'heads-up':'heads-ups'}</summary>${noticeRows(heads)}</details>`:'<p class="quiet-copy">Nothing needs a look.</p>'}</section>${busy?`<section class="panel"><div class="panel-head"><h2>${esc(busy.title)}</h2><small>${esc(busy.meta)}</small></div><div class="machine-row"><span>Name</span><span>CPU</span><span>Memory</span></div>${busy.rows.map(r=>`<div class="machine-row"><span>${esc(r.cells.guest.text)}</span><span>${esc(r.cells.cpu.text)}</span><span>${esc(r.cells.memory.text)}</span></div>`).join('')}</section>`:''}</div><details class="fold-bottom"><summary>Technical details</summary><pre>${esc(data.server.server.os?.name)} ${esc(data.server.server.os?.version)}
${esc(data.server.server.cpu?.model)}
Address ${esc(data.server.server.address)}
Reading time: ${serverAt?clock(serverAt)+' · Europe/Amsterdam':'unknown'}</pre></details>`;
}
function server() {
 const back=native&&platform==='android'?icon('arrow'):icon('back')+'Overview';
 const known=!['loading','empty','no-copy'].includes(state);
 return `<a class="back" href="${link('overview')}" aria-label="Back to Overview">${back}</a><header class="server-page-head"><div class="tile">${icon('server')}</div><h1 tabindex="-1">pve-02</h1>${known?'<span class="pill warn"><i class="dot" aria-hidden="true"></i>Running warm</span>':''}<div class="actions">${ask()}${button('More','Open the existing server menu. Power commands still ask according to their safety rules.','aria-label="More for pve-02"')}</div></header>${known||state==='empty'?reading(serverAt,'page-reading'):''}${tabs(true)}${state==='loading'?loading():state==='empty'?empty():state==='no-copy'?errorBlock():`${state==='read'?errorBlock():state==='refreshing'?refreshLine():state==='action'?errorBlock(true):''}${serverContent()}`}`;
}
function composer() {
 return native?button(`Tell ${esc(assistant)}… ${icon('send')}`,'Open the existing native New chat sheet to describe an automation.','class="composer"'):`<div class="composer"><input aria-label="Describe an automation" placeholder="Tell ${esc(assistant)} what should happen on its own…"><button type="button" class="send" aria-label="Send automation request" data-preview="Open a proposed plan in Chat; nothing is enabled by this static document.">${icon('send')}</button></div>`;
}
function automationRows() {
 return `<p class="eyebrow list-label">Automations · ${data.automationRows.length}</p><section class="panel" aria-label="Automations">${data.automationRows.map(row=>`<a class="automation-row ${row.quiet?'quiet-row':''}" href="#automation" data-preview="Open ${esc(row.name)}. Its existing page holds its switch and recent runs." aria-label="${esc(row.accessibilityLabel)}"><span class="tile">${icon(row.tile.source==='schedule'?'clock':'automations')}</span><span><span class="auto-name">${esc(row.name)}</span><span class="auto-when">${esc(row.when)}</span><span class="state-line"><i class="dot ${row.state.label==='On'?'green':row.state.label==='Waiting for you'?'':'ring'}" aria-hidden="true"></i><span>${esc(row.state.label)}</span>${row.state.tone==='waiting'?'':`<span class="bars" aria-hidden="true">${row.bars.map(b=>`<i class="${b.tone==='quiet'?'short':b.tone==='bad'?'fail':''}"></i>`).join('')}</span>`}<span class="last-run">${esc(row.state.line)}</span></span></span>${icon('chevron')}</a>`).join('')}</section>`;
}
function schedules() {
 if(!native||!data.schedules?.length) return '';
 return `<p class="eyebrow list-label">Only tells you</p><section class="panel" aria-label="Schedules">${data.schedules.filter(s=>s.status!=='ended').map(s=>`<div class="schedule-row"><h3>${esc(s.what)}</h3><p>${esc(s.when)}</p>${button(s.status==='paused'?'Resume':'Pause','This is the existing schedule action. The static preview sends nothing.')}${button('Remove','Open the existing remove confirmation; no schedule is removed here.')}</div>`).join('')}</section>`;
}
function automations() {
 return heading()+composer()+(state==='loading'?loading():state==='empty'?empty():state==='no-copy'?errorBlock():`${state==='read'?errorBlock():state==='refreshing'?refreshLine():''}${automationRows()}${schedules()}`);
}
document.getElementById('app').innerHTML=`${native?`<div class="status-bar" aria-hidden="true"><span>09:41</span><span>⌁ ▰</span></div>`:sidebar()+phoneTop()}<main class="main" id="main">${{overview,server,automations}[screen]()}</main>${native&&screen!=='server'?tabBar():''}`;
let opener;
const dialog=document.getElementById('destination');
document.addEventListener('click',event=>{
 const target=event.target.closest('[data-preview]');
 if(target){event.preventDefault();if(!dialog.open) opener=target;document.getElementById('destination-copy').textContent=target.dataset.preview;dialog.showModal();document.getElementById('close-dialog').focus();}
 if(event.target.closest('#drawer')) {
  opener=document.getElementById('drawer');opener.setAttribute('aria-expanded','true');
  document.getElementById('destination-copy').innerHTML='<nav aria-label="Navigation preview">'+['Search','Chat','Inbox','Overview','Automations','Files','Vault','Usage','Settings'].map(label=>`<a href="#" data-preview="Open ${label}.">${label}</a>`).join('')+'</nav>';
  dialog.classList.add('drawer-preview');dialog.showModal();document.getElementById('close-dialog').focus();
 }
});
document.getElementById('close-dialog').addEventListener('click',()=>dialog.close());
dialog.addEventListener('close',()=>{dialog.classList.remove('drawer-preview');document.getElementById('drawer')?.setAttribute('aria-expanded','false');opener?.focus();});
