/**
 * Looks the assistant looked into (look-research-web.md AP-5905, AP-5906, AP-5909) as screenshot baselines
 * (`__screenshots__/looks.spec.ts/`), light and dark at 1440×900: the Inbox's rows for Home Assistant found with its
 * step, the hallway access point only Mara can fix and pve-02 being looked into; the step pressed (its thread opens, and
 * back in the Inbox the assistant is on it) and fixed (green; patched in the cache, the visual clock doesn't move on);
 * Home Assistant's Summary with its card. Their mock is the four desk cards John approved (Whombat look-research.md),
 * not one of the design references, so they were compared by eye when these were taken. The looks are the fixture world's (`whombat:fixture-looks`).
 */
import type { Page } from '@playwright/test';
import { expect, openApp, patchQueries, settle, THEMES, test } from './support/harness';

const HA = 'Zigbee stopped working in Home Assistant';

async function open(page: Page, theme: 'light' | 'dark', path: string) {
  await page.addInitScript(() => localStorage.setItem('whombat:fixture-looks', '1'));
  await openApp(page, { path, theme });
}

for (const theme of THEMES) {
  test(`Needs you: found, only you, looking (${theme})`, async ({ page }) => {
    await open(page, theme, '/inbox');
    const inbox = page.locator('[data-screen="inbox"]');
    // Each look is a row of the Inbox: one with its step, one only the person can fix, one being looked into.
    for (const [name, shot] of [
      [HA, 'found'],
      ['The hallway access point is offline', 'only-you'],
      ['pve-02 is running warm', 'looking'],
    ] as const) {
      const row = inbox.getByRole('article', { name });
      await row.waitFor();
      await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await settle(page);
      await expect(row).toHaveScreenshot(`needs-you-${shot}-${theme}.png`);
    }
  });

  test(`Needs you: the step pressed, then fixed (${theme})`, async ({ page }) => {
    await open(page, theme, '/inbox');
    const inbox = page.locator('[data-screen="inbox"]');
    await inbox.getByRole('article', { name: HA }).getByRole('button', { name: 'Restart Zigbee' }).click();
    // The step is taken in the look's thread, which opens; back in the Inbox its row says the assistant is on it.
    await page.waitForURL(/\/chat/);
    await page
      .getByRole('navigation', { name: 'Whombat' })
      .getByRole('link', { name: /^Inbox/ })
      .click();
    const ha = inbox.getByRole('article', { name: HA });
    await expect(ha).toHaveAttribute('data-research', 'fixing');
    await ha.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(page);
    await expect(ha).toHaveScreenshot(`needs-you-fixing-${theme}.png`);
    // The Inbox reads `needsYouList`; an older app's `needsYou` carries the same look.
    await patchQueries(
      page,
      'home.overview',
      (data, done) => {
        const fixed = (items?: { research?: { key: string } }[]) =>
          items?.map((i) =>
            i.research?.key === done.key ? { ...i, research: { ...i.research, ...done } } : i,
          );
        return { ...data, needsYou: fixed(data.needsYou), needsYouList: fixed(data.needsYouList) };
      },
      {
        key: 'connection:con_home-assistant',
        state: 'fixed',
        title: 'Zigbee works again',
        summary: 'I restarted Zigbee; the hallway lights and sensors answer again.',
      },
    );
    const fixed = inbox.getByRole('article', { name: 'Zigbee works again' });
    await fixed.waitFor();
    await fixed.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(page);
    await expect(fixed).toHaveScreenshot(`needs-you-fixed-${theme}.png`);
  });

  test(`Home Assistant’s Summary with its card (${theme})`, async ({ page }) => {
    await open(page, theme, '/things/connection%3Acon_home-assistant');
    const card = page.getByRole('region', { name: HA });
    await card.waitFor();
    await settle(page);
    await expect(page).toHaveScreenshot(`thing-${theme}.png`);
  });
}
