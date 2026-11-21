// Visual regression: viewport screenshots of key pages in fixture mode,
// compared with the baselines in visual.spec.ts-snapshots/ (rendered in the
// pinned Playwright image, see playwright.config.ts). After an intended UI
// change, refresh them with `make visual-update` and review the diff.
import { expect, type Page, test } from '@playwright/test';

const PAGES: { name: string; path: string; ready: string | RegExp; light?: boolean }[] = [
  { name: 'overview', path: '/', ready: 'Capacity', light: true },
  { name: 'host-summary', path: '/servers/basalt', ready: 'All 27', light: true },
  { name: 'host-storage', path: '/servers/basalt?tab=storage', ready: '4 disks' },
  { name: 'proxmox-summary', path: '/servers/shale', ready: 'prod-pve' },
  { name: 'guests', path: '/guests', ready: 'every VM and container' },
  { name: 'alerts', path: '/alerts', ready: 'History' },
];

async function open(page: Page, path: string, ready: string | RegExp): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-11T14:00:08Z'));
  await page.goto(path);
  await expect(page.getByText(ready).first()).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

for (const p of PAGES) {
  test(`visual: ${p.name}`, async ({ page }) => {
    await open(page, p.path, p.ready);
    await expect(page).toHaveScreenshot(`${p.name}.png`, { animations: 'disabled', maxDiffPixelRatio: 0.003 });
  });
  if (p.light) {
    test(`visual: ${p.name} (light)`, async ({ page }, info) => {
      test.skip(info.project.name === 'mobile', 'light theme checked at desktop width');
      await page.emulateMedia({ colorScheme: 'light' });
      await open(page, p.path, p.ready);
      await expect(page).toHaveScreenshot(`${p.name}-light.png`, { animations: 'disabled', maxDiffPixelRatio: 0.003 });
    });
  }
}
