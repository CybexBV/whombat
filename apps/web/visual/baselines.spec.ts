/**
 * Screens that have no mock, as screenshot baselines (`__screenshots__/baselines.spec.ts/`), light and dark:
 * - the sidebar's Servers and Connections tabs, and Settings → Connections (sidebar-tabs.md);
 * - `/settings`, one per tab (docs/decisions/burrow-settings.md, settings-simplify.md SS-01): Profile (PROFILE: name,
 *   title, signing key fingerprint); Connections → GitHub (was Repositories) connected as @whombat through gh (the default working directory
 *   ~/Code, its four repos with nothing to pick, Whombat agent-repos.md AGR-12) and the same tab before GitHub is
 *   connected, with gh logged out on the host ("Connect GitHub" and the command that fixes it);
 * - onboarding, all three steps (Whombat one-agent.md OA-13, one-person.md OP-11; app one-agent.md AP-4954,
 *   one-person.md AP-5725): “Name your Whombat”, “Set up your AI” with Claude Code chosen (installed, not signed in;
 *   SUB-08, not in the mock) and “Meet your agent” (its name and character, with the line on how it talks;
 *   agent-voices.md AP-5501). The mock's steps are the crew's (“Name your burrow”, “Meet your first agents”, “Invite your
 *   team”, their copy about agents and channels), so none is compared with it any more (hermes-engine-app.md AP-5102);
 * - Settings → Advanced → AI on this Whombat (docs/decisions/subscriptions.md, SS-03): the AI clients' folded line, and
 *   behind Details opened the clients (Claude Code alone, chatgpt-no-client.md AP-5614);
 * - The Vault (`/vault`, AP-671; docs/decisions/vault.md VT-70, VT-71; AP-111): Mara's entries and the home
 *   network, the Home Assistant entry open (its top, then scrolled to the agent's row and RECENT USE; one-agent.md
 *   AP-4940), and Add to Vault's one form;
 * - The Vault's Add to Vault filled in as a website login (VT-D28; AP-217; the form guesses it from the username);
 * - Settings' home (Often used and the five groups), Files (the Chat's own files) with no files yet, and Usage, the Spend report
 *   (Whombat spend.md SP-02): today's cost and times worked, then More open (final-settings-vault-files-usage.md);
 * - Settings → Agent → Running (Whombat one-person.md OP-19; AP-5690, AP-5725): the agent's services, one running with
 *   its link and Stop, one stopped;
 * They follow the nearest mocked patterns (B-05): reviewed against the log / onboarding screens when the
 * baselines were taken (docs/decisions/visual-regression.md). Update with `pnpm visual --update-snapshots`.
 *
 * Fixture mode does not serve `repos.list` / `github.status` (they 404 there), so those queries are seeded with the
 * fixture world's repos and a connection as @whombat.
 */
import type { Page } from '@playwright/test';
import { REPOS } from '@whombat/fixtures';
import {
  expect,
  neutraliseWorld,
  openApp,
  patchQueries,
  seedQueries,
  settle,
  THEMES,
  test,
} from './support/harness';

const GH_LOGGED_OUT = 'GitHub isn’t connected: run gh auth login on the host.';

function githubStatus(connected: boolean) {
  return {
    mode: 'gh',
    connected,
    login: connected ? 'whombat' : null,
    error: connected ? null : GH_LOGGED_OUT,
    fix: connected ? null : 'gh auth login',
    note: null,
    canConnect: true,
    polledAt: null,
  };
}

type SettingsTab = 'general' | 'repos' | 'ai' | 'spend';

/** Where each screenshot's tab is since Settings has six (settings-simplify.md SS-01, SS-02): Profile, GitHub's page in Connections… */
const SETTINGS_PATHS: Record<SettingsTab, string> = {
  general: '/settings?part=profile',
  repos: '/connections?connection=github',
  // The AI clients on this Whombat are an Advanced page; the sign-ins are the assistant's own.
  ai: '/settings?tab=advanced&part=ai',
  spend: '/settings?tab=advanced&part=spend',
};

/** The Vault's page (`/vault`, AP-671; was Settings → Vault). */
async function openVaultPage(page: Page, theme: 'light' | 'dark') {
  await openApp(page, { path: '/vault', theme });
  await page.getByRole('heading', { name: 'Vault', level: 1 }).waitFor();
  await neutraliseWorld(page);
}

async function openSettings(page: Page, theme: 'light' | 'dark', tab: SettingsTab, connected = true) {
  await openApp(page, { path: SETTINGS_PATHS[tab], theme });
  // Each group is a page of its own, titled by its name (final-settings-vault-files-usage.md); GitHub is a connection's
  // page, titled by its name under the way back.
  if (tab === 'repos') await page.getByRole('heading', { name: 'GitHub', level: 2 }).first().waitFor();
  else await page.locator('h1').first().waitFor();
  await neutraliseWorld(page);
  if (tab === 'repos') {
    await seedQueries(page, 'repos.list', {
      repos: connected ? REPOS : [],
      githubConnected: connected,
      create: {
        allowed: true,
        reason: null,
        author: { name: 'Mara Okafor', email: 'mara@burrowhq.example' },
      },
    });
    await seedQueries(page, 'github.status', githubStatus(connected));
    if (connected)
      await patchQueries(
        page,
        'conversations.bootstrap',
        (d) => ({
          ...d,
          burrow: { ...d.burrow, defaultWorkdir: '~/Code' },
        }),
        null,
      );
    await page
      .getByText(connected ? '@whombat' : 'Connect GitHub', { exact: true })
      .first()
      .waitFor();
  }
  await settle(page);
}

for (const theme of THEMES) {
  test(`settings, home (${theme})`, async ({ page }) => {
    // Often used, then the five groups (final-settings-vault-files-usage.md).
    await openApp(page, { path: '/settings', theme });
    await page.getByRole('heading', { name: 'All settings' }).waitFor();
    await neutraliseWorld(page);
    await settle(page);
    await expect(page).toHaveScreenshot(`settings-home-${theme}.png`);
  });

  test(`files, home with no files yet (${theme})`, async ({ page }) => {
    // Files opens the Chat's own files straight away; the fixture world has none there yet.
    await openApp(page, { path: '/files', theme });
    await page.getByText(/^No files here yet/).waitFor();
    await neutraliseWorld(page);
    await settle(page);
    await expect(page).toHaveScreenshot(`files-empty-${theme}.png`);
  });

  test(`settings, General (${theme})`, async ({ page }) => {
    await openSettings(page, theme, 'general');
    await page.getByText('PROFILE', { exact: true }).waitFor();
    await expect(page).toHaveScreenshot(`settings-general-${theme}.png`);
  });

  test(`settings, Repositories, GitHub connected (${theme})`, async ({ page }) => {
    await openSettings(page, theme, 'repos');
    await page.getByText('whombat/billing').waitFor();
    await expect(page).toHaveScreenshot(`settings-connected-${theme}.png`);
  });

  test(`settings, Repositories, GitHub not connected (${theme})`, async ({ page }) => {
    await openSettings(page, theme, 'repos', false);
    await page.getByText('No repositories yet').waitFor();
    await expect(page).toHaveScreenshot(`settings-not-connected-${theme}.png`);
  });

  test(`settings, Connections (${theme})`, async ({ page }) => {
    // What this Whombat is signed in to: needs you, accounts, apps and services (sidebar-tabs.md SBT-06, SBT-07).
    await openApp(page, { path: '/settings?tab=connections', theme });
    await page.getByText('What this Whombat is signed in to, and how.').waitFor();
    await settle(page);
    await expect(page).toHaveScreenshot(`settings-connections-${theme}.png`);
  });

  test(`Servers and Connections, the list beside a page (${theme})`, async ({ page }) => {
    // Places in the menu, Chat's list beside the page it opens (servers-connections-places.md).
    await page.addInitScript(() => {
      localStorage.removeItem('whombat.place.servers');
      localStorage.removeItem('whombat.place.connections');
    });
    await openApp(page, { path: '/servers', theme });
    await page.getByRole('navigation', { name: 'Servers' }).waitFor();
    await page.waitForURL(/\/things\//);
    await settle(page);
    await expect(page).toHaveScreenshot(`place-servers-${theme}.png`);
    await openApp(page, { path: '/connected', theme });
    await page.getByRole('navigation', { name: 'Connections' }).waitFor();
    await page.waitForURL(/\/things\//);
    await settle(page);
    await expect(page).toHaveScreenshot(`place-connections-${theme}.png`);
  });

  test(`onboarding step 1, Name your Whombat (${theme})`, async ({ page }) => {
    await openApp(page, { path: '/onboarding?burrow=burrow-hq&step=0', theme });
    await page.getByText('STEP 1 OF 3').waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(page).toHaveScreenshot(`onboarding-name-${theme}.png`);
  });

  test(`onboarding step 3, Meet your agent (${theme})`, async ({ page }) => {
    await openApp(page, { path: '/onboarding?burrow=burrow-hq&step=2', theme });
    await page.getByRole('heading', { name: 'Meet your agent' }).waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(page).toHaveScreenshot(`onboarding-agent-${theme}.png`);
  });

  test(`onboarding step 2, Set up your AI (${theme})`, async ({ page }) => {
    await openApp(page, { path: '/onboarding?burrow=burrow-hq&step=1', theme });
    await page.getByText('STEP 2 OF 3').waitFor();
    await page.getByRole('button', { name: 'Use Claude Code' }).click();
    await page.getByText('Installed · 2.1.278').waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(page).toHaveScreenshot(`onboarding-set-up-ai-${theme}.png`);
  });

  test(`settings, Vault (${theme})`, async ({ page }) => {
    // A page of its own since AP-671 (the baseline keeps its name).
    await openVaultPage(page, theme);
    await page.getByText('Sign-in reached · Last used 09:12').waitFor();
    await page.getByRole('link', { name: 'See home network ranges' }).waitFor();
    await settle(page);
    await expect(page).toHaveScreenshot(`settings-vault-${theme}.png`);
  });

  test(`settings, Vault, an open entry (${theme})`, async ({ page }) => {
    await openApp(page, { path: '/vault?entry=vlt_homeassistant', theme });
    const entry = page.locator('li[data-entry="vlt_homeassistant"]');
    await entry.getByText('Checked 3 min ago · Reached · 5 tools').waitFor();
    await entry.getByRole('list', { name: 'RECENT USE' }).waitFor();
    await neutraliseWorld(page);
    await settle(page);
    await expect(page).toHaveScreenshot(`settings-vault-entry-${theme}.png`);
    // The rest of the card: the agent's row (Allowed · Ask me first · Off) and RECENT USE.
    await entry.locator('[data-block="agent-access"]').evaluate((el) => {
      // Scroll the settings page itself (scrollIntoView would nudge the shell too).
      let scroller = el.parentElement;
      while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
      if (scroller)
        scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
    });
    await settle(page);
    await expect(page).toHaveScreenshot(`settings-vault-entry-keys-${theme}.png`);
  });

  test(`settings, Add to Vault (${theme})`, async ({ page }) => {
    await openVaultPage(page, theme);
    await page.getByRole('button', { name: 'Add to Vault' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add to Vault' });
    // One form for every kind (Add to Vault asks what a person knows; no Connection since VLT-30).
    await dialog.getByLabel('Address').waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(page).toHaveScreenshot(`settings-vault-add-${theme}.png`);
  });

  test(`settings, Add to Vault, Login (${theme})`, async ({ page }) => {
    await openVaultPage(page, theme);
    await page.getByRole('button', { name: 'Add to Vault' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add to Vault' });
    // A username makes the form a website login (`guessTemplate`).
    await dialog.getByLabel('What it’s for').fill('Shop');
    await dialog.getByLabel('Address').fill('shop.example.com/login');
    await dialog.getByLabel('Username').fill('mara@example.com');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(page).toHaveScreenshot(`settings-vault-add-login-${theme}.png`);
  });

  test(`usage (${theme})`, async ({ page }) => {
    await openSettings(page, theme, 'spend');
    // The person's own report only: what it cost and the times worked today (one-person.md AP-5693).
    await page.getByText('Cost reported for', { exact: false }).waitFor();
    await settle(page);
    await expect(page).toHaveScreenshot(`usage-${theme}.png`);
    // More: provider coverage, the text read and written, what plans used.
    await page.getByText('More', { exact: true }).click();
    await page.getByRole('heading', { name: 'Provider coverage' }).waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(page).toHaveScreenshot(`usage-more-${theme}.png`);
  });

  test(`settings, Agent, Running on your Whombat (${theme})`, async ({ page }) => {
    await openApp(page, { path: '/settings?tab=agent&part=services', theme });
    await page.locator('h1').first().waitFor();
    await neutraliseWorld(page);
    await page.locator('[data-service="invoice-preview"]').waitFor();
    await page.locator('[data-service="grafana"]').waitFor();
    await settle(page);
    await expect(page).toHaveScreenshot(`settings-agent-running-${theme}.png`);
  });

  test(`settings, AI accounts (${theme})`, async ({ page }) => {
    await openSettings(page, theme, 'ai');
    // Claude Code is the one client and installed, so “On this Whombat” stays folded: open it (chatgpt-no-client.md
    // AP-5614; ChatGPT is a sign-in row only).
    await page.getByText('Claude Code 2.1.278 is installed and up to date').waitFor();
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByText('Installed · 2.1.278').waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(page).toHaveScreenshot(`settings-ai-accounts-${theme}.png`);
  });
}
