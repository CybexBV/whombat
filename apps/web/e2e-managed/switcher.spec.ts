/**
 * The burrow name opens the organization's other Whombats (whombat-switcher.md AP-3080…AP-3083): with one Whombat it
 * is the name alone; with two, its menu lists both, the open one ticked, and choosing the other opens it in place.
 */
import { expect, type Page, test } from '@playwright/test';
import { agreeToTerms, type Console, claimFresh, consoles, fake, fresh, signIn, skipToApp } from './support';

/** Where the review screenshots go (`MANAGED_SHOTS_DIR`, default the repository's `tmp/shots`). */
const SHOTS = process.env.MANAGED_SHOTS_DIR ?? '../../tmp/shots';

const switcher = (page: Page) => page.locator('[data-whombat-switcher]');

/** The spare box, found on this network from the list's Claim; ends in its app. */
async function claimSpare(page: Page) {
  await fake(page, 'nearby', ['spare']);
  await page.goto('/appliances');
  await page.getByRole('button', { name: 'Claim a Whombat' }).click();
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
  const screen = (await consoles(page)).spare as Console;
  await page.getByLabel('Enter the 4 letters from its screen').fill(screen.letters);
  await agreeToTerms(page);
  await page.getByRole('button', { name: 'Claim it' }).click();
  // No kit step (BX-01): straight into the Whombat.
  await skipToApp(page);
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
}

test('the burrow name switches between the organization’s Whombats', async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  const hq = await claimFresh(page);
  // One Whombat: the name, no menu.
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible({ timeout: 20_000 });
  await expect(switcher(page)).toHaveCount(0);

  await claimSpare(page);
  const spare = (await fake<Record<string, { device: string }>>(page, 'cards')).spare?.device as string;
  await expect(switcher(page)).toBeVisible({ timeout: 20_000 });
  await switcher(page).click();
  await expect(switcher(page)).toHaveAttribute('aria-expanded', 'true');
  const here = page.locator(`[data-whombat="${spare}"]`);
  const other = page.locator(`[data-whombat="${hq.device}"]`);
  await expect(here).toHaveAttribute('aria-current', 'true');
  await expect(here).toContainText('This Whombat');
  await expect(other).toContainText('Burrow HQ');
  await expect(page.getByRole('button', { name: 'All Whombats' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/whombat-switcher-open.png` });

  // Esc closes it; choosing the other Whombat opens it in place.
  await page.keyboard.press('Escape');
  await expect(switcher(page)).toHaveAttribute('aria-expanded', 'false');
  await switcher(page).click();
  await other.click();
  await expect(page).not.toHaveURL(/\/appliances/);
  await switcher(page).click();
  await expect(page.locator(`[data-whombat="${hq.device}"]`)).toHaveAttribute('aria-current', 'true', {
    timeout: 20_000,
  });

  // All Whombats: the list.
  await page.getByRole('button', { name: 'All Whombats' }).click();
  await expect(page.getByRole('heading', { name: 'Pick a Whombat' })).toBeVisible();

  // You name the spare there (AP-3086); the menu shows that name from then on.
  await page
    .getByRole('button', { name: /^Rename / })
    .nth(1)
    .click();
  const field = page.getByRole('textbox', { name: `Name for ${spare}` });
  await field.fill('Spare room');
  await page.screenshot({ path: `${SHOTS}/whombat-rename.png` });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(field).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Whombats' })).toContainText('Spare room');
  await page.getByRole('button', { name: 'Open Burrow HQ' }).click();
  await switcher(page).click();
  await expect(page.locator(`[data-whombat="${spare}"]`)).toContainText('Spare room');
  await page.screenshot({ path: `${SHOTS}/whombat-switcher-named.png` });
});
