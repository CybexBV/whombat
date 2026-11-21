/**
 * Rich messages in the hosted build under its own CSP (assignment item 8, AP-320…AP-326): an HTML page as a fenced
 * block and as an `.html` attachment render live in the sandboxed frame (its script runs, its style applies), the page
 * can't reach the app or the network, code is highlighted, a Mermaid diagram draws, a PDF's first page shows, and the
 * app itself has no CSP violation. Hermetic: the page loads nothing from third parties.
 */
import { expect, type FrameLocator, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Pretzel logo</title>
<style>body{margin:0;background:#f6f1ea;color:#2b221d} h1{margin:0;color:rgb(125, 99, 83)} .row{display:flex;gap:24px;align-items:center;padding:32px}</style></head>
<body><div class="row"><svg width="96" height="96" viewBox="0 0 120 120"><circle cx="60" cy="60" r="56" fill="#2b221d"/><circle id="coin" cx="60" cy="58" r="10" fill="#e0b75e"/></svg><h1>Burrow Billing</h1></div>
<p id="out">waiting</p>
<script>
  const out = [];
  try { parent.document.title; out.push('parent: open'); } catch (e) { out.push('parent: ' + e.name); }
  try { top.location.href = 'https://example.com/'; out.push('top: navigated'); } catch (e) { out.push('top: ' + e.name); }
  fetch('/version.json').then(() => 'fetch: allowed', () => 'fetch: blocked').then((f) => {
    out.push(f);
    document.getElementById('out').textContent = out.join(' · ');
  });
  document.getElementById('coin').setAttribute('cy', '44');
</script></body></html>`;

const PDF = (() => {
  const content = 'BT /F1 24 Tf 72 720 Td (Brand sheet) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
})();

async function expectPageRendered(frame: FrameLocator) {
  await expect(frame.locator('h1')).toHaveText('Burrow Billing');
  await expect(frame.locator('h1')).toHaveCSS('color', 'rgb(125, 99, 83)');
  await expect(frame.locator('#coin')).toHaveAttribute('cy', '44');
  await expect(frame.locator('#out')).toHaveText(
    'parent: SecurityError · top: SecurityError · fetch: blocked',
  );
}

test('HTML pages, code, diagrams and PDFs render under the hosted CSP; the page is sandboxed', async ({
  page,
}) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    // The app's own document only: the sandboxed page's blocked attempts are the point of the sandbox.
    if (location.pathname.startsWith('/sandbox/')) return;
    document.addEventListener('securitypolicyviolation', (e) =>
      console.log(`CSP ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`),
    );
  });
  page.on('console', (m) => {
    // Radix Dialog's scroll lock (react-remove-scroll) adds a <style> element, which the app's style-src refuses: the
    // same for every modal in the hosted build, and harmless (the page still doesn't scroll behind the overlay).
    if (m.text().startsWith('CSP ') && !m.text().startsWith('CSP style-src-elem inline'))
      violations.push(m.text());
  });
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  await claimAndSaveKit(page);
  await page.goto('/burrow-hq/pr/482');
  const composer = page.getByRole('textbox', { name: 'Comment on PR #482' });

  // A fenced page.
  await composer.fill(`The logo page:\n\n\`\`\`html\n${PAGE}\n\`\`\``);
  await composer.press('Enter');
  const card = page.getByRole('figure', { name: 'Pretzel logo' }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  const frame = card.locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expectPageRendered(card.frameLocator('iframe'));
  expect(new URL(page.url()).pathname).toBe('/pr/482');
  // Its height follows the page (clamped), not the initial 320px.
  await expect.poll(async () => (await frame.boundingBox())?.height).toBeLessThan(320);
  // View source: highlighted.
  await card.getByRole('button', { name: 'View source' }).click();
  await expect(card.locator('pre span').first()).toBeVisible();
  await card.getByRole('button', { name: 'View source' }).click();

  // The same page as an attachment, and a PDF.
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'logo.html', mimeType: 'text/html', buffer: Buffer.from(PAGE) },
    { name: 'brand-sheet.pdf', mimeType: 'application/pdf', buffer: PDF },
  ]);
  await expect(page.getByText('2 files: 2 ready to send')).toBeAttached({ timeout: 15_000 });
  await composer.fill('As files');
  await composer.press('Enter');
  const attached = page.getByRole('figure', { name: 'Pretzel logo' }).nth(1);
  await expect(attached).toContainText('logo.html');
  await expectPageRendered(attached.frameLocator('iframe'));
  await expect(page.getByRole('img', { name: 'First page of brand-sheet.pdf' })).toBeVisible({
    timeout: 15_000,
  });

  // Code and a diagram.
  await composer.fill('```ts\nconst total = 42;\n```\n\n```mermaid\ngraph LR\n  Brief --> Logo\n```');
  await composer.press('Enter');
  await expect(page.getByText('const', { exact: true }).last()).toBeVisible();
  const diagram = page.getByRole('figure', { name: 'Diagram' }).last();
  await expect(
    diagram.frameLocator('iframe').locator('svg[id^="mermaid"], svg[aria-roledescription]').first(),
  ).toBeVisible({
    timeout: 15_000,
  });

  // Full screen, and back.
  await card.getByRole('button', { name: 'Open full screen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pretzel logo' });
  await expectPageRendered(dialog.frameLocator('iframe'));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  expect(violations).toEqual([]);
});
