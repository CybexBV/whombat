/**
 * Inside a managed Whombat (assignment §14 items 6, 14): status panels, device trust, connection states,
 * revocation clearing caches, durable commands, attachments and canvases through the session.
 */
import { expect, type Page, test } from '@playwright/test';
import { pairingFingerprint, SESSION_PROTOCOL } from '@whombat/protocol/session';
import { claimAndSaveKit, fake, fresh, saveKitAsFile, signIn } from './support';

/** Burrow screens are burrow-less (AP-360); the open appliance's burrow is the one they show. */
const B = '';

async function setup(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  return claimAndSaveKit(page);
}

test('This Whombat: backups say Unprotected without a destination; provider states are on the AI tab', async ({
  page,
}) => {
  const c = await setup(page);
  await fake(page, 'providers', c.device, [
    {
      provider: 'claude',
      authMode: 'subscription',
      state: 'ready',
      explanation: null,
    },
    {
      provider: 'codex',
      authMode: 'subscription',
      state: 'auth_revoked',
      explanation: null,
    },
    {
      provider: 'claude',
      authMode: 'subscription',
      state: 'quota_exhausted',
      explanation: 'Resets at 16:00.',
    },
    {
      provider: 'codex',
      authMode: 'api_key',
      state: 'auth_expired',
      explanation: null,
    },
    {
      provider: 'claude',
      authMode: 'api_key',
      state: 'outage',
      explanation: 'Anthropic reports an incident.',
    },
  ]);
  await page.goto(`${B}/settings?tab=appliance&section=backups`);
  const panel = page.getByRole('region', { name: 'This Whombat' });
  await expect(panel.getByText('Unprotected', { exact: true })).toBeVisible();
  await expect(panel.getByText('No place for backups is set up.', { exact: false })).toBeVisible();
  // The passkey holds the backups' key on this Whombat, so the recovery kit has no row here.
  await expect(page.getByRole('region', { name: 'RECOVERY KIT' })).toHaveCount(0);
  // The AI providers' sign-ins are in Settings → AI, once (settings-simplify.md SS-03): not here.
  await expect(panel.getByText('Claude · Ready')).toHaveCount(0);
  await expect(panel.getByText('AI PROVIDERS')).toHaveCount(0);

  // Backups that fail say so on the top card, with the box's reason (backup-options.md AP-6809), never a calm
  // “Backed up 3 days ago”.
  await fake(page, 'backup', c.device, 'failing');
  await page.reload();
  const backups = page.getByRole('region', { name: 'This Whombat' });
  await expect(backups.getByRole('heading', { name: 'The last backup didn’t work' })).toBeVisible();
  await expect(backups.getByText(/The backup destination didn.t answer/)).toBeVisible();
});

test('Devices: look up a new device by its code, compare its fingerprint, let it in, remove it', async ({
  page,
}) => {
  const c = await setup(page);
  const code = await fake<string>(page, 'requestPairing', c.device, 'Hugo’s phone');
  const state = await fake<{
    appliances: Record<string, { pairing: { code: string; endpoint: string }[] }>;
  }>(page, 'state');
  const phone = state.appliances[c.device]?.pairing.find((p) => p.code === code)?.endpoint as string;
  await page.goto(`${B}/settings?tab=appliance#devices`);
  await expect(page.getByText('This browser', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Have a code already?' }).click();
  await page.getByLabel('Code shown on the new device').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  // The Mobile app page's card: the question, what it is, the fingerprint to compare, and “Not my device”.
  const asking = page.getByTestId('pairing-device');
  await expect(asking.getByRole('heading', { name: 'Let Hugo’s phone in?' })).toBeFocused();
  await expect(asking.getByTestId('pairing-platform')).toHaveText('Android phone');
  await expect(asking.getByTestId('pairing-fingerprint')).toHaveText(pairingFingerprint(phone));
  await expect(asking.getByRole('button', { name: 'Not my device' })).toBeVisible();
  await page.getByRole('button', { name: 'Let it in' }).click();
  await expect(page.getByText('Let in.')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Remove Hugo’s phone' }).click();
  await expect(page.getByText('Removed · cleared when it next connects')).toBeVisible();
});

test('a wrong pairing code is refused', async ({ page }) => {
  await setup(page);
  await page.goto(`${B}/settings?tab=appliance#devices`);
  await page.getByRole('button', { name: 'Have a code already?' }).click();
  await page.getByLabel('Code shown on the new device').fill('1111-2222');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('No device is showing that code.', { exact: false })).toBeVisible();
});

test('a code that another device took over after the look-up lets nothing in', async ({ page }) => {
  const c = await setup(page);
  const code = await fake<string>(page, 'requestPairing', c.device, 'Hugo’s phone');
  await page.goto(`${B}/settings?tab=appliance#devices`);
  await page.getByRole('button', { name: 'Have a code already?' }).click();
  await page.getByLabel('Code shown on the new device').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('pairing-device')).toBeVisible();
  await fake(page, 'hijackPairing', c.device, code);
  await page.getByRole('button', { name: 'Let it in' }).click();
  await expect(
    page.getByText('Another device now shows that code. Nothing was let in.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Code shown on the new device')).toBeVisible();
  await expect(page.getByText('Hugo’s phone', { exact: false })).toHaveCount(0);
});

test('a notification tap opens what its ref resolves to; an unknown one the inbox with a note', async ({
  page,
}) => {
  const c = await setup(page);
  // The branch room (channels went with one agent, Whombat one-agent.md OA-04).
  const ref = await fake<string>(page, 'pushRef', c.device, { type: 'pr', number: 482 });
  await page.goto(`/?push=message&ref=${ref}`);
  await expect(page).toHaveURL(new RegExp(`${B}/pr/482$`), { timeout: 15_000 });
  await page.goto(`/?push=message&ref=${'A'.repeat(22)}`);
  await expect(
    page.getByRole('status').filter({ hasText: 'Couldn’t find what that notification was about.' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`${B}/log\\?kind=asks$`));
});

test('connection states: appliance offline shows a quiet strip, then recovers', async ({ page }) => {
  const c = await setup(page);
  await fake(page, 'applianceOffline', c.device, true);
  await expect(page.getByRole('status').filter({ hasText: 'Your Whombat isn’t online.' })).toBeVisible({
    timeout: 10_000,
  });
  await fake(page, 'applianceOffline', c.device, false);
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your Whombat isn’t online.' })).toHaveCount(0, {
    timeout: 15_000,
  });
});

test('connection states: offline network and relay trouble say so', async ({ page }) => {
  await setup(page);
  await fake(page, 'relayDown', true);
  await expect(page.getByRole('status').filter({ hasText: 'You’re offline.' })).toBeVisible({
    timeout: 10_000,
  });
  await fake(page, 'relayDown', false);
});

test('versions: a Whombat on another major says who must update, and nothing else (HE-52)', async ({
  page,
}) => {
  const c = await setup(page);
  // A box on the next major: this app is too old; on the one before: the box is (session major 4 since 3.0, CT-1540).
  await fake(page, 'protocol', c.device, [SESSION_PROTOCOL.major + 1]);
  await expect(page.getByRole('heading', { name: 'Update the app' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await fake(page, 'protocol', c.device, [SESSION_PROTOCOL.major - 1]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'This Whombat needs an update' })).toBeVisible({
    timeout: 15_000,
  });
});

test('revocation: the device is removed elsewhere, its cached content is cleared, and it is set up again', async ({
  page,
}) => {
  const c = await setup(page);
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  const cached = await page.evaluate(
    () => window.__WHOMBAT__?.services.queryClient.getQueryCache().getAll().length ?? 0,
  );
  expect(cached).toBeGreaterThan(0);
  const peerId = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('whombat-keys');
      q.onsuccess = () => r(q.result);
    });
    const kp = await new Promise<CryptoKeyPair>((r) => {
      const q = db.transaction('endpoint').objectStore('endpoint').get('default');
      q.onsuccess = () => r((q.result as { keyPair: CryptoKeyPair }).keyPair);
    });
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    return Array.from(raw).join(',');
  });
  expect(peerId.length).toBeGreaterThan(0);
  const services = await page.evaluateHandle(() => window.__WHOMBAT__?.services);
  const state = await fake<{ appliances: Record<string, { endpoints: Record<string, unknown> }> }>(
    page,
    'state',
  );
  const mine = Object.keys(state.appliances[c.device]?.endpoints ?? {})[0] as string;
  await fake(page, 'revokeEndpoint', c.device, mine);
  await expect(page.getByRole('heading', { name: 'This device was removed' })).toBeVisible({
    timeout: 10_000,
  });
  const after = await services.evaluate((s) => s?.queryClient.getQueryCache().getAll().length ?? -1);
  expect(after).toBe(0);
  await expect(page.getByText('To use it here again, set it up again', { exact: false })).toBeVisible();
  // A revoked key stays revoked: setting up again makes a new key and asks to be let in with it.
  await page.getByRole('button', { name: 'Set up this device again' }).click();
  await expect(page.getByRole('heading', { name: 'Let this device in' })).toBeVisible();
  await page.getByRole('button', { name: 'Show a code' }).click();
  await expect(page.getByTestId('pairing-code')).toBeVisible({ timeout: 10_000 });
  const pending = await fake<{
    appliances: Record<string, { pairing: { code: string; endpoint: string; state: string }[] }>;
  }>(page, 'state');
  const request = pending.appliances[c.device]?.pairing.find((p) => p.state === 'pending');
  expect(request?.endpoint).toBeTruthy();
  expect(request?.endpoint).not.toBe(mine);
  await expect(page.getByTestId('pairing-code')).toHaveText(request?.code as string);
  await expect(page.getByTestId('pairing-fingerprint')).toHaveText(
    pairingFingerprint(request?.endpoint as string),
  );
  await fake(page, 'approveMyPairing', c.device);
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible({ timeout: 15_000 });
});

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
  await page.goto('/appliances');
  await expect(page.getByRole('heading', { name: 'Pick a Whombat' })).toBeVisible();
}

async function useKitFile(page: Page, kitText: string) {
  await page.getByLabel('Open the kit file').setInputFiles({
    name: 'whombat-recovery-kit.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(kitText),
  });
  await expect(page.getByText('Kit opened · whombat-recovery-kit.txt')).toBeVisible();
  await page.getByRole('button', { name: 'Let this device in' }).click();
}

test('recovery kit: a removed browser lets itself in again with the typed recovery key', async ({ page }) => {
  const c = await setup(page);
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  expect(c.kitText).toContain('Owner account: acc_mara');
  const before = await fake<{ appliances: Record<string, { endpoints: Record<string, unknown> }> }>(
    page,
    'state',
  );
  const old = Object.keys(before.appliances[c.device]?.endpoints ?? {})[0] as string;
  await fake(page, 'revokeEndpoint', c.device, old);
  await expect(page.getByRole('heading', { name: 'This device was removed' })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'Use your recovery kit' }).click();
  await expect(page.getByRole('heading', { name: 'Use your recovery kit' })).toBeVisible();
  await page.getByLabel('Recovery key').fill(c.recoveryKey);
  await page.getByRole('button', { name: 'Let this device in' }).click();
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible({ timeout: 15_000 });
  const after = await fake<{
    appliances: Record<string, { endpoints: Record<string, { revokedAt: string | null }> }>;
  }>(page, 'state');
  const live = Object.entries(after.appliances[c.device]?.endpoints ?? {}).filter(([, e]) => !e.revokedAt);
  expect(live.map(([k]) => k)).not.toContain(old);
  expect(live).toHaveLength(1);
});

test('recovery kit: a new browser opens the saved kit file from the list and continues as you', async ({
  page,
}) => {
  const c = await setup(page);
  await asNewBrowser(page);
  await page.getByRole('button', { name: /^Lost access\? Use your recovery kit/ }).click();
  await expect(page.getByRole('heading', { name: 'Use your recovery kit' })).toBeVisible();
  await useKitFile(page, c.kitText);
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible({ timeout: 15_000 });
});

test('recovery kit: only into the kit’s own account, and only a confirmed kit', async ({ page }) => {
  const c = await setup(page);
  await asNewBrowser(page);
  await page.getByRole('button', { name: /^Lost access\? Use your recovery kit/ }).click();
  // Typed on a browser that never knew this Whombat: it can't tell whose kit it is.
  await page.getByLabel('Recovery key').fill(c.recoveryKey);
  await page.getByRole('button', { name: 'Let this device in' }).click();
  await expect(page.getByText('This device doesn’t know whose kit this is.', { exact: false })).toBeVisible();

  await fake(page, 'kitOwner', c.device, 'acc_hugo');
  await useKitFile(page, c.kitText);
  await expect(
    page.getByText('This recovery kit belongs to another account.', { exact: false }),
  ).toBeVisible();

  await fake(page, 'kitOwner', c.device, 'acc_mara');
  await fake(page, 'kitUnconfirmed', c.device);
  await page.getByRole('button', { name: 'Let this device in' }).click();
  await expect(
    page.getByText('That recovery kit was never confirmed, so it can’t let a device in.'),
  ).toBeVisible();
  // Nothing was let in.
  await expect(page.getByRole('heading', { name: 'Use your recovery kit' })).toBeVisible();
});

test('durable commands: a message whose answer was lost is sent once', async ({ page }) => {
  const c = await setup(page);
  await page.goto(`${B}/pr/482`);
  const composer = page.getByRole('textbox', { name: 'Comment on PR #482' });
  await expect(composer).toBeVisible();
  await fake(page, 'loseResults', c.device, 1);
  await composer.fill('Ship the invoice export');
  await composer.press('Enter');
  await expect(page.getByText('Ship the invoice export')).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await expect(page.getByText('Ship the invoice export')).toHaveCount(1);
});

test('durable commands: a slow send shows it was received, then settles quietly', async ({ page }) => {
  const c = await setup(page);
  await page.goto(`${B}/pr/482`);
  const composer = page.getByRole('textbox', { name: 'Comment on PR #482' });
  await expect(composer).toBeVisible();
  await fake(page, 'slowAccept', c.device, 3000);
  await composer.fill('Queued behind the migration');
  await composer.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Received · working on it' })).toBeVisible({
    timeout: 5000,
  });
  await expect(page.getByRole('status').filter({ hasText: 'Received · working on it' })).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByText('Queued behind the migration')).toHaveCount(1);
});

test('you set up backups; the next recovery kit carries the backup section; own AI sign-in with a key', async ({
  page,
}) => {
  const c = await setup(page);
  // A Whombat from before the passkey: its recovery kit holds the backups' key.
  await fake(page, 'beforePasskey', c.device);
  await page.goto(`${B}/settings?tab=appliance`);
  const panel = page.getByRole('region', { name: 'This Whombat' });
  // The Overview says it needs you; its button opens Backups with the form (this-whombat-sections.md AP-1224).
  const needs = panel.locator('[data-needs-you]');
  await expect(needs.getByText('Backups aren’t set up')).toBeVisible();
  await needs.getByRole('button', { name: 'Set up backups' }).click();
  await expect(page).toHaveURL(/section=backups#set-up$/);
  await expect(panel.getByText('Unprotected', { exact: true })).toBeVisible();
  await panel.getByRole('radio', { name: /A restic REST server/ }).check();
  await panel.getByLabel('Server address').fill('rest:https://backup.example.com/whombat/');
  await panel.getByRole('button', { name: 'Save and check' }).click();
  await expect(panel.getByText('Old backups can’t be deleted from here', { exact: false })).toBeVisible();
  await expect(panel.getByText('A new place needs a new recovery kit', { exact: false })).toBeVisible();
  // Backed up now: the top card of the backups (backup-options.md AP-6800), on the destination just set up.
  await page.reload();
  const backups = page.getByRole('region', { name: 'This Whombat' });
  await expect(backups.getByRole('heading', { name: /^Backed up / })).toBeVisible();
  await expect(backups.getByText(/^On backup\.example\.com/)).toBeVisible();

  // Own sign-in (Settings → AI): the key goes through the session once and is never shown again.
  await page.goto(`${B}/settings?tab=ai`);
  const signIns = page.getByRole('region', { name: 'YOUR AI SIGN-INS' });
  await signIns.getByRole('button', { name: 'Use your own API key (Claude Code)' }).click();
  await signIns.getByLabel('Claude Code API key').fill('sk-test-0123456789');
  await signIns.getByRole('button', { name: 'Save key' }).click();
  await expect(signIns.getByText('Signed in. The key works.')).toBeVisible();
  await expect(signIns.getByText('Signed in with your API key')).toBeVisible();
  await expect(page.getByText('sk-test-0123456789')).toHaveCount(0);

  // The kit made now includes the backup section. A kit exists: the current one signs its replacement (CT-45).
  await page.goto(`/appliances/${c.device}/recovery-kit`);
  await expect(page.getByRole('heading', { name: 'Replace your recovery kit' })).toBeVisible();
  await page.getByLabel('Recovery key from your current kit').fill('0000-1111');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByText('That isn’t the recovery key of your current kit.', { exact: false }),
  ).toBeVisible();
  await page.getByLabel('Recovery key from your current kit').fill(c.recoveryKey);
  await page.getByRole('button', { name: 'Continue' }).click();
  const text = await saveKitAsFile(page);
  expect(text).toContain('Destination: rest:https://backup.example.com/whombat/');
  expect(text).toMatch(/Repository password: rp-[0-9a-f]+/);
});

test('Claude subscription: the guided sign-in in front of Claude Code’s own console, through the session (CT-71, AP-62)', async ({
  page,
}) => {
  await setup(page);
  // Not signed in yet: the agent can't work for Mara, and the line above the screen says where to fix that.
  await page.goto(`${B}/chat`);
  const notice = page.getByRole('status').filter({ hasText: 'can’t work for you' });
  await expect(notice).toBeVisible();
  await notice.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${B}/settings\\?tab=agent&part=ai$`));

  const signIns = page.getByRole('region', { name: 'YOUR AI SIGN-INS' });
  await signIns.getByRole('button', { name: 'Sign in with your subscription (Claude Code)' }).click();
  const panel = signIns.getByRole('region', { name: 'Claude Code sign-in' });

  // Step 1: the link Claude Code printed (its OSC 8 hyperlink), opened in a new tab.
  const open = panel.getByRole('link', { name: 'Open claude.ai to sign in' });
  await expect(open).toHaveAttribute('href', /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toBeFocused();
  const [tab] = await Promise.all([page.context().waitForEvent('page'), open.click()]);
  await tab.close();

  // A wrong code: Claude Code says “Login failed”; one click starts a new console with a new link.
  const field = panel.getByLabel('Paste the code from claude.ai');
  await expect(field).toBeFocused();
  const firstLink = await open.getAttribute('href');
  await field.fill('wrong');
  await panel.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    panel.getByText('That code didn’t work. Codes work once and expire after a few minutes.'),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Get a new link' }).click();
  await expect(open).toBeVisible();
  expect(await open.getAttribute('href')).not.toBe(firstLink);

  // Claude Code's own output is one click away, and says what it said.
  await panel.getByRole('button', { name: 'Show Claude Code’s output' }).click();
  const output = panel.getByRole('region', { name: 'Claude Code’s output' });
  await expect(output.getByText('Paste code here if prompted', { exact: false })).toBeVisible();

  // The right code through the field: the code and Enter go to Claude Code's prompt, and the row says signed in.
  await field.fill('code-4821#state');
  await field.press('Enter');
  await expect(signIns.getByText('Signed in with your Claude subscription')).toBeVisible();
  await expect(panel).toHaveCount(0);

  await page.goto(`${B}/chat`);
  await expect(page.getByRole('status').filter({ hasText: 'can’t work for you' })).toHaveCount(0);
});
