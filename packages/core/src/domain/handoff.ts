/**
 * Work the agent handed to another program and is waiting for (Whombat t3code.md T3-24…T3-28, app t3code-handoff.md):
 * a T3 Code thread it started, sent a message or answered from a Whombat thread, until the result came back. The thread's
 * reply row and its end show it, so a thread whose work went on elsewhere doesn't look finished.
 */
import { z } from 'zod';
import { ConversationId, MessageId, PrincipalId } from '../ids.js';
import { Count, Timestamp } from './common.js';

/**
 * Where the handed-over work stands: `working`; `finishing` (its run ended and its after-work still runs); `asked` (it
 * asked the agent a question, which the agent answers); `needs_ok` (it waits for the person's OK in T3 Code, which
 * Whombat can't give); `checks` (its run ended waiting for a pull request's checks or reviews); `ended` (its work is over
 * and the agent hasn't said so yet).
 */
export const HANDOFF_STATES = ['working', 'finishing', 'asked', 'needs_ok', 'checks', 'ended'] as const;
export const HandoffState = z.enum(HANDOFF_STATES);
export type HandoffState = z.infer<typeof HandoffState>;

/** How ended work ended. */
export const HANDOFF_OUTCOMES = ['completed', 'failed', 'stopped'] as const;
export const HandoffOutcome = z.enum(HANDOFF_OUTCOMES);
export type HandoffOutcome = z.infer<typeof HandoffOutcome>;

/** At most this many of its latest steps are shown. */
export const HANDOFF_STEPS_MAX = 5;
/** At most this many hand-overs of one conversation are listed. */
export const HANDOFFS_MAX = 20;

/**
 * One step of the work, in plain words (“Running the tests”), with what T3 Code itself said of it (a command, a file's
 * name) for the folded details only.
 */
export const HandoffStep = z.object({
  text: z.string().min(1).max(120),
  detail: z.string().max(200).nullable(),
  done: z.boolean(),
});
export type HandoffStep = z.infer<typeof HandoffStep>;

/* The job's progress (Whombat docs/decisions/t3code.md T3-30…T3-41) --------------------------------------------------- */

/**
 * The stage track of a job, in order: reading the code, planning, editing, running the tests, a review, opening the pull
 * request, its checks, merged. Read from T3 Code's timeline and the pull request; it only moves forward.
 */
export const HANDOFF_STAGES = [
  'reading',
  'plan',
  'editing',
  'tests',
  'review',
  'pull_request',
  'checks',
  'merged',
] as const;
export const HandoffTrackStage = z.enum(HANDOFF_STAGES);
export type HandoffTrackStage = z.infer<typeof HandoffTrackStage>;

/** Where the job is on the track, or how it ended off the track (`failed`, `stopped`). */
export const HandoffStage = z.enum([...HANDOFF_STAGES, 'failed', 'stopped']);
export type HandoffStage = z.infer<typeof HandoffStage>;

/** When the job reached a stage and when it moved past it (null: it is there now, or it ended there). */
export const HandoffStageTime = z.object({
  stage: HandoffTrackStage,
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type HandoffStageTime = z.infer<typeof HandoffStageTime>;

/** At most this many steps of T3 Code's plan are shown. */
export const HANDOFF_PLAN_MAX = 12;

/** One step of T3 Code's own plan, as its program keeps it: done, the one it is on now, or still to come. */
export const HandoffPlanStep = z.object({
  text: z.string().min(1).max(200),
  state: z.enum(['done', 'now', 'next']),
});
export type HandoffPlanStep = z.infer<typeof HandoffPlanStep>;

/** At most this many changed files are listed (the totals count them all). */
export const HANDOFF_FILES_MAX = 20;

/** What the job changed: its pull request's files, with the totals and the pull request's Files page. */
export const HandoffChanges = z.object({
  files: z
    .array(z.object({ path: z.string().min(1).max(300), additions: Count, deletions: Count }))
    .max(HANDOFF_FILES_MAX),
  fileCount: Count,
  additions: Count,
  deletions: Count,
  /** The pull request's title: the change in one line. */
  summary: z.string().max(200).nullable(),
  /** The pull request's Files page. */
  url: z.string().max(2000).nullable(),
});
export type HandoffChanges = z.infer<typeof HandoffChanges>;

/** At most this many checks are listed. */
export const HANDOFF_CHECKS_MAX = 20;
export const HANDOFF_CHECK_STATES = ['queued', 'running', 'passed', 'failed', 'skipped'] as const;
export const HandoffCheckState = z.enum(HANDOFF_CHECK_STATES);
export type HandoffCheckState = z.infer<typeof HandoffCheckState>;

export const HandoffCheck = z.object({
  name: z.string().min(1).max(200),
  state: HandoffCheckState,
  url: z.string().max(2000).nullable(),
});
export type HandoffCheck = z.infer<typeof HandoffCheck>;

/**
 * The pull request's checks on its latest commit, as GitHub says. `failing`: the first that failed; `attempts`: how many
 * fixes T3 Code pushed since a check first failed (0 before one).
 */
export const HandoffChecks = z.object({
  runs: z.array(HandoffCheck).max(HANDOFF_CHECKS_MAX),
  failing: z.string().max(200).nullable(),
  attempts: Count,
});
export type HandoffChecks = z.infer<typeof HandoffChecks>;

/**
 * A question T3 Code waits on, which the person may answer from the job (`conversations.handoffAnswer`). A permission
 * request is never one: only T3 Code itself approves it (`state` `needs_ok`).
 */
export const HandoffQuestion = z.object({
  requestId: z.string().min(1).max(2000),
  questionId: z.string().min(1).max(200),
  text: z.string().min(1).max(300),
  options: z
    .array(z.object({ label: z.string().min(1).max(200), description: z.string().max(300).nullable() }))
    .max(10),
  multiSelect: z.boolean(),
});
export type HandoffQuestion = z.infer<typeof HandoffQuestion>;

/** The job's pull request, as T3 Code links it. */
export const HandoffPullRequest = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1).max(500),
  state: z.enum(['open', 'draft', 'merged', 'closed']),
});
export type HandoffPullRequest = z.infer<typeof HandoffPullRequest>;

/**
 * What the job came to, once it ended: its answer's first sentence, how its last tests went, how long it took. The whole
 * answer is the hand-over's `answer`.
 */
export const HandoffReceipt = z.object({
  summary: z.string().max(300).nullable(),
  tests: z.enum(['passed', 'failed']).nullable(),
  durationMs: Count.nullable(),
  /** A picture the job left; null when the box can't read one. */
  screenshot: z.object({ url: z.string().min(1).max(2000), alt: z.string().max(200) }).nullable(),
});
export type HandoffReceipt = z.infer<typeof HandoffReceipt>;

/**
 * What a turn's preface calls the T3 Code threads its Whombat thread already handed work to (`t3Handoffs` in the
 * turn's context): an automation step's prompt names the list by these words.
 */
export const T3_HANDOFFS_HEADING = 'T3 Code threads of this thread';

/** The longest final answer of a job the thread keeps to read (the rest is in T3 Code). */
export const HANDOFF_ANSWER_MAX = 6000;

export const Handoff = z.object({
  /** The program's own id of the work (a T3 Code thread id): the key, never shown. */
  id: z.string().min(1).max(300),
  to: z.literal('t3code'),
  conversationId: ConversationId,
  /** The Whombat thread it was handed over from; null: the top of a conversation without threads. */
  rootId: MessageId.nullable(),
  /** The agent that handed it over. */
  agentId: PrincipalId,
  /** Its title in T3 Code (“Dusty - Fix Settle in the Feedback room”). */
  title: z.string().min(1).max(160),
  state: HandoffState,
  /** When its current run started (the clock); null before T3 Code said. */
  since: Timestamp.nullable(),
  /** When its run ended (`checks`, `ended`). */
  endedAt: Timestamp.nullable(),
  outcome: HandoffOutcome.nullable(),
  /** Its latest steps, oldest first; the last not done is what it does now. */
  steps: z.array(HandoffStep).max(HANDOFF_STEPS_MAX),
  /** What its question asks (`asked`) or what the permission it waits for is about (`needs_ok`), as T3 Code says it. */
  asks: z.string().max(300).nullable(),
  /** The pull requests it waits for (`checks`): their addresses, or `#342`. */
  pullRequests: z.array(z.string().min(1).max(500)).max(5),
  /** The AI program and model it runs on (“Codex · gpt-5.5”). */
  program: z.string().max(80).nullable(),
  /** Its page in T3 Code. */
  url: z.string().max(2000).nullable(),
  /*
   * The job's progress (t3code.md T3-30…T3-41). Absent from a Whombat from before them; null or empty where the box can't
   * read it, and then the apps hide that part.
   */
  stage: HandoffStage.nullable().optional(),
  stages: z.array(HandoffStageTime).max(HANDOFF_STAGES.length).optional(),
  plan: z.array(HandoffPlanStep).max(HANDOFF_PLAN_MAX).optional(),
  changes: HandoffChanges.nullable().optional(),
  checks: HandoffChecks.nullable().optional(),
  question: HandoffQuestion.nullable().optional(),
  pullRequest: HandoffPullRequest.nullable().optional(),
  receipt: HandoffReceipt.nullable().optional(),
  /**
   * What T3 Code answered when its run ended, as it wrote it (markdown), for the person to read in the thread; its start
   * when it is longer than `HANDOFF_ANSWER_MAX`. Only on an ended job, each run's end replacing it. Absent from a Whombat
   * from before it; null when the job left none.
   */
  answer: z.string().max(HANDOFF_ANSWER_MAX).nullable().optional(),
  /**
   * The message in the thread that is this job's result (`Message.jobResult`, T3-55), once it ended and Whombat posted
   * one: the apps then draw no receipt or parts for the ended job, the message says it. Absent or null otherwise.
   */
  resultMessageId: MessageId.nullable().optional(),
});
export type Handoff = z.infer<typeof Handoff>;
