/**
 * Workspaces for coding agents. Each (burrow, repo, branch) has a git dir of its own that Whombat owns — the
 * workspace repo, `<root>/<burrow>/.repos/<repo>/<branch>.git` — whose history comes from Whombat's mirror per
 * (burrow, repo) at `<root>/<burrow>/.mirrors/<repo>.git`: the objects a workspace needs are fetched from it (copied).
 *
 * The agent commits into its workspace repo and nowhere else: its sandbox can write that repo (but not its config,
 * hooks, info, alternates or its admin dir's `commondir`), and nothing of the mirror, not a file that does not exist
 * there yet (`commondir`, `packed-refs`). Its checkout is a git worktree of the workspace repo at
 * `<root>/<burrow>/<repo>/<branch>`. The agent's git finds its admin dir through the worktree's `.git` file (read-only
 * to the agent, restored at the next prepare), so its environment names no git dir and git it runs in another folder (a
 * test fixture's `git init`) is that folder's own.
 *
 * Credentials come from a callback (the runner asks the server's `git-credentials` endpoint) and travel only in the git
 * subprocess env as an `http.extraHeader`, never in a URL, argv or on-disk config. Fetches and pushes always go to that
 * https remote.
 *
 * The runner runs git outside the agent's sandbox, so it never trusts what the agent could write:
 * - every git call pins its git dir and common dir (`GIT_DIR`, `GIT_COMMON_DIR`: a `commondir` file is never
 *   followed) and names the work tree; a worktree's admin dir is found from the workspace repo, never from the
 *   worktree's `.git` file;
 * - hooks, fsmonitor, submodule recursion, replace refs and credential helpers are off on the command line;
 *   git runs with an allowlisted environment and no system or global config, so in a workspace repo (whose
 *   config is Whombat's) no attribute filter can run at all;
 * - pushes (the only git call that holds a write token) run from a fresh bare repo the runner creates for
 *   that push outside every workspace (`<root>/.push/…`, the workspace repo's objects as alternates), to an
 *   explicit URL — no config, hook or remote the agent could have touched is read.
 * `commitPaths()` lists what the agent's sandbox must let it write to commit (and what stays read-only).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { devNull } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { defaultWorkspaceRoot } from '../host';
import { providerEnv } from '../support/env';
import { LOCAL_ORIGINS_DIR, localRemoteConfig, sharedGitCommand } from './local-origin';
import { LockBusyError, withHostLock } from './lock';

export interface WorkspaceTarget {
  burrow: string;
  repo: string;
  branch: string;
  baseBranch: string;
  cloneUrl: string;
  /** Commit identity for this workspace only (the agent's name and a no-reply address). */
  identity?: { name: string; email: string };
  /**
   * The branch's head as Whombat knows it (its pull request's, `DispatchContext.workspace.headSha`): when the source's
   * `origin/<branch>` is already there, nothing is fetched from GitHub (turn-efficiency.md TE-10).
   */
  headSha?: string | null;
}

export type GitOperation = 'fetch' | 'push';

/**
 * The server↔runner convention for a pull request's checkout (Whombat automation-recipes.md): the branch
 * `pull/<n>/head` is that pull request's head as GitHub keeps it, `refs/pull/<n>/head` — also when its branch is in a
 * fork. Fetching it lands it at `refs/remotes/origin/pull/<n>/head`, where every other branch's remote-tracking ref is,
 * so preparing, exporting and diffing it work as for any branch. Only read-only checkouts get one (nothing is pushed).
 */
export function pullRequestRef(branch: string): string | null {
  const m = /^pull\/([1-9][0-9]{0,9})\/head$/.exec(branch);
  return m ? `refs/pull/${m[1]}/head` : null;
}

/** Credentials for one git operation (`runner.gitCredentials`: the host gh account's token), or null for none. */
export type GitCredentialsProvider = (request: {
  repo: string;
  branch: string;
  operation: GitOperation;
  /** Push only: the commit being pushed (the server signs the push as the agent only when GitHub has it). */
  sha?: string;
}) => Promise<{ token: string; remoteUrl?: string } | null>;

export interface WorkspaceManagerOptions {
  /** Default `WHOMBAT_WORKSPACES` or `~/.whombat/workspaces`. */
  root?: string;
  credentials?: GitCredentialsProvider;
  /** git binary (default `git`). */
  git?: string;
  /** Base environment for git (default `process.env`); only an allowlist of it reaches git. */
  env?: NodeJS.ProcessEnv;
  /**
   * Holder files of the host-wide workspace locks (MSB-12; default `<root>/.locks`). The locks themselves are
   * kernel-held (`lock.ts`): shared operations on one repository serialise across every runner process.
   */
  lockDir?: string;
  /** How long an operation waits for another process's (default 5 minutes), then `WorkspaceBusyError`. */
  lockWaitMs?: number;
  /** Who holds the locks this manager takes (the dispatch id), for the refusal. */
  holder?: string;
  /**
   * Managed mode (MSB-11): this turn's fencing token. A workspace remembers the newest token that prepared it;
   * a manager with an older one (a stale runner generation, an earlier attempt of the same dispatch) may no
   * longer prepare or push from it (`WorkspaceFencedError`).
   */
  fence?: WorkspaceFence;
}

/** A turn's claim on its workspace: the runner generation, the dispatch and its attempt. */
export interface WorkspaceFence {
  generation: number;
  dispatch: string;
  attempt: number;
}

/** A newer runner generation (or a later attempt of the dispatch) owns the workspace now. */
export class WorkspaceFencedError extends Error {
  constructor(
    readonly path: string,
    readonly owner: string,
  ) {
    super(`The workspace ${path} belongs to a newer turn (${owner}); this one may not write to it any more.`);
    this.name = 'WorkspaceFencedError';
  }
}

/** Another process held a shared operation on the repository longer than `lockWaitMs`. */
export class WorkspaceBusyError extends Error {
  constructor(
    readonly key: string,
    readonly holder: string | null,
  ) {
    super(`Another turn${holder ? ` (${holder})` : ''} is still working on ${key}.`);
    this.name = 'WorkspaceBusyError';
  }
}

/** A token stored in a workspace repo's config: `<generation> <dispatch> <attempt>`. */
function parseFence(text: string): WorkspaceFence | null {
  const [g, dispatch, a] = text.trim().split(/\s+/);
  const generation = Number(g);
  const attempt = Number(a);
  if (!dispatch || !Number.isInteger(generation) || !Number.isInteger(attempt)) return null;
  return { generation, dispatch, attempt };
}

/** `mine` is stale when a newer generation, or a later attempt of the same dispatch, prepared the workspace. */
export function fenceIsStale(mine: WorkspaceFence, recorded: WorkspaceFence | null): boolean {
  if (!recorded) return false;
  if (recorded.generation > mine.generation) return true;
  return recorded.dispatch === mine.dispatch && recorded.attempt > mine.attempt;
}

export interface PreparedWorkspace {
  path: string;
  branch: string;
  head: string;
  /** The worktree was created now (false: an existing one was reused). */
  created: boolean;
  /**
   * What the agent's environment needs for its git (and its CLI's): nothing — git finds the worktree's `.git` file, which
   * names its admin dir, and every other folder's git stays that folder's (a `GIT_DIR` here sent a test fixture's commit
   * in a temporary folder onto the agent's branch). The runner's own git pins both.
   */
  env: Record<string, string>;
}

/** A branch's change against its base (`WorkspaceManager.changes`). */
export interface BranchChanges {
  /** `abc1234 Subject` per commit, newest first. */
  commits: string;
  stat: string;
  patch: string;
  /** The patch was cut at the byte limit. */
  truncated: boolean;
}

/** What the agent's sandbox must allow for it to commit, and keep read-only (absolute paths). */
export interface CommitPaths {
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

export interface CleanupResult {
  /** Paths removed (worktrees, workspace repos, scratch and push dirs). */
  removed: string[];
  /** Workspaces that were due but hold work that is nowhere else, and why. */
  kept: { path: string; reason: string }[];
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(`git ${args[0] ?? ''} failed: ${stderr.trim().split('\n').slice(-2).join(' ') || `exit ${code}`}`);
    this.name = 'GitError';
  }
}

/**
 * On every git command line: no hooks, no fsmonitor, no submodule recursion, no credential helper and no
 * `ext::` transport, whatever a config file says (command-line config wins over every file).
 */
const HARDENED = [
  '-c',
  `core.hooksPath=${devNull}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'submodule.recurse=false',
  '-c',
  'credential.helper=',
  '-c',
  'protocol.ext.allow=never',
];

/** Where the runner creates its one-off push repos (`<root>/.push`), next to `.scratch`. */
const PUSH_DIR = '.push';
const SCRATCH_DIR = '.scratch';
/** Holder files of the host-wide workspace locks (`lock.ts`). */
const LOCKS_DIR = '.locks';
/** The runner's cache of the conversations' Files (files-space.md FS-09): bounded by the runner itself. */
const FILES_CACHE_DIR = '.files-cache';
/** Per burrow: the workspace repos (`.repos/<repo>/<branch>.git`). */
const REPOS_DIR = '.repos';
const MIRRORS_DIR = '.mirrors';

/**
 * Who and when for the cleanup's throwaway squash commit (`#squashed`): fixed, so a workspace repo without an
 * identity can make it and every sweep makes the same object, not a new one.
 */
const SQUASH_CHECK_ENV = {
  GIT_AUTHOR_NAME: 'Whombat',
  GIT_AUTHOR_EMAIL: 'runner@whombat.invalid',
  GIT_AUTHOR_DATE: '@1000000000 +0000',
  GIT_COMMITTER_NAME: 'Whombat',
  GIT_COMMITTER_EMAIL: 'runner@whombat.invalid',
  GIT_COMMITTER_DATE: '@1000000000 +0000',
};

/**
 * Which repo a git call runs against: its git dir, its common dir (default: the git dir) and, for commands
 * that need one, the work tree. Both dirs are pinned in the environment.
 */
interface GitRepo {
  gitDir: string;
  commonDir?: string;
  workTree?: string;
}

/** Where a target's history comes from: Whombat's mirror (its real path, so every lock on it has the same key). */
interface Source {
  gitDir: string;
  commonDir: string;
}

/** A `/`-separated part that maps to itself: lowercase, no leading dot or dash, no `--`, no trailing dash. */
const PLAIN_PART = /^[a-z0-9_](?:[a-z0-9._]|-(?=[a-z0-9._]))*$/;

/**
 * One path segment from a repo / branch / burrow name, one-to-one (two names never share a directory,
 * also on case-insensitive file systems). Plain names read as they are, `/` as `--`: `feat/invoice-pdf`
 * → `feat--invoice-pdf`, `whombat/billing` → `whombat--billing` — unambiguous because a plain part never
 * contains `--` or starts or ends with `-`. Any other name (capitals, `--`, other characters, very long)
 * is a readable form plus `~` and a hash of the exact name: `feat--x` → `feat--x~5b1d…`. Plain forms never
 * contain `~`, so the two kinds cannot meet; nor can `.mirrors`, `.repos`, `.push` or `.scratch`.
 */
export function safeSegment(name: string): string {
  const parts = name.split('/');
  if (parts.every((p) => PLAIN_PART.test(p))) {
    const plain = parts.join('--');
    if (plain.length <= 120) return plain;
  }
  const readable = name
    .trim()
    .replace(/\//g, '--')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 80);
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 12);
  return `${!readable || readable.startsWith('.') ? `_${readable}` : readable}~${hash}`;
}

/** `WHOMBAT_WORKSPACES`, else `$WHOMBAT_HOME/workspaces` (`~/.whombat/workspaces`). */
export { defaultWorkspaceRoot };

function validBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch.length <= 255 &&
    !branch.startsWith('-') &&
    !branch.includes('..') &&
    !/[\s~^:?*[\\]|@\{|\/\/|\.lock$|\/$|^\//.test(branch)
  );
}

/** Operations on one git dir are serialised across every manager in this process (one per dispatch). */
const LOCKS = new Map<string, Promise<unknown>>();
/** Checkouts a turn in this process works in right now (`hold`), which cleanup leaves alone. */
const HELD = new Map<string, number>();

export class WorkspaceManager {
  readonly root: string;
  readonly #options: WorkspaceManagerOptions;

  constructor(options: WorkspaceManagerOptions = {}) {
    this.#options = options;
    this.root = options.root ?? defaultWorkspaceRoot(options.env);
  }

  paths(target: Pick<WorkspaceTarget, 'burrow' | 'repo' | 'branch'>): {
    mirror: string;
    worktree: string;
    repo: string;
  } {
    const burrow = join(this.root, safeSegment(target.burrow));
    return {
      mirror: join(burrow, MIRRORS_DIR, `${safeSegment(target.repo)}.git`),
      worktree: join(burrow, safeSegment(target.repo), safeSegment(target.branch)),
      repo: join(burrow, REPOS_DIR, safeSegment(target.repo), `${safeSegment(target.branch)}.git`),
    };
  }

  /** The directory the agent works in: the worktree. */
  workPath(target: WorkspaceTarget): string {
    return this.paths(target).worktree;
  }

  /**
   * Marks the target's checkout as in use by a turn of this process until the returned function is called;
   * `cleanup()` leaves it alone meanwhile.
   */
  hold(target: WorkspaceTarget): () => void {
    const key = this.workPath(target);
    HELD.set(key, (HELD.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (HELD.get(key) ?? 1) - 1;
      if (n > 0) HELD.set(key, n);
      else HELD.delete(key);
    };
  }

  /** Fetches the repo into the mirror and returns a worktree on `branch` (created from `baseBranch` if new). */
  async prepare(target: WorkspaceTarget): Promise<PreparedWorkspace> {
    for (const b of [target.branch, target.baseBranch]) {
      if (!validBranch(b)) throw new Error(`Invalid branch name: ${b}`);
    }
    const source = await this.#source(target);
    const { worktree } = this.paths(target);
    return this.#locked(source.commonDir, async () => {
      await this.#ensureMirror(target, source.gitDir);
      if (!(await this.#current(target, source))) await this.#fetch(target, source.gitDir);
      const repoPath = await this.#ensureRepo(target, source);
      await this.#fenced(repoPath, true);
      const agentRepo = { gitDir: repoPath };
      const ref = `refs/heads/${target.branch}`;
      let admin = await this.#adminDir(repoPath, worktree);
      if (!admin) {
        const legacy = await this.#legacyAdmin(target, worktree);
        if (legacy) admin = await this.#adopt(target, legacy, repoPath, worktree);
      }
      const created = !admin;
      if (created) {
        await this.#git(agentRepo, ['worktree', 'prune']);
        if (existsSync(worktree)) await rm(worktree, { recursive: true, force: true });
        await mkdir(dirname(worktree), { recursive: true });
        if (!(await this.#resolve(agentRepo, ref))) {
          // An earlier layout's local branch in the mirror, else the branch on GitHub, else the base.
          const start =
            (await this.#resolve(source, ref)) ??
            (await this.#resolve(agentRepo, `refs/remotes/origin/${target.branch}`)) ??
            (await this.#resolve(agentRepo, `refs/remotes/origin/${target.baseBranch}`));
          if (!start) throw new Error(`Base branch ${target.baseBranch} does not exist in ${target.repo}.`);
          await this.#git(agentRepo, ['update-ref', ref, start]);
        }
        await this.#git(agentRepo, ['worktree', 'add', '--quiet', worktree, target.branch]);
        admin = await this.#adminDir(repoPath, worktree);
      }
      if (!admin) throw new Error(`git did not register the worktree ${worktree}.`);
      await this.#upstream(agentRepo, target.branch);
      await this.#sealAdmin(admin);
      const wt = { gitDir: admin, commonDir: repoPath, workTree: worktree };
      if (!created) {
        await this.#restoreGitFile(worktree, admin);
        const clean = !(await this.#git(wt, ['status', '--porcelain', '--ignore-submodules=all'])).trim();
        // The worktree belongs to `branch`: put it back there if it was switched (never over local work).
        const on = (await this.#git(wt, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
        if (on !== ref) {
          if (!clean) {
            const where = on.replace(/^refs\/heads\//, '') || 'a detached HEAD';
            throw new Error(
              `The workspace for ${target.branch} is on ${where} with local changes; not using it.`,
            );
          }
          await this.#git(wt, ['switch', '--quiet', '--no-guess', target.branch]);
        }
        // Bring a clean, behind worktree up to date; never touch local work.
        if (clean) await this.#git(wt, ['merge', '--ff-only', '@{u}']).catch(() => '');
        const now = new Date();
        await utimes(worktree, now, now).catch(() => {});
      }
      const head = (await this.#git(wt, ['rev-parse', 'HEAD'])).trim();
      return {
        path: worktree,
        branch: target.branch,
        head,
        created,
        // Nothing to pin: the worktree's `.git` file names `admin` (see `env`).
        env: {},
      };
    });
  }

  /**
   * Commits on `branch` that the remote does not have yet (compared with `origin/<branch>`, or with
   * `origin/<baseBranch>` for a branch that was never pushed). 0 when there is no workspace.
   */
  async ahead(target: WorkspaceTarget): Promise<number> {
    const source = await this.#source(target);
    return this.#locked(source.commonDir, async () => {
      const repoPath = this.paths(target).repo;
      if (!existsSync(join(repoPath, 'HEAD'))) return 0;
      await this.#sanitizeRepo(repoPath);
      const agentRepo = { gitDir: repoPath };
      const branch = `refs/heads/${target.branch}`;
      const remote = (await this.#resolve(agentRepo, `refs/remotes/origin/${target.branch}`))
        ? `refs/remotes/origin/${target.branch}`
        : `refs/remotes/origin/${target.baseBranch}`;
      if (!(await this.#resolve(agentRepo, branch)) || !(await this.#resolve(agentRepo, remote))) return 0;
      const out = await this.#git(agentRepo, ['rev-list', '--count', `${remote}..${branch}`]);
      return Number.parseInt(out.trim(), 10) || 0;
    });
  }

  /**
   * What `branch` changes against its base (from their merge base), for a read-only review of it: the commits, a
   * stat and the patch, cut at `maxBytes`. Null when the workspace has no such branch or base. Read with the
   * runner's hardened git: no external diff drivers or text conversions run.
   */
  async changes(target: WorkspaceTarget, maxBytes = 24_000): Promise<BranchChanges | null> {
    const source = await this.#source(target);
    return this.#locked(source.commonDir, async () => {
      const repoPath = this.paths(target).repo;
      if (!existsSync(join(repoPath, 'HEAD'))) return null;
      await this.#sanitizeRepo(repoPath);
      const agentRepo = { gitDir: repoPath };
      const branch = await this.#reviewRef(agentRepo, target.branch);
      const base = `refs/remotes/origin/${target.baseBranch}`;
      if (!branch || !(await this.#resolve(agentRepo, base))) return null;
      const plain = ['--no-color', '--no-ext-diff', '--no-textconv'];
      const commits = await this.#git(agentRepo, [
        'log',
        '--no-color',
        '--format=%h %s',
        '--max-count=50',
        `${base}..${branch}`,
      ]);
      const stat = await this.#git(agentRepo, ['diff', ...plain, '--stat', `${base}...${branch}`]);
      const patch = await this.#git(agentRepo, ['diff', ...plain, `${base}...${branch}`]);
      const truncated = Buffer.byteLength(patch) > maxBytes;
      return {
        commits: commits.trim(),
        stat: stat.trim(),
        patch: truncated ? Buffer.from(patch).subarray(0, maxBytes).toString('utf8') : patch,
        truncated,
      };
    });
  }

  /**
   * The files of `branch` (as GitHub has it, else as the workspace has it) written into `dir`, with no git
   * metadata: a read-only checkout for a turn that only reads (an automation's investigator or reviewer). It lives
   * outside the workspaces root every sandbox denies, and never touches a worktree an agent works in.
   * Call `prepare(target)` first (it fetches). Returns the commit exported.
   */
  async exportTree(target: WorkspaceTarget, dir: string): Promise<string> {
    const source = await this.#source(target);
    return this.#locked(source.commonDir, async () => {
      const repoPath = this.paths(target).repo;
      await this.#sanitizeRepo(repoPath);
      const agentRepo = { gitDir: repoPath };
      const ref = await this.#reviewRef(agentRepo, target.branch);
      const sha = ref ? await this.#resolve(agentRepo, ref) : null;
      if (!sha) throw new Error(`${target.branch} is not in the workspace for ${target.repo}.`);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const index = `${dir}.index`;
      const wt = { gitDir: repoPath, workTree: dir };
      try {
        await this.#git(wt, ['read-tree', sha], { GIT_INDEX_FILE: index });
        await this.#git(wt, ['checkout-index', '--all', '--force'], { GIT_INDEX_FILE: index });
      } finally {
        await rm(index, { force: true });
      }
      return sha;
    });
  }

  /** The ref a review reads: the branch as last fetched from GitHub, else the workspace's own branch. */
  async #reviewRef(repo: GitRepo, branch: string): Promise<string | null> {
    for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`])
      if (await this.#resolve(repo, ref)) return ref;
    return null;
  }

  /**
   * Pushes `branch` (credentials asked with operation `push`) from a one-off bare repo that borrows the
   * workspace repo's objects, so the token only ever meets config and hooks the runner wrote itself — and
   * always to the https remote the server names.
   */
  async push(target: WorkspaceTarget): Promise<void> {
    const source = await this.#source(target);
    return this.#locked(source.commonDir, async () => {
      const repoPath = this.paths(target).repo;
      const agentRepo = { gitDir: repoPath };
      const ref = `refs/heads/${target.branch}`;
      if (existsSync(join(repoPath, 'HEAD'))) await this.#sanitizeRepo(repoPath);
      await this.#fenced(repoPath, false);
      const sha = existsSync(join(repoPath, 'HEAD')) ? await this.#resolve(agentRepo, ref) : null;
      if (!sha) throw new Error(`No workspace for ${target.repo} ${target.branch}.`);
      const { env, remoteUrl } = await this.#credentials(target, 'push', sha);
      const pushRepo = await this.#pushRepo(repoPath);
      try {
        await this.#git(
          { gitDir: pushRepo },
          ['push', '--quiet', '--no-verify', remoteUrl, `${sha}:${ref}`],
          env,
          localRemoteConfig(remoteUrl),
        );
        // Whombat's mirror's copy of the branch is GitHub's again — the pushed commit, taken locally from the runner's
        // own clean push repo — so the next turn on this head fetches nothing (turn-efficiency.md TE-10).
        await this.#git({ gitDir: pushRepo }, ['update-ref', 'refs/heads/pushed', sha])
          .then(() =>
            this.#git(
              source,
              [
                'fetch',
                '--quiet',
                '--no-tags',
                '--no-write-fetch-head',
                pushRepo,
                `+refs/heads/pushed:refs/remotes/origin/${target.branch}`,
              ],
              {},
              ['protocol.file.allow=always'],
            ),
          )
          .catch(() => '');
      } finally {
        await rm(pushRepo, { recursive: true, force: true });
      }
      await this.#git(agentRepo, ['update-ref', `refs/remotes/origin/${target.branch}`, sha]);
      await this.#upstream(agentRepo, target.branch);
    });
  }

  /**
   * Whether the source already has the branch at the head Whombat knows (`headSha`, turn-efficiency.md TE-10): its
   * `origin/<branch>` is that commit. Then the fetch is skipped; the base stays as it was last fetched (an agent that
   * needs a newer one fetches it itself).
   */
  async #current(target: WorkspaceTarget, source: Source): Promise<boolean> {
    if (!target.headSha) return false;
    const have = await this.#resolve(source, `refs/remotes/origin/${target.branch}`);
    return have !== null && have.toLowerCase() === target.headSha.toLowerCase();
  }

  /**
   * What the agent's sandbox must let it write to commit on `branch`, and what stays read-only:
   * - writable: the workspace repo — its own git dir. Its top level too: every `git commit` deletes the
   *   `AUTO_MERGE` pseudo-ref, which locks `packed-refs` there (read-only, each commit says “error: Unable to
   *   create …/packed-refs.lock”). Whatever the agent creates there is its own repo's (`packed-refs`, a
   *   `commondir` no git outside the sandbox follows: the runner pins `GIT_COMMON_DIR`, agents' git and CLIs
   *   run on the admin dir, whose `commondir` stays read-only);
   * - read-only inside it: what code outside the sandbox trusts — the repo's `config`, `hooks`, `info`,
   *   `objects/info` (its alternates), the admin dir's `commondir`, `gitdir` and `config.worktree`;
   * - read-only elsewhere: the worktree's `.git` file (the mirror's objects were copied into the repo).
   * Nothing of the mirror is writable, not even a file that does not exist there yet.
   */
  async commitPaths(target: WorkspaceTarget): Promise<CommitPaths> {
    const { repo, worktree } = this.paths(target);
    if (existsSync(repo)) await this.#sanitizeRepo(repo);
    const admin = await this.#adminDir(repo, worktree);
    const guard = [join(worktree, '.git')];
    if (!admin || !existsSync(admin)) return { allowRead: [], allowWrite: [], denyWrite: guard };
    return {
      allowRead: [],
      // The admin dir and `objects` are listed too: Codex's bubblewrap setup binds each writable root, and
      // cannot make the read-only files inside them (`commondir`, `objects/info`) under a denied parent without.
      allowWrite: [repo, admin, join(repo, 'objects')],
      denyWrite: [
        ...['config', 'hooks', 'info', join('objects', 'info')].map((p) => join(repo, p)),
        ...['commondir', 'gitdir', 'config.worktree'].map((p) => join(admin, p)),
        ...guard,
      ],
    };
  }

  /** Removes one workspace (worktree and workspace repo: local, unpushed work is lost). */
  async remove(target: Pick<WorkspaceTarget, 'burrow' | 'repo' | 'branch'>): Promise<void> {
    const { mirror, worktree, repo } = this.paths(target);
    return this.#locked(mirror, async () => {
      if (existsSync(mirror) && (await this.#adminDir(mirror, worktree)))
        await this.#removeWorktree(mirror, worktree);
      if (existsSync(repo)) await this.#removeWorktree(repo, worktree);
      await rm(worktree, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    });
  }

  /**
   * Removes workspaces nobody needs any more, never work that is nowhere else:
   * - a worktree (and its workspace repo) whose branch is merged into its base on GitHub (as last fetched;
   *   squash-merged too) and was not used for `mergedAfterMs` (default a day), or not used for `olderThanMs` — when it has no
   *   uncommitted changes (untracked files count) and every commit is on GitHub;
   * - a workspace repo without a worktree (a worktree deleted by hand) not used for `olderThanMs`, when its commits
   *   are on GitHub;
   * - scratch and push dirs older than `olderThanMs`.
   * Checkouts a turn holds (`hold`) are skipped. Returns what was removed and what was kept, and why.
   */
  async cleanup(options: {
    olderThanMs: number;
    mergedAfterMs?: number;
    now?: number;
  }): Promise<CleanupResult> {
    const now = options.now ?? Date.now();
    const mergedAfter = options.mergedAfterMs ?? 86_400_000;
    const result: CleanupResult = { removed: [], kept: [] };
    if (!existsSync(this.root)) return result;
    const idle = async (path: string) => {
      const s = await stat(path).catch(() => null);
      return s ? now - s.mtimeMs : null;
    };
    for (const burrow of await readdir(this.root)) {
      // Local repos' origins (repositories.md RP-02) are what agents push to, never a workspace.
      if (burrow === LOCKS_DIR || burrow === LOCAL_ORIGINS_DIR || burrow === FILES_CACHE_DIR) continue;
      if (burrow === SCRATCH_DIR || burrow === PUSH_DIR) {
        for (const dir of await readdir(join(this.root, burrow)).catch(() => [] as string[])) {
          const path = join(this.root, burrow, dir);
          const age = await idle(path);
          if (age !== null && age > options.olderThanMs) {
            await rm(path, { recursive: true, force: true });
            result.removed.push(path);
          }
        }
        continue;
      }
      const burrowDir = join(this.root, burrow);
      // Worktrees.
      for (const repo of await readdir(burrowDir).catch(() => [] as string[])) {
        if ([MIRRORS_DIR, REPOS_DIR].includes(repo)) continue;
        for (const branch of await readdir(join(burrowDir, repo)).catch(() => [] as string[])) {
          const path = join(burrowDir, repo, branch);
          const age = await idle(path);
          if (age === null || HELD.has(path)) continue;
          await this.#cleanupWorktree(
            burrowDir,
            repo,
            branch,
            path,
            age,
            options.olderThanMs,
            mergedAfter,
            result,
          );
        }
      }
      // Workspace repos without a worktree (a worktree removed by hand).
      for (const repo of await readdir(join(burrowDir, REPOS_DIR)).catch(() => [] as string[])) {
        for (const entry of await readdir(join(burrowDir, REPOS_DIR, repo)).catch(() => [] as string[])) {
          const repoPath = join(burrowDir, REPOS_DIR, repo, entry);
          const worktree = join(burrowDir, repo, entry.replace(/\.git$/, ''));
          if (existsSync(worktree)) continue;
          const age = await idle(repoPath);
          if (age === null || age <= options.olderThanMs) continue;
          const why = await this.#locked(await this.#sourceKey(repoPath), async () => {
            const reason = await this.#unsaved(repoPath, null);
            if (!reason) await rm(repoPath, { recursive: true, force: true });
            return reason;
          });
          if (why) result.kept.push({ path: repoPath, reason: why });
          else result.removed.push(repoPath);
        }
      }
    }
    return result;
  }

  async #cleanupWorktree(
    burrowDir: string,
    repo: string,
    branch: string,
    path: string,
    age: number,
    olderThanMs: number,
    mergedAfterMs: number,
    result: CleanupResult,
  ): Promise<void> {
    const repoPath = join(burrowDir, REPOS_DIR, repo, `${branch}.git`);
    // Where the worktree is registered: its workspace repo, or (before those) the mirror.
    const candidates = [repoPath, join(burrowDir, MIRRORS_DIR, `${repo}.git`)];
    let owner: string | null = null;
    let admin: string | null = null;
    for (const gitDir of candidates) {
      if (!existsSync(gitDir)) continue;
      admin = await this.#adminDir(gitDir, path);
      if (admin) {
        owner = gitDir;
        break;
      }
    }
    if (!owner || !admin) {
      // Not a checkout git knows about any more: what is in it cannot be told apart from work.
      if (age > olderThanMs) result.kept.push({ path, reason: 'not a checkout of any repo Whombat knows' });
      return;
    }
    const key = owner === repoPath ? await this.#sourceKey(repoPath) : owner;
    await this.#locked(key, async () => {
      const wt = { gitDir: admin as string, commonDir: owner as string, workTree: path };
      const merged = await this.#merged(owner as string, admin as string, owner === repoPath);
      if (!(merged && age > mergedAfterMs) && !(age > olderThanMs)) return;
      const dirty = (
        await this.#git(wt, ['status', '--porcelain', '--ignore-submodules=all']).catch(() => 'unreadable')
      ).trim();
      if (dirty) {
        result.kept.push({ path, reason: 'uncommitted changes' });
        return;
      }
      const why = merged ? null : await this.#unsaved(owner as string, admin);
      if (why) {
        result.kept.push({ path, reason: why });
        return;
      }
      await this.#removeWorktree(owner as string, path);
      if (owner === repoPath) await rm(repoPath, { recursive: true, force: true });
      result.removed.push(path);
    });
  }

  /**
   * Whether the checkout's branch is in its base on GitHub, as last fetched into the workspace repo or its
   * source (a workspace repo records its base; older checkouts do not, so they are never "merged"): its HEAD is
   * in the base's history (a merge commit, a fast-forward), or its whole change is (a squash merge, `#squashed`).
   * The source's base is read with the source's objects: a mirror-backed repo only has those of its last prepare.
   * `own`: the checkout is a workspace repo's, where the squash check may write its throwaway commit (never the
   * mirror).
   */
  async #merged(commonDir: string, admin: string, own: boolean): Promise<boolean> {
    const repo = { gitDir: admin, commonDir };
    const base = (
      await this.#git({ gitDir: commonDir }, ['config', '--get', 'whombat.base']).catch(() => '')
    ).trim();
    const tip = await this.#resolve(repo, 'HEAD');
    if (!base || !tip) return false;
    const sourceDir = await this.#sourceKey(commonDir);
    const wheres: [GitRepo, NodeJS.ProcessEnv][] = [
      [repo, {}],
      [{ gitDir: sourceDir }, { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(sourceDir, 'objects') }],
    ];
    for (const [where, env] of wheres) {
      const into = await this.#resolve(where, `refs/remotes/origin/${base}`);
      if (!into) continue;
      const ok = await this.#git(repo, ['merge-base', '--is-ancestor', tip, into], env).then(
        () => true,
        () => false,
      );
      if (ok || (own && (await this.#squashed(repo, tip, into, env)))) return true;
    }
    return false;
  }

  /**
   * Whether the branch's whole change since it left the base is already in the base (`into`) as one commit,
   * as a squash merge lands it: HEAD's tree as a single commit on the merge base, which `git cherry` finds in
   * the base by patch id. That commit is written to the workspace repo but never referenced (the same object at
   * every sweep). A branch with no change of its own, or with more than the base has, is not squashed.
   */
  async #squashed(repo: GitRepo, tip: string, into: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    const read = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
      this.#git(repo, args, { ...env, ...extra }).then(
        (out) => out.trim(),
        () => '',
      );
    const mb = await read(['merge-base', tip, into]);
    if (!mb || mb === tip || mb === into) return false;
    const [tree, baseTree] = await Promise.all([
      read(['rev-parse', '--verify', '--quiet', `${tip}^{tree}`]),
      read(['rev-parse', '--verify', '--quiet', `${mb}^{tree}`]),
    ]);
    if (!tree || tree === baseTree) return false;
    const squash = await read(
      ['commit-tree', '--no-gpg-sign', tree, '-p', mb, '-m', 'squash-check'],
      SQUASH_CHECK_ENV,
    );
    if (!squash) return false;
    // `-` <commit>: an equivalent change is in the base already.
    const cherry = await read(['cherry', into, squash]);
    return cherry.split('\n').some((line) => line.startsWith('- '));
  }

  /**
   * Why a checkout's branch holds work that is nowhere else (null: none): commits on no remote-tracking ref. A branch it
   * cannot read counts as work.
   */
  async #unsaved(commonDir: string, admin: string | null): Promise<string | null> {
    const repo = { gitDir: admin ?? commonDir, commonDir };
    const name = admin
      ? null
      : (await this.#git(repo, ['config', '--get', 'whombat.branch']).catch(() => '')).trim();
    if (name === '') return 'its branch is unknown';
    const tip = await this.#resolve(repo, name ? `refs/heads/${name}` : 'HEAD');
    if (!tip) return name ? null : 'its HEAD could not be read';
    const out = await this.#git(repo, ['rev-list', '--count', tip, '--not', '--remotes=origin']).catch(
      () => 'x',
    );
    const n = Number.parseInt(out.trim(), 10);
    if (Number.isNaN(n)) return 'its history could not be read';
    return n > 0 ? `${n} commit(s) not on GitHub` : null;
  }

  /** The source a workspace repo was last prepared from (its common dir: the key `prepare` locks on). */
  async #sourceKey(repoPath: string): Promise<string> {
    const recorded = (
      await this.#git({ gitDir: repoPath }, ['config', '--get', 'whombat.source']).catch(() => '')
    ).trim();
    if (recorded) return recorded;
    const alternate = (await this.#alternates(repoPath))[0];
    return alternate ? dirname(alternate) : repoPath;
  }

  /** An empty scratch directory for non-coding turns (`<root>/.scratch/<id>`). */
  async scratch(id: string): Promise<string> {
    const path = join(this.root, SCRATCH_DIR, safeSegment(id));
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  async removeScratch(id: string): Promise<void> {
    await rm(join(this.root, SCRATCH_DIR, safeSegment(id)), { recursive: true, force: true });
  }

  async #source(target: WorkspaceTarget): Promise<Source> {
    const path = this.paths(target).mirror;
    // Real paths, so every lock on this source (cleanup's too) has the same key.
    const mirror = await realpath(path).catch(() => path);
    return { gitDir: mirror, commonDir: mirror };
  }

  /**
   * The workspace repo for a target, made if missing: a bare repo whose config is the runner's (the remote for
   * `@{u}` and the agent's identity, no filters, no automatic gc), whose objects and remote-tracking refs are fetched
   * from the mirror.
   */
  async #ensureRepo(target: WorkspaceTarget, source: Source): Promise<string> {
    const repoPath = this.paths(target).repo;
    const agentRepo = { gitDir: repoPath };
    if (!existsSync(join(repoPath, 'HEAD')) || !existsSync(join(repoPath, 'config'))) {
      await rm(repoPath, { recursive: true, force: true });
      await mkdir(repoPath, { recursive: true, mode: 0o700 });
      await this.#git(agentRepo, ['init', '--bare', '--quiet', '--template=']);
    }
    for (const dir of [
      'hooks',
      'info',
      join('objects', 'info'),
      join('logs', 'refs', 'heads'),
      join('refs', 'heads'),
    ])
      await mkdir(join(repoPath, dir), { recursive: true });
    await this.#sanitizeRepo(repoPath);
    await this.#fromMirror(target, source, repoPath);
    // A shallow source's boundary, so history walks stop where the source's do.
    const shallow = join(source.commonDir, 'shallow');
    if (existsSync(shallow)) await copyFile(shallow, join(repoPath, 'shallow'));
    else await rm(join(repoPath, 'shallow'), { force: true });
    const settings: [string, string][] = [
      ['core.logAllRefUpdates', 'true'],
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      ['remote.origin.url', target.cloneUrl],
      ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['whombat.branch', target.branch],
      ['whombat.base', target.baseBranch],
      ['whombat.source', source.commonDir],
    ];
    if (target.identity)
      settings.push(['user.name', target.identity.name], ['user.email', target.identity.email]);
    const current = await this.#git(agentRepo, ['config', '--local', '--list']).catch(() => '');
    for (const [key, value] of settings) {
      if (!current.split('\n').includes(`${key.toLowerCase()}=${value}`))
        await this.#git(agentRepo, ['config', '--local', key, value]);
    }
    return repoPath;
  }

  /**
   * A workspace repo of the mirror has objects of its own, fetched from the mirror (locally): the mirror is every
   * agent's of the burrow, so never in a turn's sandbox. Copies the base and branch remote-tracking refs, and the
   * mirror's local branch (an earlier layout's) when the repo has none.
   */
  async #fromMirror(target: WorkspaceTarget, source: Source, repoPath: string): Promise<void> {
    const agentRepo = { gitDir: repoPath };
    const specs: string[] = [];
    for (const b of new Set([target.baseBranch, target.branch])) {
      const ref = `refs/remotes/origin/${b}`;
      if (await this.#resolve(source, ref)) specs.push(`+${ref}:${ref}`);
    }
    const ref = `refs/heads/${target.branch}`;
    if (!(await this.#resolve(agentRepo, ref)) && (await this.#resolve(source, ref)))
      specs.push(`${ref}:${ref}`);
    if (specs.length > 0)
      await this.#git(agentRepo, [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        source.gitDir,
        ...specs,
      ]);
  }

  /**
   * Undoes what an agent could have left at the workspace repo's writable top level to mislead the
   * runner's git: a `commondir` file (git would treat the repo as a linked worktree and take refs from wherever
   * it points, even with `GIT_COMMON_DIR` pinned) and a stale `packed-refs.lock`. The repo is its own common
   * dir, so it never has a real `commondir`.
   */
  async #sanitizeRepo(repoPath: string): Promise<void> {
    await rm(join(repoPath, 'commondir'), { recursive: true, force: true });
    await rm(join(repoPath, 'packed-refs.lock'), { recursive: true, force: true });
  }

  async #alternates(repoPath: string): Promise<string[]> {
    return (await readFile(join(repoPath, 'objects', 'info', 'alternates'), 'utf8').catch(() => ''))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /** `@{u}` of the branch in the workspace repo, once the branch is on GitHub. */
  async #upstream(agentRepo: GitRepo, branch: string): Promise<void> {
    if (!(await this.#resolve(agentRepo, `refs/remotes/origin/${branch}`))) return;
    const merge = (
      await this.#git(agentRepo, ['config', '--get', `branch.${branch}.merge`]).catch(() => '')
    ).trim();
    if (merge === `refs/heads/${branch}`) return;
    await this.#git(agentRepo, ['config', `branch.${branch}.remote`, 'origin']);
    await this.#git(agentRepo, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
  }

  /** Files of an admin dir the agent's sandbox keeps read-only must exist to be bound. */
  async #sealAdmin(admin: string): Promise<void> {
    const file = join(admin, 'config.worktree');
    if (!existsSync(file)) await writeFile(file, '');
  }

  /** A worktree registered, before workspace repos, in the mirror. */
  async #legacyAdmin(
    target: WorkspaceTarget,
    worktree: string,
  ): Promise<{ gitDir: string; admin: string } | null> {
    const gitDir = this.paths(target).mirror;
    if (!existsSync(gitDir)) return null;
    const admin = await this.#adminDir(gitDir, worktree);
    return admin ? { gitDir, admin } : null;
  }

  /**
   * Moves a worktree registered in the mirror (before workspace repos) into its workspace repo, files and index as they
   * are: the branch's commit was fetched into the repo already (`#fromMirror`), the worktree's `.git` names a new admin
   * dir, the old admin dir goes.
   */
  async #adopt(
    target: WorkspaceTarget,
    legacy: { gitDir: string; admin: string },
    repoPath: string,
    worktree: string,
  ): Promise<string | null> {
    const old = { gitDir: legacy.gitDir };
    const agentRepo = { gitDir: repoPath };
    const ref = `refs/heads/${target.branch}`;
    const sha = await this.#resolve(old, ref);
    let admin: string | null = null;
    if (sha && existsSync(worktree)) {
      if (!(await this.#resolve(agentRepo, ref))) await this.#git(agentRepo, ['update-ref', ref, sha]);
      admin = join(repoPath, 'worktrees', basename(worktree));
      await rm(admin, { recursive: true, force: true });
      await mkdir(join(admin, 'logs'), { recursive: true });
      await writeFile(join(admin, 'HEAD'), `ref: ${ref}\n`);
      await writeFile(join(admin, 'commondir'), '../..\n');
      await writeFile(join(admin, 'gitdir'), `${join(await realpath(worktree), '.git')}\n`);
      const index = join(legacy.admin, 'index');
      if (existsSync(index)) await copyFile(index, join(admin, 'index')).catch(() => {});
      await rm(join(worktree, '.git'), { recursive: true, force: true });
      await writeFile(join(worktree, '.git'), `gitdir: ${admin}\n`);
    }
    await rm(legacy.admin, { recursive: true, force: true });
    await this.#git(old, ['worktree', 'prune']).catch(() => '');
    return admin;
  }

  async #removeWorktree(gitDir: string, worktree: string): Promise<void> {
    if (existsSync(gitDir)) {
      await this.#git({ gitDir }, ['worktree', 'remove', '--force', worktree]).catch(() => '');
    }
    await rm(worktree, { recursive: true, force: true });
    if (existsSync(gitDir)) await this.#git({ gitDir }, ['worktree', 'prune']).catch(() => '');
  }

  async #ensureMirror(target: WorkspaceTarget, mirror: string): Promise<void> {
    if (existsSync(join(mirror, 'HEAD'))) return;
    await rm(mirror, { recursive: true, force: true });
    await mkdir(mirror, { recursive: true });
    const bare = { gitDir: mirror };
    await this.#git(bare, ['init', '--bare', '--quiet', '--template=']);
    await this.#git(bare, ['remote', 'add', 'origin', target.cloneUrl]);
    await this.#git(bare, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  }

  async #fetch(target: WorkspaceTarget, mirror: string): Promise<void> {
    const { env, remoteUrl } = await this.#credentials(target, 'fetch');
    await this.#git({ gitDir: mirror }, ['remote', 'set-url', 'origin', remoteUrl]);
    await this.#git(
      { gitDir: mirror },
      ['fetch', '--prune', '--quiet', 'origin'],
      env,
      localRemoteConfig(remoteUrl),
    );
    // A pull request's head (`pull/<n>/head`): not under refs/heads, so fetched by itself, after the prune.
    const pull = pullRequestRef(target.branch);
    if (pull)
      await this.#git(
        { gitDir: mirror },
        ['fetch', '--quiet', '--no-tags', 'origin', `+${pull}:refs/remotes/origin/${target.branch}`],
        env,
        localRemoteConfig(remoteUrl),
      );
  }

  /** Asks for credentials; returns the remote to use and the env carrying the auth header. */
  async #credentials(
    target: WorkspaceTarget,
    operation: GitOperation,
    sha?: string,
  ): Promise<{ remoteUrl: string; env: NodeJS.ProcessEnv }> {
    const creds = await this.#options.credentials?.({
      repo: target.repo,
      branch: target.branch,
      operation,
      ...(sha ? { sha } : {}),
    });
    const remoteUrl = creds?.remoteUrl || target.cloneUrl;
    if (!creds?.token) return { remoteUrl, env: {} };
    const basic = Buffer.from(`x-access-token:${creds.token}`).toString('base64');
    return {
      remoteUrl,
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      },
    };
  }

  /** A fresh bare repo for one push: no hooks, no remotes, its objects borrowed from the workspace repo. */
  async #pushRepo(repoPath: string): Promise<string> {
    const base = join(this.root, PUSH_DIR);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(base, 'push-'));
    await this.#git({ gitDir: dir }, ['init', '--bare', '--quiet', '--template=']);
    await mkdir(join(dir, 'objects', 'info'), { recursive: true });
    await writeFile(join(dir, 'objects', 'info', 'alternates'), `${resolve(repoPath, 'objects')}\n`);
    const shallow = join(repoPath, 'shallow');
    if (existsSync(shallow)) await copyFile(shallow, join(dir, 'shallow'));
    return dir;
  }

  /**
   * The worktree's admin dir (`<git dir>/worktrees/<id>`), found from the git dir: the one whose `gitdir`
   * names `<worktree>/.git`. Null when the worktree is not registered (or gone).
   */
  async #adminDir(gitDir: string, worktree: string): Promise<string | null> {
    const real = await realpath(worktree).catch(() => null);
    if (!real) return null;
    const expected = join(real, '.git');
    const ids = await readdir(join(gitDir, 'worktrees')).catch(() => [] as string[]);
    // The id git gives a worktree first (its directory's name), so nothing else can claim it.
    const preferred = basename(worktree);
    for (const id of [...ids.filter((i) => i === preferred), ...ids.filter((i) => i !== preferred)]) {
      const admin = join(gitDir, 'worktrees', id);
      const recorded = await readFile(join(admin, 'gitdir'), 'utf8').catch(() => null);
      if (recorded && resolve(admin, recorded.trim()) === expected) return admin;
    }
    return null;
  }

  /** Points the worktree's `.git` file back at its admin dir if the agent changed it (for its own git). */
  async #restoreGitFile(worktree: string, admin: string): Promise<void> {
    const file = join(worktree, '.git');
    const content = `gitdir: ${admin}\n`;
    const current = await lstat(file).catch(() => null);
    if (current?.isFile()) {
      const text = await readFile(file, 'utf8').catch(() => '');
      const named = text.startsWith('gitdir:') ? text.slice('gitdir:'.length).trim() : null;
      if (named && (await realpath(resolve(worktree, named)).catch(() => null)) === (await realpath(admin)))
        return;
    }
    await rm(file, { recursive: true, force: true });
    await writeFile(file, content, { flag: 'wx' });
  }

  /** The commit a ref names (peeled), or null. */
  async #resolve(repo: GitRepo, ref: string): Promise<string | null> {
    const out = await this.#git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(
      () => '',
    );
    return out.trim() || null;
  }

  #git(
    repo: GitRepo,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
    config: string[] = [],
  ): Promise<string> {
    return this.#run(
      args,
      repo.workTree ?? repo.gitDir,
      {
        GIT_DIR: repo.gitDir,
        GIT_COMMON_DIR: repo.commonDir ?? repo.gitDir,
        ...(repo.workTree ? { GIT_WORK_TREE: repo.workTree } : {}),
        ...extraEnv,
      },
      config,
    );
  }

  /** git with the hardened command line and an allowlisted environment (`GIT_DIR` only when given). */
  #run(
    args: string[],
    cwd: string,
    extraEnv: NodeJS.ProcessEnv = {},
    config: string[] = [],
  ): Promise<string> {
    const env = {
      // Nothing of the runner's own environment (tokens, secrets) and no system / global git config.
      ...providerEnv(this.#options.env ?? process.env, { pass: [] }),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_ATTR_NOSYSTEM: '1',
      // Replace refs would let a workspace repo show the runner other commits than the ones it pushes.
      GIT_NO_REPLACE_OBJECTS: '1',
      // Reading state never rewrites an index.
      GIT_OPTIONAL_LOCKS: '0',
      ...extraEnv,
    };
    // A push into a local origin writes into the folder the server shares (goal-first.md GF-08): under umask 007.
    const local = config.includes('protocol.file.allow=always');
    const intoLocalOrigin = args[0] === 'push' && local;
    // The origin belongs to the server: receive-pack and upload-pack run in processes of their own, which get none of
    // the command's `-c`, so without their own safe.directory they refuse it (“dubious ownership”) and the push or
    // fetch fails (goal-first.md GF-09).
    const safe = local ? config.find((c) => c.startsWith('safe.directory=')) : undefined;
    const pack =
      args[0] === 'push'
        ? 'receive-pack'
        : ['fetch', 'clone', 'ls-remote'].includes(args[0] ?? '')
          ? 'upload-pack'
          : null;
    const withPack =
      safe && pack
        ? [
            args[0] as string,
            `--${pack}=${this.#options.git ?? 'git'} -c '${safe}' ${pack}`,
            ...args.slice(1),
          ]
        : args;
    const argv = [...HARDENED, ...config.flatMap((c) => ['-c', c]), ...withPack];
    const command = intoLocalOrigin
      ? sharedGitCommand(this.#options.git ?? 'git', argv)
      : { file: this.#options.git ?? 'git', args: argv };
    return new Promise((resolvePromise, reject) => {
      execFile(
        command.file,
        command.args,
        { cwd, env, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error)
            reject(new GitError(args, String(stderr), typeof error.code === 'number' ? error.code : null));
          else resolvePromise(String(stdout));
        },
      );
    });
  }

  /**
   * Checks this manager's fencing token against the one the workspace repo recorded (under the repository's
   * lock), and with `claim` records it. Without a token (self-hosted) nothing is checked.
   */
  async #fenced(repoPath: string, claim: boolean): Promise<void> {
    const mine = this.#options.fence;
    if (!mine || !existsSync(join(repoPath, 'config'))) return;
    const repo = { gitDir: repoPath };
    const text = await this.#git(repo, ['config', '--get', 'whombat.fence']).catch(() => '');
    const recorded = parseFence(text);
    if (fenceIsStale(mine, recorded)) throw new WorkspaceFencedError(repoPath, text.trim());
    if (claim)
      await this.#git(repo, [
        'config',
        'whombat.fence',
        `${mine.generation} ${mine.dispatch} ${mine.attempt}`,
      ]);
  }

  #locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = LOCKS.get(key) ?? Promise.resolve();
    // In this process: one after the other. Across processes: the host-wide lock on the same key (MSB-12).
    const next = previous
      .catch(() => {})
      .then(() =>
        withHostLock(
          `ws:${key}`,
          {
            dir: this.#options.lockDir ?? join(this.root, LOCKS_DIR),
            holder: this.#options.holder ?? `pid ${process.pid}`,
            waitMs: this.#options.lockWaitMs ?? 5 * 60_000,
            pollMs: 50,
          },
          fn,
        ).catch((err: unknown) => {
          if (err instanceof LockBusyError) throw new WorkspaceBusyError(key, err.holder);
          throw err;
        }),
      );
    const settled = next.catch(() => {});
    LOCKS.set(key, settled);
    void settled.then(() => {
      if (LOCKS.get(key) === settled) LOCKS.delete(key);
    });
    return next;
  }
}

export { type HostLock, hostLock, hostLockWaiters, LockBusyError, withHostLock } from './lock';
