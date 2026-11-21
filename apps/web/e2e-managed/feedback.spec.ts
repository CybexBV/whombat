/**
 * Website feedback on a managed Whombat (AP-105, Whombat FD-25 … FD-37) on the fake world: with the drop, the
 * integration shows the snippets from the embed origin with the site key and the delivery through Whombat's cloud,
 * and you switch intake on; without it (the cloud connection can't carry the drop), AP-102's notice and a
 * switch that can't be turned on. Screenshots for review, light and dark at 1440×900, in `tmp/visual/feedback-drop/`
 * (`FEEDBACK_SHOTS_DIR`).
 */
import { expect, type Page, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

const SHOTS = process.env.FEEDBACK_SHOTS_DIR ?? '../../tmp/visual/feedback-drop';

async function openIntegration(page: Page) {
  await page.goto('/burrow-hq/settings?tab=connections&connection=feedback');
  await page.getByRole('link', { name: 'Open Billing portal' }).click();
  // The integration's own page (AP-400), no longer a modal.
  const view = page.locator('[data-screen="feedback-integration"]');
  await expect(view.getByText('HEALTH', { exact: true })).toBeVisible();
  return view;
}

for (const theme of ['light', 'dark'] as const)
  test(`feedback integration on a managed Whombat (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await fresh(page);
    await fake(page, 'reset');
    await page.reload();
    await signIn(page);
    const { device } = await claimAndSaveKit(page);

    const view = await openIntegration(page);
    const basic = view.locator('pre').first();
    await expect(basic).toContainText('src="https://embed.whombat.com/embed/v1/widget.js"');
    await expect(basic).toContainText(/data-key="fbk_[A-Za-z0-9_-]{22}"/);
    await expect(view.getByText('Delivery', { exact: true })).toBeVisible();
    await expect(view.getByText('Widget address')).toBeVisible();
    await expect(view.locator('[data-feedback-managed]')).toHaveCount(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/managed-integration-${theme}.png` });
    await view.getByText('INSTALL', { exact: true }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/managed-integration-install-${theme}.png` });

    // You switch intake off and on again.
    const intake = view.getByRole('switch', { name: 'Accept reports' });
    await intake.click();
    await expect(page.getByText('Billing portal stopped accepting reports.')).toBeVisible();
    await intake.click();
    await expect(page.getByText('Billing portal accepts reports again.')).toBeVisible();

    // Without the drop: the notice, no snippets, and intake can't be switched on.
    await fake(page, 'feedbackDrop', device, 'unsupported');
    await page.reload();
    const unsupported = await openIntegration(page);
    await expect(unsupported.locator('[data-feedback-managed]')).toBeVisible();
    await expect(unsupported.locator('pre')).toHaveCount(0);
    await expect(
      unsupported.getByText('Feedback needs an update of this Whombat’s cloud connection.'),
    ).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/managed-integration-unsupported-${theme}.png` });
  });
