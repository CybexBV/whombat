/**
 * Passkeys that open a Whombat (Whombat passkeys.md PK-04…PK-10, passkeys.md AP-785…): Chrome's virtual authenticator
 * (CDP `WebAuthn`, CTAP2, internal, resident keys, user verification) against the fake control and Whombat, which check
 * the client data, challenge and user handle as the real ones do (without the signature).
 *
 * `PASSKEY_SHOTS=1` also writes review screenshots (light and dark) to `MANAGED_SHOTS_DIR` (default `tmp/shots`).
 */
import { type CDPSession, expect, type Locator, type Page, test } from '@playwright/test';
import { BACKUP_PASSKEY_HREF, passkeyUserHandleBase64url } from '@whombat/protocol/session';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

const SHOTS = process.env.MANAGED_SHOTS_DIR ?? '../../tmp/shots';
const shots = !!process.env.PASSKEY_SHOTS;

async function authenticator(page: Page, hasPrf = true): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

/**
 * No passkeys in the email field's autofill: the virtual authenticator answers a conditional request at once, so tests
 * of the button turn it off.
 */
async function noAutofill(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window.PublicKeyCredential, 'isConditionalMediationAvailable', {
      value: async () => false,
    });
  });
}

async function setup(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  return claimAndSaveKit(page);
}

/** This browser becomes a new device: no key, no records, signed out; the world (control, Whombats) stays. */
async function newDevice(page: Page) {
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage))
      if (k.startsWith('whombat:appliances:') || k === 'whombat:cloud-token') localStorage.removeItem(k);
    const raw = localStorage.getItem('whombat:fake-world');
    if (raw)
      localStorage.setItem('whombat:fake-world', JSON.stringify({ ...JSON.parse(raw), signedIn: false }));
    indexedDB.deleteDatabase('whombat-keys');
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
}

const devices = '/settings?tab=appliance#devices';

/** A credential saved before shared passkeys: the actual browser credential and both services' legacy records. */
async function legacyPasskey(page: Page, device: string) {
  const peer = await page.evaluate((device) => {
    const key = Object.keys(localStorage).find((key) => key.startsWith('whombat:appliances:'));
    return key
      ? (JSON.parse(localStorage.getItem(key) ?? '{}').appliances.find(
          (a: { device: string }) => a.device === device,
        ).peerId as string)
      : '';
  }, device);
  await page.evaluate(
    async ({ device, handle }) => {
      const user = Uint8Array.from(atob(handle.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      );
      const credential = (await navigator.credentials.create({
        publicKey: {
          rp: { id: location.hostname, name: 'Whombat' },
          user: { id: user, name: 'mara@example.com', displayName: 'Old passkey' },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        },
      })) as PublicKeyCredential;
      const id = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const state = JSON.parse(localStorage.getItem('whombat:fake-world') ?? '{}');
      const box = state.appliances[device];
      const endpoint = Object.values(box.endpoints)[0] as { accountId: string };
      const basic = { id, name: 'Old passkey', createdAt: new Date().toISOString(), lastUsedAt: null };
      box.passkeys = [
        ...(box.passkeys ?? []),
        { ...basic, accountId: endpoint.accountId, synced: false, removed: false },
      ];
      const key = Object.keys(localStorage).find((key) => key.startsWith('whombat:appliances:')) as string;
      const appliance = JSON.parse(localStorage.getItem(key) ?? '{}').appliances.find(
        (a: { device: string }) => a.device === device,
      ).peerId;
      state.controlPasskeys = [...(state.controlPasskeys ?? []), { ...basic, appliance }];
      localStorage.setItem('whombat:fake-world', JSON.stringify(state));
    },
    { device, handle: passkeyUserHandleBase64url(peer) },
  );
  await page.reload();
}

/** A passkey notice is a line of its own under “You haven’t signed in to Claude…”, never drawn over it. */
async function expectBelowSignInNotice(page: Page, notice: Locator) {
  const claude = page.getByRole('status').filter({ hasText: 'You haven’t signed in to' });
  await expect(claude).toBeVisible();
  const above = await claude.boundingBox();
  const box = await notice.boundingBox();
  expect(above && box && box.y >= above.y + above.height - 1).toBe(true);
}

test('add a passkey in Devices, then a new device opens the Whombat with one touch', async ({ page }) => {
  const c = await setup(page);
  await authenticator(page);
  await noAutofill(page);
  await page.goto(devices);
  const section = page.getByRole('region', { name: 'PASSKEYS' });
  await expect(section.getByText('Set up your passkey', { exact: true })).toBeVisible();
  // “Only passkeys that stay on one device” is yours to set.
  await section.getByRole('button', { name: 'Passkey details', exact: true }).click();
  await expect(section.getByRole('switch', { name: 'Only passkeys that stay on one device' })).toBeVisible();
  await section.getByRole('button', { name: 'Set up my passkey', exact: true }).click();
  await expect(page.getByText(/Your passkey (is ready|is saved)/).first()).toBeVisible();
  await expect(section.getByText('Not used yet', { exact: false })).toBeVisible();
  await expect(section.getByText('On one device', { exact: true })).toBeVisible();
  // Having one says so, and setup offers to reuse it everywhere.
  await expect(section.getByText('Passkey ready', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Set up my passkey', exact: true })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Check my passkey', exact: true })).toBeVisible();
  // The Whombat first, then control (PK-06): both keep it.
  expect(await fake<unknown[]>(page, 'passkeys', c.device)).toHaveLength(1);
  expect(await fake<unknown[]>(page, 'controlPasskeys')).toHaveLength(1);
  if (shots)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      // The theme's colours ease in: the still is taken once they are there.
      await page.waitForTimeout(400);
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/passkeys-${theme}-devices.png` });
    }
  await page.emulateMedia({ colorScheme: 'light' });

  // Backed up and no passkey holds the backups' key yet: “one touch more”, with the touch right there.
  await fake(page, 'backup', c.device, 'protected');
  await page.goto(devices);
  await expect(section.getByText('Finish setting up your passkey', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(section.getByRole('button', { name: 'Finish setup', exact: true })).toBeVisible();
  // The Overview says it's set, and the touch is the one thing that needs you.
  await page.goto('/settings?tab=appliance');
  await expect(page.getByText('Finish setting up your passkey', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.locator('[data-needs-you]').getByRole('button', { name: 'Finish setup', exact: true }),
  ).toHaveCount(1);
  if (shots)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/passkeys-${theme}-overview.png` });
      await page.goto(devices);
      await expect(section.getByRole('button', { name: 'Finish setup', exact: true })).toBeVisible();
      await page.waitForTimeout(400);
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/passkeys-${theme}-devices-touch.png` });
      await page.goto('/settings?tab=appliance');
    }
  await page.emulateMedia({ colorScheme: 'light' });

  await newDevice(page);
  const before = Object.keys(
    (await fake<{ appliances: Record<string, { endpoints: Record<string, unknown> }> }>(page, 'state'))
      .appliances[c.device]?.endpoints ?? {},
  );
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username webauthn');
  if (shots)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      // The theme's colours ease in: the still is taken once they are there.
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/passkeys-${theme}-sign-in.png` });
    }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  // Straight into the Whombat: no list, no setup, no pairing.
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
  const after = (
    await fake<{ appliances: Record<string, { endpoints: Record<string, unknown> }> }>(page, 'state')
  ).appliances[c.device]?.endpoints;
  expect(Object.keys(after ?? {})).toHaveLength(before.length + 1);
  await page.goto(devices);
  await page.getByRole('button', { name: 'Passkey details', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'PASSKEYS' }).getByText('Set up this device', { exact: false }),
  ).toBeVisible();
});

test('no passkey and backups waiting show one setup action; it sets up all three uses', async ({ page }) => {
  const c = await setup(page);
  await authenticator(page);
  await noAutofill(page);
  await page.goto(devices);
  await expect(page.getByRole('region', { name: 'PASSKEYS' })).toBeVisible();
  await fake(page, 'backup', c.device, 'protected');
  await page.goto('/settings?tab=appliance');
  const needs = page.locator('[data-needs-you]');
  await expect(needs.getByRole('button', { name: 'Set up my passkey', exact: true })).toHaveCount(1);
  await expect(needs).not.toContainText('Touch');
  await expect(needs).not.toContainText('No passkey yet');
  if (shots)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({ path: `${SHOTS}/one-passkey-empty-${theme}.png`, animations: 'disabled' });
    }
  await needs.getByRole('button', { name: 'Set up my passkey', exact: true }).click();
  await expect(page.getByText('Passkey ready', { exact: true })).toBeVisible();
  expect(await fake<unknown[]>(page, 'controlPasskeys')).toHaveLength(1);
  expect(
    (await fake<{ removed?: boolean }[]>(page, 'passkeys', c.device)).filter((key) => !key.removed),
  ).toHaveLength(1);
  await page.goto(devices);
  await expect(
    page.getByRole('region', { name: 'PASSKEYS' }).getByText('Passkey ready', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish setup', exact: true })).toHaveCount(0);
});

test('removing local access relinks the account passkey without creating another', async ({ page }) => {
  const c = await setup(page);
  await authenticator(page);
  await noAutofill(page);
  await page.goto(devices);
  const section = page.getByRole('region', { name: 'PASSKEYS' });
  await section.getByRole('button', { name: 'Set up my passkey', exact: true }).click();
  await expect(section.getByText('Passkey ready', { exact: true })).toBeVisible();
  const accountKeys = await fake<{ id: string }[]>(page, 'controlPasskeys');
  expect(accountKeys).toHaveLength(1);
  await section.getByRole('button', { name: 'Passkey details', exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await section.getByRole('button', { name: /^Remove / }).click();
  await expect(section.getByText('Finish setting up your passkey', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Set up my passkey', exact: true })).toHaveCount(0);
  expect((await fake<{ id: string }[]>(page, 'controlPasskeys')).map((key) => key.id)).toEqual(
    accountKeys.map((key) => key.id),
  );
  await page.evaluate(() => {
    navigator.credentials.create = async () => {
      throw new Error('Local removal must reuse the account passkey');
    };
  });
  await section.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(section.getByText('Passkey ready', { exact: true })).toBeVisible();
  expect(
    (await fake<{ id: string; removed?: boolean }[]>(page, 'passkeys', c.device))
      .filter((key) => !key.removed)
      .map((key) => key.id),
  ).toEqual(accountKeys.map((key) => key.id));
  expect((await fake<{ id: string }[]>(page, 'controlPasskeys')).map((key) => key.id)).toEqual(
    accountKeys.map((key) => key.id),
  );
});

test('one shared passkey replaces the old credential and is reused for backups and repeated setup', async ({
  page,
}) => {
  const c = await setup(page);
  await authenticator(page);
  await noAutofill(page);
  await legacyPasskey(page, c.device);
  await page.goto(devices);
  const section = page.getByRole('region', { name: 'PASSKEYS' });
  await section.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(section).toContainText('You can delete their old items');
  const one = await fake<{ id: string; owner?: unknown }[]>(page, 'controlPasskeys');
  expect(one).toHaveLength(1);
  expect(one[0]?.owner).toBeTruthy();
  await page.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    let requests = 0;
    Object.defineProperty(window, 'passkeyRequests', { get: () => requests });
    navigator.credentials.get = async (options) => {
      requests++;
      if (requests > 1) throw new Error('Repeated setup must finish in one prompt');
      return get(options);
    };
    navigator.credentials.create = async () => {
      throw new Error('Setup must reuse the shared passkey');
    };
  });
  await section.getByRole('button', { name: 'Passkey details', exact: true }).click();
  await section.getByRole('button', { name: 'Check my passkey', exact: true }).click();
  await expect(section.getByRole('button', { name: 'Check my passkey', exact: true })).toBeEnabled();
  await expect(section).toContainText('Your passkey is ready');
  expect(await page.evaluate(() => (window as unknown as { passkeyRequests: number }).passkeyRequests)).toBe(
    1,
  );
  expect(await fake(page, 'controlPasskeys')).toEqual(one);
  await page.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (options) => get(options);
  });
  await fake(page, 'backup', c.device, 'protected');
  await page.goto(devices);
  await page.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    let requests = 0;
    Object.defineProperty(window, 'finishRequests', { get: () => requests });
    navigator.credentials.get = async (options) => {
      requests++;
      if (requests > 1) throw new Error('Finish setup must save and verify backups with one prompt');
      return get(options);
    };
    navigator.credentials.create = async () => {
      throw new Error('Finish setup must reuse the shared passkey');
    };
  });
  await section.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(section).toContainText('Your backups have been checked');
  expect(await page.evaluate(() => (window as unknown as { finishRequests: number }).finishRequests)).toBe(1);
  expect((await fake<{ id: string }[]>(page, 'controlPasskeys')).map((p) => p.id)).toEqual(
    one.map((p) => p.id),
  );
  if (shots)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/one-passkey-${theme}.png`, animations: 'disabled' });
    }
});

test('cancelling setup keeps the key; Finish saves and checks backups in one prompt', async ({ page }) => {
  const c = await setup(page);
  await authenticator(page);
  await noAutofill(page);
  await page.goto(devices);
  const section = page.getByRole('region', { name: 'PASSKEYS' });
  await section.getByRole('button', { name: 'Set up my passkey', exact: true }).click();
  await expect(section).toContainText('Your passkey is ready');
  await fake(page, 'backup', c.device, 'protected');
  await page.goto(devices);
  await page.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    const prompt = { requests: 0, cancelAt: 1, hold: false, release: () => {} };
    Object.assign(window, { passkeyPrompt: prompt });
    navigator.credentials.create = async () => {
      throw new Error('Must reuse the shared passkey');
    };
    navigator.credentials.get = async (options) => {
      prompt.requests++;
      if (prompt.hold)
        await new Promise<void>((resolve) => {
          prompt.release = resolve;
        });
      if (prompt.requests === prompt.cancelAt) throw new DOMException('Cancelled', 'NotAllowedError');
      return get(options);
    };
  });
  await section.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(section).toContainText('The check stopped');
  await expect(section).toContainText('existing access has been kept');
  expect(await fake<unknown[]>(page, 'controlPasskeys')).toHaveLength(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { passkeyPrompt: { requests: number } }).passkeyPrompt.requests,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    const prompt = (
      window as unknown as { passkeyPrompt: { requests: number; hold: boolean; cancelAt: number } }
    ).passkeyPrompt;
    prompt.requests = 0;
    prompt.cancelAt = 0;
    prompt.hold = true;
  });
  await section.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(section).toContainText('Whombat 1 of 1');
  await expect(section).toContainText('check access');
  await expect(section.getByRole('button', { name: 'Checking your passkey…', exact: true })).toBeDisabled();
  if (shots)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/one-passkey-checking-${theme}.png`, animations: 'disabled' });
    }
  await page.evaluate(() =>
    (window as unknown as { passkeyPrompt: { release: () => void } }).passkeyPrompt.release(),
  );
  await expect(section).toContainText('Your backups have been checked');
  expect(
    await page.evaluate(
      () => (window as unknown as { passkeyPrompt: { requests: number } }).passkeyPrompt.requests,
    ),
  ).toBe(1);
  expect(await fake<unknown[]>(page, 'controlPasskeys')).toHaveLength(1);
});

test('the autofill failing on load says nothing; the button says why (AP-804)', async ({ page }) => {
  // A browser without a passkey provider: the email field's conditional request fails at once.
  await page.addInitScript(() => {
    Object.defineProperty(window.PublicKeyCredential, 'isConditionalMediationAvailable', {
      value: async () => true,
    });
    Object.defineProperty(navigator.credentials, 'get', {
      value: async () => {
        throw new DOMException('Resident credentials are not supported at this time.', 'NotSupportedError');
      },
    });
  });
  await setup(page);
  await newDevice(page);
  await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username webauthn');
  await page.waitForTimeout(1000);
  await expect(page.getByText('Passkeys don’t work here', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByText('Passkeys don’t work here. Sign in with your email instead.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
});

for (const entry of ['Overview', 'Backups', 'Devices', 'Inbox'] as const) {
  test(`the only setup action reuses the same flow and preserves cancellation in ${entry}`, async ({
    page,
  }) => {
    const c = await setup(page);
    await authenticator(page);
    await noAutofill(page);
    await legacyPasskey(page, c.device);
    await page.goto(devices);
    await expect(page.getByRole('region', { name: 'PASSKEYS' })).toBeVisible();
    await fake(page, 'backup', c.device, 'protected');
    await page.goto(
      entry === 'Devices'
        ? devices
        : entry === 'Inbox'
          ? '/inbox'
          : `/settings?tab=appliance&section=${entry.toLowerCase()}`,
    );
    if (entry === 'Inbox') {
      await expect(page.locator('[data-needs-you-item]').first()).toBeVisible();
      // The fake box serves the fixture Inbox, so give its query the real passkey ask.
      const patched = await page.evaluate((href) => {
        const qc = window.__WHOMBAT__?.services.queryClient;
        if (!qc) throw new Error('The app has not opened');
        const item = {
          id: 'backup:passkey',
          ref: { kind: 'backup', id: 'passkey' },
          kind: 'backup',
          severity: 'info',
          nature: 'you',
          title: 'Set up your passkey',
          body: 'Check that your passkey unlocks your saved backup details.',
          at: new Date().toISOString(),
          actions: [{ id: 'passkey', label: 'Set up my passkey', style: 'primary', kind: 'open', href }],
          href,
        };
        const queries = qc.getQueryCache().findAll({ queryKey: ['whombat', 'home.overview'] });
        for (const q of queries)
          qc.setQueryData(q.queryKey, {
            ...(q.state.data as object),
            needsYou: [item],
            needsYouList: [item],
          });
        return queries.length;
      }, BACKUP_PASSKEY_HREF);
      expect(patched).toBeGreaterThan(0);
    }
    const line =
      entry === 'Devices'
        ? page.getByRole('region', { name: 'PASSKEYS' })
        : page.locator(
            entry === 'Inbox'
              ? '[data-needs-you-item="backup:passkey"]'
              : entry === 'Backups'
                ? '[data-backup-passkey]'
                : '[data-needs-you]',
          );
    await expect(line.getByRole('button', { name: 'Finish setup', exact: true })).toBeEnabled();
    // There is no initial sign-in-only touch or upgrade mode: this click starts the one setup ceremony.
    await page.evaluate(() => {
      const state = window as unknown as { upgradeCreates: number };
      state.upgradeCreates = 0;
      navigator.credentials.create = async () => {
        state.upgradeCreates++;
        throw new DOMException('Dismissed', 'NotAllowedError');
      };
    });
    await line.getByRole('button', { name: 'Finish setup', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { upgradeCreates: number }).upgradeCreates))
      .toBe(1);
    await expect(line.getByRole('button', { name: 'Finish setup', exact: true })).toBeEnabled();
    await expect(line).toContainText('The check stopped');
    if (shots)
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.getByRole('button', { name: 'Finish setup', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${SHOTS}/passkeys-${theme}-upgrade-${entry.toLowerCase()}.png`,
          animations: 'disabled',
        });
      }
    if (entry === 'Overview') {
      await page.getByRole('radio', { name: /^Backups/ }).press('Space');
      await expect(
        page.locator('[data-backup-passkey]').getByRole('button', { name: 'Finish setup', exact: true }),
      ).toBeVisible();
    }
    expect(await fake<unknown[]>(page, 'passkeys', c.device)).toHaveLength(1);
    expect(await fake<unknown[]>(page, 'controlPasskeys')).toHaveLength(1);
  });
}

test('a browser without WebAuthn offers no passkey (AP-804)', async ({ page }) => {
  await page.addInitScript(() => {
    // biome-ignore lint/suspicious/noExplicitAny: removing the global, as an old browser has none
    delete (window as any).PublicKeyCredential;
  });
  await fresh(page);
  await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'email');
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);
  await expect(page.getByText('Passkeys don’t work here', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Email me a link' })).toBeEnabled();
});

test('a passkey sign-in that stopped halfway leaves the passkey on the pairing screen (AP-806)', async ({
  page,
}) => {
  await setup(page);
  await authenticator(page);
  await noAutofill(page);
  await page.goto(devices);
  await page
    .getByRole('region', { name: 'PASSKEYS' })
    .getByRole('button', { name: 'Set up my passkey', exact: true })
    .click();
  await expect(page.getByText(/Your passkey (is ready|is saved)/).first()).toBeVisible();
  await newDevice(page);
  // The Whombat answers what the app has no words for: pinned from the passkey, not let in (John's Firefox).
  await fake(page, 'passkeyEnrollDown', true);
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByText('That didn’t work. Try again.')).toBeVisible({ timeout: 20_000 });
  expect(warnings.join('\n')).toContain('enroll.passkey: 400 invalid_input');
  await page.getByRole('button', { name: 'Set up this device another way' }).click();
  await expect(page.getByRole('heading', { name: 'Let this device in' })).toBeVisible();
  await fake(page, 'passkeyEnrollDown', false);
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
});

test('a challenge not bound to this device is refused before the authenticator is asked (PK-03)', async ({
  page,
}) => {
  await setup(page);
  await authenticator(page);
  await noAutofill(page);
  await page.goto(devices);
  await page
    .getByRole('region', { name: 'PASSKEYS' })
    .getByRole('button', { name: 'Set up my passkey', exact: true })
    .click();
  await expect(page.getByText(/Your passkey (is ready|is saved)/).first()).toBeVisible();
  await fake(page, 'passkeyChallenge', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await newDevice(page);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(
    page.getByText(
      'Whombat’s servers sent a sign-in request this device didn’t expect, so nothing was signed.',
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
});

test('the email field’s autofill offers the passkey: picking it opens the Whombat (conditional mediation)', async ({
  page,
}) => {
  const c = await setup(page);
  await authenticator(page);
  await page.goto(devices);
  await page
    .getByRole('region', { name: 'PASSKEYS' })
    .getByRole('button', { name: 'Set up my passkey', exact: true })
    .click();
  await expect(page.getByText(/Your passkey (is ready|is saved)/).first()).toBeVisible();
  await newDevice(page).catch(() => {});
  // The virtual authenticator picks the offered passkey by itself.
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
  const passkeys = await fake<{ lastUsedAt: string | null }[]>(page, 'passkeys', c.device);
  expect(passkeys[0]?.lastUsedAt).not.toBeNull();
});

test('control refusing the new passkey removes it on the Whombat again (PK-06)', async ({ page }) => {
  const c = await setup(page);
  await authenticator(page);
  await fake(page, 'controlPasskeyDown', true);
  await page.goto(devices);
  const section = page.getByRole('region', { name: 'PASSKEYS' });
  await section.getByRole('button', { name: 'Set up my passkey', exact: true }).click();
  await expect(
    section.getByText('Your Whombat saved the passkey but Whombat’s servers didn’t'),
  ).toBeVisible();
  const kept = await fake<{ removed: boolean }[]>(page, 'passkeys', c.device);
  expect(kept.map((p) => p.removed)).toEqual([true]);
  await expect(section.getByText('Set up your passkey', { exact: true })).toBeVisible();
});

test('the nudge uses the same full passkey setup, or Not now for good (PK-10)', async ({ page }) => {
  const c = await setup(page);
  await authenticator(page);
  const endpoint = Object.keys(
    (await fake<{ appliances: Record<string, { endpoints: Record<string, unknown> }> }>(page, 'state'))
      .appliances[c.device]?.endpoints ?? {},
  )[0] as string;
  // As if this browser had just been let in by pairing (`PASSKEY_NUDGE.due`).
  await page.evaluate(
    ([device, peer]) =>
      localStorage.setItem('whombat:passkey-nudge', JSON.stringify({ [`${device}|${peer}`]: 'due' })),
    [c.device, endpoint] as const,
  );
  await page.goto('/');
  const nudge = page.getByTestId('passkey-nudge');
  await expect(nudge).toContainText('One passkey to sign in');
  await expectBelowSignInNotice(page, nudge);
  if (shots)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      // The theme's colours ease in: the still is taken once they are there.
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/passkeys-${theme}-nudge.png` });
    }
  await page.emulateMedia({ colorScheme: 'light' });
  await nudge.getByRole('button', { name: 'Set up my passkey', exact: true }).click();
  await expect(nudge).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('passkey-nudge')).toHaveCount(0);
});

test('a device a passkey let in is told on the person’s other devices, under the other notices (PK-09)', async ({
  page,
}) => {
  const c = await setup(page);
  await authenticator(page);
  await page.goto(devices);
  await page
    .getByRole('region', { name: 'PASSKEYS' })
    .getByRole('button', { name: 'Set up my passkey', exact: true })
    .click();
  await expect(page.getByText(/Your passkey (is ready|is saved)/).first()).toBeVisible();
  // Mara's phone signs in with the passkey: this browser is told.
  await fake(page, 'passkeySignInElsewhere', c.device);
  await page.goto('/');
  const told = page.getByTestId('passkey-new-device');
  await expect(told).toContainText('New device signed in with a passkey: Pixel 9 · Android app');
  await expectBelowSignInNotice(page, told);
  if (shots)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/passkeys-${theme}-new-device.png` });
    }
  await page.emulateMedia({ colorScheme: 'light' });
  await told.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('region', { name: 'PASSKEYS' })).toBeVisible();
  await page.goto('/');
  await expect(page.locator('[data-screen]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('passkey-new-device')).toHaveCount(0);
});

test('Set up this device offers a passkey (shots only)', async ({ page }) => {
  test.skip(!shots, 'set PASSKEY_SHOTS=1 to write review screenshots');
  const c = await setup(page);
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage))
      if (k.startsWith('whombat:appliances:')) localStorage.removeItem(k);
  });
  await page.goto(`/appliances/${c.device}/setup`);
  await expect(page.getByRole('button', { name: 'Use a passkey' })).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    // The theme's colours ease in: the still is taken once they are there.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/passkeys-${theme}-setup.png` });
  }
});
