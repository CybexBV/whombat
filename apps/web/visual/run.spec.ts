/**
 * The run page (`/runs/1907`) against the reference's run screen, the main column, light and dark,
 * at live ticks 0 (11:22, as the reference opens), 3 and 5 (steps advancing, log growing, diff +232 /
 * +244) and 8 (RUN · DONE, 41 of 41).
 *
 * The reference plays one tick every 2.6 s; `waitFor` shoots it the moment the tick's diff stat (or
 * RUN · DONE) is on screen. The cached `runs.get` data is patched to the mock's run at the same tick
 * (`mockRun.ts`): the fixture run is the 11:22 seed, the server lays out the rest as the run plays.
 *
 * The mock's run is Banjo's, the fixture world's the one agent's: the reference names Neo (`renameInReference`, Whombat
 * one-agent.md OA-01). Masked: Lucide icons (TP-14), agent avatars (AV-02); the back link and the “Asked by …” line,
 * where the mock names a channel and a crew member (“← #billing-v2”, “Asked by Hazel in #billing-v2”) and the app the
 * room and the person that asked the one agent (OA-04); the keys of the run, the hired developer's in the mock and the
 * one agent's in the app (Settings → Agent's rows, one-agent.md AP-4903; hermes-engine-app.md AP-5100); and, at
 * RUN · DONE only, the
 * header actions: the page shows only "Branch room" once the run is done, the mock's static buttons still offer
 * Pause / Take over (docs/decisions/runs-approvals.md RAP-03). The sidebar isn't compared (`mainRegion`).
 * Hidden: the ACTIVITY section under the two columns (work-supervision WS-13, AP-88) isn't in the mock
 * (`hideAdditions` in `neutraliseWorld`); the keys and files below it are compared where the mock has them.
 */
import { shootReference } from '@whombat/visual-tools';
import { patchRunScript } from './mockRun';
import {
  deviationMasks,
  elementMasks,
  expectMatch,
  lineMasks,
  mainRegion,
  neutraliseWorld,
  openApp,
  type Rect,
  renameInReference,
  settle,
  THEMES,
  test,
} from './support/harness';

/** Header actions at RUN · DONE (RAP-03), page coordinates (masks are relative to the region). */
const ACTIONS: Rect = { x: 1016, y: 120, width: 340, height: 56 };

/** What the reference shows once it has reached `tick`. */
function tickReached(tick: number): string {
  if (tick >= 8) return `document.body.innerText.includes('RUN · DONE')`;
  if (tick >= 7) return `document.body.innerText.includes('41 of 41 passing')`;
  return `document.body.innerText.includes('+${214 + tick * 6} ')`;
}

for (const theme of THEMES) {
  for (const tick of [0, 3, 5, 8]) {
    test(`run page matches the reference at tick ${tick} (${theme})`, async ({ page }, testInfo) => {
      const reference = await shootReference({
        file: 'desktop',
        props: { start: 'run', theme },
        prepare: (ref) => renameInReference(ref, { Banjo: 'Neo' }),
        ...(tick > 0 && { waitFor: tickReached(tick) }),
      });
      await openApp(page, { path: '/runs/1907', theme });
      await page.getByRole('heading', { name: 'Address review on PR #482', level: 1 }).waitFor();
      await neutraliseWorld(page);
      await page.evaluate(patchRunScript(tick));
      await page.getByText(tick >= 8 ? /^RUN · DONE/ : /^RUN · LIVE/).waitFor();
      await settle(page);

      const region = mainRegion();
      await expectMatch(testInfo, {
        name: `run-t${tick}-${theme}`,
        reference,
        mine: await page.screenshot({ animations: 'disabled' }),
        region,
        masks: [
          ...(await deviationMasks(page, region)),
          ...(await lineMasks(page.getByRole('link', { name: /^← / }), region)),
          ...(await lineMasks(page.getByText(/^Asked by /), region)),
          ...(await elementMasks(
            page.getByRole('region', { name: /keys for this run$/ }).locator('ul'),
            region,
            2,
          )),
          ...(tick >= 8 ? [{ ...ACTIONS, x: ACTIONS.x - region.x }] : []),
        ],
        budget: 0.05,
      });
    });
  }
}
