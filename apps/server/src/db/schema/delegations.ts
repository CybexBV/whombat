/**
 * Delegations (docs/decisions/delegate.md), migration 0046: tasks the agent offered to hand to T3 Code from a checklist
 * card (where it is told, what it is for, the T3 Code project, how many work at once, the card's message), and one row
 * per task (its brief, whether it is ticked, the task it comes after, its T3 Code thread, branch and pull request, its
 * last answer). Written by the delegation's commands (`delegate/commands.ts`), as the agent, the card's presses as the
 * person.
 */
import type {
  CouncilShotNote,
  DelegationOutcome,
  DelegationStage,
  DelegationTaskChecks,
  DelegationTaskMerge,
  DelegationTaskState,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { attachments } from './attachments';
import { ts } from './common';
import { catalogConnections } from './connections-catalog';
import { conversations } from './conversations';
import { type CouncilAreaRow, councils } from './councils';
import { principals } from './principals';
import { burrows } from './tenancy';

export const delegations = pgTable(
  'delegations',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** Where it is told: the Chat thread the card is in. */
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    threadRootId: text('thread_root_id'),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** The person it works for; its wakes are their turns. */
    personId: text('person_id').references(() => principals.id, { onDelete: 'set null' }),
    /** The T3 Code connection its tasks run on. */
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    /** T3 Code's project (null: scratch folders), its title and folder as T3 Code says. */
    projectId: text('project_id'),
    projectTitle: text('project_title'),
    projectRoot: text('project_root'),
    title: text('title').notNull(),
    stage: text('stage').$type<DelegationStage>().notNull(),
    atOnce: integer('at_once').notNull(),
    pullRequests: boolean('pull_requests').notNull().default(true),
    /** Whether Whombat integrates and merges the finished work automatically. */
    merge: boolean('merge').notNull().default(false),
    /** Left from the removed repository delivery (docs/decisions/fast-testing.md); nothing reads or writes it. */
    delivery: jsonb('delivery'),
    /** Batch integration checks the combined work before it reaches the default branch. */
    integrationMode: text('integration_mode').$type<'batch' | 'legacy'>().notNull().default('batch'),
    /** The council whose agreed plan it carries out (council.md CNL-60, migration 0048). */
    councilId: text('council_id').references(() => councils.id, { onDelete: 'set null' }),
    /** What every task keeps to alike, in the agent's words (DLG-24). */
    rules: text('rules'),
    /** The branch its pull requests target, once T3 Code said (DLG-23): later tasks start from it, fetched fresh. */
    baseBranch: text('base_branch'),
    /**
     * The AI the person chose on the checklist for every task without a choice of its own (migration 0049): T3 Code's
     * provider instance and model, its name and its options (effort, fast tier); null: T3 Code's default.
     */
    aiProvider: text('ai_provider'),
    aiModel: text('ai_model'),
    aiModelLabel: text('ai_model_label'),
    aiOptions: jsonb('ai_options').$type<{ id: string; value: string | boolean }[]>(),
    /** The agent's words under the card: its latest, then its summary. */
    note: text('note'),
    /** The card's message. */
    messageId: text('message_id'),
    /** When the ticked tasks were handed over. */
    handedAt: ts('handed_at'),
    outcome: text('outcome').$type<DelegationOutcome>(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    endedAt: ts('ended_at'),
  },
  (t) => [
    index('delegations_stage_idx').on(t.burrowId, t.stage),
    index('delegations_thread_idx').on(t.conversationId, t.threadRootId),
  ],
);

export type DelegationRow = typeof delegations.$inferSelect;

export const delegationTasks = pgTable(
  'delegation_tasks',
  {
    id: text('id').primaryKey(),
    delegationId: text('delegation_id')
      .notNull()
      .references(() => delegations.id, { onDelete: 'cascade' }),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** Its place on the card (its number is this plus one). */
    position: integer('position').notNull(),
    title: text('title').notNull(),
    why: text('why'),
    brief: text('brief').notNull(),
    picked: boolean('picked').notNull().default(true),
    /**
     * The task it is done with: in that one's thread, after it, on its branch and in its pull request when both are
     * waiting to start; once that one is merged, on its own from the default branch (DLG-42).
     */
    afterId: text('after_id'),
    /**
     * The ordinary work, or the combined check Whombat reserves before an automatic list can merge.
     */
    kind: text('kind').$type<'task' | 'final'>().notNull().default('task'),
    /** The files, folders or parts it said it changes (DLG-24, migration 0048). */
    areas: text('areas').array().notNull().default(sql`'{}'::text[]`),
    /**
     * T3 Code's provider instance and model the person named for it (in the chat or on the checklist), and the model's
     * name; null: the delegation's choice, else T3 Code's default.
     */
    provider: text('provider'),
    model: text('model'),
    modelLabel: text('model_label'),
    /** Its model's options in T3 Code (effort, fast tier): the person's on the checklist, or a council's builder seat's. */
    options: jsonb('options').$type<{ id: string; value: string | boolean }[]>(),
    state: text('state').$type<DelegationTaskState>().notNull(),
    /** How often it was started (a retry starts a new thread on a new branch). */
    attempt: integer('attempt').notNull().default(0),
    /** A durable identity for tasks launched together, including while their thread is still starting. */
    groupId: text('group_id'),
    /** Its number on the card when its thread got it: the thread reports on it by that number (`Item 3: …`). */
    item: integer('item'),
    /**
     * Two meanings, told apart by the row's state. On a waiting candidate: Whombat is merging it on GitHub now, and
     * changes that would replace its check wait until that is over (or this is a few minutes old, after a restart).
     * On a merging or merged final row: Whombat merged it itself, so its thread puts it live and a retry does that
     * again (`whombatMerged`, the update's retry). Read it only with the row's state.
     */
    mergeClaimedAt: ts('merge_claimed_at'),
    /** Its T3 Code thread, its page there, its worktree and branch, once it started. */
    threadId: text('thread_id'),
    url: text('url'),
    worktree: text('worktree'),
    branch: text('branch'),
    /** Its pull request's page, once it opened one. */
    pr: text('pr'),
    /** The agent's line about how it went. */
    note: text('note'),
    /** Its thread's last answer, when it ended. */
    answer: text('answer'),
    /**
     * Its pull request when Whombat merges them (migration 0047): `waiting` its turn, `merging`, `merged`, `not_merged`,
     * or `kept` (the person keeps it to merge themselves); null: as the delegation says, once it is done.
     */
    mergeState: text('merge_state').$type<DelegationTaskMerge | 'kept'>(),
    /** What its thread answered when it merged it, or couldn't. */
    mergeAnswer: text('merge_answer'),
    /** Where its pull request's checks are (DLG-20, DLG-21); null: not known. */
    checks: text('checks').$type<DelegationTaskChecks>(),
    /** The combined work's commit, inputs and default-branch base that a passing check covered. */
    checkedRevision: text('checked_revision'),
    checkedInputs: text('checked_inputs'),
    checkedBase: text('checked_base'),
    /** New work advances the generation so an older check cannot certify it. */
    checkGeneration: integer('check_generation').notNull().default(0),
    checkedGeneration: integer('checked_generation'),
    /** Since when the checks it was told about waited to start; a later wait tells it again. Null: none told. */
    checksStuckAt: ts('checks_stuck_at'),
    /** More work the agent sent while it wasn't at work, sent when a place frees up (DLG-25). */
    sendPending: text('send_pending'),
    /** Its picture link's token hash and end (DLG-27); null: none given. */
    uploadHash: text('upload_hash'),
    uploadUntil: ts('upload_until'),
    /** The `delegation` turn that tells its end; null before one. */
    dispatchId: text('dispatch_id'),
    /**
     * Its thread is to be stopped in T3 Code and T3 Code hasn't said so yet (it couldn't be reached): the watcher's pass
     * tries again until it answers, whatever became of the delegation.
     */
    stopPending: boolean('stop_pending').notNull().default(false),
    stopTries: integer('stop_tries').notNull().default(0),
    stopNextAt: ts('stop_next_at'),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    /** Not used: a task's run has no time limit. */
    deadline: ts('deadline'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    index('delegation_tasks_delegation_idx').on(t.delegationId, t.position),
    index('delegation_tasks_thread_idx').on(t.threadId),
    index('delegation_tasks_dispatch_idx').on(t.dispatchId),
    index('delegation_tasks_upload_idx').on(t.uploadHash),
  ],
);

export type DelegationTaskRow = typeof delegationTasks.$inferSelect;

/**
 * A task's pictures of what it changed (DLG-27, migration 0048), as the council's were (CNL-30…CNL-33): per screen the
 * before, the after and the one picture Whombat draws of them, attachments of the delegation's conversation, the areas it
 * numbered and the task's notes.
 */
export const delegationShots = pgTable(
  'delegation_shots',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => delegationTasks.id, { onDelete: 'cascade' }),
    delegationId: text('delegation_id')
      .notNull()
      .references(() => delegations.id, { onDelete: 'cascade' }),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    view: text('view').notNull(),
    /** Its place among the task's screens: the order they first came in. */
    position: integer('position').notNull(),
    beforeId: text('before_id').references(() => attachments.id, { onDelete: 'set null' }),
    afterId: text('after_id').references(() => attachments.id, { onDelete: 'set null' }),
    compareId: text('compare_id').references(() => attachments.id, { onDelete: 'set null' }),
    width: integer('width'),
    height: integer('height'),
    areas: jsonb('areas').$type<CouncilAreaRow[]>().notNull().default(sql`'[]'::jsonb`),
    notes: jsonb('notes').$type<CouncilShotNote[]>().notNull().default(sql`'[]'::jsonb`),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'delegation_shots_pk', columns: [t.taskId, t.view] }),
    index('delegation_shots_delegation_idx').on(t.delegationId),
  ],
);

export type DelegationShotRow = typeof delegationShots.$inferSelect;
