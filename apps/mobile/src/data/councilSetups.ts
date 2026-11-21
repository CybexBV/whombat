/**
 * Settings → the assistant → Council on the phone (Whombat docs/decisions/council.md; app council-phone.md): the part's
 * one council — who T3 Code's council sits, to read (a seat T3 Code can't run now muted, with why), where to change that,
 * and how it runs (the person's rounds and score, else the usual ones), and why nothing can be changed while T3 Code's
 * choices are missing — and the editor's draft: its rounds, the score to reach as the app's menu, and what keeps it from
 * being saved. The words are the shared ones (`@whombat/client`'s `COUNCIL_SETUP_WORDS`), so the web says the same. Pure.
 */
import {
  COUNCIL_SETUP_WORDS,
  COUNCIL_USUAL,
  type CouncilDraft,
  type CouncilSeatView,
  councilDraft,
  councilSeatView,
  councilSetupProblem,
} from '@whombat/client';
import {
  COUNCIL_ROUNDS_ASKED_MAX,
  type CouncilSeatSetup,
  type CouncilSetupResponse,
  type SaveCouncilSetupBody,
} from '@whombat/core';
import type { NativeMenuItem, NativeMenuSpec } from './nativeMenu';

export type { CouncilDraft };

/* The part ---------------------------------------------------------------------------------------------------------- */

/** One seat: its model and thinking in a line, its company, muted when T3 Code can't run it now. */
export interface CouncilSeatLine extends CouncilSeatView {
  key: string;
}

/** The council as the part shows it: T3 Code's council's seats, with the person's rounds and score or the usual ones. */
export interface CouncilShown {
  /** The person chose its rounds and score (else they are the usual ones). */
  yours: boolean;
  /** Over the seats: T3 Code's council sits on it; with no seats to show, that it sits the AIs its skill names. */
  text: string;
  /** Under the seats: to change who sits, change the skill in T3 Code; null without seats. */
  hint: string | null;
  /** “4 AIs · up to 3 rounds · 9/10”; null without seats. */
  summary: string | null;
  seats: CouncilSeatLine[];
  /** Under the seats when one of them can't run now. */
  note: string | null;
  /** For screen readers: the whole council in one go. */
  label: string;
}

export interface CouncilPartView {
  intro: string;
  council: CouncilShown;
  /** Why nothing can be changed now (T3 Code not connected, or out of reach); null when it can. */
  t3: string | null;
  /** The rounds and score open for changes: while T3 Code's choices are known and its council has seats. */
  editable: boolean;
  /** “Use the usual rounds and score” shows: the person chose theirs, and T3 Code's choices are known. */
  canReset: boolean;
}

function seatLines(
  seats: readonly CouncilSeatSetup[],
  options: CouncilSetupResponse['options'],
): CouncilSeatLine[] {
  return seats.map((seat, i) => ({
    key: `${i}:${seat.provider}:${seat.model}`,
    ...councilSeatView(seat, options),
  }));
}

/** The part from `councils.setup`'s answer. */
export function councilPartView(data: CouncilSetupResponse, assistant: string): CouncilPartView {
  const known = data.options !== null;
  const { setup } = data;
  const seats = seatLines(setup?.seats ?? data.automatic, data.options);
  const some = seats.length > 0;
  const text = some ? COUNCIL_SETUP_WORDS.sits : COUNCIL_SETUP_WORDS.sitsUnknown;
  const hint = some ? COUNCIL_SETUP_WORDS.sitsHint : null;
  const summary = some
    ? COUNCIL_SETUP_WORDS.summary(
        seats.length,
        setup?.rounds ?? COUNCIL_USUAL.rounds,
        setup?.target ?? COUNCIL_USUAL.target,
      )
    : null;
  const note = seats.find((seat) => seat.note)?.note ?? null;
  return {
    intro: COUNCIL_SETUP_WORDS.intro(assistant),
    council: {
      yours: !!setup,
      text,
      hint,
      summary,
      seats,
      note,
      label: [text, ...seats.map((seat) => `${seat.provider}: ${seat.line}`), note, hint, summary]
        .filter(Boolean)
        .join('. '),
    },
    t3:
      data.t3 === 'ready' && known
        ? null
        : COUNCIL_SETUP_WORDS.t3[data.t3 === 'ready' ? 'unreachable' : data.t3],
    editable: known && seats.length >= 2,
    canReset: known && !!setup,
  };
}

/* The editor's draft ------------------------------------------------------------------------------------------------ */

/** The draft the editor opens on: T3 Code's council's seats, with the person's rounds and score else the usual ones. */
export function councilDraftFor(data: CouncilSetupResponse): CouncilDraft {
  return councilDraft(data.setup, data.automatic);
}

/** Whether two drafts would save the same council (the editor has unsaved changes when they don't). */
export function sameCouncilDraft(a: CouncilDraft, b: CouncilDraft): boolean {
  return (
    a.builder === b.builder &&
    a.rounds === b.rounds &&
    a.target === b.target &&
    a.seats.length === b.seats.length &&
    a.seats.every((s, i) => {
      const o = b.seats[i];
      return !!o && s.provider === o.provider && s.model === o.model && s.effort === o.effort;
    })
  );
}

/** What Save sends: the rounds and score, with T3 Code's seats and the builder as they came. */
export function councilDraftBody(draft: CouncilDraft): SaveCouncilSetupBody {
  return {
    seats: draft.seats.map((s) => ({ provider: s.provider, model: s.model, effort: s.effort })),
    builder: draft.builder,
    rounds: draft.rounds,
    target: draft.target,
  };
}

/** What keeps it from being saved (Save is off while there is something). */
export function councilDraftCheck(draft: CouncilDraft): { problem: string | null } {
  return { problem: councilSetupProblem(draft) };
}

/**
 * Save is there to press: nothing keeps the council from being saved, and either it changed or none is set yet (saving
 * the usual rounds and score as they are makes them the person's).
 */
export function councilCanSave(draft: CouncilDraft, original: CouncilDraft, set: boolean): boolean {
  return !councilDraftCheck(draft).problem && (!set || !sameCouncilDraft(draft, original));
}

/* The editor's choices ---------------------------------------------------------------------------------------------- */

/** A choice the editor shows as a row — what it's called, what is chosen — that opens the app's menu of the rest. */
export interface CouncilPicker {
  label: string;
  value: string;
  /** iOS's own menu, else a sheet: the chosen one ticked. A pick comes back as the item's id. */
  menu: NativeMenuSpec;
  /** There is something to choose. */
  enabled: boolean;
  /** For screen readers: “Score to reach: 9/10”. */
  spoken: string;
}

const menuOf = (items: NativeMenuItem[]): NativeMenuSpec => ({
  title: null,
  reactions: null,
  more: null,
  sections: [items],
});

/** The scores a council may have to reach: 7 to 10 in halves. */
export const COUNCIL_TARGETS: readonly number[] = [7, 7.5, 8, 8.5, 9, 9.5, 10];

/** “Score to reach”, 7…10 in halves (one saved outside them still shows, ticked). */
export function councilTargetPicker(draft: CouncilDraft): CouncilPicker {
  const targets = COUNCIL_TARGETS.includes(draft.target)
    ? COUNCIL_TARGETS
    : [...COUNCIL_TARGETS, draft.target].sort((a, b) => a - b);
  const value = COUNCIL_SETUP_WORDS.score(draft.target);
  return {
    label: COUNCIL_SETUP_WORDS.target,
    value,
    menu: menuOf(
      targets.map((t) => ({
        id: String(t),
        title: COUNCIL_SETUP_WORDS.score(t),
        checked: t === draft.target,
      })),
    ),
    enabled: true,
    spoken: `${COUNCIL_SETUP_WORDS.target}: ${value}`,
  };
}

/** “Rounds”, 1 to 5, as the segmented control's choices. */
export const COUNCIL_ROUND_CHOICES: readonly { value: string; label: string }[] = Array.from(
  { length: COUNCIL_ROUNDS_ASKED_MAX },
  (_, i) => ({ value: String(i + 1), label: String(i + 1) }),
);
