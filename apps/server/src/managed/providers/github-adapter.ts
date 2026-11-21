/**
 * GitHub on a managed appliance (docs/decisions/managed-providers.md PV-06): there is no host `gh` account. Each
 * burrow's GitHub work — polling, pull requests, merges, deploys, the repo picker — runs as the person who connected
 * the burrow, with their own GitHub sign-in from their credential home (named in settings; `owner_departed` when they
 * leave, until an owner reconnects). Agents' git operations use their credential owner's sign-in (`github.ts`).
 *
 * `ManagedGitHub` is the `GitHubAdapter` the GitHub service uses in managed mode. Calls about a repo run as the
 * person who connected the burrow that has it; calls without a repo (who am I, the repo list) run as the account or
 * burrow of the current scope (`githubScope`), set by the GitHub routes and the poller.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, inArray } from 'drizzle-orm';
import { githubConnections, principals, repos } from '../../db/schema/index';
import {
  type GhAccount,
  type GhActionsJob,
  type GhAvatar,
  type GhRepo,
  type GhRepoSpec,
  type GitHubAdapter,
  GitHubNotConnectedError,
  type MergeMethod,
  type RateLimit,
} from '../../github/adapter';
import { fetchOwnerAvatar } from '../../github/avatar';
import { GhCliGitHub, type GhCliGitHubOptions } from '../../github/gh';
import type { Services } from '../../services';
import { providerLogins } from './service';

/** Whose GitHub sign-in calls without a repo use: an account (connecting), or who connected a burrow's GitHub. */
export const githubScope = new AsyncLocalStorage<{ accountId?: string; burrowId?: string }>();

/**
 * Nobody connected GitHub for the burrow (resourceful-agents.md RA-DS50, RA-DS51): one person connects it once in
 * Settings → Connections → GitHub and every agent then works as that connection — no agent is ever “assigned” one.
 */
export const NO_GITHUB_CONNECTION =
  'Nobody has connected GitHub on this Whombat yet. Connect it once in Settings → Connections → GitHub (every agent then uses it).';

const NOT_CONNECTED = NO_GITHUB_CONNECTION;

/**
 * An account without a GitHub sign-in of its own (EA-10): what connecting (or acting as it) needs first. The sign-in is
 * in Settings → Connections → GitHub since app AP-550.
 */
export const GITHUB_SIGN_IN_FIRST =
  'Sign in to GitHub with your own GitHub account first (Settings → Connections → GitHub), then connect it for this Whombat.';

export interface ConnectionOwner {
  accountId: string;
  name: string;
  /** Still a member of the burrow (else `owner_departed`). */
  present: boolean;
}

/** The person whose GitHub sign-in a burrow's GitHub work runs as. */
export async function burrowGitHubOwner(
  services: Services,
  burrowId: string,
): Promise<ConnectionOwner | null> {
  const [conn] = await services.db
    .select({ by: githubConnections.connectedById })
    .from(githubConnections)
    .where(eq(githubConnections.burrowId, burrowId));
  if (!conn) return null;
  const [p] = await services.db.select().from(principals).where(eq(principals.id, conn.by));
  if (!p) return null;
  return {
    accountId: p.accountId ?? '',
    name: p.shortName || p.name,
    // A former person's principal stays without its account (OP-S08): never used again (RA-DS51).
    present: Boolean(p.accountId) && p.burrowId === burrowId,
  };
}

export class ManagedGitHub implements GitHubAdapter {
  readonly kind = 'gh' as const;
  private readonly clients = new Map<string, GhCliGitHub>();
  private last: GhCliGitHub | null = null;

  constructor(
    private readonly services: Services,
    private readonly options: Pick<GhCliGitHubOptions, 'fetch' | 'apiUrl' | 'webUrl'> = {},
  ) {}

  /** The client that acts as one account (its own GitHub sign-in, read through the sign-in executor). */
  forAccount(accountId: string): GhCliGitHub {
    let client = this.clients.get(accountId);
    if (!client) {
      client = new GhCliGitHub({
        ...this.options,
        auth: {
          token: async () => {
            const token = await providerLogins(this.services).githubToken();
            if (!token) throw new GitHubNotConnectedError(GITHUB_SIGN_IN_FIRST, 'sign in to GitHub');
            return token;
          },
          invalidate: () => {},
        },
      });
      this.clients.set(accountId, client);
    }
    this.last = client;
    return client;
  }

  private async forBurrow(burrowId: string): Promise<GhCliGitHub> {
    const owner = await burrowGitHubOwner(this.services, burrowId);
    if (!owner) throw new GitHubNotConnectedError(NOT_CONNECTED, 'connect GitHub');
    if (!owner.present || !owner.accountId)
      throw new GitHubNotConnectedError(
        `${owner.name} connected GitHub and isn’t on this Whombat any more. Connect it again with your own GitHub sign-in.`,
        'connect GitHub',
      );
    return this.forAccount(owner.accountId);
  }

  private async scoped(): Promise<GhCliGitHub> {
    const scope = githubScope.getStore();
    if (scope?.accountId) return this.forAccount(scope.accountId);
    if (scope?.burrowId) return this.forBurrow(scope.burrowId);
    throw new GitHubNotConnectedError(NOT_CONNECTED, 'connect GitHub');
  }

  /** A repo's client: the scope's burrow when it has the repo, else the (first) connected burrow that has it. */
  private async forRepo(repo: string): Promise<GhCliGitHub> {
    const scope = githubScope.getStore();
    if (scope?.accountId) return this.forAccount(scope.accountId);
    const rows = await this.services.db
      .select({ burrowId: repos.burrowId })
      .from(repos)
      .where(eq(repos.fullName, repo));
    const ids = rows.map((r) => r.burrowId);
    // A call for one burrow about a repository no burrow lists (a repository whose GitHub Actions run on its check
    // server, say) runs as that burrow's own connection.
    if (scope?.burrowId && (ids.includes(scope.burrowId) || !ids.length))
      return this.forBurrow(scope.burrowId);
    const connected = ids.length
      ? await this.services.db
          .select({ burrowId: githubConnections.burrowId })
          .from(githubConnections)
          .where(and(inArray(githubConnections.burrowId, ids)))
      : [];
    const first = connected[0]?.burrowId;
    if (!first) throw new GitHubNotConnectedError(NOT_CONNECTED, 'connect GitHub');
    return this.forBurrow(first);
  }

  async whoami(): Promise<GhAccount> {
    return (await this.scoped()).whoami();
  }
  async gitToken(): Promise<{ token: string; expiresAt: string }> {
    // Managed git tokens are the agent's credential owner's (`managedGitToken`), never a shared one.
    throw new GitHubNotConnectedError(
      'Git tokens come from the agent’s credential owner on a managed appliance.',
    );
  }
  remoteUrl(repo: string): string {
    return `${(this.options.webUrl ?? 'https://github.com').replace(/\/$/, '')}/${repo}.git`;
  }
  rateLimit(): RateLimit {
    return this.last?.rateLimit() ?? { remaining: null, limit: null, resetAt: null };
  }
  async listRepos(limit: number, options?: { owned?: boolean }) {
    return (await this.scoped()).listRepos(limit, options);
  }
  async getRepo(fullName: string): Promise<GhRepo> {
    const scope = githubScope.getStore();
    return (scope ? await this.scoped() : await this.forRepo(fullName)).getRepo(fullName);
  }
  async branchExists(repo: string, branch: string) {
    return (await this.forRepo(repo)).branchExists(repo, branch);
  }
  async createPullRequest(pr: { repo: string; head: string; base: string; title: string; body: string }) {
    return (await this.forRepo(pr.repo)).createPullRequest(pr);
  }
  async getPullRequest(repo: string, number: number) {
    return (await this.forRepo(repo)).getPullRequest(repo, number);
  }
  async closedBy(repo: string, number: number) {
    return (await this.forRepo(repo)).closedBy(repo, number);
  }
  async listPullRequestCommits(repo: string, number: number) {
    return (await this.forRepo(repo)).listPullRequestCommits(repo, number);
  }
  async listPullRequestFiles(repo: string, number: number) {
    return (await this.forRepo(repo)).listPullRequestFiles(repo, number);
  }
  async listReviewComments(repo: string, number: number, reviewId: number) {
    return (await this.forRepo(repo)).listReviewComments(repo, number, reviewId);
  }
  async compare(repo: string, base: string, head: string) {
    return (await this.forRepo(repo)).compare(repo, base, head);
  }
  async compareStatus(repo: string, base: string, head: string) {
    return (await this.forRepo(repo)).compareStatus(repo, base, head);
  }
  async mergeBase(repo: string, base: string, head: string) {
    return (await this.forRepo(repo)).mergeBase(repo, base, head);
  }
  async commitParent(repo: string, sha: string) {
    return (await this.forRepo(repo)).commitParent(repo, sha);
  }
  async branchFiles(repo: string, branch: string) {
    return (await this.forRepo(repo)).branchFiles(repo, branch);
  }
  async branchTree(repo: string, ref: string) {
    return (await this.forRepo(repo)).branchTree(repo, ref);
  }
  async blobAt(repo: string, sha: string, maxBytes: number) {
    return (await this.forRepo(repo)).blobAt(repo, sha, maxBytes);
  }
  async commitTree(repo: string, sha: string) {
    return (await this.forRepo(repo)).commitTree(repo, sha);
  }
  async requiredStatusChecks(repo: string, branch: string) {
    return (await this.forRepo(repo)).requiredStatusChecks(repo, branch);
  }
  async commitStatuses(repo: string, sha: string) {
    return (await this.forRepo(repo)).commitStatuses(repo, sha);
  }
  async fileAt(repo: string, sha: string, path: string, maxBytes: number) {
    return (await this.forRepo(repo)).fileAt(repo, sha, path, maxBytes);
  }
  async mergePullRequest(merge: {
    repo: string;
    number: number;
    method: MergeMethod;
    sha?: string;
    title: string;
    message: string;
  }) {
    return (await this.forRepo(merge.repo)).mergePullRequest(merge);
  }
  async copyRepo(source: string, copy: { owner: string; name: string; template: boolean }) {
    // As the person who connected the burrow (the scope): the copy is theirs, the source isn't the burrow's yet.
    return (await this.scoped()).copyRepo(source, copy);
  }
  async createRepo(repo: GhRepoSpec & { owner: string; ownAccount: boolean }) {
    // As the person who connected the burrow (the scope), like a copy.
    return (await this.scoped()).createRepo(repo);
  }
  async ownerAvatar(owner: string, size: number): Promise<GhAvatar | null> {
    // Public: nobody's sign-in, so it works before anyone connected GitHub (automation-list.md AL-S06).
    return fetchOwnerAvatar(owner, size, this.options);
  }
  async rerunFailedJobs(repo: string, runId: number) {
    return (await this.forRepo(repo)).rerunFailedJobs(repo, runId);
  }
  async actionsJob(repo: string, jobId: number): Promise<GhActionsJob> {
    return (await this.forRepo(repo)).actionsJob(repo, jobId);
  }
  async dispatchWorkflow(run: {
    repo: string;
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }) {
    return (await this.forRepo(run.repo)).dispatchWorkflow(run);
  }
  async getIssue(repo: string, number: number) {
    return (await this.forRepo(repo)).getIssue(repo, number);
  }
  async commentOnIssue(repo: string, number: number, body: string) {
    return (await this.forRepo(repo)).commentOnIssue(repo, number, body);
  }

  async deleteBranch(repo: string, branch: string) {
    return (await this.forRepo(repo)).deleteBranch(repo, branch);
  }
  async openIssues(repo: string, etag: string | null) {
    return (await this.forRepo(repo)).openIssues(repo, etag);
  }
  async openPullRequests(repo: string, etags: readonly string[]) {
    return (await this.forRepo(repo)).openPullRequests(repo, etags);
  }
  async closedPullRequests(repo: string, etag: string | null) {
    return (await this.forRepo(repo)).closedPullRequests(repo, etag);
  }
  async checkRuns(repo: string, sha: string, etag: string | null) {
    return (await this.forRepo(repo)).checkRuns(repo, sha, etag);
  }
  async reviews(repo: string, number: number, etags: readonly string[]) {
    return (await this.forRepo(repo)).reviews(repo, number, etags);
  }
  async repoInfo(repo: string, etag: string | null) {
    return (await this.forRepo(repo)).repoInfo(repo, etag);
  }
  async branchHead(repo: string, branch: string, etag: string | null) {
    return (await this.forRepo(repo)).branchHead(repo, branch, etag);
  }
  async workflowRuns(repo: string, etag: string | null) {
    return (await this.forRepo(repo)).workflowRuns(repo, etag);
  }
}
