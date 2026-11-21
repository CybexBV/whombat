/**
 * A delegation (Whombat docs/decisions/delegate.md): a list of tasks the agent offers to hand to T3 Code, each in a
 * thread, worktree and branch of its own. The person ticks the tasks they want on the `delegation` card and hands them
 * over; the same card then shows each task's progress until all of them ended, with the agent's words under it. The
 * person can talk about the card in its thread at any time, and the agent changes it (`delegate_update`). Server-made
 * only, never `PostableCard`; the same shape is stored, and the server updates it in place.
 */
import { z } from 'zod';
import { DelegationId, DelegationTaskId } from '../ids.js';
import { Timestamp } from './common.js';
import { CouncilShot } from './council.js';

/**
 * Where a delegation is: `offer` (the checklist waits for the person), `working` (tasks are handed over), or how it
 * ended: `done` (every task ended), `stopped` (the person stopped it, or it was never handed over).
 */
export const DELEGATION_STAGES = ['offer', 'working', 'done', 'stopped'] as const;
export const DelegationStage = z.enum(DELEGATION_STAGES);
export type DelegationStage = z.infer<typeof DelegationStage>;

/**
 * A task: `offered` (on the checklist, not handed over yet), `skipped` (not ticked when the rest were handed over),
 * `queued` (handed over, waiting for its turn or for the task it comes after), `working` (its T3 Code thread works),
 * `done` (its thread finished), `failed`, `stopped`, `timed_out` (it ran out of time and was stopped).
 */
export const DELEGATION_TASK_STATES = [
  'offered',
  'skipped',
  'queued',
  'working',
  'done',
  'failed',
  'stopped',
  'timed_out',
] as const;
export const DelegationTaskState = z.enum(DELEGATION_TASK_STATES);
export type DelegationTaskState = z.infer<typeof DelegationTaskState>;

/**
 * Where a done task's pull request is when Whombat merges them: `waiting` for its turn (one at a
 * time), `merging` (its thread brings it up to date, gets its checks to pass and merges it), `merged`, or `not_merged`
 * (that didn't work, or it needs a person). Absent or null: nothing of it is merged by Whombat.
 */
export const DELEGATION_TASK_MERGES = ['waiting', 'merging', 'merged', 'not_merged'] as const;
export const DelegationTaskMerge = z.enum(DELEGATION_TASK_MERGES);
export type DelegationTaskMerge = z.infer<typeof DelegationTaskMerge>;

/** How a delegation ended: every task done, some didn't finish, or someone stopped it. */
export const DelegationOutcome = z.enum(['done', 'incomplete', 'stopped']);
export type DelegationOutcome = z.infer<typeof DelegationOutcome>;

/**
 * Where a task's pull request checks are (delegate.md DLG-20, DLG-21): `running` (its thread waits for them, holding no
 * place), `passing`, `none` (the repository runs none on pull requests) or `failing` (still red after its fixes).
 */
export const DELEGATION_TASK_CHECKS = ['running', 'passing', 'none', 'failing'] as const;
export const DelegationTaskChecks = z.enum(DELEGATION_TASK_CHECKS);
export type DelegationTaskChecks = z.infer<typeof DelegationTaskChecks>;

/** What a working task waits for: a question to the agent, or the person's OK in T3 Code. */
export const DelegationTaskPending = z.enum(['question', 'approval']);
export type DelegationTaskPending = z.infer<typeof DelegationTaskPending>;

/** At most this many ordinary tasks may be offered. */
export const DELEGATION_TASKS_MAX = 12;
/** A full checklist also carries Whombat's final integration check. */
export const DELEGATION_CARD_TASKS_MAX = DELEGATION_TASKS_MAX + 1;
/** Tasks at work at once unless the person says otherwise, and the most. */
export const DELEGATION_AT_ONCE_DEFAULT = 3;
export const DELEGATION_AT_ONCE_MAX = 6;
/** The longest title, reason, brief, note and summary Whombat keeps. */
export const DELEGATION_TITLE_MAX = 120;
export const DELEGATION_TASK_TITLE_MAX = 120;
export const DELEGATION_WHY_MAX = 200;
export const DELEGATION_BRIEF_MAX = 6000;
export const DELEGATION_TASK_NOTE_MAX = 300;
/** The longest of a lead thread's latest words the card shows. */
export const DELEGATION_SAID_MAX = 200;
export const DELEGATION_NOTE_MAX = 1200;
export const DELEGATION_SUMMARY_MAX = 4000;
/** The changes a Tasks card names at most, and how long each may be. */
export const DELEGATION_CHANGES_MAX = 4;
export const DELEGATION_CHANGE_WORDS_MAX = 160;
export const DELEGATION_ANSWER_MAX = 8000;
/** The rules every task of one card follows (DLG-24), and the parts each task names that it changes. */
export const DELEGATION_RULES_MAX = 2000;
export const DELEGATION_AREAS_MAX = 8;
export const DELEGATION_AREA_MAX = 160;
/** Screens with pictures per task (DLG-27). */
export const DELEGATION_TASK_SHOTS_MAX = 6;

/**
 * The AI a task runs with in T3 Code, as the person chose it on the card (or the agent named it): T3 Code's provider
 * instance and model, the model's name, its effort (one of the model's values; null: the model's own) and its fast tier
 * (on or off; null: the model's own, or it has none). A Whombat sends only what was chosen; the rest is T3 Code's.
 */
export const DelegationAi = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(80),
  /** “Claude Opus 5.5”. */
  label: z.string().min(1).max(60),
  effort: z.string().min(1).max(20).nullable(),
  fast: z.boolean().nullable(),
});
export type DelegationAi = z.infer<typeof DelegationAi>;

/** One task as the card shows it. `n` is its number on the card (1…), which the person and the agent use. */
export const DelegationCardTask = z.object({
  id: DelegationTaskId,
  n: z.number().int().min(1).max(99),
  title: z.string().min(1).max(DELEGATION_TASK_TITLE_MAX),
  /** Why it is worth doing, in a line; null: none given. */
  why: z.string().max(DELEGATION_WHY_MAX).nullable(),
  /** Ticked on the checklist (the offer), or handed over. */
  picked: z.boolean(),
  /** The number of the task it starts after, on that task's branch; null: it starts by itself. */
  after: z.number().int().min(1).max(99).nullable(),
  state: DelegationTaskState,
  /** What a working task waits for, or null. */
  pending: DelegationTaskPending.nullable(),
  /** What it does now, in plain words (“Running the tests”); null when not at work. */
  step: z.string().max(120).nullable(),
  /**
   * The latest words of the thread that leads it and other tasks (“The reconciler split is ready.”), on the first
   * task of that thread while it works; null or absent: none, or an older box.
   */
  said: z.string().max(DELEGATION_SAID_MAX).nullable().optional(),
  /**
   * Its thread said it finished this task while the thread works on the others (`Item 3 done: …`); absent: not yet,
   * or an older box. The line itself is its `note` until the thread's answer gives the last one.
   */
  reported: z.boolean().optional(),
  /** The AI that works on it (“Claude”, “Codex”), once it started; null: T3 Code's default before it said. */
  program: z.string().max(60).nullable(),
  /**
   * The AI chosen for this task alone (by the person on the card, or named by the agent); null: the card's `ai`, else
   * T3 Code's default. Absent: an older box, where the card can't choose.
   */
  ai: DelegationAi.nullable().optional(),
  since: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  /** Its thread in T3 Code. */
  url: z.string().max(2000).nullable(),
  branch: z.string().max(300).nullable(),
  /** Its pull request's page, once it opened one. */
  pr: z.string().max(500).nullable(),
  /** The agent's line about how it went (“The buttons are taller now.”); null: none yet. */
  note: z.string().max(DELEGATION_TASK_NOTE_MAX).nullable(),
  /** Where its pull request is when Whombat merges it; null or absent (an older box): not merged by Whombat. */
  merge: DelegationTaskMerge.nullable().optional(),
  /** Where its pull request's checks are; null or absent: not known (no pull request yet, or an older box). */
  checks: DelegationTaskChecks.nullable().optional(),
  /** Pictures of what it changed people can see, before and after (DLG-27); absent: none. */
  shots: z.array(CouncilShot).max(DELEGATION_TASK_SHOTS_MAX).optional(),
});
export type DelegationCardTask = z.infer<typeof DelegationCardTask>;

/**
 * The `delegation` card. The message's words are the agent's intro above the card; `note` shows under the card:
 * Whombat's short status (the agent's own words are replies under it; on older cards its latest words or summary).
 */
export const DelegationCard = z.object({
  kind: z.literal('delegation'),
  delegationId: DelegationId,
  /** What the tasks are for, in the agent's words (“Polish the Settings page”). */
  title: z.string().min(1).max(DELEGATION_TITLE_MAX),
  /** The T3 Code project they run in; null: in scratch folders. */
  project: z.string().max(200).nullable(),
  stage: DelegationStage,
  live: z.boolean(),
  /** How many tasks work at once. */
  atOnce: z.number().int().min(1).max(DELEGATION_AT_ONCE_MAX),
  /** Whether each task opens a pull request when it is done. */
  pullRequests: z.boolean(),
  /** Whether Whombat merges each one's pull request, one at a time, once its work is done; absent: an older box, no. */
  merge: z.boolean().optional(),
  /** It carries out a council's plan (council.md CNL-60): the council's card above it says how it went. */
  council: z.boolean().optional(),
  /**
   * The AI for every task without a choice of its own; null: T3 Code's default. Absent: an older box, where the card
   * can't choose (no AI buttons show).
   */
  ai: DelegationAi.nullable().optional(),
  tasks: z.array(DelegationCardTask).max(DELEGATION_CARD_TASKS_MAX),
  outcome: DelegationOutcome.nullable(),
  /** The agent's latest words, then its summary, shown under the card as its words. */
  note: z.string().max(DELEGATION_SUMMARY_MAX).nullable(),
  /**
   * What the last change to the offered list did, while it waits for Hand over (Whombat delegate.md): when and, in a
   * few words each, the tasks added, taken off, renamed or moved (“Took off “A search box””). Absent or null: no change
   * since it was offered, or it was handed over.
   */
  changed: z
    .object({
      at: Timestamp,
      said: z.array(z.string().min(1).max(DELEGATION_CHANGE_WORDS_MAX)).min(1).max(DELEGATION_CHANGES_MAX),
    })
    .nullable()
    .optional(),
  /**
   * A council in its thread is checking this offered list now (Whombat delegate.md): Hand over waits for its answer.
   * Absent or false otherwise.
   */
  checking: z.boolean().optional(),
  startedAt: Timestamp,
  /** When the tasks were handed over; null while the checklist waits. */
  handedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
});
export type DelegationCard = z.infer<typeof DelegationCard>;
