/**
 * Whombat Feedback (docs/decisions/feedback.md; not in the mocks), as screenshot baselines
 * (`__screenshots__/feedback.spec.ts/`), light and dark, 1440×900, fixture mode:
 * - Website feedback, a connection's page (Overview → Website feedback): the integration list; the integration's page (status and health, then scrolled to the
 *   installation snippets, and to the widget settings with pages visited and reporter sign-in, AP-434); New
 *   integration's first step (docs/decisions/ui-improvements.md AP-400);
 * - the list at a narrow window (760px wide), light only;
 * - the report card with its details open (cards harness, `report` state): a verified reporter and the pages before
 *   reporting (CT-161, CT-162).
 * The collapsed report card states (assessed, queued, failed, content removed, feature request) are story
 * baselines (`stories.spec.ts`, Cards/Chat cards). They follow the nearest patterns (B-05): Settings' row cards,
 * the pack/memory modal, the automation editor's fields and the chat cards (FB-C01…).
 *
 * Fixture mode does not serve `repos.list` (it 404s there), so it is seeded with the fixture world's repos
 * once the page asks for it.
 */
import type { Page } from '@playwright/test';
import { REPOS } from '@whombat/fixtures';
import { FROZEN_NOW } from '@whombat/visual-tools';
import { expect, neutraliseWorld, openApp, seedQueries, settle, THEMES, test } from './support/harness';

async function openFeedback(page: Page, theme: 'light' | 'dark', width = 1440) {
  await openApp(page, { path: '/connections?connection=feedback', theme, width });
  await page.getByRole('heading', { name: 'Website feedback', level: 2 }).waitFor();
  await neutraliseWorld(page);
  await page.getByText('Billing portal').waitFor();
  await settle(page);
}

async function openIntegration(page: Page) {
  await page.getByRole('link', { name: 'Open Billing portal' }).click();
  const view = page.locator('[data-screen="feedback-integration"]');
  await view.getByText('HEALTH', { exact: true }).waitFor();
  await seedQueries(page, 'repos.list', { repos: REPOS, githubConnected: true });
  await view.locator('option', { hasText: 'whombat/billing' }).first().waitFor({ state: 'attached' });
  await settle(page);
  return view;
}

for (const theme of THEMES) {
  test(`settings, Feedback list (${theme})`, async ({ page }) => {
    await openFeedback(page, theme);
    await expect(page).toHaveScreenshot(`feedback-list-${theme}.png`);
  });

  test(`settings, Feedback integration (${theme})`, async ({ page }) => {
    await openFeedback(page, theme);
    const view = await openIntegration(page);
    await expect(page).toHaveScreenshot(`feedback-integration-${theme}.png`);
    await view.getByText('INSTALL', { exact: true }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await settle(page);
    await expect(page).toHaveScreenshot(`feedback-integration-install-${theme}.png`);
    const method = view.getByRole('combobox', { name: 'INSTALLATION METHOD' });
    await expect(view.locator('pre')).toHaveCount(1);
    expect((await method.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await method.selectOption('custom');
    await expect(view.locator('pre')).toHaveCount(1);
    await expect(view.locator('pre')).toContainText(
      '<button type="button" data-whombat-feedback>Feedback</button>',
    );
    await expect(view.locator('pre')).not.toContainText('Report a problem');
    await settle(page);
    await expect(page).toHaveScreenshot(`feedback-integration-install-custom-${theme}.png`);
  });

  test(`settings, Feedback integration widget settings (${theme})`, async ({ page }) => {
    await openFeedback(page, theme);
    const view = await openIntegration(page);
    await view
      .getByText('THE FORM ON YOUR WEBSITE', { exact: true })
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await view.getByText('REPORTER SIGN-IN', { exact: true }).waitFor();
    await settle(page);
    await expect(page).toHaveScreenshot(`feedback-integration-widget-${theme}.png`);
  });

  test(`settings, Feedback new integration (${theme})`, async ({ page }) => {
    await openFeedback(page, theme);
    await page.getByRole('link', { name: 'New integration' }).click();
    await page.getByLabel('ALLOWED ORIGINS', { exact: true }).waitFor();
    await settle(page);
    await expect(page).toHaveScreenshot(`feedback-new-${theme}.png`);
  });

  test(`report row with details (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.clock.setFixedTime(FROZEN_NOW);
    await page.goto(`/visual/cards.html?theme=${theme}&states=report`);
    // The report's row (docs/decisions/report-rows.md RR-02), opened: the whole card with its details under it.
    const card = page.locator('[data-state="report"] [data-card="report"][data-variant="line"]');
    await card.getByRole('button', { name: 'Details' }).click();
    await card.getByText('WHAT THEY SENT').waitFor();
    await card.getByText('billing/pdf/format.ts:88').waitFor();
    await settle(page);
    await expect(card).toHaveScreenshot(`report-details-${theme}.png`);
  });
}

test('settings, Feedback list at 760px (light)', async ({ page }) => {
  await openFeedback(page, 'light', 760);
  await expect(page).toHaveScreenshot('feedback-list-narrow-light.png');
});
