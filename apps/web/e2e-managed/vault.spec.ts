/**
 * The Vault on a managed Whombat (docs/decisions/vault.md VT-58, VT-70…VT-72; AP-111…AP-115) on the fake world: Settings
 * → Vault over the end-to-end session — the entries, an open entry, Add to Vault (`vault.create` is a secret op, then
 * `vault.check`), whether the agent may use an entry, the home network list, and Remove. Screenshots for review, light and dark
 * at 1440×900, in `tmp/visual/vault/` (`VAULT_SHOTS_DIR`).
 */
import { expect, type Page, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

const SHOTS = process.env.VAULT_SHOTS_DIR ?? '../../tmp/visual/vault';

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/managed-${name}.png` });
}

for (const theme of ['light', 'dark'] as const)
  test(`the Vault on a managed Whombat (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await fresh(page);
    await fake(page, 'reset');
    await page.reload();
    await signIn(page);
    await claimAndSaveKit(page);

    // The Vault is a page of its own (VT-70, AP-671).
    await page.goto('/burrow-hq/vault');
    await expect(page.getByRole('list', { name: 'YOUR ENTRIES' })).toBeVisible();
    // The entry's line says how its check went and when it was last used (final-settings-vault-files-usage.md FSV-07).
    await expect(page.getByRole('button', { name: /^Home Assistant Sign-in reached/ })).toBeVisible();
    // The home network ranges are under the local network switch on What the assistant may do; the page links there.
    await expect(page.locator('[data-note="home-network"]').getByRole('link')).toHaveAttribute(
      'href',
      /tab=agent&part=may#local-network/,
    );
    await shot(page, `tab-${theme}`);

    // An open entry: its connection and tools, whether the agent may use it, recent use.
    await page.getByRole('button', { name: /Home Assistant/ }).click();
    const ha = page.locator('li[data-entry="vlt_homeassistant"]');
    await expect(ha.getByRole('heading', { name: 'TOOLS' })).toBeVisible();
    // Opened, it says what it is and where it reaches (AP-4992).
    await expect(ha.getByText('192.168.1.10:8123', { exact: true })).toBeVisible();
    await expect(ha.getByText(/^Checked .* · Reached · 5 tools$/)).toBeVisible();
    await shot(page, `entry-${theme}`);
    const use = ha.getByRole('radiogroup', { name: /can use this$/ });
    await expect(use.getByRole('radio', { name: 'On' })).toBeChecked();
    await ha.getByRole('heading', { name: 'RECENT USE' }).scrollIntoViewIfNeeded();
    await shot(page, `entry-use-${theme}`);

    // Add to Vault over the session: the secret travels as a secret op, then the entry is checked.
    await page.getByRole('button', { name: 'Add to Vault' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add to Vault' });
    await expect(dialog.getByLabel('What it’s for')).toBeVisible();
    await shot(page, `add-${theme}`);
    // A sign-in key is chosen under Advanced; the everyday kinds are guessed from what is typed. An MCP server is
    // connected in Connections now, not here (vault-simplify.md VLT-30).
    await dialog.getByRole('button', { name: 'Advanced' }).click();
    await dialog.getByLabel('Kind').selectOption('token');
    await dialog.getByLabel('What it’s for').fill('Garden sensors');
    await dialog.getByLabel('Address').fill('https://garden.example.com/api');
    await dialog.getByLabel('Sign-in key').fill('eyJhbGciOi-fake-token');
    await shot(page, `add-form-${theme}`);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/^Added “Garden sensors” to your Vault/)).toBeVisible();
    const garden = page.locator('li[data-entry]').filter({ hasText: 'Garden sensors' });
    await expect(garden.getByRole('button', { expanded: true })).toBeVisible();

    // Remove it again, under Danger.
    await garden.getByRole('button', { name: 'Danger' }).click();
    await garden.getByRole('button', { name: 'Remove from Vault' }).click();
    await garden.getByRole('button', { name: 'Remove from Vault' }).click();
    await expect(page.getByText('Removed “Garden sensors” from your Vault.')).toBeVisible();
    await expect(garden).toHaveCount(0);
  });
