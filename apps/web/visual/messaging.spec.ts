/**
 * The branch room (`/pr/482`) as screenshot baselines (`__screenshots__/messaging.spec.ts/`), light and dark:
 * Conversation, Files changed and the overlay pane below 1240px (1200px). Message and thread columns are scrolled to the
 * top before the shot (the app opens a conversation at its newest message).
 *
 * The mock's branch room is the crew's (opened by Banjo, Hazel's review, role titles, agents beside the people) and its
 * channels and DMs went with one agent (one-agent.md AP-4957); the one-agent room is Neo's and the people's (Whombat
 * one-agent.md OA-01, OA-04), so it is pinned by baselines of its own, reviewed against the mock's branch room when taken
 * (hermes-engine-app.md AP-5102). Its chat cards are still compared with the mock's in `cards.spec.ts`. Update with
 * `pnpm visual --update-snapshots messaging.spec.ts` and review the PNGs.
 */
import { expect, neutraliseWorld, openApp, settle, THEMES, test } from './support/harness';

const STATES = [
  { name: 'branch-conversation', path: '/pr/482' },
  { name: 'branch-files', path: '/pr/482?tab=files' },
  { name: 'branch-overlay-1200', path: '/pr/482', width: 1200 },
] as const;

for (const s of STATES) {
  for (const theme of THEMES) {
    test(`${s.name} (${theme})`, async ({ page }) => {
      const width = 'width' in s ? s.width : 1440;
      await openApp(page, { path: s.path, theme, width });
      await page.locator('[data-conversation-scroll]').waitFor();
      await page
        .getByRole('article')
        .first()
        .or(page.getByRole('list', { name: 'Files changed' }))
        .waitFor();
      await neutraliseWorld(page);
      await settle(page);
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-conversation-scroll], [data-thread-scroll]')) {
          el.scrollTop = 0;
        }
      });
      await settle(page, 150);
      await expect(page).toHaveScreenshot(`${s.name}-${theme}.png`);
    });
  }
}
