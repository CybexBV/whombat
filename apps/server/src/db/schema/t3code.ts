/**
 * T3 Code threads the agent handed work to and Whombat watches for it (docs/decisions/t3code.md), migration 0023: one
 * row per connection and thread, with where the work was handed over (the conversation, its thread, the agent and the
 * person) and what the agent already knows of the thread, so it is woken once for each thing that happens there, and the thread is settled in T3 Code once its work completed. Written by the agent's own calls (`t3code.follow_thread`) and the watcher's wakes
 * (`t3code.thread_moved`); the watcher's bookkeeping (when it last read a thread, its length) is a plain update.
 */
import type { HandoffStep, T3ThreadUpdate } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { catalogConnections } from './connections-catalog';
import { conversations } from './conversations';
import { councils } from './councils';
import { delegationTasks } from './delegations';
import { principals } from './principals';
import { burrows } from './tenancy';

/** Where a prompt's merge stands (`t3_watches.merge`). */
export interface T3WatchMerge {
  state: 'wanted' | 'merged' | 'left';
  /** When it was merged or left. */
  at?: string;
}

/** `watching`: read every pass; `idle`: its work ended (or the agent stopped it), until the agent sends it more. */
export type T3WatchState = 'watching' | 'idle';

export const t3Watches = pgTable(
  't3_watches',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    /** T3 Code's own id of the thread (`mcp:…`). */
    threadId: text('thread_id').notNull(),
    /** Its title, as the agent named it or T3 Code renamed it. */
    title: text('title').notNull(),
    /** Where the work was handed over: the wake's conversation and thread (null: the top of a flat conversation). */
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    threadRootId: text('thread_root_id'),
    /** The agent woken, and the person its turn is for (null: nobody, never woken). */
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    personId: text('person_id').references(() => principals.id, { onDelete: 'set null' }),
    state: text('state').$type<T3WatchState>().notNull().default('watching'),
    /**
     * Whether the agent is woken when the thread moves on. False for a thread an automation's step (or another turn that waits for its
     * thread itself) handed work to: that turn waits for it itself, and the watch only settles the thread once its work completed.
     */
    wakes: boolean('wakes').notNull().default(true),
    /**
     * What the agent knows of the thread already, in the watcher's words: `done:<run>` (that run ended), `asks:<hash>`
     * (those questions), `approval:<run>:<n>` (that permission request): told in a wake, or seen in its own calls.
     */
    seenKey: text('seen_key'),
    /** What the last wake told (the turn's `t3Threads` entry); null before one. */
    told: jsonb('told').$type<T3ThreadUpdate>(),
    /** The `t3_thread` turn that tells it; null before one. */
    dispatchId: text('dispatch_id'),
    /** When the agent last handed it work (started, messaged or answered it). */
    armedAt: ts('armed_at').notNull(),
    /** When the watcher last read it, and the length of its timeline then (to read its latest items). */
    checkedAt: ts('checked_at'),
    items: integer('items').notNull().default(0),
    /**
     * What the person sees of it (t3code.md T3-24, `t3code/handoff.ts`), as the watcher last read it: T3 Code's word
     * for its state, what it waits on (`question`, `approval`, null), the question or the permission's subject, its
     * latest steps in plain words, its AI program, its page in T3 Code, the pull requests it waits for and when its run
     * started and ended. Null before the first read and after the agent hands it new work.
     */
    status: text('status'),
    pending: text('pending').$type<'question' | 'approval'>(),
    asks: text('asks'),
    steps: jsonb('steps').$type<(HandoffStep & { id: string })[]>(),
    program: text('program'),
    url: text('url'),
    prs: jsonb('prs').$type<string[]>(),
    /** Unused since every thread is Chat's (docs/decisions/one-chat.md); dropped with `thread_places` later. */
    branch: text('branch'),
    projectId: text('project_id'),
    runStartedAt: ts('run_started_at'),
    runEndedAt: ts('run_ended_at'),
    /**
     * The job's progress (t3code.md T3-30…T3-41, `t3code/progress.ts`): its stage track, plan, pull request with its
     * changes and checks, the question it waits on, its receipt and its answer, as the watcher last read them (migration 0055).
     * Bookkeeping like the parts above; a new hand-over keeps it, so the track goes on.
     */
    progress: jsonb('progress'),
    /**
     * The council this thread is a member or the builder of (council.md): its end goes to the council, which reads its
     * answer and wakes the agent, and it doesn't show as a hand-over. Null for every other thread.
     */
    councilId: text('council_id').references(() => councils.id, { onDelete: 'set null' }),
    /**
     * The delegation task this thread works on (delegate.md): its end goes to the delegation, which starts the next task
     * and wakes the agent, and it doesn't show as a hand-over (the card shows it). Null for every other thread.
     */
    delegationTaskId: text('delegation_task_id').references(() => delegationTasks.id, {
      onDelete: 'set null',
    }),
    /**
     * The message in the Whombat thread that is this job's result (`Message.jobResult`, migration 0003): the next end
     * updates it in place while it is still the thread's latest word or the person's answers on it started the run.
     */
    resultMessageId: text('result_message_id'),
    /**
     * A prompt's “Merge into main when it’s done” (prompts.md): Whombat merges the job's pull request once the thread
     * is done and its checks pass (`t3code/merge.ts`). `wanted` until then; `merged` or `left` (for the person, and
     * why) after. Null for every other thread.
     */
    merge: jsonb('merge').$type<T3WatchMerge>(),
  },
  (t) => [
    primaryKey({ name: 't3_watches_pk', columns: [t.connectionId, t.threadId] }),
    index('t3_watches_watching_idx').on(t.armedAt).where(sql`${t.state} = 'watching'`),
    index('t3_watches_dispatch_idx').on(t.dispatchId).where(sql`${t.dispatchId} is not null`),
    // A conversation's hand-overs (`conversations.handoffs`).
    index('t3_watches_conversation_idx').on(t.conversationId),
  ],
);

export type T3WatchRow = typeof t3Watches.$inferSelect;
