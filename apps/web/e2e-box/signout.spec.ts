import { expect, type Page, test } from '@playwright/test';
import { inTheApp, setUp } from './support';

// Only public identifiers leave the page; the private key stays in IndexedDB.
async function peer(page: Page, slot = 'default') {
  return page.evaluate(async (slot) => {
    const path = '/src/managed/keys.ts';
    const keys = (await import(/* @vite-ignore */ path)) as typeof import('../src/managed/keys');
    return (await keys.loadOrCreateEndpointKey({ slot })).peerId;
  }, slot);
}

test('sign-out forgets the person’s key, closes other tabs, and preserves the screen key', async ({
  page,
  context,
}) => {
  await setUp(page);
  const before = await peer(page);
  const screen = await peer(page, 'screen');
  const other = await context.newPage();
  await other.goto('/');
  await inTheApp(other);
  await page.getByRole('button', { name: /^Account,/ }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  for (const tab of [page, other]) {
    await expect(tab.getByRole('navigation')).toHaveCount(0);
    await expect(tab.getByRole('heading', { name: 'Sign in on this machine' })).toBeVisible();
    expect(await peer(tab)).not.toBe(before);
    expect(await peer(tab, 'screen')).toBe(screen);
  }
  expect(await peer(other)).toBe(await peer(page));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in on this machine' })).toBeVisible();
  await other.close();
});

test('failed credential deletion is visible and can be retried', async ({ page }) => {
  await setUp(page);
  const before = await peer(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete;
    Object.assign(window, {
      restoreDeletion: () => {
        IDBObjectStore.prototype.delete = original;
      },
    });
    IDBObjectStore.prototype.delete = function (key) {
      if (key === 'default') throw new DOMException('Synthetic storage failure', 'UnknownError');
      return original.call(this, key);
    };
  });
  await page.getByRole('button', { name: /^Account,/ }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Couldn’t sign out' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  expect(await peer(page)).toBe(before);
  await page.evaluate(() => Reflect.get(window, 'restoreDeletion')());
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in on this machine' })).toBeVisible();
  expect(await peer(page)).not.toBe(before);
});
