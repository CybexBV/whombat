/**
 * Needs you with what needs a look (Whombat desk-display.md DK-93…DK-96, quiet-notices.md QN-20; appliance CG-310…,
 * CG-330…): the rows in their order, the assistant's line that speaks only while something needs the person, the words a
 * look's card and *Ask {assistant} to look into it* use, which buttons a look's card has, and *Ignore* and *Not now*'s
 * request and answer; since 3.5 (Whombat look-research.md, CG-374…) what the assistant found out and its step. Pure.
 */

import { english, type Translate } from '../i18n/translate';
import { type DeskAsk, type DeskGlance, type DeskLook, deskErrorCode, type LookQuietHow } from './desk';
import { deskCopy, deskWordsCopy, fill } from './deskCopy';

/** One row of Needs you: an ask, or something that needs a look. */
export type NeedRow = { kind: 'ask'; ask: DeskAsk } | { kind: 'look'; look: DeskLook };

const looksOf = (g: DeskGlance): DeskLook[] => g.needsYou.looks ?? [];

/** Everything that needs the person: the asks (the shown ones and the ones a locked screen only counts) and the looks. */
export const needsTotal = (g: DeskGlance): number => g.needsYou.count + looksOf(g).length;

/** The rows in their order (DK-93): what is down first, then the asks, then the rest of what needs a look. */
export function needRows(g: DeskGlance): NeedRow[] {
  const looks = looksOf(g);
  const row = (look: DeskLook): NeedRow => ({ kind: 'look', look });
  return [
    ...looks.filter((l) => l.state === 'down').map(row),
    ...g.needsYou.items.map((ask): NeedRow => ({ kind: 'ask', ask })),
    ...looks.filter((l) => l.state !== 'down').map(row),
  ];
}

/** “pve-02 is down.”, “Home Assistant needs a look.” */
export const lookTitle = (l: DeskLook, t: Translate = english): string => {
  const DESK_WORDS = deskWordsCopy(t);
  return fill(l.state === 'down' ? DESK_WORDS.status.down : DESK_WORDS.status.look, { server: l.name });
};

/** A reason as a sentence on the card: with its full stop. */
export const lookDetail = (l: DeskLook): string | null =>
  l.reason ? (/[.!?…]$/.test(l.reason) ? l.reason : `${l.reason}.`) : null;

/**
 * What *Ask {assistant} to look into it* sends as the person's words: the line's own question (QN-20), else DK-96's
 * “Please take a look at {name}: {reason}.”; at most a question's 500.
 */
export function lookQuestion(l: DeskLook, t: Translate = english): string {
  const DESK_WORDS = deskWordsCopy(t);

  if (l.question) return l.question.slice(0, 500);
  const reason = l.reason?.replace(/[.\s]+$/, '');
  const words = reason
    ? fill(DESK_WORDS.looks.question, { name: l.name, reason })
    : fill(DESK_WORDS.looks.questionBare, { name: l.name });
  return words.slice(0, 500);
}

/**
 * Where the assistant is with a look, as the screens draw it (Whombat look-research.md LR-09, CG-374): finding out,
 * said what is wrong, taking the step, fixed it; none without research or once it `failed` (the look as before).
 */
export type LookStage = 'looking' | 'found' | 'fixing' | 'fixed';

export function lookStage(l: DeskLook | undefined): LookStage | null {
  const s = l?.research?.state;
  return s && s !== 'failed' ? s : null;
}

/** The one step the assistant offers (LR-07), its button's label: only once it found what is wrong. */
export const lookStep = (l: DeskLook): string | null =>
  (l.research?.state === 'found' && l.research.fix) || null;

/** A look's title: the assistant's once it found out (“Zigbee stopped working in Home Assistant”), else the usual. */
export function researchTitle(l: DeskLook, t: Translate = english): string {
  const stage = lookStage(l);
  return stage && stage !== 'looking' && l.research?.title ? l.research.title : lookTitle(l, t);
}

/**
 * What the assistant says beside its face about a look it looked into (LR-09, CG-374): while looking “I’m looking into
 * it.” with the reason so far, while taking the step “I’m on it.”, else its summary (or `fallback`, what the screen
 * said before).
 */
export function researchSays(
  l: DeskLook | undefined,
  stage: LookStage,
  fallback: string | null,
  t: Translate = english,
): string {
  const DESK_WORDS = deskWordsCopy(t);

  if (stage === 'looking') {
    const reason = l?.reason?.replace(/[.\s]+$/, '');
    return reason ? fill(DESK_WORDS.looks.lookingSoFar, { reason }) : DESK_WORDS.looks.looking;
  }
  if (stage === 'fixing') return DESK_WORDS.looks.fixing;
  return l?.research?.summary ?? fallback ?? DESK_WORDS.looks.noReason;
}

/**
 * What a look's card offers (QN-20, CG-333): *Ask {assistant} to look into it* for a problem (a look without a nature is
 * one), never for what only a person can do; *Ignore* and *Not now* when the look says which line it comes from (a
 * runtime from before 0.122 doesn't: then the card is 0.118's, with *Close*). A look the assistant looked into (LR-09,
 * CG-375): while looking *Ignore* and *Not now*; once found the step it offers first (`step`), *Ignore*, *Not now* and
 * *Ask {assistant}* (`ask`); while it takes the step and once fixed only *Close*.
 */
export function lookActions(l: DeskLook): {
  fix: boolean;
  quiet: boolean;
  step: string | null;
  ask: boolean;
} {
  const quiet = l.notice !== undefined;
  switch (lookStage(l)) {
    case null:
      return { fix: l.nature !== 'you', quiet, step: null, ask: false };
    case 'looking':
      return { fix: false, quiet, step: null, ask: false };
    case 'found':
      return { fix: false, quiet, step: lookStep(l), ask: true };
    default:
      return { fix: false, quiet: false, step: null, ask: false };
  }
}

/** The page's body for `/api/desk/look/quiet` (CG-331): the look's key and its line as they came, and how; none without a line. */
export function lookQuietBody(
  l: DeskLook,
  how: LookQuietHow,
): { key: string; notice: { check: string; subject?: string }; how: LookQuietHow } | null {
  if (!l.notice) return null;
  const { check, subject } = l.notice;
  return { key: l.key, notice: subject === undefined ? { check } : { check, subject }, how };
}

/**
 * Whombat's answer to *Ignore* or *Not now* (CG-334): done; `locked` (the screen locked meanwhile: the PIN again);
 * `notAllowed` (the paired person may not manage the thing); `gone` (the look or its line went meanwhile); else
 * `failed` (no answer, Whombat away, anything else).
 */
export type QuietAnswer = 'quieted' | 'locked' | 'notAllowed' | 'gone' | 'failed';

export function parseQuietAnswer(status: number, body: unknown): QuietAnswer {
  if (status === 200) return 'quieted';
  const code = deskErrorCode(body);
  if (status === 409 && code === 'locked') return 'locked';
  if (status === 403 && code === 'not_allowed') return 'notAllowed';
  if (status === 404 && code === 'not_found') return 'gone';
  return 'failed';
}

/**
 * Whombat's answer to the step's button (`/api/desk/look/fix`, CG-376): `taken` (the assistant takes it now), or a
 * refusal as Ignore's: the PIN again, the person may not manage it, the step went meanwhile, anything else.
 */
export type StepAnswer = 'taken' | Exclude<QuietAnswer, 'quieted'>;

export function parseStepAnswer(status: number, body: unknown): StepAnswer {
  const a = parseQuietAnswer(status, body);
  return a === 'quieted' ? 'taken' : a;
}

/** How long a taken step's button waits for the state to say the assistant is on it before it may be pressed again. */
export const STEP_WAIT_MS = 10_000;

/** What the card says after Ignore or Not now (QN-20), before it closes. */
export const quietDone = (how: LookQuietHow, t: Translate = english): string => {
  const DESK_WORDS = deskWordsCopy(t);
  return how === 'ignore' ? DESK_WORDS.looks.ignored : DESK_WORDS.looks.snoozed;
};

/** How long the card shows that before it closes (CG-334). */
export const QUIET_DONE_MS = 2500;

/** A refusal in plain words on the card (CG-334, CG-376); `locked` says nothing: the PIN pad says it. */
export function quietRefusal(
  a: QuietAnswer | StepAnswer,
  name: string,
  t: Translate = english,
): string | null {
  const DESK = deskCopy(t);
  const DESK_WORDS = deskWordsCopy(t);

  if (a === 'notAllowed') return fill(DESK.lookNotAllowed, { name });
  if (a === 'gone') return DESK.lookChanged;
  if (a === 'failed') return DESK_WORDS.talkFailed;
  return null;
}

/** The assistant's line (DK-94): the first thing that needs the person, and what touching it opens. */
export interface AssistantLine {
  text: string;
  more: string | null;
  /** The row it opens; null: asks a locked screen only counts (the PIN pad, then the first ask). */
  opens: NeedRow | null;
}

/**
 * The line while something needs the person, else none: a look's title with the offer to look into it, an ask's “{title}
 * needs a decision.” with “Touch to answer”, or on a locked screen without titles how many things need the person.
 */
export function assistantLine(g: DeskGlance | null, t: Translate = english): AssistantLine | null {
  const DESK_WORDS = deskWordsCopy(t);
  const DESK = deskCopy(t);

  if (!g || needsTotal(g) === 0) return null;
  const first = needRows(g)[0];
  const s = DESK_WORDS.status;
  // Only a person can do it (QN-02): the assistant doesn't offer to look into it. Looking into it already (LR-09): it
  // says where it is, or its own title once it found out.
  if (first?.kind === 'look') {
    const stage = lookStage(first.look);
    const more =
      stage === 'looking'
        ? DESK_WORDS.looks.looking
        : stage === 'fixing'
          ? DESK_WORDS.looks.fixing
          : stage
            ? null
            : lookActions(first.look).fix
              ? DESK_WORDS.looks.offer
              : DESK.youOffer;
    return { text: researchTitle(first.look, t), more, opens: first };
  }
  if (first?.kind === 'ask') {
    const about = first.ask.title.trim().replace(/[?.]+$/, '');
    return { text: fill(s.decision, { title: about }), more: DESK_WORDS.touchToAnswer, opens: first };
  }
  const n = g.needsYou.count;
  return {
    text: n === 1 ? s.needsYouOne : fill(s.needsYouMany, { n }),
    more: DESK_WORDS.touchToAnswer,
    opens: null,
  };
}
