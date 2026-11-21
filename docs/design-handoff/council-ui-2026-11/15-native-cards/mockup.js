/* Static proposal only: shared fixture and card renderer are read without modification. */
(() => {
  const q = new URLSearchParams(location.search);
  window.profile = ['ios','android','phone-web'].includes(q.get('platform')) ? q.get('platform') : 'ios';
  window.look = q.get('theme') === 'dark' ? 'dark' : 'light';
  const screen = q.get('screen') || 'card';
  const id = q.get('card') || 'council-done';
  const expanded = q.get('expanded') === '1';
  const { esc, words, assistant } = Cards;
  const n = NativeStudy;
  document.documentElement.dataset.theme = look;
  document.body.dataset.os = profile;
  if (profile !== 'phone-web') document.body.classList.add('native');
  if (q.get('large') === '1') document.body.classList.add('text-large');
  if (q.get('document') === '1') document.body.classList.add('document-mode');
  if (q.get('capture') === '1') document.body.classList.add('capture-only');
  window.CARD_PICTURE = '../04-cards/png/fixture-settings.png';
  const decisions = screen === 'card' ? (id.startsWith('council') ? ['AP-7626','AP-7718'] : id.startsWith('delegation') ? ['AP-7704','AP-7730','AP-7731'] : []) : screen.startsWith('connection') ? [] : ['AP-6412'];
  document.getElementById('review-labels').innerHTML = '<strong>Main design · HTML mockup for John’s review</strong>' + decisions.map(d=>`<p>Reopens ${d} — decided by Dusty for John’s review</p>`).join('');
  function cardHTML() {
    if (id === 'council-round') {
      const c = Cards.fromThread('council-mixed','council');
      const round = c.history.find(r=>r.stage==='agree');
      return `<article class="card" data-card-id="council-round" aria-label="Council: ${words(c.title)}, earlier agreement round"><div class="status">Earlier agreement round · Council</div><h3>${words(c.title)}</h3><p class="why">Two agree, one wants changes.</p><div class="body"><ol class="rows">${round.members.map(m=>`<li class="row"><span class="number" aria-hidden="true">·</span><div><strong>${words(m.name)}</strong><p>${m.verdict==='agree'?'Agrees':'Wants changes'}</p></div></li>`).join('')}</ol></div><div class="footer"><button class="primary" data-preview>Read the answers</button></div></article>`;
    }
    const el = document.createElement('template');
    el.innerHTML = Cards.render(id,{expanded,variant:id.startsWith('delegation')||id.startsWith('council')});
    if (id.startsWith('council')) {
      const c = Cards.dataFor(id);
      const result = el.content.querySelector('.verdict');
      if (result) {
        const agrees = c.members.filter(m=>m.verdict==='agree').length;
        const changes = c.members.filter(m=>m.verdict==='changes').length;
        result.textContent = agrees === c.members.length ? `All ${['zero','one','two','three'][agrees] || agrees} agree.` : `${agrees} agree${changes ? `, ${changes} want changes` : ''}.`;
      }
      el.content.querySelectorAll('.row').forEach(row=>{
        const name = row.querySelector('strong')?.textContent;
        const answer = row.querySelector('summary');
        if (answer && name) answer.textContent = `Read ${name}’s answer`;
      });
      const primary = el.content.querySelector('.footer > .primary');
      if (primary && !c.live) primary.dataset.action = 'expand';
    }
    if (id === 'delegation-working' || id === 'delegation-done') {
      const data = Cards.dataFor(id);
      el.content.querySelectorAll('.footer .detail-body > p').forEach(p => {
        const number = Number(p.querySelector('b')?.textContent.match(/^(\d+)\./)?.[1]);
        const task = data.tasks.find(t => t.n === number);
        if (!task?.pr) return;
        const actions = document.createElement('div');
        actions.className = 'controls task-links';
        actions.innerHTML = `<a class="button" href="${esc(task.pr)}" data-preview aria-label="Open pull request for ${words(task.title)}">Pull request #${esc(String(task.pr).split('/').pop())}</a><button data-action="task-menu" aria-label="More for ${words(task.title)}">More</button>`;
        p.after(actions);
      });
    }
    if (id === 'delegation-offer') {
      el.content.querySelectorAll('.footer .detail-body > p').forEach(p=>{
        const task = p.textContent.match(/^Task (\d+):/);
        if (task) {
          const button = p.querySelector('button');
          button.dataset.aiTask = task[1];
          button.setAttribute('aria-label',`Change AI for task ${task[1]}`);
        }
      });
    }
    return el.innerHTML;
  }
  const titles = {'chat-list':'Chat',inbox:'Inbox',overview:'Overview',automations:'Automations',settings:'Settings'};
  const isCard = screen === 'card';
  const isConnection = screen.startsWith('connection');
  const content = isCard ? `<div class="thread-intro"><b>${esc(assistant)}</b> · ${profile==='phone-web'?'Chat':'Thread'}</div>${cardHTML()}` : isConnection ? n.connection() : n[screen === 'chat-list' ? 'chat' : screen]();
  const webHeader = `<header class="app-header"><button class="icon-button" aria-label="Open navigation drawer" data-preview>${n.icon('menu')}</button><h1>Chat</h1><button class="icon-button" aria-label="More in Chat" data-preview>${n.icon('more')}</button></header>`;
  const phoneHeader = n.header(isCard?'Thread':titles[screen]||'',isCard||isConnection,isCard?'Chat':'Overview');
  document.getElementById('app').innerHTML = `<section class="phone" aria-label="${profile==='phone-web'?'Phone-width web, navigation drawer closed':profile==='ios'?'iOS design mockup':'Android design mockup'}">${profile==='phone-web'?'':n.statusbar}${profile==='phone-web'?webHeader:phoneHeader}<div class="phone-body ${isCard?'conversation':''}">${content}</div>${isCard||screen==='chat-list'?n.composer(isCard):''}${!isCard&&!isConnection&&profile!=='phone-web'?n.nav(screen):''}</section>`;
  if (isConnection && q.get('heads') === '1') document.getElementById('heads-ups').scrollIntoView({block:'center'});
  const drafts = new Map();
  function offer(card) {
    const data = structuredClone(Cards.dataFor('delegation-offer'));
    data.tasks.forEach(t=>{t.picked=card.querySelector(`[data-task-check="${t.n}"]`).checked;if(drafts.has(t.n))t.ai=drafts.get(t.n);});
    if(drafts.has(0)) data.ai=drafts.get(0);
    return data;
  }
  function updateOffer(card) {
    const data = offer(card);
    card.querySelector('[data-picked-summary]').outerHTML=Cards.pickedSummary(data);
    const b=card.querySelector('[data-action="handover"]');
    const count=Cards.selectedTasks(data).length;
    b.textContent=`Hand over ${count}`;b.disabled=!count;
  }
  function dialog(title, body) {
    const opener = document.activeElement;
    const d = document.createElement('dialog');
    d.className='card';d.style.maxWidth='min(358px, calc(100% - 32px))';
    d.innerHTML=`<h2 id="dialog-title">${esc(title)}</h2><div class="body">${body}</div><div class="footer"><button data-close>Close</button></div>`;
    d.setAttribute('aria-labelledby','dialog-title');document.body.append(d);
    d.addEventListener('click',e=>{if(e.target.closest('[data-close]'))d.close();});
    d.addEventListener('close',()=>{d.remove();opener?.focus();});
    d.showModal();return d;
  }
  document.addEventListener('click',e=>{
    const b=e.target.closest('button,a[data-preview]');if(!b)return;
    if(b.matches('[data-preview], [data-back]')){e.preventDefault();dialog('Design preview','<p>This action opens its existing destination in the app.</p>');return;}
    if(b.matches('[data-unlock]')){dialog('Unlock the front door?','<p>Anyone at the door can come in.</p><div class="controls"><button data-close>Cancel</button><button data-close>Unlock</button></div>');return;}
    if(b.matches('[data-switch]')){const on=b.getAttribute('aria-checked')!=='true';b.setAttribute('aria-checked',String(on));b.classList.toggle('lit',on);b.querySelector('.control-state').textContent=on?'On':'Off';return;}
    const card=b.closest('.card');
    if(b.dataset.option){if(b.getAttribute('aria-disabled')==='true')return;card.querySelectorAll('[data-option]').forEach(o=>o.setAttribute('aria-pressed',String(o===b)));return;}
    if(b.dataset.action==='expand'){const d=card.querySelector('.footer > details');d.open=!d.open;b.setAttribute('aria-expanded',String(d.open));return;}
    if(b.dataset.action==='ai'){
      const task=Number(b.dataset.aiTask||0);
      const d=dialog(task?`AI for task ${task}`:'AI for every task','<label class="field">AI<select><option>T3 Code’s default</option><option>GPT 6.1 Sol · High · Fast</option><option>Claude Opus 5.5 · Extra high</option></select></label><button data-save>Done</button>');
      d.querySelector('[data-save]').onclick=()=>{const value=d.querySelector('select').value;drafts.set(task,value==='T3 Code’s default'?null:{label:value});updateOffer(card);if(task){b.textContent='Change AI';b.setAttribute('aria-label',`Change AI for task ${task}: ${value}`);}d.close();};return;
    }
    if(b.dataset.action==='stop'){dialog('Stop this work?','<p>Keep going leaves the work running. Stop ends it after confirmation.</p><div class="controls"><button data-close>Keep going</button><button data-close>Stop</button></div>');return;}
    if(b.dataset.action==='handover'){dialog('Selected work',Cards.pickedSummary(offer(card))+'<p class="notice">Preview only. This is not a new confirmation step in the app.</p>');return;}
    if(b.dataset.action==='reply'){document.getElementById('compose').focus();return;}
    if(b.dataset.action)dialog('Design preview','<p>This action opens its existing destination in the app.</p>');
  });
  document.addEventListener('change',e=>{if(e.target.matches('[data-task-check]'))updateOffer(e.target.closest('.card'));});
  document.querySelectorAll('.card').forEach((c,i)=>{const d=c.querySelector('.footer > details');const b=c.querySelector('[data-action="expand"]');if(d){d.id=`details-${i}`;if(b){b.setAttribute('aria-controls',d.id);b.setAttribute('aria-expanded',String(d.open));}}});
})();
