/**
 * Settings → the assistant → Council (Whombat docs/decisions/council.md), shared by web and the phone: the words, how a
 * seat of T3 Code's council reads (its provider, model and effort, or why it can't run now), and the council's draft:
 * who sits is always T3 Code's council, so the person changes only its rounds and score.
 */
import {
  type CouncilProviderOption,
  type CouncilSeatSetup,
  type CouncilSetup,
  councilSeatsProblem,
  EFFORT_LABELS,
} from '@whombat/core';

/** “9/10”, “7.5/10”. */
const scoreText = (target: number) => `${Number.isInteger(target) ? target : target.toFixed(1)}/10`;

export const COUNCIL_SETUP_WORDS = {
  title: 'Council',
  intro: (assistant: string) =>
    `When you ask ${assistant} for the council, several AIs look at it, each on its own, and ${assistant} brings their answers together.`,
  /** Above the seats: who sits is T3 Code's council. */
  sits: 'T3 Code’s council sits on it:',
  /** Under the seats. */
  sitsHint:
    'These are the AIs T3 Code’s council skill names. To change who sits, change that skill in T3 Code.',
  /** No council has sat yet and T3 Code can't be asked. */
  sitsUnknown: 'T3 Code’s council sits on it: the AIs its council skill names.',
  edit: 'Change',
  /** Back to the usual rounds and score. */
  reset: 'Use the usual rounds and score',
  resetAsk: 'Use the usual rounds and score?',
  resetBody: 'The council goes back to up to 3 rounds and 9/10.',
  rounds: 'Rounds',
  roundsHint: 'The most rounds to agree on a plan, and the most to check the result.',
  target: 'Score to reach',
  targetHint: 'When the council improves something, it keeps going until every member gives it this.',
  save: 'Save',
  cancel: 'Cancel',
  saved: 'Council saved',
  wasReset: 'The council has its usual rounds and score again',
  notAvailable: 'T3 Code can’t run this now, so the council goes without it.',
  /** The model is there, but no longer thinks at the chosen level. */
  effortNotAvailable: 'This model doesn’t think at that level now, so it thinks as hard as it can.',
  /** Why the choices are missing. */
  t3: {
    not_connected: 'Connect T3 Code with Manage: the council runs there.',
    unreachable: 'T3 Code can’t be reached now. These are the AIs its last council sat.',
  },
  /** The council couldn't be read. */
  loadFailed: 'Couldn’t load the council. Try again in a moment.',
  /** A save or a reset that didn't go through, without the server's own words. */
  failed: 'That didn’t go through. Try again in a moment.',
  /** “Claude Opus 5.5 · Extra high”. */
  seatLine: (model: string, effort: string | null) => (effort ? `${model} · ${effort}` : model),
  /** A score to reach, “9/10”. */
  score: scoreText,
  /** “3 AIs · up to 3 rounds · 9/10”. */
  summary: (seats: number, rounds: number, target: number) =>
    `${seats} AIs · up to ${rounds} round${rounds === 1 ? '' : 's'} · ${scoreText(target)}`,
} as const;

/** Efforts T3 Code's models take beyond the agent's own (`EFFORT_LABELS`). */
const MORE_EFFORTS: Record<string, string> = {
  minimal: 'Minimal',
  ultracode: 'Ultracode',
  ultrathink: 'Ultrathink',
};

/** An effort in words (“Extra high”); a value nobody named yet as it is, its first letter up. */
export function effortWord(value: string | null): string | null {
  if (!value) return null;
  return (
    (EFFORT_LABELS as Record<string, string>)[value] ??
    MORE_EFFORTS[value] ??
    `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`
  );
}

/** How a seat reads in the list. */
export interface CouncilSeatView {
  provider: string;
  model: string;
  effort: string | null;
  line: string;
  /** T3 Code can run it now, at its effort (true when it can't be asked: nothing is known to be wrong). */
  available: boolean;
  /** Why not, in words; null when it can. */
  note: string | null;
}

export function councilSeatView(
  seat: CouncilSeatSetup,
  options: readonly CouncilProviderOption[] | null,
): CouncilSeatView {
  const provider = options?.find((p) => p.id === seat.provider);
  const model = provider?.models.find((m) => m.id === seat.model);
  const effort = effortWord(seat.effort);
  // Its usual effort always works; a chosen one only while the model still takes it.
  const effortOk = !model || seat.effort === null || model.efforts.includes(seat.effort);
  // The names T3 Code gives now, else the ones kept when it was saved, else its ids.
  const modelName = model?.label ?? seat.modelLabel ?? seat.model;
  return {
    provider: provider?.name ?? seat.providerName ?? seat.provider,
    model: modelName,
    effort,
    line: COUNCIL_SETUP_WORDS.seatLine(modelName, effort),
    available: options === null || (!!model && effortOk),
    note:
      options === null
        ? null
        : !model
          ? COUNCIL_SETUP_WORDS.notAvailable
          : effortOk
            ? null
            : COUNCIL_SETUP_WORDS.effortNotAvailable,
  };
}

/** The usual rounds and score, before the person chose theirs. */
export const COUNCIL_USUAL = { rounds: 3, target: 9 } as const;

/**
 * The council as it is edited: its rounds and score. The seats and the builder go with a save unchanged (who sits is
 * T3 Code's council, the lead the AI the person chats with); a Whombat from before reads them.
 */
export type CouncilDraft = Pick<CouncilSetup, 'seats' | 'builder' | 'rounds' | 'target'>;

/** The council to edit: T3 Code's council's seats, with the person's rounds and score, else the usual ones. */
export function councilDraft(
  setup: CouncilSetup | null,
  automatic: readonly CouncilSeatSetup[],
): CouncilDraft {
  return {
    seats: (automatic.length >= 2 ? automatic : (setup?.seats ?? [])).map((s) => ({ ...s })),
    builder: 0,
    rounds: setup?.rounds ?? COUNCIL_USUAL.rounds,
    target: setup?.target ?? COUNCIL_USUAL.target,
  };
}

/** What keeps the council from being saved, in words (T3 Code's council has no two companies now); null: nothing. */
export function councilSetupProblem(draft: Pick<CouncilDraft, 'seats'>): string | null {
  return councilSeatsProblem(draft.seats);
}
