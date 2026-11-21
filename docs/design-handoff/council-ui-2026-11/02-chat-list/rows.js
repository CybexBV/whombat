// Shared static specimen renderer. This does not ship with either app.
window.createChatRows = (source) => {
  const fixture = window.CHAT_FIXTURE;
  const assistant = fixture.assistant.name;
  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const svg = (path) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
  // No inferred stage: prose, reply count and a turn error cannot set a flag.
  function stage(thread) {
    if (thread.waiting) return { key: 'waiting', label: 'Waiting for you', mark: '' };
    if (thread.working) return { key: 'working', label: `${assistant} is working`, mark: '' };
    if (thread.handedOver) return { key: 'handed-over', label: 'Handed over', mark: svg('M3 3v6a3 3 0 0 0 3 3h7M10 9l3 3-3 3M3 6h6a3 3 0 0 0 3-3') };
    if (thread.settled) return { key: 'settled', label: 'Settled', mark: svg('m3 8 3 3 7-7') };
    return null;
  }
  function stageHtml(thread) {
    const value = stage(thread);
    return value ? `<span class="stage ${value.key}"><span class="mark" aria-hidden="true">${value.mark}</span>${escape(value.label)}</span>` : '';
  }
  const clock = (at) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }).format(new Date(at));
  const time = (at) => at.slice(0, 10) === fixture.frozen.slice(0, 10) ? clock(at) : new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short' }).format(new Date(at));
  const fullTime = (at) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'full', timeStyle: 'short' }).format(new Date(at));
  const unread = new Map(source.unread.threads.map((thread) => [thread.rootId, thread.unread]));
  function rowHtml(thread) {
    const isNew = (unread.get(thread.rootId) || 0) > 0 && !thread.settled;
    const meta = [stageHtml(thread), isNew ? '<span class="new-reply">New reply</span>' : '', thread.replyCount === 0 ? '<span class="no-reply">No replies yet</span>' : ''].filter(Boolean).join('');
    const label = [thread.text, stage(thread)?.label, isNew ? 'New reply' : null, thread.replyCount === 0 ? 'No replies yet' : null, `Last activity ${fullTime(thread.lastAt)}`, 'Open thread'].filter(Boolean).join('. ');
    return `<li data-root="${escape(thread.rootId)}"><a class="thread-row" href="#thread-${escape(thread.rootId)}" aria-label="${escape(label)}"><div class="row-main"><span class="topic">${escape(thread.text)}</span>${meta ? `<span class="row-meta">${meta}</span>` : ''}</div><span class="row-end"><time class="row-time" datetime="${escape(thread.lastAt)}" title="${escape(fullTime(thread.lastAt))}">${escape(time(thread.lastAt))}</time><span class="open-label">Open thread<span class="chevron" aria-hidden="true">›</span></span></span></a></li>`;
  }
  // Inputs that exercise existing fields, isolated from the baseline list.
  const sampleBase = fixture.examples.open.threads.find((t) => t.rootId === 'msg_chat-pve-memory');
  const localScenarios = [
    { ...sampleBase, rootId: 'msg_study-no-reply', subject: null, text: 'Can you check last night’s backups?', createdAt: '2026-09-23T08:08:00.000Z', lastAt: '2026-09-23T08:08:00.000Z', replyCount: 0, working: false, waiting: false, handedOver: false, settled: null },
    { ...sampleBase, rootId: 'msg_study-long-question', text: 'Can you check why pve-02 uses so much memory after the nightly backups, whether the ZFS cache is giving it back to the guests, and what we should change before the backup starts on the server tonight?', replyCount: 1, createdAt: '2026-09-23T07:39:00.000Z', lastAt: '2026-09-23T07:40:00.000Z', working: false, waiting: false, handedOver: false, settled: null },
    { ...sampleBase, rootId: 'msg_study-reply-error', subject: null, text: 'Why did the NAS wake up at 04:00?', replyCount: 0, createdAt: '2026-09-23T07:30:00.000Z', lastAt: '2026-09-23T07:30:00.000Z', working: false, waiting: false, handedOver: false, settled: null },
  ];
  return { stage, stageHtml, rowHtml, localScenarios };
};
