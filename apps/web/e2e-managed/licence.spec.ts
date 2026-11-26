/**
 * Contracts 0.10.0 in the hosted UI, on the fake world: no Subscription section or strips any more (the licence is
 * inert, LNK-04), licence refusals, the appliance terms at claim (LC-17, LC-18) and deleting the cloud account (CT-78).
 */
import { expect, type Page, test } from '@playwright/test';
import { APPLIANCE_TERMS_VERSION } from '@whombat/control-contracts';
import { agreeToTerms, claimAndSaveKit, consoles, fake, fresh, signIn, startFresh } from './support';

/** Burrow screens are burrow-less (AP-360); the open appliance's burrow is the one they show. */
const B = '';

async function setup(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  return claimAndSaveKit(page);
}

// The licence is inert (whombat-link.md LNK-04; app whombat-link-app.md AP-9505): no PLAN, no strip, whatever it says.
const subscription = (page: Page) => page.getByRole('region', { name: 'PLAN' });
const strip = (page: Page) => page.getByTestId('licence-strip');

test('no PLAN section and no licence strip, whatever the licence says', async ({ page }) => {
  const c = await setup(page);
  for (const kind of ['not_renewed', 'payment', 'cancelled'] as const) {
    await fake(page, 'licence', c.device, kind);
    await page.goto(`${B}/settings?tab=appliance&section=about`);
    await expect(page.getByRole('region', { name: 'VERSION' })).toBeVisible({ timeout: 15_000 });
    await expect(subscription(page)).toHaveCount(0);
    await expect(strip(page)).toHaveCount(0);
  }
});

test('lapsed: a message to the agent is refused, a plain comment still posts', async ({ page }) => {
  const c = await setup(page);
  await fake(page, 'licence', c.device, 'cancelled');
  // The branch room: its comments reach the agent only when they mention it (the Chat is the agent's alone).
  await page.goto(`${B}/pr/482`);
  const composer = page.getByRole('textbox', { name: /Comment on PR #482/ });
  await composer.fill('@Neo draft the release notes');
  await composer.press('Enter');
  await expect(
    page.getByText(
      'Your Whombat’s subscription has ended, so your agent and automations are paused. You can still read and export everything.',
    ),
  ).toBeVisible();
  await composer.fill('Lunch at one');
  await composer.press('Enter');
  await expect(page.getByText('Lunch at one')).toBeVisible();
});

test('the terms at claim: the claim waits for the tick, the terms page is public, the version goes to control', async ({
  page,
  context,
}) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  await page.getByRole('button', { name: 'Claim a Whombat' }).click();
  await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
  const screen = (await consoles(page)).fresh;
  await page.getByLabel('Enter the 4 letters from its screen').fill(screen?.letters ?? '');
  const terms = page.getByRole('checkbox', { name: 'I agree to the Whombat Appliance Terms' });
  await expect(terms).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Claim it' })).toBeDisabled();
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: 'Whombat Appliance Terms' }).click(),
  ]);
  await expect(tab.getByRole('heading', { name: 'Whombat Appliance Terms', level: 1 })).toBeVisible();
  await expect(tab.getByRole('note')).toContainText(`Version ${APPLIANCE_TERMS_VERSION}`);
  await expect(tab.getByRole('heading', { name: '2. Your data stays yours' })).toBeVisible();
  await tab.close();
  await agreeToTerms(page);
  await page.getByRole('button', { name: 'Claim it' }).click();
  await startFresh(page);
  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 20_000 });
  expect(await fake<string[]>(page, 'claimTerms')).toEqual([APPLIANCE_TERMS_VERSION]);
});

test('control’s claim refusals: a self-installed box, and the plan’s Whombat limit', async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  const claim = async () => {
    await page.goto('/appliances/claim');
    await expect(page.getByRole('heading', { name: 'We found a Whombat on your network' })).toBeVisible();
    await page
      .getByLabel('Enter the 4 letters from its screen')
      .fill((await consoles(page)).fresh?.letters ?? '');
    await agreeToTerms(page);
    await page.getByRole('button', { name: 'Claim it' }).click();
  };
  await fake(page, 'claimRefusal', 'self_install_not_allowed');
  await claim();
  await expect(
    page.getByText(
      'This Whombat was installed by hand, and your plan doesn’t include self-installed Whombats.',
    ),
  ).toBeVisible();
  await fake(page, 'claimRefusal', 'devices_allowed_reached');
  await claim();
  await expect(page.getByText('Your plan covers 1 Whombat.')).toBeVisible();
});

test('deleting the cloud account: what goes and what stays, the typed email, refusals, then signed out', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/appliances');
  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByRole('heading', { name: 'Delete your Whombat account' })).toBeVisible();
  await expect(page.getByText('Your organization', { exact: true })).toBeVisible();
  const go = page.getByRole('button', { name: 'Delete my account' });
  await expect(go).toBeDisabled();
  await page.getByLabel('Type your email to confirm').fill('someone@else.nl');
  await expect(go).toBeDisabled();
  await page.getByLabel('Type your email to confirm').fill('mara@burrowhq.example');
  await go.click();
  await expect(
    page.getByText('Your organization still has a Whombat. Retire it first, or contact support.'),
  ).toBeVisible();
  await fake(page, 'deleteRefusal', 'subscription_live');
  await go.click();
  await expect(
    page.getByText('Your subscription is still running. Cancel it under Billing first.'),
  ).toBeVisible();

  // An account whose organization has no Whombat: deleted, signed out, nothing of it left in this browser.
  await fake(page, 'deleteRefusal', null);
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  await page.getByRole('button', { name: 'Delete account' }).click();
  await page.getByLabel('Type your email to confirm').fill('Mara@burrowhq.example');
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible({ timeout: 15_000 });
  const left = await page.evaluate(() =>
    Object.keys(localStorage).filter(
      (k) => k.startsWith('whombat:appliances:') || k === 'whombat:cloud-token',
    ),
  );
  expect(left).toEqual([]);
});
