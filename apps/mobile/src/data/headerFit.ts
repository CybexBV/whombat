/**
 * Which header buttons fit beside a page's title, and which go into its ⋯ menu: on a narrow page (the list beside the
 * Duo's open right page, larger text) the title keeps its room and the buttons that don't fit move into the menu, the
 * first ones kept longest. Widths are estimated from the words at the header's sizes, scaled with the text size.
 */

export interface HeaderButtonSpec {
  id: string;
  label: string;
  /** Carries a count badge. */
  badge?: boolean;
}

/** The header's own room: its left padding (22), its right (10), the title's minimum and the ⋯ button. */
const PAD_LEFT = 22;
const PAD_RIGHT = 10;
const MORE = 44;
/** Between the header's buttons, so Feedback and Settled read as two (docs/decisions/chat-threads-cards.md). */
export const HEADER_GAP = 8;
const GAP = HEADER_GAP;
/** Average glyph widths at the title's 24/700 and the buttons' 15.5. */
const TITLE_CHAR = 14;
const BUTTON_CHAR = 8.4;
/** The button's padding and its 1pt outline, each side. */
const BUTTON_PAD = 22;
const BADGE = 28;

function buttonWidth(b: HeaderButtonSpec, scale: number): number {
  return b.label.length * BUTTON_CHAR * scale + BUTTON_PAD + (b.badge ? BADGE : 0);
}

/** The buttons shown in the header (in order) and the ones moved into ⋯, for a page `width` points wide. */
export function fitHeaderButtons(
  width: number,
  title: string,
  buttons: readonly HeaderButtonSpec[],
  fontScale = 1,
): { shown: HeaderButtonSpec[]; more: HeaderButtonSpec[] } {
  const titleWidth = title.length * TITLE_CHAR * fontScale;
  const room = width - PAD_LEFT - PAD_RIGHT - titleWidth;
  const all = buttons.reduce((sum, b) => sum + GAP + buttonWidth(b, fontScale), 0);
  if (all <= room) return { shown: [...buttons], more: [] };
  const shown: HeaderButtonSpec[] = [];
  let used = GAP + MORE;
  for (const b of buttons) {
    const w = GAP + buttonWidth(b, fontScale);
    if (used + w > room) break;
    shown.push(b);
    used += w;
  }
  return { shown, more: buttons.slice(shown.length) };
}
