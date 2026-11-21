/**
 * Signing in at the box's screen (BX-02…BX-06, signin-at-box-web.md AP-3508…AP-3512) against the fake world, whose box
 * shows its six letters through `screenSignIn`: from “Let this device in” (the pin stays the claim's) and from “Set up
 * this device” (the directory's identity, pinned with `screen` only after the box's tag; a lying directory stops it).
 */
import { expect, type Page, test } from '@playwright/test';
import { claimFresh, fake, fresh, type ScreenPanel, screenPanel, signIn, startFresh } from './support';

const REGISTRY = 'whombat:appliances:acc_mara';

async function setup(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  return claimFresh(page);
}

async function pinOf(page: Page, device: string): Promise<{ peerId: string; pinSource: string } | undefined> {
  return page.evaluate(
    ([key, d]) =>
      (
        JSON.parse(localStorage.getItem(key as string) ?? '{"appliances":[]}') as {
          appliances: { device: string; peerId: string; pinSource: string }[];
        }
      ).appliances.find((a) => a.device === d),
    [REGISTRY, device] as const,
  );
}

/** This browser forgets its key and every Whombat it knew (the cloud sign-in and the fake world stay). */
async function asNewBrowser(page: Page) {
  await page.evaluate(async () => {
    for (const k of Object.keys(localStorage))
      if (k.startsWith('whombat:appliances:')) localStorage.removeItem(k);
    await new Promise((r) => {
      const q = indexedDB.deleteDatabase('whombat-keys');
      q.onsuccess = q.onerror = q.onblocked = r;
    });
  });
}

/** “Use its screen”, “Show a code” (no email: the box is one person's, AP-5675): then the box's screen shows letters. */
async function askForCode(page: Page, device: string): Promise<ScreenPanel> {
  await page.getByRole('button', { name: 'Use its screen' }).click();
  await expect(page.getByRole('heading', { name: 'Use your Whombat’s screen' })).toBeVisible();
  await expect(page.getByLabel('Your email on this Whombat')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show a code' }).click();
  await expect(page.getByRole('heading', { name: 'Type the code from its screen' })).toBeVisible();
  const panel = await screenPanel(page, device);
  expect(panel).not.toBeNull();
  return panel as ScreenPanel;
}

const lettersField = (page: Page) => page.getByLabel('Letters on the screen');
/** The Whombat is open: its sidebar is there. */
const inTheApp = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });

test('Let this device in → Use its screen: a wrong code shows new letters, the right ones let it in', async ({
  page,
}) => {
  const c = await setup(page);
  const pinned = await pinOf(page, c.device);
  // This browser is removed, then set up again with a new key: pinned, not let in.
  const state = await fake<{ appliances: Record<string, { endpoints: Record<string, unknown> }> }>(
    page,
    'state',
  );
  await fake(page, 'revokeEndpoint', c.device, Object.keys(state.appliances[c.device]?.endpoints ?? {})[0]);
  await expect(page.getByRole('heading', { name: 'This device was removed' })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'Set up this device again' }).click();
  await expect(page.getByRole('heading', { name: 'Let this device in' })).toBeVisible({ timeout: 10_000 });

  const first = await askForCode(page, c.device);
  // The screen names whose device it is and which device asked (BX-06).
  expect(first.name).toContain('Mara');
  expect(first.device).not.toBe('');
  expect(first.code).toBe(`${first.letters.slice(0, 3)} ${first.letters.slice(3)}`);

  await lettersField(page).fill(first.letters === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA');
  await page.getByRole('button', { name: 'Let this device in' }).click();
  await expect(page.getByText('now shows new letters', { exact: false })).toBeVisible();
  const next = (await screenPanel(page, c.device)) as ScreenPanel;
  expect(next.letters).not.toBe(first.letters);

  // Typed in lower case with a space: shown grouped as the screen shows it.
  await lettersField(page).fill(
    `${next.letters.slice(0, 3).toLowerCase()} ${next.letters.slice(3).toLowerCase()}`,
  );
  await expect(lettersField(page)).toHaveValue(next.code);
  await page.getByRole('button', { name: 'Let this device in' }).click();
  await expect(inTheApp(page)).toBeVisible({ timeout: 15_000 });
  expect(await screenPanel(page, c.device)).toBeNull();
  // The pin is the claim's, as it was: nothing replaced it.
  expect(await pinOf(page, c.device)).toEqual(pinned);
});

test('Set up this device → Use its screen pins the identity with `screen` after the tag; a lying directory stops it', async ({
  page,
}) => {
  const c = await setup(page);
  const real = await fake<string>(page, 'peerOf', c.device);

  await asNewBrowser(page);
  await page.goto('/appliances');
  await page.getByRole('button', { name: 'Open Burrow HQ' }).click();
  await expect(page.getByRole('heading', { name: 'Set up this device' })).toBeVisible();
  const panel = await askForCode(page, c.device);
  expect(await pinOf(page, c.device)).toBeUndefined();
  await lettersField(page).fill(panel.letters);
  await page.getByRole('button', { name: 'Let this device in' }).click();
  await expect(inTheApp(page)).toBeVisible({ timeout: 15_000 });
  expect(await pinOf(page, c.device)).toMatchObject({ peerId: real, pinSource: 'screen' });

  // A directory that names another identity: the handshake can't reach that key, nothing is asked or pinned.
  await asNewBrowser(page);
  await fake(page, 'lieAbout', c.device, true);
  await page.goto(`/appliances/${c.device}/setup`);
  await page.getByRole('button', { name: 'Use its screen' }).click();
  await page.getByRole('button', { name: 'Show a code' }).click();
  await expect(page.getByText('whose screen you’re looking at', { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  expect(await screenPanel(page, c.device)).toBeNull();
  expect(await pinOf(page, c.device)).toBeUndefined();
});

/** Where the review screenshots go (`MANAGED_SHOTS_DIR`, default the repository's `tmp/shots`). */
const SHOTS = process.env.MANAGED_SHOTS_DIR ?? '../../tmp/shots';

for (const theme of ['light', 'dark'] as const)
  test(`screens: signing in at the box's screen beside the other ways in (${theme})`, async ({ page }) => {
    test.skip(!process.env.MANAGED_SHOTS, 'set MANAGED_SHOTS=1 to write review screenshots');
    await page.emulateMedia({ colorScheme: theme });
    const shot = (name: string) => page.screenshot({ path: `${SHOTS}/screen-signin-${theme}-${name}.png` });
    await fresh(page);
    await fake(page, 'reset');
    await page.reload();
    await signIn(page);
    await page.getByRole('button', { name: 'Claim a Whombat' }).click();
    const letters = (await fake<Record<string, { letters: string } | null>>(page, 'consoles')).fresh?.letters;
    await page.getByLabel('Enter the 4 letters from its screen').fill(letters as string);
    await page.getByRole('checkbox', { name: 'I agree to the Whombat Appliance Terms' }).check();
    await page.getByRole('button', { name: 'Claim it' }).click();
    await startFresh(page);
    await expect(page.getByRole('heading', { name: 'Protect your Whombat' })).toBeVisible();
    await shot('protect-step-2-of-3');
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 20_000 });
    await shot('connect-ai-step-3-of-3');
    await page.getByRole('button', { name: 'Later' }).click();
    await expect(inTheApp(page)).toBeVisible({ timeout: 20_000 });
    const device = (await fake<Record<string, { device: string }>>(page, 'cards')).fresh?.device as string;
    await page.goto('/settings?tab=appliance&section=backups');
    await expect(page.getByRole('region', { name: 'RECOVERY KIT' })).toBeVisible();
    await page.getByRole('region', { name: 'RECOVERY KIT' }).scrollIntoViewIfNeeded();
    await shot('settings-no-kit');

    // Pinned, not let in: “Let this device in” with the screen's row.
    const state = await fake<{ appliances: Record<string, { endpoints: Record<string, unknown> }> }>(
      page,
      'state',
    );
    await fake(page, 'revokeEndpoint', device, Object.keys(state.appliances[device]?.endpoints ?? {})[0]);
    await page.getByRole('button', { name: 'Set up this device again' }).click();
    await expect(page.getByRole('heading', { name: 'Let this device in' })).toBeVisible({ timeout: 10_000 });
    await shot('pair');
    await page.getByRole('button', { name: 'Have a recovery kit? Use it instead' }).click();
    await expect(page.getByRole('heading', { name: 'Use your recovery kit' })).toBeVisible();
    await shot('recover');
    await page.goBack();
    await page.getByRole('button', { name: 'Use its screen' }).click();
    await expect(page.getByRole('heading', { name: 'Use your Whombat’s screen' })).toBeVisible();
    await shot('screen-start');
    await page.getByRole('button', { name: 'Show a code' }).click();
    await expect(page.getByRole('heading', { name: 'Type the code from its screen' })).toBeVisible();
    await shot('screen-letters');
    const panel = (await screenPanel(page, device)) as ScreenPanel;
    await lettersField(page).fill(panel.letters.slice(0, 4));
    await shot('screen-letters-typing');
    await lettersField(page).fill(panel.letters === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA');
    await page.getByRole('button', { name: 'Let this device in' }).click();
    await expect(page.getByText('now shows new letters', { exact: false })).toBeVisible();
    await shot('screen-letters-wrong');
    await fake(page, 'noScreen', device, true);
    await page.getByRole('button', { name: 'Show a new code' }).click();
    await expect(page.getByText('no screen to show a code on', { exact: false })).toBeVisible();
    await shot('screen-stopped');

    // Not pinned: “Set up this device” with the screen as a way.
    await asNewBrowser(page);
    await page.goto(`/appliances/${device}/setup`);
    await expect(page.getByRole('heading', { name: 'Set up this device' })).toBeVisible();
    await shot('setup');
  });
