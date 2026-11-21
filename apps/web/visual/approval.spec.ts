/**
 * The approval modal (`?approval=12`, Neo's staging deploy) against the reference's (the channel screen, "Details" on
 * the approval card), the dialog alone, light and dark:
 * - at 11:22 (checks 38 of 41, changes requested → "Approve in advance");
 * - once the run is done (checks 41 of 41, the review approved at 11:38 → "Approve and deploy"). The reference is shot
 *   the moment its live modal shows "Approve and deploy"; the cached `approvals.get` data is patched to the same
 *   conditions (`mockApproval.ts`).
 * The app opens it over the branch room: the mock's channel under the overlay is gone with one agent (Whombat
 * one-agent.md OA-04), so only the dialog is compared (hermes-engine-app.md AP-5101). The mock's crew go by the fixture
 * world's names (`renameInReference`: its Dusty is the one agent, Neo; Hazel's review is Mara's), and the approval's
 * explainer names the agent as the fixture world does (the shared fixtures' text says Dusty, the agent's name before
 * Mara renamed it, OA-08).
 *
 * Masked: Lucide icons (TP-14), agent avatars (AV-02) and the answer row, all outlined in the card's order
 * (approval-card.md ACD-04).
 */
import { setReferenceState, shootReference } from '@whombat/visual-tools';
import { patchApprovalReadyScript } from './mockApproval';
import {
  boxOf,
  deviationMasks,
  expect,
  expectMatch,
  lineMasks,
  neutraliseWorld,
  ONE_PERSON_WORDS,
  openApp,
  patchQueries,
  renameInReference,
  settle,
  THEMES,
  test,
} from './support/harness';

for (const theme of THEMES) {
  for (const state of ['pending', 'ready'] as const) {
    test(`approval modal matches the reference, ${state} (${theme})`, async ({ page }, testInfo) => {
      const cta = state === 'ready' ? 'Approve and deploy' : 'Approve in advance';
      const reference = await shootReference({
        file: 'desktop',
        props: { start: 'channel', theme },
        // Same as clicking "Details", without scrolling the channel under the overlay.
        prepare: async (ref) => {
          await setReferenceState(ref, { modal: 'approval' });
          await renameInReference(ref, { Dusty: 'Neo', Hazel: 'Mara', ...ONE_PERSON_WORDS });
        },
        ...(state === 'ready' && {
          waitFor: `document.querySelector('[data-screen-label="Approval"]')?.innerText.includes('${cta}')`,
        }),
      });

      await openApp(page, { path: '/pr/482?approval=12', theme });
      const dialog = page.getByRole('dialog', { name: 'Deploy feat/invoice-pdf to staging?' });
      await dialog.waitFor();
      await neutraliseWorld(page);
      await patchQueries(
        page,
        'approvals.get',
        (d) => ({
          ...d,
          approval: { ...d.approval, explainer: d.approval.explainer.replace(/\bDusty\b/g, 'Neo') },
        }),
        null,
      );
      if (state === 'ready') await page.evaluate(patchApprovalReadyScript());
      await dialog.getByRole('button', { name: cta }).waitFor();
      await settle(page);

      const region = await boxOf(dialog);
      expect(region.width).toBeGreaterThanOrEqual(560);
      await expectMatch(testInfo, {
        name: `approval-${state}-${theme}`,
        reference,
        mine: await page.screenshot({ animations: 'disabled' }),
        region,
        // The answers are outlined alike, in the card's order (approval-card.md ACD-04): their row is masked.
        masks: [
          ...(await deviationMasks(page, region)),
          ...(await lineMasks(dialog.locator('[data-answers]'), region)),
        ],
        budget: 0.05,
      });
    });
  }
}
