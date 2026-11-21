/**
 * Settings → the assistant → Council's editor: the council being changed (`councilDraft` in `@whombat/client`), what
 * Save sends, and the scores to reach it offers. Who sits is T3 Code's council, so only the rounds and the score change.
 */
import type { CouncilDraft } from '@whombat/client';
import type { SaveCouncilSetupBody } from '@whombat/core/contracts';

export type { CouncilDraft };

/** The scores to reach the editor offers. */
export const COUNCIL_TARGETS: readonly number[] = [7, 7.5, 8, 8.5, 9, 9.5, 10];

/** What Save sends (`councils.saveSetup`): the draft as the contract takes it, nothing more. */
export function councilSaveBody(draft: CouncilDraft): SaveCouncilSetupBody {
  return { seats: draft.seats, builder: draft.builder, rounds: draft.rounds, target: draft.target };
}

/** The scores to reach, with the council's own when it is another. */
export function councilTargetChoices(target: number): number[] {
  return COUNCIL_TARGETS.includes(target)
    ? [...COUNCIL_TARGETS]
    : [...COUNCIL_TARGETS, target].sort((a, b) => a - b);
}
