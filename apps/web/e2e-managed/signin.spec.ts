/**
 * First sign-in the way control sends it (fragment token): a new account lands on the home (Whombat Link,
 * LNK-35); an account with an organization from before Link on the hosted list.
 */
import { expect, test } from '@playwright/test';
import { fake, fresh, openSignInLink } from './support';

test.beforeEach(async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
});

test('the emailed link (#token=…) signs in, leaves no token in the address, and a new account lands on the home', async ({
  page,
}) => {
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = await fake<string>(page, 'lastLink');
  expect(link).toMatch(/^\/auth\/verify#token=[0-9a-f]+$/);
  await openSignInLink(page, link);
  // No Whombat yet: how to add the first, with the code field right there.
  await expect(page.getByRole('heading', { name: 'Add your Whombat' })).toBeVisible();
  expect(page.url()).not.toContain('token');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel('Code from its screen')).toBeVisible();
  // No organization naming, no waitlist, no plans: the old addresses show the home or the account.
  await page.goto('/signup');
  await expect(page.getByRole('heading', { name: 'Add your Whombat' })).toBeVisible();
  await page.goto('/appliances');
  await expect(page.getByRole('heading', { name: 'Add your Whombat' })).toBeVisible();
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
});

test('an account with an organization from before Link lands on the home; its list stays at /appliances', async ({
  page,
}) => {
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await fake(page, 'nearby', []);
  await fake(page, 'existingOrg');
  await openSignInLink(page, await fake<string>(page, 'lastLink'));
  await expect(page.getByRole('heading', { name: 'Add your Whombat' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/appliances');
  await expect(page.getByRole('heading', { name: 'Pick a Whombat' })).toBeVisible();
  await page.getByRole('button', { name: 'Whombat Link' }).click();
  await expect(page.getByRole('heading', { name: 'Add your Whombat' })).toBeVisible();
});

test('/waitlist and /signup signed out are the sign-in page', async ({ page }) => {
  for (const path of ['/waitlist', '/signup']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join the waitlist' })).toHaveCount(0);
  }
});

test('opening a sign-in link uses nothing until Sign in is tapped (mail scanners open links too)', async ({
  page,
}) => {
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await fake<string>(page, 'lastLink'));
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(page.url()).not.toContain('token');
  expect(await fake<number>(page, 'verifyCalls')).toBe(0);
});

test('a used or broken link says so instead of looping back to sign-in, with a way to ask again', async ({
  page,
}) => {
  await openSignInLink(page, '/auth/verify#token=x');
  await expect(page.getByText('That sign-in link doesn’t work any more.')).toBeVisible();
  await page.getByRole('button', { name: 'Ask for a new link' }).click();
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('a link without a token is just the sign-in page', async ({ page }) => {
  await page.goto('/auth/verify');
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
});

test('first run in one page: verify → straight to the Whombat found on this network', async ({ page }) => {
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = await fake<string>(page, 'lastLink');
  await fake(page, 'existingOrg');
  // The link opens in this tab (as an email client would), then the organization's list.
  await openSignInLink(page, link);
  await expect(page.getByRole('heading', { name: 'Add your Whombat' })).toBeVisible();
  await page.goto('/appliances');
  // No Whombats yet and one on this network: its claim, without “Claim a Whombat” (AP-75).
  await expect(page).toHaveURL(/\/appliances\/claim$/);
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
  // Back to the list: it stays there (once per visit).
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Pick a Whombat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Claim a Whombat' })).toBeVisible();
  await expect(page).toHaveURL(/\/appliances$/);
  await page.getByRole('button', { name: 'Claim a Whombat' }).click();
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
});

test('first run with several Whombats on this network: straight to picking one', async ({ page }) => {
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await fake(page, 'nearby', ['fresh', 'contested']);
  await fake(page, 'existingOrg');
  await openSignInLink(page, await fake<string>(page, 'lastLink'));
  await expect(page.getByRole('heading', { name: 'Add your Whombat' })).toBeVisible();
  await page.goto('/appliances');
  await expect(page.getByRole('heading', { name: 'We found 2 Whombats on your network' })).toBeVisible();
});

test('a Whombat on the release before Link says “open …/claim”: sign in and claim', async ({ page }) => {
  await page.goto('/claim');
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  const link = await fake<string>(page, 'lastLink');
  expect(decodeURIComponent(link)).toContain('next=/claim');
  await fake(page, 'existingOrg');
  await openSignInLink(page, link);
  await expect(page).toHaveURL(/\/claim$/);
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
});

test('the one-use token is sent once, even under StrictMode', async ({ page }) => {
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = await fake<string>(page, 'lastLink');
  await openSignInLink(page, link);
  await expect(page.getByRole('heading', { name: 'Add your Whombat' })).toBeVisible();
  expect(await fake<number>(page, 'verifyCalls')).toBe(1);
});
