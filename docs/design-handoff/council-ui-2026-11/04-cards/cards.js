/* Static design renderer. fixture.js is a read-only export of the shipped fixture world. */
(() => {
  const fixture = window.CARD_FIXTURE;
  const assistant = fixture.assistantName;
  const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const words = value => esc(String(value ?? '').replaceAll('{assistant}', assistant));
  const walk = (value, predicate, found = []) => {
    if (!value || typeof value !== 'object') return found;
    if (predicate(value)) found.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child, predicate, found);
    return found;
  };
  const fromThread = (id, kind, predicate = () => true) => walk(fixture.threads[id], v => v.kind === kind && predicate(v))[0];
  const threadTime = (id, kind) => walk(fixture.threads[id], v => v.card?.kind === kind && v.createdAt)[0]?.createdAt;
  const time = date => date ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' }).format(new Date(date)) : 'No time recorded';
  const button = (label, primary = false, action = 'demo') => `<button type="button" class="${primary ? 'primary' : ''}" data-action="${action}">${words(label)}</button>`;
  const detail = (html, open = false, label = 'Details') => `<details class="details" ${open ? 'open' : ''}><summary>${esc(label)}</summary><div class="detail-body">${html}</div></details>`;
  const rows = items => `<ol class="rows">${items.map((item, i) => `<li class="row"><span class="number" aria-hidden="true">${item.mark ?? i + 1}</span><div><strong>${words(item.title)}</strong>${item.text ? `<p>${words(item.text)}</p>` : ''}${item.note ? `<p class="note">${words(item.note)}</p>` : ''}${item.extra ?? ''}</div></li>`).join('')}</ol>`;
  const focus = (label, value, note = '') => `<div class="focus-step"><b>${words(label)}</b> ${words(value)}${note ? `<span>${words(note)}</span>` : ''}</div>`;
  const progress = value => `<div class="progress" role="progressbar" aria-label="Run progress" aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="100"><i style="width:${value}%"></i></div>`;
  const providers = card => card.members.map(m => ({ title: m.name, text: m.state === 'working' ? 'Working' : m.verdict === 'agree' ? 'Agrees' : m.verdict === 'changes' ? 'Wants changes' : m.state === 'done' ? 'Answered' : m.state === 'failed' ? 'Couldn’t answer' : 'Didn’t answer', mark: m.mark ? `<img class="provider-mark" src="../../../../packages/brand/assets/marks/${m.mark}.svg" alt="" width="14" height="14">` : 'M', extra: m.answer ? detail(`<div class="answer">${words(m.answer)}</div>`, false, 'Read its answer') : '' }));
  const aiLine = ai => ai ? [ai.label || ai.model || 'T3 Code’s default', ai.effort === 'xhigh' ? 'Extra high' : ai.effort ? ai.effort[0].toUpperCase() + ai.effort.slice(1) : null, ai.fast ? 'Fast' : null].filter(Boolean).join(' · ') : 'T3 Code’s default';
  const table = card => {
    const history = card.history || [];
    return `<div class="score-scroll" tabindex="0" role="region" aria-label="Council scores by round"><table><caption class="sr-only">Council scores by member and round</caption><thead><tr><th scope="col">Member</th>${history.map((r, i) => `<th scope="col">${r.stage === 'agree' ? 'Agreement' : 'Look'} ${r.round ?? r.n ?? i + 1}</th>`).join('')}</tr></thead><tbody>${card.members.map(m => `<tr><th scope="row">${words(m.name)}</th>${history.map(r => { const v = r.members?.find(v => v.name === m.name); return `<td class="score">${v?.score ?? (v?.verdict === 'agree' ? 'Agrees' : v?.verdict === 'changes' ? 'Changes' : '—')}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
  };
  const selectedTasks = card => card.tasks.filter(t => t.picked);
  const pickedSummary = card => {
    const tasks = selectedTasks(card);
    return `<div class="commitment" data-picked-summary><strong>${tasks.length} tasks selected</strong><p>${tasks.map(t => words(t.title)).join(' · ')}</p><p>${tasks.filter(t => t.after).map(t => `Task ${t.n} starts after task ${t.after}.`).join(' ') || 'No tasks depend on another task.'}</p><p>AI: ${tasks.map(t => `${t.n} · ${words(aiLine(t.ai || card.ai))}`).join('; ')}.</p></div>`;
  };
  const checklist = (card, variant) => `<div class="checklist">${card.tasks.map(t => `<div class="task" data-task="${t.n}"><label><input type="checkbox" ${t.picked ? 'checked' : ''} aria-label="Select task ${t.n}: ${words(t.title)}" data-task-check="${t.n}"></label><div><div class="task-title">${t.n}. ${words(t.title)}</div><p>${words(t.why)}</p>${t.after ? `<p><b>Starts after task ${t.after}.</b></p>` : ''}${variant ? '' : `<button class="ai" data-action="ai" aria-label="AI for task ${t.n}: ${words(aiLine(t.ai || card.ai))}">${words(t.ai ? aiLine(t.ai) : 'Default')} ⌄</button>`}</div></div>`).join('')}</div>`;
  const taskPictures = task => (task.shots || []).map(s => `<p><b>${words(s.view)}</b></p><a href="${window.CARD_PICTURE}" target="_blank" rel="noopener noreferrer"><img class="picture" src="${window.CARD_PICTURE}" alt="${words(s.view)}: before above, after below; open the full picture"></a>${(s.notes || []).map(n => `<p>${n.n}. ${words(n.text)}</p>`).join('')}`).join('');
  const delegationRows = (tasks, links = false) => rows(tasks.map(t => ({ title: t.title, text: t.checks === 'failing' ? 'Checks still failing' : t.pending === 'question' ? 'Asked {assistant}' : t.state === 'queued' && t.after ? `Waiting for task ${t.after}` : t.merge === 'merging' ? 'Finishing the changes' : t.merge === 'waiting' ? 'Waiting to finish' : t.checks === 'running' ? 'Waiting for checks' : t.merge === 'merged' ? 'Finished' : t.state === 'failed' ? 'Didn’t finish' : t.state === 'working' ? 'Working' : t.state === 'done' ? 'Done' : 'Not handed over', note: t.note || (t.step ? 'Preparing the changes.' : null), mark: t.merge === 'merged' ? '✓' : t.n, extra: links && (t.pr || t.url) ? `<div class="controls row-links">${t.pr ? button('Pull request', false, 'external') : ''}${button('⋯', false, 'task-menu').replace('<button ', `<button aria-label="More for ${words(t.title)}" `)}</div>${t.shots?.length ? detail(taskPictures(t), false, t.shots.length + ' picture') : ''}` : '' })));
  const defs = [
    ['plan', 'Plan · current step'], ['plan-go-ahead', 'Plan · blocked on your go-ahead'], ['plan-deployed', 'Plan · done'],
    ['run', 'Run · live'], ['run-done', 'Run · done'], ['run-failed', 'Run · checks didn’t pass'], ['run-paused', 'Run · paused'],
    ['delegation-offer', 'Delegation · editable checklist'], ['delegation-working', 'Delegation · handed over'], ['delegation-done', 'Delegation · ended'],
    ['council-live', 'Council · live and an unanswered member'], ['council-done', 'Council · final'],
    ['digest', 'Digest · problems first'], ['research', 'Research · comparison'], ['research-go', 'Research · Go ahead'], ['care-plan', 'Care plan'],
    ['guide-provider', 'Question · waiting'], ['question-done', 'Question · answered'], ['secret', 'Secret ask · waiting'], ['secret-done', 'Secret ask · saved'],
    ['guide-connect', 'Connect · waiting'], ['guide-result', 'Connect · result'], ['review', 'Review'], ['commits', 'Commits'], ['pill', 'Pill'], ['answer', 'Answer receipts'],
  ];
  const dataFor = id => fixture.states[id] || fromThread(id, id.startsWith('delegation') ? 'delegation' : id.startsWith('council') ? 'council' : ['care-plan', 'research-go'].includes(id) ? 'look_plan' : 'guide', id === 'secret' ? v => v.vaultAsk?.name === 'UniFi' : () => true);
  function view(id, expanded = false, variant = false) {
    let card = dataFor(id);
    const v = { id, kind: '', status: 'Ready', tone: '', title: '', why: '', body: '', details: '', main: '', secondary: '', folded: false, detailsOpen: false, time: null, note: '' };
    if (id.startsWith('plan')) {
      const plan = card.plan;
      const current = plan.steps.find(s => s.state === 'active') || plan.steps.find(s => s.state === 'gate' || s.state === 'blocked');
      const gate = plan.steps.find(s => s.state === 'gate' || s.state === 'blocked');
      const blocked = id === 'plan-go-ahead';
      v.kind = 'Plan'; v.title = plan.title; v.time = plan.updatedAt;
      v.status = id === 'plan-deployed' ? 'Done' : blocked ? 'Waiting for you' : '{assistant} is working';
      v.tone = id === 'plan-deployed' ? 'done' : blocked ? 'waiting' : 'working';
      v.why = id === 'plan-deployed' ? 'All four steps are done.' : blocked ? 'Your go-ahead lets the next step start.' : 'Build the invoice export, then review it before it goes out.';
      v.body = id === 'plan-deployed' ? '' : focus(blocked ? 'Waiting:' : 'Now:', (blocked ? gate : current).title, (blocked ? gate : current).note || (blocked ? 'The next step starts after your answer.' : 'The remaining steps stay in their order.'));
      v.details = rows(plan.steps.map(s => ({ title: s.title, text: s.stateLabel, mark: s.state === 'done' ? '✓' : '·' })));
      v.main = blocked ? 'Go ahead' : 'Open plan'; v.secondary = blocked ? 'Change something' : ''; v.folded = id === 'plan-deployed';
    } else if (id.startsWith('run')) {
      const run = card.run;
      v.kind = 'Run'; v.title = run.title.replace(/ on PR #\d+/, ''); v.time = run.finishedAt || run.startedAt;
      v.status = id === 'run-done' ? 'Done' : id === 'run-failed' ? 'Checks didn’t pass' : id === 'run-paused' ? 'Paused' : '{assistant} is working';
      v.tone = id === 'run-done' ? 'done' : id === 'run' ? 'working' : '';
      v.why = id === 'run' ? 'The review changes are being made.' : id === 'run-done' ? 'The changes are ready for another review.' : id === 'run-failed' ? 'Three checks still need a fix before this can finish.' : 'The work is paused.';
      v.body = id === 'run' ? focus('Now:', 'Updating how invoice amounts are displayed.') + progress(run.progress) : id === 'run-failed' ? focus('Stopped here:', 'Three invoice checks still need a fix.') : id === 'run-paused' ? focus('Progress saved:', `${run.progress}%`) : '';
      v.details = `<p>Branch: <code>${words(run.branch)}</code></p><p>Pull request ${run.prNumber ? '#' + run.prNumber : 'not created'} · +${run.diff.add} −${run.diff.del} · ${run.diff.files} files</p>${run.tests ? `<p>Checks: ${words(JSON.stringify(run.tests))}</p>` : ''}<p>${words(run.summary || run.activity)}</p>`;
      v.main = id === 'run' ? 'Watch run' : id === 'run-paused' ? 'Resume' : 'Open run'; v.secondary = id === 'run' ? 'Pause' : ''; v.folded = id === 'run-done';
    } else if (id.startsWith('delegation')) {
      v.kind = 'Tasks'; v.title = card.title; v.time = card.endedAt || card.handedAt || card.startedAt;
      v.status = id === 'delegation-offer' ? 'Waiting for you' : id === 'delegation-working' ? 'Handed over' : 'Finished with a problem';
      v.tone = id === 'delegation-offer' ? 'waiting' : '';
      v.why = id === 'delegation-offer' ? 'Choose the work to hand over, and check what each task needs.' : id === 'delegation-working' ? 'Each selected task is being handled in its own place.' : 'Three tasks finished; one still needs a look.';
      if (id === 'delegation-offer') {
        v.body = checklist(card, variant) + pickedSummary(card);
        v.main = `Hand over ${selectedTasks(card).length}`; v.secondary = 'Not now';
        v.details = `<p>Work runs in up to ${card.atOnce} separate T3 Code threads, each on its own branch. Pull requests are merged one at a time.</p>${variant ? card.tasks.map(t => `<p>Task ${t.n}: ${words(aiLine(t.ai || card.ai))} ${button('Change AI', false, 'ai')}</p>`).join('') : ''}<p>Other tasks: ${words(aiLine(card.ai))}.</p>`;
      } else {
        const finished = card.tasks.filter(t => t.merge === 'merged');
        const remaining = card.tasks.filter(t => t.merge !== 'merged' && t.picked);
        v.body = delegationRows(remaining, !variant) + (finished.length ? detail(delegationRows(finished, !variant), expanded, `Details · ${finished.length} merged`) : '');
        v.main = 'Open tasks'; v.secondary = id === 'delegation-working' ? 'Stop' : '';
        const links = card.tasks.filter(t => t.pr || t.branch).map(t => `<p><b>${t.n}. ${words(t.title)}</b><br>${t.pr ? `Pull request: <code>${words(t.pr)}</code>` : 'No pull request yet.'}${t.branch ? `<br>Branch: <code>${words(t.branch)}</code>` : ''}${t.step ? `<br>${words(t.step)}` : ''}${t.merge ? `<br>${words(t.merge)}` : ''}</p>${variant && t.shots?.length ? detail(taskPictures(t), false, t.shots.length + ' picture') : ''}`).join('');
        v.details = `<p>${words(card.note || card.outcome || '')}</p>${links}`;
      }
      v.note = id === 'delegation-offer' ? 'Starts open. The selected work, dependencies and AI remain above Hand over.' : 'Starts open. Merged rows fold; problems and waiting work remain visible.';
    } else if (id.startsWith('council')) {
      v.kind = 'Council'; v.title = card.title; v.time = card.endedAt || card.startedAt;
      v.status = card.live ? 'Handed over' : 'Done'; v.tone = card.live ? '' : 'done';
      v.why = id === 'council-mixed' ? 'The members agreed on the Inbox plan.' : card.live ? 'The members are comparing ways to back up the NAS offsite.' : 'The members finished reviewing the Settings changes.';
      const keep = id === 'council-live';
      v.body = keep ? rows(providers(card)) : `<p class="verdict">${variant ? 'All three agree.' : 'Three members have finished their review.'}</p>`;
      if (!card.live && card.shots?.length) v.body += `<div class="notice"><b>What changed</b>${card.shots.map(s => `<p>${words(s.view)}</p>${window.CARD_PICTURE ? `<img class="picture" src="${window.CARD_PICTURE}" alt="${words(s.view)}: fixture before and after with numbered changes">` : ''}${(s.notes || []).map(n => `<p>${n.n}. ${words(n.text)}</p>`).join('')}`).join('')}</div>`;
      v.details = (!variant && !keep ? table(card) : '') + (!keep ? rows(providers(card)) : '') + (card.plan ? detail(`<div class="answer">${words(card.plan)}</div>`, expanded, 'The plan') : '') + '<p>Stop asks before ending every member’s work.</p>';
      v.detailsOpen = !keep && !variant;
      v.main = 'Read the answers'; v.secondary = card.live ? 'Stop' : '';
      v.note = 'Starts open in every state. The members, final score table and last answers stay available.';
    } else if (id === 'digest') {
      v.kind = 'Digest'; v.title = 'Your inbox'; v.status = 'Ready';
      v.why = `${card.summary}; the broken checks are first.`;
      const items = card.sections.flatMap(s => s.items);
      const broken = items.find(i => i.source === 'GitHub');
      const security = items.find(i => i.source === 'Lumio');
      v.body = rows([{ title: 'The latest checks didn’t pass', text: 'All the checks need a fix.', mark: '!' }, { title: security.title, text: security.note, mark: '·' }]);
      const rest = items.filter(i => i !== broken && i !== security);
      v.body += detail(rows(rest.map(i => ({ title: i.title, text: i.note, note: [i.source, i.time].filter(Boolean).join(' · ') }))), expanded, `Heads-ups · ${rest.length}`);
      v.details = `<p>Source: ${words(broken.title)} · ${words(broken.time)}.</p><p>${words(broken.note)}</p>`;
      v.main = 'Open inbox'; v.note = 'Starts open. What is broken now stays visible; heads-ups start folded.';
    } else if (id === 'research') {
      v.kind = 'Research'; v.status = 'Ready'; v.title = card.topic;
      v.why = card.rows.find(r => r.verdict === 'pick')?.note || 'The options have been compared.';
      v.details = rows(card.rows.map(r => ({ title: r.name, text: `${r.verdict === 'pick' ? 'Pick' : r.verdict === 'maybe' ? 'Maybe' : 'No'} · ${r.note}` }))) + `<p>${card.sourceCount} sources · ${card.testedCount} tested</p>`;
      v.main = 'Read the comparison'; v.folded = true;
    } else if (id === 'research-go' || id === 'care-plan') {
      const plan = card.plan;
      v.kind = id === 'care-plan' ? 'Care plan' : 'Plan'; v.status = 'Waiting for you'; v.tone = 'waiting'; v.title = plan.title; v.time = plan.research?.at;
      v.why = id === 'care-plan' ? plan.summary : 'The machines have no backups and nginx stopped, so these steps need your go-ahead.';
      v.body = rows(plan.steps.map(title => ({ title }))) + '<div class="notice">Go ahead is your OK for exactly these steps.</div>';
      v.details = '<p>The plan belongs to this server’s research and stays in the same thread. Change something focuses your reply here.</p>';
      v.main = 'Go ahead'; v.secondary = 'Change something'; v.note = 'Starts open. Read the exact steps and their times before giving the go-ahead.';
    } else if (id === 'guide-provider' || id === 'question-done') {
      card = id === 'question-done' ? fixture.states['question-done'] || fixture.states['guide-provider'] : card;
      v.kind = 'Question'; v.title = card.title; v.why = 'Choose your provider so {assistant} can help with your email.';
      v.status = id === 'question-done' ? 'Answered' : 'Waiting for you'; v.tone = id === 'question-done' ? 'done' : 'waiting';
      if (id === 'question-done') { v.why = 'You chose Google.'; v.folded = true; v.main = 'Read your answer'; }
      else { v.body = `<div class="choices">${card.blocks.find(b => b.type === 'choices').options.map(o => `<button type="button" data-option="${esc(o.id)}" aria-pressed="false" ${o.disabled ? 'aria-disabled="true"' : ''}>${words(o.title)}${o.disabled ? ' · Coming soon' : ''}</button>`).join('')}</div>`; v.main = 'Choose Google'; }
      v.details = (id === 'question-done' ? `<p>${words(card.answer?.label || 'You chose Google')}</p>` : '') + '<p>Google: Gmail or Google Workspace, calendar and files. Microsoft 365 and other email are coming soon.</p>';
    } else if (id.startsWith('secret')) {
      const name = card.vaultAsk?.name || 'Grafana';
      v.kind = 'Secret ask'; v.title = id === 'secret-done' ? `Saved to your Vault · ${name}` : `{assistant} needs your ${name} sign-in`;
      v.status = id === 'secret-done' ? 'Saved' : 'Waiting for you'; v.tone = id === 'secret-done' ? 'done' : 'waiting'; v.time = card.answer?.at || threadTime(id, 'guide');
      v.why = id === 'secret-done' ? 'The password is saved in your Vault.' : 'Save your sign-in so {assistant} can read your Wi-Fi’s logs.';
      v.body = id === 'secret' ? '<label class="field">Username<input type="text" autocomplete="off" aria-label="UniFi username"></label><label class="field">Password<input type="password" autocomplete="new-password" aria-label="UniFi password"></label><p class="meta" style="margin-top:10px">Goes straight to your Vault; never into the chat.</p>' : '';
      v.details = `<p>Saved as ${words(name)} · ${words(card.vaultAsk?.url || '')}. The chat stores the answer label, never the secret.</p>`;
      v.main = id === 'secret' ? 'Save to Vault' : 'Open Vault'; v.secondary = id === 'secret' ? 'No' : ''; v.folded = id === 'secret-done';
    } else if (id === 'guide-connect' || id === 'guide-result') {
      v.kind = 'Connect'; v.title = id === 'guide-result' ? card.title.split(' · ')[0] : card.title;
      v.status = id === 'guide-result' ? 'Connected' : 'Waiting for you'; v.tone = id === 'guide-result' ? 'done' : 'waiting';
      v.why = id === 'guide-result' ? 'Google Drive needs its API turned on.' : 'Google will ask you to allow access to the services you choose.';
      v.body = id === 'guide-result' ? rows(card.blocks.find(b => b.type === 'status').rows.map(r => ({ title: r.label, text: r.detail || 'No status reported', mark: r.state === 'ok' ? '✓' : '·' }))) : `<div class="choices">${card.blocks.find(b => b.type === 'connect').services.map(s => `<label class="field"><span><input type="checkbox" checked> ${words(({mail:'Mail',calendar:'Calendar',files:'Drive',docs:'Docs',sheets:'Sheets',contacts:'Contacts'})[s])}</span></label>`).join('')}</div>`;
      v.details = `<p>${words(card.body)}</p>`; v.main = id === 'guide-result' ? 'Open connections' : 'Connect Google'; v.note = 'Starts open. Access choices stay visible before leaving for Google; a result with a problem stays open.';
    } else if (id === 'review') {
      v.kind = 'Review'; v.status = 'Changes requested'; v.title = 'Review of the invoice export';
      v.why = `${card.comments?.length || card.changesRequested || 2} review comments need a look.`;
      v.main = 'Read the review'; v.folded = true;
      v.details = `<p>Pull request #${card.prNumber} · <code>${words(card.file)}:${card.line}</code></p><pre><code>${words(card.diff.map(d => `${d.kind === 'add' ? '+' : d.kind === 'del' ? '−' : ' '} ${d.text}`).join('\n'))}</code></pre>${rows((card.comments || []).map(c => ({ title: c.body || c.text || c, text: c.path || c.file })) )}`;
    } else if (id === 'commits') {
      v.kind = 'Commits'; v.status = 'Saved'; v.tone = 'done'; v.title = 'The changes are saved';
      v.why = `${card.commits.length} commits are recorded for this work.`; v.main = 'See the changes'; v.folded = true;
      v.details = rows(card.commits.map(c => ({ title: c.message || c.title, text: c.sha || c.hash }))) + `<p>${words(card.signedBy ? `Signed by ${card.signedBy}` : '')}</p>`;
    } else if (id === 'pill') {
      v.kind = 'Checks'; v.status = 'Checks need a look'; v.title = 'Three checks didn’t pass'; v.why = '38 of 41 checks passed.'; v.main = 'Open checks';
      v.details = `<p>${words(card.text)}</p>`; v.folded = true;
    } else if (id === 'answer') {
      v.kind = 'Sources'; v.status = 'Ready'; v.title = 'Where this answer came from';
      v.why = `${card.receipts.length} sources support the answer above.`; v.main = 'Open in search'; v.folded = true;
      v.details = rows(card.receipts.map(r => ({ title: `${r.n}. ${r.source}`, text: r.detail, mark: r.n, extra: button('Open source', false, 'source') })));
    }
    if (!v.note) v.note = v.folded ? 'Starts folded on phone. Status, title, one sentence and the main action remain visible; open in place.' : 'Starts open on phone. Details opens in place; the action stays at the foot.';
    return v;
  }
  function render(id, { expanded = false, variant = false } = {}) {
    const v = view(id, expanded, variant);
    const stateClass = ['waiting', 'broken', 'done'].includes(v.tone) ? `state-${v.tone}` : '';
    const mark = v.tone === 'done' ? '✓' : v.tone === 'waiting' || v.tone === 'working' || v.tone === 'broken' ? '' : '·';
    const body = v.body ? `<div class="body">${v.body}</div>` : '';
    const main = v.main ? id === 'delegation-offer' ? `<span class="split">${button(v.main, true, 'handover')}<button type="button" class="primary split-arrow" data-action="ai" aria-label="AI for every task">⌄</button></span>` : button(v.main, true, ['research', 'review', 'question-done'].includes(id) ? 'expand' : 'demo') : '';
    const html = `<article class="card" data-card-id="${id}" aria-label="${words(v.kind + ': ' + v.title)}" data-start="${v.folded ? 'folded' : 'open'}"><div class="status"><span class="mark ${v.tone}" aria-hidden="true">${mark}</span><span class="${stateClass}">${words(v.status)}</span><span class="kind">· ${esc(v.kind)}</span><time aria-label="${v.time ? esc(time(v.time)) : 'No time recorded'}">${v.time ? esc(time(v.time)) : '—'}</time></div><h3>${words(v.title)}</h3><p class="why">${words(v.why)}</p>${body}<div class="footer">${main}${v.secondary ? button(v.secondary, false, v.secondary === 'Stop' ? 'stop' : v.secondary === 'Change something' ? 'reply' : 'demo') : ''}${v.details ? detail(v.details, expanded || v.detailsOpen) : ''}</div><p class="inline-status" role="status" aria-live="polite"></p></article>`;
    return expanded ? html.replaceAll('<details class="details" >', '<details class="details" open>') : html;
  }
  window.Cards = { fixture, assistant, defs, esc, words, view, render, dataFor, fromThread, table, selectedTasks, pickedSummary };
})();
