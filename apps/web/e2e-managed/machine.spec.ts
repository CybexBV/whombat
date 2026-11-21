/**
 * The machine over the session (hardware-support-web.md AP-3223…AP-3231; bluetooth-web.md AP-3711…AP-3717): on a
 * Z13-like laptop you join a Wi-Fi network (a wrong password first), forget one, and see a join to a network
 * without internet go back once the cable is out; pair a mouse and a keyboard that wants a code, connect headphones
 * and remove a keyboard; About's HARDWARE downloads the report — `host.network`, `host.wifi.*`, `host.bluetooth*` and
 * `host.hardware` through the fake world's machine. A box without a machine shows none of the sections.
 */
import { expect, type Page, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

type Saved = { connected: string | null; saved: { ssid: string }[] } | null;
type Paired = { devices: { name: string; connected: boolean }[] } | null;

async function setup(page: Page, machine: 'z13' | 'nodriver' | null) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  const c = await claimAndSaveKit(page);
  await fake(page, 'machine', c.device, machine);
  return c;
}

test('join a Wi-Fi network, forget one, and a join that goes back', async ({ page }) => {
  test.setTimeout(90_000);
  const c = await setup(page, 'z13');
  await page.goto('/settings?tab=appliance');
  const network = page.locator('section[data-network]');
  await expect(network.getByText('Wi-Fi · Home · Strong signal')).toBeVisible({ timeout: 20_000 });
  await expect(network.getByText('Cable · Connected')).toBeVisible();

  await network.getByRole('button', { name: 'Join a Wi-Fi network' }).click();
  // The dialog takes the chosen network's name as its title.
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^Neighbours/ }).click();
  await dialog.getByLabel('Password').fill('not the password');
  await dialog.getByRole('button', { name: 'Join' }).click();
  await expect(dialog.getByRole('alert')).toContainText('That password didn’t work.', { timeout: 10_000 });
  await dialog.getByLabel('Password').fill('correct horse battery');
  await dialog.getByRole('button', { name: 'Join' }).click();
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(network.getByText('Wi-Fi · Neighbours · Good signal')).toBeVisible();
  expect((await fake<Saved>(page, 'machineNetwork', c.device))?.connected).toBe('Neighbours');

  await network.getByRole('button', { name: 'Forget Office' }).click();
  await page
    .getByRole('dialog', { name: 'Forget “Office”?' })
    .getByRole('button', { name: 'Forget' })
    .click();
  await expect(network.getByRole('button', { name: 'Forget Office' })).toHaveCount(0, { timeout: 15_000 });

  // Without the cable the box depends on the Wi-Fi: a network without internet is undone.
  await fake(page, 'machineCable', c.device, false);
  await network.getByRole('button', { name: 'Join a Wi-Fi network' }).click();
  await dialog.getByRole('button', { name: /^Café Wombat/ }).click();
  await dialog.getByRole('button', { name: 'Join' }).click();
  await expect(
    dialog.getByText(/couldn’t reach the internet there, so it went back to Neighbours\./),
  ).toBeVisible({
    timeout: 20_000,
  });
  expect((await fake<Saved>(page, 'machineNetwork', c.device))?.connected).toBe('Neighbours');
});

test('pair a mouse and a keyboard with a code, connect headphones, remove a keyboard', async ({ page }) => {
  test.setTimeout(90_000);
  const c = await setup(page, 'z13');
  await page.goto('/settings?tab=appliance');
  const bluetooth = page.locator('section[data-bluetooth]');
  await expect(bluetooth.getByText('Connected · Battery 80 %')).toBeVisible({ timeout: 20_000 });

  const dialog = page.getByRole('dialog');
  await bluetooth.getByRole('button', { name: 'Add a device' }).click();
  await dialog.getByRole('button', { name: /^MX Master 3S/ }).click({ timeout: 15_000 });
  await expect(dialog.getByText('MX Master 3S is ready.')).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(bluetooth.getByText('MX Master 3S')).toBeVisible();

  await bluetooth.getByRole('button', { name: 'Add a device' }).click();
  await dialog.getByRole('button', { name: /^Magic Keyboard/ }).click({ timeout: 15_000 });
  await expect(dialog.getByText(/^Type \d{6} on Magic Keyboard, then press Enter\.$/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.getByText('Magic Keyboard is ready.')).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Done' }).click();

  // A row's menu closes when the page scrolls: in view first.
  const menu = async (name: string, item: string) => {
    const button = bluetooth.getByRole('button', { name: `Actions for ${name}` });
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  await menu('WH-1000XM5', 'Connect');
  await expect
    .poll(
      async () =>
        (await fake<Paired>(page, 'machineBluetooth', c.device))?.devices.find((d) => d.name === 'WH-1000XM5')
          ?.connected,
    )
    .toBe(true);
  await menu('Keychron K3', 'Remove…');
  await page
    .getByRole('dialog', { name: 'Remove Keychron K3?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(bluetooth.getByText('Keychron K3')).toHaveCount(0, { timeout: 15_000 });
  expect((await fake<Paired>(page, 'machineBluetooth', c.device))?.devices.map((d) => d.name).sort()).toEqual(
    ['MX Master 3S', 'Magic Keyboard', 'WH-1000XM5'],
  );
});

test('a Wi-Fi card without a driver, Bluetooth switched off, and the hardware report', async ({ page }) => {
  await setup(page, 'nodriver');
  await page.goto('/settings?tab=appliance');
  await expect(page.locator('section[data-bluetooth]').getByText('Bluetooth is switched off.')).toBeVisible({
    timeout: 20_000,
  });
  const network = page.locator('section[data-network]');
  await expect(network.getByText('This Wi-Fi card has no driver yet.')).toBeVisible({ timeout: 20_000 });
  await network.getByRole('button', { name: 'See hardware' }).click();
  const hardware = page.locator('section[data-hardware]');
  await expect(hardware.getByText('Minisforum MS-A1')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    hardware.getByRole('button', { name: 'Download report' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^whombat-hardware-\d{4}-\d{2}-\d{2}\.txt$/);
});

test('a box without a machine shows none of the sections', async ({ page }) => {
  await setup(page, null);
  await page.goto('/settings?tab=appliance');
  await expect(page.getByRole('heading', { name: 'AT A GLANCE' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('section[data-network]')).toHaveCount(0);
  await expect(page.locator('section[data-bluetooth]')).toHaveCount(0);
  await page.goto('/settings?tab=appliance&section=about');
  await expect(page.getByRole('heading', { name: 'VERSION' })).toBeVisible();
  await expect(page.locator('section[data-hardware]')).toHaveCount(0);
});
