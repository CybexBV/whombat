/**
 * GhCliGitHub: GitHub's REST API as one account (docs/github.md, docs/decisions/github-gh.md), the client
 * `ManagedGitHub` runs the person's own GitHub sign-in through (PV-06).
 *
 * The token comes from its source (`auth`), read again when GitHub refuses it (401). Requests go straight to the REST
 * API with `fetch` — the HTTP answers carry what polling needs: ETags (a 304 costs no rate limit), the rate-limit
 * headers and pagination links. Only github.com for now; the API and web URLs are options so GHES stays a small change.
 */
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
  GitHubRateLimitedError,
  isBotAccount,
  type MergeMethod,
  type RateLimit,
  splitRepo,
} from './adapter';
import { fetchOwnerAvatar } from './avatar';

/** Where a client's token comes from: a person's own GitHub sign-in (`ManagedGitHub`), or a test's. */
export interface GhTokenSource {
  token(): Promise<string>;
  /** Forget a cached token (GitHub refused it). */
  invalidate(): void;
}

export interface GhCliGitHubOptions {
  /** `https://api.github.com` */
  apiUrl?: string;
  /** `https://github.com` — clone and push URLs. */
  webUrl?: string;
  /** Tests inject a fetch (the transport). */
  fetch?: typeof fetch;
  /** The token source. */
  auth: GhTokenSource;
  /** Per-request timeout. */
  timeoutMs?: number;
  clock?: () => number;
}

/** Page size of every list read. */
const PER_PAGE = 100;

interface GhAnswer<T> {
  status: number;
  etag: string | null;
  data: T;
  next: boolean;
  headers: Headers;
}

/** `feat/x` → `feat/x` with each segment encoded (GitHub routes branch names with slashes). */
function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function repoPath(fullName: string): string {
  const { owner, repo } = splitRepo(fullName);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function wrap(err: unknown, what: string): GitHubError {
  if (err instanceof GitHubNotConnectedError || err instanceof GitHubRateLimitedError) return err;
  if (err instanceof GitHubError)
    return new GitHubError(`GitHub: couldn’t ${what}: ${err.message}`, err.status);
  return new GitHubError(`GitHub: couldn’t ${what}: ${err instanceof Error ? err.message : String(err)}`);
}

/** An answer's body: JSON when it parses, else the text (null when empty). */
function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* Raw API shapes (only what we read) ------------------------------------------------------------ */

interface RawRepo {
  id: number;
  full_name: string;
  description: string | null;
  language: string | null;
  default_branch: string;
  pushed_at: string | null;
  private: boolean;
  /** The signed-in account's rights (authenticated requests only). */
  permissions?: { push?: boolean };
  is_template?: boolean;
  archived?: boolean;
}

interface RawPr {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  merged?: boolean | null;
  merged_at?: string | null;
  merged_by?: { login: string } | null;
  merge_commit_sha?: string | null;
  draft?: boolean;
  user?: { login: string; type?: string } | null;
  author_association?: string | null;
  assignees?: { login: string }[] | null;
  /** `repo` is null once a fork was deleted. */
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string; repo?: { full_name: string } };
  requested_reviewers?: { login: string }[];
  created_at?: string;
  updated_at?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

/** An issue (or, with `pull_request`, a pull request) as the issues API returns it. */
interface RawIssue {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  user?: { login: string; type?: string } | null;
  author_association?: string | null;
  assignees?: { login: string }[] | null;
  labels?: (string | { name?: string | null })[];
  created_at?: string | null;
  pull_request?: unknown;
}

export function toIssue(d: RawIssue): GhIssue {
  return {
    number: d.number,
    url: d.html_url,
    title: d.title,
    body: d.body ?? null,
    author: d.user?.login ?? null,
    authorBot: isBotAccount(d.user),
    authorAssociation: d.author_association ?? null,
    assignees: (d.assignees ?? []).map((u) => u.login).slice(0, 20),
    labels: (d.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
      .filter((l): l is string => !!l)
      .slice(0, 20),
    state: d.state,
    createdAt: d.created_at ?? null,
  };
}

interface RawActionsJob {
  id: number;
  run_id: number;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  steps?: { name?: string | null; status?: string | null; conclusion?: string | null }[] | null;
}

interface RawCommit {
  sha: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date?: string } | null;
    committer?: { date?: string } | null;
  };
  author: { login: string } | null;
}

export function toRepo(r: RawRepo): GhRepo {
  return {
    id: r.id,
    fullName: r.full_name,
    description: r.description,
    language: r.language,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
    private: r.private,
    ...(r.permissions ? { canPush: r.permissions.push === true } : {}),
    ...(r.is_template !== undefined ? { template: r.is_template } : {}),
    ...(r.archived !== undefined ? { archived: r.archived } : {}),
  };
}

/** The fork a PR's head is in, null when it is a branch of the base repo. */
function forkOf(d: RawPr): string | null {
  if (d.head.repo === null) return 'unknown'; // the fork was deleted
  const head = d.head.repo?.full_name;
  const base = d.base.repo?.full_name;
  if (!head || !base || head.toLowerCase() === base.toLowerCase()) return null;
  return head;
}

export function toPr(d: RawPr): GhPullRequest {
  return {
    number: d.number,
    url: d.html_url,
    title: d.title,
    body: d.body ?? null,
    headRef: d.head.ref,
    fork: forkOf(d),
    headSha: d.head.sha,
    baseRef: d.base.ref,
    state: d.state,
    merged: Boolean(d.merged ?? d.merged_at),
    mergedAt: d.merged_at ?? null,
    mergedBy: d.merged_by?.login ?? null,
    // GitHub fills `merge_commit_sha` for open pull requests too (a test merge): only a merged one's counts.
    mergeCommitSha: (d.merged ?? d.merged_at) ? (d.merge_commit_sha ?? null) : null,
    draft: Boolean(d.draft),
    author: d.user?.login ?? null,
    authorBot: isBotAccount(d.user),
    authorAssociation: d.author_association ?? null,
    assignees: (d.assignees ?? []).map((u) => u.login).slice(0, 20),
    requestedReviewers: (d.requested_reviewers ?? []).map((u) => u.login),
    createdAt: d.created_at ?? null,
    updatedAt: d.updated_at ?? null,
    additions: d.additions ?? null,
    deletions: d.deletions ?? null,
    changedFiles: d.changed_files ?? null,
  };
}

function toCommit(c: RawCommit): GhCommit {
  return {
    sha: c.sha,
    message: firstLine(c.commit.message),
    fullMessage: c.commit.message,
    authorName: c.commit.author?.name ?? null,
    authorEmail: c.commit.author?.email ?? null,
    authorLogin: c.author?.login ?? null,
    at: c.commit.author?.date ?? new Date().toISOString(),
    ...(c.commit.committer?.date ? { committedAt: c.commit.committer.date } : {}),
  };
}

export class GhCliGitHub implements GitHubAdapter {
  readonly kind = 'gh' as const;
  readonly auth: GhTokenSource;
  private readonly apiUrl: string;
  private readonly webUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private rate: RateLimit = { remaining: null, limit: null, resetAt: null };

  constructor(private readonly options: GhCliGitHubOptions) {
    this.auth = options.auth;
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.webUrl = (options.webUrl ?? 'https://github.com').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
  }

  rateLimit(): RateLimit {
    return { ...this.rate };
  }

  remoteUrl(repo: string): string {
    splitRepo(repo);
    return `${this.webUrl}/${repo}.git`;
  }

  async gitToken(): Promise<{ token: string; expiresAt: string }> {
    // gh's OAuth tokens do not expire; the hour is how long a push grant counts for that push.
    return {
      token: await this.auth.token(),
      expiresAt: new Date(this.clock() + 60 * 60_000).toISOString(),
    };
  }

  /* HTTP ------------------------------------------------------------------------------------------ */

  private noteRate(headers: Headers): void {
    const num = (name: string) => {
      const v = headers.get(name);
      return v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
    };
    const remaining = num('x-ratelimit-remaining');
    const limit = num('x-ratelimit-limit');
    const reset = num('x-ratelimit-reset');
    if (remaining !== null) this.rate.remaining = remaining;
    if (limit !== null) this.rate.limit = limit;
    if (reset !== null) this.rate.resetAt = reset * 1000;
  }

  /** Sends one request as the gh account and notes the rate limit; a failure to reach GitHub is a `GitHubError`. */
  private async send(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number>;
      body?: unknown;
      etag?: string | null;
      accept?: string;
    },
  ): Promise<Response> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const token = await this.auth.token();
    const headers: Record<string, string> = {
      accept: opts.accept ?? 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'whombat-server',
      'x-github-api-version': '2022-11-28',
    };
    if (opts.etag) headers['if-none-match'] = opts.etag;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new GitHubError(err instanceof Error ? err.message : String(err));
    }
    this.noteRate(res.headers);
    return res;
  }

  /**
   * GitHub refused (status 400 and up): throws what it said as a `GitHubError` — the rate limit and a refused token
   * as theirs. `retry` once for a refused token: the sign-in may have a new one.
   */
  private refusal(res: Response, data: unknown, retried: boolean): 'retry' {
    if (res.status === 401) {
      this.auth.invalidate();
      if (!retried) return 'retry';
      throw new GitHubNotConnectedError('GitHub refused the GitHub sign-in. Sign in to GitHub again.');
    }
    const said =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : '';
    const message = said || `HTTP ${res.status}`;
    if (res.status === 429 || (res.status === 403 && /rate limit/i.test(message))) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const until =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? this.clock() + retryAfter * 1000
          : this.rate.remaining === 0 && this.rate.resetAt
            ? this.rate.resetAt
            : this.clock() + 60_000;
      throw new GitHubRateLimitedError(until);
    }
    throw new GitHubError(message, res.status);
  }

  /** One request as the gh account. 304 comes back as `{status: 304}`; errors throw `GitHubError`s. */
  async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number>; body?: unknown; etag?: string | null } = {},
    retried = false,
  ): Promise<GhAnswer<T>> {
    const res = await this.send(method, path, opts);
    const etag = res.headers.get('etag');
    const next = /<[^>]+>;\s*rel="next"/.test(res.headers.get('link') ?? '');
    if (res.status === 304)
      return { status: 304, etag: etag ?? opts.etag ?? null, data: null as T, next, headers: res.headers };
    const data = parseBody(await res.text());
    if (res.status >= 400) {
      this.refusal(res, data, retried);
      return this.request<T>(method, path, opts, true);
    }
    return { status: res.status, etag, data: data as T, next, headers: res.headers };
  }

  /**
   * A GET answered raw (`application/vnd.github.raw+json`: a file's bytes; a directory or a submodule still comes as
   * JSON, `json` then). The body is read up to `maxBytes`; a longer one is `{tooLarge}` and the rest isn't downloaded.
   */
  private async requestRaw(
    path: string,
    query: Record<string, string | number>,
    maxBytes: number,
    retried = false,
  ): Promise<{ json: unknown } | { bytes: Uint8Array } | { tooLarge: number }> {
    const res = await this.send('GET', path, { query, accept: 'application/vnd.github.raw+json' });
    if (res.status >= 400) {
      this.refusal(res, parseBody(await res.text()), retried);
      return this.requestRaw(path, query, maxBytes, true);
    }
    if (/^application\/json\b/i.test(res.headers.get('content-type') ?? ''))
      return { json: parseBody(await res.text()) };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel();
      return { tooLarge: declared };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { tooLarge: total };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { bytes };
  }

  private async get<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    return (await this.request<T>('GET', path, query ? { query } : {})).data;
  }

  /** Every page of a list (100 a page, following `Link: next`), up to `maxPages`. */
  private async all<T>(path: string, maxPages: number, query: Record<string, string | number> = {}) {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.request<T[]>('GET', path, { query: { ...query, per_page: PER_PAGE, page } });
      out.push(...res.data);
      if (!res.next) break;
    }
    return out;
  }

  private async conditional<T, R>(
    path: string,
    query: Record<string, string | number>,
    etag: string | null,
    map: (raw: T) => R,
  ): Promise<Conditional<R>> {
    const res = await this.request<T>('GET', path, { query, etag });
    if (res.status === 304) return { modified: false };
    return { modified: true, etag: res.etag, data: map(res.data) };
  }

  /* Account and repos ------------------------------------------------------------------------------- */

  async whoami(): Promise<GhAccount> {
    try {
      const res = await this.request<{ login: string; id: number; name: string | null }>('GET', '/user');
      const scopes = res.headers.get('x-oauth-scopes');
      return {
        login: res.data.login,
        id: res.data.id,
        name: res.data.name ?? null,
        scopes:
          scopes === null
            ? null
            : scopes
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
      };
    } catch (err) {
      throw wrap(err, 'read the gh account');
    }
  }

  async listRepos(
    limit: number,
    options: { owned?: boolean } = {},
  ): Promise<{ repos: GhRepo[]; hasMore: boolean }> {
    const out: GhRepo[] = [];
    const perPage = Math.min(100, Math.max(1, limit));
    try {
      for (let page = 1; page <= 10; page++) {
        const res = await this.request<RawRepo[]>('GET', '/user/repos', {
          query: {
            affiliation: options.owned ? 'owner' : 'owner,collaborator,organization_member',
            sort: 'pushed',
            direction: 'desc',
            per_page: perPage,
            page,
          },
        });
        out.push(...res.data.map(toRepo));
        if (out.length >= limit)
          return { repos: out.slice(0, limit), hasMore: out.length > limit || res.next };
        if (!res.next) break;
      }
    } catch (err) {
      throw wrap(err, 'list the repos gh can reach');
    }
    return { repos: out, hasMore: false };
  }

  async getRepo(fullName: string): Promise<GhRepo> {
    try {
      return toRepo(await this.get<RawRepo>(repoPath(fullName)));
    } catch (err) {
      throw wrap(err, `find ${fullName}`);
    }
  }

  async branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.get(`${repoPath(repo)}/branches/${refPath(branch)}`);
      return true;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return false;
      throw wrap(err, `look up ${branch}`);
    }
  }

  /* Pull requests ----------------------------------------------------------------------------------- */

  async createPullRequest(pr: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<GhPullRequest> {
    try {
      const res = await this.request<RawPr>('POST', `${repoPath(pr.repo)}/pulls`, {
        body: { head: pr.head, base: pr.base, title: pr.title, body: pr.body },
      });
      return toPr(res.data);
    } catch (err) {
      throw wrap(err, `open a pull request from ${pr.head}`);
    }
  }

  async getPullRequest(repo: string, number: number): Promise<GhPullRequest> {
    try {
      return toPr(await this.get<RawPr>(`${repoPath(repo)}/pulls/${number}`));
    } catch (err) {
      throw wrap(err, `read PR #${number}`);
    }
  }

  async closedBy(repo: string, number: number): Promise<string | null> {
    try {
      const issue = await this.get<{ closed_by?: { login: string } | null }>(
        `${repoPath(repo)}/issues/${number}`,
      );
      return issue.closed_by?.login ?? null;
    } catch (err) {
      throw wrap(err, `read who closed #${number}`);
    }
  }

  async getIssue(repo: string, number: number): Promise<GhIssue & { pullRequest: boolean }> {
    try {
      const raw = await this.get<RawIssue>(`${repoPath(repo)}/issues/${number}`);
      return { ...toIssue(raw), pullRequest: raw.pull_request != null };
    } catch (err) {
      throw wrap(err, `read #${number}`);
    }
  }

  async commentOnIssue(repo: string, number: number, body: string): Promise<{ id: number; url: string }> {
    try {
      const res = await this.request<{ id: number; html_url: string }>(
        'POST',
        `${repoPath(repo)}/issues/${number}/comments`,
        { body: { body } },
      );
      return { id: res.data.id, url: res.data.html_url };
    } catch (err) {
      throw wrap(err, `comment on #${number}`);
    }
  }

  async deleteBranch(repo: string, branch: string): Promise<'deleted' | 'gone'> {
    try {
      await this.request('DELETE', `${repoPath(repo)}/git/refs/heads/${refPath(branch)}`, {});
      return 'deleted';
    } catch (err) {
      // GitHub answers 422 “Reference does not exist” as well as 404 for a branch that is gone.
      if (err instanceof GitHubError && (err.status === 404 || /does not exist/i.test(err.message)))
        return 'gone';
      throw wrap(err, `delete ${branch}`);
    }
  }

  async listPullRequestCommits(repo: string, number: number): Promise<GhCommit[]> {
    try {
      // Oldest first: the head is on the last page (GitHub lists at most 250).
      const data = await this.all<RawCommit>(`${repoPath(repo)}/pulls/${number}/commits`, 10);
      return data.map(toCommit);
    } catch (err) {
      throw wrap(err, `list the commits of PR #${number}`);
    }
  }

  async listPullRequestFiles(repo: string, number: number): Promise<GhFile[]> {
    try {
      const data = await this.all<{ filename: string; additions: number; deletions: number }>(
        `${repoPath(repo)}/pulls/${number}/files`,
        5,
      );
      return data.map((f) => ({ path: f.filename, add: f.additions, del: f.deletions }));
    } catch (err) {
      throw wrap(err, `list the files of PR #${number}`);
    }
  }

  async listReviewComments(repo: string, number: number, reviewId: number): Promise<GhReviewComment[]> {
    try {
      const data = await this.get<
        {
          path: string;
          line: number | null;
          original_line?: number | null;
          body: string;
          diff_hunk: string;
        }[]
      >(`${repoPath(repo)}/pulls/${number}/reviews/${reviewId}/comments`, { per_page: 50 });
      return data.map((c) => ({
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        body: c.body,
        diffHunk: c.diff_hunk,
      }));
    } catch (err) {
      throw wrap(err, `read the review comments on PR #${number}`);
    }
  }

  async compare(repo: string, base: string, head: string): Promise<GhCommit[]> {
    try {
      const data = await this.get<{ commits: RawCommit[] }>(
        `${repoPath(repo)}/compare/${refPath(base)}...${refPath(head)}`,
        { per_page: 100 },
      );
      return data.commits.slice(-100).map(toCommit);
    } catch (err) {
      throw wrap(err, `compare ${base}...${head}`);
    }
  }

  async compareStatus(repo: string, base: string, head: string): Promise<CompareStatus> {
    try {
      const data = await this.get<{ status?: string }>(
        `${repoPath(repo)}/compare/${refPath(base)}...${refPath(head)}`,
        { per_page: 1 },
      );
      const status = data.status;
      return status === 'ahead' || status === 'identical' || status === 'behind' || status === 'diverged'
        ? status
        : 'unknown';
    } catch (err) {
      // A commit GitHub doesn't have (a revision from another repository, a force-pushed one): nothing to say.
      if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) return 'unknown';
      throw wrap(err, `compare ${base.slice(0, 7)}...${head.slice(0, 7)}`);
    }
  }

  async mergeBase(repo: string, base: string, head: string): Promise<string | null> {
    try {
      const data = await this.get<{ merge_base_commit?: { sha?: string } | null }>(
        `${repoPath(repo)}/compare/${refPath(base)}...${refPath(head)}`,
        { per_page: 1 },
      );
      return data.merge_base_commit?.sha ?? null;
    } catch (err) {
      // An unknown branch or commit, or no common history.
      if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) return null;
      throw wrap(err, `compare ${base}...${head}`);
    }
  }

  async branchFiles(repo: string, branch: string): Promise<{ sha: string; names: string[] } | null> {
    try {
      const head = await this.get<{ object?: { sha?: string } }>(
        `${repoPath(repo)}/git/ref/heads/${refPath(branch)}`,
      );
      const sha = head.object?.sha;
      if (!sha) return null;
      const entries = await this.get<{ name?: string; type?: string }[]>(`${repoPath(repo)}/contents`, {
        ref: sha,
      });
      const names = (Array.isArray(entries) ? entries : []).flatMap((e) =>
        e.type === 'file' && typeof e.name === 'string' ? [e.name] : [],
      );
      return { sha, names };
    } catch (err) {
      // No such branch (or an empty one).
      if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) return null;
      throw wrap(err, `list ${branch}`);
    }
  }

  async commitParent(repo: string, sha: string): Promise<string | null> {
    try {
      const data = await this.get<{ parents?: { sha: string }[] }>(
        `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`,
        { per_page: 1 },
      );
      return data.parents?.[0]?.sha ?? null;
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) return null;
      throw wrap(err, `read commit ${sha.slice(0, 7)}`);
    }
  }

  async branchTree(repo: string, ref: string): Promise<{ files: GhTreeFile[]; truncated: boolean } | null> {
    try {
      const data = await this.get<{
        tree?: { path?: string; type?: string; size?: number; sha?: string }[];
        truncated?: boolean;
      }>(`${repoPath(repo)}/git/trees/${refPath(ref)}`, { recursive: 1 });
      const files = (Array.isArray(data.tree) ? data.tree : []).flatMap((e) =>
        e.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string'
          ? [{ path: e.path, size: typeof e.size === 'number' ? e.size : 0, sha: e.sha }]
          : [],
      );
      return { files, truncated: data.truncated === true };
    } catch (err) {
      // No such branch, an empty repository (409) or none the account can see.
      if (err instanceof GitHubError && (err.status === 404 || err.status === 409 || err.status === 422))
        return null;
      throw wrap(err, `list the files of ${repo}`);
    }
  }

  async blobAt(repo: string, sha: string, maxBytes: number): Promise<GhFileVersion | null> {
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) return null;
    try {
      const res = await this.requestRaw(`${repoPath(repo)}/git/blobs/${sha}`, {}, maxBytes);
      if ('bytes' in res) return { kind: 'file', bytes: res.bytes };
      if ('tooLarge' in res) return { kind: 'too_large', size: res.tooLarge };
      return null;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw wrap(err, `read a file of ${repo}`);
    }
  }

  async commitTree(repo: string, sha: string): Promise<string | null> {
    try {
      const data = await this.get<{ sha: string; commit: { tree: { sha: string } } }>(
        `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`,
      );
      if (data.sha !== sha || !data.commit?.tree?.sha)
        throw new GitHubError('The commit tree did not identify the requested revision.');
      return data.commit.tree.sha;
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) return null;
      throw wrap(err, `read the tree of ${sha.slice(0, 7)}`);
    }
  }

  async requiredStatusChecks(repo: string, branch: string): Promise<string[]> {
    type Required = { contexts?: string[]; checks?: { context: string }[] };
    type Rule = { type: string; parameters?: { required_status_checks?: { context: string }[] } };
    const path = repoPath(repo);
    try {
      const info = await this.get<{
        protected: boolean;
        protection?: { required_status_checks?: Required | null };
      }>(`${path}/branches/${refPath(branch)}`);
      if (typeof info.protected !== 'boolean') throw new GitHubError('Branch protection was not reported.');
      const contexts: string[] = [];
      const add = (names: unknown) => {
        if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name.trim()))
          throw new GitHubError('Required status checks were not reported completely.');
        contexts.push(...names);
      };
      if (info.protected) {
        let classic: Required | null;
        try {
          classic = await this.get<Required>(
            `${path}/branches/${refPath(branch)}/protection/required_status_checks`,
          );
        } catch (err) {
          if (!(err instanceof GitHubError) || err.status !== 404) throw err;
          // A hidden protection policy must not become an empty list of requirements.
          if (info.protection?.required_status_checks === undefined) throw err;
          classic = info.protection.required_status_checks;
        }
        if (classic) {
          if (classic.contexts === undefined && classic.checks === undefined)
            throw new GitHubError('Classic status-check policy was not reported.');
          if (classic.contexts !== undefined) add(classic.contexts);
          if (classic.checks !== undefined) add(classic.checks.map((check) => check.context));
        }
      }
      for (let page = 1; page <= 20; page++) {
        const res = await this.request<Rule[]>('GET', `${path}/rules/branches/${refPath(branch)}`, {
          query: { per_page: PER_PAGE, page },
        }).catch((err: unknown) => {
          // GitHub explicitly disables rules on private repositories on this plan. This is different from a
          // policy our sign-in cannot read; the branch must independently confirm it is unprotected.
          const inline = info.protection?.required_status_checks;
          if (
            page === 1 &&
            info.protected === false &&
            !(inline?.contexts?.length || inline?.checks?.length) &&
            err instanceof GitHubError &&
            err.status === 403 &&
            /^Upgrade to GitHub Pro or make this repository public to enable this feature\.?$/i.test(
              err.message,
            )
          )
            return null;
          throw err;
        });
        if (!res) return [];
        if (!Array.isArray(res.data)) throw new GitHubError('Active branch rules were not reported.');
        for (const rule of res.data) {
          if (rule.type === 'required_status_checks')
            add(rule.parameters?.required_status_checks?.map((check) => check.context));
        }
        if (!res.next) return [...new Set(contexts)].sort();
      }
      throw new GitHubError('Too many pages of required status checks to verify completely.');
    } catch (err) {
      throw wrap(err, `read the required checks for ${branch}`);
    }
  }

  async commitStatuses(repo: string, sha: string): Promise<GhCommitStatus[]> {
    type Raw = {
      sha: string;
      total_count: number;
      statuses: {
        id: number;
        context: string;
        state: string;
        created_at?: string | null;
        updated_at?: string | null;
        target_url?: string | null;
        description?: string | null;
      }[];
    };
    try {
      const out: GhCommitStatus[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await this.request<Raw>(
          'GET',
          `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/status`,
          {
            query: { per_page: PER_PAGE, page },
          },
        );
        if (
          res.data.sha !== sha ||
          !Array.isArray(res.data.statuses) ||
          !Number.isInteger(res.data.total_count)
        )
          throw new GitHubError('Commit statuses did not identify the requested revision completely.');
        for (const status of res.data.statuses) {
          if (!status.context || !Number.isInteger(status.id) || !status.state)
            throw new GitHubError('A commit status was incomplete.');
          out.push({
            id: status.id,
            context: status.context,
            state: status.state,
            createdAt: status.created_at ?? null,
            updatedAt: status.updated_at ?? null,
            url: status.target_url ?? null,
            description: status.description ?? null,
          });
        }
        if (!res.next) {
          if (out.length < res.data.total_count) throw new GitHubError('Commit statuses were truncated.');
          return out;
        }
      }
      throw new GitHubError('Too many pages of commit statuses to verify completely.');
    } catch (err) {
      throw wrap(err, `read the statuses on ${sha.slice(0, 7)}`);
    }
  }

  async fileAt(repo: string, sha: string, path: string, maxBytes: number): Promise<GhFileVersion | null> {
    // A URL would resolve `.` and `..` segments: such a path is no file of the repo.
    if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
    try {
      const res = await this.requestRaw(
        `${repoPath(repo)}/contents/${refPath(path)}`,
        { ref: sha },
        maxBytes,
      );
      if ('bytes' in res) return { kind: 'file', bytes: res.bytes };
      if ('tooLarge' in res) return { kind: 'too_large', size: res.tooLarge };
      // JSON instead of the file: a directory (a list) is no file; a submodule reads as git's diff shows it.
      const meta = res.json as { type?: string; sha?: string } | null;
      if (meta && !Array.isArray(meta) && meta.type === 'submodule' && meta.sha)
        return { kind: 'file', bytes: new TextEncoder().encode(`Subproject commit ${meta.sha}\n`) };
      return null;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw wrap(err, `read ${path} at ${sha.slice(0, 7)}`);
    }
  }

  async mergePullRequest(merge: {
    repo: string;
    number: number;
    method: MergeMethod;
    sha?: string;
    title: string;
    message: string;
  }) {
    try {
      const res = await this.request<{ merged: boolean; sha: string | null; message: string }>(
        'PUT',
        `${repoPath(merge.repo)}/pulls/${merge.number}/merge`,
        {
          body: {
            merge_method: merge.method,
            commit_title: merge.title,
            commit_message: merge.message,
            ...(merge.sha && merge.sha.length === 40 ? { sha: merge.sha } : {}),
          },
        },
      );
      return { merged: res.data.merged, sha: res.data.sha, message: res.data.message };
    } catch (err) {
      throw wrap(err, `merge PR #${merge.number}`);
    }
  }

  async copyRepo(source: string, copy: { owner: string; name: string; template: boolean }): Promise<GhRepo> {
    try {
      const res = copy.template
        ? await this.request<RawRepo>('POST', `${repoPath(source)}/generate`, {
            body: { owner: copy.owner, name: copy.name, private: true, include_all_branches: false },
          })
        : await this.request<RawRepo>('POST', `${repoPath(source)}/forks`, {
            body: { name: copy.name, default_branch_only: true },
          });
      return toRepo(res.data);
    } catch (err) {
      throw wrap(err, `copy ${source}`);
    }
  }

  async createRepo(repo: GhRepoSpec & { owner: string; ownAccount: boolean }): Promise<GhRepo> {
    const fullName = `${repo.owner}/${repo.name}`;
    try {
      const res = repo.template
        ? await this.request<RawRepo>('POST', `${repoPath(repo.template)}/generate`, {
            body: {
              owner: repo.owner,
              name: repo.name,
              description: repo.description ?? undefined,
              private: repo.visibility !== 'public',
              include_all_branches: repo.includeAllBranches,
            },
          })
        : await this.request<RawRepo>(
            'POST',
            repo.ownAccount ? '/user/repos' : `/orgs/${encodeURIComponent(repo.owner)}/repos`,
            {
              body: {
                name: repo.name,
                description: repo.description ?? undefined,
                homepage: repo.homepage ?? undefined,
                private: repo.visibility !== 'public',
                // Only an organization's repository can be internal.
                ...(repo.ownAccount ? {} : { visibility: repo.visibility }),
                has_issues: repo.hasIssues,
                has_wiki: repo.hasWiki,
                auto_init: repo.addReadme,
                gitignore_template: repo.gitignore ?? undefined,
                license_template: repo.license ?? undefined,
              },
            },
          );
      return toRepo(res.data);
    } catch (err) {
      throw wrap(err, `create ${fullName}`);
    }
  }

  async ownerAvatar(owner: string, size: number): Promise<GhAvatar | null> {
    // Public: no token, so a logged-out gh still shows pictures (automation-list.md AL-S06).
    return fetchOwnerAvatar(owner, size, { fetch: this.fetchImpl, webUrl: this.webUrl });
  }

  async rerunFailedJobs(repo: string, runId: number): Promise<void> {
    try {
      await this.request('POST', `${repoPath(repo)}/actions/runs/${runId}/rerun-failed-jobs`, {});
    } catch (err) {
      throw wrap(err, `run the failed jobs of workflow run ${runId} again`);
    }
  }

  async actionsJob(repo: string, jobId: number): Promise<GhActionsJob> {
    try {
      const raw = await this.get<RawActionsJob>(`${repoPath(repo)}/actions/jobs/${jobId}`);
      // A job's check run has the job's id; its annotations say when the runner went away.
      const notes = await this.get<{ message?: string | null }[]>(
        `${repoPath(repo)}/check-runs/${jobId}/annotations`,
        { per_page: 50 },
      );
      return {
        id: raw.id,
        runId: raw.run_id,
        name: raw.name ?? '',
        status: raw.status ?? '',
        conclusion: raw.conclusion ?? null,
        steps: (raw.steps ?? []).map((s) => ({
          name: s.name ?? '',
          status: s.status ?? '',
          conclusion: s.conclusion ?? null,
        })),
        annotations: (Array.isArray(notes) ? notes : []).map((a) => a.message ?? '').filter(Boolean),
      };
    } catch (err) {
      throw wrap(err, `read job ${jobId}`);
    }
  }

  async dispatchWorkflow(run: {
    repo: string;
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void> {
    try {
      await this.request(
        'POST',
        `${repoPath(run.repo)}/actions/workflows/${encodeURIComponent(run.workflow)}/dispatches`,
        { body: { ref: run.ref, inputs: run.inputs } },
      );
    } catch (err) {
      throw wrap(err, `start the ${run.workflow} workflow`);
    }
  }

  /* Conditional reads --------------------------------------------------------------------------------- */

  async openPullRequests(repo: string, etags: readonly string[]): Promise<ConditionalPages<GhPullRequest>> {
    const path = `${repoPath(repo)}/pulls`;
    const query = (page: number) => ({
      state: 'open',
      sort: 'created',
      direction: 'desc',
      per_page: 100,
      page,
    });
    try {
      // Every page asked with its ETag; when one changed, the pages that answered 304 are read again.
      const pages: ({ etag: string | null; data: RawPr[] } | null)[] = [];
      let changed = false;
      for (let page = 1; page <= 10; page++) {
        const etag = etags[page - 1] ?? null;
        const res = await this.request<RawPr[]>('GET', path, { query: query(page), etag });
        if (res.status === 304) {
          pages.push(null);
          if (page >= etags.length) break;
          continue;
        }
        changed = true;
        pages.push({ etag: res.etag, data: res.data });
        if (!res.next) break;
      }
      if (!changed) return { modified: false };
      const out: { etag: string | null; data: RawPr[] }[] = [];
      for (const [i, p] of pages.entries())
        out.push(p ?? (await this.request<RawPr[]>('GET', path, { query: query(i + 1) })));
      return {
        modified: true,
        etags: out.map((p) => p.etag ?? ''),
        data: out.flatMap((p) => p.data.map(toPr)),
      };
    } catch (err) {
      throw wrap(err, `list the open pull requests of ${repo}`);
    }
  }

  async openIssues(repo: string, etag: string | null): Promise<Conditional<GhIssue[]>> {
    try {
      return await this.conditional<RawIssue[], GhIssue[]>(
        `${repoPath(repo)}/issues`,
        { state: 'open', sort: 'created', direction: 'desc', per_page: 50 },
        etag,
        // The issues API lists pull requests too: those are read with the pull requests.
        (raw) => raw.filter((i) => i.pull_request == null).map(toIssue),
      );
    } catch (err) {
      throw wrap(err, `list the open issues of ${repo}`);
    }
  }

  async closedPullRequests(repo: string, etag: string | null): Promise<Conditional<GhPullRequest[]>> {
    try {
      return await this.conditional<RawPr[], GhPullRequest[]>(
        `${repoPath(repo)}/pulls`,
        { state: 'closed', sort: 'updated', direction: 'desc', per_page: 30 },
        etag,
        (raw) => raw.map(toPr),
      );
    } catch (err) {
      throw wrap(err, `list the closed pull requests of ${repo}`);
    }
  }

  async checkRuns(repo: string, sha: string, etag: string | null): Promise<Conditional<GhCheckRun[]>> {
    type Raw = {
      total_count?: number;
      check_runs: {
        id: number;
        name: string;
        head_sha: string;
        status: string;
        conclusion: string | null;
        started_at: string | null;
        completed_at: string | null;
        html_url: string | null;
        details_url?: string | null;
        output?: { title?: string | null; summary?: string | null } | null;
      }[];
    };
    try {
      const runs: GhCheckRun[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await this.request<Raw>(
          'GET',
          `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs`,
          {
            query: { per_page: PER_PAGE, page, filter: 'latest' },
            etag: page === 1 ? etag : null,
          },
        );
        if (res.status === 304) return { modified: false };
        if (!Array.isArray(res.data.check_runs)) throw new GitHubError('Check runs were not reported.');
        runs.push(
          ...res.data.check_runs.map((c) => ({
            id: c.id,
            name: c.name,
            headSha: c.head_sha,
            status: c.status,
            conclusion: c.conclusion,
            startedAt: c.started_at,
            completedAt: c.completed_at,
            url: c.html_url ?? c.details_url ?? null,
            outputTitle: c.output?.title ?? null,
            outputSummary: c.output?.summary ?? null,
          })),
        );
        if (!res.next) {
          if (res.data.total_count !== undefined && runs.length < res.data.total_count)
            throw new GitHubError('Check runs were truncated.');
          // One ETag cannot represent every page. Multi-page reads are always fetched again.
          return { modified: true, etag: page === 1 ? res.etag : null, data: runs };
        }
      }
      throw new GitHubError('Too many pages of check runs to verify completely.');
    } catch (err) {
      throw wrap(err, `read the checks on ${sha.slice(0, 7)}`);
    }
  }

  async reviews(repo: string, number: number, etags: readonly string[]): Promise<ConditionalPages<GhReview>> {
    type Raw = {
      id: number;
      state: string;
      user: { login: string } | null;
      body: string | null;
      submitted_at?: string | null;
    };
    const path = `${repoPath(repo)}/pulls/${number}/reviews`;
    try {
      const out: string[] = [];
      const data: GhReview[] = [];
      let changed = false;
      for (let page = 1; page <= 30; page++) {
        const etag = etags[page - 1] ?? null;
        const res = await this.request<Raw[]>('GET', path, { query: { per_page: PER_PAGE, page }, etag });
        if (res.status === 304) {
          out.push(etag ?? '');
          if (page >= etags.length) break;
          continue;
        }
        changed = true;
        out.push(res.etag ?? '');
        data.push(
          ...res.data.map((r) => ({
            id: r.id,
            state: r.state.toLowerCase(),
            author: r.user?.login ?? null,
            body: r.body ?? '',
            submittedAt: r.submitted_at ?? null,
          })),
        );
        // A full page: the next one is where new reviews will land (read now, its ETag kept).
        if (!res.next && res.data.length < PER_PAGE) break;
      }
      return changed ? { modified: true, etags: out, data } : { modified: false };
    } catch (err) {
      throw wrap(err, `read the reviews of PR #${number}`);
    }
  }

  async repoInfo(repo: string, etag: string | null): Promise<Conditional<GhRepo>> {
    try {
      return await this.conditional<RawRepo, GhRepo>(repoPath(repo), {}, etag, toRepo);
    } catch (err) {
      throw wrap(err, `read ${repo}`);
    }
  }

  async branchHead(repo: string, branch: string, etag: string | null): Promise<Conditional<string | null>> {
    try {
      return await this.conditional<{ commit: { sha: string } }, string | null>(
        `${repoPath(repo)}/branches/${refPath(branch)}`,
        {},
        etag,
        (raw) => raw.commit.sha,
      );
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return { modified: true, etag: null, data: null };
      throw wrap(err, `read ${branch}`);
    }
  }

  async workflowRuns(repo: string, etag: string | null): Promise<Conditional<GhWorkflowRun[]>> {
    type Raw = {
      workflow_runs: {
        id: number;
        name?: string | null;
        display_title?: string | null;
        path?: string | null;
        event?: string | null;
        status?: string | null;
        conclusion?: string | null;
        head_branch?: string | null;
        html_url?: string | null;
        created_at?: string | null;
        run_started_at?: string | null;
        updated_at?: string | null;
      }[];
    };
    try {
      return await this.conditional<Raw, GhWorkflowRun[]>(
        `${repoPath(repo)}/actions/runs`,
        { event: 'workflow_dispatch', per_page: 30 },
        etag,
        (raw) =>
          raw.workflow_runs.map((r) => ({
            id: r.id,
            name: r.name ?? null,
            displayTitle: r.display_title ?? null,
            path: r.path ?? null,
            event: r.event ?? null,
            status: r.status ?? null,
            conclusion: r.conclusion ?? null,
            headBranch: r.head_branch ?? null,
            url: r.html_url ?? null,
            createdAt: r.created_at ?? null,
            runStartedAt: r.run_started_at ?? null,
            updatedAt: r.updated_at ?? null,
          })),
      );
    } catch (err) {
      throw wrap(err, `read the workflow runs of ${repo}`);
    }
  }
}
