/**
 * Toasts against the reference, light and dark, each toast alone (without its rounded corners: the page behind them
 * differs):
 * - "Approved in advance…" after approving Neo's deploy in the approval modal (fixture mode's approve fast-forwards
 *   the storyline to DEPLOYED, docs/decisions/fixtures.md; the card's states are compared in cards.spec.ts);
 * - "Declined…" after declining in the approval modal.
 * The app opens the modal over the branch room; the mock's channel behind it went with one agent (Whombat one-agent.md
 * OA-04; hermes-engine-app.md AP-5101). The reference's `toast` (and `approval`) state is patched to the app's words:
 * its `flash()` would clear it after 2.6 s. The app's toast auto-dismisses after 2.6 s too, so the shot is taken as
 * soon as it is up and the spec checks it was still up.
 */
import type { Page } from '@playwright/test';
import { setReferenceState, shootReference } from '@whombat/visual-tools';
import {
  boxOf,
  expect,
  expectMatch,
  neutraliseWorld,
  openApp,
  type Rect,
  settle,
  THEMES,
  test,
} from './support/harness';

/** The toast's box without its rounded corners. */
async function toastRegion(page: Page, text: string): Promise<Rect> {
  const box = await boxOf(page.getByRole('status').getByText(text));
  return { x: box.x + 8, y: box.y, width: box.width - 16, height: box.height };
}

/** Waits for the toast, shoots at once, and checks the toast was still up. */
async function shootToast(page: Page, text: string): Promise<Buffer> {
  const toast = page.getByRole('status').getByText(text);
  await toast.waitFor();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const shot = await page.screenshot({ animations: 'disabled' });
  await expect(toast).toBeVisible();
  return shot;
}

const TOASTS = [
  {
    name: 'approved',
    approval: 'approved',
    button: 'Approve in advance',
    text: 'Approved in advance. Neo will deploy when checks are green.',
  },
  {
    name: 'declined',
    approval: 'declined',
    button: 'Decline',
    text: 'Declined. Neo won’t deploy this commit.',
  },
] as const;

for (const t of TOASTS) {
  for (const theme of THEMES) {
    test(`"${t.text.split('.')[0]}" toast matches the reference (${theme})`, async ({ page }, testInfo) => {
      const reference = await shootReference({
        file: 'desktop',
        props: { start: 'channel', theme },
        prepare: (ref) => setReferenceState(ref, { approval: t.approval, toast: t.text }),
      });
      await openApp(page, { path: '/pr/482?approval=12', theme });
      const dialog = page.getByRole('dialog', { name: 'Deploy feat/invoice-pdf to staging?' });
      await dialog.getByRole('button', { name: t.button }).waitFor();
      await neutraliseWorld(page);
      await settle(page);
      await dialog.getByRole('button', { name: t.button }).click();
      const mine = await shootToast(page, t.text);
      await expectMatch(testInfo, {
        name: `toast-${t.name}-${theme}`,
        reference,
        mine,
        region: await toastRegion(page, t.text),
        budget: 0.05,
      });
    });
  }
}
