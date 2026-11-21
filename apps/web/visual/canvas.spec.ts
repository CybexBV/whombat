/**
 * The plan canvas (`/canvases/invoice-pdf-export-plan`) as screenshot baselines (`__screenshots__/canvas.spec.ts/`),
 * light and dark: at 1440×900 (comments column beside the article) and 1100×900 (below 1200px the comments stack under
 * the article, out of view).
 *
 * The app runs in fixture mode: the article is the live Tiptap editor on the Yjs document the seed builds from the
 * fixtures' Markdown, on a local hub where the agent is writing the third rule (its caret after "locale", the live
 * background and the "Neo is writing" tag come from its awareness state, `collab/fixture.ts`). Each comment thread's
 * Resolve button and "Reply…" box are hidden (docs/decisions/canvas-onboarding.md: not in the static mock).
 *
 * The mock's canvas is the crew's (drafted by Toffee, steps owned by Pippa, Banjo and Hazel, Toffee writing); the
 * one-agent plan has no step owners and the agent writes (Whombat one-agent.md OA-01; contracts CT-1109), so the screen
 * is pinned by baselines of its own, reviewed against the mock's canvas screen when taken (hermes-engine-app.md
 * AP-5102). Update with `pnpm visual --update-snapshots canvas.spec.ts` and review the PNGs.
 */
import type { Page } from '@playwright/test';
import { expect, neutraliseWorld, openApp, settle, THEMES, test } from './support/harness';

async function openCanvas(page: Page, theme: 'light' | 'dark', width: number): Promise<void> {
  await openApp(page, { path: '/canvases/invoice-pdf-export-plan', theme, width });
  await page.getByRole('heading', { name: 'Invoice PDF export', level: 1 }).waitFor();
  await page
    .getByText(/ is writing$/)
    .first()
    .waitFor();
  await page.locator('.canvas-caret').first().waitFor();
  await neutraliseWorld(page);
  await page.evaluate(() => {
    const hide = (el: Element | null | undefined) => {
      if (el instanceof HTMLElement) el.style.display = 'none';
    };
    for (const input of document.querySelectorAll('[aria-label="Reply to this thread"]'))
      hide(input.closest('form'));
    for (const button of document.querySelectorAll('button')) {
      if (button.textContent === 'Resolve' || button.textContent === 'Reopen') hide(button.parentElement);
    }
  });
  await settle(page);
}

for (const width of [1440, 1100]) {
  for (const theme of THEMES) {
    test(`plan canvas at ${width}px (${theme})`, async ({ page }) => {
      await openCanvas(page, theme, width);
      await expect(page).toHaveScreenshot(`canvas-${width}-${theme}.png`);
    });
  }
}
