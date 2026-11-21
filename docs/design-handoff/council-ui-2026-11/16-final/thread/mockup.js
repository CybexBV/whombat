// Read-only thread drawing. Shared final story and shell are binding and unmodified.
(() => {
 const S=FINAL_STORY,{esc,icon,mount,base}=FinalShell;
 const q=new URLSearchParams(location.search);
 const platform=['desktop','phoneweb','ios','android'].includes(q.get('platform'))?q.get('platform'):'desktop';
 const native=['ios','android'].includes(platform),theme=q.get('theme')==='dark'?'dark':'light';
 const scene=['council','council-answers','delegation','delegation-working','delegation-records','plan','plan-open','plan-blocked','plan-blocked-open'].includes(q.get('scene'))?q.get('scene'):'normal';
 const state=['loading','empty','failed','saved-failed'].includes(q.get('state'))?q.get('state'):'normal';
 document.body.dataset.text=q.get('text')==='largest'?'largest':'normal';
 document.body.dataset.scene=scene;document.body.dataset.readState=state;
 const words=value=>esc(String(value??'').replaceAll('{assistant}',S.assistant));
 const asset=part=>new URL('../../../../packages/'+part,base).href;
 const face=asset('avatars/svg/operator-head-small.svg');
 const stamp=at=>new Intl.DateTimeFormat('en-GB',{timeZone:S.timeZone,hour:'2-digit',minute:'2-digit'}).format(new Date(at));
 const url=(file,params={})=>new URL(file+'?'+new URLSearchParams({platform,theme,...params}),base).href;
 const body=S.threadBodies['msg_chat-memory'];
 const thread=S.threads.find(t=>t.rootId===body.root.id);
 const offer=structuredClone(Cards.dataFor('delegation-offer'));
 const council=Cards.dataFor('council-done');
 const working=Cards.dataFor('delegation-working');
 const everyday=scene.startsWith('plan');
 const topic=everyday?'Invoice PDF export':scene==='normal'?body.root.text:scene.startsWith('council')?council.title:scene==='delegation'?offer.title:working.title;
 const time=everyday?null:scene==='normal'?body.replies.at(-1).createdAt:scene.startsWith('council')?council.endedAt:scene==='delegation'?offer.startedAt:working.handedAt;
 const button=(text,attributes='',cls='')=>`<button type="button" class="${cls}" ${attributes}>${text}</button>`;
 const primary=(text,attributes='')=>button(text,attributes,'primary');
 // Only the Markdown constructs present in these read-only fixture answers are needed.
 // Escape first: fixture text cannot inject markup or execute a link.
 const inline=text=>words(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
 function markdown(text){
  let html='',list=null;
  const close=()=>{if(list){html+=`</${list}>`;list=null;}};
  for(const line of String(text||'').split('\n')){
   const ordered=line.match(/^\d+\.\s+(.+)/),bullet=line.match(/^[-*]\s+(.+)/);
   if(ordered||bullet){const kind=ordered?'ol':'ul';if(list!==kind){close();html+=`<${kind}>`;list=kind;}html+=`<li>${inline((ordered||bullet)[1])}</li>`;}
   else{close();if(line.trim())html+=`<p>${inline(line)}</p>`;}
  }close();return html;
 }
 const aiWords=ai=>ai?[ai.label||ai.model,ai.effort==='xhigh'?'Extra high':ai.effort].filter(Boolean).join(' · '):'T3 Code’s default';
 function aiSummary(){
  const groups=new Map();for(const t of offer.tasks.filter(t=>t.picked)){const text=aiWords(t.ai||offer.ai);if(!groups.has(text))groups.set(text,[]);groups.get(text).push(t.n);}
  return [...groups].map(([ai,ids])=>`<span><b>${ids.join(', ')}:</b> ${words(ai)}</span>`).join('');
 }
 function dependency(){return offer.tasks.filter(t=>t.picked&&t.after).map(t=>`Task ${t.n} starts after task ${t.after}.`).join(' ')||'No selected tasks depend on another task.';}
 function taskCheck(t,inDetails=false){return `<label class="task-choice" data-task="${t.n}"><input type="checkbox" data-task-check="${t.n}" ${t.picked?'checked':''} aria-label="Select task ${t.n}: ${words(t.title)}"><span><b class="task-n">${t.n}.</b> ${words(t.title)}${inDetails?`<small>${words(t.why)}</small>`:''}</span></label>`;}
 function delegation(){
  return `<article class="work-card delegation-card" aria-label="Tasks: ${words(offer.title)}" data-card="delegation"><div class="card-status"><span class="waiting-dot" aria-hidden="true"></span><span>Waiting for you</span><span class="card-kind">· Tasks</span><time>${stamp(offer.startedAt)}</time></div><h2 class="sr-only">${words(offer.title)}</h2><div class="selected-tasks" aria-label="Selected tasks">${offer.tasks.filter(t=>t.picked).map(t=>taskCheck(t)).join('')}<p class="extra-selection" data-extra-selection hidden></p></div><p class="dependency" data-dependency>${dependency()}</p><p class="effective-ai"><b>AI</b><span data-ai-summary>${aiSummary()}</span></p><div class="main-action"><span class="split">${primary('Hand over 3','data-handover')}<button class="primary split-arrow" aria-label="AI for every task" data-ai="0">⌄</button></span></div><details class="card-details" id="card-details"><summary>Details</summary><div class="detail-content"><h3>Other task</h3>${offer.tasks.filter(t=>!t.picked).map(t=>taskCheck(t,true)).join('')}<h3>Why these tasks</h3>${offer.tasks.filter(t=>t.picked).map(t=>`<section class="task-detail"><h4>${t.n}. ${words(t.title)}</h4><p>${words(t.why)}</p>${button('Change AI',`data-ai="${t.n}" aria-label="Change AI for task ${t.n}"`)}</section>`).join('')}<p>Up to ${offer.atOnce} tasks run at once, each on its own branch. Pull requests are merged one at a time.</p></div></details></article>`;
 }
 const taskState=t=>t.checks==='failing'?'Checks still failing':t.pending==='question'?`Asked ${S.assistant}`:t.state==='queued'&&t.after?`Waiting for task ${t.after}`:t.merge==='merging'?'Finishing the changes':t.merge==='waiting'?'Waiting to finish':t.checks==='running'?'Waiting for checks':t.merge==='merged'?'Finished':'Working';
 function delegationWorking(){
  const remaining=working.tasks.filter(t=>t.picked&&t.merge!=='merged');
  return `<article class="work-card delegation-card" aria-label="Tasks: ${words(working.title)}" data-card="delegation-working"><div class="card-status"><span aria-hidden="true">↗</span>Handed over <span class="card-kind">· Tasks</span><time>${stamp(working.handedAt)}</time></div><h2 class="sr-only">${words(working.title)}</h2><p class="short-result">2 finished · ${remaining.length} still in progress</p><ol class="working-tasks">${remaining.map(t=>`<li><span class="task-n">${t.n}.</span><div><strong>${words(t.title)}</strong><p>${words(taskState(t))}</p>${t.checks==='failing'?`<p>${words(t.note)}</p>`:''}</div></li>`).join('')}</ol><div class="main-action">${primary('Open tasks','data-preview="Open the existing task list"')}${button('Stop','data-stop')}</div><details class="card-details" id="card-details" ${scene==='delegation-records'?'open':''}><summary>Details</summary><div class="detail-content"><h3>Task records and pull requests</h3>${working.tasks.filter(t=>t.picked).map(t=>`<section class="task-detail"><h4>${t.n}. ${words(t.title)}</h4><p>${words(taskState(t))}</p>${t.note?`<p>${words(t.note)}</p>`:''}${t.pr?`<a class="button" href="${esc(t.pr)}" data-external aria-label="Open pull request for ${words(t.title)}">Pull request #${esc(String(t.pr).split('/').pop())}</a>`:''}${t.branch?`<p>Branch: <code>${words(t.branch)}</code></p>`:''}${button('More',`data-preview="More for ${words(t.title)}" aria-label="More for ${words(t.title)}"`)}${(t.shots||[]).map(s=>`<figure><img src="../../04-cards/png/fixture-settings.png" alt="${words(s.view)}, fixture before above and after below"><figcaption>${words(s.view)}</figcaption></figure>${s.notes.map(n=>`<p>${n.n}. ${words(n.text)}</p>`).join('')}`).join('')}</section>`).join('')}</div></details></article>`;
 }
 function councilCard(){
  const agrees=council.members.filter(m=>m.verdict==='agree').length;
  return `<article class="work-card council-card" data-card="council" aria-label="Council: ${words(council.title)}"><div class="card-status"><span aria-hidden="true">✓</span>Done <span class="card-kind">· Council</span><time>${stamp(council.endedAt)}</time></div><h2 class="card-title">${words(council.title)}</h2><p class="council-result">${agrees===council.members.length?'All three agree.':`${agrees} agree.`}</p><p class="card-summary">The members finished reviewing the Settings changes.</p><div class="main-action">${primary('Read the answers','data-read-answers aria-controls="card-details" aria-expanded="false"')}</div><details class="card-details" id="card-details" ${scene==='council-answers'?'open':''}><summary>Details</summary><div class="detail-content"><h3>The answers</h3>${council.members.map(m=>`<section class="member-answer" aria-label="${words(m.name)}’s answer"><h4>${m.mark?`<img class="provider-mark" src="${asset('brand/assets/marks/'+m.mark+'.svg')}" alt="">`:''}${words(m.name)}</h4><p class="member-verdict">${m.verdict==='agree'?'Agrees':'Wants changes'}</p><div class="markdown">${markdown(m.answer)}</div></section>`).join('')}<h3>The plan</h3><div class="markdown">${markdown(council.plan)}</div><h3>What changed</h3>${council.shots.map(s=>`<figure><img src="../../04-cards/png/fixture-settings.png" alt="${words(s.view)}, fixture before above and after below"><figcaption>${words(s.view)}</figcaption></figure>${s.notes.map(n=>`<p>${n.n}. ${words(n.text)}</p>`).join('')}`).join('')}</div></details></article>`;
 }
 function approval(card){
  return ApprovalCard.render({...FINAL_APPROVAL.primary,approval:card.approval,tonight:FINAL_APPROVAL.tonight});
 }
 // These additional cards are specimens; they do not add messages or Inbox records.
 function everydayCard({kind,status,mark,title,at,summary,extra,main,others='',records='',tone=''}){
  const expanded=platform==='desktop'||scene.endsWith('-open');
  return `<article class="work-card everyday-card ${tone}" data-card="${kind}" aria-label="${words(title)}"><div class="card-status"><span class="status-mark" aria-hidden="true">${mark}</span><span>${words(status)}</span><time${at?` datetime="${at}"`:''}>${at?stamp(at):'Time not supplied'}</time></div><h2 class="card-title">${words(title)}</h2><p class="card-summary everyday-summary">${summary}</p><div class="main-action">${main}${others}</div><details class="card-expansion" ${expanded?'open':''}><summary><span class="when-closed">Show more</span><span class="when-open">Show less</span></summary><div class="everyday-open">${extra}<details class="card-details"><summary>Details</summary><div class="detail-content">${records}</div></details></div></details></article>`;
 }
 function planCard(){
  const blocked=scene.startsWith('plan-blocked'),p=Cards.dataFor(blocked?'plan-go-ahead':'plan').plan;
  const current=blocked?p.steps.find(s=>s.state==='gate'):p.steps.find(s=>s.state==='active');
  const summary=blocked?'Waiting for your review against the brief so the next step can start.':'Now: building the invoice export so invoices can be downloaded as PDFs.';
  const stepTitle=title=>({'Pick a PDF library':'Choose how to make PDFs','Build the export endpoint':'Build the invoice export','Deploy to staging':'Try it before publishing'}[title]||title);
  const steps=p.steps.map((step,i)=>`<li><span aria-hidden="true">${step.state==='done'?'✓':step===current?'→':'·'}</span><div><strong>${words(stepTitle(step.title))}</strong><p>${words(step===current?(blocked?'Waiting for you':'Current step'):step.stateLabel)}</p></div></li>`).join('');
  return everydayCard({kind:'plan',status:blocked?'Waiting for you':'{assistant} is working',mark:blocked?'○':'◌',title:p.title,at:p.updatedAt,summary,main:primary(blocked?'Go ahead':'Open plan',blocked?'data-plan-go':'data-plan-open'),others:blocked?button('Change something','data-plan-change'):'',tone:blocked?'waiting-card':'',extra:`<p class="step-focus"><b>${blocked?'Blocked step':'Current step'}</b>${words(stepTitle(current.title))}</p><ol class="plan-steps">${steps}</ol><p class="card-summary">${blocked?'Your go-ahead starts the review; putting it live keeps its separate approval.':'The review and trying the change stay in their recorded order.'}</p>`,records:`<p>Plan: <code>${words(p.id)}</code></p><p>Due ${words(p.due)}</p>${p.steps.map(step=>`<p><b>${words(step.title)}</b> · ${words(step.stateLabel)}${step.refs.runNumber?` · Run #${step.refs.runNumber}`:''}${step.refs.approvalNumber?` · Approval #${step.refs.approvalNumber}`:''}</p>`).join('')}`});
 }
 function message(m){
  const own=m.authorId===S.person.id;
  const name=own?'Your message':`${S.assistant}’s message`;
  const ai=m.ranOn?`${m.ranOn.provider==='codex'?'Codex':'Claude'} · ${m.ranOn.modelLabel} · ${m.ranOn.effort}`:'';
  const changed=m.id===body.replies.at(-1).id&&m.ranOn;
  return `${changed?`<div class="model-change">Switched to ${words(m.ranOn.modelLabel)}</div>`:''}<article class="thread-message ${own?'own':''}" id="${m.id}"><div class="message-reading" ${native?`role="group" tabindex="0" aria-label="${esc(name+', '+stamp(m.createdAt)+'. '+m.text)}" data-message="${m.id}"`:''}><div class="message-meta" ${native?'aria-hidden="true"':''}>${own?'':`<img class="assistant-face" src="${face}" alt=""><strong>${esc(S.assistant)}</strong>`}<time datetime="${m.createdAt}" ${ai?`title="${esc(ai)}"`:''}>${stamp(m.createdAt)}</time>${native?'':button('⋯',`aria-label="Actions for ${esc(name.toLowerCase())} at ${stamp(m.createdAt)}" data-message="${m.id}"`,'icon-button')}</div><p class="message-words" ${native?'aria-hidden="true"':''}>${words(m.text)}</p></div>${m.subject?`<a class="subject" href="${url('shell.html',{place:'server'})}" aria-label="pve-02, Needs a look">pve-02</a>`:''}${m.card?.kind==='approval'?approval(m.card):''}</article>`;
 }
 function failure(saved){return `<section class="read-problem" aria-labelledby="read-title"><h2 id="read-title">Couldn’t ${saved?'refresh':'read'} this thread.</h2><p>${saved?'Showing the messages already on this device.':'There’s no saved copy to show on this device yet.'}</p><div class="recovery">${button('Try again','data-retry')}${button('Ask '+esc(S.assistant),'data-ask')}</div><details><summary>More detail</summary><p>The fixture read did not answer.</p><code>messages.thread</code></details><p class="sr-only" role="status" data-read-status></p></section>`;}
 function content(){
  if(state==='loading')return `<section class="thread-state" aria-label="Loading this thread"><p role="status">Loading this thread…</p><div class="skeletons" aria-hidden="true">${[1,2,3].map(()=>'<div><i></i><span></span><span></span></div>').join('')}</div></section>`;
  if(state==='failed')return `<div class="thread-state">${failure(false)}</div>`;
  if(state==='empty')return `<div class="thread-body">${scene==='normal'?message(body.root):''}<section class="empty-thread"><h2>No replies yet.</h2><p>Keep the conversation here.</p>${button('Write a reply','data-compose')}</section></div>`;
  let html=scene==='normal'?`<div class="day">Today · Wednesday 23 September</div>${[body.root,...body.replies].map(message).join('')}`:scene==='delegation'?delegation():scene.startsWith('delegation-')?delegationWorking():everyday?planCard():councilCard();
  return `<div class="thread-body">${state==='saved-failed'?failure(true):''}${html}<div class="thread-end" aria-hidden="true"></div></div>`;
 }
 const back=platform==='ios'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>':icon('arrow');
 const header=`<header class="thread-header"><a class="back-link" href="${url('chat-list/mockup.html')}" aria-label="Back to Chat">${back}${platform==='android'?'':'<span>Chat</span>'}</a><div class="topic"><h1 id="thread-topic" tabindex="-1">${words(topic)}</h1>${platform==='desktop'&&scene==='normal'&&['normal','saved-failed'].includes(state)?'<p>3 replies · Waiting for you</p>':''}</div>${button('⋯','data-thread-menu aria-label="More in this thread"','icon-button')}</header>`;
 const footer=`<form class="thread-composer" aria-label="Reply in this thread"><div class="composer-box"><textarea id="reply" rows="1" aria-label="Reply in this thread" placeholder="${native?'Reply…':'Reply to '+esc(S.assistant)+'…'}"></textarea><div class="composer-tools">${native?'':button(icon('file')+(platform==='desktop'?'<span>File</span>':''),'aria-label="Attach a file" data-preview="Attach a file"','icon-button')}${button(`<img src="${asset('brand/assets/marks/claude.svg')}" alt="">`,`aria-label="Choose how ${esc(S.assistant)} answers" data-preview="Choose AI"`,'icon-button')}${button(icon('mic'),'aria-label="Dictate a reply" data-preview="Dictate a reply"','icon-button')}${button(icon('send'),'aria-label="Send reply" data-send','icon-button send')}</div></div></form>`;
 mount({platform,theme,active:'chat',title:topic,header,content:content(),footer,hideTabs:true});
 const details=document.querySelector('#card-details');
 if(details){const read=document.querySelector('[data-read-answers]');if(read)read.setAttribute('aria-expanded',String(details.open));details.addEventListener('toggle',()=>read?.setAttribute('aria-expanded',String(details.open)));}
 let opener;
 const dialog=document.createElement('dialog');dialog.className='thread-dialog';dialog.setAttribute('aria-labelledby','dialog-title');document.body.append(dialog);
 function open(control,title,html){if(!dialog.open)opener=control;dialog.innerHTML=`<header><h2 id="dialog-title">${esc(title)}</h2>${button('×','aria-label="Close" data-close','icon-button')}</header><div class="dialog-body">${html}</div>`;if(!dialog.open)dialog.showModal();dialog.querySelector('select,input,button:not([data-close])')?.focus();}
 dialog.addEventListener('close',()=>opener?.focus({preventScroll:true}));
 dialog.addEventListener('click',e=>{if(e.target.closest('[data-close]'))dialog.close();});
 function updateOffer(){
  document.querySelector('[data-dependency]').textContent=dependency();document.querySelector('[data-ai-summary]').innerHTML=aiSummary();
  const picked=offer.tasks.filter(t=>t.picked);const main=document.querySelector('[data-handover]');main.textContent=`Hand over ${picked.length}`;main.disabled=!picked.length;
  const extra=offer.tasks.find(t=>t.n===3&&t.picked);const el=document.querySelector('[data-extra-selection]');el.hidden=!extra;if(extra)el.textContent=`✓ 3. ${extra.title}`;
 }
 document.addEventListener('change',e=>{if(e.target.matches('[data-task-check]')){const t=offer.tasks.find(t=>t.n===Number(e.target.dataset.taskCheck));t.picked=e.target.checked;updateOffer();}});
 document.addEventListener('click',e=>{
  const control=e.target.closest('button,a,summary,[data-message]');if(!control)return;
  if(control.matches('[data-close]'))return;
  if(control.matches('[data-plan-open]')){const expansion=document.querySelector('.card-expansion');expansion.open=true;document.querySelector('.step-focus').scrollIntoView({block:'nearest',behavior:'instant'});}
  if(control.matches('[data-plan-go]'))open(control,'Design preview','<p>Your go-ahead starts the review against the brief. This drawing sends nothing.</p>');
  if(control.matches('[data-plan-change]')){const input=document.querySelector('#reply');input.value='I’d like to change the plan: ';input.focus();}
  if(control.matches('[data-read-answers]')){details.open=true;return;}
  if(control.matches('[data-compose]')){const reply=document.querySelector('#reply');if(dialog.open){opener=reply;dialog.close();}reply.focus();}
  if(control.matches('[data-thread-menu]'))open(control,'Thread actions',button('Reply','data-compose')+button('Copy link','data-preview="Copy the thread link"'));
  if(control.matches('[data-message]')){const m=[body.root,...body.replies].find(m=>m.id===control.dataset.message);open(control,'Message actions',button('Reply','data-compose')+button('Copy','data-preview="Copy the message"')+(m?.authorId===S.person.id?button('Edit message','data-preview="Edit your message"'):'')+button('Copy link','data-preview="Copy the message link"'));}
  if(control.matches('[data-retry]'))document.querySelector('[data-read-status]').textContent='Reading again…';
  if(control.matches('[data-ask]')){const input=document.querySelector('#reply');input.value='Can you help me read this thread?';input.focus();}
  if(control.matches('[data-ai]')){
   const n=Number(control.dataset.ai);open(control,n?`AI for task ${n}`:'AI for every task',`<label class="ai-field">AI<select><option>T3 Code’s default</option><option>Claude Opus 5.5 · Extra high</option><option>GPT 6.1 Sol · High · Fast</option></select></label>${button('Done','data-ai-done')}`);
   dialog.querySelector('[data-ai-done]').onclick=()=>{const value=dialog.querySelector('select').value,ai=value==='T3 Code’s default'?null:{label:value};if(n)offer.tasks.find(t=>t.n===n).ai=ai;else offer.ai=ai;updateOffer();dialog.close();};
  }
  if(control.matches('[data-handover]'))open(control,'Design preview','<p>Hand over starts the selected tasks in the app. This drawing sends nothing and adds no confirmation step.</p>');
  if(control.matches('[data-stop]'))open(control,'Stop this work?','<p>Stop ends the remaining work after confirmation.</p>'+button('Keep going','data-close')+button('Stop','data-close'));
  if(control.matches('[data-approval-answer]')){e.preventDefault();open(control,'Design preview',`<p>This drawing previews “${control.textContent}”. No answer is sent.</p>`);}
  if(control.matches('[data-approval-lasting]')){const l=FINAL_APPROVAL.primary.view.lasting;open(control,l.title,`<p>${words(l.body)}</p>`+button(l.keep,'data-close')+button(l.confirm,'data-close'));}
  if(control.matches('[data-answer],[data-open-approval]')){e.preventDefault();open(control,'Approval 33',`<p>${words(body.replies.at(-1).card.approval.title)}</p><p>This drawing opens the existing approval flow. No answer is sent.</p>`);}
  if(control.matches('[data-preview],[data-external]')){e.preventDefault();open(control,control.dataset.preview||'Open pull request','<p>This drawing previews its existing destination. It makes no change.</p>');}
 });
 document.querySelector('form').addEventListener('submit',e=>e.preventDefault());
 document.querySelector('#reply').addEventListener('input',e=>document.querySelector('[data-send]').classList.toggle('ready',!!e.target.value.trim()));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.querySelector('dialog[open]'))location.href=url('chat-list/mockup.html');if(e.shiftKey&&e.key==='F10'&&e.target.matches('[data-message]')){e.preventDefault();e.target.click();}});
 document.addEventListener('contextmenu',e=>{const m=e.target.closest('[data-message]');if(native&&m&&!getSelection()?.toString()){e.preventDefault();m.click();}});
 if(scene==='normal'&&state==='normal')document.fonts.ready.then(()=>requestAnimationFrame(()=>{
  const main=document.querySelector('#main'),latest=document.querySelector('#'+body.replies.at(-1).id);
  if(platform==='desktop'){main.scrollTop=Math.max(0,main.scrollHeight-main.clientHeight);return;}
  const frame=main.getBoundingClientRect(),card=latest.querySelector('.decision-card');
  // Arrive at a complete message or card boundary after the bundled fonts have settled.
  const anchor=latest.getBoundingClientRect().height<=main.clientHeight-24?latest:card;
  const shift=anchor.getBoundingClientRect().top-frame.top-12;
  const tail=document.querySelector('.thread-end');
  const extra=Math.max(0,main.scrollTop+shift+main.clientHeight-main.scrollHeight);
  if(extra)tail.style.height=(tail.getBoundingClientRect().height+extra)+'px';
  main.scrollTop+=Math.max(0,shift);
 }));
 window.ThreadStudy={platform,theme,scene,state,topic,offer,markdown};
})();
