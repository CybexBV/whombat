/**
 * “Look around without a Whombat” (docs/app/decisions/look-around.md): the sign-in page opens the demo world, every
 * screen says it is a demo, and Leave the demo goes back. `LINK_SHOTS=<dir>` also writes review screenshots.
 */
import { expect, test } from '@playwright/test';
import { fake, fresh } from './support';

const DIR = process.env.LINK_SHOTS ?? '';

test('the sign-in page opens the demo world, which says so and goes back', async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
  await page.getByRole('button', { name: 'Look around without a Whombat' }).click();
  const notice = page.getByTestId('demo-notice');
  await expect(notice).toContainText('This is a demo Whombat. Nothing you do here is real.', {
    timeout: 20_000,
  });
  // The address bar stays: a reload is the sign-in page again.
  await expect(page).toHaveURL(/\/$/);
  await notice.getByRole('button', { name: 'Leave the demo' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
});

for (const size of ['desktop', 'phone'] as const)
  for (const theme of ['light', 'dark'] as const)
    test(`look around (${size}, ${theme})`, async ({ page }) => {
      test.skip(!DIR, 'set LINK_SHOTS=<dir> to write review screenshots');
      test.setTimeout(120_000);
      if (size === 'phone') await page.setViewportSize({ width: 390, height: 844 });
      else await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const shot = async (name: string) => {
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${DIR}/${size}-${theme}-${name}.png` });
      };
      await fresh(page);
      await fake(page, 'reset');
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
      await shot('sign-in-look-around');
      await page.getByRole('button', { name: 'Look around without a Whombat' }).click();
      await expect(page.getByTestId('demo-notice')).toBeVisible({ timeout: 20_000 });
      await page.waitForLoadState('networkidle');
      await shot('demo-open');
    });
