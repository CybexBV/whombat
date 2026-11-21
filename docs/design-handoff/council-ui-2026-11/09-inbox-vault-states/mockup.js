// Static fixture drawings. Interactions change this document only; no app API or clipboard is called.
const q = new URLSearchParams(location.search);
const screen = q.get('screen') === 'vault' ? 'vault' : 'inbox';
const state = q.get('state') || 'normal';
const platform = ['ios','android'].includes(q.get('platform')) ? q.get('platform') : 'web';
const native = platform !== 'web';
const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
const assistant = FIXTURE.assistant;
document.documentElement.dataset.theme = theme;
if(q.get('text') === 'large') document.documentElement.classList.add('largest');
document.body.className = `${native ? 'native' : ''} ${platform} ${screen}`;
const esc = s => String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const paths = {
  inbox:'<path d="M4 4h16l2 12v4H2v-4zM2 14h6l2 3h4l2-3h6"/>',
  vault:'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  chat:'<path d="M21 11a8 8 0 0 1-8 8H8l-5 3 1-6a8 8 0 1 1 17-5z"/>',
  overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  automations:'<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
  server:'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6h.01M7 17h.01"/>',
  alert:'<path d="m12 3 10 18H2zM12 9v4M12 17h.01"/>',
  check:'<path d="m5 12 4 4L20 5"/>',
  down:'<path d="m5 9 7 7 7-7"/>',
  right:'<path d="m9 5 7 7-7 7"/>',
  back:'<path d="m15 5-7 7 7 7"/>',
  arrow:'<path d="m12 4-8 8 8 8M4 12h17"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  power:'<path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>',
  skill:'<path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/>',
  settings:'<circle cx="12" cy="12" r="4"/><path d="m12 2 3 3h4v4l3 3-3 3v4h-4l-3 3-3-3H5v-4l-3-3 3-3V5h4z"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.server}</svg>`;
const button = (label,action,cls='',a11y='') => `<button type="button" class="${cls}" data-action="${action}" ${a11y ? `aria-label="${esc(a11y)}"` : ''}>${label}</button>`;
const href = (s,st) => `mockup.html?${new URLSearchParams({screen:s,state:st,platform,theme})}`;
const group = key => FIXTURE.view.groups.find(g=>g.key===key);
let removed = null;
let settledOpen = false;
let headsOpen = state === 'headsups';
let toastVisible = state === 'settle';
let entryOpen = ['open','entry-error','entry-loading','reveal-error'].includes(state);
const allRows = group('you').rows;
if(state === 'settle') removed = allRows[0].id;
function sidebar(){return `<aside class="sidebar" aria-label="Sidebar"><div class="brand"><img alt="" src="../../../../packages/brand/assets/svg/whombat-symbol-${theme==='dark'?'paper':'ink'}.svg">Burrow HQ</div><nav aria-label="Whombat">${[['chat','Chat'],['inbox','Inbox'],['overview','Overview'],['automations','Automations'],['vault','Vault']].map(([k,label])=>`<a href="${href(k==='vault'?'vault':'inbox','normal')}" ${k===screen?'aria-current="page"':''}>${icon(k)}${label}${k==='inbox'&&!['empty','loading','error','handling','headsups'].includes(state)?`<span class="badge ${removed?'warn':''}">${removed?5:6}</span>`:''}</a>`).join('')}</nav><div class="server-nav"><p class="eyebrow">Servers　Connections　<span aria-hidden="true">＋</span></p>${['thetitan','pve-01','pve-02','blackbox','the-falcon','Home Assistant','UniFi'].map(name=>`<a href="#" data-preview="Opens the existing page for ${name}.">${icon('server')}${name}${name==='blackbox'?'<i class="dot bad" role="img" aria-label="blackbox: disk array failed"></i>':['pve-02','Home Assistant','UniFi'].includes(name)?'<i class="dot" role="img" aria-label="Needs a look"></i>':''}</a>`).join('')}</div><div class="account"><span class="human" aria-label="Mara Okafor">MO</span><span><strong>Mara Okafor</strong><small>Settings</small></span></div></aside>`;}
function tabbar(){return `<nav class="tabbar" aria-label="Tabs">${['Chat','Inbox','Overview','Automations','Settings'].map(label=>`<a href="#" data-preview="Opens ${label}." ${label.toLowerCase() === (screen==='vault'?'settings':screen)?'aria-current="page"':''}><span class="tab-icon">${icon(label.toLowerCase())}${label==='Inbox'&&!['empty','loading','error','handling','headsups'].includes(state)?`<span class="badge ${platform==='android'&&removed?'warn':''}" aria-label="${removed?5:6} Inbox items">${removed?5:6}</span>`:''}</span><span>${label}</span></a>`).join('')}</nav>`;}
function heading(){if(native&&screen==='vault'&&entryOpen)return `<header class="heading entry-heading"><p class="eyebrow">Vault</p><h1 id="page-title" tabindex="-1">Grafana</h1>${state==='open'?'<p class="mono muted">Sign-in key · grafana.example.com</p><p>Read-only dashboards for billing-api. Use the “Billing” folder.</p>':''}</header>`;return `<header class="heading">${native&&screen==='vault'?'<p class="eyebrow">Settings</p>':''}<h1 tabindex="-1" id="page-title">${screen==='inbox'?'Inbox':'Vault'}</h1><p>${screen==='inbox'?`What only you can decide, and what ${esc(assistant)} is on.`:`What ${esc(assistant)} can sign in to when it works for you.`}</p>${screen==='vault'?`<p class="saved">When you send ${esc(assistant)} a password in your chat, it keeps it here and hides it in your message. The AI service it runs on has still seen that one message.</p>`:''}</header>`;}
function note(title,copy,action='retry',exit=false){return `<section class="notice" role="status" aria-labelledby="error-title">${icon('info')}<div><h2 id="error-title">${title}</h2><p>${copy}</p><div class="actions">${action?button('Try again',action,'primary',`Try reading ${screen==='inbox'?'the Inbox':'this Vault entry'} again`):''}${exit?button(native?'Back to Vault':'Close entry','close-entry'):''}</div><details><summary>More detail</summary><pre>The fixture read did not answer.</pre></details></div></section>`;}
function loading(label,n=4){return `<div role="status" aria-label="${label}" aria-busy="true"><p class="load-label">${label}…</p><div class="panel" aria-hidden="true">${Array.from({length:n},()=>'<div class="skeleton-row"><div class="tile"></div><div class="skeleton-body"><div class="skeleton"></div><div class="skeleton short"></div></div></div>').join('')}</div></div>`;}
function row(r,mode='you',suffix='') {
  const key=r.id+suffix;
  const assistantRow = mode==='assistant';
  const onlyMore = assistantRow;
  const rowButtons = r.buttons.filter(b=>!b.more);
  const says = assistantRow ? `<p class="says"><img src="../../../../packages/avatars/svg/${esc(SCENARIOS.faceFile)}" alt="">${esc(r.says?.text || `${assistant} is looking into it`)}</p>` : '';
  return `<article class="row" data-row="${esc(key)}" aria-labelledby="title-${esc(key)}" tabindex="-1"><div class="tile ${r.tone==='bad'&&mode==='you'?'broken':''}" aria-hidden="true">${icon(r.tone==='bad'&&mode==='you'?'alert':r.glyph)}</div><div><h3 id="title-${esc(key)}">${native?`<button class="row-open" data-preview="${assistantRow?`Opens the existing thread with ${assistant}.`:'Opens this item’s existing sheet and actions.'}" aria-label="${esc([r.title,r.body,r.meta,assistantRow?`${assistant} is looking into it`:null].filter(Boolean).join('. '))}">${esc(r.title)}</button>`:`<a class="title-link" href="#" data-preview="Opens this item’s existing ${assistantRow?'thread':'page'}.">${esc(r.title)}</a>`}</h3>${r.body?`<p class="body" ${native?'aria-hidden="true"':''}>${esc(r.body)}</p>`:''}<p class="meta" ${native?'aria-hidden="true"':''}>${esc(r.meta)}${r.state?' · '+esc(r.state):''}</p>${says}</div>${native?icon('right'):''}<div class="actions">${onlyMore?'':rowButtons.map((b,i)=>button(`${b.kind==='settle'?icon('check'):''}${esc(b.label)}`,b.kind==='settle'?`settle:${key}`:b.kind==='back'?'undo':'preview',b.look==='primary'?'primary':'',b.kind==='settle'?`Settle ${r.title}`:'')).join('')}${button(icon('more'),`more:${key}`,'more',`More for ${r.title}`)}</div></article>`;
}
function card(label,rows,mode='you'){return `<section class="panel group" aria-label="${esc(label)}"><header class="group-head"><h2>${esc(label)}</h2><span class="count">${rows.length}</span></header><div class="rows">${rows.map(r=>row(r,mode)).join('')}</div></section>`;}
function heads(){return `<section class="panel group" aria-label="Heads-ups"><header class="group-head"><h2>Heads-ups</h2><span class="count">2</span></header><button class="fold" data-action="heads" aria-expanded="${headsOpen}" aria-controls="heads-rows">${icon(headsOpen?'down':'right')}${headsOpen?'Hide heads-ups':'Show 2 heads-ups'}</button><div class="rows" id="heads-rows" ${headsOpen?'':'hidden'}>${group('fyi').rows.map(r=>row(r,'fyi')).join('')}</div></section>`;}
function inbox(){
  if(state==='loading') return loading('Loading the Inbox');
  if(state==='error') return note('Couldn’t read the Inbox.','There’s no saved Inbox to show on this device yet.');
  if(state==='empty') return '<section class="panel empty"><span aria-hidden="true">'+icon('check')+'</span><p>All good. Nothing needs you.</p></section>';
  if(state==='handling') {
    const rows=Array.from({length:3},(_,i)=>SCENARIOS.handling.rows.map(r=>({...r,id:r.id+'-length-'+i}))).flat();
    return `<aside class="review-tag"><strong>Length stress case · repeated fixture items</strong>Existing rows repeated three times to inspect scrolling, without adding incidents or claims of progress.</aside><section class="panel empty">${icon('check')}<p>Nothing needs you right now.</p></section>${card(`${assistant}’s on it`,rows,'assistant')}${heads()}`;
  }
  if(state==='headsups') return `<section class="panel empty">${icon('check')}<p>Nothing needs you right now.</p></section>${heads()}`;
  return card('Needs you',allRows.filter(r=>r.id!==removed))+heads()+card('Later',group('later').rows,'later');
}
function settled(){return `<section class="settled" aria-label="Settled"><div class="settled-body" id="settled-rows" ${settledOpen?'':'hidden'}>${removed?row({...allRows.find(r=>r.id===removed),buttons:[{label:'Bring it back',kind:'back'}]},'settled'): '<p>Nothing settled. What you settle waits here, and comes back if it happens again.</p>'}</div><button data-action="settled" aria-expanded="${settledOpen}" aria-controls="settled-rows"><strong>Settled</strong><span aria-hidden="true">·</span><span class="count">${removed?1:0}</span>${icon('down')}</button></section>`;}
function entryDetails(){
  if(state==='entry-loading') return `<div class="entry-state">${loading('Loading the entry',3)}${button(native?'Back to Vault':'Close entry','close-entry')}</div>`;
  if(state==='entry-error') return `<div class="entry-state">${note('Couldn’t read this entry.','Your saved sign-in key stays sealed. You can try reading the entry again or close it.','entry-retry',true)}</div>`;
  if(state==='reveal-error') return `<div class="entry-state"><aside class="review-tag"><strong>Decision for John — reopens VT-04</strong>Needs new data: reveal permission, reveal result and refusal reason. This branch adds none. <a href="${href('vault','entry-error')}">See the version that keeps secrets write-only</a></aside>${note('Couldn’t reveal the sign-in key.','The value isn’t on screen. Close the entry to return to your Vault.',null,true)}</div>`;
  return `<section class="entry-block"><div class="block-head"><h2 class="eyebrow">What should ${esc(assistant)} know?</h2>${button('Edit','preview')}</div><p>Read-only dashboards for billing-api. Use the “Billing” folder.</p></section><section class="entry-block"><h2 class="eyebrow">Sign-in key</h2><div class="inline-row"><p>Set · added 5 days ago</p>${button('Replace','preview')}</div></section><section class="entry-block connection-block"><h2 class="eyebrow">Connection</h2><p class="mono">https://grafana.example.com</p><p class="muted">Signs in with a sign-in key</p><div class="inline-row"><p>Checked 1 hour ago · Reached · answered 200</p>${button('Check again','preview')}</div></section><section class="entry-block agent-block"><div class="inline-row"><div class="access-identity"><img src="../../../../packages/avatars/svg/${esc(SCENARIOS.faceFile)}" alt=""><div><h2>${esc(assistant)} can use this</h2><p>${esc(assistant)} uses it when it works for you, never for anyone else.</p></div></div><div class="segment" role="group" aria-label="${esc(assistant)} can use this">${button('On','preview','primary')}${button('Off','preview')}</div></div><details><summary>Advanced</summary><p>Environment variable · GRAFANA</p></details></section><section class="entry-block"><h2 class="eyebrow">Recent use</h2><div class="inline-row"><p>${esc(assistant)} · <span class="mono">in ${esc(assistant)}’s commands for this turn</span> · <span class="done">done</span></p><span class="mono muted use-time">09:12</span></div></section><section class="entry-block"><details><summary>Danger</summary>${button('Remove from Vault','preview')}</details></section>`;
}
function entry(r){
  const lines=r.text.split('\n');
  const open=r.id==='vlt_grafana'&&entryOpen;
  const source=FIXTURE.vault.entries.entries.find(item=>item.id===r.id);
  const statusLabel=source.kind==='secret'?(source.secret.set?'Set':'Not set'):SCENARIOS.nativeRows.find(item=>item.id===r.id).status.label;
  return `<article class="panel" data-entry="${r.id}"><button id="${r.id}" class="entry-head ${open?'opened':''}" aria-label="${esc(lines.join('. ')+'. '+statusLabel)}" data-action="open-entry:${r.id}" aria-expanded="${open}" ${open?'aria-controls="entry-details"':''}><i class="entry-dot ${r.id==='vlt_printer'?'problem':''}" aria-hidden="true"></i><span class="entry-copy"><strong>${esc(lines[0])}</strong><span class="meta">${esc(lines[1])}</span><span class="${r.id==='vlt_printer'?'problem-copy':'where'}">${esc(lines[2]||'')}</span></span>${lines[3]?`<span class="used">${esc(lines[3])}</span>`:''}${icon(open?'down':'right')}</button>${open?`<div id="entry-details">${entryDetails()}</div>`:''}</article>`;
}
function nativeEntry(){return `<section class="panel entry-block"><h2 class="eyebrow">Connection</h2><p class="mono">grafana.example.com</p><p class="mono muted">Signs in with a bearer token</p><p>Checked 1 hour ago · Reached · answered 200</p>${button('Check again','preview')}</section><section class="panel entry-block"><h2 class="eyebrow">Secret</h2><p>Set · added 5 days ago</p>${button('Replace','preview')}</section><section class="panel entry-block"><h2>${esc(assistant)} can use this</h2><div class="segment" role="group" aria-label="${esc(assistant)} can use this">${button('On','preview','primary')}${button('Off','preview')}</div><p>${esc(assistant)} uses it when it works for you, never for anyone else.</p></section><section class="panel entry-block"><h2 class="eyebrow">Recent use</h2><p>${esc(assistant)} · 09:12</p><p>in ${esc(assistant)}’s commands for this turn · done</p></section>`;}
function copied(){return `<aside class="review-tag"><strong>${native?'Public-key copy variant · new native control':'Shipped public-key copy · keeps VT-04'}</strong>${native?'The native Vault currently has no Copy control. This variant copies only the existing public key; no new data.':'Optional Deploy key fixture, with Technical details opened. This is a public line, never a saved secret.'}</aside><article class="panel"><div class="entry-block"><h2>Deploy key</h2><p>${esc(SCENARIOS.ssh.description)}</p></div><div class="entry-block"><h2 class="eyebrow">Key</h2><p>Whombat made this key and keeps it. It never leaves this Whombat.</p><details open><summary>Technical details</summary><div class="inline-row"><p>Add this line to ~/.ssh/authorized_keys for the user the agent signs in as, on every server below.</p>${button('Copy','copy','','Copy the public key line')}</div><pre>${esc(SCENARIOS.publicLine)}</pre><p class="mono">${esc(SCENARIOS.ssh.auth.fingerprint)}</p></details></div></article><aside class="review-tag">Clipboard lifetime: the app does not clear it after 30 seconds. Android 13+ gives its own copy feedback; iOS and older Android use the app notice. No secret value is shown or copied.</aside>`;}
function networkContext(){return native?`<h2 class="eyebrow">Home network</h2><section class="panel entry-block"><p>When the agent may not reach your whole local network, it reaches only these networks and ports.</p>${SCENARIOS.networks.map(r=>`<p class="mono">${esc(r.cidr)}</p><p>${esc(r.ports)}</p><p>${esc(r.note)}</p>`).join('')}</section>`:`<p class="network-note">Which parts of your home network ${esc(assistant)} may reach is set in Settings. <a href="#" data-preview="Opens Settings, Advanced, home network ranges.">See home network ranges</a></p>`;}
function vault(){
  if(state==='locked') return `<aside class="review-tag"><strong>Decision for John — separate Vault lock</strong>Needs new data: a Vault lock state, unlock ceremony and failure state. No separate Vault lock exists today. <a href="${href('vault','normal')}">Keeps-decision version: closed entries, sealed values</a></aside><section class="panel quiet-space">${icon('vault')}<h2>Vault is locked.</h2><p>Unlock it to see your entries.</p><div>${button('Unlock Vault','unlock','primary')}${button('Back','preview')}</div></section>`;
  if(state==='loading') return `<h2 class="eyebrow" style="margin-bottom:12px">Your entries</h2>${loading('Loading your Vault',3)}${networkContext()}`;
  const top=native?`${button('<span aria-hidden="true">＋</span> Add to Vault','preview')}<h2 class="eyebrow" style="margin:16px 0 12px">Your entries</h2>`:`<div class="entries-head"><h2 class="eyebrow">Your entries</h2>${button('<span aria-hidden="true">＋</span> Add to Vault','preview')}</div>`;
  if(state==='empty') return top+'<section class="panel quiet-space"><p>Nothing in your Vault yet.</p></section>'+networkContext();
  if(state==='copied') return copied();
  if(native&&entryOpen) return ['entry-error','entry-loading','reveal-error'].includes(state)?entryDetails():nativeEntry();
  if(native)return top+`<section class="panel">${SCENARIOS.nativeRows.map(r=>`<button id="${r.id}" class="entry-head" data-action="open-entry:${r.id}" aria-label="${esc(r.accessibilityLabel)}"><span class="entry-copy"><strong>${esc(r.name)}</strong><span class="where">${esc(r.meta)}</span>${r.lastUsed?`<span class="meta">${esc(r.lastUsed)}</span>`:''}</span><i class="entry-dot ${r.status.tone==='bad'?'problem':''}" aria-hidden="true"></i>${icon('right')}</button>`).join('')}</section>`+networkContext();
  return top+FIXTURE.vault.rows.map(entry).join('')+networkContext();
}
function toast(){
  if(!toastVisible&&state!=='copied')return '';
  if(state==='copied') return platform==='android'?'<div class="toast system-copy" role="status" aria-label="Android 13 or later: system clipboard confirmation"><span>Copied</span></div>':`<div class="toast" role="status"><span>Line copied. Add it to ~/.ssh/authorized_keys on every server.</span></div>`;
  return `<div class="toast" role="status" aria-live="polite"><span>Settled. It comes back if it happens again.</span>${button('Undo','undo')}${platform==='ios'?button('×','dismiss','','Dismiss'):''}</div>`;
}
function render(){
  const nativeBack=native&&screen==='vault';
  document.getElementById('app').innerHTML=sidebar()+`<div class="shell">${native?'<div class="statusbar" aria-hidden="true"><span>11:22</span><span>▰ ▰</span></div>':''}${nativeBack?`<div class="backbar">${button(`${icon(platform==='ios'?'back':'arrow')}${platform==='ios'?(entryOpen?'Vault':'Settings'):''}`,entryOpen?'close-entry':'preview','',entryOpen?'Back to Vault':'Back to Settings')}</div>`:''}<main class="scroll"><div class="page">${heading()}${screen==='inbox'?inbox():vault()}</div></main>${screen==='inbox'&&!['loading','error'].includes(state)?settled():''}${native&&screen==='inbox'?tabbar():''}${toast()}</div>`;
  bind();
}
function announce(text){document.getElementById('announcement').textContent=text;}
function bind(){
  document.querySelectorAll('[data-action]').forEach(el=>el.addEventListener('click',()=>{
    const action=el.dataset.action;
    if(action==='heads'){headsOpen=!headsOpen;render();document.querySelector('[data-action="heads"]').focus();}
    else if(action==='settled'){settledOpen=!settledOpen;render();document.querySelector('[data-action="settled"]').focus();}
    else if(action.startsWith('settle:')){
      removed=action.slice(7);toastVisible=true;render();
      const index=allRows.findIndex(r=>r.id===removed);
      const next=allRows[index+1]||allRows[index-1];
      const rowEl=document.querySelector(`[data-row="${next?.id}"]`);
      (rowEl?.querySelector(native?'.row-open':'.actions button')||document.getElementById('page-title')).focus();
    } else if(action==='undo'){
      const id=removed;removed=null;toastVisible=false;render();
      (document.querySelector(`[data-row="${id}"] ${native?'.row-open':'[data-action^="settle:"]'}`)||document.getElementById('page-title')).focus();announce('It’s back.');
    } else if(action==='dismiss'){toastVisible=false;render();document.querySelector('.settled button')?.focus();}
    else if(action==='close-entry'){
      entryOpen=false;render();document.getElementById('vlt_grafana').focus();announce(native?SCENARIOS.nativeRows.find(r=>r.id==='vlt_grafana').accessibilityLabel:'Grafana, collapsed.');
    } else if(action.startsWith('open-entry:')){
      if(action.endsWith('vlt_grafana')){entryOpen=!entryOpen;render();(native&&entryOpen?document.querySelector('.backbar button'):document.getElementById('vlt_grafana')).focus();}
      else announce('Preview only. This fixture entry keeps its existing detail screen.');
    } else if(action==='retry'||action==='entry-retry'){
      el.textContent='Try again';announce('Reading again. The fixture remains in this error state.');
    } else if(action==='copy')announce('Preview only. The public key would be copied; this document does not write to your clipboard.');
    else if(action==='unlock')announce('Preview only. A Vault unlock ceremony would be needed.');
    else if(action.startsWith('more:'))announce('Preview only. More holds the existing actions for this item.');
    else announce('Preview only. This opens the existing action in the app.');
  }));
  if(native)document.querySelectorAll('.row-open').forEach(el=>el.addEventListener('click',()=>openSheet(el)));
  document.querySelectorAll('[data-preview]').forEach(el=>el.addEventListener('click',event=>{event.preventDefault();announce('Preview only. '+el.dataset.preview);}));
}
render();
if(state==='settle'){
  const next=allRows[1];
  document.querySelector(`[data-row="${next.id}"] ${native?'.row-open':'.actions button'}`)?.classList.add('focus-demo');
}

function openSheet(opener){
  const id=opener.closest('[data-row]').dataset.row;
  const r=allRows.find(r=>r.id===id)||group('fyi').rows.find(r=>r.id===id)||group('later').rows.find(r=>r.id===id);
  if(!r)return;
  const dialog=document.createElement('dialog');dialog.className='item-sheet';
  dialog.setAttribute('aria-labelledby','sheet-title');
  dialog.innerHTML=`<div class="sheet-head"><h2 id="sheet-title">${esc(r.title)}</h2>${button('×','close-sheet','','Close item')}</div><p>${esc(r.body)}</p><p class="muted mono">${esc(r.meta)}</p><div class="sheet-actions">${r.buttons.map(b=>button(esc(b.label),b.kind==='settle'?`sheet-settle:${id}`:'sheet-preview',b.look==='primary'?'primary':'')).join('')}</div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-action="close-sheet"]').addEventListener('click',()=>dialog.close());
  dialog.querySelectorAll('[data-action="sheet-preview"]').forEach(el=>el.addEventListener('click',()=>announce('Preview only. This uses the existing item action.')));
  dialog.querySelector('[data-action^="sheet-settle:"]')?.addEventListener('click',()=>{
    dialog.close();removed=id;toastVisible=true;render();
    const at=allRows.findIndex(r=>r.id===id),next=allRows[at+1]||allRows[at-1];
    (document.querySelector(`[data-row="${next?.id}"] .row-open`)||document.getElementById('page-title')).focus();
  });
  dialog.addEventListener('close',()=>{dialog.remove();if(opener.isConnected)opener.focus();});
  dialog.showModal();dialog.querySelector('[data-action="close-sheet"]').focus();
}
if(state==='closed')document.getElementById('vlt_grafana')?.classList.add('focus-demo');
