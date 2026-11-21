/**
 * Review screenshots of shared links (Whombat share-links.md; not baselines): a Chat thread's Share button, the Share
 * sheet with what to look at first, the link once made, and Settings → You → Shared links — light and dark at
 * 1440×900, in the fake managed world. `SHARE_SHOTS=<dir>` writes them.
 */
import { expect, type Page, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

const DIR = process.env.SHARE_SHOTS ?? '';

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}

for (const theme of ['light', 'dark'] as const)
  test(`shared links (${theme})`, async ({ page }) => {
    test.skip(!DIR, 'set SHARE_SHOTS=<dir> to write review screenshots');
    test.setTimeout(240_000);
    page.setDefaultTimeout(20_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await fresh(page);
    await fake(page, 'reset');
    await fake(page, 'servers', true);
    await page.reload();
    await signIn(page);
    await claimAndSaveKit(page);
    await expect(page).toHaveURL(/\/chat$/);
    const chat = page.getByRole('region', { name: 'Chat' });
    await chat
      .getByRole('link', { name: /replies/ })
      .first()
      .click();
    const thread = page.getByRole('complementary', { name: 'Thread' });
    await expect(thread).toBeVisible();
    await shot(page, `${theme}-01-thread`);
    await thread.getByRole('button', { name: 'Share this thread' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('button', { name: 'Create link' })).toBeEnabled();
    await shot(page, `${theme}-02-sheet`);
    await sheet.getByRole('button', { name: 'Create link' }).click();
    await expect(sheet.getByText('Your link is ready')).toBeVisible();
    await shot(page, `${theme}-03-ready`);
    await sheet.getByRole('button', { name: 'Done' }).click();
    await page.goto('/settings?tab=you&part=links');
    await expect(page.getByTestId('shared-links')).toBeVisible();
    await shot(page, `${theme}-04-settings`);
  });
