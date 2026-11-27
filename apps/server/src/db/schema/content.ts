/** Canvases (+ comments, Yjs snapshot), dispatches, notifications, devices, search documents and answers. */
import type {
  AnswerAction,
  AnswerStatus,
  CanvasProvenance,
  ChatRuntime,
  CommentAnchor,
  DevicePlatform,
  DispatchMode,
  DispatchState,
  DispatchTrigger,
  LinkRef,
  NotificationKind,
  PushProvider,
  SearchResultType,
  Tone,
  TurnFailureCode,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, serial, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { StoredUsage } from '../../domain/cache-result';
import { bytea, ts, tsvector } from './common';
import { accounts, burrows } from './tenancy';

export const canvases = pgTable(
  'canvases',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    conversationId: text('conversation_id'),
    planId: text('plan_id'),
    provenance: jsonb('provenance').$type<CanvasProvenance>().notNull(),
    /** Initial / exported Markdown body (seed content; the Yjs document takes over once edited). */
    markdown: text('markdown').notNull().default(''),
    /** Yjs document snapshot (`Y.encodeStateAsUpdate`), written by the collaboration server later. */
    ydoc: bytea('ydoc'),
    ydocUpdatedAt: ts('ydoc_updated_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('canvases_slug_idx').on(t.burrowId, t.slug)],
);

export const canvasComments = pgTable(
  'canvas_comments',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id),
    burrowId: text('burrow_id').notNull(),
    anchor: jsonb('anchor').$type<CommentAnchor>(),
    parentId: text('parent_id'),
    authorId: text('author_id').notNull(),
    text: text('text').notNull(),
    resolved: boolean('resolved').notNull().default(false),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('canvas_comments_canvas_idx').on(t.canvasId, t.createdAt)],
);

export interface DispatchSearch {
  query: string;
  answerId: string;
}

/** Work queued for an agent (mentions, DMs, search answers). The runner claims these later. */
/** `dispatches.failure` (EA-08). */
export interface DispatchFailure {
  code: TurnFailureCode;
  /** The public sentence (`turnFailureText`), as posted. */
  reason: string;
  /** `usage_limit`: when the limit resets, ISO. */
  resetsAt?: string | null;
  /** The agent's failure message with the `turn_failed` card; null when none was posted. */
  messageId: string | null;
  /**
   * The technical detail (the runner's error and refusal, `turnFailureDetail`: redacted, ≤ 2000) for the person in the
   * Work view only; absent on older rows (`dispatches.error` then).
   */
  detail?: string | null;
  retriedAt: string | null;
  retryDispatchId: string | null;
}

/**
 * `dispatches.waits_on` (docs/decisions/outsiders-turns.md): the T3 Code thread an automation step's turn handed its wait to
 * Whombat for, so the turn could end while another outsiders' turn waited for the profile.
 */
export interface DispatchWaitsOn {
  connectionId: string;
  threadId: string;
  /** Whether the wait also covers the thread's delegated work (`untilDelegatedWorkSettled`). */
  settled: boolean;
  /** When the turn handed it over, ISO. */
  at: string;
}

export const dispatches = pgTable(
  'dispatches',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    agentId: text('agent_id').notNull(),
    trigger: text('trigger').$type<DispatchTrigger>().notNull(),
    mode: text('mode').$type<DispatchMode>().notNull().default('reply'),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id'),
    threadRootId: text('thread_root_id'),
    runId: text('run_id'),
    state: text('state').$type<DispatchState>().notNull().default('queued'),
    providerSessionId: text('provider_session_id'),
    /**
     * The names of the tools Whombat served a chat turn when it was claimed (runtime/sessions.ts): Hermes keeps the tools a
     * session began with, so a turn that would get one more starts a fresh session.
     */
    servedTools: text('served_tools').array(),
    runnerId: text('runner_id'),
    error: text('error'),
    search: jsonb('search').$type<DispatchSearch>(),
    /** sha256 of the per-dispatch agent token (MCP / runner phase). */
    tokenHash: text('token_hash').unique(),
    tokenExpiresAt: ts('token_expires_at'),
    createdAt: ts('created_at').notNull(),
    claimedAt: ts('claimed_at'),
    finishedAt: ts('finished_at'),
    /** Runner lease: renewed by progress / heartbeat; an expired lease requeues the dispatch (runtime). */
    leaseExpiresAt: ts('lease_expires_at'),
    /** Last progress heartbeat from the runner. */
    heartbeatAt: ts('heartbeat_at'),
    /** Times the dispatch was claimed; one retry after a crash, then it fails (runtime-server.md). */
    attempts: integer('attempts').notNull().default(0),
    /** Retry backoff: not claimable before this instant. */
    notBefore: ts('not_before'),
    /** Why the runner must stop the turn: `paused` | `taken_over` | `cancelled`. */
    cancelReason: text('cancel_reason').$type<'paused' | 'taken_over' | 'cancelled'>(),
    /** The person who pressed Stop on the turn (`dispatches.cancel`, docs/decisions/review-features.md RF-01). */
    stoppedById: text('stopped_by_id'),
    /**
     * Token usage and cost the provider reported for the turn (`CompleteBody.usage`), null when it reported
     * none. Read by context-usage display (B) and automation cost limits (C); an absent value is "unknown". Since
     * contracts 0.44.1 with the cache split and the largest call (PE-04); budgets count it as billed (`billedTokens`).
     * A resumed chat turn's prompt cache result rides along (`cacheResult`, PE-12; the server's, not the runner's).
     */
    usage: jsonb('usage').$type<StoredUsage>(),
    /** First time the turn posted, over all its attempts (`Dispatch.postedAt`). */
    postedAt: ts('posted_at'),
    /**
     * The person this work is for (CT-69 `DispatchCredential.onBehalfOfAccountId`, SUB-04): who asked; an
     * automation's publisher; for an agent chain, a follow-up, a retry or a resumed run, the person who started it;
     * null for work for nobody. Set when the dispatch is queued (`enqueueDispatches`).
     */
    onBehalfOfAccountId: text('on_behalf_of_account_id'),
    /** The plan step this turn was asked to do (work-supervision WS-04); a run it starts is linked to the step. */
    planId: text('plan_id'),
    planStepId: text('plan_step_id'),
    /**
     * The approval this turn carries on after (docs/decisions/essentials-agents.md EA-07): an `approval_granted` wake,
     * a queued turn that took the wake over, or a retry of one. Its context gets `grantedApproval`; one live turn per
     * approval.
     */
    approvalId: text('approval_id'),
    /** A `retry` turn: the failed dispatch it tries again (`DispatchContext.retry`, EA-09). */
    retryOfId: text('retry_of_id'),
    /**
     * Why the server queued this turn again by itself: `usage_limit` (resourceful-agents.md RA-32) — the failed turn
     * (`retry_of_id`) carries on a minute after its usage limit resets, once, unless a newer turn of the agent took over
     * there. Null for every other turn.
     */
    requeuedFor: text('requeued_for').$type<'usage_limit'>(),
    /**
     * Why the turn failed for good (EA-08): its classification and public sentence, the failure message that carries
     * the `turn_failed` card, and its retry (once). Null for turns that didn't fail.
     */
    failure: jsonb('failure').$type<DispatchFailure>(),
    /**
     * A `schedule` turn: the agent's schedule it runs (docs/decisions/resourceful-agents.md RA-30); its context gets
     * `DispatchContext.schedule`.
     */
    scheduleId: text('schedule_id'),
    /**
     * The AI gateway (docs/decisions/ai-gateway.md AIG-07): the provider whose switch was on when this turn was claimed
     * (`claude`, `codex`), so the turn keeps its route whatever the switch does meanwhile; the relay serves only this
     * provider for it. Null: the turn runs on its agent's own sign-in.
     */
    gatewayProvider: text('gateway_provider').$type<'claude' | 'codex'>(),
    /** The Fusebox account that last answered the turn (`x-fusebox-account`, AIG-09). */
    gatewayAccount: text('gateway_account'),
    /**
     * The model runtime the turn was resolved to (docs/decisions/chat-runtime.md CR-02; chat-runtime-server.md CR-S03,
     * migration 0118): its Chat thread's choice — provider, model, effort, fast — when it was queued, kept up to date
     * while it waits. The turn runs on its agent's runtime with these four taken from it; every reader of a turn's
     * provider reads it first (`turnProviderSql`). Null: the agent's own.
     */
    runtime: jsonb('runtime').$type<ChatRuntime>(),
    /**
     * An automation step's turn that ended while its T3 Code thread worked on (migration 0065): the thread the
     * engine waits for in its place before the step's next turn. Null for every other turn.
     */
    waitsOn: jsonb('waits_on').$type<DispatchWaitsOn>(),
  },
  (t) => [
    index('dispatches_queue_idx').on(t.state, t.createdAt),
    index('dispatches_agent_idx').on(t.agentId, t.conversationId, t.state),
    index('dispatches_run_idx').on(t.runId),
    // Spend windows (docs/decisions/spend.md SP-D02).
    index('dispatches_finished_idx').on(t.burrowId, t.finishedAt),
    index('dispatches_plan_idx').on(t.planId).where(sql`${t.planId} is not null`),
    // A plan step's turns (work-supervision WS-04).
    index('dispatches_plan_step_idx').on(t.planStepId).where(sql`${t.planStepId} is not null`),
    // One live turn per approval it carries on after (EA-07).
    index('dispatches_approval_idx').on(t.approvalId).where(sql`${t.approvalId} is not null`),
    index('dispatches_thread_idx')
      .on(t.conversationId, t.threadRootId, t.createdAt)
      .where(sql`${t.threadRootId} is not null`),
    // A schedule's queued turns (cancelled when it is paused or ends, RA-30).
    index('dispatches_schedule_idx').on(t.scheduleId).where(sql`${t.scheduleId} is not null`),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    principalId: text('principal_id').notNull(),
    kind: text('kind').$type<NotificationKind>().notNull(),
    actorId: text('actor_id').notNull(),
    where: text('where').notNull().default(''),
    text: text('text').notNull(),
    link: jsonb('link').$type<LinkRef>().notNull(),
    approvalId: text('approval_id'),
    createdAt: ts('created_at').notNull(),
    readAt: ts('read_at'),
    /** Notify once per key and recipient (WS-20): a step handed to someone, a step that became blocked. */
    dedupKey: text('dedup_key'),
    /**
     * The message the row is about (essentials-people.md EP-14): a row whose message the person has read in its
     * conversation, or that was deleted, stays out of the email.
     */
    messageId: text('message_id'),
    /** When the row went out in a notification email (EP-15); each row is emailed at most once. */
    emailedAt: ts('emailed_at'),
  },
  (t) => [
    index('notifications_principal_idx').on(t.principalId, t.createdAt),
    // The email digest's scan: unread rows not emailed yet, by age (EP-15).
    index('notifications_email_idx')
      .on(t.createdAt)
      .where(sql`${t.readAt} is null and ${t.emailedAt} is null`),
    uniqueIndex('notifications_dedup_idx')
      .on(t.principalId, t.dedupKey)
      .where(sql`${t.dedupKey} is not null`),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<DevicePlatform>().notNull(),
    provider: text('provider').$type<PushProvider>().notNull(),
    token: text('token').notNull(),
    webPush: jsonb('web_push').$type<{ p256dh: string; auth: string }>(),
    name: text('name'),
    liveActivityToken: text('live_activity_token'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at'),
  },
  (t) => [uniqueIndex('devices_token_idx').on(t.accountId, t.token)],
);

/** iOS live activity push tokens per device (run / approval). */
export const liveActivities = pgTable(
  'live_activities',
  {
    id: serial('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'run' | 'approval'>().notNull(),
    refId: text('ref_id').notNull(),
    pushToken: text('push_token').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('live_activities_ref_idx').on(t.deviceId, t.kind, t.refId)],
);

/**
 * Full-text search documents, kept in sync by the commit pipeline's post-commit hook. Hits are candidates
 * only: the search route re-authorizes each against the viewer's burrow and a decision's own rule.
 */
export const searchDocuments = pgTable(
  'search_documents',
  {
    /** Result id (the source entity id: `msg_…`, `run_…`, `pr_…`, `cvs_…`). */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    type: text('type').$type<SearchResultType>().notNull(),
    /** Conversation that gates visibility; null = visible in the whole burrow. */
    conversationId: text('conversation_id'),
    where: text('where').notNull().default(''),
    authorId: text('author_id').notNull(),
    text: text('text').notNull(),
    link: jsonb('link').$type<LinkRef>().notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    /** The pill a PLAN, DECISION or AUTOMATION result shows (“2 OF 4 DONE”, “DECLINED”); null for others (WS-21). */
    status: jsonb('status').$type<{ text: string; tone: Tone }>(),
    /**
     * English stems and the words as written (resourceful-agents.md RA-26, migration 0066): a Dutch word finds Dutch,
     * and an English query still finds what it found (`read/search.ts` asks both).
     */
    tsv: tsvector('tsv')
      .notNull()
      .generatedAlwaysAs(
        sql`to_tsvector('english', coalesce("where", '') || ' ' || "text") || to_tsvector('simple', coalesce("where", '') || ' ' || "text")`,
      ),
  },
  (t) => [
    index('search_documents_tsv_idx').using('gin', t.tsv),
    index('search_documents_burrow_idx').on(t.burrowId, t.type),
    // A search in one conversation (`in`), newest first, and its days (docs/decisions/search-pagination.md SRP-10).
    index('search_documents_conversation_idx').on(t.burrowId, t.conversationId, t.createdAt),
  ],
);

export const searchAnswers = pgTable(
  'search_answers',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    query: text('query').notNull(),
    agentId: text('agent_id').notNull(),
    askedById: text('asked_by_id').notNull(),
    status: text('status').$type<AnswerStatus>().notNull().default('pending'),
    text: text('text').notNull().default(''),
    citations: jsonb('citations').$type<{ n: number; resultId: string }[]>().notNull().default([]),
    durationMs: integer('duration_ms'),
    actions: jsonb('actions').$type<AnswerAction[]>().notNull().default([]),
    /**
     * The language the answer is written in (`en`, `nl`): asking again in another language gets a new answer, while
     * the old one stays readable by its id. Null for answers from before languages, which are English.
     */
    language: text('language'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('search_answers_query_idx').on(t.burrowId, t.askedById, t.query)],
);
