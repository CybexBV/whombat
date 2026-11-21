/**
 * Search as screenshot baselines (`__screenshots__/search.spec.ts/`), light and dark: the mock's question with the
 * agent's answer and all results, and each type filter (Threads, Patches, Runs, Canvases). The app runs in fixture
 * mode, where `search.ask` answers the mock's question (`packages/fixtures/src/search.ts`).
 *
 * The mock's answer and results are the crew's (its agents' names, #billing-v2, “Post to #billing-v2”); the one-agent
 * world's are Neo's, the people's and the rooms' (Whombat one-agent.md OA-01, OA-04), so the screen is pinned by
 * baselines of its own, reviewed against the mock's search screen when taken (hermes-engine-app.md AP-5102).
 * Update with `pnpm visual --update-snapshots search.spec.ts` and review the PNGs.
 */
import { expect, neutraliseWorld, openApp, settle, THEMES, test } from './support/harness';

/** The question in the mock's search box (`query` in its initial state). */
const MOCK_QUESTION = 'have we seen this invoice rounding error before?';

const FILTERS = [
  { type: 'all', label: 'All' },
  { type: 'threads', label: 'Threads' },
  { type: 'patches', label: 'Patches' },
  { type: 'runs', label: 'Runs' },
  { type: 'canvases', label: 'Canvases' },
] as const;

for (const f of FILTERS) {
  for (const theme of THEMES) {
    test(`search, ${f.label} filter (${theme})`, async ({ page }) => {
      const type = f.type === 'all' ? '' : `&type=${f.type}`;
      await openApp(page, { path: `/search?q=${encodeURIComponent(MOCK_QUESTION)}${type}`, theme });
      await page.getByRole('textbox', { name: 'Search everything' }).waitFor();
      await page.getByText('answered from').waitFor();
      await neutraliseWorld(page);
      // The autofocused input's caret and focus ring.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settle(page);
      await expect(page).toHaveScreenshot(`search-${f.type}-${theme}.png`);
    });
  }
}
