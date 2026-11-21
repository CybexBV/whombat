/**
 * FakeGitHub: an in-memory GitHub for dev, tests and the demo, logged in as `whombat`. It holds repos,
 * branches, pull requests, reviews, check runs and workflow runs, answers the adapter calls like GitHub
 * would — including ETags on the poller's reads (an unchanged answer is `{modified: false}`, as a 304) — so
 * the poller and the mirror run exactly the code they run against GitHub.
 *
 * With `gitRoot` set, repos are real bare git repositories on disk (`<gitRoot>/<owner>/<repo>.git`): the
 * runner clones and pushes to them with the token this fake hands out, and the poller sees the pushes as
 * branch heads moving, as it does on GitHub.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { localCommitParent, localFileAt, localMergeBase } from '@whombat/agent-runtime/local-repos';
import { prFileVersions, REPOS } from '@whombat/fixtures';
import {
  type CompareStatus,
  type Conditional,
  type ConditionalPages,
  firstLine,
  type GhAccount,
  type GhActionsJob,
  type GhAvatar,
  type GhCheckRun,
  type GhCommit,
  type GhCommitStatus,
  type GhFile,
  type GhFileVersion,
  type GhIssue,
  type GhPullRequest,
  type GhRepo,
  type GhRepoSpec,
  type GhReview,
  type GhReviewComment,
  type GhTreeFile,
  type GhWorkflowRun,
  type GitHubAdapter,
  GitHubError,
  GitHubNotConnectedError,
  type MergeMethod,
  prBranch,
  type RateLimit,
} from './adapter';

/** The account the fake is "logged in" as (`Connected as @whombat`). */
export const FAKE_LOGIN = 'whombat';

/** Every owner's picture on the fake: a 1×1 PNG (automation-list.md AL-S06). */
export const FAKE_AVATAR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** A square PNG of one colour, `size` pixels a side: a repository's icon on the fake. */
export function solidPng(size: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => rgb[i % 3] as number)]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Git's id of a file's bytes, as GitHub's trees list it. */
function blobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

/**
 * The fake repository that carries an icon of its own (`public/apple-touch-icon.png` on its default branch), so the
 * Chat list's repository icons can be seen in development without GitHub.
 */
export const FAKE_ICON_REPO = 'whombat/web';

export interface FakePr {
  number: number;
  title: string;
  body: string;
  head: string;
  /** The fork the head branch is in (`stranger/billing`); absent for this repo's branches. */
  fork?: string | null;
  base: string;
  headSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergedBy: string | null;
  /** The commit it became on its base once merged (`GhPullRequest.mergeCommitSha`). */
  mergeSha?: string | null;
  closedBy: string | null;
  authorLogin: string;
  requestedReviewers: string[];
  createdAt: string;
  updatedAt: string;
  files: GhFile[];
  additions: number;
  deletions: number;
  changedFiles: number;
  /** A draft on GitHub (`simulateReadyForReview` marks it ready). */
  draft?: boolean;
  /** Opened by a bot account (Dependabot, `…[bot]`). */
  authorBot?: boolean;
  /** GitHub's `author_association` of whoever opened it (default CONTRIBUTOR). */
  authorAssociation?: string | null;
  /** Logins assigned to it. */
  assignees?: string[];
}

/** An issue on the fake GitHub (automation-recipes.md). */
export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  authorLogin: string;
  authorBot: boolean;
  /** GitHub's `author_association` of whoever opened it (AR-27; null: GitHub didn't say). */
  authorAssociation: string | null;
  /** Logins assigned to it. */
  assignees: string[];
  labels: string[];
  state: 'open' | 'closed';
  createdAt: string;
}

/** A comment Whombat left on an issue or pull request (tests read them). */
export interface FakeComment {
  id: number;
  repo: string;
  number: number;
  body: string;
  url: string;
}

export interface FakeReview extends GhReview {
  prNumber: number;
  comments: GhReviewComment[];
}

export interface FakeRun {
  id: number;
  workflow: string;
  ref: string;
  inputs: Record<string, string>;
  createdAt: number;
}

export interface FakeRepo extends GhRepo {
  /** branch → head sha (in-memory repos). */
  branches: Map<string, string>;
  /** commits by sha, in push order (in-memory repos). */
  commits: Map<string, GhCommit & { branch: string }>;
  prs: Map<number, FakePr>;
  /** Issues by number (numbers are shared with pull requests, as on GitHub). */
  issues: Map<number, FakeIssue>;
  reviews: FakeReview[];
  /** head sha → check runs on it. */
  checks: Map<string, GhCheckRun[]>;
  /** Commit statuses (external CI) and branch-required context names. */
  statuses: Map<string, GhCommitStatus[]>;
  requiredChecks: Map<string, string[]>;
  /** Every commit the repo has had at a branch or PR head (in-memory repos): GitHub answers 422 for others. */
  shas: Set<string>;
  runs: FakeRun[];
  git: string | null;
  /** In-memory repos: commit sha → the files at that commit (`simulateFiles`); git-backed repos read git. */
  files: Map<string, Map<string, Uint8Array>>;
  /** In-memory repos: commit sha → its first parent (`simulateFiles`). */
  parents: Map<string, string>;
  /** In-memory repos: a seeded PR's head → the made-up commit its files are compared with (`mergeBase`). */
  bases: Map<string, string>;
}

export interface FakeSeed {
  repos: {
    fullName: string;
    description?: string | null;
    language?: string | null;
    defaultBranch?: string;
    pushedAt?: string | null;
    prs?: {
      number: number;
      branch: string;
      base: string;
      title: string;
      headSha: string;
      state: 'open' | 'merged' | 'closed';
      files?: GhFile[];
      /** The PR's diff stat when it is not just the sum of `files` (seeded PRs). */
      diff?: { add: number; del: number; files: number };
      authorLogin?: string;
    }[];
  }[];
}

export interface FakeGitHubOptions {
  /** The login it acts as (default `whombat`). */
  login?: string;
  /** Bare repos on disk (enables real clones and pushes). */
  gitRoot?: string;
  /** Loads the repos and PRs the fake starts with (the server hydrates it from its database). */
  load?: () => Promise<FakeSeed>;
  /** How long a dispatched workflow "runs" before it completes. */
  workflowDelayMs?: number;
  /** Conclusion of dispatched workflows (`success`, `failure`). */
  workflowConclusion?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    // A command that exits before reading stdin closes the pipe; its exit code still reports the outcome.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const res = await run('git', args, { cwd, ...(input !== undefined ? { input } : {}) });
  if (res.code !== 0) throw new GitHubError(`git ${args[0]} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

/** A blob's bytes from a bare repository, as they are. */
function gitBlob(cwd: string, sha: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['cat-file', 'blob', sha], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const parts: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => parts.push(d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(parts) : null));
  });
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Whombat Fake GitHub',
  GIT_AUTHOR_EMAIL: 'fake@github.whombat.local',
  GIT_COMMITTER_NAME: 'Whombat Fake GitHub',
  GIT_COMMITTER_EMAIL: 'fake@github.whombat.local',
};

const sha40 = () => randomBytes(20).toString('hex');
const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** A weak ETag over an answer, as GitHub's change when the answer does. */
function etagOf(data: unknown): string {
  return `W/"${createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 24)}"`;
}

function conditional<T>(data: T, etag: string | null): Conditional<T> {
  const now = etagOf(data);
  return now === etag ? { modified: false } : { modified: true, etag: now, data };
}

export class FakeGitHub implements GitHubAdapter {
  readonly kind = 'fake' as const;
  readonly login: string;
  /** Every merge, with the method it was asked for (tests). */
  readonly merges: { repo: string; number: number; method: MergeMethod }[] = [];
  readonly repos = new Map<string, FakeRepo>();
  /** Every conditional read, and whether it answered 200 or 304 (tests count them). */
  readonly reads: { what: string; status: 200 | 304 }[] = [];
  /** Workflow dispatches received (all repos), oldest first. */
  readonly dispatched: (FakeRun & { repo: string })[] = [];
  /** Comments left on issues and pull requests (all repos), oldest first. */
  readonly comments: FakeComment[] = [];
  /** The next `commentOnIssue` fails with this (tests: a refusal, or an answer that was lost). */
  failNextComment: GitHubError | Error | null = null;
  /** The next `mergePullRequest` fails with this, merging nothing (tests: a refusal, or an answer that was lost). */
  failNextMerge: GitHubError | Error | null = null;
  /** Workflow runs whose failed jobs were run again (all repos), oldest first (AR-57). */
  readonly reruns: { repo: string; runId: number }[] = [];
  /** The next `rerunFailedJobs` fails with this, running nothing (tests: GitHub refusing). */
  failNextRerun: GitHubError | Error | null = null;
  /** A GitHub Actions job's steps and annotations, by its page (`simulateCheckRun`'s `steps`, `annotations`). */
  readonly jobDetails = new Map<string, Pick<GhActionsJob, 'steps' | 'annotations'>>();
  /** Jobs read with `actionsJob` (all repos), oldest first. */
  readonly jobReads: { repo: string; jobId: number }[] = [];
  /** Branches deleted (all repos), oldest first (AR-42). */
  readonly deletedBranches: { repo: string; branch: string }[] = [];
  /** `owner/repo:branch` GitHub refuses to delete (a protected branch; tests). */
  readonly protectedBranches = new Set<string>();
  /** Owners without a picture (lowercase): `ownerAvatar` answers null for them (tests). */
  readonly ownersWithoutPicture = new Set(['nopicture']);
  /** Owners whose picture was asked for, lowercase, in order (tests count the fetches). */
  readonly avatarReads: string[] = [];
  /**
   * Files on a repository's default branch besides what its commits hold (by `owner/name`, then path): a repository's
   * icon in development and tests. `branchTree` lists them and `blobAt` reads them.
   */
  readonly defaultFiles = new Map<string, Map<string, Uint8Array>>([
    [FAKE_ICON_REPO, new Map([['public/apple-touch-icon.png', solidPng(64, [0x3b, 0x82, 0xf6])]])],
  ]);
  /** Trees and files read with `branchTree` and `blobAt` (`owner/name`), in order (tests count them). */
  readonly treeReads: string[] = [];
  readonly blobReads: string[] = [];
  /** The next `branchTree` fails with this (tests: a rate limit, an outage). */
  failNextTree: GitHubError | Error | null = null;
  /** gh is "logged out" on the host: every call fails like GhCliGitHub's do. */
  loggedOut = false;
  private loaded: Promise<void> | null = null;
  private nextId = 1000;
  private token: { token: string; expiresAt: string } | null = null;
  readonly options: FakeGitHubOptions;

  constructor(options: FakeGitHubOptions = {}) {
    this.options = options;
    this.login = options.login ?? FAKE_LOGIN;
  }

  close(): void {}

  private connected(): void {
    if (this.loggedOut) throw new GitHubNotConnectedError();
  }

  /* Seeding ------------------------------------------------------------------------------------- */

  /** Loads the database's repos and PRs (once), and the mock's repos as more repos the account can reach. */
  async ready(): Promise<void> {
    this.loaded ??= (async () => {
      if (this.options.load) await this.seed(await this.options.load());
      for (const r of REPOS)
        if (!this.repos.has(r.fullName))
          await this.addRepo({
            fullName: r.fullName,
            description: r.description,
            language: r.language,
            defaultBranch: r.defaultBranch,
            pushedAt: r.pushedAt,
          });
    })();
    await this.loaded;
  }

  /** Adds repos (and their PRs) to the fake; repos already known are kept. */
  async seed(seed: FakeSeed): Promise<void> {
    for (const r of seed.repos) {
      if (this.repos.has(r.fullName)) continue;
      const repo = await this.addRepo({
        fullName: r.fullName,
        description: r.description ?? null,
        language: r.language ?? null,
        defaultBranch: r.defaultBranch ?? 'main',
        pushedAt: r.pushedAt ?? null,
      });
      const now = new Date().toISOString();
      for (const p of r.prs ?? []) {
        repo.prs.set(p.number, {
          number: p.number,
          title: p.title,
          body: '',
          head: p.branch,
          base: p.base,
          headSha: p.headSha,
          state: p.state === 'open' ? 'open' : 'closed',
          merged: p.state === 'merged',
          mergedAt: p.state === 'merged' ? now : null,
          mergedBy: null,
          closedBy: null,
          authorLogin: p.authorLogin ?? this.login,
          requestedReviewers: [],
          createdAt: now,
          updatedAt: now,
          files: p.files ?? [],
          additions: p.diff?.add ?? (p.files ?? []).reduce((n, f) => n + f.add, 0),
          deletions: p.diff?.del ?? (p.files ?? []).reduce((n, f) => n + f.del, 0),
          changedFiles: p.diff?.files ?? (p.files ?? []).length,
        });
        repo.shas.add(p.headSha);
        if (!repo.git && p.state === 'open') repo.branches.set(p.branch, p.headSha);
        if (!repo.git && p.files?.length) this.seedFiles(repo, p.headSha, p.files);
      }
    }
  }

  /**
   * A seeded PR's files, made up to show its `+add −del` (`prFileVersions`, as the fixtures' file view does): the
   * head's versions at its head, the base's at a made-up merge base. Neither has the repo's other files.
   */
  private seedFiles(r: FakeRepo, headSha: string, files: GhFile[]): void {
    const baseSha = createHash('sha1').update(`base:${headSha}`).digest('hex');
    const head = new Map<string, Uint8Array>();
    const base = new Map<string, Uint8Array>();
    for (const f of files) {
      const v = prFileVersions(f);
      head.set(f.path, new TextEncoder().encode(v.head));
      if (v.base !== null) base.set(f.path, new TextEncoder().encode(v.base));
    }
    r.files.set(headSha, head);
    r.files.set(baseSha, base);
    r.shas.add(baseSha);
    r.bases.set(headSha, baseSha);
  }

  /** A repo the account can reach (bare git repo on disk when `gitRoot` is set). */
  async addRepo(r: {
    fullName: string;
    description?: string | null;
    language?: string | null;
    defaultBranch?: string;
    pushedAt?: string | null;
  }): Promise<FakeRepo> {
    const existing = this.repos.get(r.fullName);
    if (existing) return existing;
    const defaultBranch = r.defaultBranch ?? 'main';
    const repo: FakeRepo = {
      id: this.nextId++,
      fullName: r.fullName,
      description: r.description ?? null,
      language: r.language ?? null,
      defaultBranch,
      pushedAt: r.pushedAt ?? null,
      private: true,
      branches: new Map(),
      commits: new Map(),
      prs: new Map(),
      issues: new Map(),
      reviews: [],
      checks: new Map(),
      statuses: new Map(),
      requiredChecks: new Map(),
      shas: new Set(),
      runs: [],
      git: null,
      files: new Map(),
      parents: new Map(),
      bases: new Map(),
    };
    if (this.options.gitRoot) {
      repo.git = join(this.options.gitRoot, `${r.fullName}.git`);
      await this.initGit(repo.git, defaultBranch);
    } else {
      const sha = sha40();
      repo.branches.set(defaultBranch, sha);
      repo.shas.add(sha);
      repo.commits.set(sha, {
        sha,
        message: 'Initial commit',
        authorName: 'Whombat',
        authorEmail: null,
        authorLogin: null,
        at: new Date().toISOString(),
        branch: defaultBranch,
      });
    }
    this.repos.set(r.fullName, repo);
    return repo;
  }

  private async initGit(path: string, defaultBranch: string): Promise<void> {
    if (existsSync(join(path, 'HEAD'))) return;
    await mkdir(dirname(path), { recursive: true });
    await run('git', ['init', '--bare', '--quiet', `--initial-branch=${defaultBranch}`, path]);
    const blob = (await git(path, ['hash-object', '-w', '--stdin'], '# Seeded by the fake GitHub\n')).trim();
    const tree = (await git(path, ['mktree'], `100644 blob ${blob}\tREADME.md\n`)).trim();
    const res = await run('git', ['commit-tree', tree, '-m', 'Initial commit'], {
      cwd: path,
      env: GIT_IDENTITY,
    });
    if (res.code !== 0) throw new GitHubError(`git commit-tree failed: ${res.stderr}`);
    await git(path, ['update-ref', `refs/heads/${defaultBranch}`, res.stdout.trim()]);
  }

  /** A renamed repository's old name (lowercase) → its name now: GitHub sends the old name on (`renameRepo`). */
  private readonly movedTo = new Map<string, string>();

  /** Renames a repository the way GitHub does: the same repository and id, still reached by its old name. */
  renameRepo(from: string, to: string): void {
    const r = this.repo(from);
    this.repos.delete(r.fullName);
    r.fullName = to;
    this.repos.set(to, r);
    this.movedTo.set(from.toLowerCase(), to);
  }

  /** Whether the name reaches a repository: its own, or an old one GitHub sends on. */
  reaches(fullName: string): boolean {
    return this.repos.has(fullName) || this.movedTo.has(fullName.toLowerCase());
  }

  private repo(fullName: string): FakeRepo {
    const r = this.repos.get(fullName) ?? this.repos.get(this.movedTo.get(fullName.toLowerCase()) ?? '');
    if (!r) throw new GitHubError(`Not Found: ${fullName}`, 404);
    return r;
  }

  private pr(r: FakeRepo, number: number): FakePr {
    const pr = r.prs.get(number);
    if (!pr) throw new GitHubError('Not Found', 404);
    return pr;
  }

  /** The next number of an issue or a pull request (they share one sequence, as on GitHub). */
  private nextNumber(r: FakeRepo): number {
    return Math.max(0, ...r.prs.keys(), ...r.issues.keys()) + 1;
  }

  private toGhIssue(r: FakeRepo, i: FakeIssue): GhIssue {
    return {
      number: i.number,
      url: `https://github.fake.whombat.local/${r.fullName}/issues/${i.number}`,
      title: i.title,
      body: i.body,
      author: i.authorLogin,
      authorBot: i.authorBot,
      authorAssociation: i.authorAssociation,
      assignees: [...i.assignees],
      labels: [...i.labels],
      state: i.state,
      createdAt: i.createdAt,
    };
  }

  /** Whether the repo has the commit (a 40-hex sha or a prefix of one, like GitHub). */
  private async hasCommit(r: FakeRepo, sha: string): Promise<boolean> {
    // Seeded PR heads count too (git-backed repos do not have their commits).
    for (const known of r.shas) if (sameSha(known, sha)) return true;
    if (!r.git || !/^[0-9a-f]{4,64}$/i.test(sha)) return false;
    const res = await run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: r.git });
    return res.code === 0;
  }

  private async headOf(r: FakeRepo, branch: string): Promise<string | null> {
    if (!r.git) return r.branches.get(branch) ?? null;
    const res = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: r.git,
    });
    return res.code === 0 ? res.stdout.trim() : null;
  }

  /** Git-backed repos: open PRs follow their branch (a push moves the PR's head). */
  private async refresh(r: FakeRepo): Promise<void> {
    if (!r.git) return;
    for (const pr of r.prs.values()) {
      if (pr.state !== 'open' || pr.fork) continue;
      const head = await this.headOf(r, pr.head);
      if (head && head !== pr.headSha) {
        pr.headSha = head;
        pr.updatedAt = new Date().toISOString();
        r.pushedAt = pr.updatedAt;
      }
    }
  }

  /* Adapter ------------------------------------------------------------------------------------- */

  async whoami(): Promise<GhAccount> {
    this.connected();
    return { login: this.login, id: 4242, name: 'Whombat', scopes: ['repo', 'workflow', 'read:org'] };
  }

  async gitToken() {
    this.connected();
    if (!this.token || Date.parse(this.token.expiresAt) - Date.now() < 5 * 60_000)
      this.token = {
        token: `gho_fake_${randomBytes(12).toString('hex')}`,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      };
    return this.token;
  }

  remoteUrl(repo: string): string {
    const r = this.repos.get(repo);
    if (r?.git) return r.git;
    if (this.options.gitRoot) return join(this.options.gitRoot, `${repo}.git`);
    return `https://github.fake.whombat.local/${repo}.git`;
  }

  rateLimit(): RateLimit {
    return { remaining: 5000, limit: 5000, resetAt: null };
  }

  private ghRepo(r: FakeRepo): GhRepo {
    return {
      id: r.id,
      fullName: r.fullName,
      description: r.description,
      language: r.language,
      defaultBranch: r.defaultBranch,
      pushedAt: r.pushedAt,
      private: r.private,
    };
  }

  async listRepos(limit: number, options: { owned?: boolean } = {}) {
    this.connected();
    await this.ready();
    const own = `${this.login.toLowerCase()}/`;
    const all = [...this.repos.values()]
      .filter((r) => !options.owned || r.fullName.toLowerCase().startsWith(own))
      .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
      .map((r) => this.ghRepo(r));
    return { repos: all.slice(0, limit), hasMore: all.length > limit };
  }

  async getRepo(fullName: string): Promise<GhRepo> {
    this.connected();
    await this.ready();
    return this.ghRepo(this.repo(fullName));
  }

  async branchExists(repo: string, branch: string): Promise<boolean> {
    this.connected();
    await this.ready();
    return (await this.headOf(this.repo(repo), branch)) !== null;
  }

  async createPullRequest(pr: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<GhPullRequest> {
    this.connected();
    await this.ready();
    const r = this.repo(pr.repo);
    let headSha = await this.headOf(r, pr.head);
    if (!headSha && !r.git) {
      // In-memory repos have no pushes to wait for: the branch "was pushed" off-screen.
      headSha = sha40();
      r.branches.set(pr.head, headSha);
      r.shas.add(headSha);
      r.commits.set(headSha, {
        sha: headSha,
        message: pr.title,
        authorName: this.login,
        authorEmail: null,
        authorLogin: this.login,
        at: new Date().toISOString(),
        branch: pr.head,
      });
    }
    if (!headSha) throw new GitHubError(`Validation Failed: head ${pr.head} does not exist`, 422);
    if (!(await this.headOf(r, pr.base))) throw new GitHubError(`Validation Failed: base ${pr.base}`, 422);
    for (const p of r.prs.values())
      if (p.head === pr.head && !p.fork && p.state === 'open')
        throw new GitHubError(`A pull request already exists for ${pr.head}.`, 422);
    const number = this.nextNumber(r);
    const files = await this.diffFiles(r, pr.base, pr.head);
    const now = new Date().toISOString();
    const fake: FakePr = {
      number,
      title: pr.title,
      body: pr.body,
      head: pr.head,
      base: pr.base,
      headSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergedBy: null,
      closedBy: null,
      authorLogin: this.login,
      requestedReviewers: [],
      createdAt: now,
      updatedAt: now,
      files,
      additions: files.reduce((n, f) => n + f.add, 0),
      deletions: files.reduce((n, f) => n + f.del, 0),
      changedFiles: files.length,
    };
    r.prs.set(number, fake);
    return this.toGhPr(r, fake, true);
  }

  private async diffFiles(r: FakeRepo, base: string, head: string): Promise<GhFile[]> {
    if (!r.git) return [];
    const out = await git(r.git, ['diff', '--numstat', `${base}...${head}`]).catch(() => '');
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [add = '0', del = '0', path = ''] = line.split('\t');
        return { path, add: Number(add) || 0, del: Number(del) || 0 };
      });
  }

  async getPullRequest(repo: string, number: number): Promise<GhPullRequest> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    await this.refresh(r);
    return this.toGhPr(r, this.pr(r, number), true);
  }

  async closedBy(repo: string, number: number): Promise<string | null> {
    this.connected();
    await this.ready();
    return this.pr(this.repo(repo), number).closedBy;
  }

  async getIssue(repo: string, number: number): Promise<GhIssue & { pullRequest: boolean }> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    const issue = r.issues.get(number);
    if (issue) return { ...this.toGhIssue(r, issue), pullRequest: false };
    const pr = this.pr(r, number);
    const gh = this.toGhPr(r, pr);
    return {
      number: gh.number,
      url: gh.url,
      title: gh.title,
      body: gh.body,
      author: gh.author,
      authorBot: gh.authorBot,
      authorAssociation: gh.authorAssociation,
      assignees: gh.assignees,
      labels: [],
      state: gh.state,
      createdAt: gh.createdAt,
      pullRequest: true,
    };
  }

  async commentOnIssue(repo: string, number: number, body: string): Promise<{ id: number; url: string }> {
    this.connected();
    await this.ready();
    const failure = this.failNextComment;
    this.failNextComment = null;
    if (failure) throw failure;
    const r = this.repo(repo);
    if (!r.issues.has(number) && !r.prs.has(number)) throw new GitHubError('Not Found', 404);
    const id = this.nextId++;
    const kind = r.prs.has(number) ? 'pull' : 'issues';
    const url = `https://github.fake.whombat.local/${r.fullName}/${kind}/${number}#issuecomment-${id}`;
    this.comments.push({ id, repo: r.fullName, number, body, url });
    return { id, url };
  }

  async deleteBranch(repo: string, branch: string): Promise<'deleted' | 'gone'> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    if (this.protectedBranches.has(`${r.fullName}:${branch}`))
      throw new GitHubError('Cannot delete this protected branch', 422);
    if ((await this.headOf(r, branch)) === null) return 'gone';
    if (r.git) await run('git', ['update-ref', '-d', `refs/heads/${branch}`], { cwd: r.git });
    else r.branches.delete(branch);
    this.deletedBranches.push({ repo: r.fullName, branch });
    return 'deleted';
  }

  async listPullRequestCommits(repo: string, number: number): Promise<GhCommit[]> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    const pr = this.pr(r, number);
    if (r.git && !pr.fork) return this.gitCommits(r.git, `${pr.base}..${pr.head}`);
    return this.branchCommits(r, prBranch({ headRef: pr.head, fork: pr.fork ?? null }));
  }

  private branchCommits(r: FakeRepo, branch: string): GhCommit[] {
    // In memory a commit is committed when it is made: its committer's date is its author's.
    return [...r.commits.values()]
      .filter((c) => c.branch === branch)
      .map(({ branch: _b, ...c }) => ({ ...c, fullMessage: c.message, committedAt: c.committedAt ?? c.at }));
  }

  private async gitCommits(dir: string, range: string): Promise<GhCommit[]> {
    const out = await git(dir, [
      'log',
      '--reverse',
      '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%B%x1e',
      range,
      '--',
    ]).catch(() => '');
    return out
      .split('\x1e')
      .map((record) => record.replace(/^\n+/, ''))
      .filter(Boolean)
      .map((line) => {
        const [sha = '', name = '', email = '', at = '', committedAt = '', body = ''] = line.split('\x1f');
        return {
          sha,
          message: firstLine(body),
          fullMessage: body.trim(),
          authorName: name,
          authorEmail: email,
          authorLogin: null,
          at,
          committedAt,
        };
      });
  }

  async listPullRequestFiles(repo: string, number: number): Promise<GhFile[]> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    const pr = this.pr(r, number);
    if (r.git) {
      pr.files = await this.diffFiles(r, pr.base, pr.head);
      pr.additions = pr.files.reduce((n, f) => n + f.add, 0);
      pr.deletions = pr.files.reduce((n, f) => n + f.del, 0);
      pr.changedFiles = pr.files.length;
    }
    return pr.files;
  }

  async listReviewComments(repo: string, _number: number, reviewId: number): Promise<GhReviewComment[]> {
    this.connected();
    await this.ready();
    return this.repo(repo).reviews.find((v) => v.id === reviewId)?.comments ?? [];
  }

  async compare(repo: string, base: string, head: string): Promise<GhCommit[]> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    if (r.git) return (await this.gitCommits(r.git, `${base}..${head}`)).slice(-100);
    // In-memory: the commits of the branch `head` is (or ends at), after `base` when it is one of them.
    const branch =
      [...r.branches.entries()].find(([name, sha]) => name === head || sameSha(sha, head))?.[0] ?? head;
    const commits = this.branchCommits(r, branch);
    const from = commits.findIndex((c) => sameSha(c.sha, base));
    return (from >= 0 ? commits.slice(from + 1) : commits).slice(-100);
  }

  /**
   * Git-backed repos ask git (`merge-base --is-ancestor` both ways). In-memory repos walk the first parents they know
   * (`simulateFiles`, a merge, `simulateCommitOn`); a commit the repo never had is `unknown`, as GitHub's 404.
   */
  async compareStatus(repo: string, base: string, head: string): Promise<CompareStatus> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    if (sameSha(base, head)) return 'identical';
    if (r.git) {
      const ancestor = (a: string, b: string) =>
        git(r.git as string, ['merge-base', '--is-ancestor', a, b]).then(
          () => true,
          () => false,
        );
      const known = (sha: string) =>
        git(r.git as string, ['cat-file', '-e', `${sha}^{commit}`]).then(
          () => true,
          () => false,
        );
      if (!(await known(base)) || !(await known(head))) return 'unknown';
      if (await ancestor(base, head)) return 'ahead';
      if (await ancestor(head, base)) return 'behind';
      return 'diverged';
    }
    const knows = (sha: string) => [...r.shas].some((s) => sameSha(s, sha));
    if (!knows(base) || !knows(head)) return 'unknown';
    const reaches = (from: string, to: string) => {
      for (let sha: string | undefined = from; sha; sha = r.parents.get(sha))
        if (sameSha(sha, to)) return true;
      return false;
    };
    if (reaches(head, base)) return 'ahead';
    if (reaches(base, head)) return 'behind';
    return 'diverged';
  }

  /**
   * Git-backed repos ask git. In-memory repos have no history: a seeded PR's head has its made-up base (`seedFiles`);
   * otherwise the merge base is `base`'s head (or `base` itself when it is a commit the fake knows), or `head` when
   * that is the head or one of its parents by `simulateFiles` (merged with a merge commit).
   */
  async mergeBase(repo: string, base: string, head: string): Promise<string | null> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    if (r.git) {
      const ref = (await this.headOf(r, base)) ? `refs/heads/${base}` : base;
      return localMergeBase(r.git, ref, head).catch(() => null);
    }
    const seeded = r.bases.get(head);
    if (seeded) return seeded;
    const tip = r.branches.get(base) ?? ([...r.shas].find((sha) => sameSha(sha, base)) ? base : null);
    if (!tip) return null;
    // A head already in the base (merged with a merge commit): GitHub answers the head itself.
    for (let sha: string | undefined = tip; sha; sha = r.parents.get(sha))
      if (sameSha(sha, head)) return head;
    return tip;
  }

  async branchFiles(repo: string, branch: string): Promise<{ sha: string; names: string[] } | null> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    const sha = await this.headOf(r, branch);
    if (!sha) return null;
    if (r.git) {
      const res = await run('git', ['ls-tree', sha], { cwd: r.git });
      const names = res.code === 0 ? res.stdout.split('\n').filter((l) => / blob /.test(l)) : [];
      return { sha, names: names.map((l) => l.slice(l.indexOf('\t') + 1)) };
    }
    return { sha, names: [...(r.files.get(sha)?.keys() ?? [])].filter((p) => !p.includes('/')) };
  }

  async branchTree(repo: string, ref: string): Promise<{ files: GhTreeFile[]; truncated: boolean } | null> {
    this.connected();
    await this.ready();
    this.treeReads.push(repo);
    const failure = this.failNextTree;
    this.failNextTree = null;
    if (failure) throw failure;
    const r = this.repos.get(repo) ?? this.repos.get(this.movedTo.get(repo.toLowerCase()) ?? '');
    if (!r) return null;
    const branch = ref === 'HEAD' ? r.defaultBranch : ref;
    const sha = await this.headOf(r, branch);
    if (!sha) return null;
    const files = new Map<string, GhTreeFile>();
    if (r.git) {
      const res = await run('git', ['ls-tree', '-r', '-l', sha], { cwd: r.git });
      for (const line of res.code === 0 ? res.stdout.split('\n') : []) {
        const m = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(line);
        if (m) files.set(m[3] as string, { path: m[3] as string, size: Number(m[2]), sha: m[1] as string });
      }
    } else
      for (const [path, bytes] of r.files.get(sha) ?? [])
        files.set(path, { path, size: bytes.byteLength, sha: blobSha(bytes) });
    if (branch === r.defaultBranch)
      for (const [path, bytes] of this.defaultFiles.get(r.fullName) ?? [])
        files.set(path, { path, size: bytes.byteLength, sha: blobSha(bytes) });
    return { files: [...files.values()], truncated: false };
  }

  async blobAt(repo: string, sha: string, maxBytes: number): Promise<GhFileVersion | null> {
    this.connected();
    await this.ready();
    this.blobReads.push(repo);
    const r = this.repo(repo);
    const known = [
      ...(this.defaultFiles.get(r.fullName)?.values() ?? []),
      ...[...r.files.values()].flatMap((f) => [...f.values()]),
    ];
    let bytes: Uint8Array | null = known.find((b) => blobSha(b) === sha) ?? null;
    if (!bytes && r.git && /^[0-9a-f]{40}$/.test(sha)) {
      const res = await run('git', ['cat-file', '-s', sha], { cwd: r.git });
      if (res.code === 0 && Number(res.stdout.trim()) > maxBytes)
        return { kind: 'too_large', size: Number(res.stdout.trim()) };
      if (res.code === 0) bytes = await gitBlob(r.git, sha);
    }
    if (!bytes) return null;
    return bytes.byteLength > maxBytes
      ? { kind: 'too_large', size: bytes.byteLength }
      : { kind: 'file', bytes };
  }

  async commitParent(repo: string, sha: string): Promise<string | null> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    if (r.git) return localCommitParent(r.git, sha);
    return r.parents.get(sha) ?? null;
  }

  async commitTree(repo: string, sha: string): Promise<string | null> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    if (r.git)
      return git(r.git, ['rev-parse', '--verify', `${sha}^{tree}`]).then(
        (v) => v.trim(),
        () => null,
      );
    const files = r.files.get(sha);
    if (!files) return null;
    const hash = createHash('sha256');
    for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.byteLength}:`);
      hash.update(bytes);
    }
    return hash.digest('hex');
  }

  async requiredStatusChecks(repo: string, branch: string): Promise<string[]> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    if (!(await this.headOf(r, branch))) throw new GitHubError(`Unknown branch: ${branch}`, 404);
    return [...(r.requiredChecks.get(branch) ?? [])];
  }

  async commitStatuses(repo: string, sha: string): Promise<GhCommitStatus[]> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    if (!(await this.hasCommit(r, sha))) throw new GitHubError(`No commit found for SHA: ${sha}`, 422);
    return [...(r.statuses.get(sha) ?? [])];
  }

  async fileAt(repo: string, sha: string, path: string, maxBytes: number): Promise<GhFileVersion | null> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    if (r.git) return localFileAt(r.git, sha, path, { maxBytes });
    const bytes = r.files.get(sha)?.get(path);
    if (!bytes) return null;
    return bytes.byteLength > maxBytes
      ? { kind: 'too_large', size: bytes.byteLength }
      : { kind: 'file', bytes };
  }

  async mergePullRequest(merge: {
    repo: string;
    number: number;
    method: MergeMethod;
    sha?: string;
    title: string;
    message: string;
  }) {
    this.connected();
    await this.ready();
    const failure = this.failNextMerge;
    this.failNextMerge = null;
    if (failure) throw failure;
    const r = this.repo(merge.repo);
    const pr = this.pr(r, merge.number);
    if (pr.state !== 'open') throw new GitHubError('Pull Request is not mergeable', 405);
    if (merge.sha && !sameSha(pr.headSha, merge.sha))
      throw new GitHubError('Head branch was modified. Review and try the merge again.', 409);
    const now = new Date().toISOString();
    const sha = sha40();
    Object.assign(pr, {
      state: 'closed',
      merged: true,
      mergedAt: now,
      mergedBy: this.login,
      mergeSha: sha,
      updatedAt: now,
    });
    r.shas.add(sha);
    if (!r.git) {
      const before = r.branches.get(pr.base);
      if (before) r.parents.set(sha, before);
      const files = r.files.get(pr.headSha);
      if (files) r.files.set(sha, new Map(files));
      r.branches.set(pr.base, sha);
    }
    this.merges.push({ repo: merge.repo, number: merge.number, method: merge.method });
    return { merged: true, sha, message: 'Pull Request successfully merged' };
  }

  async copyRepo(source: string, copy: { owner: string; name: string; template: boolean }): Promise<GhRepo> {
    this.connected();
    await this.ready();
    const from = this.repo(source);
    const fullName = `${copy.owner}/${copy.name}`;
    if (this.repos.has(fullName)) throw new GitHubError(`Unprocessable: ${fullName} already exists`, 422);
    const made = await this.addRepo({
      fullName,
      description: from.description,
      language: from.language,
      defaultBranch: from.defaultBranch,
      pushedAt: from.pushedAt,
    });
    return { ...this.ghRepo(made), private: copy.template, canPush: true };
  }

  async createRepo(spec: GhRepoSpec & { owner: string; ownAccount: boolean }): Promise<GhRepo> {
    this.connected();
    await this.ready();
    const from = spec.template ? this.repo(spec.template) : null;
    const fullName = `${spec.owner}/${spec.name}`;
    if (this.repos.has(fullName)) throw new GitHubError(`Unprocessable: ${fullName} already exists`, 422);
    const made = await this.addRepo({
      fullName,
      description: spec.description,
      language: from?.language ?? null,
      defaultBranch: from?.defaultBranch ?? 'main',
      pushedAt: null,
    });
    made.private = spec.visibility !== 'public';
    return { ...this.ghRepo(made), canPush: true };
  }

  async ownerAvatar(owner: string, _size: number): Promise<GhAvatar | null> {
    // Public on GitHub: a logged-out fake still answers.
    const login = owner.toLowerCase();
    this.avatarReads.push(login);
    return this.ownersWithoutPicture.has(login) ? null : { contentType: 'image/png', bytes: FAKE_AVATAR_PNG };
  }

  /**
   * A workflow run's check runs are those whose page is one of its jobs (`…/actions/runs/<id>/job/<job>`): its failed
   * ones start again as new jobs, as GitHub's re-run does; refused while one of them is still going, as GitHub does.
   */
  async rerunFailedJobs(repo: string, runId: number): Promise<void> {
    this.connected();
    await this.ready();
    const failure = this.failNextRerun;
    this.failNextRerun = null;
    if (failure) throw failure;
    const r = this.repo(repo);
    const page = `https://github.com/${repo}/actions/runs/${runId}/job/`;
    const jobs = [...r.checks.values()].flat().filter((c) => c.url?.startsWith(page));
    if (!jobs.length) throw new GitHubError('Not Found', 404);
    if (jobs.some((c) => c.status !== 'completed'))
      throw new GitHubError('This workflow run is not completed', 403);
    for (const c of jobs) {
      if (c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped') continue;
      const id = this.nextId++;
      Object.assign(c, {
        id,
        status: 'queued',
        conclusion: null,
        startedAt: null,
        completedAt: null,
        url: `${page}${id}`,
      });
    }
    this.reruns.push({ repo, runId });
  }

  /** A check run whose page is a job of a workflow run, with what `simulateCheckRun` said of its steps. */
  async actionsJob(repo: string, jobId: number): Promise<GhActionsJob> {
    this.connected();
    await this.ready();
    this.jobReads.push({ repo, jobId });
    const r = this.repo(repo);
    const page = new RegExp(`/actions/runs/(\\d+)/job/${jobId}$`);
    // The newest: job ids are unique on GitHub, a test may reuse one in another workflow run.
    const check = [...r.checks.values()].flat().findLast((c) => c.url && page.test(c.url));
    const runId = check?.url ? Number(page.exec(check.url)?.[1]) : 0;
    if (!check?.url || !runId) throw new GitHubError('Not Found', 404);
    const details = this.jobDetails.get(check.url);
    return {
      id: jobId,
      runId,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      steps: details?.steps ?? [],
      annotations: details?.annotations ?? [],
    };
  }

  async dispatchWorkflow(runReq: {
    repo: string;
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void> {
    this.connected();
    await this.ready();
    const r = this.repo(runReq.repo);
    const entry: FakeRun = {
      id: this.nextId++,
      workflow: runReq.workflow,
      ref: runReq.ref,
      inputs: runReq.inputs,
      createdAt: Date.now(),
    };
    r.runs.push(entry);
    this.dispatched.push({ ...entry, repo: r.fullName });
  }

  /* Conditional reads --------------------------------------------------------------------------- */

  private note<T>(what: string, answer: Conditional<T>): Conditional<T> {
    this.reads.push({ what, status: answer.modified ? 200 : 304 });
    return answer;
  }

  private toGhPr(r: FakeRepo, pr: FakePr, single = false): GhPullRequest {
    return {
      number: pr.number,
      url: `https://github.fake.whombat.local/${r.fullName}/pull/${pr.number}`,
      title: pr.title,
      body: pr.body,
      headRef: pr.head,
      fork: pr.fork ?? null,
      headSha: pr.headSha,
      baseRef: pr.base,
      state: pr.state,
      merged: pr.merged,
      mergedAt: pr.mergedAt,
      mergedBy: pr.mergedBy,
      mergeCommitSha: pr.merged ? (pr.mergeSha ?? null) : null,
      draft: pr.draft ?? false,
      author: pr.authorLogin,
      authorBot: pr.authorBot ?? /\[bot\]$/i.test(pr.authorLogin),
      authorAssociation: pr.authorAssociation === undefined ? 'CONTRIBUTOR' : pr.authorAssociation,
      assignees: [...(pr.assignees ?? [])],
      requestedReviewers: [...pr.requestedReviewers],
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      additions: single ? pr.additions : null,
      deletions: single ? pr.deletions : null,
      changedFiles: single ? pr.changedFiles : null,
    };
  }

  async openPullRequests(repo: string, etags: readonly string[]): Promise<ConditionalPages<GhPullRequest>> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    await this.refresh(r);
    const open = [...r.prs.values()]
      .filter((p) => p.state === 'open')
      .sort((a, b) => b.number - a.number)
      .map((p) => this.toGhPr(r, p));
    const answer = this.note(`pulls ${repo}`, conditional(open, etags[0] ?? null));
    return answer.modified ? { modified: true, etags: [answer.etag ?? ''], data: answer.data } : answer;
  }

  async closedPullRequests(repo: string, etag: string | null): Promise<Conditional<GhPullRequest[]>> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    const closed = [...r.prs.values()]
      .filter((p) => p.state === 'closed')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
      .slice(0, 30)
      .map((p) => this.toGhPr(r, p));
    return this.note(`closed pulls ${repo}`, conditional(closed, etag));
  }

  async openIssues(repo: string, etag: string | null): Promise<Conditional<GhIssue[]>> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    const open = [...r.issues.values()]
      .filter((i) => i.state === 'open')
      .sort((a, b) => b.number - a.number)
      .slice(0, 50)
      .map((i) => this.toGhIssue(r, i));
    return this.note(`issues ${repo}`, conditional(open, etag));
  }

  async checkRuns(repo: string, sha: string, etag: string | null): Promise<Conditional<GhCheckRun[]>> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    if (!(await this.hasCommit(r, sha))) throw new GitHubError(`No commit found for SHA: ${sha}`, 422);
    const runs = [...r.checks.entries()].filter(([s]) => sameSha(s, sha)).flatMap(([, list]) => list);
    return this.note(`checks ${repo}@${sha.slice(0, 7)}`, conditional(runs, etag));
  }

  /** One page of reviews (the fake does not paginate). */
  async reviews(repo: string, number: number, etags: readonly string[]): Promise<ConditionalPages<GhReview>> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    this.pr(r, number); // 404 for a PR GitHub does not have
    const list = r.reviews
      .filter((v) => v.prNumber === number)
      .map(({ prNumber: _n, comments: _c, ...v }) => v);
    const answer = this.note(`reviews ${repo}#${number}`, conditional(list, etags[0] ?? null));
    return answer.modified ? { modified: true, etags: [answer.etag ?? ''], data: answer.data } : answer;
  }

  async repoInfo(repo: string, etag: string | null): Promise<Conditional<GhRepo>> {
    this.connected();
    await this.ready();
    return this.note(`repo ${repo}`, conditional(this.ghRepo(this.repo(repo)), etag));
  }

  async branchHead(repo: string, branch: string, etag: string | null): Promise<Conditional<string | null>> {
    this.connected();
    await this.ready();
    const head = await this.headOf(this.repo(repo), branch);
    if (head === null)
      return this.note(`branch ${repo}:${branch}`, { modified: true, etag: null, data: null });
    return this.note(`branch ${repo}:${branch}`, conditional(head, etag));
  }

  async workflowRuns(repo: string, etag: string | null): Promise<Conditional<GhWorkflowRun[]>> {
    this.connected();
    await this.ready();
    const r = this.repo(repo);
    const delay = this.options.workflowDelayMs ?? 30;
    const now = Date.now();
    const list = [...r.runs].reverse().map((w): GhWorkflowRun => {
      const done = now - w.createdAt >= delay;
      return {
        id: w.id,
        name: w.workflow,
        displayTitle: `Deploy ${w.inputs.whombat_approval ?? ''}`.trim(),
        path: `.github/workflows/${w.workflow}`,
        event: 'workflow_dispatch',
        status: done ? 'completed' : 'in_progress',
        conclusion: done ? (this.options.workflowConclusion ?? 'success') : null,
        headBranch: w.ref,
        url: `https://github.fake.whombat.local/${r.fullName}/actions/runs/${w.id}`,
        createdAt: new Date(w.createdAt).toISOString(),
        runStartedAt: new Date(w.createdAt).toISOString(),
        updatedAt: new Date(done ? w.createdAt + Math.max(delay, 1) : w.createdAt).toISOString(),
      };
    });
    return this.note(`runs ${repo}`, conditional(list, etag));
  }

  /* Things that happen on GitHub (dev, tests, demo) --------------------------------------------- */

  /** Someone pushes commits to a branch (of a fork: `fork`); an open PR on it moves its head. */
  async simulatePush(p: {
    repo: string;
    branch: string;
    fork?: string;
    commits: {
      sha: string;
      message: string;
      authorEmail?: string | null;
      authorName?: string;
      authorLogin?: string;
    }[];
  }): Promise<void> {
    await this.ready();
    const r = this.repo(p.repo);
    const last = p.commits.at(-1);
    if (!last) return;
    const now = new Date().toISOString();
    const key = prBranch({ headRef: p.branch, fork: p.fork ?? null });
    for (const c of p.commits) {
      r.shas.add(c.sha);
      r.commits.set(c.sha, {
        sha: c.sha,
        message: c.message,
        authorName: c.authorName ?? null,
        authorEmail: c.authorEmail ?? null,
        authorLogin: c.authorLogin ?? null,
        at: now,
        branch: key,
      });
    }
    if (!p.fork) {
      r.branches.set(p.branch, last.sha);
      r.pushedAt = now;
    }
    for (const pr of r.prs.values())
      if (pr.state === 'open' && pr.head === p.branch && (pr.fork ?? null) === (p.fork ?? null))
        Object.assign(pr, { headSha: last.sha, updatedAt: now });
  }

  /**
   * In-memory repos: the files at commit `sha` (every file of that version; text or bytes) and its first parent, for
   * `fileAt`, `mergeBase` and `commitParent`.
   */
  async simulateFiles(f: {
    repo: string;
    sha: string;
    files: Record<string, string | Uint8Array>;
    parent?: string;
  }): Promise<void> {
    await this.ready();
    const r = this.repo(f.repo);
    r.shas.add(f.sha);
    r.files.set(
      f.sha,
      new Map(
        Object.entries(f.files).map(([path, v]) => [
          path,
          typeof v === 'string' ? new TextEncoder().encode(v) : v,
        ]),
      ),
    );
    if (f.parent) r.parents.set(f.sha, f.parent);
  }

  /** A check run reports on a commit (CI); a run of the same name on that commit is replaced. */
  async simulateCheckRun(c: {
    repo: string;
    sha: string;
    name: string;
    status?: 'queued' | 'in_progress' | 'completed';
    conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | null;
    title?: string | null;
    durationMs?: number | null;
    url?: string | null;
    /** A GitHub Actions job's steps and annotations, as `actionsJob` answers them (needs `url`). */
    steps?: GhActionsJob['steps'];
    annotations?: string[];
  }): Promise<void> {
    await this.ready();
    const r = this.repo(c.repo);
    if (c.url && (c.steps || c.annotations))
      this.jobDetails.set(c.url, { steps: c.steps ?? [], annotations: c.annotations ?? [] });
    const status = c.status ?? (c.conclusion ? 'completed' : 'in_progress');
    const completed = status === 'completed' ? new Date() : null;
    // Without a duration the run reports no start (the check shows its tests or state, not "0s").
    const started =
      completed && c.durationMs != null
        ? new Date(completed.getTime() - c.durationMs)
        : completed
          ? null
          : new Date();
    const list = r.checks.get(c.sha) ?? [];
    const runEntry: GhCheckRun = {
      id: list.find((x) => x.name === c.name)?.id ?? this.nextId++,
      name: c.name,
      headSha: c.sha,
      status,
      conclusion: status === 'completed' ? (c.conclusion ?? 'success') : null,
      startedAt: started?.toISOString() ?? null,
      completedAt: completed?.toISOString() ?? null,
      url: c.url ?? null,
      outputTitle: c.title ?? null,
      outputSummary: null,
    };
    const at = list.findIndex((x) => x.name === c.name);
    if (at >= 0) list[at] = runEntry;
    else list.push(runEntry);
    r.checks.set(c.sha, list);
  }

  /** A review is submitted on GitHub. */
  async simulateReview(v: {
    repo: string;
    number: number;
    login: string;
    state: 'approved' | 'changes_requested' | 'commented';
    body?: string;
    comments?: GhReviewComment[];
  }): Promise<number> {
    await this.ready();
    const r = this.repo(v.repo);
    const pr = this.pr(r, v.number);
    const id = this.nextId++;
    const now = new Date().toISOString();
    r.reviews.push({
      id,
      prNumber: v.number,
      state: v.state,
      author: v.login,
      body: v.body ?? '',
      submittedAt: now,
      comments: v.comments ?? [],
    });
    pr.requestedReviewers = pr.requestedReviewers.filter((l) => l !== v.login);
    pr.updatedAt = now;
    return id;
  }

  /** Someone opens a pull request on GitHub (from a branch of `fork` when set). */
  async simulateOpenPullRequest(o: {
    repo: string;
    head: string;
    fork?: string;
    base?: string;
    title: string;
    body?: string;
    login: string;
    reviewers?: string[];
    files?: GhFile[];
    /** Opened as a draft. */
    draft?: boolean;
    /** The login is a bot's (also any `…[bot]` login). */
    bot?: boolean;
    /** GitHub's `author_association` of `login` (default CONTRIBUTOR). */
    association?: string | null;
  }): Promise<number> {
    await this.ready();
    const r = this.repo(o.repo);
    const key = prBranch({ headRef: o.head, fork: o.fork ?? null });
    let headSha = o.fork
      ? ([...r.commits.values()].filter((c) => c.branch === key).at(-1)?.sha ?? null)
      : await this.headOf(r, o.head);
    if (!headSha) {
      headSha = sha40();
      if (!o.fork) r.branches.set(o.head, headSha);
      r.shas.add(headSha);
      r.commits.set(headSha, {
        sha: headSha,
        message: o.title,
        authorName: o.login,
        authorEmail: null,
        authorLogin: o.login,
        at: new Date().toISOString(),
        branch: key,
      });
    }
    const number = this.nextNumber(r);
    const files = o.files ?? (await this.diffFiles(r, o.base ?? r.defaultBranch, o.head));
    const now = new Date().toISOString();
    r.prs.set(number, {
      number,
      title: o.title,
      body: o.body ?? '',
      head: o.head,
      fork: o.fork ?? null,
      base: o.base ?? r.defaultBranch,
      headSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergedBy: null,
      closedBy: null,
      authorLogin: o.login,
      requestedReviewers: o.reviewers ?? [],
      createdAt: now,
      updatedAt: now,
      files,
      additions: files.reduce((n, f) => n + f.add, 0),
      deletions: files.reduce((n, f) => n + f.del, 0),
      changedFiles: files.length,
      draft: o.draft ?? false,
      authorBot: o.bot ?? /\[bot\]$/i.test(o.login),
      authorAssociation: o.association === undefined ? 'CONTRIBUTOR' : o.association,
    });
    return number;
  }

  /** A draft pull request is marked ready for review on GitHub. */
  async simulateReadyForReview(o: { repo: string; number: number }): Promise<void> {
    await this.ready();
    const pr = this.pr(this.repo(o.repo), o.number);
    Object.assign(pr, { draft: false, updatedAt: new Date().toISOString() });
  }

  /** Someone opens an issue on GitHub. Returns its number. */
  async simulateOpenIssue(o: {
    repo: string;
    title: string;
    body?: string;
    login: string;
    /** The login is a bot's (also any `…[bot]` login). */
    bot?: boolean;
    labels?: string[];
    /** When GitHub says it was opened (default: now). */
    createdAt?: string;
    /** GitHub's `author_association` of `login` (default CONTRIBUTOR; null: GitHub doesn't say). */
    association?: string | null;
    /** Logins assigned to it. */
    assignees?: string[];
  }): Promise<number> {
    await this.ready();
    const r = this.repo(o.repo);
    const number = this.nextNumber(r);
    r.issues.set(number, {
      number,
      title: o.title,
      body: o.body ?? '',
      authorLogin: o.login,
      authorBot: o.bot ?? /\[bot\]$/i.test(o.login),
      authorAssociation: o.association === undefined ? 'CONTRIBUTOR' : o.association,
      assignees: o.assignees ?? [],
      labels: o.labels ?? [],
      state: 'open',
      createdAt: o.createdAt ?? new Date().toISOString(),
    });
    return number;
  }

  /** Someone is assigned to an issue or pull request on GitHub (`logins` replaces who was). */
  async simulateAssign(o: { repo: string; number: number; logins: string[] }): Promise<void> {
    await this.ready();
    const r = this.repo(o.repo);
    const issue = r.issues.get(o.number);
    if (issue) {
      issue.assignees = [...o.logins];
      return;
    }
    this.pr(r, o.number).assignees = [...o.logins];
  }

  /** An issue is closed (or reopened) on GitHub. */
  async simulateIssueState(o: { repo: string; number: number; state: 'open' | 'closed' }): Promise<void> {
    await this.ready();
    const issue = this.repo(o.repo).issues.get(o.number);
    if (!issue) throw new GitHubError('Not Found', 404);
    issue.state = o.state;
  }

  /** Someone asks for reviews on GitHub. */
  async simulateRequestReviewers(o: { repo: string; number: number; logins: string[] }): Promise<void> {
    await this.ready();
    const pr = this.pr(this.repo(o.repo), o.number);
    pr.requestedReviewers = [...new Set([...pr.requestedReviewers, ...o.logins])];
    pr.updatedAt = new Date().toISOString();
  }

  /** A pull request is closed (or merged) on GitHub; `reopen` opens it again. */
  async simulateClose(c: { repo: string; number: number; login: string; merged: boolean }): Promise<void> {
    await this.ready();
    const r = this.repo(c.repo);
    const pr = this.pr(r, c.number);
    const now = new Date().toISOString();
    // A merge lands as a new commit on the base whose parent is the base's head before it (in-memory repos).
    let mergeSha: string | null = null;
    if (c.merged) {
      mergeSha = sha40();
      r.shas.add(mergeSha);
      if (!r.git) {
        const before = r.branches.get(pr.base);
        if (before) r.parents.set(mergeSha, before);
        const files = r.files.get(pr.headSha);
        if (files) r.files.set(mergeSha, new Map(files));
        r.branches.set(pr.base, mergeSha);
      }
    }
    Object.assign(pr, {
      state: 'closed',
      merged: c.merged,
      mergedAt: c.merged ? now : null,
      mergedBy: c.merged ? c.login : null,
      mergeSha,
      closedBy: c.login,
      updatedAt: now,
    });
  }

  /**
   * A commit on `branch` after its head (in-memory repos): what a deploy of a later revision runs. Returns its sha; its
   * parent is the branch's head, so `compareStatus(head, it)` is `ahead` (report-trackers.md TA-30).
   */
  async simulateCommitOn(c: { repo: string; branch: string }): Promise<string> {
    await this.ready();
    const r = this.repo(c.repo);
    const sha = sha40();
    const before = r.branches.get(c.branch);
    if (before) r.parents.set(sha, before);
    r.branches.set(c.branch, sha);
    r.shas.add(sha);
    return sha;
  }

  async simulateReopen(c: { repo: string; number: number }): Promise<void> {
    await this.ready();
    const pr = this.pr(this.repo(c.repo), c.number);
    Object.assign(pr, { state: 'open', closedBy: null, updatedAt: new Date().toISOString() });
  }
}
