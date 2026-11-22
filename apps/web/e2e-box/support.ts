/**
 * Helpers for the box's own page (AP-5430): the box target against the fake world's community box, driven through
 * `window.__WHOMBAT_FAKE__` like the managed journeys.
 */
import { expect, type Page } from '@playwright/test';

/** The fake world's community box (its device id there). */
export const COMMUNITY = 'dev_2CMTY8WB';

export function fake<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([name, rest]) => {
      const faults = (window as unknown as { __WHOMBAT_FAKE__: Record<string, (...a: unknown[]) => unknown> })
        .__WHOMBAT_FAKE__;
      return faults[name as string]?.(...(rest as unknown[])) as never;
    },
    [fn, args] as const,
  );
}

/** A new world: nobody claimed the box, this browser has no key. */
export async function fresh(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    indexedDB.deleteDatabase('whombat-keys');
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Claim your Whombat' })).toBeVisible({ timeout: 20_000 });
}

/** Another browser on the same box: this one forgets its key and record, the world (the box) stays. */
export async function anotherBrowser(page: Page, url = '/'): Promise<void> {
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k !== 'whombat:fake-world') localStorage.removeItem(k);
    indexedDB.deleteDatabase('whombat-keys');
  });
  await page.goto('about:blank');
  await page.goto(url);
}

/** The setup up to Reach it from anywhere: the letters from the box's screen, then who you are. */
export async function claim(
  page: Page,
  who = { name: 'Mara Visser', email: 'mara@lumio.example.org' },
): Promise<void> {
  const letters = await fake<string>(page, 'communityLetters');
  await page.getByLabel('Letters').fill(letters);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Who are you?' })).toBeVisible();
  await page.getByLabel('Your name').fill(who.name);
  await page.getByLabel('Email').fill(who.email);
  await page.getByRole('button', { name: 'Claim it' }).click();
  await expect(page.getByRole('heading', { name: 'Reach it from anywhere' })).toBeVisible({
    timeout: 20_000,
  });
}

/** The setup after the claim, Tailscale, Link and the AI left for later (no backups step): ends in the app. */
export async function finishSetup(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('STEP 4 OF 4')).toBeVisible();
  await page.getByRole('button', { name: 'Later' }).click();
  await inTheApp(page);
}

/** The whole setup, everything optional skipped: ends in the app. */
export async function setUp(page: Page): Promise<void> {
  await fresh(page);
  await claim(page);
  await finishSetup(page);
}

export async function inTheApp(page: Page): Promise<void> {
  await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 30_000 });
}
