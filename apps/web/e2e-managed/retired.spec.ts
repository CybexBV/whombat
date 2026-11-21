/**
 * A retired Whombat (AP-693…AP-697): control retires the Whombat this browser opens. Refreshing `/` (or the session
 * ending while it's open) goes to the list with a notice, never “You’re offline” for ever; the list shows it as Retired,
 * to forget; with every Whombat retired it looks nearby first and the new one is claimed (AP-75). A Whombat control
 * doesn't list for the organization is retried with its own words; a real network loss still says “You’re offline”.
 */
import { expect, type Page, test } from '@playwright/test';
import {
  agreeToTerms,
  type Console,
  claimFresh,
  consoles,
  fake,
  fresh,
  signIn,
  skipProtect,
} from './support';

const NOTICE = 'Burrow HQ was retired. It can’t be opened any more.';
const NONE_IN_USE = 'No Whombats in use. Plug in another one, then claim it with the code on its screen.';
/** Where the review screenshots go (`MANAGED_SHOTS_DIR`, default the repository's `tmp/shots`). */
const SHOTS = process.env.MANAGED_SHOTS_DIR ?? '../../tmp/shots';

async function setup(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  return claimFresh(page);
}

const row = (page: Page, name: string) => page.getByRole('listitem').filter({ hasText: name });

/** From the claim found on this network: the letters, the terms, protect skipped; ends in the app (no kit, BX-01). */
async function claimFound(page: Page, box: 'spare') {
  const screen = (await consoles(page))[box] as Console;
  await page.getByLabel('Enter the 4 letters from its screen').fill(screen.letters);
  await agreeToTerms(page);
  await page.getByRole('button', { name: 'Claim it' }).click();
  await skipProtect(page);
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
}

test('refreshing / on a retired Whombat goes to the list with a notice, and it isn’t reopened (AP-694, AP-695)', async ({
  page,
}) => {
  const c = await setup(page);
  await fake(page, 'nearby', []);
  await fake(page, 'retire', c.device);
  await page.goto('/');
  await expect(page).toHaveURL(/\/appliances$/);
  await expect(page.getByTestId('appliances-notice')).toHaveText(NOTICE);
  await expect(row(page, 'Burrow HQ')).toContainText('Retired');
  await expect(page.getByRole('button', { name: 'Open Burrow HQ' })).toHaveCount(0);
  await expect(page.getByText(NONE_IN_USE)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Claim a Whombat' })).toBeVisible();
  await expect(page.getByText('You’re offline.', { exact: false })).toHaveCount(0);
  // The last used is cleared: `/` lists it again, without the notice.
  await page.goto('/');
  await expect(page).toHaveURL(/\/appliances$/);
  await expect(row(page, 'Burrow HQ')).toContainText('Retired');
  await expect(page.getByTestId('appliances-notice')).toHaveCount(0);
  // Forget: gone from this browser's list at once; the organization still has no Whombat in use.
  await page.getByRole('button', { name: 'Forget Burrow HQ' }).click();
  await expect(row(page, 'Burrow HQ')).toHaveCount(0);
  await expect(page.getByText(NONE_IN_USE)).toBeVisible();
  await page.reload();
  await expect(page.getByText(NONE_IN_USE)).toBeVisible();
  await expect(row(page, 'Burrow HQ')).toHaveCount(0);
});

test('retired while open: when its connection ends, the list says so', async ({ page }) => {
  const c = await setup(page);
  await fake(page, 'nearby', []);
  await fake(page, 'retire', c.device);
  await fake(page, 'dropConnections', c.device);
  await expect(page.getByTestId('appliances-notice')).toHaveText(NOTICE, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/appliances$/);
  await expect(row(page, 'Burrow HQ')).toContainText('Retired');
});

test('a link into a retired Whombat goes to the list with the notice', async ({ page }) => {
  const c = await setup(page);
  await fake(page, 'nearby', []);
  await fake(page, 'retire', c.device);
  await page.goto(`/appliances/${c.device}/settings`);
  await expect(page.getByTestId('appliances-notice')).toHaveText(NOTICE);
  await expect(page).toHaveURL(/\/appliances$/);
});

test('every Whombat retired: the list looks nearby, the new one is claimed, then both are listed (AP-75)', async ({
  page,
}) => {
  const c = await setup(page);
  await fake(page, 'retire', c.device);
  await fake(page, 'nearby', ['spare']);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
  await claimFound(page, 'spare');
  await page.goto('/appliances');
  await expect(page.getByRole('button', { name: 'Open New Whombat' })).toBeVisible();
  await expect(row(page, 'Burrow HQ')).toContainText('Retired');
  await expect(page.getByText(NONE_IN_USE)).toHaveCount(0);
  // The new one is in use: the list stays (no look nearby), and `/` opens it.
  await page.goto('/');
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page).not.toHaveURL(/\/appliances$/);
});

test('a Whombat control doesn’t list for the organization: retried with its own words, never “offline” (AP-693)', async ({
  page,
}) => {
  const c = await setup(page);
  await fake(page, 'release', c.device);
  await fake(page, 'dropConnections', c.device);
  const strip = page
    .getByRole('status')
    .filter({ hasText: 'This Whombat isn’t in your organization right now. Trying again.' });
  await expect(strip).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('You’re offline.', { exact: false })).toHaveCount(0);
  // Back in the organization (a late claim report): it connects again.
  await fake(page, 'release', c.device, false);
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(strip).toHaveCount(0, { timeout: 15_000 });
});

test('a real network loss still says “You’re offline” and comes back', async ({ page }) => {
  const c = await setup(page);
  await fake(page, 'controlDown', true);
  await fake(page, 'dropConnections', c.device);
  const offline = page
    .getByRole('status')
    .filter({ hasText: 'You’re offline. We’ll reconnect when you’re back.' });
  await expect(offline).toBeVisible({ timeout: 15_000 });
  await fake(page, 'controlDown', false);
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(offline).toHaveCount(0, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/appliances$/);
});

for (const theme of ['light', 'dark'] as const)
  test(`screens: the list with a retired Whombat (${theme})`, async ({ page }) => {
    test.skip(!process.env.MANAGED_SHOTS, 'set MANAGED_SHOTS=1 to write review screenshots');
    await page.emulateMedia({ colorScheme: theme });
    const shot = (name: string) => page.screenshot({ path: `${SHOTS}/retired-${theme}-${name}.png` });
    const c = await setup(page);
    await fake(page, 'nearby', []);
    await fake(page, 'retire', c.device);
    await page.goto('/');
    await expect(page.getByTestId('appliances-notice')).toHaveText(NOTICE);
    await shot('list-notice');
    await page.goto('/');
    await expect(row(page, 'Burrow HQ')).toContainText('Retired');
    await shot('list');
    await fake(page, 'nearby', ['spare']);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
    await shot('claim-new');
    await claimFound(page, 'spare');
    await page.goto('/appliances');
    await expect(page.getByRole('button', { name: 'Open New Whombat' })).toBeVisible();
    await shot('list-new-and-retired');
    await page.goto('/');
    await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
    const spare = (await fake<Record<string, { device: string }>>(page, 'cards')).spare?.device as string;
    await fake(page, 'release', spare);
    await fake(page, 'dropConnections', spare);
    await page
      .getByRole('status')
      .filter({ hasText: 'isn’t in your organization right now' })
      .waitFor({ timeout: 15_000 });
    await shot('unlisted-strip');
  });
