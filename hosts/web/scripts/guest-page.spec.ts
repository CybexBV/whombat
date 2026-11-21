// The guest page in fixture mode (docs/MANAGE.md, UI): open by URL, edit
// with the review step and the pending-changes banner, add and resize
// disks, tags, cloud-init SSH keys, Incus limits, read-only keys, a
// conflicting change and the hub's field errors; axe scans and
// screenshots (web/.screenshots/guest-*.png) at 1440 and 390 px. Every test
// runs in a fresh browser context, so the fixture server gives it its own
// configurations.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const CLOCK = new Date('2026-10-11T14:00:08Z');
const VM = '/servers/shale/guests/pve%3A100';
const CI = '/servers/shale/guests/pve%3A102';
const WIN = '/servers/shale/guests/pve%3A101';
const CT = '/servers/shale/guests/pve%3A201';
const INCUS = '/servers/basalt/guests/incus%3Adev-shell';

const dialog = (page: Page) => page.getByRole('dialog');

test.describe('interactions', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop only');
    await page.clock.setFixedTime(CLOCK);
  });

  test('opens the guest page by URL with its header and tabs', async ({ page }) => {
    await page.goto(VM);
    await expect(page.getByRole('heading', { name: 'k3s-node-2', level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Guest sections' }).getByRole('link')).toHaveText(['Summary', 'Hardware', 'Options', 'Snapshots', 'Backups', 'Firewall', 'Replication', 'Tasks']);
    await expect(page.getByRole('list', { name: 'Tags' }).getByRole('listitem')).toHaveText(['k3s', 'prod']);
    await expect(page.getByText('QEMU VM 100')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open console for k3s-node-2' })).toHaveAttribute('href', '/servers/shale/guests/pve%3A100/console');
    await page.getByRole('button', { name: 'Power actions for k3s-node-2' }).click();
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['Shut down…', 'Reboot…', 'Pause', 'Force stop…']);
    await page.keyboard.press('Escape');
    // Summary: facts, notes and the history charts.
    const facts = page.getByRole('region', { name: 'Facts' });
    await expect(facts.getByText('scsi0 64 GiB')).toBeVisible();
    await expect(page.getByText('k3s worker node 2.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    // The tab lives in the URL; the host link goes back.
    await page.getByRole('link', { name: 'Hardware' }).click();
    await expect(page).toHaveURL(/pve%3A100\?tab=hardware$/);
    await page.getByRole('main').getByRole('link', { name: 'shale', exact: true }).click();
    await expect(page).toHaveURL(/\/servers\/shale\?tab=guests$/);
  });

  test('edits the memory of a running VM: review, pending banner, revert', async ({ page }) => {
    await page.goto(`${VM}?tab=hardware`);
    await page.getByRole('button', { name: 'Edit memory' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Edit memory' })).toBeVisible();
    await dialog(page).getByLabel('Memory (MiB)', { exact: true }).fill('24576');
    await expect(dialog(page).getByText('24 GiB')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Review' }).click();
    const changes = dialog(page).getByRole('list', { name: 'Changes' });
    await expect(changes.getByRole('listitem')).toHaveCount(1);
    await expect(changes).toContainText('memory');
    await expect(changes).toContainText('16384 → 24576');
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByText('k3s-node-2: saved; the change applies at the next restart.')).toBeVisible();
    const banner = page.getByRole('region', { name: '1 change applies at the next restart' });
    await expect(banner).toContainText('16384 → 24576');
    await expect(page.locator('.cfg-row', { hasText: 'Memory' }).first()).toContainText('24 GiB (after restart)');
    await banner.getByRole('button', { name: 'Revert memory' }).click();
    await expect(page.getByText('k3s-node-2: reverted.')).toBeVisible();
    await expect(banner).toBeHidden();
  });

  test('adds a hard disk', async ({ page }) => {
    await page.goto(`${VM}?tab=hardware`);
    await page.getByRole('button', { name: 'Add hardware' }).click();
    await page.getByRole('menuitem', { name: 'Hard disk' }).click();
    await expect(dialog(page).getByText('Attached as scsi1')).toBeVisible();
    await dialog(page).getByLabel('Size (GiB)').fill('20');
    await dialog(page).getByLabel('Storage', { exact: true }).selectOption('vmdata');
    await dialog(page).getByRole('button', { name: 'Review' }).click();
    await expect(dialog(page).getByRole('list', { name: 'Changes' })).toContainText('vmdata:20,iothread=1');
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    await expect(dialog(page)).toBeHidden();
    // Hotplugged at once on the running VM: the new volume has a name and a size.
    await expect(page.locator('.cfg-row', { hasText: 'Hard disk (scsi1)' })).toContainText('vmdata:vm-100-disk-1 · 20 GiB');
  });

  test('resizes a disk through a task', async ({ page }) => {
    await page.goto(`${VM}?tab=hardware`);
    await page.getByRole('button', { name: 'More for scsi0' }).click();
    await page.getByRole('menuitem', { name: 'Resize…' }).click();
    await dialog(page).getByLabel('Add (GiB)').fill('16');
    await expect(dialog(page).getByText('64 GiB → 80 GiB')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Resize' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByText('Resize scsi0 of k3s-node-2 started')).toBeVisible();
  });

  test('edits tags with chips', async ({ page }) => {
    await page.goto(`${VM}?tab=options`);
    await page.getByRole('button', { name: 'Edit Tags' }).click();
    const tags = dialog(page);
    await tags.getByRole('button', { name: 'Remove tag prod' }).click();
    await tags.getByLabel('Add a tag').fill('bad tag!');
    await tags.getByLabel('Add a tag').press('Enter');
    await expect(tags.getByText('Tags start with a letter, digit or “_”', { exact: false })).toBeVisible();
    await tags.getByLabel('Add a tag').fill('web');
    await tags.getByLabel('Add a tag').press('Enter');
    await expect(tags.getByRole('list', { name: 'Tags' }).getByRole('listitem')).toHaveText(['k3s', 'web']);
    await tags.getByRole('button', { name: 'Review' }).click();
    await expect(tags.getByRole('list', { name: 'Changes' })).toContainText('k3s;prod → k3s;web');
    await tags.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('header').getByRole('list', { name: 'Tags' }).getByRole('listitem')).toHaveText(['k3s', 'web']);
  });

  test('cloud-init SSH keys are stored URL-encoded', async ({ page }) => {
    await page.goto(`${CI}?tab=cloudinit`);
    await expect(page.locator('.cfg-row', { hasText: 'SSH public keys' })).toContainText('1 key · ssh-ed25519 admin@lab');
    await page.getByRole('button', { name: 'Edit SSH public keys' }).click();
    const box = dialog(page).getByLabel('Public keys');
    await expect(box).toHaveValue('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheFixturesOnly admin@lab');
    await box.fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheFixturesOnly admin@lab\nnot a key');
    await expect(dialog(page).getByText('Key 2 is not an OpenSSH public key', { exact: false })).toBeVisible();
    await box.fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheFixturesOnly admin@lab\nssh-rsa AAAAB3NzaC1yc2E+/= ops team');
    await dialog(page).getByRole('button', { name: 'Review' }).click();
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('.cfg-row', { hasText: 'SSH public keys' })).toContainText('2 keys · ssh-ed25519 admin@lab, ssh-rsa ops team');
    // Cloud-init changes of a running VM wait for the next start (pending).
    const cfg = (await (await page.request.get('/api/v1/servers/shale/guests/pve%3A102/config')).json()) as { pending?: Record<string, string> };
    expect(cfg.pending?.sshkeys).toBe('ssh-ed25519%20AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheFixturesOnly%20admin%40lab%0Assh-rsa%20AAAAB3NzaC1yc2E%2B%2F%3D%20ops%20team');
  });

  test('Incus limits on basalt', async ({ page }) => {
    await page.goto(`${INCUS}?tab=config`);
    await expect(page.getByRole('navigation', { name: 'Guest sections' }).getByRole('link')).toHaveText(['Summary', 'Configuration', 'Snapshots']);
    await page.getByRole('button', { name: 'Edit CPU limit' }).click();
    await dialog(page).getByLabel('CPUs').fill('2');
    await dialog(page).getByRole('button', { name: 'Review' }).click();
    await expect(dialog(page).getByRole('list', { name: 'Changes' })).toContainText('limits.cpu');
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('.cfg-row', { hasText: 'CPU limit' })).toContainText('2 CPUs');
    await page.getByRole('button', { name: 'Edit memory limit' }).click();
    await dialog(page).getByLabel('Memory').fill('lots');
    await expect(dialog(page).getByText('A size like 4GiB or 512MiB', { exact: false })).toBeVisible();
    await dialog(page).getByLabel('Memory').fill('8GiB');
    await dialog(page).getByRole('button', { name: 'Review' }).click();
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('.cfg-row', { hasText: 'Memory limit' })).toContainText('8 GiB');
    // A value from the profile is marked as such; root-only keys are read-only.
    await expect(page.locator('.cfg-row', { hasText: 'Network device (eth0)' })).toContainText('from profile default');
    await expect(page.locator('.cfg-row', { hasText: 'raw.idmap' })).toContainText('Change this in Incus');
  });

  test('restricted keys are read-only with a lock', async ({ page }) => {
    await page.goto(`${WIN}?tab=hardware`);
    const card = page.getByRole('region', { name: 'Settings only Proxmox can change' });
    const row = card.locator('.cfg-row', { hasText: 'hostpci0' });
    await expect(row).toContainText('0000:01:00.0,pcie=1,x-vga=1');
    await expect(row).toContainText('Change this in Proxmox');
    await expect(row.getByRole('button')).toHaveCount(0);
  });

  test('a change made meanwhile asks for another review', async ({ page }) => {
    await page.goto(`${VM}?tab=hardware`);
    await page.getByRole('button', { name: 'Edit processors' }).click();
    await dialog(page).getByLabel('Cores per socket').fill('12');
    await dialog(page).getByRole('button', { name: 'Review' }).click();
    // Someone else changes the VM in the meantime (same browser state, no digest).
    expect((await page.request.put('/api/v1/servers/shale/guests/pve%3A100/config', { data: { set: { cores: '10' } }, headers: { 'X-CSRF-Token': 'fixture-csrf-token' } })).ok()).toBe(true);
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    await expect(dialog(page).getByText('Changed meanwhile — review again.')).toBeVisible();
    // The review now starts from the new value.
    await expect(dialog(page).getByRole('list', { name: 'Changes' })).toContainText('10 → 12');
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    await expect(dialog(page)).toBeHidden();
  });

  test('field errors from the hub go back to the field', async ({ page }) => {
    await page.goto(`${VM}?tab=options`);
    await page.getByRole('button', { name: 'Edit Name' }).click();
    await dialog(page).getByLabel('Name').fill('not a dns name');
    await dialog(page).getByRole('button', { name: 'Review' }).click();
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    await expect(dialog(page).getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog(page).getByText('invalid format - value does not look like a valid DNS name')).toBeVisible();
  });

  test('container resources: add a mount point, detach it', async ({ page }) => {
    await page.goto(`${CT}?tab=hardware`);
    await expect(page.getByRole('navigation', { name: 'Guest sections' }).getByRole('link', { name: 'Resources' })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: 'Add a resource' }).click();
    await page.getByRole('menuitem', { name: 'Mount point' }).click();
    await dialog(page).getByLabel('Path in the container').fill('/srv/cache');
    await dialog(page).getByRole('button', { name: 'Review' }).click();
    await expect(dialog(page).getByRole('list', { name: 'Changes' })).toContainText('mp1');
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    // A running container mounts new volumes at the next restart.
    await expect(page.getByRole('region', { name: '1 change applies at the next restart' })).toContainText('mp1');
    await page.getByRole('button', { name: 'More for mp0' }).click();
    await expect(page.getByRole('menuitem', { name: 'Move storage…' })).toBeDisabled();
  });
});

// ---------------------------------------------------------------- axe and screenshots (desktop and mobile)

const PAGES: { name: string; path: string; ready: (p: Page) => Promise<void>; open?: (p: Page) => Promise<void> }[] = [
  { name: 'summary', path: VM, ready: (p) => expect(p.getByRole('heading', { name: 'History' })).toBeVisible() },
  { name: 'hardware', path: `${VM}?tab=hardware`, ready: (p) => expect(p.getByRole('button', { name: 'Edit memory' })).toBeVisible() },
  {
    name: 'hardware-pending',
    path: '/servers/shale/guests/pve%3A104?tab=hardware',
    ready: (p) => expect(p.getByRole('region', { name: '1 change applies at the next restart' })).toBeVisible(),
  },
  {
    name: 'edit-review',
    path: `${VM}?tab=hardware`,
    ready: (p) => expect(p.getByRole('button', { name: 'Edit processors' })).toBeVisible(),
    open: async (p) => {
      await p.getByRole('button', { name: 'Edit processors' }).click();
      await dialog(p).getByLabel('Cores per socket').fill('12');
      await dialog(p).getByRole('button', { name: 'Review' }).click();
      await expect(dialog(p).getByRole('list', { name: 'Changes' })).toBeVisible();
    },
  },
  {
    name: 'edit-disk',
    path: `${WIN}?tab=hardware`,
    ready: (p) => expect(p.getByRole('button', { name: 'Edit scsi0' })).toBeVisible(),
    open: async (p) => {
      await p.getByRole('button', { name: 'Add hardware' }).click();
      await p.getByRole('menuitem', { name: 'Hard disk' }).click();
      await expect(dialog(p).getByLabel('Size (GiB)')).toBeVisible();
    },
  },
  { name: 'options', path: `${VM}?tab=options`, ready: (p) => expect(p.getByRole('button', { name: 'Edit Tags' })).toBeVisible() },
  { name: 'cloudinit', path: `${CI}?tab=cloudinit`, ready: (p) => expect(p.getByRole('button', { name: 'Edit SSH public keys' })).toBeVisible() },
  { name: 'resources', path: `${CT}?tab=hardware`, ready: (p) => expect(p.getByRole('button', { name: 'Edit memory' })).toBeVisible() },
  { name: 'incus-config', path: `${INCUS}?tab=config`, ready: (p) => expect(p.getByRole('button', { name: 'Edit CPU limit' })).toBeVisible() },
  { name: 'snapshots', path: `${VM}?tab=snapshots`, ready: (p) => expect(p.getByRole('button', { name: 'Create snapshot' })).toBeVisible() },
];

for (const s of PAGES) {
  test(`axe: guest ${s.name}`, async ({ page }) => {
    await page.clock.setFixedTime(CLOCK);
    await page.goto(s.path);
    await s.ready(page);
    await s.open?.(page);
    await page.waitForTimeout(400);
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    const summary = res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')} — ${v.help}`);
    expect(summary).toEqual([]);
  });

  test(`shot: guest ${s.name}`, async ({ page }, info) => {
    const mobile = info.project.name === 'mobile';
    await page.clock.setFixedTime(CLOCK);
    await page.goto(s.path);
    await s.ready(page);
    await s.open?.(page);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `.screenshots/${mobile ? 'mobile-' : ''}guest-${s.name}.png`, fullPage: !s.open });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'horizontal page overflow in px').toBeLessThanOrEqual(0);
  });
}

test('shot: guest hardware, light theme', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop only');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.clock.setFixedTime(CLOCK);
  await page.goto(`${WIN}?tab=hardware`);
  await expect(page.getByRole('button', { name: 'Edit memory' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: '.screenshots/guest-hardware-light.png', fullPage: true });
});

for (const path of ['/servers/shale/guests/pve%3A104', '/servers/shale/guests/pve%3A104?tab=hardware']) {
  test(`axe: guest ${path.includes('tab=') ? 'hardware' : 'summary'} with pending changes, light theme`, async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop only');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.clock.setFixedTime(CLOCK);
    await page.goto(path);
    await expect(page.getByText('1 change', { exact: false }).first()).toBeVisible();
    await page.waitForTimeout(400);
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')} — ${v.help}`)).toEqual([]);
  });
}
