/**
 * Claim with the letters on the screen of a Whombat on this network, and the claim errors (CC-09, CC-13, AP-47, AP-50);
 * kept for a Whombat on the release before Whombat Link, whose card claim went (LNK-35). No recovery kit at the claim (BX-01): Settings keeps “Make a kit”, quietly.
 */
import { expect, type Page, test } from '@playwright/test';
import {
  agreeToTerms,
  type Box,
  type Console,
  claimFresh,
  consoles,
  fake,
  fresh,
  signIn,
  startFresh,
} from './support';

test.beforeEach(async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
});

const screenOf = async (page: Page, box: Box) => (await consoles(page))[box] as Console;
const lettersField = (page: Page) => page.getByLabel('Enter the 4 letters from its screen');
/** “Claim it”, after ticking the appliance terms (LC-18). */
const claimIt = (page: Page) => ({
  click: async () => {
    await agreeToTerms(page);
    await page.getByRole('button', { name: 'Claim it' }).click();
  },
});
const noneHeading = (page: Page) => page.getByRole('heading', { name: 'We couldn’t find your Whombat' });
const lookAgain = (page: Page) => page.getByRole('button', { name: 'Look again' });

/** Nearby finds these boxes (none with `[]`), then the claim page opens. */
async function openClaim(page: Page, nearby: Box[] = ['fresh']) {
  await fake(page, 'nearby', nearby);
  await page.getByRole('button', { name: 'Claim a Whombat' }).click();
}

test('found on this network: the four letters claim it, then Protect and straight into the burrow (no kit)', async ({
  page,
}) => {
  const c = await claimFresh(page);
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Save your recovery kit' })).toHaveCount(0);
  // Claimed: the console has no code any more.
  expect((await consoles(page)).fresh).toBeNull();
  await page.goto('/appliances');
  await expect(page.getByRole('button', { name: 'Open Burrow HQ' })).toBeVisible();
  expect(c.device).toBe('dev_7KQ2M4XD');
});

test('the found box shows its model and id; letters are taken in any case and spacing', async ({ page }) => {
  await openClaim(page);
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
  const box = page.getByRole('list', { name: 'Whombat on your network' });
  await expect(box).toContainText('wb-mini-1');
  await expect(box).toContainText('dev_7KQ2M4XD');
  await expect(page.getByText('The 4 letters on its screen, like KXQM.')).toBeVisible();
  const { code, letters } = await screenOf(page, 'fresh');
  // The console shows only the four letters (CC-13).
  expect(code).toBe(letters);
  expect(code).toMatch(/^[A-Z]{4}$/);
  await lettersField(page).fill(`${letters.slice(0, 2).toLowerCase()} ${letters.slice(2).toLowerCase()}`);
  await expect(lettersField(page)).toHaveValue(letters);
  await claimIt(page).click();
  await startFresh(page);
  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('CLAIM · STEP 2 OF 2')).toBeVisible();
});

test('no kit is a quiet row in Settings; “Make a kit” makes one for a box without a screen', async ({
  page,
}) => {
  const c = await claimFresh(page);
  // Nothing reminds you of a kit any more (BX-01).
  await expect(page.getByText('Recovery kit not saved')).toHaveCount(0);
  // The kit's row is for a Whombat from before the passkey; on a newer one the passkey holds the backups' key.
  await fake(page, 'beforePasskey', c.device);
  await page.goto('/settings?tab=appliance&section=backups');
  const kit = page.getByRole('region', { name: 'RECOVERY KIT' });
  await expect(kit.getByText('No recovery kit')).toBeVisible();
  await expect(kit.getByText('your Whombat’s screen lets a device in', { exact: false })).toBeVisible();
  await kit.getByRole('button', { name: 'Make a kit' }).click();
  await expect(page).toHaveURL(new RegExp(`/appliances/${c.device}/recovery-kit$`));
  await expect(page.getByText('RECOVERY KIT', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Keep a way back in' })).toBeVisible();
});

test('wrong letters: refused, the Whombat shows new ones, and those work', async ({ page }) => {
  await openClaim(page);
  const before = await screenOf(page, 'fresh');
  const wrong = before.letters === 'WXYA' ? 'WXYB' : 'WXYA';
  await lettersField(page).fill(wrong);
  await claimIt(page).click();
  await expect(page.getByText('That code isn’t right. Your Whombat now shows a new one.')).toBeVisible();
  const after = await screenOf(page, 'fresh');
  expect(after.letters).not.toBe(before.letters);
  expect(after.code).toBe(after.letters);
  await lettersField(page).fill(after.letters);
  await claimIt(page).click();
  await startFresh(page);
  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 20_000 });
});

test('too many wrong codes: the Whombat waits, and says for how long', async ({ page }) => {
  await openClaim(page);
  await fake(page, 'claimBackoff', 'dev_7KQ2M4XD', 150);
  await lettersField(page).fill((await screenOf(page, 'fresh')).letters);
  await claimIt(page).click();
  await expect(page.getByText('Too many wrong codes. Try again in 3 min.')).toBeVisible();
  const state = await fake<{ appliances: Record<string, { claimedBy: string | null }> }>(page, 'state');
  expect(state.appliances.dev_7KQ2M4XD?.claimedBy).toBeNull();
});

test('nothing on this network: we couldn’t find it; look again once this device is on its network', async ({
  page,
}) => {
  await openClaim(page, []);
  await expect(noneHeading(page)).toBeVisible();
  await expect(
    page.getByText(
      'Your phone or computer has to be on the same network as your Whombat, and the Whombat has to be online: its screen shows 4 letters.',
    ),
  ).toBeVisible();
  // No code field any more: a code claim works only from the Whombat's network.
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await lookAgain(page).click();
  await expect(noneHeading(page)).toBeVisible();
  await fake(page, 'nearby', ['fresh']);
  await lookAgain(page).click();
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
  await lettersField(page).fill((await screenOf(page, 'fresh')).letters);
  await claimIt(page).click();
  await startFresh(page);
  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 20_000 });
});

test('anything but four letters is caught before anything is sent', async ({ page }) => {
  await openClaim(page);
  for (const typed of ['kx-4821-qm', 'OOSS', 'KXQ']) {
    await lettersField(page).fill(typed);
    await claimIt(page).click();
    await expect(page.getByText('Enter the 4 letters from its screen.')).toBeVisible();
  }
  await expect(lettersField(page)).toHaveValue('KXQ');
  const state = await fake<{ appliances: Record<string, { claimFailures?: number }> }>(page, 'state');
  expect(state.appliances.dev_7KQ2M4XD?.claimFailures ?? 0).toBe(0);
});

test('several on this network: pick one, then its letters', async ({ page }) => {
  await openClaim(page, ['fresh', 'contested']);
  await expect(page.getByRole('heading', { name: 'We found 2 Whombats on your network' })).toBeVisible();
  await page.getByRole('button', { name: 'Claim wb-mini-1 · dev_7KQ2M4XD' }).click();
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
  await lettersField(page).fill((await screenOf(page, 'fresh')).letters);
  await claimIt(page).click();
  await startFresh(page);
  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 20_000 });
});

test('“Not this one?” and “None of these?”: we couldn’t find it', async ({ page }) => {
  await openClaim(page);
  await page.getByRole('button', { name: 'Not this one?' }).click();
  await expect(noneHeading(page)).toBeVisible();
  await expect(lookAgain(page)).toBeVisible();
  // Opening the list again, with still no Whombat: straight back to what's on this network (AP-75).
  await fake(page, 'nearby', ['fresh', 'contested']);
  await page.goto('/appliances');
  await page.getByRole('button', { name: 'None of these?' }).click();
  await expect(noneHeading(page)).toBeVisible();
});

test('a found box that left this network: we couldn’t find it, then look again', async ({ page }) => {
  await openClaim(page);
  await expect(lettersField(page)).toBeVisible();
  await fake(page, 'nearby', []);
  await lettersField(page).fill((await screenOf(page, 'fresh')).letters);
  await claimIt(page).click();
  await expect(noneHeading(page)).toBeVisible();
  // Back on its network: found again, and its letters claim it.
  await fake(page, 'nearby', ['fresh']);
  await lookAgain(page).click();
  await lettersField(page).fill((await screenOf(page, 'fresh')).letters);
  await claimIt(page).click();
  await startFresh(page);
  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 20_000 });
});

test('something that isn’t the Whombat on the screen answers: stopped, nothing trusted', async ({ page }) => {
  await openClaim(page, ['mismatched']);
  await lettersField(page).fill((await screenOf(page, 'mismatched')).letters);
  await claimIt(page).click();
  await expect(page.getByText('This isn’t the Whombat on your screen.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toHaveCount(0);
  const known = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('whombat:appliances:'))
      .map((k) => localStorage.getItem(k))
      .join(''),
  );
  expect(known).not.toContain('dev_9WER6TYU');
});

test('competing claim', async ({ page }) => {
  await openClaim(page, ['contested']);
  await lettersField(page).fill((await screenOf(page, 'contested')).letters);
  await claimIt(page).click();
  await expect(page.getByText('Someone else is claiming this Whombat right now.')).toBeVisible();
});

test('no card any more (Whombat Link): the claim offers only the letters on its screen', async ({ page }) => {
  await openClaim(page, []);
  await expect(noneHeading(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Claim with a card instead' })).toHaveCount(0);
});

test('/claim is the claim page (what the Whombat’s screen says to open)', async ({ page }) => {
  await page.goto('/claim');
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
});
