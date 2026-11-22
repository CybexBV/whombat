/**
 * Review screenshots of the box's page for Whombat Link (whombat-link.md LNK-40, LNK-42, LNK-06; not baselines): the one
 * setup (claim, who you are, Reach with Tailscale and the Link offer, the code, Connect your AI; the passkey at the own
 * address), This Whombat → About's REACH in each Link state and “Updates from”, and the strip while Link ends and after.
 * Light and dark, 1440×900; REACH with its folds open also at a phone's 390×844. `LINK_SHOTS=<dir>` writes them.
 */
import { expect, test } from '@playwright/test';
import { anotherBrowser, COMMUNITY, fake, fresh, inTheApp } from './support';

const DIR = process.env.LINK_SHOTS ?? '';

for (const theme of ['light', 'dark'] as const)
  test(`Whombat Link on the box's page (${theme})`, async ({ page }) => {
    test.skip(!DIR, 'set LINK_SHOTS=<dir> to write review screenshots');
    test.setTimeout(300_000);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    const shot = async (name: string) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/web-${theme}-${name}.png` });
    };
    const about = async (state: string) => {
      await page.goto('/settings?tab=appliance&section=about');
      const reach = page.locator('[data-reach]');
      await expect(reach.locator(`[data-link-state="${state}"]`)).toBeVisible({ timeout: 20_000 });
      await reach.scrollIntoViewIfNeeded();
      return reach;
    };

    // The setup: the letters, who you are.
    await fresh(page);
    await page.getByLabel('Letters').fill(await fake<string>(page, 'communityLetters'));
    await shot('setup-1-claim');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Your name').fill('Mara Visser');
    await page.getByLabel('Email').fill('mara@lumio.example.org');
    await shot('setup-2-account');
    await page.getByRole('button', { name: 'Claim it' }).click();

    // Reach it from anywhere: Tailscale off and the Link offer; then on, with the advice, and Link's code.
    await expect(page.getByRole('heading', { name: 'Reach it from anywhere' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('[data-link-offer]')).toBeVisible();
    await shot('setup-3-reach');
    await page.getByRole('button', { name: 'Turn on Tailscale' }).click();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible({ timeout: 10_000 });
    await fake(page, 'tailscaleSignedIn', COMMUNITY);
    await expect(page.locator('[data-key-expiry]')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Turn on Whombat Link' }).click();
    await expect(page.getByTestId('whombat-link-box-code')).toBeVisible();
    await shot('setup-3-reach-link-code');

    // Connect your AI in the app, the setup's last step (no backups step).
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 20_000 });
    await shot('setup-4-ai');
    await page.getByRole('button', { name: 'Later' }).click();
    await inTheApp(page);

    // This Whombat → About → REACH, each state, and Updates from.
    await fake(page, 'linkState', 'off');
    await about('off');
    await page.locator('[data-reach] [data-row="link"] summary').click();
    const tailscaleMore = page.locator('[data-reach] [data-row="reach-tailscale"] summary');
    if (await tailscaleMore.count()) await tailscaleMore.click();
    await shot('settings-reach-off');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-reach]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page
      .locator('[data-reach]')
      .screenshot({ path: `${DIR}/web-${theme}-settings-reach-off-phone.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-reach] [data-row="link"]').getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByTestId('whombat-link-box-code')).toBeVisible();
    await shot('settings-reach-code');
    await fake(page, 'linkState', 'on', {
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      email: 'mara@lumio.example.org',
    });
    await about('on');
    await shot('settings-reach-on');
    const channel = page.locator('[data-row="channel"]');
    await channel.scrollIntoViewIfNeeded();
    await channel.getByText('Beta').click();
    await expect(channel).toContainText('fully tested');
    await shot('settings-updates-beta');
    await page.locator('[data-row="link"]').getByRole('button', { name: 'Turn off' }).click();
    await shot('settings-link-off-confirm');
    await page.keyboard.press('Escape');

    // Link ending, then ended: the strip and REACH.
    await fake(page, 'linkState', 'grace');
    await about('grace');
    await expect(page.getByTestId('link-strip')).toBeVisible({ timeout: 20_000 });
    await shot('settings-reach-grace');
    await fake(page, 'linkState', 'ended');
    await page.goto('/');
    await expect(page.getByTestId('link-strip')).toContainText('ended', { timeout: 20_000 });
    await shot('strip-ended');
    await about('ended');
    await shot('settings-reach-ended');

    // At the box's own address with the link from its screen: the setup makes the box's passkey.
    await fake(page, 'ownBox', true);
    const claimLink = await fake<string>(page, 'ownClaimLink');
    await anotherBrowser(page, `/c/${claimLink}`);
    await expect(page.getByRole('heading', { name: 'Claim your Whombat' })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Letters').fill(await fake<string>(page, 'ownLetters'));
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Your name').fill('Mara Visser');
    await page.getByLabel('Email').fill('mara@lumio.example.org');
    await page.getByRole('button', { name: 'Claim it' }).click();
    await expect(page.getByRole('heading', { name: 'Make a passkey for this Whombat' })).toBeVisible({
      timeout: 20_000,
    });
    await shot('setup-3-passkey-at-address');
  });
