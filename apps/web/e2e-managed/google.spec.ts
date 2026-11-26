/**
 * Connecting Google on a managed Whombat (docs/decisions/assistant-guides.md AG-14): Google returns to the hosted
 * UI's `/connect/google`, which takes `code` and `state` off the address bar at once, reopens the Whombat that started
 * the connect and finishes over its session (`connections.finishGoogle`), then goes where it answers.
 */
import { expect, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

test('signed out on /connect/google, Google’s code never goes into the sign-in link', async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.goto('/connect/google?code=4%2F0secret-code&state=oas_1234');
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
  expect(await page.evaluate(() => window.location.href)).not.toContain('code=');
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = await fake<string>(page, 'lastLink');
  expect(decodeURIComponent(link)).not.toContain('secret-code');
  expect(decodeURIComponent(link)).not.toContain('oas_1234');
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await fresh(page);
    await fake(page, 'reset');
    await page.reload();
    await signIn(page);
  });

  test('Connect Google comes back through /connect/google and finishes over the session', async ({
    page,
  }) => {
    const { device } = await claimAndSaveKit(page);
    // Every address the tab showed: the code may appear only in the one navigation Google makes.
    const shown: string[] = [];
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) shown.push(f.url());
    });
    await page.goto('/connections?connection=google');
    await page.getByRole('button', { name: 'Connect Google' }).click();

    await expect(page.getByText('Google connected: mara@example.com.')).toBeVisible({ timeout: 15_000 });
    // It lands on the new connection's own page.
    await expect(page).toHaveURL(/\/\/[^/]+\/things\/connection%3Acon_[^/?]+$/);
    expect(await fake(page, 'googleFinishes', device)).toEqual([
      { code: '4/0fake-code', state: expect.stringMatching(/^oas_/), error: null },
    ]);
    // The address bar lost the code at once, and nothing of the connect stays in this tab.
    expect(await page.evaluate(() => window.location.href)).not.toContain('code=');
    expect(await page.evaluate(() => sessionStorage.getItem('whombat:google-connect'))).toBeNull();
    expect(shown.some((u) => u.includes('/connect/google?code='))).toBe(true);
  });

  test('a /connect/google without Google’s answer goes on without finishing anything', async ({ page }) => {
    const { device } = await claimAndSaveKit(page);
    await page.goto('/connect/google');
    await expect(page).not.toHaveURL(/connect\/google/, { timeout: 15_000 });
    expect(await fake(page, 'googleFinishes', device)).toEqual([]);
  });
});
