/**
 * Review screenshots of the account site's Whombat Link pages (not baselines): light and dark, desktop and phone.
 * `LINK_SHOTS=<dir>` writes them.
 */
import { expect, type Page, test } from '@playwright/test';
import { fake, fresh } from './support';

/** The Subscription Terms, ticked before a Whombat joins. */
const agree = (page: Page) =>
  page.getByRole('checkbox', { name: 'I agree to the Whombat Subscription Terms' }).check();

/** Where the person lives, before Checkout: an EU country, as Link is sold only there. */
const liveIn = (page: Page, country = 'NL') =>
  page.getByRole('combobox', { name: 'Where you live' }).selectOption(country);

const DIR = process.env.LINK_SHOTS ?? '';

for (const size of ['desktop', 'phone'] as const)
  for (const theme of ['light', 'dark'] as const)
    test(`link pages (${size}, ${theme})`, async ({ page }) => {
      test.skip(!DIR, 'set LINK_SHOTS=<dir> to write review screenshots');
      test.setTimeout(120_000);
      if (size === 'phone') await page.setViewportSize({ width: 390, height: 844 });
      else await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const shot = async (name: string) => {
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${DIR}/${size}-${theme}-${name}.png`, fullPage: size === 'phone' });
      };
      const heading = (name: string) => expect(page.getByRole('heading', { name })).toBeVisible();

      await fresh(page);
      await fake(page, 'reset');
      await page.reload();
      await heading('Sign in to Whombat');
      await shot('sign-in');

      const home = await fake<string>(page, 'linkCode', 'Home');
      await page.goto(`/link?code=${home}`);
      await heading('Link your Whombat');
      await page.getByLabel('Email').fill('mara@burrowhq.example');
      await shot('link-signed-out');
      await page.getByRole('button', { name: 'Email me a link' }).click();
      await heading('Check your email');
      await page.goto(await fake<string>(page, 'lastLink'));
      await heading('Add Home to Whombat Link?');
      await shot('link-confirm-trial');
      await agree(page);
      await page.getByRole('button', { name: 'Link it' }).click();
      await heading('Home is linked');
      await shot('link-done');
      // One Whombat: Your Whombats leads with one big Open.
      await page.getByRole('button', { name: 'Your Whombats' }).click();
      await expect(page.getByTestId('link-open-only')).toBeVisible();
      await shot('account-one-open');

      await page.goto('/link');
      await heading('Link your Whombat');
      await page.getByLabel('Code from its screen').fill('ABCD-EFGH');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText('That code doesn’t work.', { exact: false })).toBeVisible();
      await shot('link-wrong-code');

      await page.goto(`/link?code=${await fake<string>(page, 'linkCode', 'Office')}`);
      await agree(page);
      await page.getByRole('button', { name: 'Link it' }).click();
      await heading('Office is linked');
      await page.getByRole('button', { name: 'Your Whombats' }).click();
      await heading('Your Whombats');
      await expect(page.locator('[data-link-state="on"]')).toHaveCount(2);
      await shot('account-trial');

      // The free month's Add a card: busy, then an account without accepted terms.
      await fake(page, 'checkoutBusy', true);
      await liveIn(page);
      await shot('account-country');
      await page.getByRole('button', { name: 'Add a card' }).click();
      await expect(page.getByText('Try again in a moment.')).toBeVisible();
      await shot('account-checkout-busy');
      await fake(page, 'checkoutBusy', false);
      await fake(page, 'linkTermsForget');
      await page.reload();
      await liveIn(page, 'other');
      await shot('account-country-other');
      await liveIn(page);
      await page.getByRole('button', { name: 'Add a card' }).click();
      await expect(page.getByText('Agree to the Whombat Subscription Terms first.')).toBeVisible();
      await shot('account-terms-required');
      await page.reload();

      await page.getByRole('button', { name: 'Remove Office from Whombat Link' }).click();
      await shot('account-remove-confirm');
      await page.getByRole('button', { name: 'Cancel' }).click();

      const boxes = (await fake<{ link: { boxes: { device: string }[] } }>(page, 'state')).link.boxes;
      const now = Math.floor(Date.now() / 1000);
      await fake(page, 'linkPlan', {
        state: 'active',
        currentPeriodEnd: now + 24 * 86_400,
        trialEndsAt: null,
      });
      await page.reload();
      await expect(page.getByText(/Active · renews /).first()).toBeVisible();
      await shot('account-active');

      // Set to end at the period's end (whoever ended it): until when, and Manage subscription to resume it.
      await fake(page, 'linkPlan', { cancelAtPeriodEnd: true, cardOnFile: true });
      await page.reload();
      await expect(page.getByRole('list', { name: 'Whombat Link' })).toContainText(
        'Your Whombat Link ends on ',
      );
      await shot('account-ends-on');
      for (const b of boxes) await fake(page, 'linkBox', b.device, { state: 'off' });
      await page.reload();
      await expect(page.getByRole('button', { name: 'Manage subscription' })).toBeVisible();
      await shot('account-ends-on-no-box');
      for (const b of boxes) await fake(page, 'linkBox', b.device, { state: 'on' });
      await fake(page, 'linkPlan', { cancelAtPeriodEnd: false, cardOnFile: undefined });

      // Paid by the year, with free time from a code.
      await fake(page, 'linkPlan', {
        interval: 'year',
        cardOnFile: true,
        discount: { percentOff: 100, endsAt: now + 180 * 86_400, code: 'FRIENDS' },
      });
      await page.reload();
      await expect(page.getByText(/^Free until /).first()).toBeVisible();
      await shot('account-yearly-free');

      // R1 #15: free time during the free month, by the year: free until its end, the price what follows.
      await fake(page, 'linkPlan', {
        state: 'trialing',
        trialEndsAt: now + 20 * 86_400,
        currentPeriodEnd: now + 20 * 86_400,
        cardOnFile: true,
        interval: 'year',
        discount: { percentOff: 100, endsAt: now + 200 * 86_400, code: null },
      });
      await page.reload();
      await expect(page.getByTestId('link-price')).toContainText('Then €25 a year');
      await shot('account-trial-free-time');
      // Control's payload before CL-218: the Stripe trial stretched to the grant's end, the same second in both.
      await fake(page, 'linkPlan', {
        trialEndsAt: now + 200 * 86_400,
        currentPeriodEnd: now + 200 * 86_400,
        cardOnFile: false,
        interval: 'month',
      });
      await page.reload();
      await expect(page.getByText(/^Free until /).first()).toBeVisible();
      await expect(page.getByText(/Free month/)).toHaveCount(0);
      await shot('account-grant-same-end');
      await fake(page, 'linkPlan', { trialEndsAt: now + 20 * 86_400, cardOnFile: true, interval: 'year' });
      await fake(page, 'linkPlan', { discount: { percentOff: 100, endsAt: null, code: null } });
      await page.reload();
      await expect(page.getByText('Free for good').first()).toBeVisible();
      await shot('account-free-for-good');
      await fake(page, 'linkPlan', {
        state: 'active',
        currentPeriodEnd: now + 24 * 86_400,
        trialEndsAt: null,
        cardOnFile: undefined,
      });
      await fake(page, 'linkPlan', { interval: undefined, discount: null });

      await fake(page, 'linkPlan', { state: 'cancelled' });
      for (const b of boxes)
        await fake(page, 'linkBox', b.device, { state: 'grace', graceEndsAt: now + 7 * 86_400 });
      await page.reload();
      await expect(page.getByTestId('link-notice')).toBeVisible();
      await shot('account-grace');

      for (const b of boxes) await fake(page, 'linkBox', b.device, { state: 'ended', graceEndsAt: null });
      await page.reload();
      await expect(page.getByTestId('link-notice')).toContainText('has ended');
      await shot('account-ended');

      await fake(page, 'linkPlan', { state: 'comp' });
      for (const b of boxes) await fake(page, 'linkBox', b.device, { state: 'on' });
      await page.reload();
      await expect(page.getByText('Included', { exact: true })).toBeVisible();
      await shot('account-included');

      // No Whombat linked: one line to link one, no Subscribe.
      await fake(page, 'linkPlan', { state: 'none', trialAvailable: false });
      for (const b of boxes) await fake(page, 'linkBox', b.device, { state: 'off' });
      await page.reload();
      await expect(page.locator('[data-row="needs-box"]')).toBeVisible();
      await shot('account-needs-box');
      for (const b of boxes) await fake(page, 'linkBox', b.device, { state: 'on' });
      // A page for the month is open in another tab: the year waits, the way back is offered for that page.
      await page.evaluate(() =>
        localStorage.setItem(
          'whombat:link:payment-page',
          JSON.stringify({ interval: 'month', at: Date.now() }),
        ),
      );
      await fake(page, 'paymentPageOpen', 'month');
      await page.reload();
      await page.locator('[data-row="interval"]').getByText('€25 a year', { exact: true }).click();
      await liveIn(page);
      // This account's terms were forgotten above: Checkout asks for them first.
      await page.getByRole('button', { name: 'Subscribe' }).click();
      await expect(page.getByText('Agree to the Whombat Subscription Terms first.')).toBeVisible();
      await agree(page);
      await page.getByRole('button', { name: 'Subscribe' }).click();
      await expect(page.getByText(/already open for your Whombat Link until/)).toBeVisible();
      await shot('account-page-open');
      await fake(page, 'paymentPageOpen', null);
      await page.evaluate(() => localStorage.removeItem('whombat:link:payment-page'));
      await fake(page, 'linkPlan', { manual: true });
      await page.reload();
      await expect(page.locator('[data-row="interval"]')).toBeVisible();
      await page.locator('[data-row="interval"]').getByText('€25 a year', { exact: true }).click();
      await liveIn(page);
      await shot('account-subscribe-choice');
      await page.getByRole('button', { name: 'Subscribe' }).click();
      await expect(page.getByText('there’s nothing to pay', { exact: false })).toBeVisible();
      await shot('account-manual-billing');

      // Paying with a card on file: Manage opens the portal; Stripe without the subscription offers Subscribe.
      await fake(page, 'linkPlan', {
        state: 'active',
        manual: false,
        cardOnFile: true,
        interval: 'year',
        currentPeriodEnd: now + 300 * 86_400,
      });
      await fake(page, 'linkStripe', false);
      await page.reload();
      await expect(page.locator('[data-row="interval"]')).toHaveCount(0);
      await shot('account-manage');
      await page.getByRole('button', { name: 'Manage subscription' }).click();
      await expect(page.getByText('There’s no subscription to manage yet.')).toBeVisible();
      await shot('account-no-subscription');
      await fake(page, 'linkStripe', null);

      // An organization from before Link: its list, with the ways to Link.
      await fake(page, 'existingOrg');
      await fake(page, 'nearby', []);
      await page.goto('/appliances');
      await heading('Pick a Whombat');
      await shot('appliances-with-link');
    });
