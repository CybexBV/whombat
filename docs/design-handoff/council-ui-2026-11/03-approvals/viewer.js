const params = new URLSearchParams(location.search);
const ids = ['kind', 'surface', 'theme', 'platform'];
for (const id of ids) {
  const el = document.getElementById(id);
  if (params.has(id)) el.value = params.get(id);
  el.addEventListener('change', update);
}
function update() {
  const value = Object.fromEntries(ids.map((id) => [id, document.getElementById(id).value]));
  document.documentElement.dataset.theme = value.theme;
  const phone = value.surface === 'phone';
  document.getElementById('platform').disabled = !phone;
  document.getElementById('gap').hidden = !phone;
  document.getElementById('before-link').hidden = phone;
  const file = `png/before-${value.surface === 'card' ? 'card' : 'details'}-${value.kind}-${value.theme}.png`;
  document.getElementById('before').src = file;
  document.getElementById('before').alt = `Before: ${value.kind} approval, web ${value.surface}, ${value.theme}`;
  document.getElementById('before-link').href = file;
  document.getElementById('before-label').textContent = phone ? 'Before · GAP · native fixture build needed' : 'Before · shipped fixture screen · 1440 × 900';
  const query = new URLSearchParams(value);
  const url = `approvals.html?${query}`;
  document.getElementById('after').src = url;
  document.getElementById('after').style.height = phone ? '844px' : '900px';
  document.getElementById('full').href = url;
  document.getElementById('after-label').textContent = phone ? `After · static ${value.platform} proposal · 390 × 844` : 'After · buildable main version · static HTML';
  for (const [id, surface] of [['variants','variants'],['states','states'],['phones','phones']]) document.getElementById(id).href = `approvals.html?surface=${surface}&theme=${value.theme}`;
  document.getElementById('large').href = `approvals.html?surface=phone&large=1&kind=${value.kind}&platform=${value.platform}&theme=${value.theme}`;
  history.replaceState(null, '', `?${query}`);
}
update();
