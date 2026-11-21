/**
 * The machine's sections, which have no mock, as screenshot baselines (`__screenshots__/machine.spec.ts/`), light and
 * dark, 1440×900 (hardware-support-web.md AP-3223…AP-3230; reviewed against SCREEN and DIAGNOSTICS when taken):
 * - This Whombat → Overview → NETWORK on the Z13-like laptop (the cable, “Wi-Fi · Home · Strong signal”, two saved
 *   networks) and on the PC whose Wi-Fi card has no driver (See hardware);
 * - Join a Wi-Fi network: the networks nearby (bars, locks, Connected, the company and WEP networks disabled with their
 *   reasons, Other network…), and Neighbours' form with its password and the guard's note;
 * - Wi-Fi only (network-move-app.md): Use Wi-Fi only's question, NETWORK while the six servers find
 *   the new address (3 of 6), and once all have (Cable · Switched off with Use the cable again, the change that worked,
 *   the router tip);
 * - About → HARDWARE on the laptop (every group) and on the PC (its two problems first);
 * - BLUETOOTH (bluetooth-web.md AP-3711…AP-3716) on the laptop (Keychron K3 connected with its battery, WH-1000XM5 not
 *   connected, Add a device) and on the PC whose Bluetooth is switched off; Add a device: the devices found while it
 *   looks, Pairing with…, a keyboard's code with two digits typed, the question, ready, and a refusal with Try again;
 *   Remove's question.
 * The machine is picked before the page loads (`whombat:fixture-machine`, `machineFixtures.ts`); each shot is the
 * section or the dialog alone, so what changes elsewhere on the page doesn't move them. The clock stands still, so
 * Bluetooth's fake goes on only when a test moves it (`window.__WHOMBAT_BLUETOOTH__.advance`).
 */
import type { Page } from '@playwright/test';
import { FROZEN_NOW } from '@whombat/visual-tools';
import { expect, neutraliseWorld, openApp, settle, THEMES, test } from './support/harness';

async function open(
  page: Page,
  theme: 'light' | 'dark',
  machine: 'z13' | 'nodriver',
  part: 'overview' | 'about',
) {
  await page.addInitScript((m) => localStorage.setItem('whombat:fixture-machine', m), machine);
  await openApp(page, { path: `/settings?tab=appliance&section=${part}`, theme });
  await page.locator('h1').first().waitFor();
  await neutraliseWorld(page);
}

/** Moves the fixture machine's Bluetooth on by `ms` (what it found, the digits typed, the pairing's end). */
async function advanceBluetooth(page: Page, ms: number) {
  await page.evaluate((t) => {
    (
      window as unknown as { __WHOMBAT_BLUETOOTH__: { advance(ms: number): void } }
    ).__WHOMBAT_BLUETOOTH__.advance(t);
  }, ms);
}

/** Add a device, open, with every device the laptop finds listed. */
async function addDevice(page: Page) {
  await page.getByRole('button', { name: 'Add a device' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Looking for devices…').waitFor();
  await advanceBluetooth(page, 5_000);
  await dialog.getByRole('button', { name: /^Xbox Wireless Controller/ }).waitFor();
  return dialog;
}

for (const theme of THEMES) {
  test(`NETWORK, laptop (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'overview');
    const section = page.locator('section[data-network]');
    await section.getByText('Wi-Fi · Home · Strong signal').waitFor();
    await settle(page);
    await expect(section).toHaveScreenshot(`network-laptop-${theme}.png`);
  });

  test(`NETWORK, no driver (${theme})`, async ({ page }) => {
    await open(page, theme, 'nodriver', 'overview');
    const section = page.locator('section[data-network]');
    await section.getByText('This Wi-Fi card has no driver yet.').waitFor();
    await settle(page);
    await expect(section).toHaveScreenshot(`network-no-driver-${theme}.png`);
  });

  test(`Join a Wi-Fi network (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'overview');
    await page.getByRole('button', { name: 'Join a Wi-Fi network' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^Old Router/ }).waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`wifi-list-${theme}.png`);
    await dialog.getByRole('button', { name: /^Neighbours/ }).click();
    await dialog.getByLabel('Password').waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(dialog).toHaveScreenshot(`wifi-password-${theme}.png`);
  });

  test(`Use Wi-Fi only (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'overview');
    await page.getByRole('button', { name: 'Use Wi-Fi only' }).click();
    const dialog = page.getByRole('dialog', { name: 'Use Wi-Fi only?' });
    await dialog.getByText(/2 minutes/).waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(dialog).toHaveScreenshot(`wifi-only-ask-${theme}.png`);
  });

  test(`NETWORK, Wi-Fi only and the servers' move (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'overview');
    await page.getByRole('button', { name: 'Use Wi-Fi only' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Use Wi-Fi only' }).click();
    const section = page.locator('section[data-network]');
    await section.getByText('Moving to Wi-Fi…').waitFor();
    // The fake's change and move follow the page's clock: switched after 4.5 s, a server found every 2.5 s.
    await page.clock.setFixedTime(FROZEN_NOW.getTime() + 8_000);
    await section.getByText('3 of 6 servers found Burrow HQ’s new address.').waitFor({ timeout: 10_000 });
    await settle(page);
    await expect(section).toHaveScreenshot(`network-moving-${theme}.png`);
    await page.clock.setFixedTime(FROZEN_NOW.getTime() + 20_000);
    await section.getByText(/^All your servers found/).waitFor({ timeout: 10_000 });
    await settle(page);
    await expect(section).toHaveScreenshot(`network-wifi-only-${theme}.png`);
  });

  test(`HARDWARE, laptop (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'about');
    const section = page.locator('section[data-hardware]');
    // Every part with its driver is folded under one button.
    await section.getByRole('button', { name: 'Show every part' }).click();
    await section.getByText('ELAN9008 touchscreen').waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(section).toHaveScreenshot(`hardware-laptop-${theme}.png`);
  });

  test(`HARDWARE, no driver (${theme})`, async ({ page }) => {
    await open(page, theme, 'nodriver', 'about');
    const section = page.locator('section[data-hardware]');
    await section.getByText('This Bluetooth adapter is switched off.').waitFor();
    await settle(page);
    await expect(section).toHaveScreenshot(`hardware-no-driver-${theme}.png`);
  });

  test(`BLUETOOTH, laptop (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'overview');
    const section = page.locator('section[data-bluetooth]');
    await section.getByText('Connected · Battery 80 %').waitFor();
    await settle(page);
    await expect(section).toHaveScreenshot(`bluetooth-laptop-${theme}.png`);
  });

  test(`BLUETOOTH, switched off (${theme})`, async ({ page }) => {
    await open(page, theme, 'nodriver', 'overview');
    const section = page.locator('section[data-bluetooth]');
    await section.getByText('Bluetooth is switched off.').waitFor();
    await settle(page);
    await expect(section).toHaveScreenshot(`bluetooth-off-${theme}.png`);
  });

  test(`Add a device: looking, pairing, ready (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'overview');
    const dialog = await addDevice(page);
    await settle(page);
    await expect(dialog).toHaveScreenshot(`bluetooth-list-${theme}.png`);
    await dialog.getByRole('button', { name: /^MX Master 3S/ }).click();
    await dialog.getByText('Pairing with MX Master 3S…').waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`bluetooth-pairing-${theme}.png`);
    await advanceBluetooth(page, 3_000);
    await dialog.getByText('MX Master 3S is ready.').waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`bluetooth-ready-${theme}.png`);
  });

  test(`Add a device: a keyboard's code (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'overview');
    const dialog = await addDevice(page);
    await dialog.getByRole('button', { name: /^Magic Keyboard/ }).click();
    await dialog.getByText('Pairing with Magic Keyboard…').waitFor();
    // 1.5 s to the code, then a digit every 0.7 s: two typed.
    await advanceBluetooth(page, 3_000);
    await dialog.getByText(/^Type 482913 on Magic Keyboard/).waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`bluetooth-code-${theme}.png`);
  });

  test(`Add a device: the question (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'overview');
    const dialog = await addDevice(page);
    await dialog.getByRole('button', { name: /^Pebble Keys 2/ }).click();
    await dialog.getByText('Pairing with Pebble Keys 2…').waitFor();
    await advanceBluetooth(page, 2_000);
    await dialog.getByText('Does Pebble Keys 2 show 482913?').waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`bluetooth-confirm-${theme}.png`);
  });

  test(`Add a device: refused (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'overview');
    const dialog = await addDevice(page);
    await dialog.getByRole('button', { name: /^Xbox Wireless Controller/ }).click();
    await dialog.getByText('Pairing with Xbox Wireless Controller…').waitFor();
    await advanceBluetooth(page, 2_000);
    await dialog.getByText(/didn’t accept the pairing/).waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`bluetooth-failed-${theme}.png`);
  });

  test(`Remove a device (${theme})`, async ({ page }) => {
    await open(page, theme, 'z13', 'overview');
    const section = page.locator('section[data-bluetooth]');
    const actions = section.getByRole('button', { name: 'Actions for WH-1000XM5' });
    // The menu closes when the page scrolls: in view first, then the click.
    await actions.scrollIntoViewIfNeeded();
    await settle(page);
    await actions.click();
    await page.getByRole('menuitem', { name: 'Remove…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('You’ll need to pair it again to use it.').waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`bluetooth-remove-${theme}.png`);
  });
}
