/**
 * Backup places, which have no mock, as screenshot baselines (`__screenshots__/backupPlaces.spec.ts/`), light and dark,
 * 1440×900 (app backup-places.md AP-6700…AP-6716; reviewed against BACKUPS and RECOVERY KIT when taken): This Whombat →
 * Backups → ON YOUR NETWORK with fixture mode's places — blackbox keeping the backups, the-falcon ready, pve-01 with
 * Look only, a Synology NAS to connect first and a QNAP set up by hand — then Back up here's question (blackbox keeps
 * them, so moving asks first), the minute or two it takes, and the by-hand sheet; where on a place (AP-6770…): “Where
 * on DiskStation?”, Change on blackbox's share and the move while it runs. Each shot is the section or the dialog alone.
 */
import type { Page } from '@playwright/test';
import { expect, openApp, settle, THEMES, test } from './support/harness';

async function open(page: Page, theme: 'light' | 'dark') {
  await openApp(page, { path: '/settings?tab=appliance&section=backups', theme });
  await page.locator('h1').first().waitFor();
  const section = page.locator('section[data-backup-places]');
  await section.getByText('the-falcon').waitFor();
  return section;
}

for (const theme of THEMES) {
  test(`ON YOUR NETWORK (${theme})`, async ({ page }) => {
    const section = await open(page, theme);
    await settle(page);
    await expect(section).toHaveScreenshot(`places-${theme}.png`);
  });

  test(`Back up here: the question and the wait (${theme})`, async ({ page }) => {
    const section = await open(page, theme);
    await section
      .locator('[data-backup-place="server:the-falcon"]')
      .getByRole('button', { name: 'Back up here' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Back up to the-falcon instead?' });
    await dialog.waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`move-${theme}.png`);
    await dialog.getByRole('button', { name: 'Back up here' }).click();
    await section.getByText('This can take a minute or two.').waitFor();
    await settle(page, 50);
    await expect(section).toHaveScreenshot(`setting-up-${theme}.png`);
    await section.getByText('Done. Backups go to the-falcon now.').waitFor();
  });

  test(`Where on DiskStation? (${theme})`, async ({ page }) => {
    const section = await open(page, theme);
    await section
      .locator('[data-backup-place="connection:con_diskstation"]')
      .getByRole('button', { name: 'Back up here' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Where on DiskStation?' });
    await dialog.waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`where-${theme}.png`);
  });

  test(`Change where on blackbox, and the move (${theme})`, async ({ page }) => {
    const section = await open(page, theme);
    await section
      .locator('[data-backup-place="server:blackbox"]')
      .getByRole('button', { name: /^Change/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Where on blackbox?' });
    await dialog.waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`change-${theme}.png`);
    await dialog.getByRole('radio', { name: /^Backups/ }).check();
    await dialog.getByRole('button', { name: 'Change' }).click();
    const confirm = page.getByRole('dialog', { name: 'Keep backups in Backups?' });
    await confirm.waitFor();
    await settle(page);
    await expect(confirm).toHaveScreenshot(`change-confirm-${theme}.png`);
    await confirm.getByRole('button', { name: 'Change' }).click();
    await section.getByText(/^Moving your backups to Backups/).waitFor();
    await settle(page, 50);
    await expect(section).toHaveScreenshot(`moving-${theme}.png`);
  });

  test(`Set it up by hand (${theme})`, async ({ page }) => {
    const section = await open(page, theme);
    await section.getByRole('button', { name: 'Set it up by hand' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set up QNAP NAS by hand' });
    await dialog.getByTestId('backup-place-compose').waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`by-hand-${theme}.png`);
  });
}
