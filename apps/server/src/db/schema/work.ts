/** Plans, runs (+ steps, log, files) and approvals. */
import type {
  ActionBinding,
  ApprovalAction,
  ApprovalCondition,
  ApprovalExecution,
  ApprovalState,
  CommandScope,
  DiffStat,
  JsonObject,
  PlanStep,
  RunStatus,
  RunStepState,
  TestCounts,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

/**
 * A plan step as stored: the contract's `PlanStep` plus server-only bookkeeping (work-supervision WS-05, WS-07) that
 * never leaves the server (`loadPlans` parses it away): the projection key of the linked work last applied, and
 * when the step was first started. A step has no owner: a plan is the agent's own work (one-agent.md OA-14).
 */
export type StoredPlanStep = PlanStep & {
  followKey?: string | null;
  startedAt?: string | null;
};

export const plans = pgTable(
  'plans',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    title: text('title').notNull(),
    due: date('due', { mode: 'string' }),
    conversationId: text('conversation_id').notNull(),
    canvasId: text('canvas_id'),
    steps: jsonb('steps').$type<StoredPlanStep[]>().notNull().default([]),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    /** Who made the plan (WS-01); null for seeded plans. */
    createdById: text('created_by_id'),
    createdAt: ts('created_at'),
    /** The message the plan was made from, and the thread its card went into. */
    sourceMessageId: text('source_message_id'),
    sourceThreadRootId: text('source_thread_root_id'),
    /** The plan card message. */
    messageId: text('message_id'),
  },
  (t) => [
    index('plans_conversation_idx').on(t.conversationId, t.updatedAt),
    // Following linked work finds the plans whose steps point at a run / approval / automation run / dispatch.
    index('plans_steps_idx').using('gin', t.steps.op('jsonb_path_ops')),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    number: integer('number').notNull(),
    agentId: text('agent_id').notNull(),
    title: text('title').notNull(),
    branch: text('branch').notNull(),
    repoId: text('repo_id'),
    prNumber: integer('pr_number'),
    status: text('status').$type<RunStatus>().notNull(),
    askedById: text('asked_by_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id'),
    dispatchId: text('dispatch_id'),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    progress: doublePrecision('progress').notNull().default(0),
    activity: text('activity').notNull().default(''),
    summary: text('summary'),
    tests: jsonb('tests').$type<TestCounts>(),
    diff: jsonb('diff').$type<DiffStat>().notNull().default({ add: 0, del: 0, files: 0 }),
    keysUsed: text('keys_used').array().notNull().default(sql`'{}'::text[]`),
    logCount: integer('log_count').notNull().default(0),
    pausedById: text('paused_by_id'),
    takenOverById: text('taken_over_by_id'),
    /** Why the live run needs a person (run-checkout.md RC-11); null when nothing does. */
    attention: text('attention'),
    /** When Whombat woke the agent because the run stalled (RC-11): once, until a person resumes or retries it. */
    stalledAt: ts('stalled_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('runs_number_idx').on(t.burrowId, t.number),
    index('runs_agent_idx').on(t.agentId, t.startedAt),
    // The run a turn started (observed activity attaches it on every beat, work-supervision WS-12).
    index('runs_dispatch_idx').on(t.dispatchId),
  ],
);

export const runSteps = pgTable(
  'run_steps',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    idx: integer('idx').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    at: ts('at'),
    state: text('state').$type<RunStepState>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.idx] })],
);

export const runLog = pgTable(
  'run_log',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    seq: integer('seq').notNull(),
    at: ts('at').notNull(),
    text: text('text').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export const runFiles = pgTable(
  'run_files',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    path: text('path').notNull(),
    add: integer('add').notNull(),
    del: integer('del').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.runId, t.path] })],
);

/** The command to run once an `ask` approval goes through (generic asks from the commit pipeline). */
export interface DeferredCommand {
  name: string;
  input: JsonObject;
}

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    number: integer('number').notNull(),
    requesterId: text('requester_id').notNull(),
    /** The turn and run that asked, kept across approval execution and its follow-up. */
    createdByDispatchId: text('created_by_dispatch_id'),
    runId: text('run_id'),
    /** The catalog key that asked; null only for a `vault_use` approval (docs/decisions/vault.md VT-20, CT-102). */
    keyId: text('key_id'),
    action: jsonb('action').$type<ApprovalAction>().notNull(),
    title: text('title').notNull(),
    question: text('question').notNull(),
    target: text('target').notNull().default(''),
    whatHappens: jsonb('what_happens').$type<string[]>().notNull().default([]),
    /**
     * WHAT HAPPENS for someone who cannot read the approval's conversation (deciding from the inbox),
     * when `whatHappens` repeats what was said there (a pack tool's arguments). Null: the same lines for everyone.
     */
    whatHappensOutside: jsonb('what_happens_outside').$type<string[]>(),
    explainer: text('explainer').notNull().default(''),
    summary: text('summary').notNull().default(''),
    conditions: jsonb('conditions').$type<ApprovalCondition[]>().notNull(),
    state: text('state').$type<ApprovalState>().notNull().default('pending'),
    decidedById: text('decided_by_id'),
    decidedAt: ts('decided_at'),
    execution: jsonb('execution').$type<ApprovalExecution>().notNull(),
    executedAt: ts('executed_at'),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id'),
    involvedIds: text('involved_ids').array().notNull().default(sql`'{}'::text[]`),
    eventId: text('event_id'),
    command: jsonb('command').$type<DeferredCommand>(),
    /** sha256 of {action, deferred input, binding}, signed in `approval.requested` (bp-automations BP-C09). */
    actionHash: text('action_hash'),
    /** What the hash is bound to besides the action and input (automation, version, step, commit). */
    actionBinding: jsonb('action_binding').$type<ActionBinding>(),
    /**
     * The person the request was made for (SUB-28): the person the requesting agent's dispatch was for when it asked,
     * the person who asked in person, an automation run's person. What runs once it is approved (a deferred command,
     * a pack tool's result, the wake-up after a key) is for them. Null: nobody (and requests from before this column).
     */
    onBehalfOfAccountId: text('on_behalf_of_account_id'),
    /** How long a yes to a `run_command` lasts (agent-computer.md AC-42): `once`, `task`, `agent`; null otherwise. */
    scope: text('scope').$type<CommandScope>(),
    /**
     * Approve later (one-whombat.md ONE-10, migration 0104): the approved request runs at this time, not when the person
     * said yes. Null: it runs on the yes.
     */
    executeAt: ts('execute_at'),
    /**
     * What an approved call returned (home-redesign.md HR-04, migration 0111), sealed (AAD `approval:<id>:result`): the
     * agent woken after the yes reads it (`DispatchContext.grantedResult`) and answers in its own words. Null otherwise.
     */
    resultEnc: text('result_enc'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('approvals_number_idx').on(t.burrowId, t.number),
    index('approvals_state_idx').on(t.burrowId, t.state),
    index('approvals_execute_at_idx')
      .on(t.executeAt)
      .where(sql`${t.executeAt} IS NOT NULL AND ${t.executedAt} IS NULL`),
  ],
);
