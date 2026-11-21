/**
 * GitHub integration state (docs/decisions/github-gh.md): which burrows are connected through the host's gh,
 * GitHub logins mapped to principals, push grants (which agent a push through the host account was for),
 * the poller's cursors and what it already mirrored, and deploy workflow runs waiting to finish.
 */
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
import { ts } from './common';
import { burrows } from './tenancy';

/**
 * A burrow connected to GitHub through the host's gh (the person connected it). `login` is the gh account at
 * that moment; null for connections carried over from the removed GitHub App (migration 0007).
 */
export const githubConnections = pgTable('github_connections', {
  burrowId: text('burrow_id')
    .primaryKey()
    .references(() => burrows.id),
  login: text('login'),
  githubUserId: bigint('github_user_id', { mode: 'number' }),
  /** The person who connected it (joins branch rooms nobody else is known in). */
  connectedById: text('connected_by_id').notNull(),
  connectedAt: ts('connected_at').notNull().defaultNow(),
});

/** A GitHub login that is a principal of the burrow (the person links theirs; agents' commits map by email). */
export const githubIdentities = pgTable(
  'github_identities',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    /** Lowercase login. */
    login: text('login').notNull(),
    principalId: text('principal_id').notNull(),
    githubUserId: bigint('github_user_id', { mode: 'number' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.burrowId, t.login] }),
    uniqueIndex('github_identities_principal_idx').on(t.burrowId, t.principalId),
  ],
);

/**
 * Push credentials handed to an agent's runner. Every push goes out as the host's gh account; a live grant
 * whose `sha` is the head GitHub reports says which agent pushed it.
 */
export const githubPushGrants = pgTable(
  'github_push_grants',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id').notNull(),
    repo: text('repo').notNull(),
    branch: text('branch').notNull(),
    agentId: text('agent_id').notNull(),
    dispatchId: text('dispatch_id'),
    onBehalfOf: jsonb('on_behalf_of').$type<{ text?: string; principalId?: string }>(),
    /** The commit the runner said it was pushing (lowercase); null from runners that did not say. */
    sha: text('sha'),
    issuedAt: ts('issued_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('github_push_grants_branch_idx').on(t.burrowId, t.repo, t.branch)],
);

/**
 * The poller's place in one repo of one burrow: when it started watching (`baselineAt`), the ETags of its
 * last successful reads (a 304 costs no rate limit), the open PRs the burrow already had then (their older
 * reviews are not posted again) and how the last poll went.
 */
export const githubPollCursors = pgTable(
  'github_poll_cursors',
  {
    burrowId: text('burrow_id').notNull(),
    repo: text('repo').notNull(),
    baselineAt: ts('baseline_at').notNull(),
    /** Request key (`pulls:1`, `checks:<n>:<sha>`, `reviews:<n>:<page>`, `branch:<name>`, `runs`) → ETag. */
    etags: jsonb('etags').$type<Record<string, string>>().notNull().default({}),
    /** Open PR numbers the burrow knew when the poller started (their reviews before then are history). */
    knownPrs: jsonb('known_prs').$type<number[]>().notNull().default([]),
    /** Last read that ignored ETags (a periodic full refresh). */
    refreshedAt: ts('refreshed_at'),
    polledAt: ts('polled_at'),
    error: text('error'),
    /**
     * Since when the repo's issues are watched (an automation listens to new issues there; automation-recipes.md): the
     * first read is the baseline, issues already open then never start anything. Null while nothing listens.
     */
    issuesSince: ts('issues_since'),
    /** The highest issue or pull request number known at the baseline: only higher numbers are new issues. */
    issuesAfter: integer('issues_after'),
  },
  (t) => [primaryKey({ columns: [t.burrowId, t.repo] })],
);

/**
 * GitHub issues the poller mirrored (automation-recipes.md): one row per new issue of a watched repo, written with its
 * signed `issue.opened` event, so polling again changes nothing. No room post: automations are what read them.
 */
export const githubIssues = pgTable(
  'github_issues',
  {
    /** `ghi_…` (core has no id kind for it; ids follow `newId`'s shape). */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** Cut to 8 KB. */
    body: text('body').notNull().default(''),
    authorLogin: text('author_login'),
    authorBot: boolean('author_bot').notNull().default(false),
    /**
     * GitHub's `author_association` of whoever opened it (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, …; null: unknown or
     * mirrored before 0096): `trigger.trusted` (automation-recipes.md AR-27).
     */
    authorAssociation: text('author_association'),
    /** The logins assigned to it when it was mirrored (`trigger.assigned`; the auto-fix gate reads them again). */
    assignees: text('assignees').array().notNull().default(sql`'{}'::text[]`),
    url: text('url').notNull(),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    state: text('state').$type<'open' | 'closed'>().notNull().default('open'),
    openedAt: ts('opened_at').notNull(),
    /** When the poller mirrored it. */
    seenAt: ts('seen_at').notNull(),
  },
  (t) => [uniqueIndex('github_issues_number_idx').on(t.burrowId, t.repo, t.number)],
);

/** The last head the mirror recorded per branch (pushes are mirrored once; branches without a PR too). */
export const githubBranchHeads = pgTable(
  'github_branch_heads',
  {
    burrowId: text('burrow_id').notNull(),
    repo: text('repo').notNull(),
    branch: text('branch').notNull(),
    sha: text('sha').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.burrowId, t.repo, t.branch] })],
);

/** GitHub objects the mirror already turned into burrow state (`review:<id>`): never twice. */
export const githubSeen = pgTable(
  'github_seen',
  {
    burrowId: text('burrow_id').notNull(),
    repo: text('repo').notNull(),
    key: text('key').notNull(),
    seenAt: ts('seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.burrowId, t.repo, t.key] })],
);

/** A deploy approval running as a GitHub Actions `workflow_dispatch`, completed when the poller sees its run end. */
export const githubDeploys = pgTable(
  'github_deploys',
  {
    approvalId: text('approval_id').primaryKey(),
    burrowId: text('burrow_id').notNull(),
    repo: text('repo').notNull(),
    workflow: text('workflow').notNull(),
    ref: text('ref').notNull(),
    environment: text('environment').notNull(),
    /** `dispatched` | `running` | `succeeded` | `failed` */
    state: text('state').notNull().default('dispatched'),
    runId: bigint('run_id', { mode: 'number' }),
    runUrl: text('run_url'),
    dispatchedAt: ts('dispatched_at').notNull(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('github_deploys_open_idx')
      .on(t.repo, t.workflow)
      .where(sql`${t.state} in ('dispatched', 'running')`),
  ],
);

/**
 * A repository's own icon as the Chat list shows it (docs/decisions/chat-inbox.md): what the last look in its default
 * branch found, kept per burrow so GitHub is asked about a repository at most about once a day. `repo` is the
 * lowercase `owner/name`. `attachmentId` is the stored picture (a ready image attachment without a conversation, read
 * by anyone in the burrow), null when the repository has none that fits; `blobSha` is GitHub's id of the file it came
 * from, so the same picture isn't downloaded again. A look that failed (no connection, a rate limit, a timeout)
 * writes nothing and is tried again later.
 */
export const repoIcons = pgTable(
  'repo_icons',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    attachmentId: text('attachment_id'),
    path: text('path'),
    blobSha: text('blob_sha'),
    checkedAt: ts('checked_at').notNull(),
    nextCheckAt: ts('next_check_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.burrowId, t.repo] }),
    index('repo_icons_attachment_idx').on(t.attachmentId).where(sql`${t.attachmentId} is not null`),
  ],
);
