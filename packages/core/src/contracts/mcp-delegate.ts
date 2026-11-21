/**
 * The delegation's tools for the agent (Whombat docs/decisions/delegate.md). Spread into `MCP_TOOLS` (`./mcp`);
 * `personal: true`, and served only while a T3 Code connection manages (the tasks run as T3 Code threads). Whombat keeps
 * the checklist, starts each task when it is its turn, follows its thread and wakes the agent (trigger `delegation`) as
 * tasks end; the agent writes the tasks, their briefs and every word the person reads.
 */
import { z } from 'zod';
import {
  DELEGATION_AREA_MAX,
  DELEGATION_AREAS_MAX,
  DELEGATION_AT_ONCE_MAX,
  DELEGATION_BRIEF_MAX,
  DELEGATION_NOTE_MAX,
  DELEGATION_RULES_MAX,
  DELEGATION_SUMMARY_MAX,
  DELEGATION_TASK_NOTE_MAX,
  DELEGATION_TASK_TITLE_MAX,
  DELEGATION_TASKS_MAX,
  DELEGATION_TITLE_MAX,
  DELEGATION_WHY_MAX,
} from '../domain/delegation.js';
import { SUGGESTIONS_MAX, Suggestion } from '../domain/message.js';
import { CouncilId, DelegationId, MessageId } from '../ids.js';
import type { McpTool } from './mcp.js';
import { DelegationDispatchContext } from './runner.js';

const Refused = z.object({
  status: z.literal('refused'),
  reason: z.enum(['no_t3', 'no_project', 'not_found', 'busy', 'invalid', 'unavailable']),
  message: z.string(),
});

const N = z.number().int().min(1).max(99);

/** One task as the agent writes it. */
export const DelegateTaskInput = z.object({
  /** A few words for the checklist (“Make the Settings buttons taller”). */
  title: z.string().trim().min(1).max(DELEGATION_TASK_TITLE_MAX),
  /** Why it is worth doing, in a line, for the person. */
  why: z.string().trim().min(1).max(DELEGATION_WHY_MAX).optional(),
  /** What the coding agent is asked: the task, what done looks like, the files or screens that matter. */
  brief: z.string().trim().min(1).max(DELEGATION_BRIEF_MAX),
  /** Ticked on the checklist (default true). */
  picked: z.boolean().optional(),
  /**
   * The number of a task it builds on: it is done after that one, in its thread and pull request (with another AI,
   * from that one's finished branch).
   */
  after: N.optional(),
  /** The files, folders or parts it changes: a task with another AI sharing one with an earlier task waits for it. */
  areas: z.array(z.string().trim().min(1).max(DELEGATION_AREA_MAX)).max(DELEGATION_AREAS_MAX).optional(),
  /** Only when the person named the AI for it: T3 Code's provider, and its model. */
  provider: z.string().trim().min(1).max(40).optional(),
  model: z.string().trim().min(1).max(80).optional(),
});
export type DelegateTaskInput = z.input<typeof DelegateTaskInput>;

export const DelegateOfferInput = z.object({
  /** What the tasks are for, in the person's words (“Polish the Settings page”). */
  title: z.string().trim().min(1).max(DELEGATION_TITLE_MAX),
  /** Your words above the card, a sentence or two. */
  intro: z.string().trim().min(1).max(DELEGATION_NOTE_MAX),
  /** The T3 Code project's title, folder or id; none: scratch folders. */
  project: z.string().trim().min(1).max(300).optional(),
  tasks: z.array(DelegateTaskInput).min(1).max(DELEGATION_TASKS_MAX),
  /** How many work at once (default 3). */
  atOnce: z.number().int().min(1).max(DELEGATION_AT_ONCE_MAX).optional(),
  /** Each task opens a pull request when done (default true). */
  pullRequests: z.boolean().optional(),
  /**
   * Whombat checks the finished work together and merges it by itself (default true with pull requests). False: the
   * person reviews and merges the pull requests.
   */
  merge: z.boolean().optional(),
  /** The person said to hand them over now: no checklist to tick first. */
  start: z.boolean().optional(),
  /** What every task must keep to alike: where strings and translations go, conventions of the project. */
  rules: z.string().trim().min(1).max(DELEGATION_RULES_MAX).optional(),
  /** The council whose agreed plan these tasks carry out. */
  council: CouncilId.optional(),
});

export const DelegateOfferOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.enum(['offered', 'started']),
    delegationId: DelegationId,
    message: z.string(),
  }),
  Refused,
]);
export type DelegateOfferOutput = z.infer<typeof DelegateOfferOutput>;

/** A change to one task, by its number on the card. */
const TaskChange = z.object({
  n: N,
  title: z.string().trim().min(1).max(DELEGATION_TASK_TITLE_MAX).optional(),
  why: z.string().trim().max(DELEGATION_WHY_MAX).optional(),
  brief: z.string().trim().min(1).max(DELEGATION_BRIEF_MAX).optional(),
  picked: z.boolean().optional(),
  /** The task it is done with (builds on or shares files with); 0: none. */
  after: z.number().int().min(0).max(99).optional(),
  areas: z.array(z.string().trim().min(1).max(DELEGATION_AREA_MAX)).max(DELEGATION_AREAS_MAX).optional(),
  /** Your line about how it went, shown on its row. */
  note: z.string().trim().max(DELEGATION_TASK_NOTE_MAX).optional(),
  /**
   * True: merge its pull request (again) when its turn comes, once its work is done; false: leave it for the person.
   */
  merge: z.boolean().optional(),
});

export const DelegateUpdateInput = z.object({
  delegationId: DelegationId,
  /** Your words, posted as a reply under the card. */
  note: z.string().trim().min(1).max(DELEGATION_NOTE_MAX).optional(),
  title: z.string().trim().min(1).max(DELEGATION_TITLE_MAX).optional(),
  atOnce: z.number().int().min(1).max(DELEGATION_AT_ONCE_MAX).optional(),
  pullRequests: z.boolean().optional(),
  /** Whombat checks the finished work together and merges it by itself (true), or leaves it for the person. */
  merge: z.boolean().optional(),
  rules: z.string().trim().min(1).max(DELEGATION_RULES_MAX).optional(),
  /** New tasks, at the end of the list. */
  add: z.array(DelegateTaskInput).max(DELEGATION_TASKS_MAX).optional(),
  change: z.array(TaskChange).max(DELEGATION_TASKS_MAX).optional(),
  /** Tasks to take off the list (not one that started). */
  remove: z.array(N).max(DELEGATION_TASKS_MAX).optional(),
  /** New order of the tasks not started yet, by their numbers now. */
  order: z.array(N).max(DELEGATION_TASKS_MAX).optional(),
  /** Hand over the ticked tasks now (the person said so). */
  start: z.boolean().optional(),
  /** Stop these tasks' threads. */
  stop: z.array(N).max(DELEGATION_TASKS_MAX).optional(),
  /** Try these again, in a new thread on their own branch. */
  retry: z.array(N).max(DELEGATION_TASKS_MAX).optional(),
  /** Send more work to a task's own thread. */
  send: z
    .array(z.object({ n: N, message: z.string().trim().min(1).max(DELEGATION_BRIEF_MAX) }))
    .max(DELEGATION_TASKS_MAX)
    .optional(),
});

export const DelegateUpdateOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), message: z.string() }),
  Refused,
]);
export type DelegateUpdateOutput = z.infer<typeof DelegateUpdateOutput>;

export const DelegateFinishInput = z.object({
  delegationId: DelegationId,
  /** Your summary for the person, in plain words. */
  summary: z.string().trim().min(1).max(DELEGATION_SUMMARY_MAX),
  /** Stop what still works or waits. */
  stopped: z.boolean().optional(),
  /** Up to three short replies the person can tap next (“Put it on dev”). */
  next: z.array(Suggestion).max(SUGGESTIONS_MAX).optional(),
});
export const DelegateFinishOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('finished'), messageId: MessageId, message: z.string() }),
  Refused,
]);
export type DelegateFinishOutput = z.infer<typeof DelegateFinishOutput>;

export const DelegateReadInput = z.object({
  /** Default: this thread's. */
  delegationId: DelegationId.optional(),
});
export const DelegateReadOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), delegation: DelegationDispatchContext }),
  Refused,
]);
export type DelegateReadOutput = z.infer<typeof DelegateReadOutput>;

export const DELEGATE_MCP_TOOLS = {
  delegate_offer: {
    name: 'delegate_offer',
    title: 'Offer tasks for T3 Code',
    description:
      'Posts a checklist card of tasks to hand to T3 Code: one thread leads the ticked ones, with subagents where the work splits, on one branch and in one pull request (a task with another AI gets a thread of its own); Whombat checks the finished work together and merges it, unless merge: false. The person ticks the ones they want and hands them over on the card (start: true when they already said to do them). Read the whombat:delegate skill first. Your intro goes above the card; post nothing else.',
    input: DelegateOfferInput,
    output: DelegateOfferOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof DelegateOfferInput, typeof DelegateOfferOutput> & { personal: true },
  delegate_update: {
    name: 'delegate_update',
    title: 'Change the delegation card',
    description:
      'Changes the delegation card in this thread after the person talked about it, or as tasks end: your words as a reply under it (note), tasks added, changed, ticked, reordered or removed by their number, hand over the ticked ones (start), stop, retry or send more work to a task, merge pull requests or leave them for the person. Works on an ended card too: added or retried tasks open it again.',
    input: DelegateUpdateInput,
    output: DelegateUpdateOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof DelegateUpdateInput, typeof DelegateUpdateOutput> & { personal: true },
  delegate_finish: {
    name: 'delegate_finish',
    title: 'Finish the delegation',
    description:
      'Ends the delegation: your summary is posted under the final card and the person is told; next offers them quick replies. With stopped, what still works or waits stops. Then end your turn with nothing else.',
    input: DelegateFinishInput,
    output: DelegateFinishOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof DelegateFinishInput, typeof DelegateFinishOutput> & { personal: true },
  delegate_read: {
    name: 'delegate_read',
    title: 'Read the delegation',
    description:
      'The delegation card in this thread as it is now: every task with its number, brief, state, thread, branch, pull request and last answer.',
    input: DelegateReadInput,
    output: DelegateReadOutput,
    requiredKey: null,
    readOnly: true,
    personal: true,
  } satisfies McpTool<typeof DelegateReadInput, typeof DelegateReadOutput> & { personal: true },
} as const;

/** The delegation's tools (served together, `served.ts`). */
export const DELEGATE_TOOL_NAMES = Object.keys(DELEGATE_MCP_TOOLS) as (keyof typeof DELEGATE_MCP_TOOLS)[];
