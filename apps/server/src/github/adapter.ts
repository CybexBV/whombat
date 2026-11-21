/**
 * The GitHub adapter (docs/github.md): everything the server asks of GitHub, behind one interface.
 * `GhCliGitHub` talks to api.github.com as one account (a person's own GitHub sign-in, through `ManagedGitHub`);
 * `FakeGitHub` keeps an in-memory (optionally git-backed) GitHub for dev, tests and the demo.
 *
 * Reads the poller repeats every cycle are conditional: they take the ETag of the last answer and return
 * `{modified: false}` when nothing changed (a 304, which costs no rate limit).
 */

/** Who the server acts as on GitHub. */
export interface GhAccount {
  login: string;
  id: number;
  name: string | null;
  /** OAuth scopes of the token (`repo`, `workflow` …); null when GitHub does not say (fine-grained tokens). */
  scopes: string[] | null;
}

export interface GhRepo {
  id: number;
  /** `whombat/billing` */
  fullName: string;
  description: string | null;
  language: string | null;
  defaultBranch: string;
  pushedAt: string | null;
  private: boolean;
  /** Whether the signed-in account can push to it, when GitHub said (agent-repos.md AGR-04). */
  canPush?: boolean;
  /** A template repository (“Use this template”), when GitHub said (agent-repos.md AGR-07). */
  template?: boolean;
  /** Archived on GitHub (read-only), when GitHub said. */
  archived?: boolean;
}

/** A new repository an agent asked for (`gh repo create`, agent-gh.md AGH-19). */
export interface GhRepoSpec {
  name: string;
  visibility: 'public' | 'private' | 'internal';
  description: string | null;
  homepage: string | null;
  /** `owner/name` of a template repository it is made from (“Use this template”); then only its files. */
  template: string | null;
  includeAllBranches: boolean;
  addReadme: boolean;
  gitignore: string | null;
  license: string | null;
  hasIssues: boolean;
  hasWiki: boolean;
}

/** A pull request as the pulls API returns it. */
export interface GhPullRequest {
  number: number;
  url: string;
  title: string;
  body: string | null;
  headRef: string;
  /**
   * The fork the head branch is in (`stranger/billing`; `unknown` once the fork was deleted), null for a
   * branch of this repo. Whatever a fork's branch is called, it is never one of this repo's.
   */
  fork: string | null;
  headSha: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergedBy: string | null;
  /**
   * The commit a merged pull request became on its base (GitHub's `merge_commit_sha`: the merge commit, the squashed or
   * the last rebased commit); null while open, closed without merging, or when GitHub didn't say (report-trackers.md
   * TA-30: whether a deployed revision has the fix).
   */
  mergeCommitSha: string | null;
  draft: boolean;
  /** Login of whoever opened it. */
  author: string | null;
  /** GitHub marks whoever opened it as a bot (`user.type: Bot`, a `…[bot]` login; automation-recipes.md). */
  authorBot: boolean;
  /** GitHub's `author_association` (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, …; null when it didn't say; AR-27). */
  authorAssociation: string | null;
  /** Logins assigned to it. */
  assignees: string[];
  requestedReviewers: string[];
  createdAt: string | null;
  updatedAt: string | null;
  /** Only on a single PR read (not in lists). */
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

/** An issue as the issues API returns it (never a pull request: those come as `GhPullRequest`). */
export interface GhIssue {
  number: number;
  url: string;
  title: string;
  body: string | null;
  /** Login of whoever opened it. */
  author: string | null;
  /** GitHub marks whoever opened it as a bot (`user.type: Bot`, a `…[bot]` login). */
  authorBot: boolean;
  /** GitHub's `author_association` (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, …; null when it didn't say; AR-27). */
  authorAssociation: string | null;
  /** Logins assigned to it. */
  assignees: string[];
  labels: string[];
  state: 'open' | 'closed';
  createdAt: string | null;
}

/**
 * Whether GitHub's user is a bot: `type: Bot`, or a login GitHub gives apps (`dependabot[bot]`, `renovate[bot]`).
 */
export function isBotAccount(
  user: { login?: string | null; type?: string | null } | null | undefined,
): boolean {
  if (!user) return false;
  return user.type === 'Bot' || /\[bot\]$/i.test(user.login ?? '');
}

export interface GhCommit {
  sha: string;
  /** Its first line. */
  message: string;
  /** All of it, its body too, where the adapter has it. */
  fullMessage?: string;
  authorName: string | null;
  authorEmail: string | null;
  authorLogin: string | null;
  at: string;
  /** When it was committed (the committer's date; an amend or rebase moves it, the author's date stays). */
  committedAt?: string;
}

export interface GhFile {
  path: string;
  add: number;
  del: number;
}

export interface GhReviewComment {
  path: string;
  line: number | null;
  body: string;
  /** Unified diff hunk around the comment (`@@ … @@` header first). */
  diffHunk: string;
}

export interface GhReview {
  id: number;
  /** Lowercase: `approved`, `changes_requested`, `commented`, `dismissed`, `pending`. */
  state: string;
  author: string | null;
  body: string;
  submittedAt: string | null;
}

/** A check run as the checks API returns it (`checkFromRun` maps it to a Whombat check). */
export interface GhCheckRun {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
  outputTitle: string | null;
  outputSummary: string | null;
}

/** A GitHub Actions job (`GET /repos/{r}/actions/jobs/{id}`) and its check run's annotations. */
export interface GhActionsJob {
  id: number;
  runId: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: { name: string; status: string; conclusion: string | null }[];
  /** The messages of its annotations: GitHub says there when the runner was lost or shut down. */
  annotations: string[];
}

/** A commit status, including CI providers that do not publish check runs. */
export interface GhCommitStatus {
  id: number;
  context: string;
  state: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
  /** What the CI says of it (“Waiting in the CI queue”). */
  description?: string | null;
}

export interface GhWorkflowRun {
  id: number;
  name: string | null;
  displayTitle: string | null;
  /** `.github/workflows/deploy.yml` */
  path: string | null;
  event: string | null;
  status: string | null;
  conclusion: string | null;
  headBranch: string | null;
  url: string | null;
  createdAt: string | null;
  runStartedAt: string | null;
  updatedAt: string | null;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** How one commit relates to another (`GitHubAdapter.compareStatus`). */
export type CompareStatus = 'ahead' | 'identical' | 'behind' | 'diverged' | 'unknown';

/**
 * One version of a file (docs/decisions/pr-file-view.md PF-04): its bytes, or `too_large` when it is bigger than the
 * reader asked for (and wasn't read). `size` is GitHub's when it said, else just above the limit.
 */
export type GhFileVersion = { kind: 'file'; bytes: Uint8Array } | { kind: 'too_large'; size: number };

/** A file of a branch as its tree lists it (`branchTree`): its path, its size and GitHub's id of its bytes. */
export interface GhTreeFile {
  path: string;
  size: number;
  sha: string;
}

/** The answer to a conditional read. */
export type Conditional<T> = { modified: false } | { modified: true; etag: string | null; data: T };

/** A conditional read over several pages: one ETag per page. */
export type ConditionalPages<T> = { modified: false } | { modified: true; etags: string[]; data: T[] };

/** A GitHub owner's picture as GitHub sent it (`ownerAvatar`, automation-list.md AL-S06). */
export interface GhAvatar {
  /** What GitHub said it is; never trusted (`avatarDataUrl` sniffs the bytes). */
  contentType: string;
  bytes: Uint8Array;
}

/** Rate limit as GitHub last reported it. */
export interface RateLimit {
  remaining: number | null;
  limit: number | null;
  /** Epoch ms when the window resets. */
  resetAt: number | null;
}

export interface GitHubAdapter {
  readonly kind: 'gh' | 'fake';

  /** The connected account; throws `GitHubNotConnectedError` when gh is missing or logged out. */
  whoami(): Promise<GhAccount>;
  /** A token git can push and fetch with (the host account's). Never logged, never in argv. */
  gitToken(): Promise<{ token: string; expiresAt: string }>;
  /** Clone / push URL for a repo. */
  remoteUrl(repo: string): string;
  /** GitHub's last reported rate limit (null fields before the first answer). */
  rateLimit(): RateLimit;

  /**
   * Repos the account can reach (its own, collaborations, its organisations'), most recently pushed first; with `owned`
   * only the ones the account itself owns (agent-repos.md AGR-08).
   */
  listRepos(limit: number, options?: { owned?: boolean }): Promise<{ repos: GhRepo[]; hasMore: boolean }>;
  /** One repo by `owner/name`; `GitHubError` 404 when it does not exist or the account can't see it. */
  getRepo(fullName: string): Promise<GhRepo>;
  branchExists(repo: string, branch: string): Promise<boolean>;

  createPullRequest(pr: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<GhPullRequest>;
  getPullRequest(repo: string, number: number): Promise<GhPullRequest>;
  /** Who closed an issue or PR (`closed_by`), for PRs closed without merging. */
  closedBy(repo: string, number: number): Promise<string | null>;
  /** A PR's commits, oldest first, every page (GitHub lists at most 250). */
  listPullRequestCommits(repo: string, number: number): Promise<GhCommit[]>;
  /** A PR's files, every page up to 500 (what the burrow keeps). */
  listPullRequestFiles(repo: string, number: number): Promise<GhFile[]>;
  listReviewComments(repo: string, number: number, reviewId: number): Promise<GhReviewComment[]>;
  /** Commits on `head` since `base` (oldest first, at most 100). */
  compare(repo: string, base: string, head: string): Promise<GhCommit[]>;
  /**
   * How `head` relates to `base` (GitHub's compare `status`; report-trackers.md TA-30): `ahead` — head has every commit
   * of base and more, `identical`, `behind`, `diverged`; `unknown` when GitHub doesn't know one of them (404, 422).
   */
  compareStatus(repo: string, base: string, head: string): Promise<CompareStatus>;
  /** The merge base of `base` and `head` (branches or commits); null when GitHub doesn't know one of them. */
  mergeBase(repo: string, base: string, head: string): Promise<string | null>;
  /** A commit's first parent; null for a root commit or a commit GitHub doesn't have. */
  commitParent(repo: string, sha: string): Promise<string | null>;
  /**
   * The names of the files at the top of a branch (no folders), with the commit it is at; null when the branch doesn't
   * exist. For a fix's screenshots branch (`pr-shots/…`), which holds only them.
   */
  branchFiles(repo: string, branch: string): Promise<{ sha: string; names: string[] } | null>;
  /**
   * Every file of a branch (`HEAD`: the default branch), in one read of its tree; `truncated` when GitHub cut a very
   * large tree short. Null when the branch or the repository doesn't exist (or is empty).
   */
  branchTree(repo: string, ref: string): Promise<{ files: GhTreeFile[]; truncated: boolean } | null>;
  /** A file's bytes by GitHub's id of them (`GhTreeFile.sha`); `too_large` above `maxBytes`, null when there is none. */
  blobAt(repo: string, sha: string, maxBytes: number): Promise<GhFileVersion | null>;
  /** A commit's complete tree identity; null when GitHub cannot find the commit. */
  commitTree(repo: string, sha: string): Promise<string | null>;
  /** Required check names from classic branch protection and active repository rules. */
  requiredStatusChecks(repo: string, branch: string): Promise<string[]>;
  /** Latest commit statuses, across every page, for exactly this revision. */
  commitStatuses(repo: string, sha: string): Promise<GhCommitStatus[]>;
  /**
   * The file at `path` in commit `sha`, raw; null when that version has no file there. Above `maxBytes` it isn't read
   * (`too_large`). A submodule reads as `Subproject commit <sha>`, as git's diff shows it (pr-file-view.md PF-04).
   */
  fileAt(repo: string, sha: string, path: string, maxBytes: number): Promise<GhFileVersion | null>;
  mergePullRequest(merge: {
    repo: string;
    number: number;
    method: MergeMethod;
    /** Merge only if the head is still this commit. */
    sha?: string;
    title: string;
    message: string;
  }): Promise<{ merged: boolean; sha: string | null; message: string }>;
  /**
   * The account's own copy of `source` as `owner/name` (agent-repos.md AGR-07): a private repository made from a
   * template (“Use this template”), else a fork. GitHub may still be filling it when this answers.
   */
  copyRepo(source: string, copy: { owner: string; name: string; template: boolean }): Promise<GhRepo>;
  /**
   * A new repository `owner/name` (agent-gh.md AGH-19): the signed-in account's own (`ownAccount`), else one of its
   * organizations'; from a template when the spec names one. GitHub may still be filling it when this answers.
   */
  createRepo(repo: GhRepoSpec & { owner: string; ownAccount: boolean }): Promise<GhRepo>;
  /**
   * One issue by number (automation-recipes.md: “Try it on …”). The issues API answers for pull requests too: then
   * `pullRequest` is true and the caller reads it with `getPullRequest`. `GitHubError` 404 when there is none.
   */
  getIssue(repo: string, number: number): Promise<GhIssue & { pullRequest: boolean }>;
  /** A comment on an issue or a pull request (both are issues to GitHub). */
  commentOnIssue(repo: string, number: number, body: string): Promise<{ id: number; url: string }>;
  /**
   * Deletes a branch (automation-recipes.md AR-42: an automation's branch once its pull request merged). `gone` when
   * there was none; `GitHubError` when GitHub refuses (a protected branch: 422).
   */
  deleteBranch(repo: string, branch: string): Promise<'deleted' | 'gone'>;
  /**
   * An owner's public picture, `size` pixels square (automation-list.md AL-S06): asked without a token, so it needs no
   * GitHub sign-in. Null when GitHub has none or sends something unusable; throws when GitHub couldn't be reached.
   */
  ownerAvatar(owner: string, size: number): Promise<GhAvatar | null>;
  /**
   * Runs a GitHub Actions workflow run's failed jobs once more, with the jobs that need them (automation-recipes.md
   * AR-57). GitHub refuses while the run is still going.
   */
  rerunFailedJobs(repo: string, runId: number): Promise<void>;
  /**
   * One GitHub Actions job with its steps and annotations: why it failed, before a merge step runs it once more only for
   * an infrastructure fault (automations/merge-rerun.ts). `GitHubError` 404 when there is none.
   */
  actionsJob(repo: string, jobId: number): Promise<GhActionsJob>;
  /** `workflow_dispatch` on a workflow file (`deploy.yml`) at `ref`. */
  dispatchWorkflow(run: {
    repo: string;
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void>;

  /* Conditional reads (the poller) ------------------------------------------------------------ */

  /**
   * Open issues, newest first, one page of 50 (pull requests left out); conditional like the pull requests' list.
   * Only read for repos an automation listens to with new issues (automation-recipes.md).
   */
  openIssues(repo: string, etag: string | null): Promise<Conditional<GhIssue[]>>;
  /** Open pull requests, every page (one ETag per page). */
  openPullRequests(repo: string, etags: readonly string[]): Promise<ConditionalPages<GhPullRequest>>;
  /**
   * The most recently updated closed pull requests, one page of 30, newest first: a pull request opened and merged
   * between two reads of the open ones is never in that list. Only read for repositories report fixes are made in.
   */
  closedPullRequests(repo: string, etag: string | null): Promise<Conditional<GhPullRequest[]>>;
  checkRuns(repo: string, sha: string, etag: string | null): Promise<Conditional<GhCheckRun[]>>;
  /**
   * A PR's reviews, oldest first, over every page (one ETag per page). Only pages that changed are in
   * `data`: an unchanged page holds reviews read before. New reviews land on the last page, so the page
   * after a full one is asked too (its ETag kept) — a full page stops changing once the next one starts.
   */
  reviews(repo: string, number: number, etags: readonly string[]): Promise<ConditionalPages<GhReview>>;
  /**
   * The repository as GitHub names it now: a repository renamed or moved still answers by its old name (GitHub
   * redirects), with its new `fullName` (agent-repos.md AGR-15).
   */
  repoInfo(repo: string, etag: string | null): Promise<Conditional<GhRepo>>;
  /** A branch's head commit, null when the branch does not exist. */
  branchHead(repo: string, branch: string, etag: string | null): Promise<Conditional<string | null>>;
  /** Recent `workflow_dispatch` runs, newest first. */
  workflowRuns(repo: string, etag: string | null): Promise<Conditional<GhWorkflowRun[]>>;
}

/** Thrown by adapters for GitHub API failures (status from GitHub when there is one). */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** GitHub isn't connected: no sign-in, or its token was refused. `fix` says what helps. */
export class GitHubNotConnectedError extends GitHubError {
  constructor(
    message = 'GitHub isn’t connected. Sign in to GitHub.',
    readonly fix: string = 'sign in to GitHub',
  ) {
    super(message, 401);
    this.name = 'GitHubNotConnectedError';
  }
}

/** GitHub's rate limit (primary or secondary) is used up until `until` (epoch ms). */
export class GitHubRateLimitedError extends GitHubError {
  constructor(readonly until: number) {
    super(`GitHub’s rate limit is used up until ${new Date(until).toISOString()}.`, 429);
    this.name = 'GitHubRateLimitedError';
  }
}

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `whombat/billing` → `['whombat', 'billing']`; throws on anything else (it becomes part of a URL). */
export function splitRepo(fullName: string): { owner: string; repo: string } {
  if (!REPO_NAME.test(fullName)) throw new GitHubError(`“${fullName}” is not owner/name.`, 400);
  const [owner = '', repo = ''] = fullName.split('/');
  return { owner, repo };
}

/**
 * The branch a PR is keyed on in the burrow: its head ref, or GitHub's `owner:ref` label for a fork's branch.
 * Git refs cannot contain `:`, so a fork's PR never shares a branch (a push grant, an agent's PR) with ours.
 */
export function prBranch(pr: Pick<GhPullRequest, 'headRef' | 'fork'>): string {
  if (!pr.fork) return pr.headRef;
  return `${pr.fork.split('/')[0] || 'unknown'}:${pr.headRef}`.slice(0, 255);
}

/** First line of a commit message, trimmed to the card's limit. */
export function firstLine(message: string, max = 500): string {
  const line = message.split('\n')[0]?.trim() || message.trim();
  return (line || 'Commit').slice(0, max);
}
