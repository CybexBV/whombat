(() => {
  const card = document.getElementById('card');
  const platform = document.getElementById('platform');
  const expanded = document.getElementById('expanded');
  const themeButton = document.getElementById('theme');
  let theme = 'light';
  card.innerHTML = Cards.defs.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
  function update() {
    const native = platform.value !== 'web';
    const evidence = CARD_EVIDENCE.find(r => r.id === card.value && r.platform === (native ? 'phone-web' : 'web') && r.theme === theme);
    const before = document.getElementById('before');
    if (evidence) before.innerHTML = `<div class="before-crop" style="width:${evidence.crop.width}px;height:${evidence.crop.height}px"><img src="${evidence.atlas}" alt="Shipped ${Cards.esc(card.selectedOptions[0].textContent)}, ${native ? 'phone-width web' : 'web'}, ${theme}" style="top:-${evidence.crop.y}px"></div>`;
    else before.textContent = 'GAP: this before state was not captured.';
    document.getElementById('before-caption').textContent = native ? 'Phone-width web fixture evidence. Native before is a GAP.' : 'Shipped web fixture at 1440×900; card crop, without resizing.';
    document.getElementById('after-caption').textContent = `${native ? platform.value === 'ios' ? 'iOS' : 'Android' : 'Web'} proposal · ${Cards.view(card.value).note}`;
    const frame = document.getElementById('after');
    frame.className = native ? 'phone-preview' : '';
    frame.src = `mockup.html?card=${card.value}&platform=${platform.value}&theme=${theme}&expanded=${expanded.value}`;
    document.documentElement.dataset.theme = theme;
  }
  themeButton.onclick = () => { theme = theme === 'light' ? 'dark' : 'light'; themeButton.textContent = theme === 'light' ? 'Dark theme' : 'Light theme'; update(); };
  card.onchange = platform.onchange = expanded.onchange = update;
  window.addEventListener('message', event => { const frame = document.getElementById('after'); if (event.source === frame.contentWindow && Number.isFinite(event.data?.cardsHeight)) frame.style.height = `${event.data.cardsHeight + 24}px`; });
  update();
})();
