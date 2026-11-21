/**
 * Content through the session (assignment §14 item 14: no plaintext resource bypass): an image and a text file
 * uploaded in sha256-checked chunks, shown from blob object URLs (raster image) or as text, downloaded without
 * navigating; a canvas synced over the collaboration stream.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { claimAndSaveKit, fake, fresh, signIn } from './support';

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.beforeEach(async ({ page }) => {
  await fresh(page);
  await fake(page, 'reset');
  await page.reload();
  await signIn(page);
  await claimAndSaveKit(page);
});

test('attachments: uploaded through the session, shown from blob URLs, no request to a server path', async ({
  page,
}) => {
  const serverHits: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/') || path === '/ws' || path === '/collab' || path.startsWith('/embed/'))
      serverHits.push(r.url());
  });
  // An old link (`/<burrow>/…`, what the servers write) opens the burrow-less page (AP-363).
  await page.goto('/burrow-hq/pr/482');
  const composer = page.getByRole('textbox', { name: 'Comment on PR #482' });
  await expect(composer).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'dot.png', mimeType: 'image/png', buffer: PNG },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('line one\nline two\n') },
  ]);
  const chips = page.getByRole('list', { name: 'Attachments' });
  await expect(chips.getByText('70 bytes')).toBeVisible({ timeout: 15_000 });
  await expect(chips.getByText('Uploading', { exact: false })).toHaveCount(0, { timeout: 15_000 });
  await composer.fill('Two files');
  await composer.press('Enter');
  const img = page.getByRole('button', { name: 'Open dot.png' }).locator('img');
  await expect(img).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  await expect(page.getByText('line one')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download notes.txt' }).click(),
  ]);
  expect(readFileSync((await download.path()) as string, 'utf8')).toBe('line one\nline two\n');
  expect(new URL(page.url()).pathname).toBe('/pr/482');
  expect(serverHits).toEqual([]);
});

test('canvas: the document syncs over the collaboration stream', async ({ page }) => {
  await page.goto('/burrow-hq/canvases/invoice-pdf-export-plan');
  await expect(page.getByText('keyed by invoice number and locale', { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Synced over the session.');
  await expect(page.getByText('Synced over the session.')).toBeVisible();
  // The edit reached the appliance's copy of the document through the collaboration stream.
  await expect
    .poll(() => fake<string>(page, 'canvas', 'cvs_invoice-pdf-plan'), { timeout: 10_000 })
    .toContain('Synced over the session.');
});
