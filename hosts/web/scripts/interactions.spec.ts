// End-to-end smoke tests of the interactive behavior in fixture mode (UI v2):
// URL state, the hosts table and Watch panel, host tabs, guests tab, console
// side panel, command palette, host pills, phone bottom bar and sheets,
// keyboard chart navigation, old addresses.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop only');
  await page.clock.setFixedTime(new Date('2026-10-11T14:00:08Z'));
});

test('overview: group and range live in the URL and recompute the page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('8 hosts · 1 offline')).toBeVisible();
  await page.getByRole('group', { name: 'Server group' }).getByRole('button', { name: /Lab/ }).click();
  await expect(page).toHaveURL(/group=Lab/);
  await expect(page.getByText('2 hosts, all online')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Server group' }).getByRole('button', { name: /Lab/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7d' }).click();
  await expect(page).toHaveURL(/range=7d/);
  await expect(page.getByRole('columnheader', { name: 'CPU · 7d' })).toBeVisible();
  await expect(page.getByText('No open alerts')).toBeVisible();
  await page.reload();
  await expect(page.getByText('2 hosts, all online')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
});

test('overview: fleet totals, the hosts table and the Watch panel', async ({ page }) => {
  await page.goto('/');
  const totals = page.getByRole('region', { name: 'Fleet totals' });
  await expect(totals.getByText('7 / 8')).toBeVisible();
  await expect(totals.getByText('2 with warnings', { exact: false })).toBeVisible();
  await expect(totals.getByText('506 GB')).toBeVisible();
  await expect(totals.getByText('62.2 TB')).toBeVisible();
  await expect(totals.getByText('open alerts')).toBeVisible();
  // Offline host first, with its last heartbeat.
  const rows = page.getByRole('table').first().getByRole('row');
  await expect(rows.nth(1)).toContainText('marble');
  await expect(rows.nth(1)).toContainText(/Last seen 02:14 · 11 h 46 m ago/);
  await expect(rows.nth(2)).toContainText('basalt');
  await expect(page.getByRole('link', { name: 'basalt, Warning · disk wear' })).toBeVisible();
  // Watch: open alerts, then hints (warnings first).
  const watch = page.getByRole('list', { name: 'Open alerts and hints' });
  await expect(watch.getByRole('listitem').nth(0)).toContainText('Agent unreachable');
  await expect(watch.getByText('docker not reporting')).toBeVisible();
  await expect(watch.getByText('CPU package at 64 °C')).toBeVisible();
  await expect(page.getByText('6 hints: conditions from 70% of a limit', { exact: false })).toBeVisible();
  // A hint links to the host's tab for its section.
  await watch.getByRole('link', { name: 'onyx' }).first().click();
  await expect(page).toHaveURL(/\/servers\/onyx\?tab=guests$/);
});

test('overview: a row opens the host (Proxmox hosts open the Proxmox summary)', async ({ page }) => {
  await page.goto('/?range=7d');
  await page.getByRole('link', { name: /^shale, Warning/ }).click();
  await expect(page).toHaveURL(/\/servers\/shale\?range=7d/);
  await expect(page.getByRole('heading', { name: 'Proxmox VE', level: 2 })).toBeVisible();
  await expect(page.getByText('prod-pve')).toBeVisible();
});

test('host: tabs live in the URL; summary, storage and sensors', async ({ page }) => {
  await page.goto('/servers/basalt');
  const tabs = page.getByRole('navigation', { name: 'Host sections' });
  await expect(tabs.getByRole('link')).toHaveText([/^Summary/, /^Guests/, /^Storage/, /^Sensors/, /^Virtualization/, /^System/, /^Agent/]);
  await expect(tabs.getByRole('link', { name: /^Summary/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Guests', level: 2 })).toBeVisible();
  await expect(page.getByText('nvme1n1 wear at 78%')).toBeVisible();
  await tabs.getByRole('link', { name: /^Storage/ }).click();
  await expect(page).toHaveURL(/\/servers\/basalt\?tab=storage$/);
  await expect(page.getByRole('heading', { name: 'Storage', level: 2 })).toBeVisible();
  await expect(page.getByText('4 disks · 22.3 TB used of 35 TB')).toBeVisible();
  await tabs.getByRole('link', { name: /^Sensors/ }).click();
  await expect(page).toHaveURL(/tab=sensors$/);
  await page.getByRole('button', { name: 'View temperatures as table' }).click();
  await expect(page.getByRole('table', { name: /Temperatures, values/ }).getByRole('row')).toHaveCount(97);
  // Proxmox: the cluster lives on the Virtualization tab; the banner link opens Sensors.
  await page.goto('/servers/shale?tab=virtualization');
  await expect(page.getByRole('heading', { name: 'Cluster: prod-pve' })).toBeVisible();
  await page.goto('/servers/shale');
  await page.getByRole('link', { name: 'View sensors' }).click();
  await expect(page).toHaveURL(/\/servers\/shale\?tab=sensors$/);
});

test('host: chart keyboard navigation is shared across the summary charts', async ({ page }) => {
  await page.goto('/servers/basalt');
  const cpu = page.getByRole('slider', { name: /CPU chart/ });
  await expect(cpu).toHaveAttribute('aria-valuetext', /^Sun 07:15: CPU 47\.7%$/);
  await cpu.focus();
  await page.keyboard.press('End');
  await expect(cpu).toHaveAttribute('aria-valuetext', /^Sun 14:00: CPU 34\.0%$/);
  await page.keyboard.press('ArrowLeft');
  await expect(cpu).toHaveAttribute('aria-valuetext', /^Sun 13:45/);
  await expect(page.getByRole('slider', { name: /Memory chart/ })).toHaveAttribute('aria-valuetext', /^Sun 13:45/);
});

test('host guests: platform control, filter, console side panel and back', async ({ page }) => {
  await page.goto('/servers/basalt?tab=guests');
  await expect(page.getByText('Showing 8 of 16 containers, sorted by CPU')).toBeVisible();
  const platform = page.getByRole('group', { name: 'Platform' });
  await platform.getByRole('button', { name: /Incus/ }).click();
  await expect(page).toHaveURL(/tab=guests&platform=incus/);
  await expect(platform.getByRole('button', { name: /Incus/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Incus instances · 2 KVM VMs and 4 containers')).toBeVisible();
  await page.getByLabel('Filter instances by name').fill('ci');
  await expect(page).toHaveURL(/q=ci/);
  await expect(page.getByText('Showing 1 of 7 instances matching “ci”', { exact: false })).toBeVisible();
  await page.getByLabel('Filter instances by name').fill('');
  await page.getByRole('button', { name: 'Open console for nixbuild' }).click();
  await expect(page).toHaveURL(/\/servers\/basalt\/guests\/incus%3Anixbuild\/console\?platform=incus/);
  const region = page.getByRole('region', { name: 'Console for nixbuild' });
  await expect(region).toBeVisible();
  await expect(region.getByRole('group', { name: 'Connection type' }).getByRole('button', { name: 'VGA (SPICE)' })).toHaveAttribute('aria-pressed', 'true');
  // The table stays beside the panel; its row is marked.
  await expect(page.getByRole('row', { selected: true })).toContainText('nixbuild');
  await region.getByRole('button', { name: 'Close the console of nixbuild' }).click();
  await expect(page).toHaveURL(/\/servers\/basalt\?tab=guests&platform=incus$/);
  await expect(page.getByText('Showing all 7 instances', { exact: false })).toBeVisible();
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Screens' }).click();
  await expect(page).toHaveURL(/view=screens/);
  await expect(page.getByRole('list', { name: 'Screens' }).getByRole('button')).toHaveCount(7);
  // Docker has no console (fixture agents offer no shell) and no List / Screens toggle.
  await platform.getByRole('button', { name: /Docker/ }).click();
  await expect(page.getByRole('group', { name: 'View' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Open console/ })).toHaveCount(0);
  // Old addresses without the tab still open the guests tab.
  await page.goto('/servers/basalt?platform=incus');
  await expect(page.getByText('Incus instances · 2 KVM VMs and 4 containers')).toBeVisible();
});

test('guests page: filters, a console from the fleet-wide list', async ({ page }) => {
  await page.goto('/guests');
  await expect(page.getByText('27 running of 31 · every VM and container the agents can see')).toBeVisible();
  const rows = page.getByRole('table').getByRole('row');
  await expect(rows.nth(1)).toContainText('k3s-node-2');
  await page.getByRole('group', { name: 'State' }).getByRole('button', { name: /Stopped/ }).click();
  await expect(page).toHaveURL(/state=stopped/);
  await expect(page.getByText('1–4 of 4 guests', { exact: false })).toBeVisible();
  await page.getByRole('group', { name: 'State' }).getByRole('button', { name: /^All/ }).click();
  await page.getByRole('group', { name: 'Platform' }).getByRole('button', { name: /Proxmox/ }).click();
  await expect(page).toHaveURL(/platform=pve/);
  await expect(page.getByText('1–12 of 12 guests', { exact: false })).toBeVisible();
  await page.getByLabel('Filter guests by name, image or VMID').fill('grafana');
  await expect(page).toHaveURL(/q=grafana/);
  await expect(page.getByText('1–1 of 1 guest ', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Open shell for grafana-ct on shale' }).click();
  await expect(page).toHaveURL(/console=shale%2Fpve%3A200/);
  await expect(page.getByRole('region', { name: 'Shell for grafana-ct' })).toBeVisible();
  await expect(page.getByText(/Connected · xterm\.js · encrypted/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Close the shell of grafana-ct' }).click();
  await expect(page).not.toHaveURL(/console=/);
});

test('command palette: pages, hosts, guests and actions; Enter opens a console', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Search hosts, guests/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Search' });
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();
  const list = dialog.getByRole('listbox', { name: 'Results' });
  await expect(list.getByRole('group', { name: 'Pages' }).getByRole('option')).toHaveCount(4);
  await expect(list.getByRole('group', { name: 'Hosts' }).getByRole('option')).toHaveCount(8);
  await expect(list.getByRole('group', { name: 'Actions' }).getByRole('option', { name: /Enroll a server/ })).toBeVisible();
  await page.keyboard.type('grafana');
  const guests = list.getByRole('group', { name: 'Guests' });
  await expect(guests.getByRole('option')).toHaveCount(3);
  await expect(guests.getByRole('option').nth(1)).toContainText('LXC 200 · shale · running');
  // Arrow down to the LXC container and open its shell.
  const target = guests.getByRole('option', { name: /grafana-ct/ });
  const id = (await target.getAttribute('id'))!;
  while ((await input.getAttribute('aria-activedescendant')) !== id) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/servers\/shale\/guests\/pve%3A200\/console/);
  await expect(dialog).toHaveCount(0);
  // Ctrl+K opens it anywhere; Shift+Enter shows a guest in its host's list; Escape clears, then closes.
  await page.keyboard.press('Control+k');
  await expect(dialog).toBeVisible();
  await page.keyboard.type('nixbuild');
  await expect(guests.getByRole('option', { name: /nixbuild/ })).toBeVisible();
  await page.keyboard.press('Shift+Enter');
  await expect(page).toHaveURL(/\/servers\/basalt\?tab=guests&platform=incus&q=nixbuild$/);
  await expect(page.getByLabel('Filter instances by name')).toHaveValue('nixbuild');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('zzzz');
  await expect(dialog.getByRole('status')).toHaveText('No guests match “zzzz”.');
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('top bar: host pills, active page, alert badge, old addresses', async ({ page }) => {
  await page.goto('/servers/basalt?range=7d');
  const primary = page.getByRole('navigation', { name: 'Primary' }).first();
  const pill = primary.getByRole('link', { name: 'basalt, Disk wear' });
  await expect(pill).toHaveAttribute('aria-current', 'page');
  await expect(primary.getByRole('link', { name: 'marble, Offline' })).toBeVisible();
  await primary.getByRole('link', { name: 'granite, Online' }).click();
  await expect(page).toHaveURL(/\/servers\/granite\?range=7d$/);
  await page.goto('/alerts');
  await expect(primary.getByRole('link', { name: /Alerts/ })).toHaveAttribute('aria-current', 'page');
  await expect(primary.getByLabel('3 alerts need attention')).toBeVisible();
  await page.goto('/servers?range=7d');
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/\?range=7d$/);
  await page.goto('/agents?enroll=1');
  await expect(page).toHaveURL(/\/settings\/agents\?enroll=1$/);
  await expect(page.getByRole('dialog', { name: 'Enroll a server' })).toBeVisible();
  for (const gone of ['/workloads', '/storage']) {
    await page.goto(gone);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  }
});

test('phone: bottom bar with the hosts sheet and the menu sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/servers/basalt');
  await expect(page.getByRole('link', { name: 'basalt, Disk wear' })).toBeHidden();
  const bar = page.getByRole('navigation', { name: 'Primary' }).last();
  await expect(bar.getByRole('link', { name: 'Overview' })).toBeVisible();
  await bar.getByRole('button', { name: 'Hosts' }).click();
  const hosts = page.getByRole('dialog', { name: 'Hosts' });
  await expect(hosts.getByRole('link', { name: /basalt/ })).toHaveAttribute('aria-current', 'page');
  await hosts.getByRole('link', { name: /shale/ }).click();
  await expect(page).toHaveURL(/\/servers\/shale$/);
  await expect(hosts).toHaveCount(0);
  await bar.getByRole('button', { name: /^Menu/ }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu.getByRole('link', { name: 'Settings, 1 agent waiting for approval' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(bar.getByRole('button', { name: /^Menu/ })).toBeFocused();
  // The hosts table shows a compact row per host.
  await page.goto('/');
  await expect(page.getByRole('table').first().getByRole('columnheader', { name: 'Memory' })).toBeHidden();
  await expect(page.getByText('Mem 61%')).toBeVisible();
});

test('host: admins open the agent tab from the header', async ({ page }) => {
  await page.goto('/servers/basalt');
  await page.getByRole('link', { name: 'Settings for basalt' }).click();
  await expect(page).toHaveURL(/\/servers\/basalt\?tab=agent$/);
  await expect(page.getByRole('switch', { name: 'Console on basalt' })).toBeVisible();
  await page.goto('/servers/basalt?role=viewer');
  await expect(page.getByRole('heading', { name: 'basalt', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings for basalt' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Host sections' }).getByRole('link', { name: /^Agent/ })).toHaveCount(0);
});

test('host: unknown id shows not found', async ({ page }) => {
  await page.goto('/servers/granite');
  await expect(page.getByRole('heading', { name: 'Host not found' })).toBeVisible();
});

// Automated WCAG 2.2 AA checks (axe-core) on the main pages.
for (const path of ['/', '/?group=Lab&range=7d', '/servers/basalt', '/servers/basalt?tab=guests&platform=incus', '/servers/shale', '/servers/shale?tab=storage', '/guests']) {
  test(`axe: ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(500);
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    const summary = res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')} — ${v.help}`);
    expect(summary).toEqual([]);
  });
}
