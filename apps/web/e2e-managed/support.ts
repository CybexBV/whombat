/**
 * Helpers for the managed journeys (AP-15): the hosted UI in session mode against the in-browser fake world
 * (`src/managed/fake/world.ts`), driven through `window.__WHOMBAT_FAKE__`.
 */
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export interface Card {
  device: string;
  secret: string;
  /** The older QR text (`WHOMBAT1:…`). */
  qr: string;
  /** What the card's QR code encodes: `/claim#v=1&d=…&p=…&s=…`. */
  link: string;
}

export type Box = 'fresh' | 'used' | 'contested' | 'mismatched' | 'spare';
export type Cards = Record<Box, Card>;

/** What a box's console shows (CC-08, CC-13): only its four letters; null once claimed. */
export interface Console {
  code: string;
  letters: string;
}

/** Runs `fn` against the fake world's faults in the page. */
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

export async function fresh(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => 'IndexedDB' in window || true);
  await page.evaluate(() => {
    localStorage.clear();
    indexedDB.deleteDatabase('whombat-keys');
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
}

/**
 * Signs in as an account with an organization from before Whombat Link (the hosted list's Whombats; LNK-35 phase 1)
 * and waits on the list. Nothing is on this network while the list looks, so an organization without Whombats stays on
 * the list instead of going straight to the claim (AP-75); then `nearby` (the fresh box by default) is back on the
 * network for the claim.
 */
export async function signIn(page: Page, { nearby = ['fresh'] }: { nearby?: Box[] } = {}): Promise<void> {
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await fake(page, 'nearby', []);
  await fake(page, 'existingOrg');
  const link = await fake<string>(page, 'lastLink');
  expect(link).toMatch(/^\/auth\/verify#token=/);
  await page.goto(link);
  const list = page.getByRole('heading', { name: 'Pick a Whombat' });
  const account = page.getByRole('heading', { name: 'Your Whombats' });
  await expect(list.or(account)).toBeVisible();
  // From the start page a sign-in lands on Your Whombats; the hosted list is one click on.
  if (await account.isVisible()) await page.getByRole('button', { name: 'Open a Whombat here' }).click();
  await expect(list).toBeVisible();
  // The list is shown once the look is done.
  await expect(
    page.getByText('No Whombats yet.', { exact: false }).or(page.getByRole('button', { name: /^Open / })),
  ).toBeVisible();
  await fake(page, 'nearby', nearby);
}

export async function cards(page: Page): Promise<Cards> {
  return fake<Cards>(page, 'cards');
}

/** What the boxes' consoles show now (the letters rotate after a wrong try). */
export async function consoles(page: Page): Promise<Record<Box, Console | null>> {
  return fake<Record<Box, Console | null>>(page, 'consoles');
}

/** Ticks “I agree to the Whombat Appliance Terms” (LC-18): the claim button stays disabled until then. */
export async function agreeToTerms(page: Page): Promise<void> {
  await page.getByRole('checkbox', { name: 'I agree to the Whombat Appliance Terms' }).check();
}

/** Right after a claim, “Is this a new Whombat?” (backup-options.md AP-6830): a new one, Continue. */
export async function startFresh(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Is this a new Whombat?' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('radio', { name: /^Start fresh/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
}

/**
 * After a claim: Start fresh, then “Connect your AI” (Whombat first-day.md), Later; the Whombat opens next (no backups
 * step: Needs you proposes a place; no kit, BX-01).
 */
export async function skipToApp(page: Page): Promise<void> {
  await startFresh(page);
  await skipConnectAi(page);
}

/** “Connect your AI” (CLAIM · STEP 2 OF 2), Later: the Whombat opens with the line that the assistant can't work yet. */
export async function skipConnectAi(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Later' }).click();
}

/**
 * Claims the fresh appliance the way most people will (CC-09): it is found on this network, so its four letters
 * are enough; Connect your AI skipped; ends in the burrow app (the claim has no kit step any more, BX-01).
 */
export async function claimFresh(page: Page): Promise<Card> {
  const c = (await cards(page)).fresh;
  await page.getByRole('button', { name: 'Claim a Whombat' }).click();
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
  const screen = (await consoles(page)).fresh as Console;
  await page.getByLabel('Enter the 4 letters from its screen').fill(screen.letters);
  await agreeToTerms(page);
  await page.getByRole('button', { name: 'Claim it' }).click();
  await skipToApp(page);
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
  return c;
}

/**
 * Makes the recovery kit as you do from Settings · This Whombat (“Make a kit”, BX-01): downloaded and
 * confirmed; back in the burrow app.
 */
export async function makeKit(page: Page, device: string): Promise<{ recoveryKey: string; kitText: string }> {
  await page.goto(`/appliances/${device}/recovery-kit`);
  const text = await saveKitAsFile(page);
  const key = recoveryKeyOf(text);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
  return { recoveryKey: key, kitText: text };
}

/** The recovery key a kit's text carries (the line after “Recovery key:”). */
export function recoveryKeyOf(kitText: string): string {
  const lines = kitText.split('\n');
  return lines[lines.indexOf('Recovery key:') + 1] as string;
}

/**
 * “Keep a way back in” (backup-options.md AP-6820) as a file only (no authenticator, no printer here): the kit's
 * text as downloaded; the box is told it is saved.
 */
export async function saveKitAsFile(page: Page): Promise<string> {
  await expect(page.getByRole('heading', { name: 'Keep a way back in' })).toBeVisible();
  const passkey = page.getByRole('checkbox', { name: /^Your passkey/ });
  if (await passkey.isVisible()) await passkey.uncheck();
  await page.getByRole('checkbox', { name: /^Print it too/ }).uncheck();
  await page.getByRole('checkbox', { name: /^Save as a file/ }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
  return readFileSync((await download.path()) as string, 'utf8');
}

/** The claim, then a kit made from Settings: for the journeys that need one (recovery, rotation). */
export async function claimAndSaveKit(page: Page): Promise<Card & { recoveryKey: string; kitText: string }> {
  const c = await claimFresh(page);
  return { ...c, ...(await makeKit(page, c.device)) };
}

/** What the box's screen shows while a device signs in there (BX-06), or null. */
export interface ScreenPanel {
  code: string;
  letters: string;
  name: string;
  device: string;
  expiresAt: string;
}

export async function screenPanel(page: Page, device: string): Promise<ScreenPanel | null> {
  return fake<ScreenPanel | null>(page, 'screenSignIn', device);
}
