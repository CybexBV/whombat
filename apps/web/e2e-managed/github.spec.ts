/**
 * GitHub on a managed Whombat (Whombat essentials item 6; contracts CT-181; AP-493…AP-495): there is no host to run gh
 * on, so you sign in to GitHub with your own account — GitHub's device code, through the appliance session —
 * then connect it for the burrow; the sign-in sits under the connection with Sign out.
 */
import { expect, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

test('you sign in to GitHub with the device code, then connect it', async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  await claimAndSaveKit(page);

  await page.goto('/settings?tab=connections&connection=github');
  await expect(page.getByText('Sign in with your GitHub account and', { exact: false })).toBeVisible();
  await expect(page.getByText('gh auth login')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in to GitHub' }).click();
  const flow = page.getByRole('region', { name: 'GitHub sign-in' });
  await expect(flow.getByText('Enter this code')).toBeVisible();
  await expect(flow.getByRole('link', { name: /Open github\.com/ })).toHaveAttribute(
    'href',
    'https://github.com/login/device',
  );
  if (process.env.W3_SHOTS)
    await page.screenshot({ path: `${process.env.W3_SHOTS}/managed-github-device-code.png` });

  // The fake's device code completes on the third poll (3 s apart); signed in, the burrow connects by itself (AP-543).
  await expect(page.getByText('@maraokafor', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/^Connected\. .+ as @maraokafor\.$/)).toBeVisible();

  // Your own sign-in sits under the connection, with Sign out (AP-550).
  await expect(page.getByText('Signed in as @maraokafor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out (GitHub)' })).toBeVisible();
});
