/**
 * Review screenshots of the account's side of the own address (own-address.md OWA-13; the app's OA-05; not baselines):
 * the list with a Whombat set up at its own address (its name only), “Link a Whombat” with the terms, then the code with
 * its countdown and the account passkey beside it. Light and dark, 1440×900. `OWN_SHOTS=<dir>` writes them.
 */
import { expect, test } from '@playwright/test';
import { fake, fresh, signIn } from './support';

const DIR = process.env.OWN_SHOTS ?? '';

for (const theme of ['light', 'dark'] as const)
  test(`linking a Whombat at the account (${theme})`, async ({ page }) => {
    test.skip(!DIR, 'set OWN_SHOTS=<dir> to write review screenshots');
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    const shot = async (name: string) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/hosted-${theme}-${name}.png` });
    };

    await fresh(page);
    await signIn(page, { nearby: [] });
    await fake(page, 'ownLinked');
    await page.reload();
    await expect(page.getByText('Its address is in your Whombat app', { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await shot('list');

    await page.getByRole('button', { name: 'Link a Whombat' }).click();
    await expect(page.getByRole('heading', { name: 'Link a Whombat' })).toBeVisible();
    await shot('link');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Link a Whombat' }).click();
    await expect(page.getByTestId('whombat-link-code')).toBeVisible();
    await shot('link-code');
  });
