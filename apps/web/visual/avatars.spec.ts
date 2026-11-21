/**
 * The agent's five faces against the crew's reference, `docs/design-handoff/whombat-crew/reference/crew-reference.html`
 * (app docs/decisions/crew.md; Whombat five-agents.md FA-16 before it): every face at 160, 64 and 40 px (bust),
 * 32 (head), 24 and 16 (small head), on the reference's light and dark surfaces.
 *
 * The reference draws each `<img>` from the handoff's `svg/` files, the same bytes as `packages/avatars/svg`; the app
 * shows them through `<WhombatAvatar>` (`/visual/avatars.html`). Each avatar is compared element by element. The
 * screen specs mask avatars (`[data-avatar]`): the desktop mock still draws the retired family.
 */
import { AVATAR_FACES } from '@whombat/avatars';
import { shootCrewReferenceElements } from '@whombat/visual-tools';
import { expectMatch, test } from './support/harness';

/** The reference's order in each row: 160, 64, 40, 32, 24 and 16. */
const SIZES = [160, 64, 40, 32, 24, 16] as const;
/**
 * Same files, same rasteriser. The reference lays its images out at a fractional y (.47 px), so the 160 px busts
 * differ by 2–23 anti-aliased pixels at the mouth (0.008–0.090 %, the Lead on dark the most; measured 2026-10-21);
 * every smaller size is 0.000 %.
 */
const BUDGET = 0.1;

for (const surface of ['light', 'dark'] as const) {
  test.describe(`the faces on ${surface}`, () => {
    let references: Buffer[] = [];
    test.beforeAll(async () => {
      references = await shootCrewReferenceElements(`#sizes-${surface} img`);
    });

    // The reference's rows are the faces in their order (Dusty, Banjo, Neo, Skipper, Hazel).
    for (const [row, face] of AVATAR_FACES.entries()) {
      for (const [i, size] of SIZES.entries()) {
        test(`${face} at ${size}px matches the reference`, async ({ page }, testInfo) => {
          const reference = references[row * SIZES.length + i];
          if (!reference) throw new Error(`the reference has no avatar ${row}/${i}`);
          await page.setViewportSize({ width: 200, height: 200 });
          await page.goto(`/visual/avatars.html?face=${face}&size=${size}&surface=${surface}`);
          const img = page.locator('img[data-avatar]');
          await img.waitFor();
          await page.waitForFunction(() => {
            const el = document.querySelector('img[data-avatar]') as HTMLImageElement | null;
            return !!el && el.complete && el.naturalWidth > 0;
          });
          await expectMatch(testInfo, {
            name: `avatar-${face}-${size}-${surface}`,
            reference,
            mine: await img.screenshot({ animations: 'disabled' }),
            budget: BUDGET,
          });
        });
      }
    }
  });
}
