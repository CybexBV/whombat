(() => {
  const { defs, view, render, esc, dataFor, pickedSummary } = Cards;
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const platform = params.get('platform') || 'web';
  const expanded = params.get('expanded') === '1';
  const single = params.get('card');
  const decisions = params.get('decisions') === '1';
  document.documentElement.dataset.theme = theme;
  document.body.dataset.os = platform;
  if (platform !== 'web') document.body.classList.add('native');
  if (params.get('large') === '1') document.body.classList.add('largest');
  const sample = (id, isExpanded = false) => `<section class="sample" aria-label="${esc(defs.find(d => d[0] === id)?.[1] || id)}${isExpanded ? ', expanded example' : ''}"><p class="eyebrow">${esc(defs.find(d => d[0] === id)?.[1] || id)}${isExpanded ? ' · Expanded' : ''}</p>${id === 'council-live' ? '<p class="variant-label">Decision for John — reopens AP-7621, AP-7641: readable unanswered rows</p>' : ''}${render(id, { expanded: isExpanded })}<p class="meta">${esc(view(id).note)}</p></section>`;
  const header = `<header class="top"><div><p class="eyebrow">04 / Static fixture mockups · ${platform === 'web' ? 'Web' : platform === 'ios' ? 'iOS' : 'Android'}</p><h1>One layout. A clear next step.</h1><p>Nothing is sent from this proposal. The cards use the captured fixture world.</p></div><nav class="controls" aria-label="Mockup views"><a class="button" href="index.html">Before / after</a><a class="button" href="?platform=${platform}&theme=${theme === 'light' ? 'dark' : 'light'}">${theme === 'light' ? 'Dark' : 'Light'}</a><a class="button" href="?decisions=1&platform=${platform}&theme=${theme}">Decisions for John</a></nav></header>`;
  const app = document.getElementById('app');
  if (single) {
    app.innerHTML = `<main class="single">${sample(single, expanded)}</main>`;
  } else if (decisions) {
    app.innerHTML = header + `<main class="board decisions"><section class="sample"><p class="eyebrow">Shipped · Council final</p><div data-before="council-done"></div></section><section class="sample"><p class="variant-label">Decision for John — reopens AP-7626, AP-7718</p>${render('council-done', { variant: true, expanded })}<p class="meta">Words replace the score table. Last answers stay available in Details.</p></section><section class="sample"><p class="eyebrow">Shipped · Earlier agreement round</p>${render('council-mixed')}<p class="meta">The fixture’s first agreement round is in Details.</p></section><section class="sample"><p class="variant-label">Decision for John — reopens AP-7626, AP-7718</p><article class="card"><div class="status"><span class="mark" aria-hidden="true">·</span>Earlier agreement round · Council</div><h3>Improve the Inbox</h3><p class="why">Two agree, one wants changes.</p><div class="body">${Cards.fromThread('council-mixed', 'council').history.filter(r => r.stage === 'agree').map(r => `<ol class="rows">${r.members.map(m => `<li class="row"><span class="number" aria-hidden="true">·</span><div><strong>${esc(m.name)}</strong><p>${m.verdict === 'agree' ? 'Agrees' : 'Wants changes'}</p></div></li>`).join('')}</ol>`).join('')}</div><div class="footer">${'<button class="primary" data-action="demo">Read the answers</button>'}</div><p class="inline-status" role="status"></p></article><p class="meta">Historical fixture state, not a claim about the final round. No new data.</p></section><section class="sample"><p class="eyebrow">Shipped · Editable checklist</p><div data-before="delegation-offer"></div></section><section class="sample"><p class="variant-label">Decision for John — reopens AP-7704, AP-7730, AP-7731, DLG-32 to 34</p>${render('delegation-offer', { variant: true, expanded })}<p class="meta">Per-task AI controls move to Details. Selected work, dependencies and each effective AI stay above Hand over.</p></section><section class="sample"><p class="eyebrow">Shipped · Handed-over tasks</p><div data-before="delegation-working"></div></section><section class="sample"><p class="variant-label">Decision for John — reopens AP-7704, AP-7730, AP-7731, DLG-32 to 34</p>${render('delegation-working', { variant: true, expanded })}<p class="meta">Pull request links and pictures move to Details. Problems remain in sight; finished work still opens in place.</p></section></main>`;
    const script = document.createElement('script'); script.src = 'evidence.js';
    script.onload = () => document.querySelectorAll('[data-before]').forEach(el => {
      const r = CARD_EVIDENCE.find(r => r.id === el.dataset.before && r.platform === (platform === 'web' ? 'web' : 'phone-web') && r.theme === theme);
      if (!r) { el.textContent = 'Before capture GAP'; return; }
      el.innerHTML = `<div class="before-crop" style="width:${r.crop.width}px;height:${r.crop.height}px"><img src="${r.atlas}" alt="Shipped ${esc(r.id)}, ${platform === 'web' ? 'web' : 'phone-width web'}, ${theme}" style="top:-${r.crop.y}px"></div>${platform !== 'web' ? '<p class="meta">Phone-width web evidence. Native before is a GAP.</p>' : ''}`;
    }); document.body.append(script);
  } else {
    app.innerHTML = header + `<main class="board">${defs.map(([id]) => sample(id)).join('')}<div class="gallery-foot"><h2>Opened in the same place</h2><p>Every card with a starting fold has an expanded example below, plus the merged rows, council answers, plan and digest heads-ups.</p></div>${defs.filter(([id]) => view(id).folded || ['delegation-working', 'delegation-done', 'council-live', 'council-done', 'digest'].includes(id)).map(([id]) => sample(id, true)).join('')}<div class="gallery-foot"><a href="NOTES.md">Data sources, per-state folding, access and capture gaps</a></div></main>`;
  }
  const aiDraft = new Map();
  function currentOffer(card) {
    const data = structuredClone(dataFor('delegation-offer'));
    const picked = new Set([...card.querySelectorAll('[data-task-check]:checked')].map(i => Number(i.dataset.taskCheck)));
    data.tasks.forEach(t => { t.picked = picked.has(t.n); if (aiDraft.has(t.n)) t.ai = aiDraft.get(t.n); });
    if (aiDraft.has(0)) data.ai = aiDraft.get(0);
    return data;
  }
  function showDialog(title, html) {
    const returnFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'card'; dialog.style.maxWidth = 'min(560px, calc(100% - 32px))';
    dialog.innerHTML = `<h2 id="dialog-title">${esc(title)}</h2><div class="body">${html}</div><div class="footer"><button data-close>Close</button></div>`;
    dialog.setAttribute('aria-labelledby', 'dialog-title');
    document.body.append(dialog); dialog.addEventListener('close', () => { dialog.remove(); returnFocus?.focus(); });
    dialog.querySelector('[data-close]').onclick = () => dialog.close(); dialog.showModal();
    return dialog;
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('button[data-action], button[data-option]');
    if (!target) return;
    const card = target.closest('.card');
    const status = card?.querySelector('.inline-status');
    if (target.dataset.option) {
      if (target.getAttribute('aria-disabled') === 'true') { status.textContent = 'This provider is coming soon.'; return; }
      card.querySelectorAll('[data-option]').forEach(b => b.setAttribute('aria-pressed', String(b === target)));
      status.textContent = `${target.textContent} selected.`; return;
    }
    const action = target.dataset.action;
    if (action === 'expand') {
      const details = card.querySelector('.footer > details');
      details.open = !details.open; target.setAttribute('aria-expanded', String(details.open));
      return;
    }
    if (action === 'handover') {
      const data = currentOffer(card);
      showDialog('Check the selected work', pickedSummary(data) + '<p class="notice">In the app, Hand over starts these tasks. This mockup sends nothing.</p>'); return;
    }
    if (action === 'stop') {
      showDialog('Stop this work?', '<p>Keep going leaves the work running. Stop ends it after confirmation.</p><div class="controls" style="margin-top:16px"><button data-close>Keep going</button><button data-close>Stop</button></div>');
      document.querySelectorAll('dialog [data-close]').forEach(b => b.onclick = () => b.closest('dialog').close()); return;
    }
    if (action === 'ai') {
      const taskNumber = Number(target.closest('.task')?.dataset.task || target.closest('p')?.textContent.match(/Task (\d+)/)?.[1] || 0);
      const title = taskNumber ? dataFor('delegation-offer').tasks.find(t => t.n === taskNumber).title : 'Every task';
      const dialog = showDialog(`AI for ${title}`, '<label class="field">AI<select><option>T3 Code’s default</option><option>GPT 6.1 Sol · High · Fast</option><option>Claude Opus 5.5 · Extra high</option></select></label><div class="controls" style="margin-top:16px"><button data-save-ai>Done</button></div>');
      dialog.querySelector('[data-save-ai]').onclick = () => { const chosen = dialog.querySelector('select').value; aiDraft.set(taskNumber, chosen === 'T3 Code’s default' ? null : { label: chosen }); target.textContent = chosen; target.setAttribute('aria-label', `AI for ${title}: ${chosen}`); card.querySelector('[data-picked-summary]').outerHTML = pickedSummary(currentOffer(card)); dialog.close(); status.textContent = 'AI choice updated in this preview.'; }; return;
    }
    if (action === 'reply') { showDialog('Change something', `<label class="field">Reply to ${esc(Cards.assistant)}<input type="text" placeholder="What would you like to change?"></label>`).querySelector('input').focus(); return; }
    if (action === 'pictures') { showDialog('What changed', '<p>The shipped fixture picture and its notes remain with this task. Open the council final card to compare it.</p>'); return; }
    if (action === 'task-menu') { showDialog(target.getAttribute('aria-label'), '<button data-action="external">Open in T3 Code</button><button data-action="stop">Stop this task</button>'); return; }
    if (target.textContent === 'Read the answers' || target.textContent === 'Choose Google') {
      const details = card.querySelector('.footer > details'); if (details) details.open = true;
      status.textContent = target.textContent === 'Choose Google' ? 'You chose Google.' : 'Open “Read its answer” for each member.'; return;
    }
    if (status) status.textContent = 'Preview only. This opens the existing destination in the app.';
  });
  document.addEventListener('change', event => {
    if (!event.target.matches('[data-task-check]')) return;
    const card = event.target.closest('.card');
    const data = currentOffer(card);
    const picked = new Set(data.tasks.filter(t => t.picked).map(t => t.n));
    card.querySelector('[data-picked-summary]').outerHTML = pickedSummary(data);
    const primary = card.querySelector('[data-action="handover"]');
    primary.textContent = `Hand over ${picked.size}`; primary.disabled = picked.size === 0;
  });
  document.querySelectorAll('.card[data-card-id]').forEach((card, i) => {
    const details = card.querySelector('.footer > details');
    if (!details) return;
    details.id = `details-${i}`;
    const expander = card.querySelector('[data-action="expand"]');
    if (expander) { expander.setAttribute('aria-controls', details.id); expander.setAttribute('aria-expanded', String(details.open)); }
  });
  if (platform !== 'web') {
    const latest = () => document.querySelectorAll('.score-scroll').forEach(el => { el.scrollLeft = el.scrollWidth; });
    latest(); document.addEventListener('toggle', latest, true);
  }
  if (window.parent !== window) new ResizeObserver(() => window.parent.postMessage({ cardsHeight: document.getElementById('app').scrollHeight }, '*')).observe(document.getElementById('app'));
})();
