// See live.config.ts. Exercises pages and every console protocol against the
// test environment (theirs: set the guest ids for yours).
import { expect, test, type Page } from '@playwright/test';

const shot = (name: string) => `.screenshots/live-${name}.png`;
const consolePath = (server: string, guest: string, query = '') =>
  `/servers/${server}/guests/${encodeURIComponent(guest)}/console${query}`;

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('User name').fill(process.env.RACKOON_LIVE_USER ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env.RACKOON_LIVE_PASS ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

test.beforeEach(async ({ page }) => login(page));

test('overview with real hosts', async ({ page }) => {
  await expect(page.getByText(/3 servers/)).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot('overview'), fullPage: true });
});

for (const [name, path] of [
  ['thetitan', '/servers/thetitan'],
  ['thetitan-incus', '/servers/thetitan?platform=incus'],
  ['libvirt', '/servers/rackoon-libvirt?platform=libvirt'],
  ['pve', '/servers/rackoon-pve'],
  ['pve-lxc', '/servers/rackoon-pve?platform=ct'],
] as const) {
  test(`detail page ${name}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: shot(`detail-${name}`), fullPage: true });
  });
}

const consoles: [string, string, string, string][] = [
  ['incus-ct-shell', 'thetitan', 'incus:rackoon-test-ct', '?platform=incus&protocol=shell'],
  ['incus-ct-tty', 'thetitan', 'incus:rackoon-test-ct', '?platform=incus&protocol=tty'],
  ['incus-vm-spice', 'thetitan', 'incus:rackoon-test-vm', '?platform=incus&protocol=spice'],
  ['incus-vm-serial', 'thetitan', 'incus:rackoon-test-vm', '?platform=incus&protocol=serial'],
  ['libvirt-vnc', 'rackoon-libvirt', 'libvirt:vm-vnc', '?platform=libvirt&protocol=vnc'],
  ['libvirt-serial', 'rackoon-libvirt', 'libvirt:vm-vnc', '?platform=libvirt&protocol=serial'],
  ['libvirt-spice', 'rackoon-libvirt', 'libvirt:vm-spice', '?platform=libvirt&protocol=spice'],
  ['pve-vnc', 'rackoon-pve', 'pve:100', '?platform=vm&protocol=vnc'],
  ['pve-serial', 'rackoon-pve', 'pve:100', '?platform=vm&protocol=serial'],
  ['pve-spice', 'rackoon-pve', 'pve:101', '?platform=vm&protocol=spice'],
  ['pve-lxc-shell', 'rackoon-pve', 'pve:200', '?platform=ct&protocol=shell'],
  ['pve-lxc-tty', 'rackoon-pve', 'pve:200', '?platform=ct&protocol=tty'],
];

for (const [name, server, guest, query] of consoles) {
  test(`console ${name}`, async ({ page }) => {
    await page.goto(consolePath(server, guest, query));
    await expect(page.getByText(/^Connected/).first()).toBeVisible({ timeout: 30_000 });
    const rows = page.locator('.xterm-rows');
    if (name.endsWith('shell')) {
      await page.getByRole('group', { name: /screen$/ }).click();
      await expect(rows).toContainText(/[#$] *$/, { timeout: 15_000 }); // prompt: typeahead before it may be flushed
      await page.keyboard.type('echo rackoon-e2e-$((6*7))\n');
      await expect(rows).toContainText('rackoon-e2e-42', { timeout: 15_000 });
    } else if (name.includes('serial') || name.endsWith('tty')) {
      await page.getByRole('group', { name: /screen$/ }).click();
      // The serial line only redraws on input; retry until the attach is complete.
      await expect(async () => {
        await page.keyboard.press('Enter');
        await expect(rows).toContainText(/login|#|\$/, { timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
    } else {
      await page.waitForTimeout(4000); // let the framebuffer arrive
    }
    await page.screenshot({ path: shot(`console-${name}`), fullPage: false });
  });
}

test('screens wall (Proxmox VMs)', async ({ page }) => {
  await page.goto('/servers/rackoon-pve?platform=vm&view=screens');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: shot('screens-pve'), fullPage: true });
});

test('power action with confirmation: restart rackoon-test-ct', async ({ page }) => {
  await page.goto(consolePath('thetitan', 'incus:rackoon-test-ct', '?platform=incus&protocol=shell'));
  await expect(page.getByText(/^Connected/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('toolbar').getByRole('button', { name: /^Restart/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('rackoon-test-ct');
  await page.screenshot({ path: shot('action-confirm'), fullPage: false });
  await dialog.getByRole('button', { name: /^Restart rackoon-test-ct/ }).click();
  const pending = page.getByText('Restarting…');
  await expect(pending).toBeVisible();
  await expect(pending).toBeHidden({ timeout: 60_000 }); // action.finished arrived
  await expect(page.getByText(/^Connected|Reconnect/).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: shot('action-done'), fullPage: false });
});
