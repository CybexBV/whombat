/**
 * Review screenshots of choosing a Whombat's own address name at the account site (Whombat own-address.md; not
 * baselines): the confirm step's Web address row with its random name, then the field with a free name and with a taken
 * one. Light and dark, 1440×900 and a phone's 390×844. `OWN_NAME_SHOTS=<dir>` writes them.
 */
import { expect, test } from '@playwright/test';
import { fake, fresh } from './support';

const DIR = process.env.OWN_NAME_SHOTS ?? '';

for (const size of ['desktop', 'phone'] as const)
  for (const theme of ['light', 'dark'] as const)
    test(`choosing a name at the account site (${size}, ${theme})`, async ({ page }) => {
      test.skip(!DIR, 'set OWN_NAME_SHOTS=<dir> to write review screenshots');
      test.setTimeout(120_000);
      if (size === 'phone') await page.setViewportSize({ width: 390, height: 844 });
      else await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const shot = async (name: string) => {
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: `${DIR}/account-${size}-${theme}-${name}.png`,
          fullPage: size === 'phone',
        });
      };

      await fresh(page);
      await fake(page, 'reset');
      await page.reload();
      const code = await fake<string>(page, 'linkCode', 'Home');
      await page.goto(`/link?code=${code}`);
      await page.getByLabel('Email').fill('mara@burrowhq.example');
      await page.getByRole('button', { name: 'Email me a link' }).click();
      await page.goto(await fake<string>(page, 'lastLink'));
      await expect(page.getByRole('heading', { name: 'Add Home?' })).toBeVisible();
      await expect(page.getByText('A random name, like maple-otter-river.whombat.app')).toBeVisible();
      await shot('confirm-random');

      await page.getByRole('button', { name: 'Choose your own' }).click();
      const field = page.getByRole('textbox', { name: 'Web address' });
      await field.fill('office');
      await expect(page.getByText('That name is taken.')).toBeVisible();
      await shot('confirm-taken');
      await field.fill('home');
      await expect(page.getByText('home.whombat.app is free.')).toBeVisible();
      await shot('confirm-free');

      await page.getByRole('checkbox', { name: 'I agree to the Whombat Subscription Terms' }).check();
      await page.getByRole('button', { name: 'Add it' }).click();
      await expect(page.getByRole('heading', { name: 'Home is added' })).toBeVisible();
      await page.getByRole('button', { name: 'Your Whombats' }).click();
      await expect(page.getByText('home.whombat.app').first()).toBeVisible({ timeout: 20_000 });
      await shot('home-with-name');
    });
