/** Connected repositories and pull requests (+ checks, reviewers, files, commits). */
import type { CheckState, DiffStat, PrState, ReviewState, TestCounts } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

export const repos = pgTable(
  'repos',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    fullName: text('full_name').notNull(),
    description: text('description').notNull().default(''),
    language: text('language'),
    defaultBranch: text('default_branch').notNull().default('main'),
    enabled: boolean('enabled').notNull().default(false),
    pushedAt: ts('pushed_at'),
    githubRepoId: bigint('github_repo_id', { mode: 'number' }),
    position: integer('position').notNull().default(0),
    /** `github`, or `local`: a repository created on this Whombat and kept by it (docs/decisions/repositories.md RP-01). */
    source: text('source').$type<'github' | 'local'>().notNull().default('github'),
    /** A `local` repo's bare origin (`<WHOMBAT_WORKSPACES>/.origins/<burrow>/<name>.git`), absolute; null for GitHub. */
    originPath: text('origin_path'),
    /** When a `local` repo was created; null for GitHub repos (they have `pushedAt`). */
    createdAt: ts('created_at'),
  },
  (t) => [uniqueIndex('repos_name_idx').on(t.burrowId, t.fullName)],
);

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id),
    number: integer('number').notNull(),
    branch: text('branch').notNull(),
    baseBranch: text('base_branch').notNull().default('main'),
    title: text('title').notNull(),
    state: text('state').$type<PrState>().notNull().default('open'),
    headSha: text('head_sha').notNull(),
    authorId: text('author_id'),
    diff: jsonb('diff').$type<DiffStat>().notNull().default({ add: 0, del: 0, files: 0 }),
    conversationId: text('conversation_id').notNull(),
    openedAt: ts('opened_at').notNull(),
    mergedAt: ts('merged_at'),
    mergedById: text('merged_by_id'),
    url: text('url'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    /**
     * Opened in Whombat while its repo was not connected to GitHub: GitHub has no such PR, and its number
     * may belong to another PR there. The poller leaves it alone (docs/decisions/github-gh.md, GP-04).
     */
    localOnly: boolean('local_only').notNull().default(false),
    /**
     * The head commit whose finished checks Whombat has handled: woke the agent whose work the pull request is, or
     * found nobody to wake. Each head's result reaches its agent once (docs/decisions/health-checks-wake.md HW-03).
     */
    checksHandledSha: text('checks_handled_sha'),
    /** A draft on GitHub (automation-recipes.md): `drafts: false` triggers wait until it is marked ready. */
    draft: boolean('draft').notNull().default(false),
    /** The GitHub login that opened it (null: Whombat's own, or mirrored before 0095). */
    authorLogin: text('author_login'),
    /** Opened by an account GitHub marks as a bot (`…[bot]`, Dependabot, Renovate). */
    authorBot: boolean('author_bot').notNull().default(false),
    /** Its description on GitHub, cut to 8 KB (what an automation's agent reads); null before 0095. */
    body: text('body'),
    /** GitHub's `author_association` of whoever opened it (null: unknown, or mirrored before 0096; AR-27). */
    authorAssociation: text('author_association'),
    /** The logins assigned to it on GitHub, as last mirrored (0096). */
    assignees: text('assignees').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [uniqueIndex('pull_requests_number_idx').on(t.repoId, t.number)],
);

export const prChecks = pgTable(
  'pr_checks',
  {
    prId: text('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    name: text('name').notNull(),
    state: text('state').$type<CheckState>().notNull(),
    note: text('note').notNull().default(''),
    durationMs: integer('duration_ms'),
    tests: jsonb('tests').$type<TestCounts>(),
    url: text('url'),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.prId, t.name] })],
);

export const prReviewers = pgTable(
  'pr_reviewers',
  {
    prId: text('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    principalId: text('principal_id').notNull(),
    state: text('state').$type<ReviewState>().notNull().default('pending'),
    at: ts('at'),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.prId, t.principalId] })],
);

export const prFiles = pgTable(
  'pr_files',
  {
    prId: text('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    path: text('path').notNull(),
    add: integer('add').notNull(),
    del: integer('del').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.prId, t.path] })],
);

export const prCommits = pgTable(
  'pr_commits',
  {
    prId: text('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    sha: text('sha').notNull(),
    message: text('message').notNull(),
    authorId: text('author_id'),
    at: ts('at').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.prId, t.sha] })],
);
