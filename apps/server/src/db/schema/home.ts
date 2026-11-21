/**
 * One Whombat's Home (docs/decisions/one-whombat.md ONE-05, ONE-08…ONE-10; one-whombat-assistant.md ONE-DW…), migration
 * 0104: the changes Whombat made (Done recently, Undo), the widgets pinned on a person's Home and their points, and a
 * person's snoozes of Needs you and Watch items.
 */
import type { CareAutomationKind, CareStepId, LookResearchState } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ChangeLink, WidgetSeries, WidgetSource } from '../../home/types';
import { ts } from './common';
import { conversations, messages } from './conversations';
import { principals } from './principals';
import { burrows } from './tenancy';

/** A line a research covers, as Whombat words it: its check and item ('' the thing as a whole), its kind. */
export interface LookLineRow {
  check: string | null;
  subject: string;
  title: string;
  nature: 'problem' | 'you' | null;
}

/** A step of a research's plan: as its card says it (`text`) and in the assistant's own words (`step`, never shown). */
export interface LookPlanStepRow {
  text: string;
  step: string;
  /** A care plan's step (care-plan.md), in Whombat's words. */
  care?: CareStepId;
  /**
   * The automation Whombat turns on for it when the person says go ahead, written by Whombat (never the assistant) with
   * the quiet hours of that moment.
   */
  automation?: {
    kind: CareAutomationKind;
    server: { id: string; name: string; self: boolean };
    guests?: string[];
  };
}

/**
 * The care plan a research may offer (docs/decisions/care-plan.md): Whombat's defaults for the server, written when the
 * research began. `new`: the server was just added and the research proposes how the assistant looks after it.
 */
export interface LookCareRow {
  new: boolean;
  steps: LookPlanStepRow[];
}

/**
 * One change made through a tool (ONE-08). `undo_enc` is the inverse's recipe sealed with key custody (AAD
 * `change:<id>:undo`, `home/registry.ts`): it can hold old values read from a connected service.
 */
export const changes = pgTable(
  'changes',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** Who made it: the Whombat (an agent) or a person. */
    actorId: text('actor_id').notNull(),
    /** The Whombat that made it, if an agent did. */
    agentId: text('agent_id'),
    /** The person it was made for (one-person.md OP-S40). */
    personId: text('person_id'),
    /** What changed, for the undoer registry: `connection.call`, `hosts.guest_power`, `device.action` … */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    subjectKind: text('subject_kind'),
    subjectId: text('subject_id'),
    subjectName: text('subject_name'),
    /** The registered undoer that reverses it; null: no undo. */
    undoKind: text('undo_kind'),
    undoEnc: text('undo_enc'),
    /** Undo is offered until then (null: as long as the change is shown). */
    undoUntil: ts('undo_until'),
    link: jsonb('link').$type<ChangeLink>(),
    /** The chat it was made in, if any. */
    conversationId: text('conversation_id'),
    /** The thread of that chat it was made in (chat-channel.md CHT-08, migration 0116); null: the top level. */
    threadRootId: text('thread_root_id'),
    undoneAt: ts('undone_at'),
    undoneById: text('undone_by_id'),
    /** The change that undid it (the inverse, recorded as a change of its own). */
    undoChangeId: text('undo_change_id'),
    /**
     * Settings saved in a row (home-redesign.md HR-06, migration 0111): what a later save of the same thing by the same
     * actor merges on (`hosts.server_settings:<server>:`), and the fields changed so far (for the title). Null: never
     * merges.
     */
    mergeKey: text('merge_key'),
    mergeFields: jsonb('merge_fields').$type<string[]>(),
    /** A person pressed Undo on a reported change and the agent was asked to put it back (HR-03), and who. */
    undoAskedAt: ts('undo_asked_at'),
    undoAskedById: text('undo_asked_by_id'),
    /** When it was made, or last merged into (HR-06). */
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    index('changes_burrow_idx').on(t.burrowId, t.createdAt),
    index('changes_subject_idx').on(t.burrowId, t.subjectKind, t.subjectId, t.createdAt),
  ],
);

/**
 * A task the agent finished (docs/decisions/done-today.md DN-02, migration 0011): its own few words of what it did
 * (`report_done`), one row per thread, a later report replacing the words and the time. The desk's *Done today* and
 * *Welcome back* read these. Rows older than 30 days go when the next one is reported.
 */
export const doneTasks = pgTable(
  'done_tasks',
  {
    /** `done_…`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** The person the turn was for. */
    personId: text('person_id').references(() => principals.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** The thread it was done in; null: the top of a flat conversation. */
    threadRootId: text('thread_root_id').references(() => messages.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    /** The turn that reported it last. */
    dispatchId: text('dispatch_id'),
    reportedAt: ts('reported_at').notNull(),
  },
  (t) => [
    // One per thread; the top of a conversation is one place too.
    uniqueIndex('done_tasks_thread_idx').on(t.conversationId, sql`coalesce(${t.threadRootId}, '')`),
    index('done_tasks_burrow_idx').on(t.burrowId, t.reportedAt),
  ],
);

/** A widget pinned on a person's Home (ONE-09): refreshed by the server from `source`, without the model. */
export const widgets = pgTable(
  'widgets',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** Whose Home it is on. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** The Whombat that pinned it. */
    agentId: text('agent_id'),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    kind: text('kind').$type<'line'>().notNull().default('line'),
    source: jsonb('source').$type<WidgetSource>().notNull(),
    series: jsonb('series').$type<WidgetSeries[]>().notNull(),
    refreshSec: integer('refresh_sec').notNull().default(300),
    position: integer('position').notNull().default(0),
    fromConversationId: text('from_conversation_id'),
    /** The last refresh's failure in plain words; null when it worked. */
    lastError: text('last_error'),
    refreshedAt: ts('refreshed_at'),
    createdAt: ts('created_at').notNull(),
    /**
     * Kept on a thing's page instead of Home (connection-pages.md CP-14, migration 0110): `connection:con_…`,
     * `device:…`, `server:<id>`. Null: on Home.
     */
    thingId: text('thing_id'),
  },
  (t) => [
    index('widgets_owner_idx').on(t.burrowId, t.ownerId, t.position),
    index('widgets_thing_idx').on(t.ownerId, t.thingId),
  ],
);

/** A widget's values at one refresh (24 hours are kept). */
export const widgetPoints = pgTable(
  'widget_points',
  {
    widgetId: text('widget_id')
      .notNull()
      .references(() => widgets.id, { onDelete: 'cascade' }),
    t: ts('t').notNull(),
    values: jsonb('values').$type<Record<string, number | null>>().notNull(),
  },
  (t) => [primaryKey({ name: 'widget_points_pk', columns: [t.widgetId, t.t] })],
);

/**
 * A person's “Remind me tomorrow” / “Not now” on a Needs you or Watch item (ONE-10), or their acknowledgement of a
 * Watch item. `until` null with `snoozed`: until the item changes; `acknowledged`: seen, kept out of the badge.
 */
export const needsYouSnoozes = pgTable(
  'needs_you_snoozes',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    refKind: text('ref_kind').notNull(),
    refId: text('ref_id').notNull(),
    state: text('state').$type<'snoozed' | 'acknowledged' | 'ignored'>().notNull().default('snoozed'),
    until: ts('until'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [primaryKey({ name: 'needs_you_snoozes_pk', columns: [t.personId, t.refKind, t.refId] })],
);

/**
 * What the assistant found out about a look (docs/decisions/look-research.md LR-01…LR-09; migration 0012): one row per
 * look the assistant looked into by itself, kept while the look stays (`gone_at` null) and as history after. A look that
 * comes back, gets worse or whose line changes is a new row. Every change is signed through the pipeline
 * (`looks/research.ts`); the signed events carry ids, never the words.
 */
export const lookResearches = pgTable(
  'look_researches',
  {
    /** `lkr_…`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** The person it was looked into for. */
    personId: text('person_id').references(() => principals.id, { onDelete: 'set null' }),
    /** The look's key (`DeskLook.key`): `server:pve-02`, `connection:con_…`. */
    lookKey: text('look_key').notNull(),
    kind: text('kind').$type<'server' | 'connection' | 'device'>().notNull(),
    name: text('name').notNull(),
    /** The line behind the look: its check (null: none known) and its item ('' the thing as a whole). */
    checkId: text('check_id'),
    subject: text('subject').notNull().default(''),
    /** How bad, the worst seen while it lasts: 0 down, 1 in trouble, 2 to look at. */
    rank: integer('rank').notNull(),
    /** Whombat's own words for it when it began: the screen's reason and the line's question (data for the turn). */
    reason: text('reason'),
    question: text('question'),
    /** Since when the look was there, when Whombat knows. */
    since: ts('since'),
    /** `LookResearchState`. */
    state: text('state').$type<LookResearchState>().notNull(),
    /** The assistant's words (`look_report`), one line each. */
    title: text('title'),
    summary: text('summary'),
    /** The step it offers: the button's label and the step in its own words (never shown); kept while it takes it. */
    fixLabel: text('fix_label'),
    fixStep: text('fix_step'),
    /** The thread of the person's Chat it looks into it in. */
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    threadRootId: text('thread_root_id').references(() => messages.id, { onDelete: 'set null' }),
    /** The turn on it now: the research's, then the step's. */
    dispatchId: text('dispatch_id'),
    startedAt: ts('started_at').notNull(),
    /** When its state last changed (`LookResearch.at`). */
    stateAt: ts('state_at').notNull(),
    /** When the assistant last reported. */
    reportedAt: ts('reported_at'),
    /** When the look went, or changed into a new problem: the row is history from then on. */
    goneAt: ts('gone_at'),
    /**
     * Every line it covers (handle-it.md): the thing's problems and only-you lines when it began, as Whombat words them;
     * a line not among them is a new problem. Empty on a row from before: only its own line is known.
     */
    lines: jsonb('lines').$type<LookLineRow[]>().notNull().default([]),
    /** The plan it offers (`look_report`'s steps), kept while it takes it and after, for its card. */
    plan: jsonb('plan').$type<LookPlanStepRow[] | null>(),
    /** The person who asked (*Ask {assistant} to handle these*); null when it looked by itself. */
    askedById: text('asked_by_id').references(() => principals.id, { onDelete: 'set null' }),
    /** The plan's card in the thread, posted with the first plan. */
    planMessageId: text('plan_message_id').references(() => messages.id, { onDelete: 'set null' }),
    /** When the finding was pushed to the person (once per research). */
    pushedAt: ts('pushed_at'),
    /** The care plan it may offer (care-plan.md); null: none. */
    care: jsonb('care').$type<LookCareRow | null>(),
  },
  (t) => [
    // One research per look while it stays (LR-02).
    uniqueIndex('look_researches_live_idx').on(t.burrowId, t.lookKey).where(sql`${t.goneAt} is null`),
    // The day's budget (LR-03) and the history's pruning.
    index('look_researches_burrow_idx').on(t.burrowId, t.startedAt),
    index('look_researches_dispatch_idx').on(t.dispatchId),
    // Whether a message's thread is a look's (its replies stay quiet, LR-04).
    index('look_researches_thread_idx').on(t.threadRootId),
  ],
);

export type LookResearchRow = typeof lookResearches.$inferSelect;
