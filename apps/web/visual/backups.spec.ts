/**
 * Settings → This Whombat → Backups, which has no mock for these states, as screenshot baselines
 * (`__screenshots__/backups.spec.ts/`), light and dark, 1440×900 (app backup-v2.md AP-6880…; reviewed against the
 * existing Backups part and the Settings tokens when taken): the page as fixture mode's box has it (backed up, can be
 * brought back), the top card failing (with Ask to fix it), behind, backing up now, just after Back up now, with a
 * backup that left something out, with the passkey's one calm line, and while the backup service isn't answering;
 * the line about older backups on a place used before; Details unfolded; one backup's page with a gap in what's in it
 * and “Bring things back from this backup” under its check. The states the box doesn't reach by itself are patched
 * into `backup.status`'s and the page notes' cached answers.
 */
import type { Page } from '@playwright/test';
import { expect, openApp, patchQueries, settle, THEMES, test } from './support/harness';

async function open(page: Page, theme: 'light' | 'dark') {
  await openApp(page, { path: '/settings?tab=appliance&section=backups', theme });
  await page.locator('h1').first().waitFor();
  const hero = page.locator('[data-backup-hero]');
  await hero.waitFor();
  await page.locator('[data-backup-list] [data-backup]').first().waitFor();
  return hero;
}

/** The service's status and summary as a state the box doesn't reach on its own. */
async function patchStatus(
  page: Page,
  patch: Record<string, unknown>,
  summary: Record<string, unknown> = {},
) {
  const n = await patchQueries(
    page,
    'backup.status',
    (data, arg) => ({
      ...data,
      status: { ...data.status, ...arg.patch },
      summary: { ...data.summary, ...arg.summary },
    }),
    { patch, summary },
  );
  expect(n).toBeGreaterThan(0);
}

const days = (n: number) => new Date(Date.parse('2026-09-23T09:22:00Z') - n * 86_400_000).toISOString();

for (const theme of THEMES) {
  test(`Backups (${theme})`, async ({ page }) => {
    await open(page, theme);
    await settle(page);
    await expect(page).toHaveScreenshot(`page-${theme}.png`);
  });

  test(`the top card's states (${theme})`, async ({ page }) => {
    const hero = await open(page, theme);
    await patchStatus(page, {
      state: 'failing',
      lastFailure: { id: 'f', at: days(0), stage: 'upload', reason: 'The NAS at 192.168.1.40 didn’t answer' },
    });
    await expect(hero).toHaveAttribute('data-state', 'failing');
    await settle(page);
    await expect(hero).toHaveScreenshot(`hero-failing-${theme}.png`);

    await patchStatus(page, { state: 'stale', lastFailure: null, lastSuccess: { at: days(3) } });
    await expect(hero).toHaveAttribute('data-state', 'behind');
    await settle(page);
    await expect(hero).toHaveScreenshot(`hero-behind-${theme}.png`);

    await patchStatus(page, {
      state: 'protected',
      running: { id: 'chk', op: 'checkpoint', stage: 'upload', since: days(0) },
    });
    await expect(hero).toHaveAttribute('data-state', 'running');
    await settle(page);
    await expect(hero).toHaveScreenshot(`hero-running-${theme}.png`);

    await patchStatus(
      page,
      { running: null },
      {
        incomplete: { reason: '1 attachment wasn’t on this Whombat any more, so it isn’t in this backup' },
        bringBack: { state: 'needs_passkey', passkeys: 0, lockedAt: null, nasCopyAt: null, paperAt: null },
      },
    );
    await hero.locator('[data-backup-passkey]').waitFor();
    await settle(page);
    await expect(hero).toHaveScreenshot(`hero-passkey-left-out-${theme}.png`);
  });

  test(`the service not answering, and older backups elsewhere (${theme})`, async ({ page }) => {
    const hero = await open(page, theme);
    const notice =
      'Your Whombat’s backup service isn’t answering right now. It usually comes back by itself; try again in a minute.';
    await patchQueries(page, 'backup.pageNotes', (data, arg) => ({ ...data, ...arg }), {
      notice: null,
      earlierPlaces: [{ placeId: 'connection:con_attic', name: 'Attic' }],
    });
    const list = page.locator('[data-backup-list]');
    await list.locator('[data-backup-earlier]').waitFor();
    await list.locator('[data-backup-earlier]').scrollIntoViewIfNeeded();
    await settle(page);
    await expect(list).toHaveScreenshot(`list-earlier-${theme}.png`);

    await patchQueries(page, 'backup.pageNotes', (data, arg) => ({ ...data, ...arg }), { notice });
    const n = await patchQueries(page, 'backup.status', (data) => ({ ...data, status: null }), null);
    expect(n).toBeGreaterThan(0);
    await expect(hero).toHaveAttribute('data-state', 'unknown');
    await hero.scrollIntoViewIfNeeded();
    await settle(page);
    await expect(hero).toHaveScreenshot(`hero-down-${theme}.png`);
  });

  test(`Back up now, then “Backed up just now” (${theme})`, async ({ page }) => {
    const hero = await open(page, theme);
    await hero.getByRole('button', { name: 'Back up now' }).click();
    await expect(hero).toHaveAttribute('data-state', 'justNow', { timeout: 10_000 });
    await settle(page);
    await expect(hero).toHaveScreenshot(`hero-just-now-${theme}.png`);
  });

  test(`saving and verifying the passkey's backup key (${theme})`, async ({ page }) => {
    const hero = await open(page, theme);
    const bringBack = {
      state: 'needs_passkey',
      setup: 'saving',
      passkeys: 1,
      lockedAt: null,
      verifiedAt: null,
      nasCopyAt: null,
      paperAt: null,
    };
    await patchStatus(page, {}, { bringBack });
    await expect(hero).toContainText('Your backup details are being saved.');
    await expect(hero.locator('[data-backup-way-back]')).toHaveAttribute('data-tone', 'mut');
    await expect(hero.locator('[data-backup-passkey]')).toHaveCount(0);
    await settle(page);
    await expect(hero).toHaveScreenshot(`hero-passkey-saving-${theme}.png`);

    await patchStatus(
      page,
      {},
      {
        bringBack: { ...bringBack, state: 'ready', setup: 'verify', lockedAt: days(0) },
      },
    );
    await expect(hero).toContainText('Passkey setup isn’t finished.');
    await expect(hero.locator('[data-backup-way-back]')).toHaveAttribute('data-tone', 'mut');
    await expect(hero.locator('[data-backup-passkey]')).toBeVisible();
    await settle(page);
    await expect(hero).toHaveScreenshot(`hero-passkey-verify-${theme}.png`);
  });

  test(`Details and one backup's page (${theme})`, async ({ page }) => {
    await open(page, theme);
    const details = page.locator('[data-backup-details]');
    await details.getByRole('button', { name: 'Details' }).click();
    await details.scrollIntoViewIfNeeded();
    await settle(page);
    await expect(details).toHaveScreenshot(`details-${theme}.png`);

    const list = page.locator('[data-backup-list]');
    await list.getByRole('button', { name: /^Show all/ }).click();
    await list.getByText('Left something out').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await settle(page);
    await expect(dialog).toHaveScreenshot(`backup-gap-${theme}.png`);
  });
}
