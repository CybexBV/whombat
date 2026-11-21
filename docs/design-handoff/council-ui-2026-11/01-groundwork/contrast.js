/** Run in a rendered fixture page. Solid CSS text/background pairs, WCAG 2.x sRGB. */
function measureContrast() {
  const rgba = (s) => {
    const n = s.match(/[\d.]+/g)?.map(Number);
    if (!n || n.length < 3) return null;
    const scale = s.startsWith('color(srgb ') ? 255 : 1;
    return [n[0] * scale, n[1] * scale, n[2] * scale, n[3] ?? 1];
  };
  const over = (a, b) => [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3]));
  const luminance = (rgb) => rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const rows = [];
  const skipped = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    const el = node.parentElement;
    if (!text || !el || el.closest('script,style,svg,[aria-hidden="true"]')) continue;
    const style = getComputedStyle(el);
    if (style.visibility !== 'visible' || style.display === 'none') continue;
    const range = document.createRange();
    range.selectNode(node);
    const rect = [...range.getClientRects()].find((r) => r.width && r.height && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth);
    if (!rect) continue;
    const cx = Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2));
    const cy = Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2));
    const front = document.elementFromPoint(cx, cy);
    if (front && !el.contains(front) && !front.contains(el)) continue;
    const chain = [];
    for (let p = el; p; p = p.parentElement) chain.unshift(getComputedStyle(p));
    if (chain.some((s) => s.backgroundImage !== 'none' || s.mixBlendMode !== 'normal' || s.filter !== 'none')) {
      skipped.push(text.slice(0, 100));
      continue;
    }
    let bg = [255, 255, 255];
    let opacity = 1;
    for (const s of chain) {
      opacity *= Number(s.opacity);
      const color = rgba(s.backgroundColor);
      if (color) bg = over(color, bg);
    }
    if (!opacity) continue;
    const color = rgba(style.color);
    if (!color) { skipped.push(text.slice(0, 100)); continue; }
    color[3] *= opacity;
    const fg = over(color, bg);
    const a = luminance(fg), b = luminance(bg);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    rows.push({ text: text.slice(0, 120), ratio: +ratio.toFixed(3), foreground: fg.map(Math.round), background: bg.map(Math.round), fontSize: style.fontSize, shell: !!el.closest('aside,nav'), tag: el.tagName });
  }
  rows.sort((a, b) => a.ratio - b.ratio);
  return { url: location.pathname + location.search, date: new Date().toISOString(), theme: document.documentElement.dataset.theme, viewport: [innerWidth, innerHeight], userAgent: navigator.userAgent, threshold: 4.5, count: rows.length, minimum: rows[0]?.ratio ?? null, failures: rows.filter((r) => r.ratio < 4.5), skipped, pairs: [...new Map(rows.map((r) => [JSON.stringify([r.foreground, r.background]), r])).values()], text: document.body.innerText };
}
