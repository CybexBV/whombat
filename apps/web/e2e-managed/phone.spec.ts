/**
 * Signing a phone in by QR code (CT-190, AP-521…AP-528): Settings → Phone app, the QR code, the fake phone
 * scanning it and asking to be let in (`phoneScan` / `phoneReport`), the fingerprint check and “Let it in”; forged
 * reports never let anything in; `/auth/phone` in a browser. `PHONE_SHOTS=<dir>` also writes review screenshots.
 */
import { expect, type Page, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

const DIR = process.env.PHONE_SHOTS ?? '';

async function toMobile(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  await claimAndSaveKit(page);
  // An old /mobile link: with a Whombat open it is Settings → Phone app, inside the app (SPL-23).
  await page.goto('/mobile');
  await expect(page.getByRole('heading', { name: 'Phone app', level: 1 })).toBeVisible();
  await expect(qr(page)).toBeVisible();
}

const card = (page: Page) => page.getByTestId('phone-signin');
const qr = (page: Page) => page.getByRole('img', { name: 'QR code that signs your phone in to Whombat' });

test('scan, compare the fingerprint, let the phone in', async ({ page }) => {
  await toMobile(page);
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/settings?tab=phone');
  await expect(page.getByRole('link', { name: 'Back to Settings' })).toBeVisible();
  await expect(page.getByTestId('phone-qr-countdown')).toHaveText(/^New code in [45]:\d\d$/);
  await expect(page.getByTestId('android-download')).toContainText('41 MB · Updates itself');
  await expect(page.getByRole('link', { name: 'Download for Android' })).toHaveAttribute(
    'href',
    /whombat-0\.16\.0\.apk$/,
  );
  // The code names the open Whombat and carries a key; only the page has it.
  const link = (await page.getByTestId('phone-qr').getAttribute('data-phone-link')) as string;
  expect(link).toMatch(/\/auth\/phone#t=[\w-]+&k=[\w-]{43}&d=[^&]+&p=12D3KooW/);

  expect(await fake<boolean>(page, 'phoneScan')).toBe(true);
  await expect(card(page).getByText('Your phone scanned the code')).toBeVisible();
  await expect(card(page).getByText(/^Waiting for it to ask /)).toBeVisible();

  expect(await fake<string>(page, 'phoneReport')).toMatch(/^\d{4}-\d{4}$/);
  const confirm = page.getByTestId('phone-confirm');
  await expect(confirm.getByRole('heading', { name: 'Let Pixel 9 in?' })).toBeFocused();
  await expect(confirm.getByTestId('phone-confirm-platform')).toHaveText('Android phone');
  await expect(confirm.getByTestId('phone-confirm-fingerprint')).toHaveText(
    /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/,
  );
  expect(await fake<boolean>(page, 'phoneLetIn')).toBe(false);

  await confirm.getByRole('button', { name: 'Let it in' }).click();
  await expect(page.getByRole('heading', { name: 'Pixel 9 is in' })).toBeVisible();
  expect(await fake<boolean>(page, 'phoneLetIn')).toBe(true);

  // Another phone: a fresh code.
  await page.getByRole('button', { name: 'Sign in another phone' }).click();
  await expect(qr(page)).toBeVisible();
  expect(await page.getByTestId('phone-qr').getAttribute('data-phone-link')).not.toBe(link);
});

test('a report that doesn’t check out lets nothing in and shows a new code', async ({ page }) => {
  await toMobile(page);
  const first = await page.getByTestId('phone-qr').getAttribute('data-phone-link');
  await fake(page, 'phoneScan');
  await fake(page, 'phoneReport', undefined, { tamper: 'mac' });
  await expect(
    card(page).getByText(/^That answer didn’t come from the phone that scanned the code/),
  ).toBeVisible();
  await expect(qr(page)).toBeVisible();
  expect(await page.getByTestId('phone-qr').getAttribute('data-phone-link')).not.toBe(first);

  // A valid MAC over a fingerprint the Whombat doesn't know for that code: refused after the look-up.
  await fake(page, 'phoneScan');
  await fake(page, 'phoneReport', undefined, { tamper: 'fingerprint' });
  await expect(page.getByTestId('phone-confirm')).toHaveCount(0);
  await expect(card(page).getByText(/^That answer didn’t come from the phone/)).toBeVisible();
  expect(await fake<boolean>(page, 'phoneLetIn')).toBe(false);
});

test('“Not my phone” lets nothing in', async ({ page }) => {
  await toMobile(page);
  await fake(page, 'phoneScan');
  await fake(page, 'phoneReport');
  await page.getByRole('button', { name: 'Not my phone' }).click();
  await expect(card(page).getByText('Not let in. Here’s a new code.')).toBeVisible();
  await expect(qr(page)).toBeVisible();
  expect(await fake<boolean>(page, 'phoneLetIn')).toBe(false);
});

test('/auth/phone in a browser: open in the app, get the app; the fragment leaves the address bar', async ({
  page,
}) => {
  await fresh(page);
  const fragment = 't=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
  await page.goto(`/auth/phone#${fragment}`);
  await expect(page.getByRole('heading', { name: 'Open this with the Whombat app' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in the Whombat app' })).toHaveAttribute(
    'href',
    `whombat://auth/phone#${fragment}`,
  );
  await expect(page.getByTestId('android-download')).toContainText('41 MB · Updates itself');
  expect(new URL(page.url()).hash).toBe('');
  // Nothing redeemed it.
  expect(await fake<{ state: string }[]>(page, 'phoneHandoffs')).toEqual([]);

  // Without a (valid) code: says so, and still offers the app.
  await page.goto('/auth/phone');
  await expect(page.getByText(/^This link is incomplete or already used/)).toBeVisible();
});

test('no APK published: a calm note', async ({ page }) => {
  await toMobile(page);
  await fake(page, 'androidDownload', null);
  await page.reload();
  await expect(page.getByTestId('android-download')).toContainText(
    'The Android app isn’t published here yet.',
  );
  await expect(page.getByRole('link', { name: 'Download for Android' })).toHaveCount(0);
});

/* Review screenshots (not baselines) ------------------------------------------------------------------------ */

for (const size of ['desktop', 'phone'] as const)
  for (const theme of ['light', 'dark'] as const)
    test(`review screenshots (${size}, ${theme})`, async ({ page }) => {
      test.skip(!DIR, 'set PHONE_SHOTS=<dir> to write review screenshots');
      test.setTimeout(120_000);
      if (size === 'phone') await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const shot = (name: string) =>
        page.screenshot({ path: `${DIR}/${size}-${theme}-${name}.png`, fullPage: size === 'phone' });
      await toMobile(page);
      await shot('1-qr');
      await fake(page, 'phoneScan');
      await expect(card(page).getByText('Your phone scanned the code')).toBeVisible();
      await shot('2-scanned');
      await fake(page, 'phoneReport');
      await expect(page.getByTestId('phone-confirm')).toBeVisible();
      await shot('3-confirm');
      await page.getByRole('button', { name: 'Let it in' }).click();
      await expect(page.getByTestId('phone-success')).toBeVisible();
      await shot('4-success');
      await page.getByRole('button', { name: 'Sign in another phone' }).click();
      await expect(qr(page)).toBeVisible();
      await fake(page, 'phoneScan');
      await fake(page, 'phoneReport', undefined, { tamper: 'mac' });
      await expect(card(page).getByText(/^That answer didn’t come/)).toBeVisible();
      await expect(qr(page)).toBeVisible();
      await shot('5-refused');
      await fake(page, 'androidDownload', null);
      await page.reload();
      await expect(qr(page)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('android-download')).toContainText('isn’t published here yet');
      await shot('6-no-download');
      await fake(page, 'controlDown', true);
      await expect(card(page).getByText(/^Couldn’t reach Whombat’s service/)).toBeVisible({
        timeout: 20_000,
      });
      await shot('7-error');
      await fake(page, 'controlDown', false);
      await fake(page, 'androidDownload', undefined);
      await page.goto(
        '/auth/phone#t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      );
      await expect(page.getByRole('heading', { name: 'Open this with the Whombat app' })).toBeVisible();
      await expect(page.getByTestId('android-download')).toContainText('41 MB · Updates itself');
      await shot('8-auth-phone');
    });
