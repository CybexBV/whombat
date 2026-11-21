// Exactly the three returned Inbox records in STORY.md, in their supplied order.
(() => {
 const U=window.FinalReview,{S,q,platform,theme,native,esc,icon,link,time,exact,button,preview,readState,announce}=U;
 const state=q.get('state')||'normal',items=S.inbox;
 let isSettled=false;
 const more=item=>`<details class="row-more"><summary aria-label="More for ${esc(item.title)}">More</summary><div class="more-options">${item.kind==='alert'?button('Settle','settle','quiet'):''}${button(`Talk to ${S.assistant} about it`,'discuss:'+item.id,'quiet')}${item.actions.some(a=>a.kind==='snooze')||item.kind==='device_skill'?button('Remind me tomorrow','remind:'+item.id,'quiet'):''}</div></details>`;
 function row(item){
  const broken=item.kind==='alert',approval=item.kind==='approval';
  const later=item.actions.find(a=>a.kind==='approve_later');
  if(approval)return `<div class="inbox-approval" data-row="${esc(item.id)}">${ApprovalCard.render({approval:{number:item.ref.id,title:item.title,createdAt:item.at},tonight:later.at,explanation:item.body,subject:item.subject.name})}${more(item)}</div>`;
  return `<article class="inbox-row" data-row="${esc(item.id)}" aria-labelledby="row-${item.ref.id}"><span class="row-mark ${broken?'broken':''}" aria-hidden="true">${broken?'!':icon(approval?'chat':'overview')}</span><div class="row-copy"><h3 id="row-${item.ref.id}">${esc(item.title)}</h3><p class="reason">${esc(item.body)}</p><p class="meta">${esc(item.subject.name)} · ${broken?'Opened':'Asked'} ${time(item.at)}</p>${approval?`<p class="timing"><strong>Yes, tonight</strong> means<br>${esc(exact(later.at))}.</p>`:''}<div class="row-controls">${approval?`<div class="row-answers" aria-label="Restart approval answers">${button('Yes, now','answer:now')}${button('Yes, tonight','answer:tonight')}${button('No','answer:no')}</div>`:broken?button(item.actions.find(a=>a.kind==='investigate').label,'investigate','primary'):`<a class="button primary" href="${new URL('shell.html?'+new URLSearchParams({platform,theme,place:'thread',root:'msg_chat-heat'}),window.FinalShell.base)}">Choose</a>`}${more(item)}</div></div></article>`;
 }
 function list(){return `<div class="inbox-panel"><header class="group-heading"><h2>Needs you</h2><span class="group-count" aria-label="3 items">3</span></header>${items.map(row).join('')}</div>`;}
 const content=['loading','empty','failed'].includes(state)?readState('the Inbox',state):`${state==='saved-failed'?`<div class="inbox-saved-note">${readState('the Inbox',state)}</div>`:''}${list()}`;
 window.FinalShell.mount({platform,theme,active:'inbox',title:'Inbox',header:`<header class="screen-head"><h1 id="page-title" tabindex="-1">Inbox</h1><p>What only you can decide, and what ${esc(S.assistant)} is on.</p></header>`,content:`<div class="inbox-content">${content}</div>`,footer:`<section class="settled-area" aria-label="Settled"><div class="settled-panel" id="settled-items" hidden><p>Nothing settled. What you settle waits here, and comes back if it happens again.</p></div><button class="settled-toggle" data-action="settled" aria-expanded="false" aria-controls="settled-items"><strong>Settled</strong><span data-settled-count>0　⌃</span></button></section>`});
 // A successful empty alternative supersedes the count for this query scope.
 if(state==='empty')document.querySelectorAll('[data-place="inbox"]').forEach(el=>{el.querySelector('.shell-badge')?.remove();el.setAttribute('aria-label','Inbox, nothing needs you');});
 U.bindRead('the Inbox');
 function count(){
  const n=isSettled?2:3;document.querySelector('.group-count').textContent=n;document.querySelector('.group-count').setAttribute('aria-label',`${n} items`);
  document.querySelectorAll('[data-place="inbox"]').forEach(el=>{el.setAttribute('aria-label',`Inbox, ${n} things need you${isSettled?'':', one is not working'}`);const b=el.querySelector('.shell-badge');b.textContent=n;b.style.background=isSettled?'var(--warn)':'var(--bad)';b.style.color=isSettled?'var(--ink)':'var(--btnfg)';});
  document.querySelector('[data-settled-count]').textContent=`${isSettled?1:0}　⌃`;
 }
 document.addEventListener('click',ev=>{
  const b=ev.target.closest('[data-action]');if(!b)return;const action=b.dataset.action;
  if(action==='settled'){const panel=document.querySelector('#settled-items');panel.hidden=!panel.hidden;b.setAttribute('aria-expanded',String(!panel.hidden));return;}
  if(action==='investigate'){preview('Look into it',`Please look into blackbox’s failed disk array. My files have no protection now.`);return;}
  if(action.startsWith('discuss:')){const item=items.find(i=>i.id===action.slice(8));preview(`Talk to ${S.assistant} about it`,`Open the existing discussion about “${item.title}”. This preview sends no question.`);return;}
  if(action.startsWith('remind:')){preview('Remind me tomorrow','This quiets the item until tomorrow at 09:00, Europe/Amsterdam. This preview changes nothing.');return;}
  if(action==='settle'){
   isSettled=true;document.querySelector('[data-row="hosts.alert:al_blackbox_md0"]').hidden=true;count();
   document.querySelector('#settled-items').innerHTML=`<h3>${esc(items[0].title)}</h3><p>Settled until it happens again.</p>${button('Bring it back','undo')}`;
   const toast=document.createElement('aside');toast.className='toast';toast.innerHTML=`<p role="status">Settled. It comes back if it happens again.</p>${button('Undo','undo')}`;document.body.append(toast);toast.querySelector('button').focus();return;
  }
  if(action==='undo'){
   isSettled=false;const row=document.querySelector('[data-row="hosts.alert:al_blackbox_md0"]');row.hidden=false;row.querySelector('details').open=false;count();document.querySelector('.toast')?.remove();document.querySelector('#settled-items').innerHTML='<p>Nothing settled. What you settle waits here, and comes back if it happens again.</p>';row.querySelector('[data-action="investigate"]').focus();announce('It’s back.');return;
  }
  if(action.startsWith('answer:')){
   const area=b.closest('.decision-answers,.row-controls'),later=items[1].actions.find(a=>a.kind==='approve_later');
   area.innerHTML=`<p class="row-result" role="status" tabindex="-1">${action==='answer:no'?'You said no.':action==='answer:tonight'?`Approved for ${esc(exact(later.at))}.`:'Your answer was saved.'}</p>`;area.querySelector('p').focus();
  }
 });
 document.fonts.ready.then(()=>requestAnimationFrame(()=>{
  if(q.get('focus')==='approval'){const main=document.querySelector('#main'),row=document.querySelector('[data-row="approval:31"]');if(row)main.scrollTop=row.offsetTop-main.offsetTop-12;}
  if(q.get('focus')==='answers'){const main=document.querySelector('#main'),timing=document.querySelector('[data-row="approval:31"] .timing');if(timing)main.scrollTop+=timing.getBoundingClientRect().top-main.getBoundingClientRect().top-12;}
  document.documentElement.dataset.ready='true';
 }));
})();
