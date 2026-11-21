/**
 * The GitHub integration as a service (docs/github.md, docs/decisions/github-gh.md): picks the adapter from
 * config (each burrow's own GitHub sign-in, the fake, or none), knows which burrows are connected,
 * hands out git credentials to runners (and remembers which agent a push token was for), opens and merges
 * pull requests on GitHub, and owns the poller and the deploy executor.
 */
import { randomUUID } from 'node:crypto';
import { localBranchHead } from '@whombat/agent-runtime/local-repos';
import { GITHUB_AVATAR_SIZE } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { externalEffect } from '../commit/scope';
import type { Config } from '../config';
import {
  dispatches,
  githubConnections,
  githubPushGrants,
  prFiles,
  pullRequests,
  repos,
} from '../db/schema/index';
import { ApiError } from '../lib/errors';
import { managedGitToken } from '../managed/providers/github';
import { githubScope, ManagedGitHub, NO_GITHUB_CONNECTION } from '../managed/providers/github-adapter';
import { onBehalfOf } from '../mcp/tools';
import type { GitHost } from '../runtime/service';
import type { Services } from '../services';
import {
  type GhAccount,
  type GitHubAdapter,
  GitHubError,
  GitHubNotConnectedError,
  type MergeMethod,
} from './adapter';
import { fetchOwnerAvatar, OwnerAvatars } from './avatar';
import { DeployExecutor } from './deploy';
import { FakeGitHub, type FakeSeed } from './fake';
import { GitHubPoller } from './poller';
import { RepoIcons } from './repo-icons';
import { GitHubSync } from './sync';

export type GitHubMode = 'gh' | 'fake' | 'off';

/** GitHub answered the merge with `merged: false`. */
class NotMerged extends Error {}

/**
 * GitHub itself refused (a 4xx answer), or the call never reached it (not connected): it did nothing there. A 5xx, a
 * timeout or a lost answer may have.
 */
export function githubRefused(err: unknown): boolean {
  if (err instanceof GitHubNotConnectedError) return true;
  return err instanceof GitHubError && err.status !== null && err.status >= 400 && err.status < 500;
}

/** `auto`: each burrow's own GitHub sign-in (`gh`) in production, the fake otherwise. */
export function githubMode(config: Config): GitHubMode {
  const wanted = config.WHOMBAT_GITHUB;
  if (wanted === 'gh') return 'gh';
  if (wanted === 'fake' || wanted === 'off') return wanted;
  if (config.WHOMBAT_FAKE_GITHUB) return 'fake';
  return config.NODE_ENV === 'production' ? 'gh' : 'fake';
}

export function createAdapter(services: Services): GitHubAdapter | null {
  const config = services.config;
  const mode = githubMode(config);
  if (mode === 'off') return null;
  // No host gh account: each burrow's GitHub runs as the own sign-in of the person who connected it (PV-06).
  if (mode === 'gh') return new ManagedGitHub(services);
  return new FakeGitHub({
    ...(config.WHOMBAT_FAKE_GITHUB_GIT_ROOT ? { gitRoot: config.WHOMBAT_FAKE_GITHUB_GIT_ROOT } : {}),
    load: () => fakeSeedFromDb(services),
  });
}

/** The fake starts as a mirror of the database's repos and PRs (the seeded world). */
export async function fakeSeedFromDb(services: Services): Promise<FakeSeed> {
  const db = services.db;
  const repoRows = await db.select().from(repos).orderBy(asc(repos.position));
  const prRows = await db.select().from(pullRequests);
  const files = await db.select().from(prFiles);
  const seen = new Set<string>();
  const out: FakeSeed = { repos: [] };
  for (const r of repoRows) {
    if (r.source === 'local' || seen.has(r.fullName)) continue;
    seen.add(r.fullName);
    out.repos.push({
      fullName: r.fullName,
      description: r.description,
      language: r.language,
      defaultBranch: r.defaultBranch,
      pushedAt: r.pushedAt?.toISOString() ?? null,
      prs: prRows
        .filter((p) => p.repoId === r.id)
        .map((p) => ({
          number: p.number,
          branch: p.branch,
          base: p.baseBranch,
          title: p.title,
          headSha: p.headSha,
          state: p.state,
          diff: p.diff,
          files: files.filter((f) => f.prId === p.id).map((f) => ({ path: f.path, add: f.add, del: f.del })),
        })),
    });
  }
  return out;
}

/** Whether the adapter can be used, and as whom. */
export type GitHubConnection =
  | { ok: true; account: GhAccount; note: string | null }
  | { ok: false; error: string; fix: string | null };

const CONNECTION_OK_MS = 60_000;
const CONNECTION_ERROR_MS = 10_000;

export class GitHubService implements GitHost {
  readonly adapter: GitHubAdapter | null;
  readonly poller: GitHubPoller;
  readonly sync: GitHubSync;
  readonly deploys: DeployExecutor;
  /** GitHub owners' pictures for the Automations list, kept in memory (automation-list.md AL-S07). */
  readonly avatars: OwnerAvatars;
  /** Repositories' own icons for the Chat list, looked for in the background (chat-inbox.md). */
  readonly repoIcons: RepoIcons;
  private cachedConnection: { at: number; state: GitHubConnection } | null = null;
  /** How long `awaitBranch` waits for a pushed branch by default (tests shorten it; docs/decisions/test-speed.md TS-S01). */
  branchWaitMs = 20_000;

  constructor(
    private readonly services: Services,
    adapter: GitHubAdapter | null = createAdapter(services),
  ) {
    this.adapter = adapter;
    this.sync = new GitHubSync(services, () => this.connectionLogin());
    this.poller = new GitHubPoller(services, this);
    this.deploys = new DeployExecutor(services, this);
    this.deploys.install();
    this.repoIcons = new RepoIcons(services);
    this.avatars = new OwnerAvatars(
      // Through the adapter (the fake in dev and tests); with GitHub off the pictures are still public (AL-S06).
      (owner) =>
        this.adapter
          ? this.adapter.ownerAvatar(owner, GITHUB_AVATAR_SIZE)
          : fetchOwnerAvatar(owner, GITHUB_AVATAR_SIZE),
      {
        clock: () => services.clock().getTime(),
        onError: (err, owner) => services.log.info({ err: String(err), owner }, 'github avatar not fetched'),
      },
    );
  }

  get mode(): GitHubMode {
    return this.adapter?.kind ?? 'off';
  }

  /** The fake adapter, when that is what runs (dev, tests, demo). */
  get fake(): FakeGitHub | null {
    return this.adapter instanceof FakeGitHub ? this.adapter : null;
  }

  /** Starts polling (the server process; scripts and tests poll by hand). */
  start(): void {
    this.poller.start();
  }

  /** Stops polling and waits for the cycle in flight. */
  async close(): Promise<void> {
    await this.poller.stop();
    await this.repoIcons.idle();
    this.fake?.close();
  }

  /** Resolves once no poll is running (tests, shutdown). */
  async idle(): Promise<void> {
    await this.poller.idle();
  }

  /** The adapter or a 501 for features that need GitHub. */
  require(): GitHubAdapter {
    if (!this.adapter)
      throw new ApiError(
        'not_implemented',
        'GitHub is off on this server (WHOMBAT_GITHUB=off, docs/github.md).',
      );
    return this.adapter;
  }

  /* The connection ------------------------------------------------------------------------------ */

  /** Whether gh is logged in, and as whom (cached a minute; errors ten seconds). */
  async connection(force = false): Promise<GitHubConnection> {
    const adapter = this.adapter;
    if (!adapter) return { ok: false, error: 'GitHub is off on this server.', fix: null };
    const now = Date.now();
    const cached = this.cachedConnection;
    if (!force && cached && now - cached.at < (cached.state.ok ? CONNECTION_OK_MS : CONNECTION_ERROR_MS))
      return cached.state;
    let state: GitHubConnection;
    try {
      const account = await adapter.whoami();
      const scopes = account.scopes;
      const note =
        scopes && !scopes.includes('repo')
          ? 'This GitHub sign-in can’t reach private repos. Sign in to GitHub again.'
          : scopes && !scopes.includes('workflow')
            ? 'This GitHub sign-in can’t start workflows (deploys). Sign in to GitHub again.'
            : null;
      state = { ok: true, account, note };
    } catch (err) {
      state =
        err instanceof GitHubNotConnectedError
          ? { ok: false, error: err.message, fix: err.fix }
          : { ok: false, error: err instanceof Error ? err.message : String(err), fix: null };
    }
    this.cachedConnection = { at: now, state };
    return state;
  }

  /** gh failed: check again next time. */
  forgetConnection(): void {
    this.cachedConnection = null;
  }

  /**
   * The login GitHub actions in this burrow are performed as, outside any request scope (MOA-03): a command's `apply`
   * has no `githubScope`, so `connectionLogin` alone would fall back to the adapter's own account.
   */
  connectionLoginFor(burrowId: string): Promise<string | null> {
    return githubScope.run({ ...githubScope.getStore(), burrowId }, () => this.connectionLogin());
  }

  /** The login every GitHub action is performed as. */
  async connectionLogin(): Promise<string | null> {
    // The login the burrow in scope was connected as (the person's own GitHub account).
    const scoped = githubScope.getStore()?.burrowId;
    if (scoped) {
      const [row] = await this.services.db
        .select({ login: githubConnections.login })
        .from(githubConnections)
        .where(eq(githubConnections.burrowId, scoped));
      return row?.login ?? null;
    }
    const c = await this.connection();
    return c.ok ? c.account.login : null;
  }

  /** A connection error as the API answers it (409 with the fix). */
  notConnected(state: Extract<GitHubConnection, { ok: false }>): ApiError {
    return new ApiError('conflict', state.error, { details: { fix: state.fix } });
  }

  /* Burrows and repos --------------------------------------------------------------------------- */

  /** The person connected the burrow. With the fake, any burrow that has repos is (the seeded world). */
  async isConnected(burrowId: string): Promise<boolean> {
    if (!this.adapter) return false;
    const [row] = await this.services.db
      .select({ burrowId: githubConnections.burrowId })
      .from(githubConnections)
      .where(eq(githubConnections.burrowId, burrowId));
    if (row) return true;
    if (!this.fake) return false;
    const [repo] = await this.services.db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.burrowId, burrowId))
      .limit(1);
    return !!repo;
  }

  /** Every connected burrow (the poller's). */
  async connectedBurrowIds(): Promise<string[]> {
    if (!this.adapter) return [];
    const rows = await this.services.db.select({ id: githubConnections.burrowId }).from(githubConnections);
    const ids = new Set(rows.map((r) => r.id));
    if (this.fake) {
      const withRepos = await this.services.db.selectDistinct({ id: repos.burrowId }).from(repos);
      for (const r of withRepos) ids.add(r.id);
    }
    return [...ids];
  }

  /** The adapter knows the repo (the fake only has the repos it was seeded with or added). */
  async hasRepo(fullName: string): Promise<boolean> {
    const fake = this.fake;
    if (!fake) return !!this.adapter;
    await fake.ready();
    return fake.reaches(fullName);
  }

  /** The repo is one of a connected burrow's: PRs, merges, pushes and deploys go through GitHub. */
  async connectedRepo(burrowId: string, repoFullName: string): Promise<boolean> {
    if (!(await this.isConnected(burrowId))) return false;
    const [repo] = await this.services.db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.burrowId, burrowId), eq(repos.fullName, repoFullName)));
    return !!repo && (await this.hasRepo(repoFullName));
  }

  /* Pull requests and merges ------------------------------------------------------------------------ */

  /** The PR was opened in Whombat while its repo was not connected: GitHub has no such PR. */
  private async localOnly(burrowId: string, repo: string, number: number): Promise<boolean> {
    const [row] = await this.services.db
      .select({ localOnly: pullRequests.localOnly })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(eq(pullRequests.burrowId, burrowId), eq(repos.fullName, repo), eq(pullRequests.number, number)),
      );
    return row?.localOnly ?? false;
  }

  private refused(err: unknown, what: string): ApiError {
    if (err instanceof GitHubNotConnectedError)
      return new ApiError('conflict', err.message, { details: { fix: err.fix, github: err.status } });
    return new ApiError(
      'conflict',
      err instanceof GitHubError ? err.message : `GitHub: couldn’t ${what}: ${String(err)}`,
      { details: { github: err instanceof GitHubError ? err.status : null } },
    );
  }

  /**
   * Opens a pull request on GitHub for a connected repo (as the gh account). Null when GitHub is off or the
   * burrow is not connected (the PR then only exists in Whombat).
   */
  async openOnGitHub(p: {
    burrowId: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string; headSha: string } | null> {
    const adapter = this.adapter;
    if (!adapter || !(await this.connectedRepo(p.burrowId, p.repo))) return null;
    try {
      const pr = await externalEffect('github.pr.open', () => adapter.createPullRequest(p), {
        refused: githubRefused,
      });
      return { number: pr.number, url: pr.url, headSha: pr.headSha };
    } catch (err) {
      throw this.refused(err, 'open the pull request');
    }
  }

  /**
   * A merge outside any database transaction. A definite refusal permits another request; an unknown answer may
   * already have acted and must never be blindly repeated. `here` means the PR exists only on this Whombat.
   */
  async mergeOutcome(p: {
    burrowId: string;
    repo: string;
    number: number;
    method: MergeMethod;
    headSha: string;
    title: string;
    mergedBy: string;
  }): Promise<
    | { outcome: 'merged'; sha: string | null }
    | { outcome: 'here' }
    | { outcome: 'refused' | 'unknown'; reason: string }
  > {
    const adapter = this.adapter;
    if (!adapter) return { outcome: 'refused', reason: 'GitHub isn’t connected.' };
    if (await this.localOnly(p.burrowId, p.repo, p.number)) return { outcome: 'here' };
    if (!(await this.connectedRepo(p.burrowId, p.repo)))
      return { outcome: 'refused', reason: `GitHub isn’t connected for ${p.repo}.` };
    try {
      const res = await githubScope.run({ burrowId: p.burrowId }, () => this.githubMerge(adapter, p));
      return { outcome: 'merged', sha: res.sha };
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      return { outcome: err instanceof NotMerged || githubRefused(err) ? 'refused' : 'unknown', reason };
    }
  }

  /** The merge on GitHub, as an external effect: GitHub answering 4xx, or “not merged”, proves it didn't merge. */
  private githubMerge(
    adapter: GitHubAdapter,
    p: {
      repo: string;
      number: number;
      method: MergeMethod;
      headSha: string;
      title: string;
      mergedBy: string;
    },
  ): Promise<{ merged: boolean; sha: string | null; message: string }> {
    return externalEffect(
      'github.merge',
      async () => {
        const merged = await adapter.mergePullRequest({
          repo: p.repo,
          number: p.number,
          method: p.method,
          sha: p.headSha,
          title: `${p.title} (#${p.number})`,
          message: `Merged by ${p.mergedBy} in Whombat.`,
        });
        if (!merged.merged) throw new NotMerged(merged.message);
        return merged;
      },
      { refused: (err) => err instanceof NotMerged || githubRefused(err) },
    );
  }

  /* Git credentials (GitHost) -------------------------------------------------------------------- */

  /**
   * The GitHub token an agent's git operations and its `gh` use (agent-gh.md AGH-01): its credential owner's own
   * sign-in or that of the person who connected the burrow (`managedGitToken`, managed-providers.md PV-06). Throws
   * `managedGitToken`'s sentences (409) when nobody's sign-in can be used.
   */
  async agentToken(req: {
    burrowId: string;
    agentId?: string;
  }): Promise<{ token: string; expiresAt: string }> {
    this.require();
    return managedGitToken(this.services, req.agentId, req.burrowId);
  }

  /**
   * The gh account's token for one fetch or push of a connected repo. The keys decision already ran
   * (`runtime.authorize_git`); a push token is remembered as a push grant so the push — which GitHub
   * attributes to the gh account — is signed by the agent it was for.
   */
  async credentials(req: {
    burrowId: string;
    repo: string;
    branch: string;
    operation: 'fetch' | 'push';
    agentId?: string;
    dispatchId?: string;
    sha?: string;
  }): Promise<{ token: string; expiresAt: string; remoteUrl: string }> {
    const adapter = this.require();
    // A burrow nobody connected says where it's fixed (resourceful-agents.md RA-DS50); the fake's own gaps as before.
    if (!(await this.connectedRepo(req.burrowId, req.repo)))
      throw (await this.isConnected(req.burrowId))
        ? new ApiError('conflict', `${req.repo} is not connected to GitHub.`)
        : new ApiError('conflict', NO_GITHUB_CONNECTION, { details: { code: 'provider.owner_required' } });
    const token = await this.agentToken({ burrowId: req.burrowId, agentId: req.agentId });
    if (req.operation === 'push' && req.agentId) {
      let behalf: { text?: string; principalId?: string } = {};
      if (req.dispatchId) {
        const [d] = await this.services.db.select().from(dispatches).where(eq(dispatches.id, req.dispatchId));
        if (d) behalf = await onBehalfOf(this.services, d);
      }
      await this.recordPushGrant({
        burrowId: req.burrowId,
        repo: req.repo,
        branch: req.branch,
        agentId: req.agentId,
        dispatchId: req.dispatchId ?? null,
        onBehalfOf: behalf,
        sha: req.sha ?? null,
        expiresAt: new Date(token.expiresAt),
      });
    }
    return { token: token.token, expiresAt: token.expiresAt, remoteUrl: adapter.remoteUrl(req.repo) };
  }

  /**
   * Remembers a push token handed to an agent's runner: which branch it watches (the poller reads it), and
   * the commit it said it was pushing — the push GitHub then reports is the agent's only when its head is
   * that commit (docs/decisions/github-gh.md, GP-01).
   */
  async recordPushGrant(g: {
    burrowId: string;
    repo: string;
    branch: string;
    agentId: string;
    dispatchId: string | null;
    onBehalfOf: { text?: string; principalId?: string };
    /** The commit being pushed; null when the runner did not say (the push is then signed by GitHub). */
    sha?: string | null;
    expiresAt: Date;
  }): Promise<void> {
    const now = this.services.clock();
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx.insert(githubPushGrants).values({
        id: `gpg_${randomUUID()}`,
        burrowId: g.burrowId,
        repo: g.repo,
        branch: g.branch,
        agentId: g.agentId,
        dispatchId: g.dispatchId,
        onBehalfOf: g.onBehalfOf,
        sha: g.sha?.toLowerCase() ?? null,
        issuedAt: now,
        expiresAt: g.expiresAt,
      });
    });
    // The push lands in a moment: its repo goes on the fast cadence now (docs/decisions/polling.md PL-01).
    this.poller.wake(g.burrowId, g.repo);
  }

  /**
   * Agents open a pull request right after committing; the runner pushes new commits within a couple of
   * seconds. Waits (outside any transaction) until GitHub has the branch, up to `timeoutMs`.
   */
  async awaitBranch(
    burrowId: string,
    repo: string,
    branch: string,
    timeoutMs = this.branchWaitMs,
  ): Promise<void> {
    // A repository kept on this Whombat: the runner pushes to its origin on this machine (runs-approvals.md MDS-D05).
    const [local] = await this.services.db
      .select({ originPath: repos.originPath })
      .from(repos)
      .where(and(eq(repos.burrowId, burrowId), eq(repos.fullName, repo), eq(repos.source, 'local')));
    if (local) {
      const origin = local.originPath;
      if (!origin) return;
      const deadline = Date.now() + timeoutMs;
      while (!(await localBranchHead(origin, branch).catch(() => 'unreadable'))) {
        if (Date.now() > deadline) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      return;
    }
    const adapter = this.adapter;
    if (!adapter) return;
    const fake = this.fake;
    if (fake) {
      await fake.ready();
      if (!fake.repos.get(repo)?.git) return; // in-memory fake repos have nothing to wait for
    }
    if (!(await this.connectedRepo(burrowId, repo))) return;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await adapter.branchExists(repo, branch)) return;
      } catch {
        return; // let the command report GitHub's error
      }
      if (Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
