/**
 * The hosted build under its own Content-Security-Policy (AP-23; assignment §5): the journeys run with no
 * violation — no inline script, no eval, fonts and styles from this origin, images from blob:, nothing loaded
 * from a third party.
 */
import { expect, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('claim, chat with an image, canvas, the sign-in console: no CSP violations and no third-party requests', async ({
  page,
}) => {
  const violations: string[] = [];
  const foreign: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}:${e.columnNumber} ${e.sample}`,
      ),
    );
  });
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && u.protocol !== 'blob:' && u.protocol !== 'data:')
      foreign.push(r.url());
  });
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  await claimAndSaveKit(page);
  // The branch room's composer (channels went with the crew, one-agent.md).
  await page.goto('/burrow-hq/pr/482');
  const composer = page.getByRole('textbox', { name: 'Comment on PR #482' });
  await page
    .locator('input[type="file"]')
    .setInputFiles([{ name: 'dot.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(page.getByRole('list', { name: 'Attachments' }).getByText('70 bytes')).toBeVisible({
    timeout: 15_000,
  });
  await composer.fill('Under CSP');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Open dot.png' }).locator('img')).toHaveAttribute(
    'src',
    /^blob:/,
  );
  await page.goto('/burrow-hq/canvases/invoice-pdf-export-plan');
  await expect(page.getByText('keyed by invoice number and locale', { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  // Claude Code's own sign-in in the console (xterm: its styles and truecolor cells, CT-71), typed into directly
  // behind the guided steps (AP-62).
  await page.goto('/burrow-hq/settings?tab=ai');
  await page.getByRole('button', { name: 'Sign in with your subscription (Claude Code)' }).click();
  const panel = page.getByRole('region', { name: 'Claude Code sign-in' });
  await expect(panel.getByRole('link', { name: 'Open claude.ai to sign in' })).toBeVisible();
  await panel.getByRole('button', { name: 'Show Claude Code’s output' }).click();
  const consoleRegion = panel.getByRole('region', { name: 'Claude Code’s output' });
  await expect(consoleRegion.getByText('Paste code here if prompted', { exact: false })).toBeVisible();
  // A wrong code first: Claude Code's truecolor “Login failed” stays on screen.
  await consoleRegion.click();
  await page.keyboard.type('wrong');
  await page.keyboard.press('Enter');
  await expect(consoleRegion.getByText('Login failed', { exact: false })).toBeVisible();
  await panel.getByRole('button', { name: 'Get a new link' }).click();
  await expect(consoleRegion.getByText('Paste code here if prompted', { exact: false })).toBeVisible();
  await consoleRegion.click();
  await page.keyboard.type('code-4821');
  await expect(panel.getByText('Code entered (9 characters) · press Enter')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Signed in with your Claude subscription')).toBeVisible();
  // Fonts came from this origin.
  expect(await page.evaluate(() => document.fonts.check('16px "Bricolage Grotesque"'))).toBe(true);
  const fromPage = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  expect([...violations, ...fromPage]).toEqual([]);
  expect(foreign).toEqual([]);
});
