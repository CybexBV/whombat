// Auth and admin pages in fixture mode: screenshots at 1440 and 390 px,
// interaction tests and axe-core WCAG 2.2 AA scans. Every test runs in a
// fresh browser context, so the fixture server gives it its own state
// (cookie `rackoon_fx`): signed in as admin; `?setup=1`, `?signedout=1` and
// `?role=` switch that state.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const CLOCK = new Date('2026-10-11T14:00:08Z');

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'horizontal page overflow in px').toBeLessThanOrEqual(0);
}

const enrollDialog = (page: Page) => page.getByRole('dialog', { name: 'Enroll a server' });

// ---------------------------------------------------------------- screenshots

// Dialog states are captured at viewport size (the backdrop only covers the viewport).
const SHOTS: { name: string; path: string; ready: (page: Page) => Promise<void>; viewportOnly?: boolean }[] = [
  { name: 'login', path: '/login?signedout=1', ready: (p) => expect(p.getByRole('heading', { name: 'Sign in to Rackoon' })).toBeVisible() },
  { name: 'setup', path: '/setup?setup=1', ready: (p) => expect(p.getByRole('heading', { name: 'Set up Rackoon' })).toBeVisible() },
  { name: 'agents', path: '/settings/agents', ready: (p) => expect(p.getByRole('link', { name: 'quartz', exact: true })).toBeVisible() },
  { name: 'agent', path: '/settings/agents/obsidian', ready: (p) => expect(p.getByRole('switch', { name: 'Console on obsidian' })).toBeVisible() },
  {
    name: 'agents-enroll-waiting',
    path: '/settings/agents?enroll=1',
    ready: async (p) => {
      await expect(enrollDialog(p).getByText('Expires in 59 min')).toBeVisible();
      await expect(p.getByRole('link', { name: 'quartz', exact: true })).toBeVisible();
    },
    viewportOnly: true,
  },
  {
    name: 'agents-enroll-pending',
    path: '/settings/agents?enroll=1',
    ready: async (p) => {
      await expect(enrollDialog(p).getByText('Check the details, then approve it.', { exact: false })).toBeVisible({ timeout: 20_000 });
      await expect(p.getByRole('link', { name: 'quartz', exact: true })).toBeVisible();
    },
    viewportOnly: true,
  },
  { name: 'alerts', path: '/alerts', ready: (p) => expect(p.getByRole('list', { name: 'History' }).getByRole('listitem').first()).toBeVisible() },
  { name: 'account', path: '/settings/account', ready: (p) => expect(p.getByRole('list', { name: 'Passkeys' })).toBeVisible() },
  { name: 'audit', path: '/settings/audit', ready: (p) => expect(p.getByRole('table', { name: 'Audit log' }).getByRole('row').nth(1)).toBeVisible() },
  { name: 'users', path: '/settings/users', ready: (p) => expect(p.getByRole('button', { name: 'More for olive' })).toBeVisible() },
];

for (const s of SHOTS) {
  test(`shot: ${s.name}`, async ({ page }, info) => {
    const mobile = info.project.name === 'mobile';
    await page.clock.setFixedTime(CLOCK);
    await page.goto(s.path);
    await s.ready(page);
    await settle(page);
    await page.screenshot({ path: `.screenshots/${mobile ? 'mobile-' : ''}admin-${s.name}.png`, fullPage: !s.viewportOnly });
    await noHorizontalOverflow(page);
  });
}

// ---------------------------------------------------------------- interactions (desktop)

test.describe('interactions', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop only');
    await page.clock.setFixedTime(CLOCK);
  });

  test('login: wrong password, then success returns to next', async ({ page }) => {
    await page.goto('/login?signedout=1');
    await expect(page.getByRole('heading', { name: 'Sign in to Rackoon' })).toBeVisible();
    await page.goto('/servers/basalt?range=7d');
    await expect(page).toHaveURL(/\/login\?next=%2Fservers%2Fbasalt%3Frange%3D7d$/);
    await page.getByLabel('User name').fill('admin');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Wrong user name or password.' })).toBeVisible();
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.getByLabel('Password').fill('correct horse battery');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/servers\/basalt\?range=7d$/);
    await expect(page.getByRole('heading', { name: 'basalt', level: 1 })).toBeVisible();
    // Signed in: the login page sends you away.
    await page.goto('/login?next=%2Falerts');
    await expect(page).toHaveURL(/\/alerts$/);
    // A foreign next is ignored.
    await page.goto('/login?next=https%3A%2F%2Fevil.example%2F');
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  });

  test('setup: token errors, then the account is created and signed in', async ({ page }) => {
    await page.goto('/?setup=1');
    await expect(page).toHaveURL(/\/setup$/);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByText('Printed in the hub log on first start', { exact: false })).toBeVisible();
    await page.getByLabel('Setup token').fill('not-the-token');
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Use at least 10 characters.')).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill('correct horse battery');
    await page.getByLabel('Confirm password').fill('correct horse battery');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByLabel('Setup token')).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('Setup token').fill('fixture-setup-token');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await page.goto('/setup');
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  });

  test('setup: token from the URL fragment is filled in and removed', async ({ page }) => {
    await page.goto('/setup?setup=1#token=fixture-setup-token');
    await expect(page.getByLabel('Setup token')).toHaveValue('fixture-setup-token');
    expect(new URL(page.url()).hash).toBe('');
  });

  test('logout from the account menu and from Settings', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Account: admin' }).click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu.getByRole('menuitem', { name: 'Account settings' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/login$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in to Rackoon' })).toBeVisible();
    await page.getByLabel('User name').fill('admin');
    await page.getByLabel('Password').fill('correct horse battery');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\/account$/);
    await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/settings/agents');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fagents$/);
  });

  test('enroll: command, pending agent, approve into a new group', async ({ page }) => {
    await page.goto('/?group=Lab');
    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page).toHaveURL(/\/\?group=Lab&enroll=1$/);
    const dialog = enrollDialog(page);
    await expect(dialog.getByLabel('Install command')).toContainText('--token');
    await expect(dialog.getByText('Expires in 59 min')).toBeVisible();
    await expect(dialog.getByText('Waiting for the agent…').first()).toBeVisible();
    await expect(dialog.getByText('Check the details, then approve it.', { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText('thetitan').first()).toBeVisible();
    await expect(dialog.getByLabel('Server name')).toHaveValue('thetitan');
    await expect(dialog.getByLabel('Server name')).toBeFocused();
    await dialog.getByLabel('Group').selectOption({ label: 'New group…' });
    await dialog.getByLabel('New group name').fill('Garage');
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(dialog.locator('p').filter({ hasText: 'thetitan was added to Garage.' })).toBeVisible();
    await expect(dialog.getByRole('status').filter({ hasText: 'thetitan was added to Garage.' })).toHaveCount(1);
    await expect(dialog.getByText('Remote control is off until you turn it on in the server’s settings.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Server settings' }).click();
    await expect(page).toHaveURL(/\/settings\/agents\/thetitan$/);
    await expect(enrollDialog(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'thetitan', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Server', exact: true }).getByText('Garage')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Console on thetitan' })).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Agents' }).click();
    const row = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'thetitan', exact: true }) });
    await expect(row.getByText('Garage')).toBeVisible();
    await expect(row.getByText('Off', { exact: true })).toBeVisible();
  });

  test('enroll: name collision shows the hub error; the card and the Proxmox button open it in place', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page).toHaveURL(/\/\?enroll=1$/);
    const dialog = enrollDialog(page);
    await expect(dialog.getByText('Check the details, then approve it.', { exact: false })).toBeVisible({ timeout: 20_000 });
    await dialog.getByLabel('Server name').fill('basalt');
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(dialog.getByText(/already exists/)).toBeVisible();
    // Esc closes; the URL loses the parameter (Back restores the page).
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(page.getByRole('button', { name: 'Add server' })).toBeFocused();
    await page.goto('/servers/shale?tab=virtualization');
    await page.getByRole('link', { name: 'Enroll agent on schist' }).click();
    await expect(page).toHaveURL(/\/servers\/shale\?tab=virtualization&enroll=1&name=schist$/);
    await expect(dialog.getByText('schist')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(page).toHaveURL(/\/servers\/shale\?tab=virtualization$/);
  });

  test('agents: reject a pending enrollment', async ({ page }) => {
    await page.goto('/agents');
    // The old address moved to Settings.
    await expect(page).toHaveURL(/\/settings\/agents$/);
    const pending = page.getByRole('region', { name: 'Waiting for approval' });
    await expect(pending.getByRole('rowheader', { name: 'pumice' })).toBeVisible();
    await pending.getByRole('button', { name: 'Reject pumice' }).click();
    const dlg = page.getByRole('dialog', { name: 'Reject pumice?' });
    await dlg.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Waiting for approval' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  });

  test('agents: approve the seeded pending enrollment from its row', async ({ page }) => {
    await page.goto('/settings/agents');
    // The top bar's Settings link and the settings menu say an agent is waiting.
    await expect(page.getByRole('link', { name: 'Settings, 1 agent waiting for approval' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Agents, 1 agent waiting for approval' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve pumice' }).click();
    const dlg = page.getByRole('dialog', { name: 'Approve pumice' });
    await expect(dlg.getByLabel('Server name')).toHaveValue('pumice');
    await dlg.getByLabel('Group').selectOption('Lab');
    await dlg.getByRole('button', { name: 'Approve' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'pumice', exact: true })).toBeVisible();
  });

  test('agents: the list summarizes each server; a row opens its settings', async ({ page }) => {
    await page.goto('/settings/agents');
    const row = (id: string) => page.getByRole('listitem').filter({ has: page.getByRole('link', { name: id, exact: true }) });
    await expect(row('basalt').getByText('Console and power')).toBeVisible();
    await expect(row('granite').getByText('Off', { exact: true })).toBeVisible();
    await expect(row('obsidian').getByText('1 of 5 not reporting')).toBeVisible();
    await expect(row('quartz').getByText('Clock off by 4.8 s', { exact: false })).toBeVisible();
    await expect(row('marble').getByText(/Last seen/)).toBeVisible();
    // The name's link covers the row.
    await row('obsidian').click();
    await expect(page).toHaveURL(/\/settings\/agents\/obsidian$/);
    await expect(page.getByText('permission denied while trying to connect to the Docker daemon socket', { exact: false })).toBeVisible();
    await expect(page.getByText('The host does not allow it either', { exact: false }).first()).toBeVisible();
    await page.getByRole('link', { name: 'View server' }).click();
    await expect(page).toHaveURL(/\/servers\/obsidian$/);
  });

  test('agents: remote-control switch flips, persists, and warns about the agent policy', async ({ page }) => {
    await page.goto('/settings/agents/granite');
    const sw = page.getByRole('switch', { name: 'Console on granite' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Console on granite' })).toHaveAttribute('aria-checked', 'true');
    // onyx: the agent's config forbids the console.
    await page.goto('/settings/agents/onyx');
    await expect(page.getByText('The host does not allow it either (console = false in its config)')).toBeVisible();
    await page.getByRole('switch', { name: 'Console on onyx' }).click();
    await expect(page.getByText('Turned on here, but the host does not allow it yet', { exact: false })).toBeVisible();
    await expect(page.getByText('systemctl reload rackoon-agent').first()).toBeVisible();
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Agents' }).click();
    const onyx = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'onyx', exact: true }) });
    await expect(onyx.getByText('Console blocked on host')).toBeVisible();
    const granite = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'granite', exact: true }) });
    await expect(granite.getByText('Console only')).toBeVisible();
  });

  test('agents: edit group and location', async ({ page }) => {
    await page.goto('/settings/agents/granite');
    await page.getByRole('button', { name: 'Edit granite' }).click();
    const dlg = page.getByRole('dialog', { name: 'Edit granite' });
    await expect(dlg.getByLabel('Location')).toHaveValue('Rack A · unit 5');
    await dlg.getByLabel('Group').selectOption('Lab');
    await dlg.getByLabel('Location').fill('Rack C · unit 2');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toHaveCount(0);
    const card = page.getByRole('region', { name: 'Server', exact: true });
    await expect(card.getByText('Rack C · unit 2')).toBeVisible();
    await expect(card.getByText('Lab', { exact: true })).toBeVisible();
    // Esc closes the edit dialog without saving.
    await page.getByRole('button', { name: 'Edit granite' }).click();
    await expect(dlg.getByLabel('Location')).toHaveValue('Rack C · unit 2');
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit granite' })).toBeFocused();
  });

  test('agents: delete requires typing the server name', async ({ page }) => {
    await page.goto('/settings/agents/marble');
    await page.getByRole('button', { name: 'Delete marble' }).click();
    const dlg = page.getByRole('dialog', { name: 'Delete marble?' });
    await expect(dlg.getByText('agent certificate is revoked', { exact: false })).toBeVisible();
    const del = dlg.getByRole('button', { name: 'Delete server' });
    await expect(del).toBeDisabled();
    await dlg.getByLabel('Type marble to confirm').fill('marbl');
    await expect(del).toBeDisabled();
    await dlg.getByLabel('Type marble to confirm').fill('marble');
    await expect(del).toBeEnabled();
    await del.click();
    await expect(dlg).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings\/agents$/);
    await expect(page.getByRole('link', { name: 'marble', exact: true })).toHaveCount(0);
  });

  test('settings: audit log paging and event filter; CSV link', async ({ page }) => {
    await page.goto('/settings/audit');
    const table = page.getByRole('table', { name: 'Audit log' });
    await expect(table.getByRole('row')).toHaveCount(101);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(table.getByRole('row')).toHaveCount(201);
    await page.getByLabel('Event', { exact: true }).selectOption('console.opened');
    await expect(page).toHaveURL(/event=console\.opened/);
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    const events = await table.locator('tbody tr td:nth-child(3)').allTextContents();
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events)).toEqual(new Set(['console.opened']));
    await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveAttribute('href', /\/api\/v1\/audit\/export\?event=console\.opened/);
    await page.getByLabel('Server', { exact: true }).selectOption('shale');
    const servers = await table.locator('tbody tr td:nth-child(4)').allTextContents();
    expect(servers.every((s) => s.startsWith('shale'))).toBe(true);
  });

  test('settings: change password errors and success', async ({ page }) => {
    await page.goto('/settings/account');
    await page.getByLabel('Current password').fill('wrong-password');
    await page.getByLabel('New password', { exact: true }).fill('another long password');
    await page.getByLabel('Confirm new password').fill('another long password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('The current password is wrong.')).toBeVisible();
    await page.getByLabel('Current password').fill('correct horse battery');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Password changed. Other sessions were signed out.')).toBeVisible();
    await expect(page.getByLabel('Current password')).toHaveValue('');
  });

  test('settings: passkey list and removal', async ({ page }) => {
    await page.goto('/settings/account');
    const list = page.getByRole('list', { name: 'Passkeys' });
    await expect(list.getByText('MacBook Touch ID', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove passkey MacBook Touch ID' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove passkey' }).click();
    await expect(page.getByText('No passkeys yet.')).toBeVisible();
  });

  test('passkeys: add one and sign in with it (CDP virtual authenticator on localhost)', async ({ page, baseURL }) => {
    // WebAuthn needs a host name: use localhost instead of the 127.0.0.1 base URL.
    const origin = baseURL!.replace('127.0.0.1', 'localhost');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await page.goto(`${origin}/settings/account`);
    await page.getByRole('button', { name: 'Add passkey' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add a passkey' });
    await expect(dlg.getByLabel('Name')).toBeFocused();
    await dlg.getByLabel('Name').fill('Virtual key');
    await dlg.getByRole('button', { name: 'Continue' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Passkeys' }).getByText('Virtual key', { exact: true })).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  });

  test('viewer: only Account; audit log and agents need admin access', async ({ page }) => {
    await page.goto('/settings?role=viewer');
    await expect(page).toHaveURL(/\/settings\/account\?role=viewer$/);
    await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
    await expect(page.getByText('Viewer', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    await page.goto('/settings/audit');
    await expect(page.getByRole('heading', { name: 'Requires admin access' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Audit log' })).toHaveCount(0);
    await page.goto('/settings/agents');
    await expect(page.getByRole('heading', { name: 'Requires admin access' })).toBeVisible();
    // No admin actions in the command palette.
    await page.getByRole('button', { name: /Search hosts, guests/ }).click();
    const palette = page.getByRole('dialog', { name: 'Search' });
    await expect(palette.getByRole('group', { name: 'Hosts' }).getByRole('option')).toHaveCount(8);
    await expect(palette.getByRole('option', { name: /Enroll a server/ })).toHaveCount(0);
  });

  test('alerts: open and recently resolved', async ({ page }) => {
    await page.goto('/alerts');
    await expect(page.getByRole('list', { name: 'Open' }).getByRole('listitem')).toHaveCount(3);
    const resolved = page.getByRole('list', { name: 'History' });
    await expect(resolved.getByRole('listitem')).toHaveCount(6);
    await expect(resolved.getByText('open for 41 min', { exact: false })).toBeVisible();
  });
});

// ---------------------------------------------------------------- axe (desktop and mobile)

const AXE: { path: string; ready: (page: Page) => Promise<void> }[] = [
  { path: '/login?signedout=1', ready: (p) => expect(p.getByRole('heading', { name: 'Sign in to Rackoon' })).toBeVisible() },
  { path: '/setup?setup=1', ready: (p) => expect(p.getByRole('heading', { name: 'Set up Rackoon' })).toBeVisible() },
  { path: '/settings/agents', ready: (p) => expect(p.getByRole('link', { name: 'quartz', exact: true })).toBeVisible() },
  { path: '/settings/agents?enroll=1', ready: (p) => expect(enrollDialog(p).getByText('Check the details, then approve it.', { exact: false })).toBeVisible({ timeout: 20_000 }) },
  { path: '/settings/agents/obsidian', ready: (p) => expect(p.getByRole('switch', { name: 'Console on obsidian' })).toBeVisible() },
  { path: '/alerts', ready: (p) => expect(p.getByRole('heading', { name: 'History' })).toBeVisible() },
  { path: '/settings/account', ready: (p) => expect(p.getByRole('list', { name: 'Passkeys' })).toBeVisible() },
  { path: '/settings/audit', ready: (p) => expect(p.getByRole('table', { name: 'Audit log' })).toBeVisible() },
  { path: '/settings/users', ready: (p) => expect(p.getByRole('button', { name: 'More for olive' })).toBeVisible() },
];

for (const a of AXE) {
  test(`axe: ${a.path}`, async ({ page }) => {
    await page.clock.setFixedTime(CLOCK);
    await page.goto(a.path);
    await a.ready(page);
    await page.waitForTimeout(400);
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    const summary = res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')} — ${v.help}`);
    expect(summary).toEqual([]);
  });
}
