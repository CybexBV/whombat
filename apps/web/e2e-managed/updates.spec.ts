/**
 * Updates on the clients (updates.md UP-E4, UP-F1; AP-257…AP-260): what you're told about updates in Settings →
 * This Whombat, and where backups go, set in Settings after the claim. Versions are one check (HE-52;
 * `appliance.spec.ts`).
 */
import { expect, type Page, test } from '@playwright/test';
import {
  agreeToTerms,
  cards,
  claimAndSaveKit,
  consoles,
  fake,
  fresh,
  makeKit,
  recoveryKeyOf,
  saveKitAsFile,
  signIn,
  skipConnectAi,
  startFresh,
} from './support';

/** Burrow screens are burrow-less (AP-360); the open appliance's burrow is the one they show. */
const B = '';

async function setup(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  return claimAndSaveKit(page);
}

test('updates: waiting for work, since when; then it moves and the page follows', async ({ page }) => {
  // The section asks again every 15 s while an update waits, every 5 s while it moves.
  test.setTimeout(60_000);
  const c = await setup(page);
  const since = new Date(Date.now() - 40 * 60_000).toISOString();
  await fake(page, 'update', c.device, {
    state: 'WaitingForSafeBoundary',
    candidate: '2026.9.3',
    waiting: { reason: 'boundary', since, blockers: [{ kind: 'run', count: 2 }] },
  });
  await page.goto(`${B}/settings?tab=appliance&section=about`);
  const updates = page.getByRole('region', { name: 'UPDATES' });
  await expect(updates.getByText('Update ready · waiting for work to finish')).toBeVisible();
  await expect(updates.getByText('It waits for work in progress to finish.')).toBeVisible();
  // 40 minutes ago is yesterday before 00:40 in the browser's time zone: the line then says the day (“5 November”).
  await expect(
    updates.getByText(/^2 runs in progress · Waiting since (\d\d:\d\d|\d{1,2} [A-Z][a-z]+)$/),
  ).toBeVisible();

  // It installs: the section asks again by itself while an update moves.
  await fake(page, 'update', c.device, { state: 'Verifying', candidate: '2026.9.3' });
  await expect(updates.getByText('Checking the update')).toBeVisible({ timeout: 20_000 });
  await fake(
    page,
    'releaseSummary',
    '2026.9.3',
    'Faster replies in busy channels, and Spend shows each agent’s week.',
  );
  await fake(page, 'update', c.device, {
    state: 'Healthy',
    current: '2026.9.3',
    candidate: null,
    lastUpdate: { release: '2026.9.3', from: '2026.9.2', at: '2026-09-28T18:10:00Z' },
  });
  await expect(updates.getByText('Up to date')).toBeVisible({ timeout: 15_000 });
  await expect(updates.getByText('Updated to 2026.9.3 on 28 September 2026')).toBeVisible();
  await expect(
    updates.getByText('Faster replies in busy channels, and Spend shows each agent’s week.'),
  ).toBeVisible();

  // Check for updates (check-for-updates.md): the box looks now and says what came of it.
  await updates.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByText('You’re up to date.')).toBeVisible();
});

test('updates: a failed one says why and that nothing changed; forward repair is worded', async ({
  page,
}) => {
  const c = await setup(page);
  await fake(page, 'update', c.device, {
    state: 'Failed',
    current: 'pve-20260928.4',
    candidate: 'pve-20260928.5',
    failureDetail: {
      stage: 'Staged',
      code: 'schema_incompatible',
      reasons: ['candidate_cannot_read_schema'],
      release: 'pve-20260928.5',
      schema: { database: 48, target: null, candidateWrites: 49, candidateReads: { min: 49, max: 49 } },
      failedChecks: [],
      at: 1_790_000_000,
    },
  });
  await page.goto(`${B}/settings?tab=appliance&section=about`);
  const updates = page.getByRole('region', { name: 'UPDATES' });
  await expect(
    updates.getByText('The last update didn’t work · still on the previous version'),
  ).toBeVisible();
  await expect(
    updates.getByText(
      'pve-20260928.5 couldn’t start on this Whombat’s database: it reads schema 49 only and the database is at 48. Nothing was changed. Your Whombat is still on pve-20260928.4.',
    ),
  ).toBeVisible();

  await fake(page, 'update', c.device, { state: 'ForwardRepairRequired', current: 'pve-20261001.1' });
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'UPDATES' })
      .getByText('Updated · can’t go back to the previous version'),
  ).toBeVisible();
});

test('updates: one that needs a backup says so, and you set up a destination from there', async ({
  page,
}) => {
  const c = await setup(page);
  await fake(page, 'update', c.device, {
    state: 'Staged',
    candidate: '2026.10.1',
    waiting: {
      reason: 'checkpoint',
      since: '2026-09-27T08:00:00Z',
      blockers: [{ kind: 'no_destination', count: 1 }],
    },
  });
  await page.goto(`${B}/settings?tab=appliance&section=about`);
  const panel = page.getByRole('region', { name: 'This Whombat' });
  const updates = page.getByRole('region', { name: 'UPDATES' });
  await expect(
    updates.getByText(
      'It needs a backup destination first: it changes the database in a way that can’t be undone.',
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await updates.getByRole('button', { name: 'Set up backups' }).click();
  // It opens Backups with the form (this-whombat-sections.md AP-1231), which says what a missing destination blocks.
  await expect(page).toHaveURL(/section=backups#set-up$/);
  await expect(
    panel.getByText('Updates that change the database in a breaking way wait until a backup exists.', {
      exact: false,
    }),
  ).toBeVisible();
  const backups = page.getByRole('region', { name: 'BACKUPS' });
  await backups.getByRole('radio', { name: /A disk on this Whombat/ }).check();
  await backups.getByRole('button', { name: 'Save and check' }).click();
  await expect(backups.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
  await expect(panel.getByText('Protected', { exact: true })).toBeVisible();
  // The passkey holds the backups' key, so a new place needs no new recovery kit.
  await expect(backups.getByText('A new place needs a new recovery kit', { exact: false })).toHaveCount(0);
});

test('backups to an SFTP server with this Whombat’s key, set in Settings after the claim; a kit made later carries it', async ({
  page,
}) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  const c = (await cards(page)).fresh;
  await page.getByRole('button', { name: 'Claim a Whombat' }).click();
  await page
    .getByLabel('Enter the 4 letters from its screen')
    .fill(((await consoles(page)).fresh as { letters: string }).letters);
  await agreeToTerms(page);
  await page.getByRole('button', { name: 'Claim it' }).click();

  // Where backups go isn't a step of the claim: on to Connect your AI.
  await startFresh(page);
  await expect(page.getByText('CLAIM · STEP 2 OF 2')).toBeVisible({ timeout: 20_000 });
  await skipConnectAi(page);
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });

  await page.goto(`${B}/settings?tab=appliance&section=backups`);
  const backups = page.getByRole('region', { name: 'BACKUPS' });
  await backups.getByRole('button', { name: 'Set up backups' }).click();
  await backups.getByRole('radio', { name: /A NAS or server \(SFTP\)/ }).check();
  await expect(backups.getByTestId('backup-ssh-key')).toContainText(`whombat-backup@${c.device}`);
  await backups.getByRole('button', { name: 'Save and check' }).click();
  await expect(backups.getByText('Enter the server’s name or address.')).toBeVisible();
  await backups.getByLabel('Server', { exact: true }).fill('nas.burrowhq.example');
  await backups.getByLabel('Folder on the server').fill('/srv/whombat');
  await backups.getByLabel('User', { exact: true }).fill('whombat');
  await backups.getByRole('button', { name: 'Save and check' }).click();
  await expect(
    backups.getByText('Compare this with your server’s host key fingerprint: SHA256:', { exact: false }),
  ).toBeVisible();
  const { kitText } = await makeKit(page, c.device);
  expect(kitText).toContain('Destination: sftp:nas.burrowhq.example:/srv/whombat');
});

test('no backups yet: Settings says what that blocks', async ({ page }) => {
  await setup(page);
  await page.goto(`${B}/settings?tab=appliance&section=backups`);
  const backups = page.getByRole('region', { name: 'BACKUPS' });
  await expect(backups.getByText('Unprotected', { exact: true })).toBeVisible();
  await expect(
    backups.getByText('Updates that change the database in a breaking way wait until a backup exists.', {
      exact: false,
    }),
  ).toBeVisible();
});

test('security views read strictly: a device only a newer app knows isn’t left out of Devices (AP-266)', async ({
  page,
}) => {
  const c = await setup(page);
  await fake(page, 'newerDevice', c.device, 'visionos');
  await page.goto(`${B}/settings?tab=appliance#devices`);
  // Devices is You's part: the group is a page of its own, named You.
  const panel = page.getByRole('region', { name: 'You' });
  await expect(
    panel.getByText('This needs a newer version of the app. Reload to get the newest version.'),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(panel.getByText('This browser')).toHaveCount(0);
  await expect(page.getByTestId('left-out-strip')).toHaveText(
    /Part of this page needs a newer version of the app\./,
  );
});

test('the recovery kit leaves out a backup section it can’t carry whole, and says so (AP-265)', async ({
  page,
}) => {
  const c = await setup(page);
  // A Whombat from before the passkey: its recovery kit carries the backups' key.
  await fake(page, 'beforePasskey', c.device);
  await page.goto(`${B}/settings?tab=appliance&section=backups`);
  const backups = page.getByRole('region', { name: 'BACKUPS' });
  await backups.getByRole('button', { name: 'Set up backups' }).click();
  await backups.getByRole('radio', { name: /A storage bucket/ }).check();
  await backups.getByLabel('Endpoint', { exact: true }).fill('https://s3.eu-central-1.amazonaws.com');
  await backups.getByLabel('Bucket', { exact: true }).fill('burrow-backups');
  // A refusal is the backup service's own sentence for you (BK-21).
  await backups.getByLabel('Access key', { exact: true }).fill('AKIAWRONG');
  await backups.getByLabel('Secret key', { exact: true }).fill('nope');
  await backups.getByRole('button', { name: 'Save and check' }).click();
  await expect(
    backups.getByText('The bucket refused the key. Check the access key and the secret key (403 Forbidden).'),
  ).toBeVisible();
  await backups.getByLabel('Access key', { exact: true }).fill('AKIAFAKE0123');
  await backups.getByLabel('Secret key', { exact: true }).fill('fake/secret+key');
  await backups.getByRole('button', { name: 'Save and check' }).click();
  await expect(backups.getByText('A new place needs a new recovery kit', { exact: false })).toBeVisible();

  // A kit exists: the current one signs its replacement. Saving the replacement confirms it (AP-6820), so the next
  // one is signed with its key in turn.
  const kitOf = async (currentKey: string) => {
    await page.goto(`/appliances/${c.device}/recovery-kit`);
    await page.getByLabel('Recovery key from your current kit').fill(currentKey);
    await page.getByRole('button', { name: 'Continue' }).click();
    return saveKitAsFile(page);
  };
  const whole = await kitOf(c.recoveryKey);
  expect(whole).toContain('Kit version: 3');
  expect(whole).toContain('S3 access key: AKIAFAKE0123');
  expect(whole).toContain('S3 secret key: fake/secret+key');
  expect(whole).toContain('Backup section for whombat-backup (save the next line as kit.json):');

  await fake(page, 'backupMaterial', c.device, { s3Endpoint: 'https://s3.eu-central-1.amazonaws.com' });
  const part = await kitOf(recoveryKeyOf(whole));
  await expect(page.getByTestId('kit-backup-gap')).toHaveText(
    'This version of the app can’t write all of your Whombat’s backup details into the kit, so the kit leaves them out. Update the app, then save a new kit.',
  );
  expect(part).toContain('Backups: not in this kit.');
  expect(part).not.toContain('S3 secret key');
});

test('ask before updating: the owner turns it on, an update waits for their yes, Update now installs it', async ({
  page,
}) => {
  // The section asks again every 15 s while an update waits, every 5 s while it moves.
  test.setTimeout(60_000);
  const c = await setup(page);
  await fake(page, 'update', c.device, { state: 'Healthy', askFirst: false });
  await page.goto(`${B}/settings?tab=appliance&section=about`);
  const updates = page.getByRole('region', { name: 'UPDATES' });
  const ask = updates.getByRole('switch', { name: 'Ask before updating' });
  await expect(ask).not.toBeChecked();
  await ask.click();
  await expect(ask).toBeChecked();
  await expect(updates.getByText('Each update waits for your yes.')).toBeVisible();

  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  await fake(page, 'update', c.device, {
    state: 'Staged',
    candidate: '2026.9.3',
    askFirst: true,
    waiting: { reason: 'owner', since, blockers: [] },
  });
  await page.reload();
  await expect(updates.getByText('It waits for your yes before it installs.')).toBeVisible();
  await updates.getByRole('button', { name: 'Update now' }).click();
  await expect(updates.getByText('Updating now')).toBeVisible({ timeout: 20_000 });
  await expect(updates.getByRole('button', { name: 'Update now' })).toHaveCount(0);
});
