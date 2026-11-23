/**
 * Whombat Link at the account site (Whombat whombat-link.md LNK-13, LNK-32…LNK-35, LNK-06; app account-home.md): the
 * code a Whombat's screen shows, entered at `/link` or `/add` signed out or in, confirmed into the account; the home with
 * each Whombat and the account with the subscription; Stripe Checkout and back; a Whombat removed; Link ending.
 */
import { expect, type Page, test } from '@playwright/test';
import { fake, fresh, openSignInLink } from './support';

test.beforeEach(async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to Whombat' })).toBeVisible();
});

const account = (page: Page) => page.getByRole('heading', { name: 'Account' });
/** The home: the account's Whombats, or how to add the first. */
const home = (page: Page) => page.getByRole('heading', { name: /^(Your Whombats?|Add your Whombat)$/ });
/** The Subscription Terms, ticked before a Whombat joins. */
/** Where the person lives, before Checkout: an EU country, as Link is sold only there. */
const liveIn = (page: Page, country = 'NL') =>
  page.getByRole('combobox', { name: 'Where you live' }).selectOption(country);
const agree = (page: Page) =>
  page.getByRole('checkbox', { name: 'I agree to the Whombat Subscription Terms' }).check();

/** Signs in from the start page as a new account: the home, with how to add the first Whombat. */
async function signInNew(page: Page) {
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await openSignInLink(page, await fake<string>(page, 'lastLink'));
  await expect(home(page)).toBeVisible();
}

test('signed out, the box’s code and an email: the link comes back to /link, which names the Whombat; the free month starts', async ({
  page,
}) => {
  const code = await fake<string>(page, 'linkCode', 'Home');
  await page.goto(`/link?code=${code.toLowerCase()}`);
  await expect(page.getByRole('heading', { name: 'Add your Whombat' })).toBeVisible();
  await expect(page.getByLabel('Code from its screen')).toHaveValue(code);
  await page.getByLabel('Email').fill('mara@burrowhq.example');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = await fake<string>(page, 'lastLink');
  expect(decodeURIComponent(link)).toContain(`next=/add?code=${code}`);
  await openSignInLink(page, link);
  await expect(page.getByRole('heading', { name: 'Add Home?' })).toBeVisible();
  await expect(page.getByText('Your first month is free. No card needed.')).toBeVisible();
  await agree(page);
  await page.getByRole('button', { name: 'Add it' }).click();
  await expect(page.getByRole('heading', { name: 'Home is added' })).toBeVisible();
  // Control recorded the Subscription Terms the person ticked.
  expect(await fake<(string | null)[]>(page, 'linkTerms')).toEqual(['2026-11-22']);
  await page.getByRole('button', { name: 'Your Whombats' }).click();
  await expect(page.getByRole('heading', { name: 'Your Whombat' })).toBeVisible();
  await expect(page.getByText(/Whombat Link · Free month · until /)).toBeVisible();
  const row = page.locator('[data-link-state="on"]');
  await expect(row).toContainText('Home');
  await expect(row).toContainText('.box.whombat.app');
  // The account's Link org is in the session now; it is never the hosted list's organization.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Whombat' })).toBeVisible();
});

test('signed in, a typed code in any case and spacing; a wrong one says so; the same code again is already linked', async ({
  page,
}) => {
  await signInNew(page);
  await page.goto('/add');
  await expect(page.getByRole('heading', { name: 'Add a Whombat' })).toBeVisible();
  await page.getByLabel('Code from its screen').fill('ABCD');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Enter the 8 letters from its screen', { exact: false })).toBeVisible();
  await page.getByLabel('Code from its screen').fill('abcd efgh');
  await expect(page.getByLabel('Code from its screen')).toHaveValue('ABCD-EFGH');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('That code doesn’t work.', { exact: false })).toBeVisible();
  const code = await fake<string>(page, 'linkCode', null);
  await page.getByLabel('Code from its screen').fill(code.replace('-', ' ').toLowerCase());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Add this Whombat?' })).toBeVisible();
  await agree(page);
  await page.getByRole('button', { name: 'Add it' }).click();
  await expect(page.getByRole('heading', { name: 'Your Whombat is added' })).toBeVisible();
  await page.goto(`/link?code=${code}`);
  await expect(page.getByRole('heading', { name: 'Your Whombat is already in your account' })).toBeVisible();
});

test('a third Whombat in the free month asks for a card; Checkout comes back and the subscription shows', async ({
  page,
}) => {
  await signInNew(page);
  for (const name of ['Home', 'Office']) {
    await page.goto(`/link?code=${await fake<string>(page, 'linkCode', name)}`);
    await agree(page);
    await page.getByRole('button', { name: 'Add it' }).click();
    await expect(page.getByRole('heading', { name: `${name} is added` })).toBeVisible();
  }
  await fake(page, 'checkoutLag', 1_500);
  await page.goto(`/link?code=${await fake<string>(page, 'linkCode', 'Cabin')}`);
  await agree(page);
  await page.getByRole('button', { name: 'Add it' }).click();
  await expect(
    page.getByText('You can link 2 Whombats during the free month.', { exact: false }),
  ).toBeVisible();
  // Link is sold in EU countries only: another country says so and opens nothing.
  await liveIn(page, 'other');
  await expect(
    page.getByText('Whombat Link is only sold in EU countries for now.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a card' })).toBeDisabled();
  await liveIn(page);
  await page.getByRole('button', { name: 'Add a card' }).click();
  await expect(page).toHaveURL(/\/billing/);
  await expect(page.getByText('You’re subscribed to Whombat Link.')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/billing$/);
});

test('Subscribe from the account, a free account, Included, Manage only with a card', async ({ page }) => {
  await signInNew(page);
  await page.goto('/account');
  await expect(page.getByText('Not subscribed')).toBeVisible();
  await expect(page.getByText('Your first month is free.', { exact: false })).toBeVisible();
  // Nothing to pay for before a Whombat is linked: the free month starts with the first one, never with Subscribe.
  await expect(page.getByText('Add a Whombat to start your free month.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Subscribe' })).toHaveCount(0);
  await page.goto(`/link?code=${await fake<string>(page, 'linkCode', 'Home')}`);
  await agree(page);
  await page.getByRole('button', { name: 'Add it' }).click();
  await expect(page.getByRole('heading', { name: /is added$/ })).toBeVisible();
  await page.goto('/account');
  await expect(page.getByText(/Free month · until /).first()).toBeVisible();
  await fake(page, 'linkPlan', { manual: true });
  await liveIn(page);
  await page.getByRole('button', { name: 'Add a card' }).click();
  await expect(page.getByText('there’s nothing to pay', { exact: false })).toBeVisible();
  await fake(page, 'linkPlan', { manual: false, state: 'comp' });
  await page.reload();
  await expect(page.getByText('Included', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Subscribe' })).toHaveCount(0);
  await fake(page, 'linkPlan', {
    state: 'active',
    currentPeriodEnd: Math.floor(Date.now() / 1000) + 20 * 86_400,
  });
  await page.reload();
  await expect(page.getByText(/Active · renews /).first()).toBeVisible();
  // No card on file: nothing in Stripe to manage, so paying starts with Checkout.
  await expect(page.getByRole('button', { name: 'Manage subscription' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a card' })).toBeVisible();
  await fake(page, 'linkPlan', { cardOnFile: true });
  await page.reload();
  // The terms were accepted when Home was linked: the portal opens straight away.
  await page.getByRole('button', { name: 'Manage subscription' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(account(page)).toBeVisible();
});

test('the free month: Checkout by the year, the code on the payment page; busy says so; no subscription offers Subscribe', async ({
  page,
}) => {
  await signInNew(page);
  await page.goto(`/link?code=${await fake<string>(page, 'linkCode', 'Home')}`);
  await agree(page);
  await page.getByRole('button', { name: 'Add it' }).click();
  await expect(page.getByRole('heading', { name: /is added$/ })).toBeVisible();
  await page.goto('/account');
  await expect(account(page)).toBeVisible();
  await expect(page.getByText('Have a code? Enter it on the payment page.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  // A page for the month is open elsewhere: the year waits until it closes, as control says.
  await fake(page, 'paymentPageOpen', 'month');
  await page.locator('[data-row="interval"]').getByText('€25 a year', { exact: true }).click();
  await liveIn(page);
  await page.getByRole('button', { name: 'Add a card' }).click();
  await expect(page.getByText(/already open for your Whombat Link until \d{2}:\d{2} UTC/)).toBeVisible();
  await fake(page, 'paymentPageOpen', null);
  await fake(page, 'checkoutBusy', true);
  await page.getByRole('button', { name: 'Add a card' }).click();
  await expect(page.getByText('Try again in a moment.')).toBeVisible();
  await fake(page, 'checkoutBusy', false);
  await fake(page, 'checkoutLag', 500);
  await page.getByRole('button', { name: 'Add a card' }).click();
  await expect(page.getByText('You’re subscribed to Whombat Link.')).toBeVisible({ timeout: 20_000 });
  // Still the free month; the yearly price is what follows it. After paying, changes are the portal's.
  await expect(page.getByTestId('link-price')).toContainText('Then €25 a year for each Whombat from');
  await expect(page.locator('[data-row="interval"]')).toHaveCount(0);
  // Stripe has no subscription after all: the portal says so and the card offers Subscribe.
  await fake(page, 'linkStripe', false);
  await page.getByRole('button', { name: 'Manage subscription' }).click();
  await expect(page.getByText('There’s no subscription to manage yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Subscribe' })).toBeVisible();
});

test('a Whombat removed from Link after a confirmation; Link ending says until when and how to keep it', async ({
  page,
}) => {
  await signInNew(page);
  await page.goto(`/link?code=${await fake<string>(page, 'linkCode', 'Home')}`);
  await agree(page);
  await page.getByRole('button', { name: 'Add it' }).click();
  await expect(page.getByRole('heading', { name: /is added$/ })).toBeVisible();
  await page.goto('/account');
  const box =
    (await fake<{ link: { boxes: { device: string }[] } }>(page, 'state')).link.boxes[0]?.device ?? '';
  await fake(page, 'linkPlan', { state: 'cancelled' });
  await fake(page, 'linkBox', box, {
    state: 'grace',
    graceEndsAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
  });
  await page.reload();
  await expect(page.getByTestId('link-notice')).toContainText('Tailscale');
  await expect(page.getByRole('button', { name: 'Subscribe again' })).toBeVisible();
  await fake(page, 'linkBox', box, { state: 'ended', graceEndsAt: null });
  await page.reload();
  await expect(page.getByTestId('link-notice')).toContainText('Whombat Link has ended.');
  await page.goto('/');
  await page.getByRole('button', { name: 'More for Home' }).click();
  await page.getByRole('button', { name: 'Remove from Whombat Link' }).click();
  await expect(page.getByText('Remove Home from Whombat Link?', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Remove it' }).click();
  await expect(page.getByRole('heading', { name: 'Add your Whombat' })).toBeVisible();
});

test('the legal pages stay public', async ({ page }) => {
  await page.goto('/legal/subscription-terms');
  await expect(page.getByRole('heading', { name: 'Whombat Subscription Terms' })).toBeVisible();
});
