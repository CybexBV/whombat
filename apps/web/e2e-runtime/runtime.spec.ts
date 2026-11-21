import { expect, test } from '@playwright/test';

test('a browser signs in, sends a real turn, receives it over the encrypted session, and reconnects', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('/');
  await page.getByLabel('Name', { exact: true }).fill('Mara Okafor');
  await page.getByLabel('Email', { exact: true }).fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Chat', exact: true }).first().click();
  const composer = page.getByRole('textbox').first();
  await composer.fill('Please check invoice 8812 in this runtime smoke test.');
  await composer.press('Enter');
  await expect(
    page.getByText('Please check invoice 8812 in this runtime smoke test.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('On it.', { exact: false })).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText('On it.', { exact: false })).toBeVisible();
  expect(failures).toEqual([]);
});
