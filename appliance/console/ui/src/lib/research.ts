/**
 * What the assistant found out about a look (3.5; Whombat look-research.md LR-01…LR-12, appliance CG-372): the shape
 * of core's `LookResearch` as the page reads it, on a look (`DeskLook.research`) and the calm hero (`research`, `fix`).
 * Copied from the vendored `look-research.ts` and checked against it.
 */

/**
 * Where the assistant is with a look: finding out, said what is wrong, taking the step the person let it take, fixed
 * it, or couldn't finish (then the look shows as before).
 */
export const LOOK_RESEARCH_STATES = ['looking', 'found', 'fixing', 'fixed', 'failed'] as const;
export type LookResearchState = (typeof LOOK_RESEARCH_STATES)[number];
/** The bounds of its words (core's `LOOK_TITLE_MAX`, `LOOK_SUMMARY_MAX`, `LOOK_FIX_LABEL_MAX`). */
export const LOOK_TITLE_MAX = 80;
export const LOOK_SUMMARY_MAX = 240;
export const LOOK_FIX_LABEL_MAX = 32;

/**
 * A look's research: where it is, its title and summary once it found out, and the label of the one step it offers
 * (“Restart Zigbee”), only while `found`. The thread's ids aren't the desk's: Ask talks about it in Talk.
 */
export interface LookResearch {
  state: LookResearchState;
  title?: string;
  summary?: string;
  fix?: string;
}
