const query = new URLSearchParams(location.search);
const platform = document.querySelector('#platform');
const pictureTheme = document.querySelector('#theme');
let theme = query.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = theme;
function updateToggle() { document.querySelector('[data-theme-toggle]').textContent = theme === 'light' ? 'Use dark theme' : 'Use light theme'; }
document.querySelector('[data-theme-toggle]').addEventListener('click', () => {
  theme = theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  if (pictureTheme) { pictureTheme.value = theme; updatePictures(); }
  updateToggle();
});
updateToggle();
document.querySelectorAll('[data-working]').forEach((el) => { el.textContent = `${window.CHAT_FIXTURE.assistant.name} is working`; });
document.querySelectorAll('[data-assistant]').forEach((el) => { el.textContent = window.CHAT_FIXTURE.assistant.name; });
function updatePictures() {
  const p = platform.value;
  const t = pictureTheme.value;
  const native = ['ios', 'android'].includes(p);
  document.querySelector('#before-link').hidden = native;
  document.querySelector('#native-gap').hidden = !native;
  const before = document.querySelector('#before');
  const after = document.querySelector('#after');
  if (!native) before.src = `../01-groundwork/png/${p}-chat-list-${t}.png`;
  before.alt = `Chat list before · ${p} · ${t}`;
  document.querySelector('#before-link').href = before.src;
  after.src = `png/${p}-${t}.png`;
  after.alt = `Chat list proposal · ${p} · ${t}${native ? ' · static HTML study, not a native capture' : ''}`;
  document.querySelector('#after-link').href = after.src;
  for (const el of [before, after]) { el.classList.toggle('phone-picture', p !== 'desktop'); el.width = p === 'desktop' ? 1440 : 390; el.height = p === 'desktop' ? 900 : 844; }
  document.querySelector('#live').href = `mockup.html?theme=${t}&platform=${native ? p : 'web'}`;
  document.querySelector('#evidence').textContent = native ? 'Native proposal only. The row content uses the same frozen fixture inputs as web. Platform chrome is schematic; native before captures, rendering, VoiceOver and TalkBack remain GAP.' : 'Both pictures use the same frozen fixture world. The unchanged web shell comes from the before picture; only the row region is replaced.';
}
if (platform) {
  platform.value = ['desktop', 'phone-web', 'ios', 'android'].includes(query.get('platform')) ? query.get('platform') : 'desktop';
  pictureTheme.value = theme;
  platform.addEventListener('change', updatePictures);
  pictureTheme.addEventListener('change', updatePictures);
  updatePictures();
}
