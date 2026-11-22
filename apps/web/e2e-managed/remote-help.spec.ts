/**
 * Remote help (Whombat remote-help.md RH-01…RH-12; app remote-help.md AP-4440…): the person on a test Whombat lets support
 * look and fix until they stop it (the dialog: no passkey), sees Support connect and what Support did, opens the command
 * line and downloads it, and stops it; the person on a customer box confirms with a passkey (Chrome's virtual
 * authenticator), reads the help code, and sees a Look visit stopped where it needed more; a box without a support key
 * says it isn't available. Through the fake world's remote help (`createFakeRemoteHelp`).
 *
 * `RH_SHOTS=<dir>` also writes review screenshots, light and dark, 1440×900.
 */
import { readFileSync } from 'node:fs';
import { type CDPSession, expect, type Page, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

const SHOTS = process.env.RH_SHOTS ?? '';
const about = '/settings?tab=appliance&section=about';

interface Snapshot {
  grant: { level: string; until: string | null; helpCode: string | null } | null;
  visits: { id: string; endedAt: string | null }[];
}

async function setup(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  const c = await claimAndSaveKit(page);
  // Remote help is a Whombat Link feature: the card shows while Link is on.
  await fake(page, 'linkState', 'on', {}, c.device);
  return c;
}

async function authenticator(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasPrf: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.addInitScript(() => {
    Object.defineProperty(window.PublicKeyCredential, 'isConditionalMediationAvailable', {
      value: async () => false,
    });
  });
  return cdp;
}

/** Both themes of what is on screen now, with the card in view. */
async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  const card = page.locator('section[data-remote-help]');
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    // The theme's colours ease in: the still is taken once they are there.
    await page.waitForTimeout(400);
    if (!(await page.getByRole('dialog').isVisible())) await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/remote-help-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('a test Whombat: look and fix until stopped, what Support did, the command line, Stop', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const c = await setup(page);
  await page.goto(about);
  const card = page.getByRole('region', { name: 'Remote help' });
  await expect(card.getByText('Nobody can get in while this is off.', { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  await expect(card.getByText('Nobody has used remote help yet.')).toBeVisible();
  // A test Whombat offers Forever; without a passkey there's no passkey hint.
  await expect(card.getByText('You’ll confirm with your passkey.')).toHaveCount(0);
  await card.getByRole('radio', { name: /^Look and fix/ }).check();
  // The segmented control's radios sit under their labels: the label is what is clicked.
  await card.getByText('Forever', { exact: true }).click();
  await expect(card.getByRole('radio', { name: 'Forever' })).toBeChecked();
  await shoot(page, 'off');

  await card.getByRole('button', { name: 'Turn on remote help' }).click();
  const dialog = page.getByRole('dialog', { name: 'Turn on remote help?' });
  await expect(dialog).toContainText('look and fix until you stop it');
  await shoot(page, 'confirm');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await fake<Snapshot>(page, 'remoteHelp', c.device)).grant).toBeNull();
  await card.getByRole('button', { name: 'Turn on remote help' }).click();
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  await expect(card.getByText('On · Look and fix · forever')).toBeVisible();
  expect((await fake<Snapshot>(page, 'remoteHelp', c.device)).grant).toMatchObject({
    level: 'fix',
    until: null,
  });

  // Support connects: the card follows by itself.
  await fake(page, 'remoteHelpVisit', c.device, 'Support');
  await expect(card.getByText('Support is connected now')).toBeVisible({
    timeout: 20_000,
  });
  const log = card.getByRole('list', { name: 'What support did' });
  await expect(log.getByText('Support connected')).toBeVisible();
  await expect(log.getByText('Read the logs of voice')).toBeVisible();
  await expect(log.getByText('Restarted voice')).toBeVisible();
  await expect(log.getByText('systemctl status whombat-voice')).toBeVisible();
  await shoot(page, 'on');

  await log.getByRole('button', { name: 'Show command line' }).click();
  const transcript = page.getByRole('dialog', { name: 'Command line' });
  await expect(transcript).toContainText('root@whombat:~# systemctl restart whombat-voice');
  await shoot(page, 'transcript');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    transcript.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^whombat-remote-help-vis_[0-9a-f]+\.txt$/);
  expect(readFileSync((await download.path()) as string, 'utf8')).toContain('audio device busy');
  await transcript.getByRole('button', { name: 'Close' }).click();

  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(card.getByRole('button', { name: 'Turn on remote help' })).toBeVisible();
  await expect(log.getByText('Support left')).toBeVisible();
  const after = await fake<Snapshot>(page, 'remoteHelp', c.device);
  expect(after.grant).toBeNull();
  expect(after.visits[0]?.endedAt).not.toBeNull();
});

test('a customer box: a passkey confirms it, the help code, and Look stops at what needs more', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const c = await setup(page);
  await authenticator(page);
  await page.goto('/settings?tab=appliance&section=devices');
  const passkeys = page.getByRole('region', { name: 'PASSKEYS' });
  await passkeys.getByRole('button', { name: 'Set up my passkey', exact: true }).click();
  await expect(passkeys).toContainText('Your passkey is ready');
  await fake(page, 'remoteHelpBox', c.device, { environment: 'prod' });

  await page.goto(about);
  const card = page.getByRole('region', { name: 'Remote help' });
  await expect(card.getByText('You’ll confirm with your passkey.')).toBeVisible({ timeout: 20_000 });
  // No Forever on a customer box (RH-03).
  await expect(card.getByRole('radio', { name: 'Forever' })).toHaveCount(0);
  await card.getByText('1 hour', { exact: true }).click();
  await shoot(page, 'off-passkey');
  await card.getByRole('button', { name: 'Turn on remote help' }).click();
  // An hour from now is tomorrow after 23:00 in the browser's time zone (“until tomorrow 00:42”).
  await expect(card.getByText(/^On · Look · until (tomorrow )?\d\d:\d\d$/)).toBeVisible({ timeout: 15_000 });
  const code = (await fake<Snapshot>(page, 'remoteHelp', c.device)).grant?.helpCode as string;
  expect(code).toMatch(/^[0-9A-Z]{6}$/);
  await expect(card.getByText(`${code.slice(0, 3)}·${code.slice(3)}`)).toBeVisible();
  await expect(card.getByText('Give this to Whombat support. They need it to connect.')).toBeVisible();

  await fake(page, 'remoteHelpVisit', c.device, 'Support');
  await page.reload();
  const log = page
    .getByRole('region', { name: 'Remote help' })
    .getByRole('list', { name: 'What support did' });
  await expect(log.getByText('Was stopped: that needs Look and fix').first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(log.getByRole('button', { name: 'Show command line' })).toHaveCount(0);
  await shoot(page, 'customer');
});

test('a box without a support key says remote help isn’t available yet', async ({ page }) => {
  const c = await setup(page);
  await fake(page, 'remoteHelpBox', c.device, { available: false });
  await page.goto(about);
  const card = page.getByRole('region', { name: 'Remote help' });
  await expect(card.getByText('Remote help isn’t available on this Whombat yet.')).toBeVisible({
    timeout: 20_000,
  });
  await expect(card.getByRole('button', { name: 'Turn on remote help' })).toHaveCount(0);
});
