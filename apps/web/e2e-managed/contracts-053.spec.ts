/**
 * Contracts 0.5.3 on the fake world: the client security floor (CT-53) and diagnostic bundles (CT-52). Packs over the
 * session went with the packs (Whombat skill-store.md SST-09; AP-4109); owner-assisted re-enrollment with owners
 * (one-person.md AP-5681).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

/** Burrow screens are burrow-less (AP-360); the open appliance's burrow is the one they show. */
const B = '';

async function setup(page: Page) {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  return claimAndSaveKit(page);
}

test('security floor: a build below it gets a plain “Update the app” page; lifted, it connects again', async ({
  page,
}) => {
  const c = await setup(page);
  await fake(page, 'clientFloor', c.device, { web: 2_000_000_000 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Update the app' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('no longer lets this version of the app in', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await fake(page, 'clientFloor', c.device, { web: 1, android: 140 });
  await page.reload();
  await expect(page.getByRole('link', { name: 'Chat' }).first()).toBeVisible({ timeout: 15_000 });
  await page.goto(`${B}/settings?tab=appliance&section=about`);
  await expect(page.getByText('Oldest app builds let in')).toBeVisible();
  await expect(page.getByText('Web 1 · Android 140')).toBeVisible();
});

test('diagnostics: choose, make, read exactly what is in it, download the same bytes, delete', async ({
  page,
}) => {
  const c = await setup(page);
  await page.goto('/settings?tab=advanced&part=diagnostics');
  const section = page.getByRole('region', { name: 'DIAGNOSTICS' });
  await expect(section.getByText('Nothing is sent anywhere by itself', { exact: false })).toBeVisible();
  // What to include is a dialog, in plain words (this-whombat-sections.md AP-1232).
  await section.getByRole('button', { name: 'Make a file for support…' }).click();
  const choose = page.getByRole('dialog', { name: 'Make a file for support' });
  await expect(
    choose.getByText('Whether backups work and when the last one ran.', { exact: false }),
  ).toBeVisible();
  await choose.getByRole('checkbox', { name: /Connection/ }).check();
  await choose.getByRole('button', { name: 'Make the file' }).click();
  await expect(choose).toHaveCount(0);
  const bundle = section.getByTestId('diagnostics-bundle');
  await expect(bundle.getByText('Versions · Health · Connection')).toBeVisible();
  await bundle.getByRole('button', { name: 'Show what’s in it' }).click();
  await expect(section.getByText('This is exactly what the file contains.', { exact: false })).toBeVisible();
  const shown = await section.getByTestId('diagnostics-preview').textContent();
  expect(JSON.parse(shown ?? '')).toMatchObject({
    format: 'whombat-diagnostics/1',
    scopes: ['versions', 'health', 'connectivity'],
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    bundle.getByRole('button', { name: 'Download' }).click(),
  ]);
  const bytes = readFileSync((await download.path()) as string);
  const state = await fake<{
    appliances: Record<string, { diagnostics: { summary: { sha256: string; size: number } }[] }>;
  }>(page, 'state');
  const summary = state.appliances[c.device]?.diagnostics[0]?.summary;
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(summary?.sha256);
  expect(JSON.parse(bytes.toString('utf8'))).toEqual(JSON.parse(shown ?? ''));
  await expect(bundle.getByText('Downloaded 1 time', { exact: false })).toBeVisible();
  await bundle.getByRole('button', { name: 'Delete' }).click();
  await expect(section.getByText('No diagnostic files yet.')).toBeVisible();

  // What the appliance stored no longer matches its recorded hash: nothing is shown.
  await section.getByRole('button', { name: 'Make a file for support…' }).click();
  await page
    .getByRole('dialog', { name: 'Make a file for support' })
    .getByRole('button', { name: 'Make the file' })
    .click();
  await expect(section.getByTestId('diagnostics-bundle')).toBeVisible();
  await fake(page, 'tamperDiagnostics', c.device);
  await section.getByRole('button', { name: 'Show what’s in it' }).click();
  await expect(
    section.getByText('The file didn’t match what your Whombat recorded', { exact: false }),
  ).toBeVisible();
  await expect(section.getByTestId('diagnostics-preview')).toHaveCount(0);
});
