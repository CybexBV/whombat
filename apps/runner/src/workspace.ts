/**
 * Working directories for turns (one mode, hermes-engine.md HE-48):
 *
 * - Coding work (a dispatch with a `workspace`) is a git worktree of Whombat's own mirror under
 *   `<WHOMBAT_WORKSPACES>/<burrow>/<repo>/<branch>` (`WorkspaceManager`).
 * - A commands turn without a checkout (`isWorkFolderTurn`, one-person.md OP-S109) works in the agent's work folder,
 *   `~/work` in the agent's home (`agentWorkFolder`), kept between turns and read-write for its commands at the same
 *   path.
 * - Any other turn works in an empty directory in the runner's private temporary space (removed afterwards).
 * - A Whombat Feedback assessment works in an empty directory, or a read-only export of Whombat's own mirror of the
 *   repo's remote default branch (FB-21).
 * - A read-only workspace (an automation's investigator or reviewer, `workspace.access: 'read'`) is fetched the
 *   same way, then the branch's files are exported into a directory of its own (no git metadata, outside the
 *   workspaces root) that is removed after the turn; nothing is ever pushed from it.
 *
 * Git credentials come from the server's git-credentials endpoint (only for switched-on repos), in git's environment
 * only. Commits carry the agent's identity (`dusty@agents.<burrow>.whombat.com`), so pushes and PR commits map back to
 * the agent. Agents commit; the runner pushes (`pushIfAhead`): when the agent opens a pull request and after the turn —
 * only with push credentials, which the server gives only when the agent holds the branch key (403 Blocked for main,
 * 202 an approval for shared branches).
 */
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type CommitPaths,
  isWorkFolderTurn,
  WorkspaceBusyError,
  WorkspaceFencedError,
  WorkspaceManager,
  type WorkspaceTarget,
} from '@whombat/agent-runtime';
import { PrivateDirError, privateDir, runnerTmpRoot, shownPath } from '@whombat/agent-runtime/host';
import { agentCommitEmail, type DispatchContext, TURN_FAILURE_REASON_MAX } from '@whombat/core';
import { leaseOf, type RunnerApi, RunnerApiError } from './api';

export interface GitWorkspace {
  manager: WorkspaceManager;
  target: WorkspaceTarget;
}

/** The host as this runner sees it: what `~` means and Whombat's own directory. */
export interface RunnerHost {
  home: string;
  whombatHome: string;
  /**
   * The runner's private temporary directory (`runnerTmpRoot()`, `<tmp>/whombat-runner-<uid>`): empty working
   * directories and read-only exports (BP-C38). Every task sandbox denies it.
   */
  runnerTmp?: string;
  /** The runner's environment: where credentials were moved (`XDG_CONFIG_HOME`, `CODEX_HOME`, …). */
  env?: NodeJS.ProcessEnv;
  /**
   * Where people's provider sign-ins live (`WHOMBAT_CREDENTIALS_ROOT`, wherever it points): denied to every turn
   * (SUB-42, review CON-3); a turn's own home is its CLI's, never its tools'.
   */
  credentialsRoot?: string;
  /** The agent's home (I-3, `WHOMBAT_AGENT_HOME`; default `$WHOMBAT_HOME/agent/home`): its commands' `$HOME`. */
  agentHome?: string;
}

/** The agent's home on this host (one-person.md OP-S109). */
export function agentHomeOf(host: Pick<RunnerHost, 'agentHome' | 'whombatHome'>): string {
  return host.agentHome ?? join(host.whombatHome, 'agent', 'home');
}

export interface PreparedCwd {
  cwd: string;
  /** Removes an empty working directory or an export; workspaces are kept between turns. */
  release(): Promise<void>;
  note: string | null;
  /**
   * Why the turn has no checkout although it should have one (the fetch failed, it works in an empty directory
   * instead): reported to the server with the turn (`WorkspaceReport`, run-checkout.md RC-09).
   */
  problem?: string;
  /** The worktree, when the turn works on a checkout. */
  git: GitWorkspace | null;
  /** What the task sandbox must let the agent write to commit there. */
  commit: CommitPaths | null;
  /**
   * What the agent's environment needs for its git: nothing for a worktree, whose `.git` file names its git dir
   * (`PreparedWorkspace.env`); the work folder sets `GIT_CEILING_DIRECTORIES`.
   */
  env: Record<string, string>;
  /** The commit the checkout (or the read-only export) was made from; absent without one. */
  head?: string;
  /** The agent's work folder, for a commands turn without a checkout (OP-S109): `cwd`, kept between turns. */
  workFolder?: boolean;
  /**
   * An automation step's own folder (automation-recipes.md AR-43): in the work folder, at the same path for the agent's
   * commands, for what only this step needs, removed by `release`. Absent for every other turn.
   */
  stepFolder?: string;
}

export type PushResult =
  | { status: 'pushed'; commits: number }
  | { status: 'nothing' }
  | { status: 'blocked' | 'pending_approval' | 'failed'; message: string };

/**
 * The turn cannot start for a reason a person has to fix. `refusal` is what the agent says in the conversation; the
 * dispatch fails for good (no retry).
 */
export class TurnRefusal extends Error {
  constructor(
    readonly refusal: string,
    readonly code: string,
  ) {
    super(refusal);
    this.name = 'TurnRefusal';
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

/** The worktree target for a dispatch's workspace, with the agent as commit author. */
export function workspaceTarget(ctx: DispatchContext): WorkspaceTarget | null {
  const ws = ctx.workspace;
  if (!ws) return null;
  return {
    burrow: ctx.burrow.slug,
    repo: ws.repo,
    branch: ws.branch,
    baseBranch: ws.baseBranch,
    cloneUrl: ws.cloneUrl,
    identity: { name: ctx.agent.name, email: agentCommitEmail(ctx.agent.handle, ctx.burrow.slug) },
    // The head Whombat knows: no fetch when the copy here is already on it (turn-efficiency.md TE-10).
    ...(ws.headSha ? { headSha: ws.headSha } : {}),
  };
}

export function workspaceManager(
  ctx: DispatchContext,
  root: string,
  api: RunnerApi,
  /** Managed: this runner's generation — the workspace refuses an older one (MSB-11). */
  generation?: number,
): WorkspaceManager {
  return new WorkspaceManager({
    root,
    holder: ctx.dispatch.id,
    ...(generation !== undefined
      ? { fence: { generation, dispatch: ctx.dispatch.id, attempt: ctx.dispatch.attempts ?? 0 } }
      : {}),
    // The token travels to git in the environment only (WorkspaceManager); never in argv or on disk.
    credentials: async (req) => {
      const creds = await api.gitCredentials(ctx.dispatch.id, { ...req, ...leaseOf(ctx) });
      return { token: creds.token, remoteUrl: creds.remoteUrl };
    },
  });
}

/** What the runner's temporary directory holds, one directory each: empty working directories, read-only exports. */
const RUNNER_TMP_KINDS = ['scratch', 'read'] as const;

/**
 * `<runner tmp>/<kind>`, with the runner's temporary directory checked to be this user's alone first (BP-C38): on a
 * shared `/tmp` another user could otherwise make it, or a directory in it, and read or swap a turn's files. One that
 * isn't private refuses the turn.
 */
export async function runnerTmpDir(
  host: RunnerHost,
  kind: (typeof RUNNER_TMP_KINDS)[number],
): Promise<string> {
  const root = host.runnerTmp ?? runnerTmpRoot();
  try {
    await privateDir(root);
    for (const other of RUNNER_TMP_KINDS) await privateDir(join(root, other));
    return join(root, kind);
  } catch (err) {
    throw notPrivate(err, host);
  }
}

/** A `PrivateDirError` as the turn's refusal (BP-C38); anything else as it is. */
function notPrivate(err: unknown, host: RunnerHost): unknown {
  if (err instanceof PrivateDirError)
    return new TurnRefusal(
      `I can’t start: Whombat’s scratch directory ${shownPath(err.path, host.home)} ${err.why} Someone who runs this Whombat can remove it (or start the runner with another TMPDIR), then ask me again.`,
      'scratch_not_private',
    );
  return err;
}

/** The agent's work folder (OP-S109): `~/work` in its home, kept between turns. */
export function agentWorkFolder(agentHome: string): string {
  return join(agentHome, 'work');
}

/** The folder of the automation steps' own folders, in the agent's work folder (AR-43). */
export const STEP_FOLDERS_DIR = '.automation';

/**
 * An automation step's own folder (automation-recipes.md AR-43): `<work folder>/.automation/<dispatch>`, on the
 * persistent disk next to what the agent keeps (a copy of a checkout and its build can take gigabytes, more than the
 * runner's temporary space), removed when the turn ends.
 */
export function automationStepFolder(agentHome: string, dispatchId: string): string {
  return join(agentWorkFolder(agentHome), STEP_FOLDERS_DIR, safe(dispatchId));
}

/**
 * Step folders a turn left behind (the runner stopped mid-turn), older than `olderThanMs`: removed by the daily
 * cleanup (AR-43). Returns what it removed.
 */
export async function removeStaleStepFolders(
  agentHome: string,
  olderThanMs: number,
  now = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  const dir = join(agentWorkFolder(agentHome), STEP_FOLDERS_DIR);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (!st || now - st.mtimeMs < olderThanMs) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

/**
 * The work folder of a person's turn without a checkout (OP-S109): `~/work` in the agent's home, which the container
 * engine's user reaches too (I-3) — never through a link. Nothing is removed after the turn: clones and files stay for
 * the next one.
 */
async function agentWorkspace(host: RunnerHost): Promise<PreparedCwd> {
  const dir = agentWorkFolder(agentHomeOf(host));
  try {
    await mkdir(dir, { recursive: true });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new PrivateDirError(dir, 'is not a directory of its own.');
  } catch (err) {
    if (err instanceof PrivateDirError)
      throw new TurnRefusal(
        `I can’t start: my work folder ${shownPath(err.path, host.home)} ${err.why} Someone who runs this Whombat can remove it, then ask me again.`,
        'work_folder_not_private',
      );
    throw err;
  }
  return {
    cwd: dir,
    release: async () => {},
    note: null,
    git: null,
    commit: null,
    // Git in it never looks for a repository above it (the agent's home).
    env: { GIT_CEILING_DIRECTORIES: dirname(dir) },
    workFolder: true,
  };
}

async function scratch(
  ctx: DispatchContext,
  host: RunnerHost,
  note: string | null = null,
): Promise<PreparedCwd> {
  // A provider session lives in its working directory (Claude keys sessions by cwd), so turns of one session
  // share a directory name: the session's (docs/decisions/bp-memory.md). The server's one turn in flight per agent,
  // conversation and thread (hermes-native.md HN-T01) keeps two turns of one session from running at once.
  const dir = join(await runnerTmpDir(host, 'scratch'), safe(ctx.session?.scratchKey ?? ctx.dispatch.id));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return {
    cwd: dir,
    release: () => rm(dir, { recursive: true, force: true }),
    note,
    git: null,
    commit: null,
    env: {},
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A turn on a run, in run mode (RC-01): it exists to work in the run's checkout. */
export function isRunTurn(ctx: DispatchContext): boolean {
  return ctx.dispatch.mode === 'run' && Boolean(ctx.run);
}

/** “…, then choose Try again.” after a reason, never a second period (resourceful-agents.md RA-DS54). */
export function thenTryAgain(reason: string): string {
  const said = reason.trim().replace(/\s+/g, ' ');
  if (!said) return 'Choose Try again.';
  if (said.endsWith('.')) return `${said.slice(0, -1)}, then choose Try again.`;
  if (/[!?…]$/.test(said)) return `${said} Then choose Try again.`;
  return `${said}, then choose Try again.`;
}

/**
 * What a run turn says when its checkout can't be made (RA-DS54): the run, the repository, what is missing and where a
 * person fixes it — the server's own words for a sign-in it can't give (RA-DS50, RA-DS51) — then Try again. Nothing
 * runs: an empty folder is no place for the run's work.
 */
export function runCheckoutRefusal(ctx: DispatchContext, repo: string | null, reason: string): string {
  const run = ctx.run?.number;
  const tail = thenTryAgain(reason);
  // A sentence of the server's (“Nobody has connected …”) follows as one; a bare error (“fetch failed: …”) after a colon.
  const join = /^[A-Z]/.test(tail) ? '. ' : ': ';
  // The run's number where it fits the failure card's sentence (`TURN_FAILURE_REASON_MAX`), so the card shows this
  // once, not beside a general one; the run card in the same thread names the run anyway.
  const leads = repo
    ? [...(run ? [`I couldn’t check out ${repo} for run #${run}`] : []), `I couldn’t check out ${repo}`]
    : [`I couldn’t get the checkout of ${run ? `run #${run}` : 'this run'}`];
  const texts = leads.map((lead) => `${lead}${join}${tail}`);
  return texts.find((t) => t.length <= TURN_FAILURE_REASON_MAX) ?? (texts.at(-1) as string);
}

/** Why a checkout couldn't be made, in the words people read: the server's answer when it gave one. */
function checkoutReason(err: unknown): string {
  if (err instanceof RunnerApiError && err.status === 501)
    return 'GitHub isn’t switched on for this Whombat, so it can’t fetch GitHub repositories.';
  return describe(err);
}

export async function prepareCwd(
  ctx: DispatchContext,
  options: {
    root: string;
    api?: RunnerApi;
    checkout: boolean;
    host: RunnerHost;
    /** Managed: the runner generation, the workspace fence (MSB-11). */
    generation?: number;
    /**
     * The turn runs in its person's pod (hermes-native.md HN-W01). The pod mounts the agent's home and the workspaces,
     * never the runner's scratch space, so a folder there would not exist for Hermes and the pod would refuse the turn.
     */
    pod?: boolean;
  },
): Promise<PreparedCwd> {
  const { host } = options;
  // Without a checkout: an empty folder in the runner's scratch space, or in the pod the agent's work folder, as a
  // person's chat turn has. Hermes needs a folder that exists; a turn without commands (a Looks ahead check, a Search
  // answer) runs nothing in it.
  const noCheckout = async (note: string | null = null): Promise<PreparedCwd> =>
    options.pod ? { ...(await agentWorkspace(host)), note } : scratch(ctx, host, note);
  // A live run turn without its checkout: the server gives none when the run's repository is gone. Its work can't
  // happen anywhere else, so nothing runs (resourceful-agents.md RA-DS54).
  if (options.checkout && isRunTurn(ctx) && !ctx.workspace && ctx.run?.repoId)
    throw new TurnRefusal(
      runCheckoutRefusal(
        ctx,
        null,
        'Its repository isn’t one this Whombat’s GitHub sign-in reaches any more. Check that it’s still on GitHub',
      ),
      'checkout',
    );
  // A Whombat Feedback assessment works in an empty directory, or with a repo in an export of Whombat's own mirror of
  // the remote default branch (feedback.md FB-21, review-2 F3).
  // A commands turn without a checkout (OP-S109): the agent's work folder.
  if (options.checkout && isWorkFolderTurn(ctx)) return agentWorkspace(host);
  const target = workspaceTarget(ctx);
  if (!target || !options.checkout || !options.api) return noCheckout();
  const manager = workspaceManager(ctx, options.root, options.api, options.generation);
  const readOnly = ctx.workspace?.access === 'read';
  try {
    const prepared = await manager.prepare(target);
    if (readOnly) {
      // Only reading (an automation's investigator or reviewer, bp-automations.md BP-C26): the branch's files,
      // exported outside the workspaces root (which every sandbox denies) and with no git metadata to write to, into
      // a fresh directory in the runner's private scratch space (BP-C38). The tree is one level down so git's
      // temporary index (next to it) stays inside this turn's own directory, never among other turns' exports.
      const own = await mkdtemp(join(await runnerTmpDir(host, 'read'), `${safe(ctx.dispatch.id)}-`));
      const dir = join(own, 'tree');
      // The commit actually exported (GitHub's branch as last fetched), which is what the turn reads and what the
      // runner reports — not the workspace's local branch, which may be ahead of it (review-3 NEW-2).
      const head = await manager.exportTree(target, dir);
      return {
        cwd: dir,
        release: () => rm(own, { recursive: true, force: true }),
        note: `read-only checkout of ${target.repo}@${target.branch} (${head.slice(0, 7)})`,
        git: { manager, target },
        commit: null,
        env: {},
        head,
      };
    }
    const commit = await manager.commitPaths(target);
    // Cleanup leaves the checkout alone while the turn works in it.
    const unhold = manager.hold(target);
    return {
      cwd: prepared.path,
      release: async () => unhold(),
      note: null,
      git: { manager, target },
      commit,
      env: prepared.env,
    };
  } catch (err) {
    if (err instanceof TurnRefusal) throw err;
    if (err instanceof WorkspaceFencedError)
      throw new TurnRefusal('A newer turn has taken over this workspace, so I stopped here.', 'lease_lost');
    if (err instanceof WorkspaceBusyError)
      throw new TurnRefusal(
        `Another turn is still working on ${target.repo}, and I waited as long as I may. Ask me again when it’s done.`,
        'workspace_busy',
      );
    // A run turn is refused instead (RA-DS54): its run needs the checkout, and a model turn in an empty folder only
    // spends tokens finding that out. The run then waits for a person: the fix, then Try again.
    if (isRunTurn(ctx))
      throw new TurnRefusal(runCheckoutRefusal(ctx, target.repo, checkoutReason(err)), 'checkout');
    // Anything else (GitHub not configured, a network error): work without a checkout, as before.
    const why =
      err instanceof RunnerApiError && err.status === 501
        ? 'GitHub is not configured on the server; working without a checkout'
        : `could not check out ${target.repo}@${target.branch}: ${describe(err)}`;
    return { ...(await noCheckout(why)), problem: why };
  }
}

/** Pushes the workspace branch when the agent committed something the remote does not have. */
export async function pushIfAhead(git: GitWorkspace): Promise<PushResult> {
  let commits: number;
  try {
    commits = await git.manager.ahead(git.target);
  } catch (err) {
    return { status: 'failed', message: describe(err) };
  }
  if (commits === 0) return { status: 'nothing' };
  try {
    await git.manager.push(git.target);
    return { status: 'pushed', commits };
  } catch (err) {
    if (err instanceof RunnerApiError && err.status === 403)
      return { status: 'blocked', message: err.message };
    if (err instanceof RunnerApiError && err.status === 202)
      return { status: 'pending_approval', message: 'A person has to approve this push first.' };
    return { status: 'failed', message: describe(err) };
  }
}
