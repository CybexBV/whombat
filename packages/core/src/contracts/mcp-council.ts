/**
 * The council's tools for the agent (Whombat docs/decisions/council.md CNL-S04). Spread into `MCP_TOOLS` (`./mcp`);
 * `personal: true`, and served only while a T3 Code connection manages (a council runs as T3 Code threads, CNL-03). Whombat
 * starts one lead thread in T3 Code that runs the council there (its reviewers, its rounds, the fixes), shows its
 * reviewers on the card and wakes the agent when the lead is done (trigger `council`); the agent writes what the council
 * is asked and every word the person reads.
 */
import { z } from 'zod';
import {
  COUNCIL_AREAS_MAX,
  COUNCIL_MEMBERS_MAX,
  COUNCIL_NOTE_MAX,
  COUNCIL_PLAN_MAX,
  COUNCIL_QUESTION_MAX,
  COUNCIL_ROUNDS_ASKED_MAX,
  COUNCIL_SHOT_NOTE_MAX,
  COUNCIL_SHOTS_MAX,
  COUNCIL_SUMMARY_MAX,
  COUNCIL_TITLE_MAX,
  CouncilKind,
  CouncilScore,
} from '../domain/council.js';
import { SUGGESTIONS_MAX, Suggestion } from '../domain/message.js';
import { CouncilId, MessageId } from '../ids.js';
import type { McpTool } from './mcp.js';
import { CouncilDispatchContext } from './runner.js';

const Refused = z.object({
  status: z.literal('refused'),
  reason: z.enum([
    'no_t3',
    'not_enough_providers',
    'no_project',
    'not_found',
    'busy',
    'limit',
    'unavailable',
  ]),
  message: z.string(),
});

export const CouncilStartInput = z.object({
  kind: CouncilKind,
  /** What it is about, in the person's words (“Improve the Settings page”). */
  title: z.string().trim().min(1).max(COUNCIL_TITLE_MAX),
  /** What the council is asked: what to look at, what good looks like. It goes to the lead thread as written. */
  question: z.string().trim().min(1).max(COUNCIL_QUESTION_MAX),
  /** Your words above the card, for the person: what you asked the council, in a sentence or two. */
  intro: z.string().trim().min(1).max(COUNCIL_NOTE_MAX),
  /** The T3 Code project's title, folder or id; none for plain research. */
  project: z.string().trim().min(1).max(300).optional(),
  /** Only when the person named who sits on it this time; else their council. */
  members: z
    .array(
      z.object({
        provider: z.string().trim().min(1).max(40),
        model: z.string().trim().min(1).max(80).optional(),
        effort: z.string().trim().min(1).max(20).optional(),
      }),
    )
    .min(2)
    .max(COUNCIL_MEMBERS_MAX)
    .optional(),
  /** `improve`: the score to reach (default 9). */
  target: CouncilScore.optional(),
  /** Rounds to agree and rounds to check, each (default 3). */
  rounds: z.number().int().min(1).max(COUNCIL_ROUNDS_ASKED_MAX).optional(),
  /** The person said to have it built without asking first: the lead builds the agreed plan at once. */
  goAllTheWay: z.boolean().optional(),
});
export type CouncilStartInput = z.input<typeof CouncilStartInput>;

export const CouncilStartOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('started'),
    councilId: CouncilId,
    members: z.array(z.object({ name: z.string(), provider: z.string(), effort: z.string().nullable() })),
    message: z.string(),
  }),
  Refused,
]);
export type CouncilStartOutput = z.infer<typeof CouncilStartOutput>;

export const CouncilNoteInput = z.object({
  councilId: CouncilId,
  /** One or two plain sentences: what those who answered think, who you still wait for. */
  text: z.string().trim().min(1).max(COUNCIL_NOTE_MAX),
});
export const CouncilOkOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), message: z.string() }),
  Refused,
]);
export type CouncilOkOutput = z.infer<typeof CouncilOkOutput>;

export const CouncilTellInput = z.object({
  councilId: CouncilId,
  /** What the council's lead is told, in your words: the person's go-ahead, a correction, what to look at again. */
  message: z.string().trim().min(1).max(COUNCIL_PLAN_MAX),
  /**
   * The person said to build the plan the council waits with. Only in the turn their own message started; without it a
   * message to a waiting council changes the plan and the council comes back with it.
   */
  goAhead: z.boolean().optional(),
});
export const CouncilTellOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('told'), message: z.string() }),
  Refused,
]);
export type CouncilTellOutput = z.infer<typeof CouncilTellOutput>;

export const CouncilFinishInput = z.object({
  councilId: CouncilId,
  /** The conclusion for the person, in plain words. */
  summary: z.string().trim().min(1).max(COUNCIL_SUMMARY_MAX),
  /** Plain-words notes for numbered areas of the pictures. */
  notes: z
    .array(
      z.object({
        view: z.string().trim().min(1).max(80),
        n: z.number().int().min(1).max(COUNCIL_AREAS_MAX),
        text: z.string().trim().min(1).max(COUNCIL_SHOT_NOTE_MAX),
      }),
    )
    .max(COUNCIL_SHOTS_MAX * COUNCIL_AREAS_MAX)
    .optional(),
  stopped: z.boolean().optional(),
  /** Up to three short replies the person can tap next (“Put it on dev”). */
  next: z.array(Suggestion).max(SUGGESTIONS_MAX).optional(),
});
export const CouncilFinishOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('finished'), messageId: MessageId, message: z.string() }),
  Refused,
]);
export type CouncilFinishOutput = z.infer<typeof CouncilFinishOutput>;

export const CouncilReadInput = z.object({
  /** Default: this thread's council. */
  councilId: CouncilId.optional(),
});
export const CouncilReadOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), council: CouncilDispatchContext }),
  Refused,
]);
export type CouncilReadOutput = z.infer<typeof CouncilReadOutput>;

export const COUNCIL_MCP_TOOLS = {
  council_start: {
    name: 'council_start',
    title: 'Start a council',
    description:
      'Puts a question or a goal to the council: AI models of different providers in T3 Code, each on its own, led by one T3 Code thread that runs the rounds and, for improve, builds and fixes. kind review (one round of scores), research (one answer they agree on) or improve (one plan they agree on, the person’s go-ahead, the build, checks until the target score). Who sits on it: T3 Code’s own council (the members its council skill names), or the members the person names this time. Only when the person asked; read the whombat:council skill first. Whombat posts your intro with a live card under it and wakes you when the lead is done.',
    input: CouncilStartInput,
    output: CouncilStartOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof CouncilStartInput, typeof CouncilStartOutput> & { personal: true },
  council_note: {
    name: 'council_note',
    title: 'Write on the council’s card',
    description:
      'Posts your words as a reply under the council’s live card while it works, without telling anyone.',
    input: CouncilNoteInput,
    output: CouncilOkOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof CouncilNoteInput, typeof CouncilOkOutput> & { personal: true },
  council_tell: {
    name: 'council_tell',
    title: 'Tell the council’s lead',
    description:
      'Sends your words to the council’s lead thread in T3 Code, which works on: a correction, something to look at again, or with goAhead true the person’s go-ahead on the plan it waits with (only in the turn they said so). You are woken when it is done.',
    input: CouncilTellInput,
    output: CouncilTellOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof CouncilTellInput, typeof CouncilTellOutput> & { personal: true },
  council_finish: {
    name: 'council_finish',
    title: 'Finish the council',
    description:
      'Ends the council: your conclusion is posted under the final card (every round’s scores and the plan) and what still works stops; next offers the person quick replies. Then end your turn with nothing else.',
    input: CouncilFinishInput,
    output: CouncilFinishOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof CouncilFinishInput, typeof CouncilFinishOutput> & { personal: true },
  council_read: {
    name: 'council_read',
    title: 'Read the council',
    description:
      'Where a council stands: its stage and round, each member’s state, score, verdict and answer, the plan and the pictures’ areas. For when the person asks about it outside a council wake.',
    input: CouncilReadInput,
    output: CouncilReadOutput,
    requiredKey: null,
    readOnly: true,
    personal: true,
  } satisfies McpTool<typeof CouncilReadInput, typeof CouncilReadOutput> & { personal: true },
} as const;

/** The council's tools (served together, `served.ts`). */
export const COUNCIL_TOOL_NAMES = Object.keys(COUNCIL_MCP_TOOLS) as (keyof typeof COUNCIL_MCP_TOOLS)[];
