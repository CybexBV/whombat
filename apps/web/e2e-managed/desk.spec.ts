/**
 * The desk display over the session (desk-display-web.md AP-3003…AP-3012, AP-5830…): from This Whombat's row to
 * Settings → Screen, you pair the box's own screen with the letters it shows and a PIN, choose what a locked screen
 * shows and what the screen shows, and answer the screen's unlock request from the notice — `desk.*` and
 * `desk.changed` through the fake world's screen.
 */
import { expect, type Page, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

async function setup(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  const c = await claimAndSaveKit(page);
  // The fresh box is a laptop on the desk with nobody paired yet.
  await fake(page, 'desk', c.device, 'unpaired');
  return c;
}

test('pair the screen, choose what it shows, and unlock it from the web', async ({ page }) => {
  const c = await setup(page);
  await page.goto('/settings?tab=appliance');
  await page
    .getByRole('group', { name: 'Parts of This Whombat' })
    .getByText('Screen', { exact: true })
    .click();
  const screen = page.locator('[data-screen-tab]');
  await expect(screen.getByText('The screen isn’t paired')).toBeVisible();
  await screen.getByRole('button', { name: 'Pair the screen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pair the screen' });
  await expect(dialog.getByText(/They change in \d+ min\./)).toBeVisible();
  const letters = await fake<string>(page, 'deskLetters', c.device);
  expect(letters).toMatch(/^[A-Z]{4}$/);
  await dialog.getByLabel('Type the 4 letters on the screen').fill(letters.toLowerCase());
  // A PIN of 4 to 6 digits (DK-26), over the session.
  await dialog.getByLabel(/^Choose a PIN/).fill('2580');
  await dialog.getByLabel('Type it again').fill('2580');
  await dialog.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(screen.getByText(/paired with you since/)).toBeVisible();

  type Desk = { settings: { lockedView: string; show: { items: Record<string, string> } } };
  const kept = () =>
    fake<{ appliances: Record<string, { desk?: { snapshot: Desk } }> }>(page, 'state').then(
      (s) => s.appliances[c.device]?.desk?.snapshot.settings,
    );

  // What it shows: the preview, and a choice saved over the session.
  await expect(screen.getByRole('img', { name: /^Preview: / })).toBeVisible();
  await screen.getByRole('radiogroup', { name: 'Plex' }).getByText('Off', { exact: true }).click();
  await expect.poll(() => kept().then((s) => s?.show.items['connection:con_plex'])).toBe('off');

  await screen
    .getByRole('group', { name: 'Screen settings' })
    .getByText('Lock and PIN', { exact: true })
    .click();
  const locked = screen.getByRole('group', { name: 'While locked it shows' });
  await locked.getByText('Everything', { exact: true }).click();
  await expect(screen.getByText(/Anyone walking past/)).toBeVisible();
  await expect.poll(() => kept().then((s) => s?.lockedView)).toBe('everything');

  // Someone at the screen presses “Confirm on your phone”: the notice comes by `desk.changed`.
  await page.goto('/settings?tab=profile');
  await page.waitForFunction(() => '__WHOMBAT_FAKE__' in window);
  await fake(page, 'deskRequestUnlock', c.device);
  const notice = page.getByTestId('desk-unlock-notice');
  await expect(notice).toContainText('Your desk screen wants to unlock.');
  await notice.getByRole('button', { name: 'Unlock' }).click();
  await expect(notice).toHaveCount(0);
  expect(await fake<boolean>(page, 'deskUnlocked', c.device)).toBe(true);
});
