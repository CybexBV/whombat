/**
 * What this browser holds between opening a link and finishing its journey (AP-590, AP-591); sign-out forgets them all.
 * No invite or link to get back in any more (AP-5674), and no card or invite code since Whombat Link (LNK-35).
 */
import { expect, type Page, test } from '@playwright/test';
import { cards, claimFresh, fake, fresh, signIn } from './support';

const CLAIM_CARD = 'whombat:claim-card';
/** A valid value for each held record: a device link, a card and a signup code (one-person.md AP-5674). */
const HELD: Record<string, Record<string, unknown>> = {
  'whombat:add-device-link': { device: 'dev_planted', peerId: null },
  [CLAIM_CARD]: { device: 'dev_planted', secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  'whombat:signup-code': { code: '7KQ2-M4XD' },
};
const HOUR = 3_600_000;

interface Stored {
  v: number;
  heldAt: number;
  expiresAt: number;
  value: Record<string, unknown>;
}

const raw = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const stored = async (page: Page, key: string) =>
  JSON.parse((await raw(page, key)) ?? 'null') as Stored | null;
/** Puts a record straight into storage (at `Date.now()` of the page plus `offset` for `at`/`heldAt`). */
const plant = (page: Page, key: string, make: (now: number) => unknown) =>
  page.evaluate(([k, text]) => localStorage.setItem(k as string, text as string), [
    key,
    JSON.stringify(make(Date.now())),
  ] as const);

test.beforeEach(async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
});

test('a card’s link holds nothing any more (Whombat Link): its secret only leaves the address bar', async ({
  page,
}) => {
  const c = (await cards(page)).fresh;
  await page.goto(c.link);
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
  expect(page.url()).not.toContain('#');
  expect(await raw(page, CLAIM_CARD)).toBeNull();
});

test('a Whombat this browser can’t store is kept for this page, the list says so, and a reload doesn’t pretend', async ({
  page,
}) => {
  await signIn(page);
  // This browser's storage is full for the list of Whombats (until the reload).
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k.startsWith('whombat:appliances:'))
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return setItem.call(this, k, v);
    };
  });
  // No kit: making one opens its page in a new load, and this test needs the page that couldn't store.
  await claimFresh(page);
  expect(await raw(page, 'whombat:appliances:acc_mara')).toBeNull();
  // To the list in the same page (as “Switch Whombat” does).
  await page.evaluate(() => {
    window.history.pushState(null, '', '/appliances');
    window.dispatchEvent(new Event('whombat:navigate'));
  });
  await expect(page.getByRole('heading', { name: 'Pick a Whombat' })).toBeVisible();
  const cantKeep = page.getByText(
    'This browser can’t keep a device key safely. Use a recent Chrome, Edge, Firefox or Safari.',
  );
  await expect(cantKeep).toBeVisible();
  // Kept for this page: it still opens.
  await page.getByRole('button', { name: 'Open Burrow HQ' }).click();
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 15_000 });

  // A reload asks storage again: this browser never stored it, so it asks to be set up.
  await page.goto('/appliances');
  await expect(page.getByRole('heading', { name: 'Pick a Whombat' })).toBeVisible();
  await expect(cantKeep).toBeHidden();
  await page.getByRole('button', { name: 'Open Burrow HQ' }).click();
  await expect(page.getByRole('heading', { name: 'Set up this device' })).toBeVisible();
});

test('signing out forgets every held link, code and card, and nothing else', async ({ page }) => {
  await signIn(page, { nearby: [] });
  for (const [key, value] of Object.entries(HELD))
    await plant(page, key, (now) => ({ v: 1, heldAt: now, expiresAt: now + HOUR, value }));
  await page.evaluate(() => localStorage.setItem('whombat:unrelated', 'kept'));
  // Still held while signed in on the list.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pick a Whombat' })).toBeVisible();
  for (const key of Object.keys(HELD))
    expect(await stored(page, key), key).toMatchObject({ value: HELD[key] });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
  for (const key of Object.keys(HELD)) expect(await raw(page, key), key).toBeNull();
  expect(await raw(page, 'whombat:unrelated')).toBe('kept');
});
