/**
 * The one setup on a box's own page (whombat-link.md LNK-40): the letters from its screen, who you are, Tailscale with
 * your own login server and the advice on key expiry, Whombat Link offered once (never a gate), Connect your AI;
 * a wrong guess goes back to the letters, which the box changed.
 */
import { expect, test } from '@playwright/test';
import { COMMUNITY, claim, fake, finishSetup, fresh, inTheApp } from './support';

test('claims the box, turns Tailscale on with your own login server, offers Link once', async ({ page }) => {
  await fresh(page);
  await claim(page);
  await page.getByRole('button', { name: 'Use your own login server' }).click();
  await page.getByLabel('Login server').fill('ftp://hs.lumio.example.org');
  await expect(page.getByText('Start it with https:// or http://.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on Tailscale' })).toBeDisabled();
  await page.getByLabel('Login server').fill('https://HS.lumio.example.org/');
  await page.getByRole('button', { name: 'Turn on Tailscale' }).click();
  const signIn = page.getByRole('link', { name: 'Sign in' });
  await expect(signIn).toHaveAttribute('href', /^https:\/\/hs\.lumio\.example\.org\/register\//);
  // Neither Tailscale nor Link is a gate.
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await fake(page, 'tailscaleSignedIn', COMMUNITY);
  await expect(page.getByText('whombat-r7m4.lumio.hs', { exact: false })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('key expiry', { exact: false })).toBeVisible();
  // Link, once, with the price from its one constant; turning it on shows the code to type at the account site.
  const offer = page.locator('[data-link-offer]');
  await expect(offer).toContainText('€2.50 a month');
  await offer.getByRole('button', { name: 'Turn on Whombat Link' }).click();
  await expect(page.getByTestId('whombat-link-box-code')).toHaveText('KXQM-PRTV');
  await expect(page.getByRole('link', { name: 'app.whombat.com/link' })).toBeVisible();
  await finishSetup(page);
  // A reload opens the app: this browser is your first device.
  await page.reload();
  await inTheApp(page);
});

test('a wrong guess goes back to the letters, which the box changed', async ({ page }) => {
  await fresh(page);
  const before = await fake<string>(page, 'communityLetters');
  const wrong = before === 'KXQM' ? 'PRTV' : 'KXQM';
  await page.getByLabel('Letters').fill(wrong);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill('Mara Visser');
  await page.getByLabel('Email').fill('mara@lumio.example.org');
  await page.getByRole('button', { name: 'Claim it' }).click();
  await expect(page.getByRole('heading', { name: 'Claim your Whombat' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('new one');
  expect(await fake<string>(page, 'communityLetters')).not.toBe(before);
});
