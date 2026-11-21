/**
 * The appliance identity pin (MA-24, AP-63…AP-69) against a directory that lies: the fake control reports another
 * identity for the Whombat (`lieAbout`), the box keeps its own. A browser connects only with the identity it pinned
 * from the claim, a recovery kit or an add-a-device link; a pin that differs from the directory is a hard stop, and
 * nothing connects before that is settled. No invite links any more (one-person.md AP-5675).
 */
import { expect, type Page, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

/** Burrow screens are burrow-less (AP-360); the open appliance's burrow is the one they show. */
const B = '';
const REGISTRY = 'whombat:appliances:acc_mara';

async function setup(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  return claimAndSaveKit(page);
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

/** The connections this page attempted to a device since it loaded. */
async function connectsTo(page: Page, device: string) {
  const all = await fake<{ device: string; peerId: string; channel: string }[]>(page, 'connects');
  return all.filter((c) => c.device === device);
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

async function addDeviceLink(page: Page): Promise<string> {
  await page.goto(`${B}/settings?tab=appliance#devices`);
  // Add a computer opens the link's steps under the DEVICES list (this-whombat-sections.md AP-1229); the link itself is
  // folded under Copy the link.
  await page.getByTestId('add-device').getByRole('button', { name: 'Add a computer' }).click();
  const panel = page.getByTestId('add-device-link');
  await expect(panel.getByText('It lets nothing in by itself.', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy the link' })).toBeVisible();
  await panel.getByText('Show the link').click();
  return panel.getByRole('textbox').inputValue();
}

test('open from the list: a directory that names another identity is a hard stop, and nothing connects', async ({
  page,
}) => {
  const c = await setup(page);
  const real = await fake<string>(page, 'peerOf', c.device);
  expect(await pinOf(page, c.device)).toMatchObject({ peerId: real, pinSource: 'claim' });
  await fake(page, 'lieAbout', c.device, true);
  await page.goto('/appliances');
  await page.getByRole('button', { name: 'Open Burrow HQ' }).click();
  await expect(page.getByRole('heading', { name: 'This Whombat’s identity has changed' })).toBeVisible();
  await expect(
    page.getByText('Someone could be trying to intercept your connection.', { exact: false }),
  ).toBeVisible();
  expect(await connectsTo(page, c.device)).toEqual([]);
  // The pin is never updated from the directory.
  expect(await pinOf(page, c.device)).toMatchObject({ peerId: real, pinSource: 'claim' });

  // A link naming the Whombat stops the same way.
  await page.goto(`/appliances/${c.device}/burrow-hq/pr/482`);
  await expect(page.getByRole('heading', { name: 'This Whombat’s identity has changed' })).toBeVisible();
  expect(await connectsTo(page, c.device)).toEqual([]);

  // Forgetting it on this device is explicit; then it has to be set up again through a trusted path.
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Forget this Whombat on this device' }).click();
  await expect(page.getByRole('heading', { name: 'Pick a Whombat' })).toBeVisible();
  expect(await pinOf(page, c.device)).toBeUndefined();
  await page.getByRole('button', { name: 'Open Burrow HQ' }).click();
  await expect(page.getByRole('heading', { name: 'Set up this device' })).toBeVisible();
  expect(await connectsTo(page, c.device)).toEqual([]);
});

test('a pinned browser keeps connecting to the identity it pinned, whatever the directory says', async ({
  page,
}) => {
  const c = await setup(page);
  const real = await fake<string>(page, 'peerOf', c.device);
  await fake(page, 'lieAbout', c.device, true);
  await page.goto(`${B}/pr/482`);
  await expect(page.getByRole('textbox', { name: 'Comment on PR #482' })).toBeVisible({ timeout: 15_000 });
  const tried = await connectsTo(page, c.device);
  expect(tried.length).toBeGreaterThan(0);
  expect(tried.every((t) => t.peerId === real)).toBe(true);
});

test('a browser that never knew the Whombat: set up this device, never a connection to the directory’s identity', async ({
  page,
}) => {
  const c = await setup(page);
  await asNewBrowser(page);
  await page.goto('/appliances');
  await page.getByRole('button', { name: 'Open Burrow HQ' }).click();
  await expect(page.getByRole('heading', { name: 'Set up this device' })).toBeVisible();
  await expect(page.getByText('A link from a device that’s already set up', { exact: false })).toBeVisible();
  await page.getByLabel('Paste a link').fill('https://example.com/nothing');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('That isn’t a link to set up this device.', { exact: false })).toBeVisible();
  // Asking to be let in directly doesn't get around it either.
  await page.goto(`/appliances/${c.device}/pair`);
  await expect(page.getByRole('heading', { name: 'Set up this device' })).toBeVisible();
  expect(await connectsTo(page, c.device)).toEqual([]);
  expect(await pinOf(page, c.device)).toBeUndefined();
});

test('add a device: the link pins the identity and continues into pairing; a lying directory stops it', async ({
  page,
}) => {
  const c = await setup(page);
  const link = await addDeviceLink(page);
  expect(link).toBe(
    `${new URL(page.url()).origin}/appliances/${c.device}/add#p=${await fake<string>(page, 'peerOf', c.device)}`,
  );
  await asNewBrowser(page);
  await fake(page, 'lieAbout', c.device, true);
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'This link doesn’t match your Whombat' })).toBeVisible({
    timeout: 15_000,
  });
  expect(await connectsTo(page, c.device)).toEqual([]);

  await fake(page, 'lieAbout', c.device, false);
  await page.goto('/appliances');
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Let this device in' })).toBeVisible({ timeout: 15_000 });
  expect(page.url()).not.toContain('#p=');
  expect(await pinOf(page, c.device)).toMatchObject({ pinSource: 'add-link' });
  await page.getByRole('button', { name: 'Show a code' }).click();
  await expect(page.getByTestId('pairing-code')).toBeVisible({ timeout: 10_000 });
  await fake(page, 'approveMyPairing', c.device);
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible({ timeout: 15_000 });
});

test('the add-a-device link pasted on the set-up screen', async ({ page }) => {
  const c = await setup(page);
  const link = await addDeviceLink(page);
  await asNewBrowser(page);
  await page.goto(`/appliances/${c.device}/setup`);
  await page.getByLabel('Paste a link').fill(link);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Let this device in' })).toBeVisible({ timeout: 15_000 });
  expect(await pinOf(page, c.device)).toMatchObject({ pinSource: 'add-link' });
});

test('recovery kit version 2: a new browser pins the identity from the kit; a lying directory stops it', async ({
  page,
}) => {
  const c = await setup(page);
  const real = await fake<string>(page, 'peerOf', c.device);
  expect(c.kitText).toContain(`Appliance identity: ${real}`);
  await asNewBrowser(page);
  await fake(page, 'lieAbout', c.device, true);
  await page.goto(`/appliances/${c.device}/recover`);
  await page.getByLabel('Open the kit file').setInputFiles({
    name: 'kit.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(c.kitText),
  });
  await page.getByRole('button', { name: 'Let this device in' }).click();
  await expect(
    page.getByRole('heading', { name: 'This recovery kit doesn’t match your Whombat' }),
  ).toBeVisible();
  expect(await connectsTo(page, c.device)).toEqual([]);

  await fake(page, 'lieAbout', c.device, false);
  await page.goto('/appliances');
  await page.getByRole('button', { name: /^Lost access\? Use your recovery kit/ }).click();
  await page.getByLabel('Open the kit file').setInputFiles({
    name: 'kit.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(c.kitText),
  });
  await page.getByRole('button', { name: 'Let this device in' }).click();
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible({ timeout: 15_000 });
  expect(await pinOf(page, c.device)).toMatchObject({ peerId: real, pinSource: 'kit' });
});

test('recovery kit version 1: refused on a browser that never knew the Whombat; a damaged kit is caught', async ({
  page,
}) => {
  const c = await setup(page);
  const v1 = c.kitText
    .split('\n')
    .filter((l) => !/^(Kit version|Appliance identity|Checksum): /.test(l))
    .join('\n');
  await asNewBrowser(page);
  await page.goto(`/appliances/${c.device}/recover`);
  await page.getByLabel('Open the kit file').setInputFiles({
    name: 'old-kit.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(v1),
  });
  await page.getByRole('button', { name: 'Let this device in' }).click();
  await expect(
    page.getByText('Make a new kit from a device that’s still set up (Settings → This Whombat → Backups)', {
      exact: false,
    }),
  ).toBeVisible();
  expect(await connectsTo(page, c.device)).toEqual([]);

  await page.getByLabel('Open the kit file').setInputFiles({
    name: 'edited-kit.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(c.kitText.replace('Whombat: ', 'Whombat: X')),
  });
  await expect(page.getByText('That kit file is damaged or was changed.', { exact: false })).toBeVisible();
});
