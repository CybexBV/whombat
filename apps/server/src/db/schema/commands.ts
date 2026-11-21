/**
 * The agent's commands (docs/decisions/agent-computer.md AC-41, AC-42): what the person allowed.
 *
 * - `command_allowances`: **Always allow for {Agent}** — one agent, one key, one normalised command and target, shown
 *   and removable in the agent's Access settings.
 * - `command_passes`: one row per `run_command` approval — what it asked (the asking dispatch, its run or thread, the
 *   normalised command and target) and, once a person said yes for `once` or `task`, the pass it is: `once` is used by
 *   the waiting command (or the next identical one after a late yes) and then spent (`used_at`); `task` covers the same
 *   command and target for the rest of the run, or of the thread when there is no run.
 */
import type { CommandCategory, CommandScope, KeyId } from '@whombat/core';
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';

export const commandAllowances = pgTable(
  'command_allowances',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    keyId: text('key_id').$type<KeyId>().notNull(),
    /** `normaliseCommand` of the command as it was allowed. */
    command: text('command').notNull(),
    /** `classifyCommand`'s target ('' when it had none, so the unique index holds). */
    target: text('target').notNull().default(''),
    createdById: text('created_by_id').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('command_allowances_match_idx').on(t.agentId, t.keyId, t.command, t.target)],
);

export const commandPasses = pgTable(
  'command_passes',
  {
    /** The `run_command` approval (one pass per approval). */
    approvalId: text('approval_id').primaryKey(),
    burrowId: text('burrow_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** The dispatch whose command asked. */
    dispatchId: text('dispatch_id').notNull(),
    /** The asking dispatch's run (a `task` pass covers the run), else null. */
    runId: text('run_id'),
    conversationId: text('conversation_id').notNull(),
    /** The asking dispatch's thread (a `task` pass without a run covers the thread). */
    threadRootId: text('thread_root_id'),
    category: text('category').$type<CommandCategory>().notNull(),
    keyId: text('key_id').$type<KeyId>().notNull(),
    command: text('command').notNull(),
    target: text('target').notNull().default(''),
    /** The scope a person allowed it for; null while pending and after a no. */
    scope: text('scope').$type<CommandScope>(),
    /** When the runner last long-polled it (`runner.authorizeWait`): a runner still waiting gets the yes itself. */
    polledAt: ts('polled_at'),
    /** When a waiting runner was told `run` (the yes reached the command in its turn). */
    deliveredAt: ts('delivered_at'),
    /** A `once` pass spent (by the waiting command or the next identical one). */
    usedAt: ts('used_at'),
    /** When a late yes woke the agent (`approval_granted`). */
    wokenAt: ts('woken_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('command_passes_agent_idx').on(t.agentId, t.command)],
);
