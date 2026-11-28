/**
 * The pictures in the repository's README (`docs/readme/`), taken from the demo world: the web app in fixture mode
 * (`VITE_FIXTURES=1` and the worlds `playwright.config.ts` turns on for the `readme` project), never a real box, so
 * nobody's names, addresses or mail can end up in them. Light and dark, with the clock frozen like the visual suite's.
 * `pnpm readme:shots` takes them all again; `README_SHOTS=<dir>` writes them somewhere else. Not baselines: nothing
 * compares them, so a changed screen only needs the command run again and the pictures looked at before committing.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Locator, type Page, test } from '@playwright/test';
import { FROZEN_NOW, REPO_ROOT, waitForWebFonts } from '@whombat/visual-tools';

const DIR = process.env.README_SHOTS ? resolve(REPO_ROOT, process.env.README_SHOTS) : '';
type Theme = 'light' | 'dark';
const THEMES: readonly Theme[] = ['light', 'dark'];

interface Shot {
  name: string;
  path: string;
  width?: number;
  height?: number;
  /** Phones are drawn at twice the size, so they stay sharp when the README shows them small. */
  phone?: boolean;
  /** One picture only: the screen is dark in both themes. */
  themes?: readonly Theme[];
  prepare?: (page: Page) => Promise<void>;
}

/** Scroll the nearest scrolling box around `inside` to its top, so a thread starts at its question. */
async function scrollToTop(inside: Locator) {
  await inside.evaluate((el) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node);
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
        node.scrollTop = 0;
        return;
      }
    }
  });
}

const SHOTS: Shot[] = [
  {
    // The first picture: a question in Chat, the assistant's short answer and the approval it asks for.
    name: 'chat',
    path: '/chat?thread=msg_chat-pve-memory',
    height: 960,
    prepare: async (page) => {
      const card = page.getByRole('button', { name: 'Yes, tonight' }).first();
      await card.waitFor();
      await scrollToTop(card);
    },
  },
  {
    name: 'servers',
    path: '/servers',
    prepare: (page) => page.getByRole('heading', { name: 'blackbox' }).first().waitFor(),
  },
  {
    name: 'automations',
    path: '/automations',
    prepare: (page) => page.getByText('Suspected bug', { exact: true }).first().waitFor(),
  },
  {
    name: 'service',
    path: '/things/connection%3Acon_plex',
    prepare: (page) => page.getByText('Now playing').first().waitFor(),
  },
  {
    name: 'watches',
    path: '/things/connection%3Acon_plex?tab=settings',
    prepare: async (page) => {
      const heading = page.getByText('What Whombat watches', { exact: true }).first();
      await heading.waitFor();
      await page.getByText('Plex updates', { exact: true }).first().scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'screen',
    path: '/use-as-screen?as=office',
    width: 1280,
    height: 800,
    themes: ['dark'],
    prepare: (page) => page.getByText('All fine').first().waitFor(),
  },
  {
    name: 'phone-chat',
    path: '/chat',
    width: 390,
    height: 844,
    phone: true,
    prepare: (page) => page.getByText('Why is pve-02 using so much memory?').first().waitFor(),
  },
  {
    name: 'phone-thread',
    path: '/chat?thread=msg_chat-pve-memory',
    width: 390,
    height: 844,
    phone: true,
    prepare: (page) => page.getByRole('button', { name: 'Yes, tonight' }).first().waitFor(),
  },
];

for (const shot of SHOTS)
  for (const theme of shot.themes ?? THEMES)
    test(`${shot.name} (${theme})`, async ({ browser }) => {
      test.skip(!DIR, 'run `pnpm readme:shots` (README_SHOTS=<dir>) to take the README pictures');
      const context = await browser.newContext({
        viewport: { width: shot.width ?? 1440, height: shot.height ?? 900 },
        deviceScaleFactor: shot.phone ? 2 : 1,
        isMobile: !!shot.phone,
        hasTouch: !!shot.phone,
        colorScheme: theme,
        reducedMotion: 'reduce',
        timezoneId: 'Europe/Amsterdam',
        locale: 'en-GB',
      });
      const page = await context.newPage();
      await page.addInitScript((t) => localStorage.setItem('whombat:theme', t), theme);
      await page.clock.setFixedTime(FROZEN_NOW);
      await page.goto(shot.path);
      await shot.prepare?.(page);
      await page.waitForLoadState('networkidle');
      await waitForWebFonts(page);
      await page.mouse.move(0, 0);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(400);
      const name = (shot.themes ?? THEMES).length > 1 ? `${shot.name}-${theme}` : shot.name;
      await mkdir(DIR, { recursive: true });
      await writeFile(`${DIR}/${name}.png`, await page.screenshot({ animations: 'disabled', caret: 'hide' }));
      await context.close();
    });
