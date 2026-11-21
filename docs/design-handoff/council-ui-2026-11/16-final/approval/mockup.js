// Approval 33 is the final story. Command/mail are explicitly separate payload specimens.
(() => {
 const U=window.FinalReview,{S,q,platform,theme,native,esc,icon,link,time,exact,button,face,modal,preview,readState,announce}=U;
 const D=window.FINAL_APPROVAL,kind=Object.hasOwn(D.specimens,q.get('kind'))?q.get('kind'):'primary';
 const {approval:a,view:v,keyLabel}=kind==='primary'?D.primary:D.specimens[kind];
 // The primary request is the same complete card on every platform and surface.
 if(kind==='primary'&&!['answer-unknown','answer-never-sent'].includes(q.get('state'))){
  const state=q.get('state')||'normal',isRead=['loading','empty','failed'].includes(state);
  const recovery=state==='saved-failed'?readState('the approval',state):'';
  const card=ApprovalCard.render({...D.primary,tonight:D.tonight,disabled:state==='saved-failed'});
  const contents=isRead?readState('the approval',state):recovery+card;
  const header=`<header class="push-head"><a href="${link('thread')}" aria-label="Back to Chat">${platform==='android'?icon('arrow'):'‹ Chat'}</a><span>Approval</span></header>`;
  document.body.classList.add('primary-approval-screen');
  FinalShell.mount({platform,theme,active:'chat',title:'Approval',hideTabs:true,header,content:`<div class="primary-approval-content">${contents}</div>`});
  if(!native&&q.get('surface')!=='card'){
   const sheet=document.createElement('dialog');sheet.className='approval-sheet';sheet.setAttribute('aria-labelledby','details-title');
   sheet.innerHTML=`<header class="sheet-head"><h2 id="details-title">Approval details</h2><a href="${link('approval',{surface:'card'})}" aria-label="Close approval details">${icon('close')}</a></header><div class="primary-approval-content">${contents}</div>`;
   document.querySelector('#main').innerHTML='';document.querySelector('.shell-workspace').append(sheet);sheet.showModal();
   sheet.addEventListener('cancel',event=>{event.preventDefault();location.href=link('approval',{surface:'card'});});
  }
  U.bindRead('the approval');
  document.addEventListener('click',ev=>{
   const control=ev.target.closest('[data-action]');if(!control)return;
   if(control.dataset.action==='lasting'){const l=v.lasting;modal(l.title,`<p>${esc(l.body)}</p>`,button(l.keep,'cancel')+button(l.confirm,'confirm','primary'));}
   if(control.matches('[data-approval-answer]')){const card=control.closest('.decision-card');card.querySelector('.decision-answers').innerHTML=`<p role="status" tabindex="-1">${control.dataset.approvalAnswer==='no'?'You said no.':control.dataset.approvalAnswer==='tonight'?`Approved for ${esc(exact(D.tonight))}.`:'Your answer was saved.'}</p>`;card.querySelector('[role="status"]').focus();}
  });
  document.fonts.ready.then(()=>requestAnimationFrame(()=>{
   if(q.get('technical')==='open')document.querySelector('.decision-details')?.setAttribute('open','');
   if(q.get('scroll')==='end'){const el=document.querySelector('dialog[open] .primary-approval-content,#main');el.scrollTop=el.scrollHeight;}
   document.documentElement.dataset.ready='true';
  }));return;
 }

 const state=q.get('state')||'normal',surface=native?'native':q.get('surface')||'details';
 const isRead=['loading','empty','failed'].includes(state),unknown=state==='answer-unknown',neverSent=state==='answer-never-sent';
 if(native)document.body.classList.add('native-screen');
 const params=extra=>({...Object.fromEntries(q),platform,theme,kind,...extra});
 const cardURL=link('approval',params({surface:'card'}));
 function choices(){
  const list=kind==='command'?v.scopeChoices.map(c=>[c.label,c.scope]):[['Yes, now','now'],['Yes, tonight','tonight'],['No','no']];
  if(kind==='command')list.push([v.declineCta,'no']);
  return `<div class="answer-buttons ${kind==='command'?'command':'three'}">${list.map(([word,id],i)=>button(word,'answer:'+id,'')).join('')}</div>`;
 }
 function facts(full=false){
  let html=`<h1 class="question" id="${full?'approval-question':'card-question'}" tabindex="-1">${esc(native||full?v.question:v.title)}</h1><div class="fact-stack">`;
  if(kind==='command')html+=`<div class="fact"><span class="label">Why</span><p>${esc(a.action.params.reason)}</p></div>`;
  if(kind==='mail')html+=[['From',a.action.params.connectionEmail],['To',a.action.params.to.join(', ')],['Subject',a.action.params.subject],['Copies','No Cc or Bcc']].map(([label,text])=>`<div class="fact"><span class="label">${label}</span><p>${esc(text)}</p></div>`).join('');
  html+=`<div class="fact"><span class="label">Permission used</span><p>“${esc(keyLabel)}”</p></div></div>`;
  if(kind!=='command')html+=`<p class="timing"><strong>Yes, tonight</strong> means<br>${esc(exact(D.tonight))}.</p>`;
  // A sole person condition repeats the question. It is omitted on web and native.
  if(kind==='command')html+=`<div class="fact"><span class="label">Command · ${esc(a.action.params.target)}</span><pre class="payload" tabindex="0" aria-label="The whole command">${esc(a.action.params.command)}</pre></div>`;
  if(kind==='mail'&&full)html+=`<div class="fact"><span class="label">Message</span><div class="email" tabindex="0" aria-label="The whole email">${esc(mailBody())}</div></div>`;
  if(kind!=='command')html+=`<details><summary>Technical details</summary><p class="meta">${esc(a.target)}</p>${kind==='mail'&&!full?`<div class="email" tabindex="0" aria-label="The whole email">${esc(mailBody())}</div>`:''}${a.connection?.argumentsPreview?`<pre class="payload" tabindex="0" aria-label="Requested server command">${esc(a.connection.argumentsPreview)}</pre>`:''}${a.explainer?`<p>${esc(a.explainer)}</p>`:''}</details>`;
  if(v.lasting)html+=`<div class="lasting">${button(v.lasting.link,'lasting','quiet')}</div>`;
  return html;
 }
 function mailBody(){return q.get('length')==='long'?Array(4).fill(a.action.params.body).join('\n\n'):a.action.params.body;}
 function warning(){return unknown?`<section class="answer-warning" role="status"><h2>Your answer may have gone through.</h2><p>Whombat didn’t get a reply. Check what happened before answering again.</p><details><summary>More detail</summary><p>The fixture answer receipt has an unknown outcome.</p></details></section><p class="meta">Last reviewed details</p>`:neverSent?`<section class="answer-warning" role="status"><h2>Your answer wasn’t sent.</h2><p>You can answer again.</p></section>`:'';}
 function footer(card=false){
  if(isRead)return '';
  if(state==='saved-failed')return `<footer class="answer-bar" aria-label="Approval recovery"><div class="check-only"><p>Saved details. Refresh before answering.</p>${button('Try again','retry')}</div></footer>`;
  return `<footer class="answer-bar" aria-label="${unknown?'Approval recovery':'Approval answers'}">${unknown?`<div class="check-only">${button(`Ask ${S.assistant} to check`,'check')}<p>Check only; don’t send the answer again.</p></div>`:choices()}${card?`<a class="details-link" data-open-details href="${link('approval',params({surface:'details'}))}">Details</a>`:''}</footer>`;
 }
 const byline=`<div class="byline"><img src="${face}" alt=""><strong>${esc(S.assistant)}</strong><time class="meta">${time(a.createdAt)}</time></div>`;
 const nativeByline=`<div class="asker"><img src="${face}" alt=""><div><p class="label wait">${esc(S.assistant)} needs your OK</p><p class="meta">${esc(S.assistant)} · Chat · ${time(a.createdAt)}</p></div></div>`;
 const card=`<section class="approval-card" aria-label="Approval"><div class="card-content"><p class="label wait">${esc(S.assistant)} needs your OK</p>${state==='saved-failed'?readState('the approval',state):''}${warning()}${facts()}</div>${footer(true)}</section>`;
 const normalContent=(state==='saved-failed'?readState('the approval',state):'')+(native?nativeByline:`<p class="label wait">${esc(S.assistant)} needs your OK</p>`)+warning()+facts(true);
 const readContent=isRead?readState('the approval',state):normalContent;
 const topic=S.threadBodies['msg_chat-memory'].root.text;
 const stored=S.threadBodies['msg_chat-memory'].replies.find(m=>m.card?.kind==='approval').text;
 const context=native?'':`<div class="thread-study"><h2 class="thread-topic">${esc(kind==='primary'?topic:kind==='command'?a.action.params.reason:a.action.params.subject)}</h2>${!isRead?byline+(kind==='primary'?`<p class="stored-message">${esc(stored)}</p>`:'')+(surface==='card'?card:state==='normal'?card:''):''}</div>`;
 window.FinalShell.mount({platform,theme,active:'chat',title:'approval',hideTabs:true,header:`<header class="push-head"><a href="${link('chat-list')}" aria-label="Back to Chat">${platform==='android'?icon('arrow'):'‹ Chat'}</a><span>Approval</span></header>`,content:native?`<section class="native-approval" aria-label="Approval"><div class="sheet-content" tabindex="0" aria-label="Approval content">${readContent}</div>${footer()}</section>`:context});
 let sheet;
 if(!native&&surface==='details'){
  sheet=document.createElement('dialog');sheet.className='approval-sheet';sheet.setAttribute('aria-labelledby','details-title');
  sheet.innerHTML=`<header class="sheet-head"><h2 id="details-title">Approval details</h2><a href="${cardURL}" data-close-details aria-label="Close approval details">${icon('close')}</a></header><div class="sheet-content" tabindex="0" aria-label="Approval content">${readContent}</div>${footer()}`;
  document.querySelector('.shell-workspace').append(sheet);sheet.showModal();
  sheet.addEventListener('cancel',ev=>{ev.preventDefault();document.querySelector('[data-close-details]').click();});
 }
 if(!native&&surface==='card'&&isRead)document.querySelector('#main').innerHTML=readContent;
 U.bindRead('the approval');
 const returnKey='final-approval-return';
 document.querySelector('[data-open-details]')?.addEventListener('click',()=>sessionStorage.setItem(returnKey,JSON.stringify({url:location.href,scroll:document.querySelector('#main').scrollTop,kind,platform})));
 try{const r=JSON.parse(sessionStorage.getItem(returnKey));if(r?.kind===kind&&r?.platform===platform&&document.querySelector('[data-close-details]'))document.querySelector('[data-close-details]').href=r.url;}catch{}
 document.querySelector('[data-close-details]')?.addEventListener('click',()=>{const saved=sessionStorage.getItem(returnKey);if(saved)sessionStorage.setItem(returnKey,JSON.stringify({...JSON.parse(saved),restore:true}));});
 if(surface==='card'){try{const r=JSON.parse(sessionStorage.getItem(returnKey));if(r?.restore&&r.url===location.href){document.querySelector('#main').scrollTop=r.scroll;document.querySelector('[data-open-details]')?.focus({preventScroll:true});sessionStorage.removeItem(returnKey);}}catch{}}
 document.addEventListener('click',ev=>{
  const control=ev.target.closest('[data-action]');if(!control)return;const action=control.dataset.action;
  if(action==='lasting'){
   const l=v.lasting,body=native?l.body.replace('in Settings','on pve-02’s page in Overview'):l.body;
   modal(l.title,`<p>${esc(body)}</p>`,`<button data-action="cancel" data-initial>${esc(l.keep)}</button>${button(l.confirm,'confirm','primary')}`);return;
  }
  if(action==='check'){preview(`Ask ${S.assistant} to check`,`Check whether my answer to “${v.question}” was saved and what happened. Don’t send the answer or run the action again.`);return;}
  if(action?.startsWith('answer:')){
   const words=action==='answer:no'?'You said no.':action==='answer:tonight'?`Approved for ${exact(D.tonight)}.`:'Your answer was saved.';
   const region=sheet||document.querySelector('.native-approval')||document.querySelector('.approval-card');
   region.querySelector('.sheet-content,.card-content').innerHTML=`<h1 class="question">${esc(v.question)}</h1><p class="answer-result" role="status" tabindex="-1">${esc(words)}</p>`;region.querySelector('.answer-bar').hidden=true;region.querySelector('[role="status"]').focus();
  }
 });
 document.fonts.ready.then(()=>requestAnimationFrame(()=>{
  if(q.get('technical')==='open')document.querySelector('.sheet-content details,.card-content details')?.setAttribute('open','');
  if(q.get('scroll')==='end'){const c=sheet?.querySelector('.sheet-content')||document.querySelector('.native-approval .sheet-content')||document.querySelector('#main');c.scrollTop=c.scrollHeight;}
  document.documentElement.dataset.ready='true';
 }));
})();
