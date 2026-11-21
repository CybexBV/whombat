// Static fixture drawings only. No network, command, clipboard, or secret read.
(() => {
 const P = new URLSearchParams(location.search);
 const platform = ['desktop','phoneweb','ios','android'].includes(P.get('platform')) ? P.get('platform') : 'desktop';
 const theme = P.get('theme') === 'dark' ? 'dark' : 'light';
 const screen = document.body.dataset.screen;
 const view = P.get('view') || 'home';
 const state = P.get('state') || 'normal';
 const native = ['ios','android'].includes(platform);
 const S = window.FINAL_STORY, F = window.FinalShell, A = S.assistant, e = F.esc;
 const homeNames = {settings:'Settings',vault:'Vault',files:'Files',usage:'Usage',chat:'Chat',search:'Search',inbox:'Inbox',overview:'Overview',automations:'Automations'};
 const initialSchedule = {...window.FINAL_BRIEF_SCHEDULE};
 let schedule = {...initialSchedule};
 let selectedWindow = P.get('window') || 'today';
 const windows = {today:['Today','23 Sep 00:00–11:22'],week:['Last 7 days','16 Sep 11:22–23 Sep 11:22'],month:['Last 30 days','24 Aug 11:22–23 Sep 11:22']};
 if (!windows[selectedWindow]) selectedWindow = 'today';
 const origin = P.get('from') || 'chat';
 const route = (place, extra = {}) => {
  const local = ['settings','vault','files','usage','search'].includes(place);
  const u = new URL(local ? `${place==='search'?'settings':place}/mockup.html` : place==='chat'?'chat-list/mockup.html':'shell.html', F.base);
  u.search = new URLSearchParams({platform,theme,...(P.get('text')?{text:P.get('text')}:{}),...(place==='search'?{view:'search',q:'Evening brief'}:{}),...(!local&&place!=='chat'?{place}:{}),...extra});
  return u.href;
 };
 const btn = (label,action,cls='') => `<button type="button" class="${cls}" data-action="${action}">${e(label)}</button>`;
 const back = (place, extra={}) => `<a class="back-link" href="${route(place,extra)}" aria-label="Back to ${e(homeNames[place]||place)}">${F.icon('arrow')}Back to ${e(homeNames[place]||place)}</a>`;
 const heading = (title,intro='',action='') => `<header class="page-heading"><div class="heading-copy"><h1 id="page-title" tabindex="-1">${e(title)}</h1>${intro?`<p class="intro">${e(intro)}</p>`:''}</div>${action}</header>`;
 const row = (title,line,to,extra={},icon='settings') => `<a class="row" href="${route(to,extra)}"><span class="row-icon">${F.icon(icon)}</span><span class="row-copy"><strong>${e(title)}</strong>${line?`<small>${e(line)}</small>`:''}</span><span class="chevron" aria-hidden="true">›</span></a>`;
 const status = () => '<p class="status-line" role="status" aria-live="polite" id="local-status"></p>';
 function readState(scope, current=state) {
  const things = {settings:['settings','preferences'],vault:['Vault','saved sign-ins or secrets'],files:['files','files'],usage:['Usage','usage reports'],brief:['evening brief’s schedule','brief schedule']};
  const [name,items] = things[scope];
  if (current==='loading') return `<section class="panel state-panel" aria-busy="true" aria-label="Loading ${e(name)}"><div class="state-symbol">${F.icon(scope==='brief'?'settings':scope)}</div><h2 role="status">Loading ${e(name)}…</h2><div class="skeleton" aria-hidden="true"></div><div class="skeleton short" aria-hidden="true"></div></section>`;
  if (current==='empty') return `<section class="panel state-panel"><div class="state-symbol">${F.icon(scope)}</div><h2>${scope==='settings'?'No saved preferences':scope==='vault'?'Nothing in your Vault yet':scope==='files'?'No files yet':scope==='brief'?'No evening brief schedule':'No usage reported for this window'}</h2><p>${scope==='settings'?'The setting names are still here. You can choose a theme on this device.':scope==='vault'?`Add a sign-in or secret for ${e(A)} to use when it works for you.`:scope==='files'?'Files you and your agent share in a conversation show up here.':scope==='brief'?'There is no saved schedule to show.':'No reports is different from no use. There is no cost or work total to show.'}</p><div class="actions">${scope==='vault'?btn('Add to Vault','add-vault','primary'):scope==='files'?`<a class="button" href="${route('chat')}">Go to Chat</a>`:scope==='settings'?btn('Theme','theme'):''}</div></section>`;
  return `<section class="panel state-panel read-error" aria-label="${e(name)} read problem"><div class="state-symbol">${F.icon(scope==='brief'?'settings':scope)}</div><h2>Couldn’t read ${scope==='settings'?'your settings':scope==='vault'?'your Vault':scope==='files'?'your files':scope==='brief'?'the evening brief’s schedule':'Usage'}</h2><p>There’s no saved copy to show on this device yet.</p><div class="actions">${btn('Try again',`retry-${scope}`)}</div><details class="more"><summary>More detail</summary><p>Only this read is tried again. Nothing is changed.</p></details>${status()}</section>`;
 }
 function settingsHome() {
  const scheduleLine = state==='normal' ? 'Weekdays at 18:00 · Amsterdam' : 'Read its schedule';
  const common = row('Evening brief',scheduleLine,'settings',{view:'brief',state},'settings')+row('Notifications','When this device alerts you','settings',{view:'group',group:'notifications'})+`<button class="row" data-action="theme"><span class="row-icon">${F.icon('settings')}</span><span class="row-copy"><strong>Theme</strong><small>Light and dark on this device</small></span><span class="chevron" aria-hidden="true">›</span></button>`;
  const groups = [['you','You','Profile · Notifications · Devices'],['assistant',A,'Name and face · Memory · What '+A+' may do'],['whombat','This Whombat','Backups · Network · About'],['screens','Screens','Displays linked to this Whombat'],['advanced','Advanced','Expert settings']];
  return heading('Settings',`You, ${A} and this Whombat.`)+`<div class="settings-layout"><section class="section"><h2>Often used</h2><div class="panel common-settings">${common}</div>${state!=='normal'?`<div class="section" id="settings-read">${readState('settings')}</div>`:''}</section><section class="section" aria-label="Settings groups"><h2>All settings</h2><div class="panel settings-groups">${groups.map(([group,title,line])=>row(title,line,'settings',{view:'group',group},'settings')).join('')}</div></section></div>`;
 }
 function briefPage() {
  return back(P.get('via')==='search'?'search':'settings')+heading('Evening brief',`The day’s work, from ${A}.`)+`<div id="brief-body">${state!=='normal'?readState('brief'):briefBody()}</div>`;
 }
 function briefBody() {
  return `<section class="panel schedule-panel" aria-label="Evening brief schedule"><p class="eyebrow">${schedule.enabled?'Weekdays':'Turned off'}</p><p class="schedule-time">${e(schedule.time)}</p><p>Europe/Amsterdam</p><p class="quiet-note">${schedule.enabled?'Weekdays at '+e(schedule.time):'Evening brief is off.'}</p><div class="actions">${btn('Change time','change-time','primary')}${schedule.enabled?btn('Turn off','turn-off'):btn('Undo','undo-brief')}</div>${status()}</section>`;
 }
 function settingsGroup() {
  const group=P.get('group');
  const groups={you:['You',[['Profile',S.person.name],['Notifications','When this device alerts you'],['Devices','Devices linked to you']]],assistant:[A,[['Name and face',A],['Evening brief','Weekdays at 18:00 · Amsterdam'],['Memory','What '+A+' remembers'],['What '+A+' may do','Permissions']]],whombat:['This Whombat',[['Backups','Backup settings'],['Network','How this Whombat connects'],['About','About this Whombat']]],screens:['Screens',[['Screens','Displays linked to this Whombat']]],advanced:['Advanced',[['AI sign-in','What '+A+' runs on'],['Diagnostics','Technical information']]],notifications:['Notifications',[['Notifications','When this device alerts you']]]};
  const [title,items]=groups[group]||groups.you;
  return back('settings')+heading(title)+`<section class="panel group-links">${items.map(([name,line])=>name==='Evening brief'?row(name,line,'settings',{view:'brief'}):`<details class="vault-entry"><summary><span class="row-copy"><strong>${e(name)}</strong><small>${e(line)}</small></span><span class="chevron" aria-hidden="true">›</span></summary><div class="entry-detail"><p>${name==='Notifications'?'Notification preferences stay with this device.':name==='Profile'?e(S.person.name):e(line)}</p></div></details>`).join('')}</section>`;
 }
 function searchPage() {
  const query=P.get('q')??'Evening brief';
  return (native?back('chat'):'')+heading('Search')+`<form class="search-form" id="local-search"><input id="query" type="search" aria-label="Search" value="${e(query)}"><button class="primary" type="submit">Search</button></form><section aria-label="Settings and places matches"><p class="eyebrow">On this device · Settings and places</p><div class="panel" id="search-matches"></div></section>`;
 }
 function drawMatches(query) {
  const catalog=[['Evening brief','Weekdays at 18:00 · Settings → '+A,'settings',{view:'brief',via:'search'}],['Vault','Sign-ins and secrets','vault',{}],['Files','Files shared in your conversations','files',{}],['Usage','What it cost and how much '+A+' worked','usage',{}],['Notifications','Settings → You','settings',{view:'group',group:'notifications'}],['Theme','Settings → this device','settings',{view:'theme'}]];
  const matches=catalog.filter(([name])=>!query||name.toLowerCase().includes(query.trim().toLowerCase()));
  document.querySelector('#search-matches').innerHTML=matches.length?matches.map(([name,line,to,extra])=>row(name,line,to,{...extra,from:'search'},to==='settings'?'settings':to)).join(''):'<div class="state-panel"><h2>No setting or place with that name</h2><p>Try its name, such as “Evening brief”.</p></div>';
 }
 function vault() {
  const action=state==='normal'?btn('Add to Vault','add-vault','primary page-action'):'';
  return (native?back(origin):'')+heading('Vault',`Sign-ins and secrets ${A} can use when it works for you.`,action)+`<div id="scope-body">${state!=='normal'?readState('vault'):vaultBody()}</div><p class="quiet-note">Secrets stay closed. Replace one here when it changes.</p>`;
 }
 function vaultBody() {
  return `<section class="panel" aria-label="Saved sign-ins and secrets">${S.vault.map(entry=>{
   const check=entry.check;
   const line=check?.status==='failing'?'Not working · Password rejected':check?.status==='reached'?'Sign-in reached · Last used '+new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:S.timeZone}).format(new Date(entry.lastUsedAt)):check?.status==='unchecked'?`Not checked · ${A} is off`:'Saved from Chat';
   return `<details class="vault-entry" data-entry="${e(entry.id)}"><summary><span class="row-icon">${F.icon('vault')}</span><span class="row-copy"><strong>${e(entry.name)}</strong><small class="${check?.status==='failing'?'bad-text':''}">${e(line)}</small></span><span class="chevron" aria-hidden="true">›</span></summary><div class="entry-detail">${entry.description?`<p>${e(entry.description)}</p>`:''}${entry.id==='vlt_homeassistant'?'<p>Sign-in was reached; the connection still needs a look.</p>':''}<p>Secret saved. Its value stays hidden.</p>${entry.url?`<p class="meta">${e(entry.url)}</p>`:''}<div class="actions">${btn('Replace secret','replace-secret')}${entry.check?btn('Check sign-in','check-signin'):''}</div>${entry.check?`<p class="quiet-note">${entry.check.checkedAt?'Last checked '+new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:S.timeZone}).format(new Date(entry.check.checkedAt))+' · Amsterdam':'Not checked'}</p>`:''}</div></details>`;
  }).join('')}</section>`;
 }
 function files() {
  return (native?back(origin):'')+heading('Files','Files shared in your conversations. You see the ones in conversations you’re in.')+`<div id="scope-body">${state!=='normal'?readState('files'):filesBody()}</div>`;
 }
 function filesBody() {
  return `<section aria-label="Conversation spaces" class="panel">${S.files.spaces.map(s=>row(s.name,`${s.count} files · ${s.size} · Last added 23 Sep ${s.lastAdded}`,'files',{view:'space',space:s.name,from:origin},s.name==='Chat'?'chat':'files')).join('')}</section>`;
 }
 function fileSpace() {
  const space=P.get('space')||'feat/invoice-pdf';
  const detail=space==='feat/invoice-pdf';
  return back('files',{from:origin})+heading(space,'Files',detail?btn('Upload','upload','page-action'):'')+`<section class="panel">${detail?S.files.names.map((name,i)=>`<details class="vault-entry"><summary><span class="row-icon">${F.icon(i===0?'files':'file')}</span><span class="row-copy"><strong>${e(name)}</strong><small>${i===0?'2 files':i===1?'PDF':'CSV'}</small></span><span class="chevron" aria-hidden="true">›</span></summary><div class="entry-detail"><p>${i===0?'Drawings · 2 files':e(name)}</p><p class="quiet-note">In feat/invoice-pdf</p></div></details>`).join(''):'<div class="state-panel"><h2>3 files · 488 bytes</h2><p>Last added 23 Sep 11:04</p><a class="button" href="'+route('chat')+'">Open Chat</a></div>'}</section>`;
 }
 function usage() {
  return (native?back(origin):'')+heading('Usage',`What it cost and how much ${A} worked.`)+`<div class="window-picker" role="group" aria-label="Usage time window">${Object.entries(windows).map(([key,[label]])=>`<button type="button" data-window="${key}" aria-pressed="${key===selectedWindow}">${label}</button>`).join('')}</div><div id="usage-body">${state!=='normal'?readState('usage'):usageBody()}</div>`;
 }
 function usageBody() {
  const t=S.usage.totals[selectedWindow];
  return `<p class="meta usage-window">${windows[selectedWindow][1]} · Europe/Amsterdam</p><div class="metrics"><section class="metric" aria-label="Estimated cost"><p class="metric-label">Estimated cost</p><strong class="value">$${t.costUsd.toFixed(2)} <span class="currency">USD</span></strong><p class="meta">Cost reported for ${t.costTurns} of ${t.turns} finished turns</p></section><section class="metric" aria-label="How much ${e(A)} worked"><p class="metric-label">Times ${e(A)} worked</p><strong class="value">${t.turns}</strong><p class="meta">Finished turns</p></section></div><p class="usage-explain">A turn is one go at answering or working for you. It can include several steps; it isn’t a count of completed tasks.</p><p class="quiet-note">Prepared 23 Sep 2026 at 11:22 Amsterdam. Estimates cover the turns that reported a cost.</p><details class="panel usage-more" id="usage-more" ${P.get('more')==='open'?'open':''}><summary>More</summary><section class="definition"><h2>Provider coverage</h2><p>All providers reporting here are combined. This report doesn’t name them or split their use.</p><p>It is different from the provider selected for your next reply.</p></section><section class="definition"><h2>Text used</h2><p><strong>${(t.inputTokens+t.outputTokens).toLocaleString('en-GB')} tokens</strong></p><p>Tokens are small pieces of text ${e(A)} reads or writes. They measure text, rather than tasks or time.</p><p>${t.unreportedTurns===0?'All finished turns supplied a usage report.':`${t.unreportedTurns} finished ${t.unreportedTurns===1?'turn has':'turns have'} no usage report. Missing use is not zero use.`}</p></section><section class="definition"><h2>Recorded by plan</h2><p>Invoice PDF export · ${S.usage.plans[0].usedTokens.toLocaleString('en-GB')} tokens</p><p>Saved plan-linked use, separate from the selected time window. It is not a whole-account bill.</p></section></details>`;
 }
 let body = screen==='settings' ? view==='brief'?briefPage():view==='search'?searchPage():view==='group'?settingsGroup():settingsHome() : screen==='vault'?vault():screen==='files'?view==='space'?fileSpace():files():usage();
 const active=screen==='settings'&&view==='search'?'search':screen;
 F.mount({platform,theme,active,title:homeNames[active],hideTabs:native&&(['vault','files','usage'].includes(screen)||view==='brief'||view==='group'||view==='search'),content:`<div class="content">${body}</div>`});
 if(P.get('text')==='largest')document.body.dataset.text='largest';
 document.querySelectorAll('[data-place],.search-link').forEach(a=>{
  const place=a.dataset.place||'search';
  a.href=route(place,{from:['vault','files','usage'].includes(screen)?origin:active});
  a.addEventListener('click',()=>sessionStorage.setItem('final-return',JSON.stringify({from:location.href,scroll:document.querySelector('#main').scrollTop,place})));
 });
 document.querySelectorAll('a.back-link').forEach(a=>a.addEventListener('click',()=>sessionStorage.setItem('final-going-back','true')));
 const saved=JSON.parse(sessionStorage.getItem('final-return')||'null');
 if(sessionStorage.getItem('final-going-back')==='true'&&saved&&saved.from===location.href){
  document.querySelector('#main').scrollTop=saved.scroll;
  (document.querySelector(`[data-place="${saved.place}"]`)||document.querySelector('.places-trigger'))?.focus({preventScroll:true});
  sessionStorage.removeItem('final-going-back');
 } else document.querySelector('#page-title')?.focus({preventScroll:true});
 if(view==='search')drawMatches(P.get('q')??'Evening brief');
 const dialog=document.createElement('dialog');dialog.className='edit-dialog';dialog.id='edit-dialog';dialog.setAttribute('aria-labelledby','edit-title');document.body.append(dialog);
 let dialogOpener;
 function openDialog(title,content,opener=document.activeElement) {
  dialogOpener=opener;
  dialog.innerHTML=`<div class="dialog-heading"><h2 id="edit-title">${e(title)}</h2><button class="icon-button" data-action="close-edit" aria-label="Close ${e(title)}">${F.icon('close')}</button></div>${content}`;
  dialog.showModal();(dialog.querySelector('input,select')||dialog.querySelector('[data-action="close-edit"]'))?.focus();
 }
 dialog.addEventListener('close',()=>{dialog.querySelectorAll('input[type=password],textarea').forEach(field=>field.value='');dialogOpener?.isConnected?dialogOpener.focus({preventScroll:true}):document.querySelector('#page-title')?.focus({preventScroll:true});});
 dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
 function openTime(opener) {
  openDialog('Change time',`<p>Evening brief · Weekdays</p><form id="time-form"><label class="field">Time<input type="time" id="brief-time" value="${e(schedule.time)}" required></label><div class="time-options" role="group" aria-label="Suggested evening times">${['17:00','18:00','19:00','21:00'].map(time=>`<button type="button" data-time="${time}" aria-pressed="${time===schedule.time}">${time}</button>`).join('')}</div><p class="field-help">Europe/Amsterdam</p><div class="actions"><button type="submit" class="primary">Save time</button>${btn('Cancel','close-edit')}</div></form>`,opener);
 }
 function vaultAddForm(kind='auto') {
  const title=kind==='login'?'Website login':kind==='basic'?'Password':'Sign-in key';
  return `<form id="vault-form"><label class="field">${native?'Name':'What it’s for'}<input name="entry-name" autocomplete="off" required></label><label class="field">${kind==='login'?'Sign-in page':'Address'}<input type="url" autocomplete="off" required></label>${kind!=='token'?`<label class="field">Username<input autocomplete="off"></label>${!native?'<p class="field-help">Leave it empty for a sign-in key.</p>':''}`:''}<label class="field">${kind==='auto'?'Password or sign-in key':kind==='token'?'Token':'Password'}<input type="password" name="new-secret" autocomplete="new-password" required></label><p class="field-help">${native?'Sealed when you save. Nobody can read it back, not you and not an agent.':'Sealed when you save. Nobody can read it back here, not even you.'}</p>${!native?btn('Paste a server key instead','server-key'):''}<label class="field">What should ${e(A)} know?<textarea rows="3"></textarea></label>${!native?`<p>${title}</p><details class="more"><summary>Advanced</summary><label class="field">Kind<select><option>Choose for me</option><option>Website login</option><option>Sign-in key</option><option>Password</option><option>Server key</option></select></label></details>`:''}<div class="actions"><button type="submit" class="primary">Save</button>${btn('Cancel','close-edit')}</div><p class="status-line" role="status" id="vault-status"></p></form>`;
 }
 function nativeVaultChoices(opener) {
  openDialog('Add to Vault',`<p>What are you adding?</p><div class="panel section">${[['token','Sign-in key',`A key a service gave you, for ${A} to use in your chats.`],['basic','Password','A username and password for an app or device the agent talks to.'],['login','Website login','A website the agent signs in to in its browser. It never sees the password.']].map(([kind,name,description])=>`<button class="row" data-action="choose-${kind}"><span class="row-copy"><strong>${name}</strong><small>${e(description)}</small></span><span class="chevron" aria-hidden="true">›</span></button>`).join('')}</div><p class="quiet-note">SSH keys are added on the web, in the Vault: their servers and public key are set up there.</p><div class="actions">${btn('Cancel','close-edit')}</div>`,opener);
 }
 document.addEventListener('click',event=>{
  const target=event.target.closest('[data-action],[data-window],[data-time]');if(!target)return;
  if(target.dataset.window){selectedWindow=target.dataset.window;document.querySelectorAll('[data-window]').forEach(b=>b.setAttribute('aria-pressed',b===target));document.querySelector('#usage-body').innerHTML=state==='normal'?usageBody():readState('usage');return;}
  if(target.dataset.time){document.querySelector('#brief-time').value=target.dataset.time;document.querySelectorAll('[data-time]').forEach(b=>b.setAttribute('aria-pressed',b===target));return;}
  const action=target.dataset.action;
  if(action==='close-edit')return dialog.close();
  if(action==='change-time')return openTime(target);
  if(action==='turn-off'||action==='undo-brief'){
   schedule.enabled=action==='undo-brief';document.querySelector('#brief-body').innerHTML=briefBody();
   document.querySelector(`[data-action="${schedule.enabled?'turn-off':'undo-brief'}"]`).focus({preventScroll:true});document.querySelector('#local-status').textContent=schedule.enabled?'Evening brief is on.':'Evening brief is off.';return;
  }
  if(action.startsWith('retry-')){
   const scope=action.slice(6);const holder=scope==='settings'?document.querySelector('#settings-read'):scope==='brief'?document.querySelector('#brief-body'):scope==='usage'?document.querySelector('#usage-body'):document.querySelector('#scope-body');
   holder.innerHTML=readState(scope,'loading');holder.querySelector('h2').setAttribute('tabindex','-1');holder.querySelector('h2').focus({preventScroll:true});return;
  }
  if(action==='theme')return openDialog('Theme',`<p>On this device</p><label class="field">Appearance<select id="theme-choice"><option value="light" ${theme==='light'?'selected':''}>Light</option><option value="dark" ${theme==='dark'?'selected':''}>Dark</option></select></label><div class="actions">${btn('Done','apply-theme','primary')}</div>`,target);
  if(action==='apply-theme'){document.documentElement.dataset.theme=document.querySelector('#theme-choice').value;dialog.close();return;}
  if(action==='add-vault')return native?nativeVaultChoices(target):openDialog('Add to Vault',vaultAddForm(),target);
  if(action.startsWith('choose-'))return openDialog('Add to Vault',vaultAddForm(action.slice(7)),dialogOpener);
  if(action==='server-key')return openDialog('Server key',`<p>You add its servers next.</p><label class="field">Private key<textarea rows="5"></textarea></label><div class="actions">${btn('Cancel','close-edit')}</div>`,dialogOpener);
  if(action==='replace-secret')return openDialog('Replace secret',`<form id="vault-form"><label class="field">New secret<input type="password" name="new-secret" autocomplete="new-password" required></label><p class="field-help">The new secret replaces the old one at once.</p><div class="actions"><button type="submit" class="primary">Replace secret</button>${btn('Cancel','close-edit')}</div><p class="status-line" role="status" id="vault-status"></p></form>`,target);
  if(action==='check-signin'){openDialog('Check sign-in',`<p>The saved check is shown on the entry. A new check would contact this sign-in.</p><div class="actions">${btn('Close','close-edit')}</div>`,target);return;}
  if(action==='upload')return openDialog('Upload',`<label class="field">File<input type="file"></label><p>In feat/invoice-pdf</p><div class="actions">${btn('Cancel','close-edit')}</div>`,target);
 });
 document.addEventListener('submit',event=>{
  if(event.target.id==='time-form'){
   event.preventDefault();schedule.time=document.querySelector('#brief-time').value;dialog.close();document.querySelector('#brief-body').innerHTML=briefBody();document.querySelector('[data-action="change-time"]').focus({preventScroll:true});document.querySelector('#local-status').textContent=`Evening brief · Weekdays at ${schedule.time}.`;return;
  }
  if(event.target.id==='local-search'){event.preventDefault();drawMatches(document.querySelector('#query').value);return;}
  if(event.target.id==='vault-form'){event.preventDefault();event.target.querySelector('[name="new-secret"]').value='';document.querySelector('#vault-status').textContent='Drawing only — no secret was saved.';return;}
 });
 if(P.get('dialog')==='time')document.querySelector('[data-action="change-time"]')?.click();
 if(P.get('dialog')==='add')document.querySelector('[data-action="add-vault"]')?.click();
 if(view==='theme')document.querySelector('[data-action="theme"]')?.click();
 document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();location.href=route('search');}});
 Promise.all([document.fonts.load('400 16px "Bricolage Grotesque"'),document.fonts.load('400 12px "DM Mono"')]).then(()=>document.fonts.ready).then(()=>document.documentElement.dataset.ready='true');
})();
