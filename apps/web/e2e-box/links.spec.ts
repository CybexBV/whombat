/**
 * Adding a device to a community box (HE-60; AP-5422…AP-5425): a device link for your own second device, and a link
 * for another box is refused. No invite links: a Whombat is one person's (one-person.md AP-5675).
 */
import { expect, test } from '@playwright/test';
import { anotherBrowser, fake, inTheApp, setUp } from './support';

test('a QR code adds your own second device', async ({ page }) => {
  await setUp(page);
  await page.goto('/settings?tab=appliance&section=devices');
  await page.getByRole('button', { name: 'Show QR code' }).click();
  const panel = page.getByTestId('device-link');
  await expect(panel.getByRole('img', { name: 'QR code that adds a device to your account' })).toBeVisible();
  await expect(panel.getByRole('timer')).toContainText(/Works for [45]:\d\d more/);
  const link = await fake<string>(page, 'lastLocalLink');
  expect(link).toMatch(/\/add-device#s=/);

  await anotherBrowser(page, link);
  await expect(page.getByRole('heading', { name: 'Add this device' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Add this device' }).click();
  await inTheApp(page);
  // Used once: the same link doesn't let a third browser in.
  await anotherBrowser(page, link);
  await page.getByRole('button', { name: 'Add this device' }).click();
  await expect(page.getByRole('alert')).toContainText('used already');
});

test('a claimed box says how to add this device, and pairing is a click away', async ({ page }) => {
  await setUp(page);
  await anotherBrowser(page, '/');
  // On the developer's own machine the development sign-in comes first (HE-49); pairing is beside it.
  await expect(page.getByRole('heading', { name: 'Sign in on this machine' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Pair with another device' }).click();
  await expect(page.getByRole('heading', { name: 'Add this device' })).toBeVisible();
  await page.getByRole('button', { name: 'Pair with another device' }).click();
  await expect(page.getByRole('heading', { name: 'Add this device' })).toHaveCount(0);
});
