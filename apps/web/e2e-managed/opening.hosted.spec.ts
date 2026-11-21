/** Prepared sessions must survive adoption by the production app, including its cache scope and live updates. */
import { expect, test } from '@playwright/test';
import { msg_dm_dusty_mara_0912 } from '@whombat/fixtures';
import { claimFresh, fake, fresh, signIn } from './support';

for (const theme of ['light', 'dark'] as const)
  test(`prepares an enrolled Whombat on focus and reuses it for Chat (${theme})`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme });
    await fresh(page);
    await fake(page, 'reset');
    await page.reload();
    await signIn(page);
    const appliance = await claimFresh(page);
    await page.mouse.move(0, 0);
    await page.goto('/appliances');
    const open = page.getByRole('button', { name: 'Open Burrow HQ' });
    await open.focus();
    await page.waitForFunction(() =>
      performance.getEntriesByType('mark').some((m) => m.name.endsWith('.welcome')),
    );
    expect(await fake<unknown[]>(page, 'connects')).toHaveLength(1);
    await expect(page.getByRole('heading', { name: 'Pick a Whombat' })).toBeVisible();
    await open.press('Enter');
    const room = page.locator('[data-screen="chat"]');
    const composer = room.getByRole('textbox');
    await expect(composer).toBeVisible();
    await page.waitForFunction(() => window.__WHOMBAT_OPEN_TIMINGS__?.().some((s) => s.totalMs !== null));
    const timing = await page.evaluate(() => window.__WHOMBAT_OPEN_TIMINGS__?.().at(-1));
    expect(timing).toMatchObject({ prepared: true, connectionMs: 0 });
    // One interactive connection, reused, and the normal warm connection for pictures.
    expect(await fake<unknown[]>(page, 'connects')).toHaveLength(2);
    await info.attach('opening-timing', {
      body: JSON.stringify(timing, null, 2),
      contentType: 'application/json',
    });
    const live = {
      ...msg_dm_dusty_mara_0912,
      id: 'msg_prepared-live',
      text: 'Live update after opening',
      createdAt: new Date().toISOString(),
    };
    await fake(page, 'publish', appliance.device, `conv:${live.conversationId}`, {
      type: 'message.created',
      message: live,
    });
    await expect(room.getByText(live.text, { exact: true })).toBeVisible();
    await composer.fill('The prepared connection works');
    await composer.press('Enter');
    await expect(room.getByText('The prepared connection works', { exact: true })).toHaveCount(1);
  });
