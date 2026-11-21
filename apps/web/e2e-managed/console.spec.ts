/**
 * Consoles through the session (contracts 0.80.1, CT-350; Whombat one-whombat-consoles.md): on a box reached through
 * the relay the server's shell opens on the session's console stream, not a WebSocket to the box — the dialog shows the
 * shell's prompt, typing reaches it and its answer comes back. The fake world's servers and its tiny shell
 * (`managed/fake/console.ts`) stand in for the hosts service.
 */
import { expect, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

test.beforeEach(async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await fake(page, 'servers', true);
  await page.reload();
  await signIn(page);
  await claimAndSaveKit(page);
});

test('a server’s shell opens through the session and answers typing', async ({ page }) => {
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.goto('/things/server%3Apve-02?console=host');
  const dialog = page.getByRole('dialog', { name: 'Shell on pve-02' });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText('Consoles open on the local network for now', { exact: false })).toHaveCount(
    0,
  );
  const screen = dialog.getByRole('application', { name: 'Shell on pve-02' });
  await expect(screen.getByText('Welcome to pve-02', { exact: false })).toBeVisible({ timeout: 15_000 });
  await screen.click();
  await page.keyboard.type('hostname');
  await page.keyboard.press('Enter');
  await expect(screen.getByText('root@pve-02:~# hostname')).toBeVisible();
  await expect.poll(() => fake<number>(page, 'consolesOpened')).toBe(1);
  // Nothing went to the box's console WebSocket path: the session carried it.
  expect(sockets.filter((u) => u.includes('/hosts/consoles/'))).toEqual([]);
  // `exit` ends it with the shell's reason, and Connect again opens a new one.
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(dialog.getByText('The session ended.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect again' }).click();
  await expect(screen.getByText('Welcome to pve-02', { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => fake<number>(page, 'consolesOpened')).toBe(2);
});
