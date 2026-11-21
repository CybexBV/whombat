/**
 * Tailscale on This Whombat (HE-51; hermes-engine-app.md AP-5305, AP-5326): you turn it on, sign in on
 * Tailscale's own page (the fake world stands for finishing it), see it on with the box's name and turn it off again.
 * `TS_SHOTS=<dir>` also writes review screenshots of the three states, light and dark, 1440×900.
 */
import { expect, type Page, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

const DIR = process.env.TS_SHOTS ?? '';

async function world(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  return claimAndSaveKit(page);
}

const section = (page: Page) => page.getByRole('region', { name: 'TAILSCALE' });

test('you turn Tailscale on, signs in on Tailscale’s page, and turns it off again', async ({ page }) => {
  const c = await world(page);
  await page.goto('/settings?tab=appliance');
  const ts = section(page);
  await expect(ts.getByText(/a private network for your own devices/)).toBeVisible({ timeout: 20_000 });
  await ts.getByRole('button', { name: 'Turn on' }).click();
  const signInLink = ts.getByRole('link', { name: 'Sign in' });
  await expect(signInLink).toHaveAttribute('href', /^https:\/\/login\.tailscale\.com\//);
  await expect(signInLink).toHaveAttribute('target', '_blank');
  await fake(page, 'tailscaleSignedIn', c.device);
  await expect(ts.getByText(/^whombat-[^ ]+\.ts\.net · in /)).toBeVisible({ timeout: 10_000 });
  await ts.getByRole('button', { name: 'Turn off' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Turn off Tailscale?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Turn off' }).click();
  await expect(ts.getByRole('button', { name: 'Turn on' })).toBeVisible();
  expect(await fake(page, 'tailscaleState', c.device)).toBe('off');
});

for (const theme of ['light', 'dark'] as const)
  test(`Tailscale's three states (${theme})`, async ({ page }) => {
    test.skip(!DIR, 'set TS_SHOTS=<dir> to write review screenshots');
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    const c = await world(page);
    await page.goto('/settings?tab=appliance');
    const ts = section(page);
    await expect(ts.getByRole('button', { name: 'Turn on' })).toBeVisible({ timeout: 20_000 });
    const shot = async (name: string) => {
      await ts.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/web-${theme}-tailscale-${name}.png` });
    };
    await shot('off');
    await ts.getByRole('button', { name: 'Turn on' }).click();
    await expect(ts.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await shot('signing-in');
    await fake(page, 'tailscaleSignedIn', c.device);
    await expect(ts.getByText(/^whombat-[^ ]+\.ts\.net · in /)).toBeVisible({ timeout: 10_000 });
    await shot('on');
  });
