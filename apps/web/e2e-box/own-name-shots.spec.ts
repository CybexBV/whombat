/**
 * Review screenshots of a Whombat's own address once it can change (Whombat own-address.md; not baselines): Settings →
 * ADDRESS with Change, the change dialog with a free name, a refusal, the old address while it still works with
 * Cloudflare's line, the banner at the old address, and the passkeys section's prompt at the new one. Light and dark,
 * 1440×900 and a phone's 390×844. `OWN_NAME_SHOTS=<dir>` writes them.
 */
import { expect, type Page, test } from '@playwright/test';
import { anotherBrowser, fake, fresh, inTheApp } from './support';

const DIR = process.env.OWN_NAME_SHOTS ?? '';

/** The A3 box claimed at its own address, its passkey and the AI left for later. */
async function ownBoxSetUp(page: Page) {
  await fresh(page);
  await fake(page, 'ownBox', true);
  const claimLink = await fake<string>(page, 'ownClaimLink');
  await anotherBrowser(page, `/c/${claimLink}`);
  await expect(page.getByRole('heading', { name: 'Claim your Whombat' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Letters').fill(await fake<string>(page, 'ownLetters'));
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill('Mara Visser');
  await page.getByLabel('Email').fill('mara@lumio.example.org');
  await page.getByRole('button', { name: 'Claim it' }).click();
  await expect(page.getByRole('heading', { name: 'Make a passkey for this Whombat' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Later' }).click();
  const ai = page.getByRole('heading', { name: 'Connect your AI' });
  await expect(ai.or(page.getByRole('navigation').first())).toBeVisible({ timeout: 20_000 });
  if (await ai.isVisible()) await page.getByRole('button', { name: 'Skip for now' }).click();
  await inTheApp(page);
}

for (const size of ['desktop', 'phone'] as const)
  for (const theme of ['light', 'dark'] as const)
    test(`own names on the box's page (${size}, ${theme})`, async ({ page }) => {
      test.skip(!DIR, 'set OWN_NAME_SHOTS=<dir> to write review screenshots');
      test.setTimeout(240_000);
      // The setup at a desktop's width (its steps pane hides the page's heading on a phone); the shots at the size.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const shot = async (name: string, full = false) => {
        await page.mouse.move(0, 0);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${DIR}/box-${size}-${theme}-${name}.png`, fullPage: full });
      };
      const address = async () => {
        await page.goto('/settings?tab=appliance&section=about');
        const section = page.locator('[data-own-address]');
        await expect(section).toBeVisible({ timeout: 20_000 });
        await section.scrollIntoViewIfNeeded();
        return section;
      };

      await ownBoxSetUp(page);
      if (size === 'phone') await page.setViewportSize({ width: 390, height: 844 });
      let section = await address();
      await shot('settings-address');

      await section.getByRole('button', { name: 'Change' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill('home');
      await expect(dialog.getByText('home.whombat.app is free.')).toBeVisible();
      await shot('change-free');
      await fake(page, 'ownRenameRefusal', 'rename_limit');
      await dialog.getByRole('button', { name: 'Change address' }).click();
      await expect(dialog.getByRole('alert')).toContainText('3 times a year');
      await shot('change-refused');
      await fake(page, 'ownRenameRefusal', null);
      await dialog.getByRole('button', { name: 'Cancel' }).click();

      // Changed: the page is at the old address (the banner), Settings shows the old one with its last day.
      await fake(page, 'ownRenamed', { label: 'home', page: 'old' });
      await page.goto('/');
      await expect(page.getByTestId('own-address-moved')).toBeVisible({ timeout: 20_000 });
      await shot('banner-old-address');
      section = await address();
      await expect(section.locator('[data-row="leaving"]')).toBeVisible();
      await expect(section.locator('[data-cloudflare]')).toBeVisible();
      await shot('settings-leaving', size === 'phone');

      // At the new address: the passkeys section asks for one there.
      await fake(page, 'ownRenamed', { label: 'home', page: 'new' });
      await page.goto('/settings?tab=appliance&section=devices');
      const passkeys = page.locator('[data-box-passkeys]');
      await expect(passkeys.getByText('Add a passkey for your new address')).toBeVisible({ timeout: 20_000 });
      await passkeys.scrollIntoViewIfNeeded();
      await shot('passkeys-new-address');
    });
