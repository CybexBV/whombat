/** Screenshots of the new managed screens for review (not baselines): light and dark. */
import { test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

/** Where the review screenshots go (`MANAGED_SHOTS_DIR`, default the repository's `tmp/shots`). */
const SHOTS = process.env.MANAGED_SHOTS_DIR ?? '../../tmp/shots';

for (const theme of ['light', 'dark'] as const)
  test(`screens (${theme})`, async ({ page }) => {
    test.skip(!process.env.MANAGED_SHOTS, 'set MANAGED_SHOTS=1 to write review screenshots');
    await page.emulateMedia({ colorScheme: theme });
    await fresh(page);
    await fake(page, 'reset');
    await page.reload();
    await signIn(page);
    await page.screenshot({ path: `${SHOTS}/managed-${theme}-appliances-empty.png` });
    // Claim (AP-47, AP-50): found on this network, anything but the letters, none found, several.
    const shot = (name: string) => page.screenshot({ path: `${SHOTS}/managed-${theme}-${name}.png` });
    const screens = await fake<Record<string, { letters: string; code: string } | null>>(page, 'consoles');
    await page.getByRole('button', { name: 'Claim a Whombat' }).click();
    await page.getByRole('heading', { name: 'We found a Whombat on your network' }).waitFor();
    await page.getByLabel('Enter the 4 letters from its screen').fill(screens.fresh?.letters ?? '');
    await shot('claim-found');
    await page.getByLabel('Enter the 4 letters from its screen').fill('KX-4821-QM');
    await page.getByRole('checkbox', { name: 'I agree to the Whombat Appliance Terms' }).check();
    await page.getByRole('button', { name: 'Claim it' }).click();
    await page.getByText('Enter the 4 letters from its screen.').waitFor();
    await shot('claim-found-error');
    await page.getByRole('button', { name: 'Not this one?' }).click();
    await page.getByRole('heading', { name: 'We couldn’t find your Whombat' }).waitFor();
    await shot('claim-none');
    // Still no Whombat: the list goes straight to what's on this network (AP-75).
    await fake(page, 'nearby', ['fresh', 'contested', 'mismatched']);
    await page.goto('/appliances');
    await page.getByRole('heading', { name: 'We found 3 Whombats on your network' }).waitFor();
    await shot('claim-pick');
    await page.goto('/appliances');
    await fresh(page);
    await fake(page, 'reset');
    await page.reload();
    await signIn(page);
    const cc = await claimAndSaveKit(page);
    await fake(page, 'providers', cc.device, [
      {
        provider: 'claude',
        authMode: 'subscription',
        state: 'ready',
        explanation: null,
      },
      {
        provider: 'codex',
        authMode: 'subscription',
        state: 'auth_revoked',
        explanation: null,
      },
    ]);
    await page.goto('/burrow-hq/settings?tab=appliance');
    await page.getByText('Unprotected', { exact: true }).waitFor();
    await page.screenshot({ path: `${SHOTS}/managed-${theme}-appliance-tab.png`, fullPage: true });
    await page.goto('/burrow-hq/settings?tab=appliance#devices');
    await page.getByText('This browser', { exact: false }).waitFor();
    await page.screenshot({ path: `${SHOTS}/managed-${theme}-devices-tab.png` });
    await fake(page, 'applianceOffline', cc.device, true);
    await page.getByRole('status').filter({ hasText: 'isn’t online' }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/managed-${theme}-offline.png` });
    await fake(page, 'applianceOffline', cc.device, false);
    await page.goto('/appliances');
    await page.getByRole('button', { name: 'Open Burrow HQ' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/managed-${theme}-appliances.png` });
    // The identity pin (AP-64, AP-66): the add-a-device link, the hard stop, set up this device.
    await page.goto('/burrow-hq/settings?tab=appliance#devices');
    await page.getByRole('button', { name: 'Add a computer' }).click();
    await page.getByText('It lets nothing in by itself.', { exact: false }).first().waitFor();
    await page.screenshot({ path: `${SHOTS}/managed-${theme}-devices-add-link.png` });
    await fake(page, 'lieAbout', cc.device, true);
    await page.goto('/appliances');
    await page.getByRole('button', { name: 'Open Burrow HQ' }).click();
    await page.getByRole('heading', { name: 'This Whombat’s identity has changed' }).waitFor();
    await shot('identity-changed');
    await page.goto(`/appliances/${cc.device}/setup`);
    await page.getByRole('heading', { name: 'Set up this device' }).waitFor();
    await shot('setup');
  });
