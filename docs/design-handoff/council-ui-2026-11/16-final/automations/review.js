// Screen-local gallery: individual, consistently named PNGs include every pictured state.
const q = new URLSearchParams(location.search);
const platform = document.getElementById('platform'), scene = document.getElementById('scene');
let theme = q.get('theme') === 'dark' ? 'dark' : 'light';
platform.value = q.get('platform') || 'desktop';
const scenes = {
  normal: {}, loading: { state: 'loading' }, empty: { state: 'empty' }, failed: { state: 'failed' },
  'saved-failed': { state: 'saved-failed' }, lower: { focus: 'later', expand: 'all' },
  largest: { text: 'largest' }, 'largest-lower': { text: 'largest', focus: 'later', expand: 'all' },
  worked: { view: 'run', run: 'arn_41' }, 'run-failed': { view: 'run', run: 'arn_26' },
  skipped: { view: 'run', automation: 'aut_suspected-bug', run: 'arn_38' },
  waiting: { view: 'run', automation: 'aut_fix-web', run: 'arn_48' },
  history: { view: 'detail' }, schedules: { focus: 'later' },
};
for (const [value, label] of [['largest-lower', 'Largest text · lower page'], ['worked', 'Run #41 · worked'], ['run-failed', 'Run #26 · failed'], ['skipped', 'Run #38 · skipped'], ['waiting', 'Run #48 · waiting'], ['history', 'Recent run history'], ['schedules', 'Only tells you schedules']]) {
  const option = document.createElement('option'); option.value = value; option.textContent = label; scene.append(option);
}
scene.value = q.get('scene') || 'normal';
function draw() {
  const p = platform.value, s = scene.value, native = p === 'ios' || p === 'android';
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-toggle').textContent = `Use ${theme === 'light' ? 'dark' : 'light'} theme`;
  const before = document.getElementById('before');
  before.src = `../../${native ? '08-native-capture' : '01-groundwork'}/png/${p === 'phoneweb' ? 'phone-web' : p}-automations-${theme}.png`;
  before.hidden = s !== 'normal';
  document.getElementById('before-note').hidden = s !== 'normal';
  document.getElementById('no-before').hidden = s === 'normal';
  document.getElementById('before-caption').textContent = `Built app reference · ${native ? 'step 08 native fixture runtime' : 'step 01 web fixture'} · ${theme}`;
  const crop = document.getElementById('crop');
  crop.className = ''; crop.style = `max-width:${p === 'desktop' ? 1440 : 390}px;margin:auto`;
  const after = document.getElementById('after'); after.style = '';
  after.src = `${p}-${theme}${s === 'normal' ? '' : '-' + s}.png`;
  document.getElementById('after-caption').textContent = `Round four · ${platform.options[platform.selectedIndex].text} · ${theme} · ${scene.options[scene.selectedIndex].text}`;
  const params = new URLSearchParams({ platform: p, theme, ...scenes[s] });
  document.getElementById('full-size').href = `mockup.html?${params}`;
  params.set('text', 'largest'); document.getElementById('largest').href = `mockup.html?${params}`;
}
platform.addEventListener('change', draw); scene.addEventListener('change', draw);
document.getElementById('theme-toggle').addEventListener('click', () => { theme = theme === 'light' ? 'dark' : 'light'; draw(); });
draw();
