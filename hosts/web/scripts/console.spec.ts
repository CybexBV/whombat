// Console, power actions, paste safety and the Screens wall in fixture mode
// (mock console WebSocket with a fake shell; VNC/SPICE answer with an error
// in fixture mode). Screenshots of the console states go to .screenshots/.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const BASALT = '/servers/basalt';
const consolePath = (server: string, guest: string, query = '') => `/servers/${server}/guests/${encodeURIComponent(guest)}/console${query}`;

async function termText(page: Page): Promise<string> {
  return (await page.locator('.xterm-rows').first().innerText()).replace(/ /g, ' ');
}

async function waitConnected(page: Page, label: string) {
  await expect(page.getByText(new RegExp(`Connected · ${label.replace(/[()]/g, '\\$&')} · encrypted`))).toBeVisible({ timeout: 15_000 });
}

async function typeInTerminal(page: Page, text: string) {
  await page.locator('.con-screen').click({ position: { x: 40, y: 40 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.describe('console (desktop)', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop only');
    page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  });

  test('shell: connects, echoes input, shows size and measured latency', async ({ page }) => {
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await waitConnected(page, 'Shell');
    await expect(page.getByText(/^\d+×\d+ · \d+ ms latency$/)).toBeVisible({ timeout: 15_000 });
    await typeInTerminal(page, 'echo rackoon-42');
    await expect.poll(() => termText(page)).toMatch(/rackoon-42[\s\S]*rackoon-42/);
    await expect(page.getByText('Type in the terminal · Ctrl+D to log out')).toBeVisible();
  });

  test('keyboard: Enter on the screen captures keys, Ctrl+Alt releases them', async ({ page }) => {
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await waitConnected(page, 'Shell');
    const screen = page.getByRole('group', { name: 'dev-shell screen' });
    await screen.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
    await expect(screen).toBeFocused();
    // Focus can leave the console with Tab.
    await page.keyboard.press('Tab');
    await expect(screen).not.toBeFocused();
  });

  test('switching guests from the table beside the panel closes the old session and opens a new one', async ({ page }) => {
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await waitConnected(page, 'Shell');
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    const closed: string[] = [];
    page.on('websocket', (ws) => ws.on('close', () => closed.push(ws.url())));
    await page.getByRole('button', { name: 'Open shell for git-mirror' }).click();
    await expect(page).toHaveURL(/guests\/incus%3Agit-mirror\/console/);
    await expect(page.getByRole('region', { name: 'Shell for git-mirror' })).toBeVisible();
    await waitConnected(page, 'Shell');
    await expect(page.getByRole('row', { selected: true })).toContainText('git-mirror');
    await expect.poll(() => sockets.length).toBe(1);
    // The hub audits the switch (fixture: console.switched record).
    const audit = await (await page.request.get('/api/v1/audit?event=console.switched&limit=5')).json();
    expect(audit.items.length).toBeGreaterThan(0);
    expect(audit.items[0].guest).toBe('incus:git-mirror');
    // Close ends the session and returns to the list.
    await page.getByRole('button', { name: 'Close the shell of git-mirror' }).click();
    await expect(page).toHaveURL(/\/servers\/basalt\?tab=guests&platform=incus$/);
    await expect.poll(() => closed.length).toBe(1);
  });

  test('connection lost shows Reconnect, which opens a new session', async ({ page }) => {
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await waitConnected(page, 'Shell');
    await typeInTerminal(page, 'simulate-drop');
    await expect(page.getByText(/^Connection lost/)).toBeVisible();
    await page.getByRole('button', { name: 'Reconnect' }).click();
    await waitConnected(page, 'Shell');
  });

  test('idle timeout from the hub is explained', async ({ page }) => {
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await waitConnected(page, 'Shell');
    await typeInTerminal(page, 'simulate-idle');
    await expect(page.getByText('Connection lost · Closed after 15 minutes without input ·')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  });

  test('graphical protocols explain fixture mode inline', async ({ page }) => {
    await page.goto(consolePath('basalt', 'libvirt:win11-test', '?platform=libvirt'));
    await expect(page.getByText(/VNC is not available in fixture mode/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByText('Not connected', { exact: true })).toBeVisible();
    // Switching the connection type reconnects with the other protocol.
    await page.getByRole('group', { name: 'Connection type' }).getByRole('button', { name: 'SPICE' }).click();
    await expect(page).toHaveURL(/protocol=spice/);
    await expect(page.getByText(/SPICE is not available in fixture mode/)).toBeVisible({ timeout: 15_000 });
  });

  test('protocol unavailable: the option is disabled with its reason', async ({ page }) => {
    // Patch the detail body and the guest list: Incus VMs gain an unavailable VNC option.
    const patch = (guests: { kind: string; console: Record<string, unknown> }[]) => {
      for (const g of guests) if (g.kind === 'vm') g.console.unavailable = { vnc: 'VNC is not enabled for this VM' };
    };
    await page.route(/\/api\/v1\/servers\/basalt(\?|$)/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      patch(body.workloads.incus.guests);
      await route.fulfill({ response: res, json: body });
    });
    await page.route(/\/api\/v1\/servers\/basalt\/guests\?/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      patch(body.guests ?? body);
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(consolePath('basalt', 'incus:nixbuild', '?platform=incus&protocol=serial'));
    const vnc = page.getByRole('group', { name: 'Connection type' }).getByRole('button', { name: 'VNC' });
    await expect(vnc).toHaveAttribute('aria-disabled', 'true');
    await expect(vnc).toHaveAttribute('title', 'VNC is not enabled for this VM');
    // aria-disabled keeps it focusable for the tooltip; clicking does nothing.
    await vnc.click({ force: true });
    await expect(page).not.toHaveURL(/protocol=vnc/);
  });

  test('stopped guest: powered off screen, Start needs power and connects afterwards', async ({ page }) => {
    await page.goto(consolePath('basalt', 'incus:scratch', '?platform=incus'));
    await expect(page.getByText('scratch is powered off')).toBeVisible();
    await expect(page.getByText('Not connected · the guest is powered off')).toBeVisible();
    for (const name of ['Paste', 'Copy output', 'Restart', 'Stop']) {
      await expect(page.getByRole('toolbar').getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-disabled', 'true');
    }
    await page.getByRole('button', { name: 'Start container' }).click();
    await expect(page.getByText('Starting…').first()).toBeVisible();
    await waitConnected(page, 'Shell');
  });

  test('power actions: confirmation names guest and action, Esc cancels, serious needs the name', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/actions')) posts.push(r.postData() ?? '');
    });
    await page.goto(consolePath('basalt', 'incus:nixbuild', '?platform=incus&protocol=serial'));
    await page.getByRole('toolbar').getByRole('button', { name: 'Shutdown' }).click();
    const dialog = page.getByRole('dialog', { name: 'Shut down nixbuild?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Shut down nixbuild' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(posts).toEqual([]);

    await page.getByRole('toolbar').getByRole('button', { name: 'Force stop' }).click();
    const fs = page.getByRole('dialog', { name: 'Force stop nixbuild?' });
    await expect(fs.getByText(/data in the guest may be lost/)).toBeVisible();
    const go = fs.getByRole('button', { name: 'Force stop nixbuild' });
    await expect(go).toHaveAttribute('aria-disabled', 'true');
    await go.click({ force: true });
    expect(posts).toEqual([]);
    await fs.getByLabel('Type nixbuild to confirm').fill('nixbuil');
    await expect(go).toHaveAttribute('aria-disabled', 'true');
    await fs.getByLabel('Type nixbuild to confirm').fill('nixbuild');
    await expect(go).not.toHaveAttribute('aria-disabled', 'true');
    await go.click();
    await expect(fs).toHaveCount(0);
    expect(JSON.parse(posts[0]!)).toEqual({ action: 'force_stop', confirm: true });
    await expect(page.getByText('Stopping…').first()).toBeVisible();
    await expect(page.getByText('nixbuild is powered off')).toBeVisible({ timeout: 15_000 });
  });

  test('action errors are reported', async ({ page }) => {
    await page.goto(consolePath('basalt', 'libvirt:truenas-lab', '?platform=libvirt'));
    await page.getByRole('button', { name: 'Start VM' }).click();
    await expect(page.getByText(/Start failed: .*not enough memory/)).toBeVisible({ timeout: 15_000 });
  });

  test('paste: dialog fallback, control characters are stripped unless raw, 1 MB is rejected', async ({ page }) => {
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await waitConnected(page, 'Shell');
    await page.getByRole('toolbar').getByRole('button', { name: 'Paste' }).click();
    const dlg = page.getByRole('dialog', { name: 'Paste into dev-shell' });
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('Text to paste').fill('x'.repeat(70 * 1024));
    await expect(dlg.getByText('The text is 70 KB; the limit is 64 KB.')).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Send to dev-shell' })).toHaveAttribute('aria-disabled', 'true');
    await dlg.getByLabel('Text to paste').fill('echo safe\u001b[31m-paste\u0007');
    await dlg.getByRole('button', { name: 'Send to dev-shell' }).click();
    const ctl = page.getByRole('dialog', { name: 'The text contains control characters' });
    await expect(ctl).toContainText('2 control characters (ESC, BEL)');
    await ctl.getByRole('button', { name: 'Paste without them' }).click();
    await expect(page.getByText('Pasted 19 characters')).toBeVisible({ timeout: 15_000 });
    // The terminal has the keyboard again after pasting.
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => termText(page)).toContain('safe[31m-paste');
  });

  test('paste: clipboard text is read on click and a 1 MB clipboard is refused', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await waitConnected(page, 'Shell');
    await page.evaluate(() => navigator.clipboard.writeText('echo from-clipboard'));
    await page.getByRole('toolbar').getByRole('button', { name: 'Paste' }).click();
    await expect(page.getByText('Pasted 19 characters')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');
    await expect.poll(() => termText(page)).toMatch(/from-clipboard[\s\S]*from-clipboard/);
    await page.evaluate(() => navigator.clipboard.writeText('y'.repeat(1024 * 1024)));
    await page.getByRole('toolbar').getByRole('button', { name: 'Paste' }).click();
    await expect(page.getByRole('alert').getByText(/1\.0 MB; the paste limit is 64 KB/)).toBeVisible({ timeout: 15_000 });
  });

  test('copy output copies the terminal buffer', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await waitConnected(page, 'Shell');
    await typeInTerminal(page, 'echo copy-me');
    await expect.poll(() => termText(page)).toMatch(/copy-me[\s\S]*copy-me/);
    await page.getByRole('toolbar').getByRole('button', { name: 'Copy output' }).click();
    await expect(page.getByText(/^Copied \d+ lines?$/)).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('copy-me');
  });

  test('session limit: a readable message', async ({ page }) => {
    await page.goto(BASALT);
    for (let i = 0; i < 5; i++) {
      const r = await page.request.post('/api/v1/servers/basalt/guests/incus%3Adns/console-sessions', { data: {}, headers: { 'X-CSRF-Token': 'x' } });
      expect(r.status()).toBe(201);
    }
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await expect(page.getByRole('alert').getByText('Too many open consoles. Close one and try again.')).toBeVisible();
    await expect(page.locator('.con-screen').getByText('Too many open consoles. Close one and try again.')).toBeVisible();
  });

  test('remote control turned off: disabled state with the reason', async ({ page }) => {
    await page.goto(BASALT);
    const r = await page.request.patch('/api/v1/servers/basalt', { data: { remote_control: { console: false } }, headers: { 'X-CSRF-Token': 'x' } });
    expect(r.ok()).toBe(true);
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await expect(page.locator('.con-screen').getByText('Remote control is turned off for this server')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Turn on remote control in the server’s settings' })).toBeVisible();
    await expect(page.getByText('Not connected · remote control is off')).toBeVisible();
    await page.goto(`${BASALT}?tab=guests&platform=incus`);
    await expect(page.getByRole('button', { name: 'Open shell for dev-shell' })).toHaveAttribute('aria-disabled', 'true');
    // The Screens wall shows the reason instead of live screens and requests no thumbnails.
    const thumbs: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/thumbnail')) thumbs.push(r.url());
    });
    await page.goto(`${BASALT}?tab=guests&platform=incus&view=screens`);
    await page.getByRole('list', { name: 'Screens' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('list', { name: 'Screens' }).getByText('Remote control is turned off for this server').first()).toBeVisible();
    await page.waitForTimeout(1000);
    expect(thumbs).toEqual([]);
  });

  test('power permission off: console works, power buttons are disabled and Start is not offered', async ({ page }) => {
    await page.goto(BASALT);
    const r = await page.request.patch('/api/v1/servers/basalt', { data: { remote_control: { power: false } }, headers: { 'X-CSRF-Token': 'x' } });
    expect(r.ok()).toBe(true);
    await page.goto(consolePath('basalt', 'incus:dev-shell', '?platform=incus'));
    await waitConnected(page, 'Shell');
    for (const name of ['Restart', 'Stop']) {
      const b = page.getByRole('toolbar').getByRole('button', { name: new RegExp(`^${name}`) });
      await expect(b).toHaveAttribute('aria-disabled', 'true');
      await expect(b).toHaveAttribute('title', 'Remote control is turned off for this server');
    }
    await page.getByRole('button', { name: 'Open shell for scratch' }).click();
    await expect(page.getByText('scratch is powered off')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start container' })).toHaveCount(0);
  });

  test('screens wall: thumbnails only for visible tiles and only while the tab is visible', async ({ page }) => {
    const thumbs: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/thumbnail')) thumbs.push(decodeURIComponent(r.url()));
    });
    // A short viewport: header, tabs, filters and the card head fill it; the tiles start more than the observer's 100 px margin below the fold.
    await page.setViewportSize({ width: 1440, height: 240 });
    await page.goto(`${BASALT}?tab=guests&platform=incus&view=screens`);
    await expect(page.getByRole('list', { name: 'Screens' }).getByRole('button')).toHaveCount(7);
    await page.waitForTimeout(1500);
    expect(thumbs, 'tiles far below the fold are not requested').toEqual([]);
    await page.getByRole('list', { name: 'Screens' }).scrollIntoViewIfNeeded();
    await expect.poll(() => thumbs.some((u) => u.includes('incus:nixbuild'))).toBe(true);
    expect(thumbs.some((u) => u.includes('incus:scratch')), 'stopped guests are not requested').toBe(false);
    await expect(page.getByRole('button', { name: /Open shell for scratch \(Container, powered off\)/ })).toContainText('scratch is powered off');
    // Refresh about every 5 s.
    const n = thumbs.filter((u) => u.includes('incus:nixbuild')).length;
    await expect.poll(() => thumbs.filter((u) => u.includes('incus:nixbuild')).length, { timeout: 9000 }).toBeGreaterThan(n);
    // Hidden tab: no more requests.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    const frozen = thumbs.length;
    await page.waitForTimeout(6000);
    expect(thumbs.length).toBe(frozen);
    // Clicking a tile opens its console.
    await page.getByRole('button', { name: /Open console for ci-runner/ }).click();
    await expect(page).toHaveURL(/guests\/incus%3Aci-runner\/console/);
  });

  for (const [name, path] of [
    ['console shell', consolePath('basalt', 'incus:dev-shell', '?platform=incus')],
    ['console stopped', consolePath('basalt', 'incus:scratch', '?platform=incus')],
    ['screens wall', `${BASALT}?tab=guests&platform=incus&view=screens`],
  ] as const) {
    test(`axe: ${name}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(1500);
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('.xterm-helper-textarea').analyze();
      const summary = res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')} — ${v.help}`);
      expect(summary).toEqual([]);
    });
  }

  test('axe: power confirmation dialog', async ({ page }) => {
    await page.goto(consolePath('basalt', 'incus:nixbuild', '?platform=incus&protocol=serial'));
    await page.getByRole('toolbar').getByRole('button', { name: 'Force stop' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const res = await new AxeBuilder({ page }).include('dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(res.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

// Screenshots of the console states (web/.screenshots/).
const SHOTS: { name: string; path: string; ready: RegExp | string; mobile?: boolean; desktop?: boolean }[] = [
  { name: 'server-incus-console-vm-serial', path: consolePath('basalt', 'incus:nixbuild', '?platform=incus&protocol=serial'), ready: /Connected · Serial/ },
  { name: 'server-incus-console-container', path: consolePath('basalt', 'incus:dev-shell', '?platform=incus'), ready: /Connected · Shell/ },
  { name: 'server-incus-console-stopped', path: consolePath('basalt', 'incus:scratch', '?platform=incus'), ready: 'scratch is powered off' },
  { name: 'server-qemu-console-windows', path: consolePath('basalt', 'libvirt:win11-test', '?platform=libvirt'), ready: /not available in fixture mode/ },
  { name: 'proxmox-lxc-console', path: consolePath('shale', 'pve:203', '?platform=ct'), ready: /Connected · xterm\.js/ },
  { name: 'proxmox-vm-console-serial', path: consolePath('shale', 'pve:105', '?protocol=serial'), ready: /Connected · Serial/ },
  { name: 'server-incus-screens-live', path: `${BASALT}?tab=guests&platform=incus&view=screens`, ready: 'Showing all 7 instances' },
  { name: 'proxmox-vm-screens', path: '/servers/shale?tab=guests&view=screens', ready: 'Showing 8 of 22 VMs' },
];

for (const s of SHOTS) {
  test(`screenshot ${s.name}`, async ({ page }, info) => {
    const mobile = info.project.name === 'mobile';
    test.skip(mobile ? s.mobile === false : s.desktop === false, 'not captured at this width');
    await page.clock.setFixedTime(new Date('2026-10-11T14:00:08Z'));
    await page.goto(s.path);
    await expect(page.getByText(s.ready).first()).toBeVisible({ timeout: 20_000 });
    if (s.name.includes('screens')) {
      await page.locator('.screens-grid').scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `.screenshots/${mobile ? 'mobile-' : ''}${s.name}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'horizontal page overflow in px').toBeLessThanOrEqual(0);
  });
}
