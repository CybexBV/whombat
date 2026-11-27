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
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from './i18n/catalog';
import { CARDS_AREA_WORDS } from './i18n/messages/chatWork/cards';

/** “9/10”, “7.5/10”. */
const scoreText = (target: number) => `${Number.isInteger(target) ? target : target.toFixed(1)}/10`;

/** Settings → the assistant → Council's words, in a locale (English when none). */
export function councilSetupWords(locale?: string | null) {
  const w = clientTree(locale, CARDS_AREA_WORDS).councilSetup;
  return {
    title: w.title,
    intro: (assistant: string) => interpolate(w.intro, { assistant }),
    /** Above the seats: who sits is T3 Code's council. */
    sits: w.sits,
    /** Under the seats. */
    sitsHint: w.sitsHint,
    /** No council has sat yet and T3 Code can't be asked. */
    sitsUnknown: w.sitsUnknown,
    edit: w.edit,
    /** Back to the usual rounds and score. */
    reset: w.reset,
    resetAsk: w.resetAsk,
    resetBody: w.resetBody,
    rounds: w.rounds,
    roundsHint: w.roundsHint,
    target: w.target,
    targetHint: w.targetHint,
    save: w.save,
    cancel: w.cancel,
    saved: w.saved,
    wasReset: w.wasReset,
    notAvailable: w.notAvailable,
    /** The model is there, but no longer thinks at the chosen level. */
    effortNotAvailable: w.effortNotAvailable,
    /** Why the choices are missing. */
    t3: { not_connected: w.t3.not_connected, unreachable: w.t3.unreachable },
    /** The council couldn't be read. */
    loadFailed: w.loadFailed,
    /** A save or a reset that didn't go through, without the server's own words. */
    failed: w.failed,
    /** “Claude Opus 5.5 · Extra high”. */
    seatLine: (model: string, effort: string | null) => (effort ? `${model} · ${effort}` : model),
    /** A score to reach, “9/10”. */
    score: scoreText,
    /** “3 AIs · up to 3 rounds · 9/10”. */
    summary: (seats: number, rounds: number, target: number) =>
      w.summary(rounds, { seats, score: scoreText(target) }),
  };
}

/** Settings → the assistant → Council's words, in English. */
export const COUNCIL_SETUP_WORDS = councilSetupWords();
const COUNCIL_SETUP_TEXT = COUNCIL_SETUP_WORDS;

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
  locale?: string | null,
): CouncilSeatView {
  const COUNCIL_SETUP_WORDS = locale ? councilSetupWords(locale) : COUNCIL_SETUP_TEXT;
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
