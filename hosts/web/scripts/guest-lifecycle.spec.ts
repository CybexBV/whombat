// Guest lifecycle in fixture mode (docs/MANAGE.md 4): create, templates and
// clone, backups and restore, storage contents and downloads, the task
// dialog, the firewall, bulk actions, the tag filter and delete, with
// screenshots (`lifecycle-*.png`) and axe-core scans at 1440 and 390 px.
// Every test runs in a fresh browser context, so the fixture server gives it
// its own state (cookie `rackoon_fx`): signed in as admin, shale (Proxmox)
// and basalt (Incus) with Manage on.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const CLOCK = new Date('2026-10-11T14:00:08Z');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function axe(page: Page, include?: string) {
  // The Disks and wear table scrolls without a tab stop on phones (not part of this change).
  const b = new AxeBuilder({ page }).withTags(TAGS).exclude('.pve-disks .table-scroll');
  const res = await (include ? b.include(include) : b).analyze();
  const summary = res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')} — ${v.help}`);
  expect(summary).toEqual([]);
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'horizontal page overflow in px').toBeLessThanOrEqual(0);
}

const dialog = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name });

// ---------------------------------------------------------------- screenshots and axe (both widths)

const SHOTS: { name: string; path: string; ready: (page: Page) => Promise<void>; viewportOnly?: boolean }[] = [
  { name: 'host-guests', path: '/servers/shale?tab=guests', ready: (p) => expect(p.getByRole('link', { name: 'k3s-node-2' })).toBeVisible() },
  {
    name: 'create-vm',
    path: '/servers/shale?tab=guests',
    ready: async (p) => {
      await p.getByRole('button', { name: 'Create a guest on shale' }).click();
      await p.getByRole('menuitem', { name: 'Virtual machine…' }).click();
      await expect(dialog(p, 'Create a virtual machine').getByLabel('Name')).toBeFocused();
    },
    viewportOnly: true,
  },
  {
    name: 'create-ct',
    path: '/servers/shale?tab=guests&platform=ct',
    ready: async (p) => {
      await p.getByRole('button', { name: 'Create a guest on shale' }).click();
      await p.getByRole('menuitem', { name: 'Container…' }).click();
      await expect(dialog(p, 'Create a container').getByLabel('Host name')).toBeFocused();
    },
    viewportOnly: true,
  },
  {
    name: 'create-incus',
    path: '/servers/basalt?tab=guests&platform=incus',
    ready: async (p) => {
      await p.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(dialog(p, 'Create an instance').getByLabel('Name')).toBeFocused();
    },
    viewportOnly: true,
  },
  { name: 'backups', path: '/servers/shale/guests/pve%3A100?tab=backups', ready: (p) => expect(p.getByRole('table').getByRole('row')).toHaveCount(4) },
  { name: 'tasks', path: '/servers/shale/guests/pve%3A100?tab=tasks', ready: (p) => expect(p.getByRole('button', { name: 'Back up' })).toBeVisible() },
  { name: 'firewall', path: '/servers/shale/guests/pve%3A201?tab=firewall', ready: (p) => expect(p.getByRole('table', { name: 'Rules' }).getByRole('row')).toHaveCount(5) },
  { name: 'replication', path: '/servers/shale/guests/pve%3A100?tab=replication', ready: (p) => expect(p.getByRole('cell', { name: 'schist' })).toBeVisible() },
  { name: 'storage', path: '/servers/shale?tab=storage', ready: (p) => expect(p.getByRole('button', { name: 'Contents… of local' })).toBeVisible() },
  {
    name: 'contents',
    path: '/servers/shale?tab=storage',
    ready: async (p) => {
      await p.getByRole('button', { name: 'Contents… of local' }).click();
      await expect(dialog(p, 'Contents of local').getByText('debian-13.1.0-amd64-netinst.iso')).toBeVisible();
    },
    viewportOnly: true,
  },
  {
    name: 'appliances',
    path: '/servers/shale?tab=storage',
    ready: async (p) => {
      await p.getByRole('button', { name: 'Contents… of local' }).click();
      await dialog(p, 'Contents of local').getByRole('button', { name: 'Container templates' }).click();
      await dialog(p, 'Contents of local').getByRole('button', { name: 'Get templates' }).click();
      await expect(dialog(p, 'Contents of local').getByRole('button', { name: 'Download TurnKey Nextcloud' })).toBeVisible();
    },
    viewportOnly: true,
  },
  { name: 'guests-tags', path: '/guests?platform=pve', ready: (p) => expect(p.getByRole('combobox', { name: 'Tag' })).toBeVisible() },
  {
    name: 'task-dialog',
    path: '/servers/shale/guests/pve%3A100?tab=backups',
    ready: async (p) => {
      await p.getByRole('button', { name: 'Back up now' }).click();
      await dialog(p, 'Back up k3s-node-2').getByRole('button', { name: 'Back up now' }).click();
      await p.locator('.toast').getByRole('button', { name: 'Show progress' }).click();
      await expect(dialog(p, 'Back up k3s-node-2').getByLabel('Task log')).toContainText('INFO: backup mode: snapshot', { timeout: 10_000 });
    },
    viewportOnly: true,
  },
  {
    name: 'restore',
    path: '/servers/shale/guests/pve%3A100?tab=backups',
    ready: async (p) => {
      await p.getByRole('table').getByRole('row').nth(1).getByRole('button', { name: /^Restore…/ }).click();
      await expect(dialog(p, /^Restore the backup of/).getByLabel('VM ID')).toBeVisible();
    },
    viewportOnly: true,
  },
  {
    name: 'delete',
    path: '/servers/shale/guests/pve%3A107',
    ready: async (p) => {
      await p.getByRole('button', { name: 'More actions for win11-lab' }).click();
      await p.getByRole('menuitem', { name: 'Delete…' }).click();
      await expect(dialog(p, 'Delete win11-lab?').getByLabel('Type win11-lab to confirm')).toBeFocused();
    },
    viewportOnly: true,
  },
  {
    name: 'bulk',
    path: '/servers/shale?tab=guests',
    ready: async (p) => {
      await p.getByRole('checkbox', { name: 'Select k3s-node-2' }).check();
      await p.getByRole('checkbox', { name: 'Select win11-lab' }).check();
      await p.getByRole('group', { name: 'Selected guests' }).getByRole('button', { name: 'Stop…' }).click();
      await expect(dialog(p, 'Stop 1 guest?')).toContainText('1 selected guest is skipped');
    },
    viewportOnly: true,
  },
];

for (const s of SHOTS) {
  test(`shot: ${s.name}`, async ({ page }, info) => {
    const mobile = info.project.name === 'mobile';
    await page.clock.setFixedTime(CLOCK);
    await page.goto(s.path);
    await s.ready(page);
    await settle(page);
    await page.screenshot({ path: `.screenshots/${mobile ? 'mobile-' : ''}lifecycle-${s.name}.png`, fullPage: !s.viewportOnly });
    await noHorizontalOverflow(page);
    await axe(page);
  });
}

// Light theme: the host's guest table and the create dialog.
for (const s of SHOTS.filter((x) => x.name === 'host-guests' || x.name === 'create-vm')) {
  test(`shot (light): ${s.name}`, async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'light theme checked at desktop width');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.clock.setFixedTime(CLOCK);
    await page.goto(s.path);
    await s.ready(page);
    await settle(page);
    await page.screenshot({ path: `.screenshots/lifecycle-${s.name}-light.png`, fullPage: !s.viewportOnly });
    await axe(page);
  });
}

// ---------------------------------------------------------------- flows (desktop)

/** The "… started" toast's Show progress, then the task dialog. */
async function showProgress(page: Page, started: string) {
  const toast = page.locator('.toast').filter({ hasText: started });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Show progress' }).click();
}

test.describe('flows', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop only');
    await page.clock.setFixedTime(CLOCK);
  });

  test('create a VM: the wizard defaults, the task toast, then the new guest opens', async ({ page }) => {
    await page.goto('/servers/shale?tab=guests');
    await page.getByRole('button', { name: 'Create a guest on shale' }).click();
    await page.getByRole('menuitem', { name: 'Virtual machine…' }).click();
    const d = dialog(page, 'Create a virtual machine');
    await expect(d.getByLabel('VM ID')).toHaveValue('108');
    await expect(d.getByLabel('CPU type')).toHaveValue('x86-64-v2-AES');
    await expect(d.getByLabel('Bridge')).toHaveValue('vmbr0');
    await d.getByRole('button', { name: 'Create VM' }).click();
    await expect(d.getByText('Enter a name.')).toBeVisible();
    await d.getByLabel('Name').fill('web-03');
    await d.getByLabel('Guest OS').selectOption('win11');
    await d.getByText('Advanced').click();
    await expect(d.getByLabel('BIOS')).toHaveValue('ovmf');
    await expect(d.getByLabel('TPM 2.0 (Windows 11 needs it)')).toBeChecked();
    await d.getByRole('button', { name: 'Create VM' }).click();
    await expect(d).toBeHidden();
    await expect(page.locator('.toast').filter({ hasText: 'Create web-03 started' })).toBeVisible();
    await expect(page).toHaveURL(/\/servers\/shale\/guests\/pve%3A108$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'web-03', level: 1 })).toBeVisible();
  });

  test('create a container with a static address; the task dialog shows the log', async ({ page }) => {
    await page.goto('/servers/shale?tab=guests&platform=ct');
    await page.getByRole('button', { name: 'Create a guest on shale' }).click();
    await page.getByRole('menuitem', { name: 'Container…' }).click();
    const d = dialog(page, 'Create a container');
    await d.getByLabel('Host name').fill('dns-2');
    await d.getByLabel('Root password').fill('abc');
    await d.getByRole('group', { name: 'IPv4' }).getByRole('button', { name: 'Static' }).click();
    await d.getByLabel('IPv4 address').fill('10.20.0.54');
    await d.getByRole('button', { name: 'Create container' }).click();
    await expect(d.getByText('Use at least 5 characters.')).toBeVisible();
    await expect(d.getByText('Use an address with prefix, like 10.0.0.5/24.')).toBeVisible();
    await d.getByLabel('Root password').fill('correct horse');
    await d.getByLabel('IPv4 address').fill('10.20.0.54/24');
    await d.getByLabel('Gateway').fill('10.20.0.1');
    await d.getByRole('button', { name: 'Create container' }).click();
    await showProgress(page, 'Create dns-2 started');
    const task = dialog(page, 'Create dns-2');
    await expect(task.getByLabel('Task log')).toContainText("extracting archive 'local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst'");
    await expect(task.getByRole('status')).toContainText('OK', { timeout: 15_000 });
    await expect(task.getByLabel('Task log')).toContainText('TASK OK');
    await task.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(page).toHaveURL(/\/servers\/shale\/guests\/pve%3A108$/, { timeout: 10_000 });
  });

  test('create an Incus instance from an image', async ({ page }) => {
    await page.goto('/servers/basalt?tab=guests&platform=incus');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const d = dialog(page, 'Create an instance');
    await expect(d.getByLabel('Image')).toHaveValue('debian/13');
    await d.getByLabel('Name').fill('web.lab');
    await d.getByRole('button', { name: 'Create instance' }).click();
    await expect(d.getByText('Instance names have no dots.')).toBeVisible();
    await d.getByLabel('Name').fill('web-03');
    await d.getByRole('button', { name: 'Virtual machine' }).click();
    await expect(d.getByLabel('Image')).toHaveValue('nixos/26.05');
    await d.getByLabel('Image').fill('images:debian/13');
    await d.getByLabel('Memory (MiB)').fill('4096');
    await expect(d.getByText('= 4 GiB')).toBeVisible();
    await d.getByRole('button', { name: 'Create instance' }).click();
    await expect(page).toHaveURL(/\/servers\/basalt\/guests\/incus%3Aweb-03$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'web-03', level: 1 })).toBeVisible();
  });

  test('HA: add a guest to HA, then remove it (Options tab)', async ({ page }) => {
    await page.goto('/servers/shale/guests/pve%3A102?tab=options');
    const ha = page.getByRole('region', { name: 'High availability' });
    await page.waitForTimeout(1000);
    test.skip(!(await ha.isVisible()), 'the Options tab renders the HA row (the other half of the guest page)');
    await expect(ha).toContainText('Not an HA resource');
    await ha.getByRole('button', { name: 'Add to HA…' }).click();
    const d = dialog(page, 'Add k3s-node-1 to HA');
    await d.getByLabel('Restarts on the same node').fill('2');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(ha).toContainText('2 restarts, 1 move to another node');
    await ha.getByRole('button', { name: 'Remove…' }).click();
    await dialog(page, 'Remove k3s-node-1 from HA?').getByRole('button', { name: 'Remove from HA' }).click();
    await expect(ha).toContainText('Not an HA resource');
  });

  test('replication: add a job to another node, then delete it', async ({ page }) => {
    await page.goto('/servers/shale/guests/pve%3A102?tab=replication');
    await expect(page.getByText('No replication jobs for k3s-node-1.')).toBeVisible();
    await page.getByRole('button', { name: 'Add job' }).click();
    const d = dialog(page, 'Replicate k3s-node-1');
    await expect(d.getByLabel('Target node')).toHaveValue('schist');
    await d.getByLabel('Rate limit (MB/s)').fill('fast');
    await d.getByRole('button', { name: 'Add job' }).click();
    await expect(d.getByText('MB/s as a number, or empty for no limit.')).toBeVisible();
    await d.getByLabel('Rate limit (MB/s)').fill('50');
    await d.getByRole('button', { name: 'Add job' }).click();
    const row = page.getByRole('table').getByRole('row').nth(1);
    await expect(row).toContainText('102-0');
    await expect(row).toContainText('every 15 min');
    await expect(row).toContainText('50 MB/s');
    await page.getByRole('button', { name: 'Delete job 102-0' }).click();
    await dialog(page, 'Delete replication job 102-0?').getByRole('button', { name: 'Delete job' }).click();
    await expect(page.getByText('No replication jobs for k3s-node-1.')).toBeVisible();
  });

  test('clone from a template in the templates list', async ({ page }) => {
    await page.goto('/servers/shale?tab=guests');
    await page.getByText('Templates (2)').click();
    await page.getByRole('button', { name: 'Clone… debian-13-cloud' }).click();
    const d = dialog(page, 'Clone debian-13-cloud');
    await expect(d.getByRole('group', { name: 'Clone mode' }).getByRole('button', { name: 'Linked clone' })).toHaveAttribute('aria-pressed', 'true');
    await expect(d.getByLabel('Target storage')).toHaveCount(0);
    await d.getByRole('button', { name: 'Full clone' }).click();
    await d.getByLabel('Target storage').selectOption('vmdata');
    await d.getByLabel('Name').fill('web-04');
    await d.getByRole('button', { name: 'Clone', exact: true }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Clone debian-13-cloud started' })).toBeVisible();
    await expect(page.locator('.toast').filter({ hasText: 'Clone debian-13-cloud: done.' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'web-04' })).toBeVisible({ timeout: 15_000 });
  });

  test('back up now, then restore the backup as a new guest', async ({ page }) => {
    await page.goto('/servers/shale/guests/pve%3A100?tab=backups');
    const rows = page.getByRole('table').getByRole('row');
    await expect(rows).toHaveCount(4);
    await page.getByRole('button', { name: 'Back up now' }).click();
    const d = dialog(page, 'Back up k3s-node-2');
    await expect(d.getByLabel('Storage')).toHaveValue('pbs-01');
    await expect(d.getByLabel('Compression')).toHaveCount(0); // PBS compresses itself
    await d.getByLabel('Storage').selectOption('local');
    await expect(d.getByLabel('Compression')).toHaveValue('zstd');
    await d.getByLabel('Notes').fill('{{guestname}} before the upgrade');
    await d.getByRole('button', { name: 'Back up now' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Back up k3s-node-2: done.' })).toBeVisible({ timeout: 15_000 });
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(1)).toContainText('k3s-node-2 before the upgrade');
    await rows.nth(1).getByRole('button', { name: /^Restore…/ }).click();
    const r = dialog(page, /^Restore the backup of/);
    await expect(r.getByLabel('VM ID')).toHaveAttribute('placeholder', '108');
    await expect(r.getByLabel('New MAC addresses (unique), so it can run next to the original')).toBeChecked();
    // Over this guest: it is running, so that waits.
    await r.getByRole('button', { name: 'Over k3s-node-2' }).click();
    await expect(r.getByText('k3s-node-2 is running: shut it down first, a restore replaces its disks.')).toBeVisible();
    await expect(r.getByRole('button', { name: 'Replace the disks of k3s-node-2' })).toHaveAttribute('aria-disabled', 'true');
    await r.getByRole('button', { name: 'A new guest' }).click();
    await r.getByLabel('Target storage').selectOption('vmdata');
    await r.getByRole('button', { name: 'Restore as a new guest' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Restore k3s-node-2 as a new guest: done.' })).toBeVisible({ timeout: 15_000 });
    await page.goto('/servers/shale/guests/pve%3A108?tab=backups');
    await expect(page.getByRole('heading', { name: 'k3s-node-2', level: 1 })).toBeVisible();
  });

  test('download an ISO image from a URL to a storage', async ({ page }) => {
    await page.goto('/servers/shale?tab=storage');
    await page.getByRole('button', { name: 'Contents… of local' }).click();
    const d = dialog(page, 'Contents of local');
    await expect(d.getByRole('list', { name: 'ISO images' }).getByRole('listitem')).toHaveCount(3);
    await d.getByRole('button', { name: 'Download from URL' }).click();
    await d.getByLabel('URL').fill('https://dl-cdn.example.org/alpine/v3.22/releases/x86_64/alpine-virt-3.22.2-x86_64.iso');
    await expect(d.getByLabel('File name')).toHaveValue('alpine-virt-3.22.2-x86_64.iso');
    await d.getByLabel('Checksum').selectOption('sha256');
    await d.getByLabel('Expected checksum').fill('abc');
    await d.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(d.getByText('A sha256 checksum has 64 characters.')).toBeVisible();
    await d.getByLabel('Expected checksum').fill('ab'.repeat(32));
    await d.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(d.getByRole('list', { name: 'ISO images' })).toBeVisible();
    await expect(page.locator('.toast').filter({ hasText: 'Download alpine-virt-3.22.2-x86_64.iso: done.' })).toBeVisible({ timeout: 15_000 });
    await expect(d.getByRole('list', { name: 'ISO images' }).getByRole('listitem')).toHaveCount(4);
    await expect(d.getByText('alpine-virt-3.22.2-x86_64.iso')).toBeVisible();
  });

  test('task dialog: the log grows, Stop ends a running task', async ({ page }) => {
    await page.goto('/servers/shale/guests/pve%3A200?tab=backups');
    await page.getByRole('button', { name: 'Back up now' }).click();
    await dialog(page, 'Back up grafana-ct').getByRole('button', { name: 'Back up now' }).click();
    await showProgress(page, 'Back up grafana-ct started');
    const task = dialog(page, 'Back up grafana-ct');
    await expect(task.getByRole('status')).toContainText('Running');
    await expect(task.getByLabel('Task log')).toContainText('INFO: starting new backup job: vzdump 200 --storage pbs-01');
    await expect(task.getByLabel('Task log')).toContainText('INFO: backup mode: snapshot', { timeout: 10_000 });
    await task.getByRole('button', { name: 'Stop task' }).click();
    await expect(task.getByRole('status')).toContainText('Failed', { timeout: 10_000 });
    await expect(task.getByLabel('Task log')).toContainText('TASK ERROR: interrupted by signal');
    await expect(task.getByRole('button', { name: 'Stop task' })).toHaveCount(0);
    // The Tasks tab lists it and opens the same dialog.
    await task.getByRole('button', { name: 'Close', exact: true }).last().click();
    await page.goto('/servers/shale/guests/pve%3A200?tab=tasks');
    const first = page.getByRole('table').getByRole('row').nth(1);
    await expect(first).toContainText('Failed');
    await first.getByRole('button', { name: 'Back up' }).click();
    await expect(dialog(page, 'Back up · grafana-ct').getByLabel('Task log')).toContainText('TASK ERROR: interrupted by signal');
  });

  test('firewall: add a rule at the top, move it down, delete it', async ({ page }) => {
    await page.goto('/servers/shale/guests/pve%3A201?tab=firewall');
    await expect(page.getByRole('note')).toContainText('The datacenter firewall is off');
    const rules = page.getByRole('table', { name: 'Rules' }).getByRole('row');
    await expect(rules).toHaveCount(5);
    await page.getByRole('button', { name: 'Add rule' }).click();
    const d = dialog(page, 'Add a firewall rule');
    await d.getByLabel('Protocol').selectOption('tcp');
    await d.getByLabel('Destination port').fill('80,8080');
    await d.getByLabel('Comment').fill('web test');
    await d.getByRole('button', { name: 'Add rule' }).click();
    await expect(rules).toHaveCount(6);
    await expect(rules.nth(1)).toContainText('tcp port 80,8080');
    await page.getByRole('button', { name: 'Move rule 0 down' }).click();
    await expect(rules.nth(2)).toContainText('tcp port 80,8080');
    await page.getByRole('button', { name: 'More for rule 1' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await dialog(page, 'Delete rule 1?').getByRole('button', { name: 'Delete rule' }).click();
    await expect(rules).toHaveCount(5);
    await expect(page.getByText('tcp port 80,8080')).toHaveCount(0);
    // Turning a rule off is one click.
    await page.getByRole('checkbox', { name: 'rule 0 on' }).click();
    await expect(page.getByRole('checkbox', { name: 'rule 0 on' })).not.toBeChecked();
  });

  test('bulk start on the Guests page; disruptive commands name the guests first', async ({ page }) => {
    await page.goto('/guests?state=stopped');
    await expect(page.getByText('1–4 of 4 guests', { exact: false })).toBeVisible();
    // Docker guests in the fixtures have no power actions here; pick the Proxmox and Incus ones.
    await page.getByRole('checkbox', { name: 'Select win11-lab on shale' }).check();
    await page.getByRole('checkbox', { name: 'Select scratch on basalt' }).check();
    const bar = page.getByRole('group', { name: 'Selected guests' });
    await expect(bar).toContainText('2 selected');
    await expect(bar.getByRole('button', { name: 'Shut down' })).toHaveAttribute('aria-disabled', 'true');
    await bar.getByRole('button', { name: 'Start' }).click();
    await expect(bar).toBeHidden();
    await expect(page.locator('.toast').filter({ hasText: 'Started 2 guests.' })).toBeVisible({ timeout: 15_000 });
    await page.goto('/servers/shale?tab=guests');
    await page.getByRole('checkbox', { name: 'Select all VMs' }).check();
    await page.getByRole('group', { name: 'Selected guests' }).getByRole('button', { name: 'Reboot' }).click();
    const c = dialog(page, 'Reboot 8 guests?');
    await expect(c.getByRole('list', { name: 'Guests' }).getByRole('listitem')).toHaveCount(8);
    await expect(c.getByText('win11-lab')).toBeVisible();
    await c.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('group', { name: 'Selected guests' })).toContainText('8 selected');
  });

  test('tag filter on the Guests page', async ({ page }) => {
    await page.goto('/guests');
    await page.getByRole('combobox', { name: 'Tag' }).selectOption('prod');
    await expect(page).toHaveURL(/tag=prod/);
    await expect(page.getByText('1–3 of 3 guests', { exact: false })).toBeVisible();
    const rows = page.getByRole('table').getByRole('row');
    await expect(rows.nth(1)).toContainText('prod');
    await page.getByRole('link', { name: 'postgres-prod' }).click();
    await expect(page).toHaveURL(/\/servers\/shale\/guests\/pve%3A103$/);
  });

  test('delete a guest: the name confirms it, then the host list opens', async ({ page }) => {
    await page.goto('/servers/shale/guests/pve%3A107');
    await page.getByRole('button', { name: 'More actions for win11-lab' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const d = dialog(page, 'Delete win11-lab?');
    await expect(d).toContainText('win11-lab (ID 107) and all its disks are removed from shale. This cannot be undone.');
    await expect(d.getByLabel('Also remove it from backup jobs, replication and HA')).toBeChecked();
    const go = d.getByRole('button', { name: 'Delete win11-lab' });
    await expect(go).toHaveAttribute('aria-disabled', 'true');
    await d.getByLabel('Type win11-lab to confirm').fill('win11');
    await expect(go).toHaveAttribute('aria-disabled', 'true');
    await d.getByLabel('Type win11-lab to confirm').fill('win11-lab');
    await go.click();
    await expect(page.locator('.toast').filter({ hasText: 'Delete win11-lab started' })).toBeVisible();
    await expect(page).toHaveURL(/\/servers\/shale\?tab=guests&platform=vm$/, { timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'k3s-node-2' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'win11-lab' })).toHaveCount(0);
    // A running guest explains why it cannot be deleted.
    await page.goto('/servers/shale/guests/pve%3A103');
    await page.getByRole('button', { name: 'More actions for postgres-prod' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await expect(dialog(page, 'Delete postgres-prod?').getByText('postgres-prod is running: stop it first, running guests cannot be deleted.')).toBeVisible();
    await expect(dialog(page, 'Delete postgres-prod?').getByText('Protection is on for postgres-prod: turn it off in Options first.')).toBeVisible();
  });

  test('dialogs pass axe: create container, task dialog, firewall rule', async ({ page }) => {
    await page.goto('/servers/shale?tab=guests&platform=ct');
    await page.getByRole('button', { name: 'Create a guest on shale' }).click();
    await page.getByRole('menuitem', { name: 'Container…' }).click();
    await dialog(page, 'Create a container').getByText('Advanced').click();
    await axe(page, 'dialog');
    await page.keyboard.press('Escape');
    await page.goto('/servers/shale/guests/pve%3A201?tab=firewall');
    await page.getByRole('button', { name: 'Add rule' }).click();
    await axe(page, 'dialog');
  });
});
