// Static review only. Every answer changes this document; it sends no decision.
(async () => {
  const world = await (await fetch('fixture-world.json')).json();
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  const surface = q.get('surface') || 'card';
  const kind = q.get('kind') || 'everyday';
  const state = q.get('state') || 'pending';
  const mode = q.get('mode') || 'main';
  const platform = q.get('platform') || 'ios';
  const large = q.get('large') === '1';
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const assistant = world.assistant;
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: world.timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(world.tonight));
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: world.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(world.tonight));
  const tonight = `${date} at ${time} · ${world.timeZone}`;
  const labels = { everyday: 'Everyday ask', command: 'Server command', deploy: 'Code / deploy', mail: 'Mail send', key: 'Key request' };
  const clock = (id) => new Intl.DateTimeFormat('en-GB', { timeZone: world.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(world.worlds[id].approval.createdAt));
  const avatar = `<img class="avatar" src="../../../../packages/avatars/svg/${e(world.avatar)}" alt="${e(assistant)}" />`;
  const button = (label, action, primary = false) => `<button type="button" data-answer="${action}" class="${primary ? 'primary' : ''}">${e(label)}</button>`;
  const fact = (label, text) => `<div class="fact"><span class="eyebrow">${label}</span><p>${text}</p></div>`;
  const technical = (w, open = false, mailBody = false) => {
    const a = w.approval;
    let content = `<p class="meta">${e(a.target)}</p>`;
    if (a.connection?.argumentsPreview) content += `<pre class="code">${e(a.connection.argumentsPreview)}</pre>`;
    if (mailBody) content += `<div class="mail-body" tabindex="0" aria-label="The whole message">${e(a.action.params.body ?? a.action.params.bodyPreview)}</div>`;
    return `<details ${open ? 'open' : ''}><summary>Technical details</summary>${content}</details>`;
  };
  const conditions = (v, phone) => `<section class="conditions" aria-label="Conditions"><ul>${v.conditions.map((c) => `<li class="condition"><span class="check" aria-hidden="true"></span><p>${e(phone ? c.mobileLabel : c.label)}<span class="sr-only"> · ${c.met ? 'met' : 'not yet'}</span><span class="note">${e(phone ? c.mobileNote : c.note)}</span></p></li>`).join('')}</ul></section>`;
  function answers(id, at, st = 'pending') {
    const w = world.worlds[id], v = w.states[st].view;
    if (st !== 'pending') return v.canUndo ? `<div class="answers">${button('Undo', 'undo')}</div>` : '';
    const phone = at === 'phone';
    if (id === 'command') {
      const choices = v.scopeChoices;
      if (at === 'details') return `<div class="answers command">${choices.slice(1).map((c) => button(c.label, c.scope)).join('')}${button(v.declineCta, 'declined')}${button(choices[0].label, 'once', true)}</div>`;
      return `<div class="answers command">${choices.map((c, i) => button(c.label, c.scope, i === 0)).join('')}${button(v.declineCta, 'declined')}${!phone ? button('Details', 'details') : ''}</div>`;
    }
    if (id === 'everyday' || id === 'mail') {
      if (at === 'details') return `<div class="answers">${button('Yes, do it', 'running', true)}${button('No', 'declined')}</div>`;
      return `<div class="answers three">${button('Yes, now', 'running', !phone)}${button('Yes, tonight', 'scheduled')}${button('No', 'declined')}</div>`;
    }
    if (phone || at === 'details') {
      const yes = button(phone ? v.mobileCta : v.cta, 'running', true);
      const no = button(v.declineCta, 'declined');
      return `<div class="answers ${id === 'key' ? 'key' : ''}">${phone && large ? yes + no : no + yes}</div>`;
    }
    return `<div class="answers">${button(v.cta, 'running', true)}${button('Details', 'details')}</div>`;
  }
  function card(id, at = 'card', variant = 'main', st = 'pending') {
    const w = world.worlds[id], a = w.approval, v = w.states[st].view, answer = w.states[st].answer;
    const phone = at === 'phone', detail = at === 'details', everyday = id === 'everyday' || id === 'mail';
    const current = variant === 'current';
    const title = phone || detail ? v.question : v.title;
    const needs = everyday ? `${assistant} needs your OK` : v.label;
    let head = phone ? `<div class="head">${avatar}<div><p class="eyebrow">${e(needs)}</p><p class="meta">${e(assistant)} · Chat · ${clock(id)}</p></div></div>` : '';
    let html = `${head}${!phone && !everyday ? `<p class="eyebrow warn">${e(v.label)}</p>` : ''}<h2 tabindex="-1">${e(title)}</h2>${!phone && everyday && st === 'pending' ? `<p class="needs">${e(needs)}</p>` : ''}`;
    if (st !== 'pending') {
      html += `<p class="answer-state ${st === 'done' ? 'done' : ''}" role="status" tabindex="-1">${e(answer?.text ?? v.message)}</p>`;
      if (v.canUndo && !phone) html += answers(id, at, st);
      html += technical(w);
      return `<section class="approval answered" aria-label="Approval: ${e(v.title)}" data-kind="${id}">${html}</section>`;
    }
    const action = id === 'deploy' ? 'Build the latest commit on feat/invoice-pdf, then roll billing-api to staging' : id === 'mail' ? a.whatHappens[0] : id === 'command' ? a.action.params.reason : id === 'key' ? a.whatHappens[0] : a.summary;
    if (!current) {
      html += `<div class="facts">${fact('What will happen', e(action))}`;
      if (id === 'deploy') html += `<div class="fact"><ol>${a.whatHappens.slice(1).map((s) => `<li>${e(s)}</li>`).join('')}</ol></div>`;
      html += fact(id === 'key' ? 'Permission requested' : 'Permission used', `“${e(w.keyLabel)}”`);
      if (id === 'mail') html += fact('Copies', 'No Cc or Bcc');
      html += '</div>';
      if (everyday && !detail) html += `<p class="timing" id="tonight"><strong>Yes, tonight</strong> means<br>${e(tonight)}.</p>`;
      if (id === 'command') html += `<div class="fact"><span class="eyebrow">Command · ${e(a.action.params.target)}</span><pre class="code" tabindex="0" aria-label="The command">${e(a.action.params.command)}</pre></div>`;
      html += conditions(v, phone);
    } else {
      html += `<p class="secondary">${e(phone ? v.mobileMessage : v.message)}</p>`;
      if (id === 'command') html += `<pre class="code">${e(a.action.params.command)}</pre>`;
      if (!everyday) html += conditions(v, phone);
    }
    // A mail card keeps its body under Technical details in the main proposal. The full details
    // and native screen already show the whole message, so those keep it visible.
    if (id === 'mail' && (phone || detail || variant === 'open')) html += `<div class="fact"><span class="eyebrow">Message · Invoice 1042</span><div class="mail-body" tabindex="0" aria-label="The whole message">${e(a.action.params.body)}</div></div>`;
    if (variant === 'data') html += `<div class="suggestion"><strong>${e(assistant)} suggests this</strong>Yes, tonight</div><div class="facts">${fact('Consequences · needs new data', 'The server and its machines will be unavailable while it restarts.')}${fact('Can it be undone? · needs new data', 'The cache limit can be changed back. A restart cannot be taken back.')}${fact('How long it stops · needs new data', 'About 40 seconds.')}</div>`;
    if (!phone) html += answers(id, at);
    if (v.lasting) html += `<div class="lasting"><button class="quiet" data-lasting="${id}">${e(v.lasting.link)}</button></div>`;
    if (id !== 'command') html += technical(w, false, id === 'mail' && !phone && !detail && variant !== 'open');
    return `<section class="approval" aria-label="Approval: ${e(v.title)}" data-kind="${id}">${html}</section>`;
  }
  function phone(id, variant = 'main', st = 'pending', os = platform, big = large) {
    return `<section class="phone ${os} ${big ? 'large' : ''}" aria-label="${os === 'ios' ? 'iOS' : 'Android'} approval screen"><div class="system-bar" aria-hidden="true"><span>11:22</span><span>▰</span></div><nav class="back" aria-label="Back"><button data-back aria-label="Back to Inbox">${os === 'ios' ? '‹ Inbox' : '←'}</button></nav><div class="scroll" tabindex="0" aria-label="Approval content">${card(id, 'phone', variant, st)}</div><div class="footer" aria-label="Answers for this time only">${answers(id, 'phone', st)}</div></section>`;
  }
  const bar = (name) => `<header class="review-bar"><div><span class="eyebrow">03 · Approvals / Static mockup</span><p>${name}</p></div><a href="index.html?kind=${kind}&theme=${theme}">All approvals ↗</a></header>`;
  const app = document.getElementById('app');
  if (surface === 'phone') {
    document.body.classList.add('phone-only');
    app.innerHTML = phone(kind, mode, state);
  } else if (surface === 'web-board') {
    const kinds = q.get('group') === 'mail' ? ['mail','key'] : ['command','deploy'];
    app.innerHTML = `<div class="board"><span class="eyebrow">Web · existing action fields, keys and conditions</span><h1>Each kind keeps its own answers.</h1><div class="board-grid">${kinds.map((id) => `<section><h2>${labels[id]} · ${id === 'deploy' ? 'ApprovalDetails' : 'chat card'}</h2>${card(id,id === 'deploy' ? 'details' : 'card')}</section>`).join('')}</div></div>`;
  } else if (surface === 'states') {
    app.innerHTML = `<div class="board"><span class="eyebrow">Same card · shipped answered words · no pending frame after answering</span><h1>One answer, a clear next state</h1><div class="states">${['pending','scheduled','running','done','declined','failed'].map((s) => `<section><p class="variant-label">${s === 'failed' ? 'Execution detail — no thread flag' : s}</p>${card('everyday','card','main',s)}</section>`).join('')}</div></div>`;
  } else if (surface === 'variants') {
    const mailPair = `<section><p class="variant-label">Keeps handle-it.md · message folded on the web card</p>${card('mail')}</section><section><p class="variant-label">Decision for John — reopens handle-it.md</p>${card('mail','card','open')}</section>`;
    const dataPair = `<section><p class="variant-label">Keeps UIR-39, UIR-40 · only existing fields</p>${card('everyday')}</section><section><p class="variant-label">needs new data — reopens UIR-39, UIR-40</p>${card('everyday','card','data')}</section>`;
    app.innerHTML = `<div class="board"><span class="eyebrow">Alternatives for review · not the buildable main version</span><h1>Keep the decision boundary visible</h1><div class="board-grid">${q.get('group') === 'mail' ? mailPair : q.get('group') === 'data' ? dataPair : mailPair + dataPair}</div></div>`;
  } else if (surface === 'phones') {
    document.body.classList.add('phone-board-page');
    app.innerHTML = `<div class="board"><div class="phone-board">${['everyday','deploy','key'].map((id) => `<section><h2>${labels[id]} · iOS · static proposal</h2>${phone(id)}</section>`).join('')}</div></div>`;
  } else if (surface === 'details') {
    app.innerHTML = `${bar(`${labels[kind]} · web ApprovalDetails · main version`)}<div class="modal-stage"><section class="detail" aria-label="Approval details"><div class="head">${avatar}<span class="eyebrow warn">${e(assistant)} is asking</span><button class="close quiet" data-back aria-label="Close approval details">✕</button></div>${card(kind,'details',mode,state)}</section></div>`;
  } else {
    app.innerHTML = `${bar(`${labels[kind]} · web chat card · main version`)}<div class="component-stage"><div><nav class="thread-head" aria-label="Thread"><a href="index.html">‹ Chat</a><span class="chip">${kind === 'everyday' ? 'pve-02' : kind === 'command' ? 'web-1' : kind === 'mail' ? 'Invoice 1042' : kind === 'key' ? assistant : 'billing-api'}</span><button class="quiet" data-back>Settle</button></nav><article class="message">${avatar}<div><div class="author">${e(assistant)}<span class="meta">${clock(kind)}</span></div><p>${e(world.worlds[kind].approval.summary)}</p>${card(kind,'card',mode,state)}</div></article></div><aside class="annotation"><span class="eyebrow">Buildable main version</span><h2>Read, then answer.</h2><p>The action, permission and unmet conditions come before the answers.</p><p>${kind === 'everyday' || kind === 'mail' ? 'The exact evening time is written out. No hover is needed.' : 'This kind keeps its existing answer labels and scope.'}</p><p>The full approval stays open. Technical details remain a separate disclosure.</p><p class="meta">Fixture only · 23 Sep 2026<br>Light and dark use real tokens.</p></aside></div>`;
  }
  app.insertAdjacentHTML('beforeend', '<div id="status" class="sr-only" role="status" aria-live="polite"></div>');
  app.addEventListener('click', (event) => {
    const b = event.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-back')) { location.href = 'index.html'; return; }
    if (b.dataset.lasting) {
      const words = world.worlds[b.dataset.lasting].states.pending.view.lasting;
      const body = surface === 'phone' ? words.body.replace('in Settings', 'on pve-02’s page in Overview') : words.body;
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-labelledby', 'confirm-title');
      dialog.setAttribute('aria-describedby', 'confirm-body');
      dialog.innerHTML = `<h2 id="confirm-title">${e(words.title)}</h2><p id="confirm-body">${e(body)}</p><div class="answers"><button data-cancel>${e(words.keep)}</button><button class="primary" data-confirm>${e(words.confirm)}</button></div>`;
      document.body.append(dialog); dialog.showModal(); dialog.querySelector('[data-cancel]').focus();
      let confirmed = false;
      dialog.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-confirm]')) confirmed = true;
        if (ev.target.closest('button')) dialog.close();
      });
      dialog.addEventListener('close', () => {
        dialog.remove();
        if (!confirmed) { b.focus(); return; }
        const section = b.closest('.approval');
        section.classList.add('answered');
        section.innerHTML = `<h2>${e(world.worlds.everyday.approval.title)}</h2><p class="answer-state" role="status" tabindex="-1">Running</p><p class="secondary">${e(world.worlds.everyday.states.pending.view.toasts.always ?? '')}</p>`;
        if (surface === 'phone') app.querySelector('.footer').innerHTML = '';
        section.querySelector('[role="status"]').focus();
      });
      return;
    }
    if (b.dataset.answer) {
      const action = b.dataset.answer;
      if (action === 'details') { q.set('surface','details'); location.search = q.toString(); return; }
      const section = b.closest('.approval') ?? app.querySelector('.approval');
      const id = section.dataset.kind;
      if (action === 'undo') { q.set('state','pending'); location.search=q.toString(); return; }
      const next = action === 'scheduled' ? 'scheduled' : action === 'declined' ? 'declined' : 'running';
      const result = world.worlds[id].states[next];
      section.innerHTML = `<h2>${e(result.view.title)}</h2><p class="answer-state" role="status" tabindex="-1">${e(result.answer?.text ?? result.view.message)}</p>${answers(id,surface,next)}`;
      section.classList.add('answered');
      if (surface === 'phone') app.querySelector('.footer').innerHTML = answers(id,'phone',next);
      section.querySelector('[role="status"]').focus();
    }
  });
  document.documentElement.dataset.ready = 'true';
})();
