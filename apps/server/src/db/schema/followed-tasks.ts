/**
 * Server tasks a Whombat started and follows to their end (docs/decisions/task-feedback.md TF-10…TF-13), migration
 * 0132: one row per task, its `task` card in the thread it was asked in, and the turn woken when it ended. Written only
 * through the commit pipeline (`hosts.follow_task`, `hosts.task_ended`); the ended ones go after 30 days.
 */
import type { TaskCardState } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { TaskWords } from '../../hosts/words';
import { ts } from './common';
import { conversations, messages } from './conversations';
import { principals } from './principals';
import { burrows } from './tenancy';

export const followedTasks = pgTable(
  'followed_tasks',
  {
    /** `ftk_…`: the card's `followedTaskId`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The hosts service's server id and its task's id there. */
    serverId: text('server_id').notNull(),
    taskId: text('task_id').notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** The thread it was asked in (TF-04); null: the top of a flat conversation. */
    threadRootId: text('thread_root_id'),
    /** The Whombat that started it: the card's author, and the agent woken when it ends (TF-12). */
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** The person it was started for; null: nobody. */
    personId: text('person_id').references(() => principals.id, { onDelete: 'set null' }),
    /** The approval whose yes ran the call that started it; null: a call that didn't ask. */
    approvalId: text('approval_id'),
    words: jsonb('words').$type<TaskWords>().notNull(),
    /** The server's name as the card says it (“Home Assistant”). */
    serverName: text('server_name').notNull(),
    /** The `task` card's message; null once it is gone (or when it couldn't be posted). */
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    state: text('state').$type<TaskCardState>().notNull().default('running'),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    /** When Whombat last asked the hosts service about it (TF-11). */
    checkedAt: ts('checked_at'),
    /** The outcome words, once it ended. */
    result: text('result'),
    /** The server's report after it asks for a restart (the next step the agent may offer). */
    rebootRequired: boolean('reboot_required').notNull().default(false),
    /** The `task_finished` turn that tells the person (TF-12); null while running or when the line was posted. */
    dispatchId: text('dispatch_id'),
    /** The change Done recently gets when it ends well (TF-13), sealed under `followed_task:<id>:change`. */
    changeEnc: text('change_enc'),
  },
  (t) => [
    uniqueIndex('followed_tasks_task_idx').on(t.serverId, t.taskId),
    index('followed_tasks_running_idx').on(t.startedAt).where(sql`${t.state} = 'running'`),
    index('followed_tasks_dispatch_idx').on(t.dispatchId).where(sql`${t.dispatchId} is not null`),
    index('followed_tasks_approval_idx').on(t.approvalId).where(sql`${t.approvalId} is not null`),
    index('followed_tasks_ended_idx').on(t.endedAt).where(sql`${t.endedAt} is not null`),
  ],
);

export type FollowedTaskRow = typeof followedTasks.$inferSelect;
