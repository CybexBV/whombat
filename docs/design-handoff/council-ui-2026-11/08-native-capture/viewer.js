const { screens, assistant } = window.nativeEvidence;
const screen = document.querySelector('#screen');
const theme = document.querySelector('#picture-theme');
const size = document.querySelector('#text-size');
for (const item of screens) screen.add(new Option(item.name, item.id));
const requested = new URLSearchParams(location.search).get('screen');
if (screens.some((item) => item.id === requested)) screen.value = requested;
function render() {
  const item = screens.find((item) => item.id === screen.value);
  document.querySelector('#screen-title').textContent = item.name;
  document.querySelector('#route').textContent = `Native route: ${item.route}`;
  for (const platform of ['ios', 'android']) {
    const label = platform === 'ios' ? 'iOS' : 'Android';
    const supported = size.value === 'standard' || ['chat-list', 'thread', 'approval', 'overview'].includes(item.id);
    const img = document.querySelector(`#${platform}-image`);
    const link = document.querySelector(`#${platform}-link`);
    const gap = document.querySelector(`#${platform}-gap`);
    document.querySelector(`#${platform}-caption`).textContent = `Native ${label} · ${theme.value} · ${size.options[size.selectedIndex].text}`;
    link.hidden = !supported; gap.hidden = supported;
    if (supported) {
      const file = `png/${platform}-${item.id}-${theme.value}${size.value === 'largest' ? '-largest' : ''}.png`;
      img.src = file; link.href = file;
      img.alt = `${item.name}, native ${label}, ${theme.value}, ${size.value} text${item.id === 'files' ? '; demo content unavailable, GAP' : ''}`;
      link.setAttribute('aria-label', `Open full-size ${img.alt}`);
    } else gap.textContent = 'GAP · largest text was requested for Chat, thread, approval and Overview only.';
  }
  document.querySelector('#evidence').textContent = item.summary.replaceAll('{assistant}', assistant);
  document.querySelector('#contrast').textContent = item.contrast;
  document.querySelector('#largest-note').textContent = size.value === 'largest' ? 'System setting: iOS AX5; Android 2.0× (the largest Android Settings size). The app caps most text at 1.6×. A picture is not a complete VoiceOver or TalkBack journey.' : 'Source clock: 23 September 2026, 14:05 Europe/Amsterdam. Status-bar 09:41 is normalized OS chrome, not the fixture clock.';
  const companions = document.querySelector('#companions'); companions.replaceChildren();
  if (['chat-list', 'thread', 'approval', 'overview'].includes(item.id)) {
    const a = document.createElement('a'); a.href = `png/phone-web-1405-${item.id}-${theme.value}.png`; a.textContent = 'Matching web fixture at 14:05'; companions.append(a);
  }
  const failures = document.querySelector('#route-failures'); failures.replaceChildren();
  if (['thread', 'approval', 'connection'].includes(item.id)) for (const platform of ['ios', 'android']) {
    const p = document.createElement('p'); const a = document.createElement('a');
    a.href = `png/${platform}-${item.id}-requested-route-${theme.value}.png`; a.textContent = `${platform === 'ios' ? 'iOS' : 'Android'} · supplied web-fixture ID opens a missing-item state`; p.append(a); failures.append(p);
  }
}
for (const control of [screen, theme, size]) control.addEventListener('change', render);
render();
