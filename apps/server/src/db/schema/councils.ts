/**
 * Councils the agent leads (docs/decisions/council.md), migration 0043: the council itself (where it is told, what it
 * asks, where it is, the plan, its builder, its cards and its pictures' upload link), one row per member thread of each
 * round and the builder, and the screens with pictures of what changed. Written by the council's commands
 * (`council/commands.ts`), always as the agent, the person's Go ahead and Stop as the person.
 */
import type {
  CouncilKind,
  CouncilMemberState,
  CouncilOutcome,
  CouncilRoundResult,
  CouncilSeatSetup,
  CouncilShotNote,
  CouncilStage,
  CouncilVerdict,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, real, text } from 'drizzle-orm/pg-core';
import { attachments } from './attachments';
import { ts } from './common';
import { catalogConnections } from './connections-catalog';
import { conversations } from './conversations';
import { principals } from './principals';
import { burrows } from './tenancy';

/** `active` while it works or waits for the person; how it ended otherwise. */
export type CouncilState = 'active' | 'done' | 'stopped';

/** A seat on the council (CNL-04): a provider of T3 Code's and the model it runs, kept for every round. */
export interface CouncilSeat {
  provider: string;
  providerName: string;
  model: string;
  label: string;
  options: { id: string; value: string | boolean }[];
}

/** One numbered area of a screen's change, in the after picture's pixels, and where it is in words. */
export interface CouncilAreaRow {
  n: number;
  x: number;
  y: number;
  w: number;
  h: number;
  where: string;
}

export const councils = pgTable(
  'councils',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** Where it is told: the Chat thread it was asked in. */
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    threadRootId: text('thread_root_id'),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** The person it works for; its wakes are their turns. */
    personId: text('person_id').references(() => principals.id, { onDelete: 'set null' }),
    /** The T3 Code connection its members run on. */
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    /** T3 Code's project (null: research in scratch folders), its title and folder as T3 Code says. */
    projectId: text('project_id'),
    projectTitle: text('project_title'),
    projectRoot: text('project_root'),
    kind: text('kind').$type<CouncilKind>().notNull(),
    /** Who sits on it, in order; every round's members are these, in new threads. */
    seats: jsonb('seats').$type<CouncilSeat[]>().notNull(),
    /** The seat that builds (`seats[builderSeat]`), from the council it was started with (CNL-52). */
    builderSeat: integer('builder_seat').notNull().default(0),
    /** The named council it was started with; null: Whombat's own seats, or members named for it alone. */
    setupName: text('setup_name'),
    title: text('title').notNull(),
    question: text('question').notNull(),
    stage: text('stage').$type<CouncilStage>().notNull(),
    /** The round of the stage now. */
    round: integer('round').notNull().default(1),
    /** Rounds to agree and to check used so far, and the most of each. */
    agreeRounds: integer('agree_rounds').notNull().default(0),
    checkRounds: integer('check_rounds').notNull().default(0),
    roundsMax: integer('rounds_max').notNull(),
    target: real('target'),
    goAllTheWay: boolean('go_all_the_way').notNull().default(false),
    /** When the person said go ahead on the plan (or the start, when they said to go all the way). */
    okAt: ts('ok_at'),
    plan: text('plan'),
    /** What the builder was last asked to do. */
    instructions: text('instructions'),
    /** The builder's T3 Code thread, worktree and branch, once it started. */
    builderThreadId: text('builder_thread_id'),
    builderWorktree: text('builder_worktree'),
    builderBranch: text('builder_branch'),
    /** The live card's message while it works, and the final message once it ended. */
    liveMessageId: text('live_message_id'),
    finalMessageId: text('final_message_id'),
    /** The builder's picture link: the token's hash, and until when it works. */
    uploadHash: text('upload_hash'),
    uploadUntil: ts('upload_until'),
    /** The rounds that ended, each member's score and verdict. */
    history: jsonb('history').$type<CouncilRoundResult[]>().notNull().default(sql`'[]'::jsonb`),
    state: text('state').$type<CouncilState>().notNull().default('active'),
    outcome: text('outcome').$type<CouncilOutcome>(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    endedAt: ts('ended_at'),
  },
  (t) => [
    index('councils_active_idx').on(t.burrowId, t.state),
    index('councils_thread_idx').on(t.conversationId, t.threadRootId),
    index('councils_upload_idx').on(t.uploadHash),
  ],
);

export type CouncilRow = typeof councils.$inferSelect;

export const councilMembers = pgTable(
  'council_members',
  {
    id: text('id').primaryKey(),
    councilId: text('council_id')
      .notNull()
      .references(() => councils.id, { onDelete: 'cascade' }),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    role: text('role').$type<'member' | 'builder'>().notNull(),
    /** The stage and round it works in (`build` for the builder). */
    stage: text('stage').$type<CouncilStage>().notNull(),
    round: integer('round').notNull(),
    /** Its place in the round. */
    position: integer('position').notNull(),
    /** T3 Code's provider instance, its name, the model and its name, and the options it runs with. */
    provider: text('provider').notNull(),
    providerName: text('provider_name').notNull(),
    model: text('model').notNull(),
    label: text('label').notNull(),
    options: jsonb('options').$type<{ id: string; value: string | boolean }[]>().notNull(),
    /** Its T3 Code thread and page there, once it started. */
    threadId: text('thread_id'),
    url: text('url'),
    state: text('state').$type<CouncilMemberState>().notNull(),
    score: real('score'),
    verdict: text('verdict').$type<CouncilVerdict>(),
    answer: text('answer'),
    /** What the builder does now, in plain words. */
    step: text('step'),
    /** The `council` turn that tells its answer; null before one. */
    dispatchId: text('dispatch_id'),
    /**
     * Its thread is to be stopped in T3 Code and T3 Code hasn't said so yet (it couldn't be reached): the watcher's pass
     * tries again until it answers, whatever became of the council.
     */
    stopPending: boolean('stop_pending').notNull().default(false),
    /** How often stopping it was tried, and when to try next (each failure waits longer, so none holds up the rest). */
    stopTries: integer('stop_tries').notNull().default(0),
    stopNextAt: ts('stop_next_at'),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    /** When it runs out of time (CNL-14). */
    deadline: ts('deadline').notNull(),
  },
  (t) => [
    index('council_members_round_idx').on(t.councilId, t.stage, t.round),
    index('council_members_thread_idx').on(t.threadId),
  ],
);

export type CouncilMemberRow = typeof councilMembers.$inferSelect;

/**
 * A screen with pictures of what changed (CNL-30…CNL-33): the before and after the builder sent and the picture Whombat
 * drew of them, each an attachment of the council's conversation (kept from the unsent-upload sweep while a row names
 * it), the numbered areas and their notes.
 */
export const councilShots = pgTable(
  'council_shots',
  {
    councilId: text('council_id')
      .notNull()
      .references(() => councils.id, { onDelete: 'cascade' }),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    view: text('view').notNull(),
    /** Its place among the screens: the order they first came in. */
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
  (t) => [primaryKey({ name: 'council_shots_pk', columns: [t.councilId, t.view] })],
);

export type CouncilShotRow = typeof councilShots.$inferSelect;

/**
 * The councils the person set up and named (council.md CNL-50…CNL-53), migration 0045: who sits on each (a provider
 * T3 Code runs, its model and effort), the seat that builds, its rounds and score, and the one used unless another is
 * named. Changed in Settings (or by the assistant on the person's word, as the person), one commit each.
 */
export const councilSetups = pgTable(
  'council_setups',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    seats: jsonb('seats').$type<CouncilSeatSetup[]>().notNull(),
    builder: integer('builder').notNull().default(0),
    rounds: integer('rounds').notNull(),
    target: real('target').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    /** Its place in the list: the order they were made in. */
    position: integer('position').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('council_setups_burrow_idx').on(t.burrowId, t.position)],
);

export type CouncilSetupRow = typeof councilSetups.$inferSelect;
