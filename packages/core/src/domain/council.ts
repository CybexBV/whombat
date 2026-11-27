/**
 * The council (Whombat council.md): a question or a goal the agent puts to several AI models of different providers,
 * each working on its own, in a Chat thread. Whombat keeps it and shows it as the `council` card: one live card while it
 * works (each member's provider mark, its state and score, the agent's latest thoughts as the message's words), and the
 * final card under the agent's conclusion (every round's scores, the plan, the pictures of what changed with their
 * notes). Server-made only, never `PostableCard`; the same shape is stored, and the server updates it in place.
 */
import { z } from 'zod';
import { coreTranslator } from '../i18n/catalog.js';
import { AttachmentId, CouncilId, CouncilMemberId } from '../ids.js';
import { Timestamp } from './common.js';

/**
 * What a council does (CNL-02): `review` (one round of reviews with scores), `research` (research, one answer the
 * members agree on), `improve` (look, one plan they agree on, its tasks handed to T3 Code on a checklist card, checks
 * of the result until the target score, CNL-60, CNL-61).
 */
export const COUNCIL_KINDS = ['review', 'research', 'improve'] as const;
export const CouncilKind = z.enum(COUNCIL_KINDS);
export type CouncilKind = z.infer<typeof CouncilKind>;

/**
 * Where a council is: `research` (the first round: each member looks, researches or reviews), `agree` (they judge the
 * agent's plan), `approve` (its plan's tasks wait on its checklist card for the person's Hand over, the go-ahead,
 * CNL-68; on a box from before CNL-60, a plan that waited for a Go ahead), `build` (its tasks were handed over to T3
 * Code), `check` (they judge the result), or how it ended: `done`, `stopped`.
 */
export const COUNCIL_STAGES = ['research', 'agree', 'approve', 'build', 'check', 'done', 'stopped'] as const;
export const CouncilStage = z.enum(COUNCIL_STAGES);
export type CouncilStage = z.infer<typeof CouncilStage>;

/** The stages a round of members runs in. */
export const COUNCIL_ROUND_STAGES = ['research', 'agree', 'check'] as const;
export const CouncilRoundStage = z.enum(COUNCIL_ROUND_STAGES);
export type CouncilRoundStage = z.infer<typeof CouncilRoundStage>;

/** A member's thread: at work, answered, failed, ran out of time without an answer (CNL-14), or stopped. */
export const COUNCIL_MEMBER_STATES = ['working', 'done', 'failed', 'no_answer', 'stopped'] as const;
export const CouncilMemberState = z.enum(COUNCIL_MEMBER_STATES);
export type CouncilMemberState = z.infer<typeof CouncilMemberState>;

/** A member's judgment of a plan or a result (CNL-11): it agrees, or it has must-fix items. */
export const CouncilVerdict = z.enum(['agree', 'changes']);
export type CouncilVerdict = z.infer<typeof CouncilVerdict>;

/** How a council ended: every member answered (`done`), some didn't (`incomplete`), or someone stopped it. */
export const CouncilOutcome = z.enum(['done', 'incomplete', 'stopped']);
export type CouncilOutcome = z.infer<typeof CouncilOutcome>;

/** The brand marks a member's provider shows with (CNL-44); any other provider shows its first letter. */
export const CouncilMark = z.enum(['claude', 'openai']);
export type CouncilMark = z.infer<typeof CouncilMark>;

/** At most this many members in a round (CNL-04). */
export const COUNCIL_MEMBERS_MAX = 4;
/** At least this many providers make a council. */
export const COUNCIL_PROVIDERS_MIN = 2;
/** Rounds to agree and rounds to check, each (CNL-12); the person may ask for up to `COUNCIL_ROUNDS_ASKED_MAX`. */
export const COUNCIL_ROUNDS_DEFAULT = 3;
export const COUNCIL_ROUNDS_ASKED_MAX = 5;
/** The longest question, plan, note and answer Whombat keeps. */
export const COUNCIL_QUESTION_MAX = 4000;
export const COUNCIL_PLAN_MAX = 8000;
export const COUNCIL_NOTE_MAX = 1200;
export const COUNCIL_SUMMARY_MAX = 4000;
export const COUNCIL_ANSWER_MAX = 12_000;
/** How much of a member's answer its row on the card opens to (CNL-64). */
export const COUNCIL_CARD_ANSWER_MAX = 6000;
export const COUNCIL_TITLE_MAX = 120;
/** Screens with pictures, and numbered areas per screen (CNL-31, CNL-32). */
export const COUNCIL_SHOTS_MAX = 12;
export const COUNCIL_AREAS_MAX = 9;
export const COUNCIL_SHOT_NOTE_MAX = 300;
/** The earlier rounds the card keeps. */
export const COUNCIL_HISTORY_MAX = 14;

/** A score out of 10, in halves. */
export const CouncilScore = z.number().min(0).max(10).multipleOf(0.5);

/** One member of the round, or the builder, as the card shows it. */
export const CouncilCardMember = z.object({
  id: CouncilMemberId,
  /** The model's name (“Claude Opus 5.5”, “GPT 6.1 Sol”). */
  name: z.string().min(1).max(60),
  /** The provider's name in T3 Code (“Claude”, “Codex”, “Muse Code”). */
  provider: z.string().min(1).max(40),
  mark: CouncilMark.nullable(),
  role: z.enum(['member', 'builder']),
  state: CouncilMemberState,
  score: CouncilScore.nullable(),
  verdict: CouncilVerdict.nullable(),
  since: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  /** What the builder does now, in plain words (“Changing Settings.tsx”); null for members. */
  step: z.string().max(120).nullable(),
  /** Its thread in T3 Code. */
  url: z.string().max(2000).nullable(),
  /** Its answer, for the person to read on the card (CNL-64); absent or null: none (yet), or an older box. */
  answer: z.string().max(COUNCIL_CARD_ANSWER_MAX).nullable().optional(),
  /**
   * A seat whose reviewer hasn't started in this round yet (`state` `working`, no `since`): every seat sits at the table
   * from the start. Absent on a card from before it.
   */
  waiting: z.boolean().optional(),
});
export type CouncilCardMember = z.infer<typeof CouncilCardMember>;

/** One finished round as the card keeps it: each member's score and verdict. */
export const CouncilRoundResult = z.object({
  stage: CouncilRoundStage,
  round: z.number().int().min(1).max(10),
  members: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        mark: CouncilMark.nullable(),
        provider: z.string().min(1).max(40),
        state: CouncilMemberState,
        score: CouncilScore.nullable(),
        verdict: CouncilVerdict.nullable(),
      }),
    )
    .max(COUNCIL_MEMBERS_MAX),
});
export type CouncilRoundResult = z.infer<typeof CouncilRoundResult>;

/** One numbered area of what changed on a screen, with its note in plain words. */
export const CouncilShotNote = z.object({
  n: z.number().int().min(1).max(COUNCIL_AREAS_MAX),
  text: z.string().min(1).max(COUNCIL_SHOT_NOTE_MAX),
});
export type CouncilShotNote = z.infer<typeof CouncilShotNote>;

/** A screen that changed (CNL-33): one picture, before on top and after below, its areas numbered, and the notes. */
export const CouncilShot = z.object({
  /** The screen's name (“Settings · light”). */
  view: z.string().min(1).max(80),
  attachmentId: AttachmentId,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** How many areas changed (numbered 1…n on the picture). */
  areas: z.number().int().min(0).max(COUNCIL_AREAS_MAX),
  notes: z.array(CouncilShotNote).max(COUNCIL_AREAS_MAX),
});
export type CouncilShot = z.infer<typeof CouncilShot>;

/**
 * The `council` card (CNL-40, CNL-42). The message's words are what the agent asked the council, above the card; `note`
 * shows under the card: Whombat's short status (the agent's thoughts and conclusion are replies under it; on older cards
 * its latest thoughts or conclusion). `members` the current round's members and the
 * builder; `history` the rounds before; `plan` the plan the members judge (shown with Go ahead and Change something while
 * `stage` is `approve`); `shots` the pictures of what changed (CNL-33).
 */
export const CouncilCard = z.object({
  kind: z.literal('council'),
  councilId: CouncilId,
  what: CouncilKind,
  /** What the council is about, in the agent's words (“Improve the Settings page”). */
  title: z.string().min(1).max(COUNCIL_TITLE_MAX),
  stage: CouncilStage,
  /** The round of the stage (1 while it has none). */
  round: z.number().int().min(1).max(10),
  /** The most rounds to agree, and to check. */
  roundsMax: z.number().int().min(1).max(COUNCIL_ROUNDS_ASKED_MAX),
  /** The score every member must give the result (`improve`), or null. */
  target: CouncilScore.nullable(),
  live: z.boolean(),
  members: z.array(CouncilCardMember).max(COUNCIL_MEMBERS_MAX + 1),
  history: z.array(CouncilRoundResult).max(COUNCIL_HISTORY_MAX),
  plan: z.string().max(COUNCIL_PLAN_MAX).nullable(),
  shots: z.array(CouncilShot).max(COUNCIL_SHOTS_MAX),
  outcome: CouncilOutcome.nullable(),
  /** The agent's latest thoughts, then its conclusion, shown under the card as its words. A box from before it: none. */
  note: z.string().max(COUNCIL_SUMMARY_MAX).nullish(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type CouncilCard = z.infer<typeof CouncilCard>;

/* The person's council ---------------------------------------------------------------------------------------------- */

/**
 * One seat of the person's council (Whombat council.md CNL-50): a provider T3 Code runs (its instance id, “codex”,
 * “claudeAgent”), its model and the effort the model runs at (one of the model's own values; null: its default).
 */
export const CouncilSeatSetup = z.object({
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(80),
  effort: z.string().trim().min(1).max(20).nullable(),
  /**
   * The company's and the model's names as T3 Code last gave them (kept by Whombat when the council is saved), so the
   * council reads in words while T3 Code can't be asked; anything a client sends here is ignored.
   */
  providerName: z.string().max(40).nullable().optional(),
  modelLabel: z.string().max(60).nullable().optional(),
});
export type CouncilSeatSetup = z.infer<typeof CouncilSeatSetup>;

/**
 * The person's council (CNL-50…CNL-54): one per Whombat, its seats in order, the seat that builds, the most rounds to
 * agree and to check, and the score to reach. None set: Whombat's own seats (CNL-04).
 */
export const CouncilSetup = z.object({
  seats: z.array(CouncilSeatSetup).min(2).max(COUNCIL_MEMBERS_MAX),
  builder: z
    .number()
    .int()
    .min(0)
    .max(COUNCIL_MEMBERS_MAX - 1),
  rounds: z.number().int().min(1).max(COUNCIL_ROUNDS_ASKED_MAX),
  target: CouncilScore,
  updatedAt: Timestamp,
});
export type CouncilSetup = z.infer<typeof CouncilSetup>;

/** What T3 Code can run now, for choosing seats: each provider with its models and the efforts each takes. */
export const CouncilProviderOption = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(40),
  models: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        label: z.string().min(1).max(60),
        efforts: z.array(z.string().min(1).max(20)).max(12),
        /** The effort it runs at unless one is chosen (the model's own default); null: it has no effort. */
        defaultEffort: z.string().min(1).max(20).nullable(),
        /**
         * It has a fast tier (Codex's priority service tier, Claude's fast mode), and whether that is on unless chosen;
         * null or absent: it has none (or an older box didn't say).
         */
        fast: z.boolean().nullable().optional(),
      }),
    )
    .max(30),
});
export type CouncilProviderOption = z.infer<typeof CouncilProviderOption>;

/** Whether a council's seats are the person's choice the rules allow: 2–4 seats, two different providers at least. */
export function councilSeatsProblem(
  seats: readonly Pick<CouncilSeatSetup, 'provider' | 'model'>[],
  locale?: string | null,
): string | null {
  const tr = coreTranslator(locale);
  if (seats.length < 2) return tr.t('councilSeats.tooFew');
  if (seats.length > COUNCIL_MEMBERS_MAX) return tr.t('councilSeats.tooMany', { max: COUNCIL_MEMBERS_MAX });
  if (new Set(seats.map((s) => s.provider)).size < 2) return tr.t('councilSeats.oneCompany');
  const keys = seats.map((s) => `${s.provider}\n${s.model}`);
  if (new Set(keys).size !== keys.length) return tr.t('councilSeats.twice');
  return null;
}

/** Whether a council has two seats of one provider: allowed, but they think alike. */
export function councilSharesProvider(seats: readonly Pick<CouncilSeatSetup, 'provider'>[]): boolean {
  return new Set(seats.map((s) => s.provider)).size < seats.length;
}
