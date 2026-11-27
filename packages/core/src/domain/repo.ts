import { z } from 'zod';
import { coreWords } from '../i18n/catalog.js';
import { BurrowId, ConversationId, PrincipalId, PullRequestId, RepoId } from '../ids.js';
import { DiffStat, FileChange, TestCounts, Timestamp, type Tone } from './common.js';

/**
 * Where a repo lives (CT-192): `github` — a GitHub repository; `local` — a Git repository created on this Whombat
 * (`repos.create`) and kept there, with no GitHub behind it (no pull requests, checks or polling).
 */
export const RepoSource = z.enum(['github', 'local']);
export type RepoSource = z.infer<typeof RepoSource>;

/**
 * The name of a repository created on this Whombat (CT-192): the folder agents check it out in and the second half of
 * its `local/<name>` full name. Letters, digits, `_`, `.` and `-`; doesn't start with `.` or `-`; not `*.git`.
 */
export const LocalRepoName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, 'Use letters, digits, _, . and -, starting with a letter or digit.')
  .refine((name) => !/\.git$/i.test(name), 'A name can’t end in .git.');
export type LocalRepoName = z.infer<typeof LocalRepoName>;

/** The owner half of a local repo's full name (`local/Whombat_Website`, CT-192). */
export const LOCAL_REPO_OWNER = 'local';

/**
 * A repository of the burrow: a GitHub repository (every one the connected account owns, and others the agent named) or
 * one created on this Whombat.
 */
export const Repo = z.object({
  id: RepoId,
  burrowId: BurrowId,
  /** `whombat/billing`; a repo created on this Whombat is `local/<name>` (CT-192). */
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  description: z.string().max(280),
  /** "TypeScript" — shown as "TypeScript · updated 2 hours ago". */
  language: z.string().max(40).nullable(),
  defaultBranch: z.string().min(1).max(255),
  /**
   * Visible to the agent. There is no per-repository choice, so the runtime sends `true` (Whombat agent-repos.md AGR-11);
   * an older runtime sends what the person switched.
   */
  enabled: z.boolean(),
  pushedAt: Timestamp.nullable(),
  /** Where it lives (CT-192). Absent: `github`. */
  source: RepoSource.optional(),
  /** Where a `local` repo is kept on this Whombat, as people read it (`~/.whombat/workspaces/.origins/…/Site.git`); null otherwise. */
  path: z.string().max(1024).nullable().optional(),
  /** When a `local` repo was created (its row); absent for GitHub repos. */
  createdAt: Timestamp.optional(),
});
export type Repo = z.infer<typeof Repo>;

/** A repo's source, `github` when the runtime doesn't say. */
export const repoSourceOf = (repo: Pick<Repo, 'source'>): RepoSource => repo.source ?? 'github';

/** The name people see: `Whombat_Website` for a local repo, `owner/name` for a GitHub one. */
export const repoDisplayName = (repo: Pick<Repo, 'source' | 'fullName'>): string =>
  repoSourceOf(repo) === 'local' ? repo.fullName.slice(repo.fullName.indexOf('/') + 1) : repo.fullName;

export const CheckState = z.enum(['queued', 'running', 'passed', 'failed', 'skipped']);
export type CheckState = z.infer<typeof CheckState>;

/** A CI check row: `lint 12s`, `unit · billing 38/41`, `pdf-snapshot queued`. */
export const Check = z.object({
  name: z.string().min(1).max(120),
  state: CheckState,
  /** Right-hand note. */
  note: z.string().max(60),
  durationMs: z.number().int().nonnegative().nullable(),
  tests: TestCounts.nullable(),
  url: z.string().max(2048).nullable(),
});
export type Check = z.infer<typeof Check>;

export const ReviewState = z.enum(['pending', 'approved', 'changes_requested', 'commented']);
export type ReviewState = z.infer<typeof ReviewState>;

/** A reviewer's state, in a locale. */
export function reviewStateLabels(locale?: string | null): Readonly<Record<ReviewState, string>> {
  return coreWords(locale, 'review.state', ReviewState.options);
}

export const REVIEW_STATE_LABELS: Record<ReviewState, string> = reviewStateLabels('en');

export const REVIEW_STATE_TONES: Record<ReviewState, Tone> = {
  pending: 'neutral',
  approved: 'ok',
  changes_requested: 'bad',
  commented: 'neutral',
};

export const Reviewer = z.object({
  principalId: PrincipalId,
  state: ReviewState,
  at: Timestamp.nullable(),
});
export type Reviewer = z.infer<typeof Reviewer>;

export const PrState = z.enum(['open', 'merged', 'closed']);
export type PrState = z.infer<typeof PrState>;

export const PrCommit = z.object({
  sha: z.string().min(4).max(64),
  message: z.string().min(1).max(500),
  authorId: PrincipalId.nullable(),
  at: Timestamp,
});
export type PrCommit = z.infer<typeof PrCommit>;

export const PullRequest = z.object({
  id: PullRequestId,
  number: z.number().int().positive(),
  repoId: RepoId,
  repoFullName: z.string(),
  /** `feat/invoice-pdf` */
  branch: z.string().min(1).max(255),
  baseBranch: z.string().min(1).max(255),
  title: z.string().min(1).max(256),
  state: PrState,
  headSha: z.string().min(4).max(64),
  authorId: PrincipalId.nullable(),
  checks: z.array(Check),
  reviewers: z.array(Reviewer),
  files: z.array(FileChange),
  diff: DiffStat,
  commits: z.array(PrCommit),
  /** The branch room. */
  conversationId: ConversationId,
  openedAt: Timestamp,
  mergedAt: Timestamp.nullable(),
  mergedById: PrincipalId.nullable(),
  url: z.string().max(2048).nullable(),
});
export type PullRequest = z.infer<typeof PullRequest>;

/** Aggregate check state of a PR. */
export function checksState(
  checks: readonly Pick<Check, 'state'>[],
): 'passed' | 'failed' | 'running' | 'none' {
  if (checks.length === 0) return 'none';
  if (checks.some((c) => c.state === 'failed')) return 'failed';
  if (checks.every((c) => c.state === 'passed' || c.state === 'skipped')) return 'passed';
  return 'running';
}

export const PrStatus = z.enum([
  'merged',
  'closed',
  'changes_requested',
  'checks_failing',
  'ready',
  'in_review',
]);
export type PrStatus = z.infer<typeof PrStatus>;

/** Where a PR stands, for the branch room header chip and the sidebar dot. */
export function prStatus(pr: Pick<PullRequest, 'state' | 'checks' | 'reviewers'>): PrStatus {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.reviewers.some((r) => r.state === 'changes_requested')) return 'changes_requested';
  const checks = checksState(pr.checks);
  if (checks === 'failed') return 'checks_failing';
  const approved = pr.reviewers.some((r) => r.state === 'approved');
  if ((checks === 'passed' || checks === 'none') && approved) return 'ready';
  return 'in_review';
}

/** Header chip: "Open · changes requested" → "Open · ready" → "Merged", in a locale. */
export function prStatusLabels(locale?: string | null): Readonly<Record<PrStatus, string>> {
  return coreWords(locale, 'pr.status', PrStatus.options);
}

export const PR_STATUS_LABELS: Record<PrStatus, string> = prStatusLabels('en');

/** Dot color: ready and merged are ok, everything open and unfinished is warn. */
export const PR_STATUS_TONES: Record<PrStatus, Tone> = {
  merged: 'ok',
  closed: 'neutral',
  changes_requested: 'warn',
  checks_failing: 'warn',
  ready: 'ok',
  in_review: 'warn',
};

export const MergeBlockReason = z.enum(['agent', 'not_open', 'checks', 'review']);
export type MergeBlock = z.infer<typeof MergeBlockReason> | null;

/**
 * Why "Merge into main" is disabled, or null when a person may merge now.
 * Agents never merge ("Merging is for people. Agents in this burrow don’t hold a merge key.").
 */
export function mergeBlock(
  pr: Pick<PullRequest, 'state' | 'checks' | 'reviewers'>,
  actorKind: 'person' | 'agent',
): MergeBlock {
  if (actorKind === 'agent') return 'agent';
  if (pr.state !== 'open') return 'not_open';
  const checks = checksState(pr.checks);
  if (checks !== 'passed' && checks !== 'none') return 'checks';
  if (
    pr.reviewers.some((r) => r.state === 'changes_requested') ||
    !pr.reviewers.some((r) => r.state === 'approved')
  )
    return 'review';
  return null;
}
