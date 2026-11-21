// Static fixture drawing. It makes no requests and sends no messages or answers.
const D = window.CHAT_DATA;
const params = new URLSearchParams(location.search);
const platform = params.get('platform') || 'desktop';
const native = platform === 'ios' || platform === 'android';
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const screen = params.get('screen') || 'chat';
const state = params.get('state') || 'normal';
const largest = params.get('text') === 'largest';
document.documentElement.dataset.theme = theme;
document.body.dataset.platform = platform;
document.body.dataset.size = largest ? 'largest' : 'normal';
const assistant = D.assistant.name;
const inboxCount = native ? 3 : D.count;
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const face = '../../../../packages/avatars/svg/operator-head.svg';
const smallFace = '../../../../packages/avatars/svg/operator-head-small.svg';
const paths = {
  chat:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  inbox:'M22 12h-6l-2 3h-4l-2-3H2m3-8h14l3 8v8H2v-8Z',
  overview:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  automations:'m13 2-3 8H4l7 12 3-8h6Z',
  vault:'M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4',
  search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  menu:'M4 6h16M4 12h16M4 18h16',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  file:'m21 11-8 8a5 5 0 0 1-7-7l8-8a3 3 0 0 1 4 4l-8 8a1 1 0 0 1-1.5-1.5L16 7',
  mic:'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8',
  send:'m5 12 7-7 7 7M12 5v15',
};
function icon(name){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.chat}"/></svg>`;}
function href(changes={}){const p = new URLSearchParams(location.search);for(const [k,v] of Object.entries(changes))p.set(k,v);return `mockup.html?${p}`;}
function clock(at){return new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'}).format(new Date(at));}
function stage(t){
  if(t.waiting)return {word:'Waiting for you',mark:'<span class="dot"></span>',type:'wait'};
  if(t.working)return {word:`${assistant} is working`,mark:'<span class="working-mark"></span>',type:'work'};
  if(t.handedOver)return {word:'Handed over',mark:'<span aria-hidden="true">↗</span>',type:'handoff'};
  if(t.settled)return {word:'Settled',mark:'<span aria-hidden="true">✓</span>',type:'settled'};
  return null;
}
function replies(t){return t.replyCount===0?'No replies yet':`${t.replyCount} ${t.replyCount===1?'reply':'replies'}`;}
function ago(t){const now=Date.parse(D.frozen);const min=Math.floor((now-Date.parse(t.lastAt))/60000);return min>=60?`${Math.floor(min/60)} ${Math.floor(min/60)===1?'hour':'hours'} ago`:`${Math.max(1,min)} min ago`;}
function threadLink(t,{sample=false,unread=false}={}){
  const s=stage(t);
  // Web keeps its separate Waiting/Answer chip; native keeps Waiting in this link.
  const showStage=s&&(!t.waiting||native||sample);
  const label=[replies(t),s?.word,unread&&!t.settled?'New replies':'',t.text,'Open thread'].filter(Boolean).join(', ');
  const target=href({screen:'thread',state:'normal'});
  return `<a class="reply-row" href="${target}" aria-label="${esc(label)}" data-root="${esc(t.rootId)}">${unread&&!t.settled?'<span class="unread-mark" aria-hidden="true"></span><span class="sr-only">New reply</span>':''}${t.replyCount?`<img class="tiny-face" src="${smallFace}" alt="">`:''}<span class="reply-count">${replies(t)}</span>${showStage?`<span class="stage ${s.type}">${s.mark}${esc(s.word)}</span>`:t.replyCount?`<span class="reply-time ${t.waiting?'web-wait-time':''}">${native?'Last reply':platform==='desktop'?'Last reply':''} ${ago(t)}</span>`:''}<span class="chevron" aria-hidden="true">›</span></a>`;
}
function subject(m){return m.subject?`<a class="subject" href="#" data-preview="${esc(m.subject.name)}" aria-label="${m.subject.name==='pve-02'?esc(m.subject.name)+', Needs a look':'About '+esc(m.subject.name)}">${m.subject.name==='pve-02'?'<span class="dot" aria-hidden="true"></span>':''}${esc(m.subject.name)}</a>`:'';}
function message(m,{root=false,time,card=true,t=null}={}){
  const own=m.authorId===D.person.id;
  const author=own?'Your':`${assistant}’s`;
  const at=time||clock(m.createdAt);
  return `<article class="message ${own?'own':''}" id="${esc(m.id)}" ${native?`tabindex="0" data-hold="${esc(m.id)}" aria-label="${esc(own?'Your message':assistant)}, ${at}. ${esc(m.text)}"`:''}>${own?'':`<img class="avatar" src="${native?smallFace:face}" alt="${esc(assistant)}">`}<div class="author">${own?'':`<strong>${esc(assistant)}</strong>`}<time datetime="${m.createdAt}">${at}</time>${native?'':`<button class="icon more-message" data-actions="${esc(m.id)}" aria-label="Actions for ${esc(author.toLowerCase()==='your'?'your message':author+' message')} at ${at}" aria-haspopup="dialog" aria-controls="sheet" aria-expanded="false">⋯</button>`}</div><div class="message-body">${esc(m.text)}</div>${root?subject(m):''}${m.card&&card?approvalCard():''}${root&&t?.waiting&&!native?`<div class="waiting"><span class="waiting-chip"><span class="dot" aria-hidden="true"></span>Waiting for you</span><a class="button" href="${href({screen:'thread',state:'normal',answer:'1'})}" aria-label="Answer in the thread: ${esc(m.text)}">Answer</a></div>`:''}${root&&t?threadLink(t):''}</article>`;
}
function approvalCard(){
  const a=D.thread.replies.find(m=>m.card?.kind==='approval').card.approval;
  return `<section class="card" aria-label="Approval: ${esc(a.title)}"><div class="eyebrow">${esc(assistant)} needs your OK</div><h2>${esc(a.title)}</h2>${!native&&a.whatHappens.length?`<p>${esc(a.whatHappens.join('. '))}.</p>`:''}${native?`<a class="button" style="display:flex;margin-top:16px;justify-content:space-between" href="#approval" data-preview="Review and answer" aria-label="Review and answer: ${esc(a.title)}">Review and answer <span aria-hidden="true">›</span></a>`:`<div class="card-actions"><button class="primary" data-preview="Yes, now">Yes, now</button><button data-preview="Yes, tonight">Yes, tonight</button><button data-preview="No">No</button></div><button class="last-yes" data-preview="Don’t ask again for pve-02…">Don’t ask again for pve-02…</button><details><summary>Technical details</summary><div class="details-copy">${esc(a.target)}<br>${esc(a.explainer)}</div></details>`}</section>`;
}
function composer(thread=false){return `<form class="composer" aria-label="${thread?'Reply':'Ask a question'}"><div class="composer-box"><textarea rows="1" aria-label="${thread?'Reply':'Your question'}" placeholder="${esc(thread?(native?'Reply…':`Reply to ${assistant}…`):`Ask ${assistant} anything`)}"></textarea><button type="button" class="file" data-preview="Attach a file" aria-label="Attach a file">${icon('file')}File</button><button type="button" class="icon" data-preview="Choose AI" aria-label="Choose how ${esc(assistant)} answers"><img class="model-mark" src="../../../../packages/brand/assets/marks/${native&&thread?'openai':'claude'}.svg" alt=""></button><button type="button" class="icon" data-preview="Dictate a message" aria-label="Dictate a message">${icon('mic')}</button><button type="submit" class="icon send" aria-label="Send message">${icon('send')}</button></div></form>`;}
function sidebar(){return `<aside class="sidebar" aria-label="Sidebar"><div class="burrow">${icon('chat')}Burrow HQ</div><nav>${[['search','Search'],['chat','Chat'],['inbox','Inbox'],['overview','Overview'],['automations','Automations'],['file','Files'],['vault','Vault'],['overview','Usage']].map(([i,w])=>`<a href="#" ${w==='Chat'?'class="active" aria-current="page"':''} data-preview="${w}">${icon(i)}${w}${w==='Inbox'?`<span class="badge">${inboxCount}</span>`:''}</a>`).join('')}</nav><p class="side-label">SERVERS　 CONNECTIONS</p>${['thetitan','pve-01','pve-02','blackbox','the-falcon','Home Assistant','UniFi'].map(w=>`<div class="side-line">${icon('overview').replace('<svg','<svg width="16" height="16"')} ${w}${['pve-02','Home Assistant','UniFi'].includes(w)?'<span class="dot" aria-hidden="true"></span>':''}</div>`).join('')}<a class="side-footer" href="#" data-preview="Settings"><span class="person-symbol" aria-hidden="true">MO</span><span>${esc(D.person.name)}<small>Settings</small></span></a></aside>`;}
function tabs(){return `<nav class="tabs" aria-label="Main navigation">${[['chat','Chat'],['inbox','Inbox'],['overview','Overview'],['automations','Automations'],['settings','Settings']].map(([i,w])=>`<a href="#" ${w==='Chat'?'class="active" aria-current="page"':''} data-preview="${w}" aria-label="${w==='Inbox'?`${inboxCount} things need you, Inbox`:w}">${icon(i)}${w==='Inbox'?`<span class="badge" aria-hidden="true">${inboxCount}</span>`:''}${w}</a>`).join('')}</nav>`;}
function header(){
  const thread=screen==='thread'||screen==='approval';
  return `<div class="native-status" aria-hidden="true"><span>09:41</span><span>••• ▰</span></div><div class="topbar"><button class="icon" data-nav aria-label="Open navigation">${icon('menu')}</button><a href="#" data-preview="Inbox">${inboxCount} things need you <span aria-hidden="true">›</span></a></div>${thread?`<header class="room-head thread-head"><a class="button back" href="${href({screen:screen==='approval'?'thread':'chat',state:'normal',answer:screen==='approval'?'1':'0'})}" aria-label="Back to ${screen==='approval'?'thread':'Chat'}">${platform==='android'?'←':'‹'} <span>${screen==='approval'?'Thread':'Chat'}</span></a><h1>${esc(D.thread.root.text)}</h1>${subject(D.thread.root)}<button class="settle" data-preview="Settle unavailable" aria-disabled="true" disabled>Settle</button></header>`:`<header class="room-head"><h1>Chat</h1><span class="subtitle">You and ${esc(assistant)} · every question gets its own thread</span><div class="head-actions"><button class="wide-action" data-preview="What ${esc(assistant)} did">What ${esc(assistant)} did</button><button class="wide-action" data-preview="Files">Files</button>${native?'<button data-preview="Feedback">Feedback <span class="badge unread-badge">1</span></button>':''}<button class="header-extra" data-shelf>Settled</button><button class="icon" data-nav aria-label="More in Chat">⋯</button></div></header>`}`;
}
const day=()=>'<div class="day">Today · Wednesday 23 September</div>';
function loading(scope){return `<div class="read-state"><p class="load-label" role="status">Loading ${scope==='chat'?'your Chat':'the thread'}…</p>${[0,1,2].map(()=>'<div class="skeleton" aria-hidden="true"><i></i><div><span></span><span></span><span></span></div></div>').join('')}</div>`;}
function problem(scope,saved=false){return `<section class="read-state problem" role="status" aria-labelledby="read-problem-${scope}"><h2 id="read-problem-${scope}">Couldn’t ${saved?'refresh':'read'} ${scope==='chat'?'your Chat':'this thread'}.</h2><p>${saved?(scope==='chat'?'Showing the messages already on this device.':'Showing the replies already on this device.'):'There’s no saved copy to show on this device yet.'}</p><div class="recover"><button data-retry aria-label="Try reading ${scope==='chat'?'your Chat':'this thread'} again">Try again</button><button data-ask>Ask ${esc(assistant)}</button></div><details><summary>More detail</summary><code>The fixture read did not answer.<br>${scope==='chat'?'messages.list':'messages.thread'}</code></details><div class="sr-only" data-read-status></div></section>`;}
function empty(scope){return `<section class="read-state"><h2>${scope==='chat'?'Your Chat starts here.':'No replies yet.'}</h2><p>${scope==='chat'?`Ask ${esc(assistant)} anything. Each question gets its own thread.`:'Replies to this question will appear here.'}</p><button data-compose>${scope==='chat'?'Ask a question':'Write a reply'}</button></section>`;}
function chat(){
  if(state==='loading')return loading('chat');
  if(state==='error')return problem('chat');
  if(state==='empty')return empty('chat');
  const roots=native?D.roots.filter(m=>['msg_chat-pve-memory','msg_chat-firmware'].includes(m.id)):D.roots;
  return `${state==='saved-error'?problem('chat',true):''}${roots.map((m,i)=>{
    const t=D.threads.find(t=>t.rootId===m.id);
    const time=native?(m.id===D.thread.root.id?'13:52':'14:04'):null;
    return `${i===0?(native?day():'<div class="day">Yesterday · Tuesday 22 September</div>'):!native&&i===1?day():''}${message(m,{root:true,t,time})}`;
  }).join('')}`;
}
function thread(){
  if(state==='loading')return loading('thread');
  if(state==='error')return problem('thread');
  const root=message(D.thread.root,{time:native?D.native.times[0]:null});
  if(state==='empty')return day()+root+'<div class="thread-replies">0 replies</div>'+empty('thread');
  return day()+root+`<div class="thread-replies">3 replies</div>${state==='saved-error'?problem('thread',true):''}`+D.thread.replies.map((m,i)=>`${native&&i===2?'<div class="switch">Switched to ChatGPT</div>':''}${message(m,{time:native?D.native.times[i+1]:null})}`).join('');
}
function shelf(){return '<h2 class="status-copy">Settled</h2>'+window.CHAT_FIXTURE.baseline.settled.threads.filter(t=>t.settled).slice(0,2).map(t=>`<article class="message own"><div class="message-body">${esc(t.text)}</div>${threadLink(t)}<button data-preview="Open again">Open again</button></article>`).join('');}
function states(){return `<main class="state-sheet"><header><h1>Chat and thread · read states</h1><span class="subtitle">HTML design · ${theme} · existing query states</span></header>${['chat','thread'].flatMap(scope=>['empty','loading','error'].map(s=>`<section class="state-tile"><h2>${scope==='chat'?'Chat':'Thread'} · ${s==='error'?'Failed first read':s==='empty'?'Successful empty read':'First load'}</h2>${s==='error'?problem(scope):s==='empty'?empty(scope):loading(scope)}</section>`)).join('')}</main>`;}
function stages(){
  const examples=window.CHAT_FIXTURE;
  const base=D.threads.find(t=>t.rootId===D.thread.root.id);
  const noFlags={...base,waiting:false,working:false,handedOver:false,settled:null};
  const cases=[
    ['Existing flags · waiting wins',base],
    ['Existing flags · working',D.threads.find(t=>t.rootId==='msg_look-pve-02')],
    ['Step 02 handoff fixture',examples.examples.open.threads.find(t=>t.handedOver)],
    ['Step 02 settled shelf',examples.baseline.settled.threads.find(t=>t.settled)],
    ['Step 02 unread fixture · separate from stage',{...base,unread:true}],
    ['No stage flag · keep the count and time',noFlags],
    ['No stage flag · zero replies',{...noFlags,text:'Can you check last night’s backups?',replyCount:0}],
    ['Local overlap · all flags true',{...base,working:true,handedOver:true,settled:{at:D.frozen,how:'person'}}],
  ];
  return `<main class="stage-sheet"><header><h1>The same timeline link, with honest words</h1><p class="status-copy">Component specimens · these are separate fixture cases, not a new Chat list.</p></header><div class="stage-grid">${cases.map(([caption,t])=>`<section class="stage-example"><h2>${caption}</h2><p>${esc(t.text)}</p>${threadLink(t,{sample:true,unread:!!t.unread})}</section>`).join('')}</div><p class="decision-note">Waiting for you → ${esc(assistant)} is working → Handed over → Settled, only when its flag is present. With no flags, a reply count and time stay readable. New reply comes only from unread; the open thread and Settled suppress it. Web’s waiting chip and Answer remain separate in the full Chat; native joins waiting to the replies row.</p></main>`;
}
window.ChatStudy={stage,threadLink};
if(screen==='states')document.querySelector('#app').innerHTML=states();
else if(screen==='stages')document.querySelector('#app').innerHTML=stages();
else document.querySelector('#app').innerHTML=`<div class="shell">${platform==='desktop'?sidebar():''}<main class="room">${header()}<div class="stream" id="content" tabindex="-1"><div class="timeline">${screen==='thread'?thread():screen==='settled'?shelf():chat()}</div></div>${composer(screen!=='chat')}${native&&screen==='chat'?tabs():''}</main></div>`;
const sheet=document.querySelector('#sheet');
let opener=null;
function openSheet(trigger,title,content){opener=trigger;document.querySelector('#sheet-title').textContent=title;document.querySelector('#sheet-body').innerHTML=content;trigger?.setAttribute('aria-expanded','true');sheet.showModal();sheet.querySelector('#sheet-body button,#sheet-body a,input')?.focus();}
function actions(trigger,id){
  const t=D.threads.find(t=>t.rootId===id);
  const flags=t&&!t.waiting&&!t.working&&!t.handedOver;
  const names={reply:'Reply in thread',react:'Add reaction',edit:'Edit message',pin:'Pin to this conversation',unpin:'Unpin from this conversation',delete:'Delete message'};
  const choices=[...(screen==='chat'&&flags?['Settle thread']:[]),...(D.actions[id]?.[screen==='chat'?'room':'thread']||[]).map(a=>names[a]),'Copy link'];
  openSheet(trigger,'Message actions',choices.map(w=>`<button data-preview="${esc(w)}">${esc(w)}</button>`).join(''));
}
document.addEventListener('click',e=>{
  const b=e.target.closest('button,a');if(!b)return;
  if(b.matches('[data-close]'))return sheet.close();
  if(b.matches('[data-actions]'))return actions(b,b.dataset.actions);
  if(b.matches('[data-nav]')){e.preventDefault();return openSheet(b,platform==='phone-web'?'Chat navigation':'More in Chat',`${platform==='phone-web'?'<button data-preview="Search">Search</button>':''}<button data-preview="What ${esc(assistant)} did">What ${esc(assistant)} did</button><button data-preview="Files">Files</button><button data-shelf>Settled</button>${native?'<button data-preview="Search">Search</button>':''}`);}
  if(b.matches('[data-shelf]')){e.preventDefault();if(sheet.open)sheet.close();return openSheet(b,'Settled',`<a class="button" href="${href({screen:'settled',state:'normal'})}">Open Settled</a>`);}
  if(b.matches('[data-compose],[data-ask]')){document.querySelector('textarea')?.focus();if(b.matches('[data-ask]'))document.querySelector('textarea').value=`I couldn’t read ${screen==='chat'?'my Chat':'this thread'}. Can you help?`;return;}
  if(b.matches('[data-retry]')){b.closest('.problem').querySelector('[data-read-status]').textContent='Reading again…';return;}
  if(b.matches('[data-preview]')){e.preventDefault();const title=b.dataset.preview;if(sheet.open){document.querySelector('#sheet-title').textContent='Preview only';document.querySelector('#sheet-body').innerHTML=`<p>${esc(title)} is an existing action or destination. This drawing sends nothing.</p><button data-close>Back to the drawing</button>`;}else openSheet(b,'Preview only',`<p>${esc(title)} is an existing action or destination. This drawing sends nothing.</p><button data-close>Back to the drawing</button>`);}
});
document.addEventListener('contextmenu',e=>{const m=e.target.closest('[data-hold]');if(m&&!window.getSelection()?.toString()){e.preventDefault();actions(m,m.dataset.hold);}});
document.addEventListener('keydown',e=>{const m=e.target.closest('[data-hold]');if(m&&e.shiftKey&&e.key==='F10'){e.preventDefault();actions(m,m.dataset.hold);}});
sheet.addEventListener('close',()=>{opener?.setAttribute('aria-expanded','false');opener?.focus({preventScroll:true});});
sheet.addEventListener('click',e=>{if(e.target===sheet&&(e.offsetX<0||e.offsetY<0||e.offsetX>sheet.clientWidth||e.offsetY>sheet.clientHeight))sheet.close();});
document.querySelector('form')?.addEventListener('submit',e=>e.preventDefault());
if(screen==='thread'&&params.get('answer')==='1')requestAnimationFrame(()=>{document.querySelector('.card')?.scrollIntoView({block:'center'});document.querySelector('.card button,.card a')?.focus({preventScroll:true});});
if(params.get('menu')==='open')document.querySelector('[data-actions]')?.click();

if(screen==='thread'&&state!=='loading'&&state!=='error'){requestAnimationFrame(()=>{const scroller=document.querySelector('.stream');scroller.scrollTop=scroller.scrollHeight;const head=document.querySelector('.thread-head');const refresh=()=>{head.classList.toggle('root-away',document.getElementById(D.thread.root.id).getBoundingClientRect().bottom<scroller.getBoundingClientRect().top);};scroller.addEventListener('scroll',refresh,{passive:true});refresh();});}
