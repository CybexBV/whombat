// Screen-local compact treatment; the shared shell and fixture snapshot stay authoritative.
(() => {
  const S = window.FINAL_STORY, { esc, icon } = window.FinalShell;
  const q = new URLSearchParams(location.search), platform = document.body.dataset.platform;
  const stamp = at => new Date(at).toLocaleDateString('en-GB', { timeZone: S.timeZone, day: 'numeric', month: 'short' }) + ', ' + new Date(at).toLocaleTimeString('en-GB', { timeZone: S.timeZone, hour: '2-digit', minute: '2-digit' });
  const outcome = run => ({ succeeded: 'worked', failed: 'failed', skipped: 'skipped', waiting: 'waiting for you', cancelled: 'stopped' }[run.status] || run.status);
  const enabled = a => a.status === 'published' ? 'On' : a.status === 'disabled' ? 'Off' : 'Not on yet';
  function last(a) {
    const r = a.lastRun;
    return !r ? 'No runs yet' : r.finishedAt ? `Last run ${outcome(r)} · ${stamp(r.finishedAt)}` : `Last run ${outcome(r)} · started ${stamp(r.startedAt)}`;
  }
  function next(a) {
    if (a.status === 'disabled') return 'No next run';
    if (a.status === 'draft') return 'No next run yet';
    if (a.nextRunAt) return `Next run ${stamp(a.nextRunAt)}`;
    const event = a.glance.source === 'message' ? 'the next matching message' : a.glance.source === 'tracker' ? 'a new report or customer reply' : a.id === 'aut_assess-billing' ? 'a new issue or pull request' : 'a new issue';
    return `Next run on ${event}`;
  }
  // Exact shipped marks: SourceTile.tsx and GitHubMark.tsx. No remote image fetching.
  function sourceMark(a) {
    const tile = S.automationRows.find(row => row.id === a.id).tile;
    let mark;
    if (tile.source === 'github') mark = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';
    else if (tile.source === 'tracker') mark = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
    else if (tile.source === 'schedule') mark = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    else mark = icon('chat');
    return `<span class="source-mark" role="img" aria-label="${esc(tile.label)}">${mark}</span>`;
  }
  const href = extra => {
    const url = new URL('mockup.html', location.href);
    url.search = new URLSearchParams({ platform, theme: document.documentElement.dataset.theme, ...(q.get('text') === 'largest' ? { text: 'largest' } : {}), ...extra });
    return url.href;
  };
  const list = document.querySelector('.auto-list');
  if (list) list.innerHTML = S.automations.map(a => {
    const plan = a.waitingPlanId ? S.automationRows.find(row => row.id === a.id).state.line : '';
    return `<a class="auto-row compact-row" data-automation="${esc(a.id)}" href="${href({ view: 'detail', automation: a.id })}"><span class="compact-main"><span class="compact-first">${sourceMark(a)}<span class="compact-name">${esc(a.name)}</span></span><span class="compact-summary"><span class="compact-state">${enabled(a)}</span> · ${esc(last(a))} · ${esc(next(a))}${plan ? ` · <span class="compact-waiting">${esc(plan.replace(/\.$/, ''))}</span>` : ''}</span></span><svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></a>`;
  }).join('');
  const skeletons = document.querySelector('.skeleton-list');
  if (skeletons) while (skeletons.children.length < S.automations.length) skeletons.append(skeletons.firstElementChild.cloneNode(true));

  const request = document.getElementById('automation-request');
  if (request && platform !== 'desktop') request.placeholder = `Tell ${S.assistant}…`;
  if (request) request.addEventListener('input', () => { request.style.height = 'auto'; request.style.height = request.scrollHeight + 'px'; });

  const selected = S.automations.find(a => a.id === (q.get('automation') || 'aut_assess-billing'));
  if (q.get('view') === 'detail' && selected) {
    document.querySelector('h1').insertAdjacentHTML('beforebegin', sourceMark(selected));
    // The list's small history bars remain beside the complete run history on its own page.
    document.querySelector('.run-list').insertAdjacentHTML('beforebegin', `<span class="run-bars detail-bars" aria-hidden="true">${[...selected.recentRuns].slice(0, 5).reverse().map(r => `<i class="${esc(r.status)}"></i>`).join('')}</span>`);
  }
  if (platform === 'ios') {
    const back = document.querySelector('.back');
    if (back) back.querySelector('svg').innerHTML = '<path d="m14 5-7 7 7 7"/>';
  }
  // Preserve the large-text setting across the existing detail/run/back links.
  if (q.get('text') === 'largest') document.querySelectorAll('.back,.run-list a').forEach(link => {
    const url = new URL(link.href); url.searchParams.set('text', 'largest'); link.href = url.href;
  });
  const main = document.getElementById('main');
  if (q.get('focus') === 'later') main.scrollTop = main.scrollHeight - main.clientHeight;
  document.documentElement.dataset.ready = 'true';
})();
