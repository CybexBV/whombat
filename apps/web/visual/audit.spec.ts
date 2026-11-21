/**
 * The audit log as screenshot baselines (`__screenshots__/audit.spec.ts/`), light and dark: the default view (e-9f18
 * expanded), the actor + kind filters (Agents, Code), and expanded rows of each detail shape (blocked: KEY IT NEEDED;
 * a decided ask: DECIDED). The app gets the state from its URL (`?actor=&kind=&open=`).
 *
 * The mock's log is the crew's: six agents' rows, their fingerprints and a per-agent filter. The one-agent log (the
 * fixture world's rows: Neo and the people, Whombat one-agent.md OA-01) can't be compared with it row for row, so the
 * screen is pinned by baselines of its own (hermes-engine-app.md AP-5102), reviewed against the mock's log screen when
 * taken. Update with `pnpm visual --update-snapshots audit.spec.ts` and review the PNGs.
 */
import { expect, neutraliseWorld, openApp, settle, THEMES, test } from './support/harness';

const STATES = [
  { name: 'default', query: '' },
  { name: 'agents-code', query: '?actor=agents&kind=code' },
  { name: 'blocked-expanded', query: '?kind=blocked&open=evt_9d31' },
  { name: 'asks-decided-expanded', query: '?kind=asks&open=evt_9d77' },
] as const;

for (const s of STATES) {
  for (const theme of THEMES) {
    test(`audit log, ${s.name} (${theme})`, async ({ page }) => {
      await openApp(page, { path: `/log${s.query}`, theme });
      await page.getByRole('heading', { name: 'Audit log' }).waitFor();
      await page
        .getByText(/ · e-9/)
        .first()
        .waitFor();
      await neutraliseWorld(page);
      await settle(page);
      await expect(page).toHaveScreenshot(`audit-${s.name}-${theme}.png`);
    });
  }
}
