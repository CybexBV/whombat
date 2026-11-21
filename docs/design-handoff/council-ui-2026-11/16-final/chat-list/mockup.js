// Static chronological Chat, shared fixture story and shared final shell.
(() => {
  const S = window.FINAL_STORY;
  const {icon,esc,mount,base} = window.FinalShell;
  const p = new URLSearchParams(location.search);
  const platform = ['desktop','phoneweb','ios','android'].includes(p.get('platform')) ? p.get('platform') : 'desktop';
  const native = ['ios','android'].includes(platform);
  const state = p.get('state') || 'normal';
  const theme = p.get('theme')==='dark'?'dark':'light';
  const A = S.assistant;
  document.body.dataset.text=p.get('text')==='largest'?'largest':'normal';
  const asset = name => new URL('../../../../packages/'+name,base).href;
  const face = asset('avatars/svg/operator-head-small.svg');
  const time = at => new Intl.DateTimeFormat('en-GB',{timeZone:S.timeZone,hour:'2-digit',minute:'2-digit'}).format(new Date(at));
  const ago = at => {const minutes=Math.floor((Date.parse(S.frozen)-Date.parse(at))/60000);return minutes<60?`${Math.max(1,minutes)} min ago`:`${Math.floor(minutes/60)} hours ago`;};
  const stage = t => t.waiting?{word:'Waiting for you',mark:'<span class="stage-dot"></span>',kind:'wait'}:t.working?{word:`${A} is working`,mark:'<span class="working-mark"></span>',kind:'work'}:t.handedOver?{word:'Handed over',mark:'<span aria-hidden="true">↗</span>',kind:'handoff'}:t.settled?{word:'Settled',mark:'<span aria-hidden="true">✓</span>',kind:'settled'}:null;
  const href = (rootId,answer=false) => {const url=new URL('shell.html',base);url.search=new URLSearchParams({platform,theme,place:'thread',root:rootId,...(answer?{answer:'1'}:{})});return url.href;};
  function replies(t) {
    const s=stage(t),count=`${t.replyCount} ${t.replyCount===1?'reply':'replies'}`;
    const word=s&&(!t.waiting||native)?`<span class="thread-stage ${s.kind}">${s.mark}${esc(s.word)}</span>`:t.replyCount?`<span class="reply-time">${platform==='desktop'?'Last reply ':''}${ago(t.lastAt)}</span>`:'';
    return `<a class="thread-link" href="${href(t.rootId)}" aria-label="${esc([count,s?.word,t.text,'Open thread'].filter(Boolean).join(', '))}">${t.replyCount?`<img src="${face}" alt="" class="participant">`:''}<span class="reply-count">${t.replyCount?count:'No replies yet'}</span>${word}<span class="chevron" aria-hidden="true">›</span></a>`;
  }
  function message(m) {
    const t=S.threads.find(t=>t.rootId===m.id),own=m.authorId===S.person.id;
    const author=own?'Your message':`${A}’s message`;
    return `<article class="message ${own?'own':''}" id="${m.id}" ${native?`tabindex="0" data-hold="${m.id}" aria-label="${esc(author+', '+time(m.createdAt)+'. '+m.text)}"`:''}>
      <div class="author">${own?'':`<img class="avatar" src="${face}" alt=""><strong>${esc(A)}</strong>`}<time datetime="${m.createdAt}">${time(m.createdAt)}</time>${native?'':`<button class="icon-button message-more" data-message="${m.id}" aria-label="Actions for ${esc(author.toLowerCase())} at ${time(m.createdAt)}" aria-haspopup="dialog" aria-controls="message-actions" aria-expanded="false">⋯</button>`}</div>
      <p class="message-text">${esc(m.text)}</p>
      ${m.vaultSaved?.length?`<a class="saved-vault" href="${new URL('shell.html?'+new URLSearchParams({platform,theme,place:'vault'}),base)}">Saved to your Vault · ${esc(m.vaultSaved[0].name)}</a>`:''}
      ${m.subject?`<a class="subject" href="${new URL('shell.html?'+new URLSearchParams({platform,theme,place:'server'}),base)}" aria-label="${esc(m.subject.name+', '+S.pve02.state)}"><span class="stage-dot" aria-hidden="true"></span>${esc(m.subject.name)}</a>`:''}
      ${t?.waiting&&!native?`<div class="waiting-line"><span class="waiting-chip"><span class="stage-dot" aria-hidden="true"></span>Waiting for you</span><a class="button answer" href="${href(t.rootId,true)}" aria-label="Answer in the thread: ${esc(m.text)}">Answer</a></div>`:''}
      ${t?replies(t):''}
    </article>`;
  }
  function failure(saved=false) {
    return `<section class="read-problem" aria-labelledby="problem-title"><h2 id="problem-title">Couldn’t ${saved?'refresh':'read'} your Chat.</h2><p>${saved?'Showing the messages already on this device.':'There’s no saved copy to show on this device yet.'}</p><div class="recovery"><button data-retry aria-label="Try reading your Chat again">Try again</button><button data-ask>Ask ${esc(A)}</button></div><details><summary>More detail</summary><code>The fixture read did not answer.<br>messages.list</code></details><p class="sr-only" role="status" id="read-status"></p></section>`;
  }
  function content() {
    if(state==='loading')return `<div class="state-content"><p class="loading-word" role="status">Loading your Chat…</p><div aria-hidden="true">${[0,1,2].map(()=>'<div class="skeleton"><span></span><i></i><i></i><i></i></div>').join('')}</div></div>`;
    if(state==='empty')return `<section class="state-content empty"><span class="empty-mark" aria-hidden="true">${icon('chat')}</span><h2>Your Chat starts here.</h2><p>Ask ${esc(A)} anything.<br>Each question gets its own thread.</p><button data-compose>Ask a question</button></section>`;
    if(state==='failed')return `<div class="state-content">${failure()}</div>`;
    return `<div class="timeline">${state==='saved-failed'?failure(true):''}<div class="day">Today · Wednesday 23 September</div>${S.roots.map(message).join('')}<div class="timeline-end" aria-hidden="true"></div></div>`;
  }
  const header = `<header class="chat-head"><div><h1>Chat</h1><p>You and ${esc(A)}</p></div><div class="chat-tools"><button data-feedback>Feedback <span class="feedback-badge">${S.feedbackUnread}</span></button><button data-settled>Settled</button><button class="icon-button" data-chatmore aria-label="More in Chat" aria-haspopup="dialog">⋯</button></div></header>`;
  const footer = `<form class="composer" aria-label="Ask a question"><div class="composer-box"><textarea id="question" rows="1" aria-label="Your question" placeholder="Ask ${esc(A)} anything"></textarea><div class="composer-tools">${native?'':`<button class="attach" type="button" data-preview="Attach a file" aria-label="Attach a file">${icon('file')}<span>File</span></button>`}<button class="icon-button" type="button" data-preview="Choose AI" aria-label="Choose how ${esc(A)} answers"><img src="${asset('brand/assets/marks/claude.svg')}" alt=""></button><button class="icon-button" type="button" data-preview="Dictate a message" aria-label="Dictate a message">${icon('mic')}</button><button class="send icon-button" type="submit" aria-label="Send message">${icon('send')}</button></div></div></form>`;
  mount({platform,theme,active:'chat',title:'Chat',header,content:content(),footer});
  const dialog=document.createElement('dialog');dialog.id='message-actions';dialog.className='action-dialog';dialog.setAttribute('aria-labelledby','actions-title');
  dialog.innerHTML='<header><h2 id="actions-title"></h2><button class="icon-button" data-close aria-label="Close">×</button></header><div id="actions-body"></div>';
  document.body.append(dialog);
  let opener;
  function open(button,title,html) {if(!dialog.open)opener=button;opener?.setAttribute('aria-expanded','true');dialog.querySelector('h2').textContent=title;dialog.querySelector('#actions-body').innerHTML=html;dialog.showModal();dialog.querySelector('#actions-body button,#actions-body a,[data-close]')?.focus();}
  function actions(button,id) {
    const m=S.roots.find(m=>m.id===id),t=S.threads.find(t=>t.rootId===id),own=m.authorId===S.person.id;
    const items=own?['Reply','Add reaction','Edit message','Pin message','Delete message','Copy link']:['Reply','Add reaction','Pin message','Copy link'];
    if(t&&!t.waiting&&!t.working&&!t.handedOver)items.push('Settle');
    open(button,'Message actions',items.map(label=>`<button data-preview="${label}">${label}</button>`).join(''));
  }
  document.addEventListener('click',e=>{
    const target=e.target.closest('button,a');if(!target)return;
    if(target.matches('[data-message]'))actions(target,target.dataset.message);
    if(target.matches('[data-compose]'))document.querySelector('#question').focus();
    if(target.matches('[data-retry]')){document.querySelector('#read-status').textContent='Reading again…';}
    if(target.matches('[data-ask]')){const field=document.querySelector('#question');field.value='Can you help me read my Chat?';field.focus();}
    if(target.matches('[data-feedback]'))open(target,'Feedback',`<p>${S.feedbackUnread} unread reply in Feedback.</p><p>This is the other room with ${esc(A)}.</p>`);
    if(target.matches('[data-settled]'))open(target,'Settled',S.settled.map(t=>`<a href="${href(t.rootId)}">${esc(t.text)}<span>Settled</span></a>`).join(''));
    if(target.matches('[data-chatmore]'))open(target,'More in Chat',`<button data-preview="What ${esc(A)} did">What ${esc(A)} did</button><button data-settled>Settled</button>`);
    if(target.matches('[data-preview]'))open(target,target.dataset.preview,'<p>This drawing previews the control. It does not send a message or make a change.</p>');
  });
  dialog.querySelector('[data-close]').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{opener?.setAttribute('aria-expanded','false');opener?.focus({preventScroll:true});});
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  document.addEventListener('contextmenu',e=>{const m=e.target.closest('[data-hold]');if(m&&!getSelection()?.toString()){e.preventDefault();actions(m,m.dataset.hold);}});
  document.addEventListener('keydown',e=>{const m=e.target.closest('[data-hold]');if(m&&e.shiftKey&&e.key==='F10'){e.preventDefault();actions(m,m.dataset.hold);}});
  document.querySelector('form').addEventListener('submit',e=>e.preventDefault());
  // The same chronological content is present on every platform. The arrival camera
  // anchors to the first waiting question; older messages remain above it.
  if(state==='normal')requestAnimationFrame(()=>{
    const scroller=document.querySelector('#main');const first=document.querySelector('#msg_chat-heat');
    if(first)scroller.scrollTop=first.offsetTop-scroller.offsetTop-16;
  });
})();
