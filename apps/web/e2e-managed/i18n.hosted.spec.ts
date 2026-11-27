/**
 * The page's language in the hosted build under its own Content-Security-Policy: Dutch through `?lang=nl`, the
 * pseudo-locale for QA through `?lang=pseudo`, and Settings → You → Language switching English ↔ Dutch once, without
 * springing back. Each with no console error, no page error and no CSP violation.
 */
import { expect, type Page, test } from '@playwright/test';
import { claimFresh, fake, fresh, signIn } from './support';

interface Watch {
  /** Console errors, page errors and CSP violations seen so far. */
  problems(): Promise<string[]>;
  /** Every value `<html lang>` took, in order, without repeats. */
  langs(): Promise<string[]>;
  /** Starts the record of `<html lang>` again from its value now. */
  mark(): Promise<void>;
}

/** Records errors, CSP violations and `<html lang>` changes from the first script of every page on. */
async function watch(page: Page): Promise<Watch> {
  const seen: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text()))
      seen.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => seen.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[]; __langs: string[] };
    w.__csp = [];
    w.__langs = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`),
    );
    const note = () => {
      const lang = document.documentElement.lang;
      if (w.__langs.at(-1) !== lang) w.__langs.push(lang);
    };
    // The first script runs before `<html>` exists: watch the document for it.
    new MutationObserver(note).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['lang'],
    });
  });
  return {
    problems: async () => [
      ...seen,
      ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).map(
        (v) => `csp: ${v}`,
      ),
    ],
    langs: () => page.evaluate(() => (window as unknown as { __langs: string[] }).__langs),
    mark: () =>
      page.evaluate(() => {
        (window as unknown as { __langs: string[] }).__langs = [document.documentElement.lang];
      }),
  };
}

async function claimed(page: Page): Promise<void> {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  await claimFresh(page);
}

test('Dutch with ?lang=nl, then English ↔ Dutch in Settings without springing back', async ({ page }) => {
  await claimed(page);
  const w = await watch(page);

  await page.goto('/settings?tab=profile&lang=nl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl-NL');
  await expect(page.getByRole('radiogroup', { name: 'Taal' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Koppelingen' }).first()).toBeVisible();
  expect(await w.problems()).toEqual([]);

  // `?lang=` empty drops the tab's test language: the page follows the owner's own choice (English) again.
  await page.goto('/settings?tab=profile&lang=');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
  const english = page.getByRole('radiogroup', { name: 'Language' });
  await expect(english).toBeVisible();
  await page.waitForLoadState('networkidle');
  await w.mark();

  await english.getByText('Nederlands').click();
  await expect(page.getByRole('radiogroup', { name: 'Taal' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl-NL');
  // The box's words come back in Dutch and nothing pulls the page back to English.
  await page.waitForLoadState('networkidle');
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl-NL');
  expect(await w.langs()).toEqual(['en-GB', 'nl-NL']);

  // And back to English, once.
  await page.getByRole('radiogroup', { name: 'Taal' }).getByText('English').click();
  await expect(page.getByRole('radiogroup', { name: 'Language' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
  expect(await w.langs()).toEqual(['en-GB', 'nl-NL', 'en-GB']);

  // The choice is the owner's: the next visit opens in it.
  await page.reload();
  await expect(page.getByRole('radiogroup', { name: 'Language' })).toBeVisible();
  expect(await w.problems()).toEqual([]);
});

test('the pseudo-locale with ?lang=pseudo', async ({ page }) => {
  await claimed(page);
  const w = await watch(page);

  await page.goto('/settings?tab=profile&lang=pseudo');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  // Pseudo words: accented letters inside brackets, longer than the English.
  const group = page.getByRole('radiogroup', { name: /^\[Ļ.*\]$/ });
  await expect(group).toBeVisible();
  await expect(
    page
      .getByText(/^\[.*~+\]$/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expect(page.locator('[data-screen]').first()).toBeVisible();
  expect(await w.problems()).toEqual([]);
});
