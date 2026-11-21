/**
 * Every Storybook story under Primitives/, Cards/ and Foundations/ as a screenshot baseline, light and dark
 * (`__screenshots__/stories.spec.ts/<story id>-<theme>.png`). The primitives and cards themselves are
 * compared with the mock in the screen specs and `cards.spec.ts`; these baselines pin every variant the
 * stories show (sizes, states, disabled, dark) so a primitive change shows up story by story.
 *
 * Storybook runs as a second web server of the visual project (`STORYBOOK_VISUAL_PORT`, default 6192).
 * One test per story title (read from the `*.stories.tsx` files); the test takes the title's story ids
 * from the running Storybook's `index.json`. Clock frozen, web fonts loaded, 1200×800.
 * Update with `pnpm visual --update-snapshots` and review the new PNGs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FROZEN_NOW, waitForWebFonts } from '@whombat/visual-tools';
import { expect, THEMES, test } from './support/harness';

const STORYBOOK = `http://localhost:${process.env.STORYBOOK_VISUAL_PORT || 6192}`;
const GROUPS = ['Primitives/', 'Cards/', 'Foundations/'];
const SRC = resolve(import.meta.dirname, '../src');

function storyFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return storyFiles(path);
    return entry.name.endsWith('.stories.tsx') ? [path] : [];
  });
}

/** Titles of the stories this spec covers, from each file's `title: '…'`. */
const TITLES = storyFiles(SRC)
  .map((file) => /\btitle:\s*'([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1])
  .filter((title): title is string => !!title && GROUPS.some((g) => title.startsWith(g)))
  .sort();

interface IndexEntry {
  id: string;
  title: string;
  type: string;
}

async function storyIds(title: string): Promise<string[]> {
  const res = await fetch(`${STORYBOOK}/index.json`);
  const index = (await res.json()) as { entries: Record<string, IndexEntry> };
  return Object.values(index.entries)
    .filter((e) => e.type === 'story' && e.title === title)
    .map((e) => e.id);
}

test.use({ viewport: { width: 1200, height: 800 } });

for (const title of TITLES) {
  for (const theme of THEMES) {
    test(`${title} stories (${theme})`, async ({ page }) => {
      const ids = await storyIds(title);
      expect(ids.length, `no stories for ${title} in ${STORYBOOK}/index.json`).toBeGreaterThan(0);
      await page.clock.setFixedTime(FROZEN_NOW);
      for (const id of ids) {
        await page.goto(`${STORYBOOK}/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
        await page.locator('#storybook-root > *').first().waitFor();
        await page.waitForLoadState('networkidle');
        await waitForWebFonts(page);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await expect.soft(page, id).toHaveScreenshot(`${id}-${theme}.png`);
      }
    });
  }
}
