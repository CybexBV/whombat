/**
 * Tracker reports through automations (docs/decisions/report-trackers.md TA-01…TA-36): the poller's place per tracker
 * connection, the reports it mirrored once (the run's scope comes from the row, never the reporter's name or email), the
 * organization access a step was granted (sealed per run, step and attempt), and the replies and statuses people sent
 * through the tracker (deduped by the client's request id, so a retry posts its thread line once), and the feature
 * requests put to the person (TA-44).
 */
import type { FeatureDecisionChoice, FeatureRequestState, TrackerFixState } from '@whombat/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { automationRuns } from './automations';
import { ts } from './common';
import { catalogConnections } from './connections-catalog';
import { burrows } from './tenancy';

/**
 * The poller's place per tracker connection (TA-05, TA-06): the baseline (`since`, `after` = the highest report number
 * handled; both null until the first read, and again once no automation listens), and how the last reads went.
 */
export const trackerCursors = pgTable('tracker_cursors', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => catalogConnections.id, { onDelete: 'cascade' }),
  burrowId: text('burrow_id')
    .notNull()
    .references(() => burrows.id, { onDelete: 'cascade' }),
  since: ts('since'),
  after: bigint('after', { mode: 'number' }),
  checkedAt: ts('checked_at'),
  succeededAt: ts('succeeded_at'),
  /** `unreachable`, `invalid_answer` or `refused` (the last also marks the connection, TA-03). */
  problemCode: text('problem_code'),
  problem: text('problem'),
  /**
   * What the installation's `/v1/health` said last (0099, TA-32): its `environment` as the tracker said it (null: it
   * didn't; `trackerEnvironmentOf` reads the address then), its version, the source revision it runs when that is clean
   * (null: dirty or unknown, so it doesn't count, TA-30) and when it was read (at most once a minute).
   */
  healthEnvironment: text('health_environment'),
  healthVersion: text('health_version'),
  healthRevision: text('health_revision'),
  /** What it offers of the part released on its own (null: it didn't say), as its health said last. */
  healthSeparate: jsonb('health_separate').$type<{ version: string | null; revision: string | null }>(),
  healthCheckedAt: ts('health_checked_at'),
  updatedAt: ts('updated_at').notNull(),
});

/**
 * A new report, mirrored once (TA-07): what a run's `{{trigger.*}}` reads. Never the reporter's name or email, and the
 * long texts cut (description 8 000, expected 3 000).
 */
export const trackerItems = pgTable(
  'tracker_items',
  {
    /** `trp_…`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    /** The tracker's report id. */
    externalId: text('external_id').notNull(),
    /** What the tracker is called (its driver's `words.product` when it was mirrored): its runs' words name it. */
    product: text('product').notNull().default('the tracker'),
    number: bigint('number', { mode: 'number' }).notNull(),
    /** `bug` or `feature`. */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    organization: text('organization'),
    /** The tracker's id of the reporting organization (TA-60): its other reports are told by it, never by a name. */
    organizationId: text('organization_id'),
    /** `production` or `development` (from the diagnostics' origin), else null. */
    environment: text('environment'),
    version: text('version'),
    page: text('page'),
    browser: text('browser'),
    status: text('status').notNull(),
    priority: text('priority'),
    hasScreenshot: boolean('has_screenshot').notNull().default(false),
    /** It came with something to read beyond its text: recent actions, device diagnostics or linked packages. */
    hasDiagnostics: boolean('has_diagnostics').notNull().default(false),
    description: text('description').notNull().default(''),
    expected: text('expected').notNull().default(''),
    /** When the tracker says it was filed. */
    reportedAt: ts('reported_at'),
    mirroredAt: ts('mirrored_at').notNull(),
    /**
     * What the poller last saw of it (0099, TA-31): its status, the tracker's `updated_at`, how many messages the
     * reporter had written and when the last one was. Null until first seen: then it is the baseline and nothing fires.
     */
    seenStatus: text('seen_status'),
    seenUpdatedAt: ts('seen_updated_at'),
    seenReporterMessages: integer('seen_reporter_messages'),
    seenReporterAt: ts('seen_reporter_at'),
  },
  (t) => [
    uniqueIndex('tracker_items_connection_idx').on(t.connectionId, t.externalId),
    index('tracker_items_number_idx').on(t.connectionId, t.number),
  ],
);

/**
 * Read access to a report's organization for one attempt of an agent step (TA-10): the token the tracker granted,
 * sealed with AAD `tracker_grant:<runId>:<stepId>:<attempt>:token`; or, without a token, why it is unavailable.
 */
export const trackerGrants = pgTable(
  'tracker_grants',
  {
    runId: text('run_id')
      .notNull()
      .references(() => automationRuns.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    attempt: integer('attempt').notNull(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id').notNull(),
    /** The tracker's report id. */
    reportId: text('report_id').notNull(),
    /** Null: unavailable (`reason` says why). */
    tokenSealed: text('token_sealed'),
    reason: text('reason'),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    organizationId: text('organization_id'),
    expiresAt: ts('expires_at'),
    calls: integer('calls').notNull().default(0),
    createdAt: ts('created_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.stepId, t.attempt] }),
    index('tracker_grants_open_idx')
      .on(t.connectionId)
      .where(sql`${t.revokedAt} is null and ${t.tokenSealed} is not null`),
  ],
);

/**
 * A reply or status a person sent to a run's report through its tracker (TA-15), by the client's request id: a retry
 * after a lost answer finds it and posts no second thread line (the tracker replays the request id itself).
 */
export const trackerUpdates = pgTable('tracker_updates', {
  requestId: text('request_id').primaryKey(),
  burrowId: text('burrow_id')
    .notNull()
    .references(() => burrows.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  byId: text('by_id').notNull(),
  messageId: text('message_id').notNull(),
  createdAt: ts('created_at').notNull(),
});

/** A production release Whombat started for a fix: the T3 Code thread doing it, and how it ended when not live. */
export interface TrackerFixRelease {
  /** The T3 Code connection and thread running the repository's own release procedure (neither: it couldn't start). */
  t3ConnectionId?: string;
  threadId?: string;
  /** The revision it releases: what development ran with the fix. */
  revision: string;
  startedAt: string;
  /** When it ended without production running the fix (it stopped, asked something, or took too long), and why. */
  stoppedAt?: string;
  why?: string;
  /** Which try for the fix this is (1 when absent): a stopped one is tried again for a newer development revision. */
  attempt?: number;
  /** The thread's timeline length when Whombat last saw it move, and when: how long it hasn't moved. */
  seenItems?: number;
  seenAt?: string;
  /** When Whombat asked the quiet thread where it stands, while that question is unanswered. */
  nudgedAt?: string;
  /** When the person heard that it hasn't moved for a long while (it is still followed). */
  slowToldAt?: string;
  /** A development revision GitHub said doesn't hold the fix, so a stopped release isn't tried for it. */
  devChecked?: string;
  /**
   * The thread's run when it stopped: a later run (someone wrote to the thread, or T3 Code woke it) means it went on,
   * and Whombat follows it again instead of starting another.
   */
  stoppedRun?: string;
  /** How often its thread went on after a stop: each stop after that reaches the person again. */
  revivals?: number;
  /**
   * Another fix of the same repository whose release was under way when this one was due: this one waits for it (no
   * thread yet) and starts only if production then still lacks the fix.
   */
  behind?: string;
  /**
   * It waits for the chosen reporters' other reports still being fixed (no thread yet), so one release takes them all to
   * production; two hours at most after it reached development (`startedAt`).
   */
  held?: boolean;
  /** When Whombat settled its thread in T3 Code, or stopped trying: its fix is live, so the thread is over. */
  settledAt?: string;
  /**
   * The threads of earlier tries that a newer one replaced, each with when it did, until Whombat settled them in T3 Code
   * (`trackers/release.ts` `settleReleaseThread`).
   */
  earlier?: { t3ConnectionId: string; threadId: string; from: string }[];
}

/**
 * The fix Whombat follows for a report (0099, TA-29…TA-33): a pull request a tracker run's step opened or found (or a
 * person's, whose description names the report), from open to merged to live where the customer is. Outside the run: a
 * production release may take weeks. Each stage's notice has its own request id, so the customer hears it once.
 */
export const trackerFixes = pgTable(
  'tracker_fixes',
  {
    /** `tfx_…`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The report's connection (no foreign key: a connection that goes stops the fix, `stopped`). */
    connectionId: text('connection_id').notNull(),
    /** The tracker's report id and number. */
    reportId: text('report_id').notNull(),
    number: bigint('number', { mode: 'number' }).notNull(),
    /** The run whose thread hears about it, and its pull request step (null: a person's pull request). */
    runId: text('run_id'),
    stepIdx: integer('step_idx'),
    automationId: text('automation_id'),
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    prUrl: text('pr_url'),
    /** `bug` or `feature`: which notice the customer gets. */
    kind: text('kind').notNull(),
    /** The customer's language (ISO 639-1; '' unknown) and how the notices are signed (“Dusty - AI Developer”). */
    language: text('language').notNull().default(''),
    signature: text('signature').notNull().default(''),
    /** `TrackerFixState`. */
    state: text('state').$type<TrackerFixState>().notNull().default('open'),
    mergeSha: text('merge_sha'),
    mergedAt: ts('merged_at'),
    developmentHost: text('development_host'),
    developmentVersion: text('development_version'),
    developmentAt: ts('development_at'),
    productionHost: text('production_host'),
    productionVersion: text('production_version'),
    productionAt: ts('production_at'),
    /** The revision each installation ran when it was last found without the fix (compared again once it moves). */
    developmentChecked: text('development_checked'),
    productionChecked: text('production_checked'),
    /** Each stage's notice request id (the tracker replays it: sent once). */
    developmentRequestId: text('development_request_id'),
    productionRequestId: text('production_request_id'),
    /** Why it stopped, or why the customer wasn't told. */
    note: text('note'),
    /**
     * Whether it changes what the tracker releases on its own (the driver's `releasedSeparately`): `only` that (docs and
     * what reaches no customer aside), `also` that and more, `none`; null when not known yet (merged before it was kept).
     */
    separate: text('separate').$type<'only' | 'also' | 'none'>(),
    /**
     * The production release Whombat started for it, for a reporter whose fixes go straight to production
     * (`trackers/release.ts`): null when none was started.
     */
    release: jsonb('release').$type<TrackerFixRelease>(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('tracker_fixes_pr_idx').on(t.connectionId, t.reportId, t.repo, t.prNumber),
    index('tracker_fixes_report_idx').on(t.connectionId, t.reportId),
    index('tracker_fixes_followed_idx')
      .on(t.burrowId)
      .where(sql`${t.state} in ('open', 'merged', 'development')`),
  ],
);

/**
 * What a report's customer wrote back (0099, TA-31): the new messages a `reporter_replied` run's `trigger.text` quotes,
 * kept here so the signed `tracker.reporter_replied` carries ids only (as TA-07). `wrote`, `reopened` or `confirmed`.
 */
export const trackerReplies = pgTable('tracker_replies', {
  /** `trr_…`. */
  id: text('id').primaryKey(),
  burrowId: text('burrow_id')
    .notNull()
    .references(() => burrows.id, { onDelete: 'cascade' }),
  reportRowId: text('report_row_id')
    .notNull()
    .references(() => trackerItems.id, { onDelete: 'cascade' }),
  event: text('event').$type<'wrote' | 'reopened' | 'confirmed'>().notNull(),
  /** The customer's new messages, oldest first, cut (never in a signed event). */
  text: text('text').notNull().default(''),
  /** The report's status then. */
  status: text('status').notNull(),
  createdAt: ts('created_at').notNull(),
});

/**
 * A feature request put to the person (0022, TA-44, TA-45): what the card shows — the agent's value and why, its two
 * drafts and its reason, the signature they go out with — and what the person answered. One per `tracker_decision` step
 * attempt; a newer one for the same report replaces a waiting one.
 */
export const featureRequests = pgTable(
  'feature_requests',
  {
    /** `tfr_…`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => automationRuns.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    attempt: integer('attempt').notNull(),
    automationId: text('automation_id').notNull(),
    /** The report's connection (no foreign key, as `tracker_fixes`) and its label then, its id, number, title and organization. */
    connectionId: text('connection_id').notNull(),
    connection: text('connection').notNull(),
    reportId: text('report_id').notNull(),
    number: bigint('number', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    organization: text('organization'),
    /** The agent's name, its value (1–10) and why, its sentence, importance and size. */
    agent: text('agent').notNull(),
    value: integer('value'),
    valueWhy: text('value_why').notNull().default(''),
    summary: text('summary').notNull().default(''),
    importance: text('importance').notNull(),
    size: text('size').notNull(),
    /** The drafts, unsigned, and the signature they go out with (“Dusty - AI Assistant”). */
    approvedReply: text('approved_reply').notNull().default(''),
    declinedReply: text('declined_reply').notNull().default(''),
    declineReason: text('decline_reason').notNull().default(''),
    signature: text('signature').notNull(),
    canBuild: boolean('can_build').notNull().default(false),
    state: text('state').$type<FeatureRequestState>().notNull().default('waiting'),
    choice: text('choice').$type<FeatureDecisionChoice>(),
    /** The person's own reason (decline) or question (ask). */
    note: text('note'),
    decidedById: text('decided_by_id'),
    decidedAt: ts('decided_at'),
    /** The card's message in the run's thread. */
    messageId: text('message_id'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('feature_requests_step_idx').on(t.runId, t.stepId, t.attempt),
    index('feature_requests_report_idx').on(t.connectionId, t.reportId, t.createdAt),
    index('feature_requests_waiting_idx').on(t.burrowId).where(sql`${t.state} = 'waiting'`),
  ],
);
