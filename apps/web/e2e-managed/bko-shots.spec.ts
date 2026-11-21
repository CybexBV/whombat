/**
 * Review screenshots of backups v2 (app backup-options.md AP-6830…, backup-v2.md AP-6880…; not baselines; there is no
 * mock for these screens, so they are compared with the existing Settings and bring-back styling): on a newly claimed
 * box “Is this a new Whombat?”, finding backups without a saved passkey, the paper copy pasted, Home's
 * backups, the steps while it works (the runtime away part of the time), the one question, and Home is back with its
 * last line a passkey button; without a copy at the account, Look on my network and what it found; a restore that
 * stopped with Try again; the Backups page with the passkey's one line, and bringing one back later — light and dark,
 * 1440×900. `BKO_SHOTS=<dir>` writes them.
 */
import { expect, type Page, test } from '@playwright/test';
import { agreeToTerms, cards, claimFresh, consoles, fake, fresh, signIn } from './support';

const DIR = process.env.BKO_SHOTS ?? '';

/** A paper copy's backup part, as its text carries it on a line of its own. */
const PAPER = [
  'WHOMBAT BACKUP DETAILS',
  'Whombat: Home',
  JSON.stringify({
    kind: 'whombat.backup-recovery-material/1',
    applianceId: 'wb-3fkq-8mzt-2049',
    generation: 2,
    createdAt: '2026-11-03T03:00:00Z',
    repository: 'rest:http://10.100.1.30:8747/whombat-home/',
    repositoryPassword: 'rp-0123456789ab',
    repositoryId: 'repo_home',
    manifestKey: 'ed25519:AAAA',
  }),
].join('\n');

async function claim(page: Page) {
  await page.getByRole('button', { name: 'Claim a Whombat' }).click();
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
  const screen = (await consoles(page)).fresh;
  await page.getByLabel('Enter the 4 letters from its screen').fill(screen?.letters ?? '');
  await agreeToTerms(page);
  await page.getByRole('button', { name: 'Claim it' }).click();
}

async function begin(page: Page, theme: 'light' | 'dark') {
  test.skip(!DIR, 'set BKO_SHOTS=<dir> to write review screenshots');
  test.setTimeout(240_000);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  return {
    shot: (name: string) => page.screenshot({ path: `${DIR}/${theme}-${name}.png` }),
    settle: () => page.waitForTimeout(400),
  };
}

/** The paper copy's text pasted; then its backups. */
async function paste(page: Page) {
  await page.getByRole('button', { name: 'Paste the paper copy' }).click();
  await page.getByLabel('The paper copy’s text').fill(PAPER);
}

for (const theme of ['light', 'dark'] as const)
  test(`bring a Whombat back (${theme})`, async ({ page }) => {
    const { shot, settle } = await begin(page, theme);
    await claim(page);
    await expect(page.getByRole('heading', { name: 'Is this a new Whombat?' })).toBeVisible({
      timeout: 20_000,
    });
    await page.locator('[data-choice="back"]').click();
    await settle();
    await shot('b1-question');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Find your Whombat’s backups' })).toBeVisible();
    await settle();
    await shot('b2-find-backups');
    await paste(page);
    await settle();
    await shot('b3-paper');
    await page.getByRole('button', { name: 'Open the backups' }).click();
    await expect(page.getByRole('heading', { name: 'Home’s backups', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await settle();
    await shot('c-choose');
    await page.getByRole('button', { name: 'Bring Home back' }).click();
    await expect(page.getByRole('heading', { name: 'Bringing Home back' })).toBeVisible();
    await settle();
    await shot('d-working');
    await expect(page.getByText('Waiting for this Whombat to answer again…')).toBeVisible({
      timeout: 20_000,
    });
    await shot('d-working-away');
    await expect(page.getByRole('heading', { name: 'Almost there' })).toBeVisible({ timeout: 40_000 });
    await settle();
    await shot('e-question');
    await page.getByRole('button', { name: 'Lost or stolen' }).click();
    await settle();
    await shot('e-answered');
    await page.getByRole('button', { name: 'Start Home' }).click();
    await expect(page.getByRole('heading', { name: 'Home is back' })).toBeVisible({ timeout: 40_000 });
    const passkey = page.locator('[data-done-passkey]');
    await expect(passkey.getByRole('button', { name: 'Set up my passkey', exact: true })).toBeEnabled();
    await settle();
    await shot('f-done');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        hasPrf: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await passkey.getByRole('button', { name: 'Set up my passkey', exact: true }).click();
    await expect(passkey.getByText('Passkey ready', { exact: true })).toBeVisible();
    const keys = await fake<{ owner?: unknown }[]>(page, 'controlPasskeys');
    expect(keys).toHaveLength(1);
    expect(keys[0]?.owner).toBeTruthy();
    await shot('f-done-passkey-ready');
  });

for (const theme of ['light', 'dark'] as const)
  test(`look on the network, and a restore that stopped (${theme})`, async ({ page }) => {
    const { shot, settle } = await begin(page, theme);
    const c = (await cards(page)).fresh;
    await claim(page);
    await expect(page.getByRole('heading', { name: 'Is this a new Whombat?' })).toBeVisible({
      timeout: 20_000,
    });
    await page.locator('[data-choice="back"]').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Find your Whombat’s backups' })).toBeVisible();
    await settle();
    await shot('g1-find');
    await page.getByRole('button', { name: 'Look on my network' }).click();
    await expect(page.getByText(/This can take about a minute/)).toBeVisible();
    await shot('g2-looking');
    await expect(page.getByText(/No backups locked with a passkey/)).toBeVisible({ timeout: 20_000 });
    await settle();
    await shot('g3-nothing');
    await fake(page, 'backupOptions', c.device, { restoreStops: true });
    await paste(page);
    await page.getByRole('button', { name: 'Open the backups' }).click();
    await expect(page.getByRole('heading', { name: 'Home’s backups', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'Bring Home back' }).click();
    await expect(page.getByRole('heading', { name: 'It didn’t finish' })).toBeVisible({ timeout: 60_000 });
    await settle();
    await shot('h-stopped');
  });

for (const theme of ['light', 'dark'] as const)
  test(`backups: the passkey's line, and bringing one back later (${theme})`, async ({ page }) => {
    const { shot, settle } = await begin(page, theme);
    const c = await claimFresh(page);
    // Started fresh, no place yet: Backups offers bringing back a Whombat you had.
    await page.goto('/settings?tab=appliance&section=backups');
    await expect(page.locator('#bring-back')).toBeVisible({ timeout: 20_000 });
    await page.locator('#bring-back').scrollIntoViewIfNeeded();
    await settle();
    await shot('i-later');
    await page.locator('#bring-back').getByRole('button', { name: 'Bring back' }).click();
    await expect(page.getByRole('heading', { name: 'Replace what’s on this Whombat?' })).toBeVisible({
      timeout: 20_000,
    });
    await settle();
    await shot('i-replace');
    // Backed up, and no passkey holds the key yet: the one calm line in the top card.
    await fake(page, 'backup', c.device, 'protected');
    await page.goto('/settings?tab=appliance&section=backups');
    await expect(page.locator('[data-backup-passkey]')).toBeVisible({ timeout: 20_000 });
    await settle();
    await shot('j-passkey-line');
    await fake(page, 'backup', c.device, 'failing');
    await page.goto('/settings?tab=appliance&section=backups');
    await expect(page.locator('[data-backup-hero][data-state="failing"]')).toBeVisible({ timeout: 20_000 });
    await settle();
    await shot('j-failing');
  });
