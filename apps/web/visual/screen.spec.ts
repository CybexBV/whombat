/**
 * Settings → Screen as screenshot baselines (`__screenshots__/screen.spec.ts/`), light and dark: its mockup
 * (`desk-calm-glance/settings.html` of the appliance's desk-calm work) isn't one of the design references, so it was
 * compared by eye when these were taken. What it shows at 1440×900 (the preview beside the choices) and at 728 px (the
 * preview on top); the preview in *Something’s wrong* and *Neo at work*; Lock and PIN, Night and Talk. The screen is
 * picked before the page loads (`whombat:fixture-desk`, `deskFixtures.ts`): the Z13 with Mara's PIN and choices
 * (`pinned`). Each shot is the tab or the preview alone, so what changes elsewhere on the page doesn't move them.
 */
import type { Page } from '@playwright/test';
import { expect, openApp, settle, THEMES, test } from './support/harness';

async function open(page: Page, theme: 'light' | 'dark', query = '', width = 1440) {
  await page.addInitScript(() => localStorage.setItem('whombat:fixture-desk', 'pinned'));
  await openApp(page, { path: `/settings?tab=screen${query}`, theme, width });
  await page.locator('[data-screen-tab]').waitFor();
}

/** Settings scrolls inside its page: the window grows to the whole tab, so its shot isn't cut at the fold. */
async function wholeTab(page: Page) {
  const tab = page.locator('[data-screen-tab]');
  const box = await tab.boundingBox();
  const width = page.viewportSize()?.width ?? 1440;
  if (box) await page.setViewportSize({ width, height: Math.ceil(box.y + box.height + 56) });
  await settle(page);
  return tab;
}

for (const theme of THEMES) {
  test(`What it shows (${theme})`, async ({ page }) => {
    await open(page, theme);
    await page.getByRole('img', { name: /^Preview: All fine/ }).waitFor();
    await expect(await wholeTab(page)).toHaveScreenshot(`shows-${theme}.png`);
  });

  test(`What it shows at 728 px (${theme})`, async ({ page }) => {
    await open(page, theme, '', 728);
    await page.getByRole('img', { name: /^Preview: All fine/ }).waitFor();
    await expect(await wholeTab(page)).toHaveScreenshot(`shows-728-${theme}.png`);
  });

  for (const [scenario, says] of [
    ['Something’s wrong', /wrong/],
    ['Neo at work', /busy/],
  ] as const) {
    test(`the preview: ${scenario} (${theme})`, async ({ page }) => {
      await open(page, theme);
      const card = page.locator('[data-preview-card]');
      await card.getByText(scenario, { exact: true }).click();
      await card.getByRole('img', { name: says }).waitFor();
      await settle(page);
      await expect(card).toHaveScreenshot(
        `preview-${scenario.startsWith('Neo') ? 'busy' : 'wrong'}-${theme}.png`,
      );
    });
  }

  for (const part of ['lock', 'night', 'talk'] as const) {
    test(`${part} (${theme})`, async ({ page }) => {
      await open(page, theme, `&part=${part}`);
      await page.locator(`[data-screen-part="${part}"]`).waitFor();
      await expect(await wholeTab(page)).toHaveScreenshot(`${part}-${theme}.png`);
    });
  }
}
