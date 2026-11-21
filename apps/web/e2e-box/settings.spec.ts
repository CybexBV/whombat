/**
 * A community box's settings (AP-5426…AP-5429): Tailscale's login server and EMAIL in This Whombat, no
 * remote help or plan, and Notifications from the box itself where the page is secure.
 */
import { expect, test } from '@playwright/test';
import { fake, setUp } from './support';

test('This Whombat: the login server and your own mail server', async ({ page }) => {
  await setUp(page);
  await page.goto('/settings?tab=appliance');
  // Tailscale is on in the fake box once turned on; the login server row is there either way.
  const tailscale = page.locator('[data-tailscale]');
  await tailscale.getByRole('button', { name: 'Turn on' }).click();
  const server = tailscale.locator('[data-row="login-server"]');
  await expect(server).toContainText('Tailscale’s own');
  await server.getByRole('button', { name: 'Change' }).click();
  const dialog = page.getByRole('dialog', { name: 'Login server' });
  await dialog.getByLabel('Login server').fill('http://10.0.0.5:8080');
  await expect(dialog.getByText('Plain http:// is fine', { exact: false })).toBeVisible();
  await expect(dialog.getByText('leaves its tailnet', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save and sign in' }).click();
  await expect(server).toContainText('http://10.0.0.5:8080');

  const mail = page.locator('[data-mail]');
  await expect(mail).toContainText('This Whombat sends no email.');
  await mail.getByRole('button', { name: 'Set up' }).click();
  const form = page.getByRole('dialog', { name: 'Your mail server' });
  await form.getByLabel('Server').fill('smtp.lumio.example.org');
  await form.getByLabel('User name').fill('whombat@lumio.example.org');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('alert')).toContainText('password');
  await form.getByLabel('Password').fill('app-password');
  await form.getByRole('button', { name: 'Send a test' }).click();
  await expect(form.getByRole('status')).toContainText('Check your inbox');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(mail).toContainText('smtp.lumio.example.org:587');
  await mail.getByRole('button', { name: 'Send a test' }).click();
  await expect(mail).toContainText('Last test');
  await mail.getByRole('button', { name: 'Remove' }).click();
  await page
    .getByRole('dialog', { name: 'Remove the mail server?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(mail).toContainText('This Whombat sends no email.');

  // No remote help or plan on a community box.
  await page.goto('/settings?tab=appliance&section=about');
  await expect(page.getByRole('heading', { name: 'VERSION' })).toBeVisible();
  await expect(page.getByText('REMOTE HELP')).toHaveCount(0);
  await expect(page.getByText('PLAN', { exact: true })).toHaveCount(0);
});

test('Notifications: from the box on a secure page, said plainly on the local-network page', async ({
  page,
  context,
}) => {
  // Headless Chromium answers `denied` whatever was granted; a person's browser asks first (`default`).
  await context.addInitScript(() =>
    Object.defineProperty(Notification, 'permission', { get: () => 'default' }),
  );
  await setUp(page);
  await page.goto('/settings?tab=notifications');
  const browser = page.getByRole('region', { name: 'THIS BROWSER' });
  await expect(browser.getByRole('status')).toHaveText('Off in this browser', { timeout: 20_000 });
  await expect(browser.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await fake(page, 'insecurePage', true);
  await page.reload();
  await expect(page.getByText('secure Tailscale page', { exact: false })).toBeVisible({ timeout: 20_000 });
  await fake(page, 'insecurePage', false);
});

test('This Whombat → About: REACH turns Link on and off, Updates from chooses the channel', async ({
  page,
}) => {
  await setUp(page);
  await page.goto('/settings?tab=appliance&section=about');
  const reach = page.locator('[data-reach]');
  const link = reach.locator('[data-row="link"]');
  await expect(link).toContainText('Whombat Link is off', { timeout: 20_000 });
  await link.getByRole('button', { name: 'Turn on' }).click();
  await expect(reach.getByTestId('whombat-link-box-code')).toHaveText('KXQM-PRTV');
  await expect(reach.getByRole('link', { name: 'app.whombat.com/link' })).toBeVisible();
  // The person confirms at the account site; the row follows by itself.
  await fake(page, 'linkState', 'on');
  await expect(link).toContainText('Whombat Link is on', { timeout: 10_000 });
  await link.getByRole('button', { name: 'Turn off' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
  await expect(link).toContainText('Whombat Link is off');

  const channel = page.locator('[data-row="channel"]');
  await channel.getByText('Beta').click();
  await expect(channel).toContainText('before they’re fully tested');
  await channel.getByText('Production').click();
  await expect(channel).toContainText('until Production has a newer version');
});

test('Link ended: the strip says what still works and turns Tailscale on', async ({ page }) => {
  await setUp(page);
  await fake(page, 'linkState', 'ended');
  await page.reload();
  const strip = page.getByTestId('link-strip');
  await expect(strip).toContainText('Whombat Link ended', { timeout: 20_000 });
  await strip.getByRole('button', { name: 'Turn on' }).click();
  await expect(strip.getByRole('link', { name: 'Sign in' })).toBeVisible({ timeout: 10_000 });
});
