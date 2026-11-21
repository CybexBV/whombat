const fixture = window.CHAT_FIXTURE;
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const platform = params.get('platform') || 'web';
const examples = params.get('view') === 'examples';
const shelf = params.get('view') === 'settled';
const source = examples ? fixture.examples : fixture.baseline;
const assistant = fixture.assistant.name;
document.documentElement.dataset.theme = theme;
document.body.classList.toggle('large-text', params.get('text') === 'large');
if (platform !== 'web') {
  document.body.classList.add('native', platform);
  document.querySelector('.native-chrome').hidden = false;
  document.querySelector('.native-bottom').hidden = false;
}
document.querySelector('[data-placeholder]').textContent = fixture.assistant.chatPlaceholder;
document.querySelector('[data-did]').textContent = `What ${assistant} did`;
const { stage, stageHtml, rowHtml, localScenarios } = window.createChatRows(source);
const rows = shelf ? source.settled.threads.slice(0, 2) : examples ? [...source.open.threads.filter((t) => !['msg_chat-backups', 'msg_chat-updates'].includes(t.rootId)), ...localScenarios].sort((a, b) => b.lastAt.localeCompare(a.lastAt)) : source.open.threads;
const rowMap = new Map([...rows, ...source.settled.threads].map((t) => [t.rootId, t]));
document.querySelector('#thread-list').innerHTML = rows.map(rowHtml).join('');
document.querySelector('#settled-list').innerHTML = source.settled.threads.slice(0, 2).map(rowHtml).join('');
if (shelf) document.querySelector('#list-date').textContent = 'Settled';
const openers = new WeakMap();
function show(dialog, target) { openers.set(dialog, target); dialog.showModal(); dialog.querySelector('button').focus(); }
document.addEventListener('click', (event) => {
  const row = event.target.closest('.thread-row');
  if (row) {
    event.preventDefault();
    const thread = rowMap.get(row.closest('[data-root]').dataset.root);
    document.querySelector('#detail-title').textContent = thread.text;
    document.querySelector('#detail-stage').innerHTML = stageHtml(thread);
    const settle = document.querySelector('[data-settle]');
    settle.hidden = !!(thread.waiting || thread.working || thread.handedOver || thread.settled);
    settle.disabled = true;
    settle.title = 'Design preview. Settle keeps its existing action and Undo.';
    show(document.querySelector('#thread-detail'), row);
  }
  if (event.target.closest('[data-shelf]')) show(document.querySelector('#settled-detail'), event.target.closest('[data-shelf]'));
  if (event.target.closest('[data-options]')) show(document.querySelector('#options-detail'), event.target.closest('[data-options]'));
  if (event.target.closest('[data-close]')) event.target.closest('dialog').close();
});
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('close', () => openers.get(dialog)?.focus()));
window.CHAT_STUDY = { stage, rows, localScenarios };
