// Static drawings only: buttons never send an approval, a command, an email or a question.
(() => {
  const world = window.APPROVAL_FIXTURE;
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  const platform = q.get('platform') || 'web';
  const native = platform !== 'web';
  const surface = q.get('surface') || (native ? 'phone' : 'card');
  const kind = Object.hasOwn(world.worlds, q.get('kind')) ? q.get('kind') : 'everyday';
  const state = q.get('state') || 'pending';
  const largest = q.get('text') === 'largest';
  const longMail = q.get('length') === 'long';
  const w = world.worlds[kind], a = w.approval, v = w.states.pending.view;
  const mailBody = kind === 'mail' && longMail ? Array(4).fill(a.action.params.body).join('\n\n') : a.action.params.body;
  const assistant = world.assistant; // Captured agentWords(theAgentOf(bootstrap.principals).name).name.
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const at = new Intl.DateTimeFormat('en-GB', {timeZone:world.timeZone,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(a.createdAt));
  const tonight = `${new Intl.DateTimeFormat('en-GB', {timeZone:world.timeZone,weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date(world.tonight))} at ${new Intl.DateTimeFormat('en-GB', {timeZone:world.timeZone,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(world.tonight))} · ${world.timeZone}`;
  const btn = (text, action, primary=false) => `<button type="button" data-action="${action}" class="${primary?'primary':''}">${e(text)}</button>`;
  const fact = (name,text) => `<div class="fact"><span class="label">${e(name)}</span><p>${e(text)}</p></div>`;
  const avatar = `<img class="avatar" src="../../../../packages/avatars/svg/${e(world.avatar)}" alt="${e(assistant)}">`;
  const detailsLink = `<a data-details href="mockup.html?${new URLSearchParams({...Object.fromEntries(q),surface:'details',platform:'web',kind,theme})}">Details</a>`;
  const details = surface === 'details';
  const everyday = kind === 'everyday' || kind === 'mail';
  document.documentElement.dataset.theme = theme;
  document.body.className = `${native?'native-page':details?'details-mode':''} ${!native&&largest?'web-text':''}`;
  function answerChoices() {
    if (kind === 'command') {
      const choices = v.scopeChoices.map((c,i)=>btn(c.label,c.scope,i===0));
      return `<div class="answer-buttons command">${details?choices.slice(1).join('')+btn(v.declineCta,'decline')+choices[0]:choices.join('')+btn(v.declineCta,'decline')}${!native&&!details?detailsLink:''}</div>`;
    }
    if (everyday) return `<div class="answer-buttons ${details?'':'three'}">${btn(details?'Yes, do it':'Yes, now','once',!native||details)}${!details?btn('Yes, tonight','tonight'):''}${btn('No','decline')}${!native&&!details?detailsLink:''}</div>`;
    if (!native&&!details) return `<div class="answer-buttons">${btn(v.cta,'once',true)}${detailsLink}</div>`;
    const yes = btn(native?v.mobileCta:v.cta,'once',true), no = btn(v.declineCta,'decline');
    return `<div class="answer-buttons">${native&&largest?yes+no:no+yes}</div>`;
  }
  function conditions() {
    // A sole person condition is already asked by the answers. Deploy keeps its full condition list.
    const rows = native && v.conditions.length===1 && v.conditions[0].kind==='person_approves' ? [] : v.conditions;
    if (!rows.length) return '';
    return `<section class="conditions" aria-label="Conditions">${rows.map(c=>`<div class="condition"><p>${e(native?c.mobileLabel:c.label)}</p><span class="condition-state">${c.met?'Met':'Not yet'}</span><span class="meta">${e(native?c.mobileNote:c.note)}</span></div>`).join('')}</section>`;
  }
  function content() {
    const title = native||details?v.question:v.title;
    const head = native?`<div class="person">${avatar}<div><p class="label">${e(state==='answer-unknown'?'Answer not confirmed':everyday?`${assistant} needs your OK`:v.mobileLabel)}</p><p class="meta">${e(assistant)} · Chat · ${at}</p></div></div>`:`<p class="label waiting">${e(state==='answer-unknown'?'Answer not confirmed':everyday?`${assistant} needs your OK`:v.label)}</p>`;
    if (state==='loading') return `<div class="loading" role="status" aria-label="Loading the approval"><p>Loading the approval…</p><div aria-hidden="true"><div class="skeleton"></div><div class="skeleton short"></div><div class="skeleton"></div></div></div>`;
    if (state==='load-error') return `<section class="outcome" role="status"><h1 id="question" tabindex="-1">Couldn’t load the approval.</h1><p>There’s no saved approval to show on this device yet.</p><details><summary>More detail</summary><p>The fixture approval read did not answer.</p></details></section>`;
    let html = `${head}${state==='answer-unknown'||state==='answer-refused'?failure():''}<h1 class="question" id="question" tabindex="-1">${e(title)}</h1><div class="facts">`;
    // The title carries the action once. Only additional supplied facts follow it.
    if (kind==='everyday') html += `<p class="body-copy">${e(a.whatHappens[0])}.</p>`;
    if (kind==='command') html += fact('Why',a.action.params.reason);
    if (kind==='deploy') html += fact('Applies to',`billing-api · staging · latest commit on ${a.action.params.ref}`)+`<div class="fact"><ul>${a.whatHappens.slice(1).map(s=>`<li>${e(s)}</li>`).join('')}</ul></div>`;
    if (kind==='mail') html += fact('From',a.action.params.connectionEmail)+fact('To',a.action.params.to.join(', '))+fact('Subject',a.action.params.subject)+fact('Copies',a.action.params.cc.length||a.action.params.bcc.length?'': 'No Cc or Bcc');
    if (kind==='key') html += `<p class="body-copy">To use without asking.</p>`;
    html += fact(kind==='key'?'Permission requested':'Permission used',`“${w.keyLabel}”`)+'</div>';
    if (everyday&&!details) html += `<p class="timing"><strong>Yes, tonight</strong> means<br>${e(tonight)}.</p>`;
    html += conditions();
    if (kind==='command') html += `<div class="fact"><span class="label">Command · ${e(a.action.params.target)}</span><pre class="code" tabindex="0" aria-label="The command">${e(a.action.params.command)}</pre></div>`;
    if (kind==='mail'&&(native||details)) html += `<div class="fact"><span class="label">Message</span><div class="mail-body" tabindex="0" aria-label="The whole message">${e(mailBody)}</div></div>`;
    if (kind!=='command') html += `<details><summary>Technical details</summary><p class="meta">${e(a.target)}</p>${a.connection?.argumentsPreview?`<pre class="code">${e(a.connection.argumentsPreview)}</pre>`:''}${kind==='mail'&&!native&&!details?`<div class="mail-body" tabindex="0" aria-label="The whole message">${e(mailBody)}</div>`:''}${kind==='everyday'?`<p>${e(a.explainer)}</p>`:''}</details>`;
    if (v.lasting) html += `<div class="lasting">${btn(v.lasting.link,'lasting')}</div>`;
    return html;
  }
  function failure() {
    if (state==='answer-refused') return `<section class="outcome" role="status" tabindex="-1"><h2>Your answer wasn’t saved.</h2><p>The request wasn’t sent. You can answer again.</p></section>`;
    return `<section class="outcome" role="status" tabindex="-1"><h2>Your answer may have gone through.</h2><p>Whombat didn’t get a reply. Check what happened before answering again.</p><details><summary>More detail</summary><p>${kind==='command'?'The fixture command receipt has an unknown outcome.':'The fixture answer delivery did not return a receipt.'}</p></details></section>`;
  }
  function footer() {
    if (state==='loading') return '';
    if (state==='load-error') return `<div class="recover">${btn('Try again','reload')}<a href="index.html">Back to Chat</a></div>`;
    if (state==='answer-unknown') return `<div class="recover">${btn(`Ask ${assistant} to check`,'check')}<p class="recover-note">Check only; don’t send the answer again.</p></div>`;
    if (state==='answer-refused') return answerChoices();
    return answerChoices();
  }
  const approval = `<section class="approval ${details?'details-surface':''}" aria-label="Approval">${details?'<header class="details-header"><span>Approval details</span><a data-close href="index.html" aria-label="Close approval details">✕</a></header>':''}<div class="content" tabindex="0" aria-label="Approval content"><div class="content-inner">${content()}</div></div><footer class="answers" aria-label="${state==='pending'||state==='answer-refused'?'Approval answers':'Approval recovery'}">${footer()}</footer></section>`;
  const subject = kind==='everyday'?'pve-02':kind==='command'?'web-1':kind==='deploy'?'billing-api':kind==='mail'?'Invoice 1042':assistant;
  const app=document.querySelector('#app');
  app.innerHTML = native?`<section class="native ${platform} ${largest?'largest':''}" aria-label="${platform==='ios'?'iOS':'Android'} approval drawing"><div class="systembar" aria-hidden="true"><span>11:22</span><span>▰</span></div><nav class="backbar" aria-label="Back"><a href="index.html" aria-label="Back to Chat">${platform==='ios'?'‹ Chat':'←'}</a></nav>${approval}</section>`:`<div class="shell"><nav class="sidebar" aria-label="Main navigation"><strong>Burrow HQ</strong>${['Search','Chat','Inbox','Overview','Automations','Files','Vault','Usage'].map(s=>`<a href="index.html" ${s==='Chat'?'aria-current="page"':''}>${s}</a>`).join('')}</nav><section class="web-body"><nav class="webbar" aria-label="Phone browser navigation"><button class="quiet menu" data-action="drawer" aria-label="Open the sidebar">☰</button><strong>Chat</strong><a href="index.html">Search</a><a href="index.html">Inbox</a></nav>${details?'':`<nav class="threadbar" aria-label="Thread"><a href="index.html">‹ Chat</a><span class="subject">${e(subject)}</span></nav>`}<div class="stage">${details?`<dialog class="details-dialog" aria-label="Approval details">${approval}</dialog>`:`<article class="message">${avatar}<div class="message-main"><div class="author">${e(assistant)}<span class="meta">${at}</span></div>${approval}</div></article>`}</div></section></div>`;
  if(details) app.querySelector('.details-dialog').showModal();
  if (state==='loading') app.querySelector('.answers').hidden=true;
  if (state==='answer-unknown'||state==='load-error'||state==='loading') app.querySelector('.approval').style.borderColor='var(--line)';
  const live=document.createElement('div');live.setAttribute('role','status');live.className='sr-only';app.append(live);
  function dialog(title,body,buttons) {
    const opener=document.activeElement;
    const d=document.createElement('dialog');d.setAttribute('aria-labelledby','dialog-title');d.innerHTML=`<h2 id="dialog-title">${e(title)}</h2><p>${e(body)}</p><div class="answer-buttons">${buttons}</div>`;
    document.body.append(d);d.showModal();d.querySelector('button').focus();
    d.addEventListener('close',()=>{d.remove();opener?.focus();});
    d.addEventListener('click',ev=>{if(ev.target.closest('button'))d.close();});
  }
  app.addEventListener('click',ev=>{
    const b=ev.target.closest('[data-action]');if(!b)return;
    const action=b.dataset.action;
    if(action==='lasting'){
      const l=v.lasting;dialog(l.title,native?l.body.replace('in Settings','on pve-02’s page in Overview'):l.body,btn(l.keep,'cancel')+btn(l.confirm,'confirm',true));return;
    }
    if(action==='drawer'){dialog('Sidebar','Static navigation preview. Search, Chat, Inbox, Overview, Automations, Files, Vault and Usage keep their destinations.',btn('Close the sidebar','cancel'));return;}
    if(action==='check'){dialog(`Ask ${assistant} to check`,`Check whether my answer to “${v.question}” was saved and what happened. Don’t send the answer or run the action again.`,btn('Back to approval','cancel'));return;}
    if(action==='reload'){live.textContent='Loading the approval…';b.focus();return;}
    const contentEl=app.querySelector('.content-inner');
    const message=action==='decline'?'You said no · 11:22':action==='tonight'?'Scheduled for tonight, 03:00':kind==='deploy'?'Approved · waiting for checks':kind==='command'?v.toasts.approve:kind==='mail'?v.toasts.approve:kind==='key'?v.toasts.approve:'Running';
    contentEl.innerHTML=`<h1 class="question">${e(v.question)}</h1><p class="result" role="status" tabindex="-1">${e(message)}</p>`;
    app.querySelector('.approval').style.borderColor='var(--line)';app.querySelector('.answers').hidden=true;contentEl.querySelector('[role=status]').focus();
  });
  // Keep the card's exact opener and scroll when its modal closes.
  const storageKey='approval-design-return';
  app.querySelector('[data-details]')?.addEventListener('click',()=>{
    sessionStorage.setItem(storageKey,JSON.stringify({url:location.href,kind,scroll:app.querySelector('.content').scrollTop,restore:false}));
  });
  if(details){
    const back=new URLSearchParams(q);back.set('surface','card');
    let origin=null;try{origin=JSON.parse(sessionStorage.getItem(storageKey));}catch{}
    const href=origin?.kind===kind?origin.url:`mockup.html?${back}`;
    const close=app.querySelector('[data-close]');close.href=href;
    const returning=()=>{if(origin?.kind===kind)sessionStorage.setItem(storageKey,JSON.stringify({...origin,restore:true}));};
    close.addEventListener('click',returning);
    app.querySelector('.details-dialog').addEventListener('cancel',ev=>{ev.preventDefault();returning();location.href=href;});
  }else{
    let origin=null;try{origin=JSON.parse(sessionStorage.getItem(storageKey));}catch{}
    if(origin?.restore&&origin.kind===kind&&origin.url===location.href){
      app.querySelector('.content').scrollTop=origin.scroll;
      app.querySelector('[data-details]')?.focus({preventScroll:true});sessionStorage.removeItem(storageKey);
    }
  }
  document.fonts.ready.then(()=>requestAnimationFrame(()=>{
    if(q.get('scroll')==='end')app.querySelector('.content').scrollTop=app.querySelector('.content').scrollHeight;
    document.documentElement.dataset.ready='true';
  }));
})();
