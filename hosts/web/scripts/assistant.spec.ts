// The assistant (docs/ASSIST.md) in fixture mode: Settings › Assistant,
// starting investigations from alerts, the host header and the command
// palette, the investigation panel (transcript, tool steps, approvals,
// replies, Stop, Delete), phone width, the Diagnostics switch, axe scans and
// screenshots (`assistant-*.png`). The fixtures keep the assistant off;
// a page loaded with `?assistant=1` turns it on for that browser (both CLIs
// installed, four investigations seeded), `?reauth=1` makes the next change
// ask for the password.
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

async function axe(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')} — ${v.help}`);
}

const panel = (page: Page) => page.getByRole('dialog', { name: /./ }).filter({ has: page.getByRole('log', { name: 'Transcript' }) });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(CLOCK);
});

// ---------------------------------------------------------------- screenshots

const SHOTS: { name: string; path: string; ready: (p: Page) => Promise<void>; light?: boolean; viewportOnly?: boolean }[] = [
  { name: 'settings-off', path: '/settings/assistant', ready: (p) => expect(p.getByRole('button', { name: 'Install Claude Code' })).toBeVisible() },
  { name: 'settings', path: '/settings/assistant?assistant=1', ready: (p) => expect(p.getByRole('link', { name: /nvme1n1 wear at 78%/ })).toBeVisible(), light: true },
  { name: 'alerts', path: '/alerts?assistant=1', ready: (p) => expect(p.getByRole('button', { name: /Waiting for you: open the investigation/ })).toBeVisible(), viewportOnly: true },
  {
    name: 'panel-approval',
    path: '/alerts?assistant=1&investigation=inv_wear',
    ready: (p) => expect(p.getByRole('group', { name: 'Run this command on basalt?' })).toBeVisible(),
    light: true,
    viewportOnly: true,
  },
  {
    name: 'panel-summary',
    path: '/?assistant=1&investigation=inv_md0',
    ready: async (p) => {
      await expect(p.getByText('Needs attention', { exact: true })).toBeVisible();
      await p.getByRole('button', { name: /^RAID arrays/ }).click();
    },
    viewportOnly: true,
  },
];

for (const s of SHOTS) {
  test(`shot: ${s.name}`, async ({ page }, info) => {
    const mobile = info.project.name === 'mobile';
    await page.goto(s.path);
    await s.ready(page);
    await settle(page);
    await page.screenshot({ path: `.screenshots/${mobile ? 'mobile-' : ''}assistant-${s.name}.png`, fullPage: !s.viewportOnly });
    await noHorizontalOverflow(page);
  });
  if (s.light) {
    test(`shot: ${s.name} (light)`, async ({ page }, info) => {
      test.skip(info.project.name === 'mobile', 'light theme at desktop width');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(s.path);
      await s.ready(page);
      await settle(page);
      await page.screenshot({ path: `.screenshots/assistant-${s.name}-light.png`, fullPage: !s.viewportOnly });
    });
  }
}

// ---------------------------------------------------------------- interactions (desktop)

test.describe('interactions', () => {
  test.beforeEach(async ({}, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop only');
  });

  test('off: no assistant buttons; the settings page sets it up', async ({ page }) => {
    await page.goto('/alerts');
    await expect(page.getByRole('list', { name: 'Open' }).getByRole('listitem')).toHaveCount(3);
    await expect(page.getByRole('button', { name: /^Investigate/ })).toHaveCount(0);
    await page.goto('/servers/basalt');
    await expect(page.getByRole('heading', { name: 'basalt', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ask assistant' })).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Search' }).getByRole('option', { name: /Ask the assistant/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByRole('link', { name: 'Settings, 1 agent waiting for approval' }).click();
    await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Assistant' }).click();
    await expect(page).toHaveURL(/\/settings\/assistant$/);
    await expect(page.getByRole('heading', { name: 'Assistant', level: 1 })).toBeVisible();
    const sw = page.getByRole('switch', { name: 'Assistant' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Install Claude Code or Codex below and sign in')).toBeVisible();
    // Codex is not installed: it cannot be the default yet.
    await expect(page.getByRole('group', { name: 'Default provider' }).getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-disabled', 'true');

    // Claude Code: install with progress, then sign in with a token.
    const claude = page.getByRole('region', { name: 'Claude Code' });
    await claude.getByRole('button', { name: 'Install Claude Code' }).click();
    await expect(claude.getByText(/Installing…/)).toBeVisible();
    await expect(claude.getByText('2.3.16')).toBeVisible({ timeout: 10_000 });
    await claude.getByRole('button', { name: 'Sign in Claude Code' }).click();
    const dlg = page.getByRole('dialog', { name: 'Sign in to Claude Code' });
    await expect(dlg.getByText('claude setup-token')).toBeVisible();
    await dlg.getByLabel('Token').fill('not-a-token');
    await dlg.getByRole('button', { name: 'Sign in' }).click();
    await expect(dlg.getByText('Paste the token that `claude setup-token` prints.')).toBeVisible();
    await dlg.getByLabel('Token').fill('sk-ant-oat01-fixturetoken');
    await dlg.getByRole('button', { name: 'Sign in' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(claude.getByText('Claude subscription')).toBeVisible();
    await expect(claude.getByText('Ready')).toBeVisible();
    await expect(page.getByText('Install Claude Code or Codex below and sign in')).toHaveCount(0);

    // Codex: the device code, then signed in by itself (SSE).
    const codex = page.getByRole('region', { name: 'Codex' });
    await codex.getByRole('button', { name: 'Install Codex' }).click();
    await codex.getByRole('button', { name: 'Sign in Codex' }).click({ timeout: 10_000 });
    await expect(codex.getByText('K7QX-4HTM')).toBeVisible();
    await expect(codex.getByRole('link', { name: /auth\.openai\.com\/codex\/device/ })).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(codex.getByText('admin@example.com (plus)')).toBeVisible({ timeout: 10_000 });
    await expect(codex.getByText('K7QX-4HTM')).toHaveCount(0);

    // Settings apply at once.
    await page.getByRole('group', { name: 'Default provider' }).getByRole('button', { name: 'Codex' }).click();
    await expect(page.getByRole('group', { name: 'Default provider' }).getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('radio', { name: /^Read only/ }).check();
    await page.getByRole('group', { name: 'Investigate new alerts automatically' }).getByRole('button', { name: 'Critical alerts' }).click();
    await page.getByText('Advanced').click();
    await page.getByLabel('Claude Code model').fill('sonnet');
    await page.getByRole('button', { name: 'Save models' }).click();
    await expect(page.getByText('Models saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('radio', { name: /^Read only/ })).toBeChecked();
    await expect(page.getByRole('group', { name: 'Investigate new alerts automatically' }).getByRole('button', { name: 'Critical alerts' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Claude Code model')).toHaveValue('sonnet');
    // Nothing investigated yet.
    await expect(page.getByRole('heading', { name: 'Recent investigations' })).toBeVisible();
    await expect(page.getByText('No investigations yet.', { exact: false })).toBeVisible();
  });

  test('a change asks for a recent sign-in, then goes through', async ({ page }) => {
    await page.goto('/settings/assistant?reauth=1');
    await page.getByRole('switch', { name: 'Assistant' }).click();
    const dlg = page.getByRole('dialog', { name: "Confirm it's you" });
    await dlg.getByLabel('Password').fill('correct horse battery');
    await dlg.getByRole('button', { name: 'Confirm' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Assistant' })).toHaveAttribute('aria-checked', 'true');
  });

  test('not sandboxed: the settings say so', async ({ page }) => {
    await page.goto('/settings/assistant?assistant=nosandbox');
    await expect(page.getByText(/Not sandboxed: the hub runs the CLIs as its own child process/)).toBeVisible();
  });

  test('an alert starts an investigation; the panel follows it live', async ({ page }) => {
    await page.goto('/alerts?assistant=1');
    const open = page.getByRole('list', { name: 'Open' });
    // The disk alert already has one, waiting for an approval.
    await expect(open.getByRole('button', { name: 'Waiting for you: open the investigation of nvme1n1 wear at 78%' })).toBeVisible();
    const start = open.getByRole('button', { name: 'Investigate CPU package at 83 °C' });
    await start.click();
    await expect(page).toHaveURL(/investigation=inv_1/);
    const p = panel(page);
    await expect(p.getByRole('heading', { name: 'CPU package at 83 °C' })).toBeVisible();
    await expect(p).toBeFocused();
    await expect(p.getByRole('link', { name: 'shale' })).toHaveAttribute('href', '/servers/shale?investigation=inv_1');
    await expect(p.getByText('Claude Code', { exact: true })).toBeVisible();
    const log = p.getByRole('log', { name: 'Transcript' });
    await expect(log.getByText('Investigate the alert “CPU package at 83 °C” on shale.')).toBeVisible();
    await expect(log.getByRole('button', { name: /Temperatures · 24 h · shale/ })).toBeVisible();
    await expect(p.getByRole('button', { name: 'Stop' })).toBeVisible();
    // Tool steps arrive one by one; the summary ends it.
    await expect(log.getByText('Check fan2 on shale.')).toBeVisible({ timeout: 15_000 });
    await expect(log.getByText('Needs attention', { exact: true })).toBeVisible();
    await expect(p.getByText('Done · needs attention')).toBeVisible();
    await expect(p.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await expect(p.getByText('≈ $0.09')).toBeVisible();
    // A step expands to its input and output.
    const step = log.getByRole('button', { name: /Sensors · shale/ });
    await expect(step).toHaveAttribute('aria-expanded', 'false');
    await step.click();
    await expect(step).toHaveAttribute('aria-expanded', 'true');
    await expect(log.getByRole('definition').filter({ hasText: 'sensors' })).toBeVisible();
    await expect(log.getByLabel('Output of Sensors')).toContainText('fan2:    0 RPM');
    // Escape closes the panel and gives the focus back; the row shows the result.
    await page.keyboard.press('Escape');
    await expect(p).toHaveCount(0);
    await expect(page).not.toHaveURL(/investigation=/);
    const done = open.getByRole('button', { name: 'Investigated: open the investigation of CPU package at 83 °C' });
    await expect(done).toBeVisible();
    await done.click();
    await expect(panel(page).getByRole('heading', { name: 'CPU package at 83 °C' })).toBeVisible();
  });

  test('the Watch panel shows the state of an alert’s investigation', async ({ page }) => {
    await page.goto('/?assistant=1');
    const watch = page.getByRole('list', { name: 'Open alerts and hints' });
    await watch.getByRole('button', { name: 'Waiting for you: open the investigation of nvme1n1 wear at 78%' }).click();
    await expect(page).toHaveURL(/investigation=inv_wear/);
    await expect(panel(page).getByRole('heading', { name: 'nvme1n1 wear at 78%' })).toBeVisible();
    await expect(watch.getByRole('button', { name: 'Investigate Agent unreachable' })).toBeVisible();
  });

  test('approve a command with a reply; reply to the assistant', async ({ page }) => {
    await page.goto('/alerts?assistant=1&investigation=inv_wear');
    const p = panel(page);
    const card = p.getByRole('group', { name: 'Run this command on basalt?' });
    await expect(card.getByLabel('Command')).toHaveText('smartctl -t short /dev/nvme1n1');
    await expect(card.getByText('A short self-test checks the controller')).toBeVisible();
    await expect(p.getByText('Waiting for you', { exact: true })).toBeVisible();
    // The transcript starts at its end (the newest event).
    const log = p.getByRole('log', { name: 'Transcript' });
    await expect.poll(() => log.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
    await card.getByLabel('Reply with your decision (optional)').fill('Go ahead, it is idle now');
    const req = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/assistant/investigations/inv_wear/approvals/ap_1'));
    await card.getByRole('button', { name: 'Run' }).click();
    expect((await req).postDataJSON()).toEqual({ approve: true, reply: 'Go ahead, it is idle now' });
    const decided = p.getByRole('group', { name: 'Command on basalt' });
    await expect(decided.getByText('Approved by admin · “Go ahead, it is idle now”')).toBeVisible();
    await expect(decided.getByRole('button', { name: 'Run' })).toHaveCount(0);
    await expect(log.getByText('The self-test is running; I will read its result in about 2 minutes.')).toBeVisible({ timeout: 10_000 });
    await decided.getByRole('button', { name: /Output/ }).click();
    await expect(decided.getByLabel('Output of Run command')).toContainText('Testing has begun.');
    await expect(p.getByText('Answered', { exact: true })).toBeVisible();

    // Reply: Shift+Enter is a new line, Enter sends.
    const box = p.getByRole('textbox', { name: 'Reply to the assistant' });
    await expect(box).toHaveAttribute('placeholder', 'Reply or give the assistant more context…');
    await box.fill('When is the warranty over?');
    await box.press('Shift+Enter');
    await box.pressSequentially('And the price?');
    await expect(box).toHaveValue('When is the warranty over?\nAnd the price?');
    await box.press('Enter');
    await expect(log.getByText('When is the warranty over? And the price?')).toBeVisible();
    await expect(box).toHaveValue('');
    await expect(box).toBeFocused();
    await expect(log.getByText(/^Noted: “When is the warranty over\?/)).toBeVisible({ timeout: 10_000 });
  });

  test('decline a guest action; stop; delete', async ({ page }) => {
    await page.goto('/settings/assistant?assistant=1&investigation=inv_wear');
    const p = panel(page);
    const card = p.getByRole('group', { name: 'Run this command on basalt?' });
    await card.getByRole('button', { name: 'Decline' }).click();
    await expect(p.getByRole('group', { name: 'Command on basalt' }).getByText('Declined by admin')).toBeVisible();
    await expect(p.getByRole('log', { name: 'Transcript' }).getByText(/^Understood, I won't run it\./)).toBeVisible({ timeout: 10_000 });

    // Ask something new, stop it while it runs.
    await p.getByRole('textbox', { name: 'Reply to the assistant' }).fill('Look at the other disk too');
    await p.getByRole('textbox', { name: 'Reply to the assistant' }).press('Enter');
    await p.getByRole('button', { name: 'Stop' }).click();
    await expect(p.getByText('Stopped by admin')).toBeVisible();
    await expect(p.getByText('Stopped', { exact: true })).toBeVisible();

    // Delete from the overflow menu, after a confirmation.
    await p.getByRole('button', { name: 'More for this investigation' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this investigation?' });
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(p).toBeVisible();
    await p.getByRole('button', { name: 'More for this investigation' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(p).toHaveCount(0);
    await expect(page.getByText('Investigation deleted.')).toBeVisible();
    await expect(page.getByRole('link', { name: /nvme1n1 wear at 78%/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Array md0 is degraded/ })).toBeVisible();
  });

  test('the host header and the command palette ask the assistant', async ({ page }) => {
    await page.goto('/servers/basalt?assistant=1');
    await page.getByRole('button', { name: 'Ask assistant' }).click();
    const dlg = page.getByRole('dialog', { name: 'What should the assistant look into on basalt?' });
    await expect(dlg.getByText('Claude Code · Ask before changes')).toBeVisible();
    const q = dlg.getByLabel('Question (optional)');
    await expect(q).toBeFocused();
    await expect(q).toHaveAttribute('placeholder', 'Check this host’s health');
    await q.fill('Why is memory at 61%?');
    await q.press('Enter');
    await expect(dlg).toHaveCount(0);
    const p = panel(page);
    await expect(p.getByRole('heading', { name: 'Why is memory at 61%?' })).toBeVisible();
    await expect(p.getByRole('log', { name: 'Transcript' }).getByText(/^About “Why is memory at 61%\?”/)).toBeVisible({ timeout: 10_000 });
    await expect(p.getByText('Answered', { exact: true })).toBeVisible();
    await p.getByRole('button', { name: 'Close the investigation' }).click();
    await expect(p).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ask assistant' })).toBeFocused();

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await palette.getByRole('option', { name: /Ask the assistant…/ }).click();
    const fleet = page.getByRole('dialog', { name: 'What should the assistant look into?' });
    await expect(fleet.getByLabel('Question (optional)')).toHaveAttribute('placeholder', 'Check the health of all hosts');
    await fleet.getByRole('button', { name: 'Ask' }).click();
    await expect(panel(page).getByRole('heading', { name: 'Check the health of all hosts' })).toBeVisible();
    await expect(panel(page).getByText('All hosts', { exact: true })).toBeVisible();
  });

  test('an unknown investigation says so', async ({ page }) => {
    await page.goto('/?assistant=1&investigation=inv_nope');
    await expect(page.getByRole('heading', { name: 'Investigation not found' })).toBeVisible();
    await page.getByRole('button', { name: 'Close the investigation' }).click();
    await expect(page).not.toHaveURL(/investigation=/);
  });

  test('the Agent tab has the Diagnostics switch, on by default', async ({ page }) => {
    await page.goto('/servers/basalt?tab=agent');
    const sw = page.getByRole('switch', { name: 'Diagnostics on basalt' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Read-only checks the assistant runs: logs, SMART, arrays, services')).toBeVisible();
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Diagnostics on basalt' })).toHaveAttribute('aria-checked', 'false');
  });
});

// ---------------------------------------------------------------- phone

test('phone: the panel takes the whole screen', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'phone only');
  await page.goto('/alerts?assistant=1');
  await page.getByRole('button', { name: 'Waiting for you: open the investigation of nvme1n1 wear at 78%' }).click();
  const p = panel(page);
  await expect(p.getByRole('group', { name: 'Run this command on basalt?' })).toBeVisible();
  const box = await p.boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  // It covers the bottom bar; its reply box stays reachable.
  await expect(p.getByRole('textbox', { name: 'Reply to the assistant' })).toBeInViewport();
  await noHorizontalOverflow(page);
  await p.getByRole('button', { name: 'Close the investigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' }).last().getByRole('link', { name: 'Alerts' })).toBeVisible();
});

// ---------------------------------------------------------------- axe

for (const [name, path, ready] of [
  ['settings', '/settings/assistant?assistant=1', 'Recent investigations'],
  ['settings off', '/settings/assistant', 'Not installed'],
  ['panel', '/alerts?assistant=1&investigation=inv_wear', 'Run this command on basalt?'],
  ['panel summary', '/?assistant=1&investigation=inv_md0', 'Needs attention'],
] as const) {
  for (const scheme of ['dark', 'light'] as const) {
    test(`axe: ${name} (${scheme})`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop' && scheme === 'light', 'light at desktop width');
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      await expect(page.getByText(ready, { exact: true }).first()).toBeVisible();
      await page.waitForTimeout(500);
      expect(await axe(page)).toEqual([]);
    });
  }
}
