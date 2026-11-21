/**
 * Supervised automations (docs/decisions/bp-automations.md): definitions and their immutable versions, durable
 * runs and steps (timers are the steps' `wake_at` and the automation's `next_fire_at`), the per-burrow cursor into
 * the signed `events` table, webhook delivery ids and the callback destinations the person approved.
 */
import type {
  AutomationDefinition,
  AutomationGrant,
  AutomationPlanStatus,
  AutomationRunStatus,
  AutomationStatus,
  AutomationStepKind,
  AutomationStepState,
  AutomationTriggerInfo,
  JsonObject,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

export const automations = pgTable(
  'automations',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').$type<AutomationStatus>().notNull().default('draft'),
    /** The live version (null until the first publish). */
    currentVersion: integer('current_version'),
    /** The draft as saved (form or JSON), valid or not; null when there is no draft. */
    draftJson: jsonb('draft_json').$type<JsonObject>(),
    draftUpdatedById: text('draft_updated_by_id'),
    draftUpdatedAt: ts('draft_updated_at'),
    /** The automation principal (agent-shaped, `principals.system = 'automation'`). */
    principalId: text('principal_id').notNull(),
    createdById: text('created_by_id').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    webhookEnabled: boolean('webhook_enabled').notNull().default(false),
    /** HMAC secret sealed with WHOMBAT_MASTER_KEY (`automation:<id>:webhook`). */
    webhookSecretEnc: text('webhook_secret_enc'),
    /** Next schedule fire (the durable timer of a schedule trigger). */
    nextFireAt: ts('next_fire_at'),
    /** Interval schedules count from here (set when switched on). */
    scheduleAnchor: ts('schedule_anchor'),
    /** When this automation's mail trigger became active (mail received before it, minus skew, never fires). */
    mailActiveAt: ts('mail_active_at'),
    /**
     * Deleted (`automations.delete`, docs/decisions/automation-recipes.md): switched off, its webhook and keys gone; it
     * leaves every list and never runs again. Its runs still show it.
     */
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('automations_burrow_idx').on(t.burrowId, t.status),
    index('automations_fire_idx').on(t.nextFireAt),
  ],
);

export const automationVersions = pgTable(
  'automation_versions',
  {
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id),
    n: integer('n').notNull(),
    definition: jsonb('definition').$type<AutomationDefinition>().notNull(),
    definitionHash: text('definition_hash').notNull(),
    publishedById: text('published_by_id').notNull(),
    publishedAt: ts('published_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.automationId, t.n] })],
);

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    number: integer('number').notNull(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id),
    /** The version it runs (0: a test run of the draft). */
    version: integer('version').notNull(),
    /** The definition it runs, fixed when it was created. */
    definition: jsonb('definition').$type<AutomationDefinition>().notNull(),
    /** Who published that version: their authority bounds every step (BP-09). */
    publishedById: text('published_by_id').notNull(),
    status: text('status').$type<AutomationRunStatus>().notNull(),
    trigger: jsonb('trigger').$type<AutomationTriggerInfo>().notNull(),
    /** Dedupe key: `evt:<event id>`, `sched:<instant>`, `hook:<delivery id>`, `manual:<id>`. */
    triggerKey: text('trigger_key').notNull(),
    /** What `{{trigger.*}}` reads (text of the message, the webhook payload, …). */
    scope: jsonb('scope').$type<JsonObject>().notNull().default({}),
    conversationId: text('conversation_id').notNull(),
    threadRootId: text('thread_root_id'),
    causalDepth: integer('causal_depth').notNull().default(0),
    /** Automations whose runs led to this one (loop guard). */
    causalChain: text('causal_chain').array().notNull().default(sql`'{}'::text[]`),
    startedById: text('started_by_id'),
    /**
     * The person the run is for (SUB-27): the publisher for a triggered run, whoever ran it by hand (Run now, a test
     * run), whoever resumed it when that was someone else. Its agent steps' dispatches are for this person. Null: a run
     * from before this column (its publisher).
     */
    onBehalfOfAccountId: text('on_behalf_of_account_id'),
    test: boolean('test').notNull().default(false),
    createdAt: ts('created_at').notNull(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    deadlineAt: ts('deadline_at').notNull(),
    error: text('error'),
    /** Engine lease: the process advancing the run and a fencing token every step write checks. */
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    fence: integer('fence').notNull().default(0),
    updatedAt: ts('updated_at').notNull(),
    /**
     * The GitHub issue or pull request a run is about (`github:acme/web#57`; automation-recipes.md): later runs of the
     * same automation about it continue its thread. Null for every other run (and test runs).
     */
    itemKey: text('item_key'),
  },
  (t) => [
    uniqueIndex('automation_runs_number_idx').on(t.burrowId, t.number),
    uniqueIndex('automation_runs_trigger_idx').on(t.automationId, t.version, t.triggerKey),
    index('automation_runs_status_idx').on(t.status),
    index('automation_runs_automation_idx').on(t.automationId, t.createdAt),
    // A thread's runs (the Chat list's repository of a thread).
    index('automation_runs_thread_idx').on(t.threadRootId).where(sql`${t.threadRootId} is not null`),
    index('automation_runs_item_idx')
      .on(t.automationId, t.itemKey, t.createdAt)
      .where(sql`${t.itemKey} is not null`),
  ],
);

export const automationRunSteps = pgTable(
  'automation_run_steps',
  {
    runId: text('run_id')
      .notNull()
      .references(() => automationRuns.id),
    idx: integer('idx').notNull(),
    stepId: text('step_id').notNull(),
    kind: text('kind').$type<AutomationStepKind>().notNull(),
    name: text('name').notNull(),
    state: text('state').$type<AutomationStepState>().notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    /** `<run>:<step>:<attempt>`: sent with external effects, recorded before they start. */
    idempotencyKey: text('idempotency_key'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    /** The durable timer of a wait, a retry backoff or a step deadline. */
    wakeAt: ts('wake_at'),
    deadlineAt: ts('deadline_at'),
    inputSummary: text('input_summary').notNull().default(''),
    output: jsonb('output').$type<JsonObject>().notNull().default({}),
    error: text('error'),
    dispatchId: text('dispatch_id'),
    approvalId: text('approval_id'),
    /** The message a dispatch was asked with (its result is what the agent posted after it). */
    promptMessageId: text('prompt_message_id'),
    messageIds: text('message_ids').array().notNull().default(sql`'{}'::text[]`),
    prNumber: integer('pr_number'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.idx] }),
    index('automation_run_steps_dispatch_idx').on(t.dispatchId),
    index('automation_run_steps_approval_idx').on(t.approvalId),
  ],
);

/** How far the trigger scan has read each burrow's signed events. */
export const automationCursors = pgTable('automation_cursors', {
  burrowId: text('burrow_id')
    .primaryKey()
    .references(() => burrows.id),
  seq: integer('seq').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

/** `http_callback` destinations the person approved (by publishing a version that calls them). */
export const automationDestinations = pgTable(
  'automation_destinations',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    url: text('url').notNull(),
    approvedById: text('approved_by_id').notNull(),
    approvedAt: ts('approved_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.burrowId, t.url] })],
);

/**
 * Plans the agent proposed in Chat (docs/decisions/automation-chat.md): a definition and the keys turning it on
 * gives, as posted on the plan's card, until the person turns it on, says not now, or a newer plan for the same
 * automation replaces it. At most one waits per automation.
 */
export const automationPlans = pgTable(
  'automation_plans',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    definition: jsonb('definition').$type<AutomationDefinition>().notNull(),
    definitionHash: text('definition_hash').notNull(),
    grants: jsonb('grants').$type<AutomationGrant[]>().notNull(),
    /** The live version it changes and the keys the automation held then; null for a new automation. */
    baseVersion: integer('base_version'),
    baseGrants: jsonb('base_grants').$type<AutomationGrant[]>(),
    /** “How I thought about it”: the agent's own points. */
    thinking: jsonb('thinking').$type<string[]>().notNull().default([]),
    status: text('status').$type<AutomationPlanStatus>().notNull().default('waiting'),
    /** Where its card is: the conversation, the thread and the card's message (set once posted). */
    conversationId: text('conversation_id').notNull(),
    threadRootId: text('thread_root_id'),
    messageId: text('message_id'),
    createdByDispatchId: text('created_by_dispatch_id'),
    decidedById: text('decided_by_id'),
    decidedAt: ts('decided_at'),
    /** The version turning it on made. */
    version: integer('version'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    index('automation_plans_automation_idx').on(t.automationId, t.createdAt),
    uniqueIndex('automation_plans_waiting_idx').on(t.automationId).where(sql`${t.status} = 'waiting'`),
  ],
);
