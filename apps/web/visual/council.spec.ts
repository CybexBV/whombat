/**
 * The council's card in Chat as screenshot baselines (`__screenshots__/council.spec.ts/`), light and dark: the research
 * council at work (its members thinking), the login council building, and the Settings council finished, at 1440×900,
 * and the research council at a phone's width. There is no design reference for the council card, so these were compared
 * by eye with the mockup John approved when they were taken. The councils are the fixture world's
 * (`whombat:fixture-council`).
 */
import type { Page } from '@playwright/test';
import { expect, openApp, settle, THEMES, test } from './support/harness';

const THREADS = {
  research: 'msg_chat-council-nas',
  building: 'msg_chat-council-login',
  finished: 'msg_chat-council-settings',
} as const;

async function councilCard(page: Page, theme: 'light' | 'dark', thread: string, width = 1440) {
  await page.addInitScript(() => localStorage.setItem('whombat:fixture-council', '1'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page, { path: `/chat?thread=${thread}`, theme, width });
  const card = page.locator('[data-card="council"]').last();
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await settle(page);
  return card;
}

for (const theme of THEMES) {
  for (const [name, thread] of Object.entries(THREADS)) {
    test(`council card: ${name} (${theme})`, async ({ page }) => {
      const card = await councilCard(page, theme, thread);
      await expect(card).toHaveScreenshot(`council-${name}-${theme}.png`);
    });
  }

  test(`council card: research at a phone's width (${theme})`, async ({ page }) => {
    const card = await councilCard(page, theme, THREADS.research, 390);
    await expect(card).toHaveScreenshot(`council-research-phone-${theme}.png`);
  });
}
