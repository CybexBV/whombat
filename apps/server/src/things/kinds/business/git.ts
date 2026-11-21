/**
 * GitLab's and Forgejo's or Gitea's page, one shape (service-dashboards.md SD-64, SD-S18): merge or pull requests
 * waiting for the connection's account to review, default branches whose last pipeline or run failed, the runners and
 * the version; the failing ones with **Retry** (a person's change, kept in Done recently), the reviews waiting and the
 * runners; a failing default branch and an offline runner in Worth a look. Kept 2 minutes, read again after Retry.
 *
 * - GitLab (API v4): the account (`/user`), `merge_requests?scope=all&state=opened&reviewer_username=…`, the 20 projects
 *   with the latest activity and, for those active in the last 7 days (8 at most), the default branch's latest
 *   pipeline; runners (`/runners/all` for an administrator, else the account's own `/runners`); `/metadata` for the
 *   version. Retry: `POST /projects/:id/pipelines/:pipeline_id/retry`.
 * - Forgejo and Gitea (API v1, answers checked against Forgejo 17 and Gitea, `fixtures/forgejo`, `fixtures/gitea`):
 *   `/version`, `/user`, `repos/issues/search?type=pulls&review_requested=true&state=open`, `/user/repos` and each
 *   recently active repository's `actions/runs` (left out where the version has none), runners from
 *   `/admin/actions/runners` (an administrator) or `/user/actions/runners`. Retry: `actions/runs/:id/rerun` — on Forgejo
 *   17 or later, and on Gitea where its runs say they can be re-run (`rerun_url`).
 */
import type { ThingLine, ThingPageBar, ThingPageItem, ThingPageKpi, ThingPagePanel } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { KindCheck } from '../../quiet/types';
import { clip, line, list, num, plural, rec, span, str, thousands } from '../../words';
import { actAs } from '../act';
import { cachedRead, latestRead } from '../read';
import type { KindAction, KindModule } from '../registry';
import { countLine, inventory, liveList, slotPanels, trend } from '../slots';
import { fixed, itemLines, type KindNotice, lookInto } from '../storage/lines';
import type { KindCtx, KindView } from '../types';
import {
  bumpGeneration,
  buttonsFor,
  generationOf,
  header,
  loader,
  type MakeButton,
  optional,
  rarelyRead,
  readAnswer,
  readJson,
  seenOfView,
  shortBadge,
  stale,
  statusFrom,
  viewOrProblem,
  webUrl,
} from './common';
import { type Happened, weekCounts, withStat } from './week';

const DAY = 86_400_000;
/** Kept 2 minutes (about a dozen calls a read), read again after Retry. */
export const GIT_CACHE_MS = 2 * 60_000;
/** Projects with activity in this many days have their default branch checked… */
export const ACTIVE_DAYS = 7;
/** …at most this many. */
export const PROJECTS_MAX = 8;
const REVIEWS_MAX = 20;
const ROWS = 10;
/** The default branches' pipelines or runs per day are read apart, kept 10 minutes: a Trend moves slowly. */
export const HISTORY_KEEP_MS = 10 * 60_000;
/** How far back they are asked for: this week and the week before. */
const HISTORY_DAYS = 15;
/** A page of them: GitLab gives 100 at most, Forgejo and Gitea 50. */
export const HISTORY_PAGE = { gitlab: 100, forgejo: 50 } as const;

export type GitService = 'gitlab' | 'forgejo';
const NAMES: Record<GitService, string> = { gitlab: 'GitLab', forgejo: 'Forgejo' };

/* What both read ---------------------------------------------------------------------------------------------------- */

export interface GitReview {
  id: string;
  title: string;
  project: string;
  author: string | null;
  createdAt: Date;
  url: string | null;
  draft: boolean;
}

export interface GitFailure {
  /** What Retry names: `<project id>/<pipeline id>` (GitLab), `<owner>/<repo>/<run id>` (Forgejo, Gitea). */
  id: string;
  /** The project as the service keeps it across runs: GitLab's id, Forgejo's and Gitea's `owner/repo`. */
  projectId: string;
  project: string;
  projectUrl: string | null;
  branch: string;
  /** What ran (the commit's title on Forgejo and Gitea). */
  title: string | null;
  at: Date;
  url: string | null;
  canRetry: boolean;
}

export interface GitRunner {
  id: string;
  name: string;
  online: boolean;
  busy: boolean;
  paused: boolean;
  /**
   * Not watched: GitLab's not seen for a week or more (`stale`) or never (`never_contacted`), a Forgejo or Gitea runner
   * for one job (`ephemeral`) that is offline between jobs.
   */
  gone?: 'stale' | 'never' | 'ephemeral';
  version: string | null;
}

export interface GitSnapshot {
  service: GitService;
  readAt: Date;
  /** “GitLab”, “Forgejo”, “Gitea”. */
  product: string;
  version: string | null;
  reviews: { items: GitReview[]; total: number } | null;
  /** Null when no project's pipelines or runs could be read. */
  failing: GitFailure[] | null;
  /** Default branches checked. */
  checked: number;
  /** Default branches that should have been checked but whose pipelines or runs didn't answer. */
  missed?: number;
  /** Null when the account may not see any runners' list. */
  runners: GitRunner[] | null;
  home: string;
  /**
   * The checked default branches' pipelines or runs of the last two weeks, when to (`since`: a project's page was full,
   * older ones may be missing); null when none was read.
   */
  history?: { runs: Happened[]; since: Date | null } | null;
}

/** The default branches' pipelines or runs of the last two weeks from each project's read (null: not read). */
function historyOf(
  reads: readonly ({ runs: Happened[]; full: Date | null } | null)[] | null,
): GitSnapshot['history'] {
  const got = (reads ?? []).filter((r) => r !== null);
  if (!got.length) return null;
  let since: Date | null = null;
  for (const r of got) if (r.full && (!since || r.full > since)) since = r.full;
  return { runs: got.flatMap((r) => r.runs), since };
}

/** The oldest of a full page: before it, some may be missing. */
const oldestIfFull = (runs: readonly Happened[], raw: number, page: number): Date | null =>
  raw >= page && runs.length ? runs.reduce((m, r) => (r.at < m ? r.at : m), runs[0]?.at as Date) : null;

const dateOf = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
};

const idOf = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : (str(v)?.slice(0, 80) ?? null);

/* GitLab ----------------------------------------------------------------------------------------------------------- */

export interface GitlabProject {
  id: string;
  path: string;
  defaultBranch: string;
  url: string | null;
  activity: Date | null;
}

/** The projects whose default branch is checked: active in the last 7 days, the latest first, 8 at most. */
export function gitlabProjects(body: unknown, now: Date): GitlabProject[] {
  return list(body)
    .map((raw) => {
      const p = rec(raw);
      const id = idOf(p.id);
      const branch = str(p.default_branch);
      if (!id || !branch || p.archived === true) return null;
      return {
        id,
        path: (str(p.path_with_namespace) ?? str(p.name) ?? id).slice(0, 120),
        defaultBranch: branch.slice(0, 120),
        url: webUrl(p.web_url),
        activity: dateOf(p.last_activity_at),
      };
    })
    .filter(
      (p): p is GitlabProject =>
        p !== null && !!p.activity && now.getTime() - p.activity.getTime() <= ACTIVE_DAYS * DAY,
    )
    .sort((a, b) => (b.activity?.getTime() ?? 0) - (a.activity?.getTime() ?? 0))
    .slice(0, PROJECTS_MAX);
}

/** GitLab's merge requests waiting for a review. */
export function gitlabReviews(body: unknown): GitReview[] {
  return list(body)
    .map((raw) => {
      const m = rec(raw);
      const id = idOf(m.id);
      const createdAt = dateOf(m.created_at);
      if (!id || !createdAt) return null;
      const ref = str(rec(m.references).full);
      const author = rec(m.author);
      return {
        id,
        title: (str(m.title) ?? 'A merge request').slice(0, 200),
        project: (ref ? ref.replace(/!\d+$/, '') : (idOf(m.project_id) ?? '')).slice(0, 120),
        author: (str(author.name) ?? str(author.username))?.slice(0, 80) ?? null,
        createdAt,
        url: webUrl(m.web_url),
        draft: m.draft === true || m.work_in_progress === true,
      };
    })
    .filter((r): r is GitReview => r !== null);
}

/**
 * GitLab's runners: online unless `offline`, `stale` or `never_contacted` (the last two `gone`: left over, not watched);
 * `paused` (or v4's `active: false`).
 */
export function gitlabRunners(body: unknown): GitRunner[] {
  return list(body)
    .map((raw) => {
      const r = rec(raw);
      const id = idOf(r.id);
      if (!id) return null;
      const status = str(r.status);
      const gone = status === 'stale' ? 'stale' : status === 'never_contacted' ? 'never' : null;
      return {
        id,
        name: (str(r.description) ?? str(r.name) ?? `Runner ${id}`).slice(0, 80),
        online: status ? status === 'online' : r.online === true,
        busy: false,
        paused: r.paused === true || r.active === false,
        ...(gone ? { gone } : {}),
        version: str(r.version)?.slice(0, 40) ?? null,
      };
    })
    .filter((r): r is GitRunner => r !== null);
}

export interface GitlabAnswers {
  metadata: unknown;
  reviews: { body: unknown; total: number | null } | null;
  projects: GitlabProject[];
  /** Each checked project's latest default-branch pipeline answer, by project id (null: not answered). */
  pipelines: Map<string, unknown>;
  runners: unknown;
  /** Each checked project's default-branch pipelines of the last two weeks, by project id. */
  history?: Map<string, unknown>;
}

/** A GitLab project's default-branch pipelines (the newest first): when each was made and whether it failed. */
export function gitlabHistory(body: unknown): { runs: Happened[]; full: Date | null } {
  const raw = list(body);
  const runs = raw
    .map((x): Happened | null => {
      const p = rec(x);
      const at = dateOf(p.created_at);
      return at ? { at, failed: str(p.status) === 'failed' } : null;
    })
    .filter((r): r is Happened => r !== null);
  return { runs, full: oldestIfFull(runs, raw.length, HISTORY_PAGE.gitlab) };
}

/** GitLab's snapshot from its answers; pure. */
export function gitlabSnapshot(a: GitlabAnswers, now: Date, home: string): GitSnapshot {
  const failing: GitFailure[] = [];
  let checked = 0;
  for (const p of a.projects) {
    const answer = a.pipelines.get(p.id);
    if (answer === undefined || answer === null) continue;
    checked++;
    const pipeline = rec(list(answer)[0]);
    const pid = idOf(pipeline.id);
    if (!pid || str(pipeline.status) !== 'failed') continue;
    failing.push({
      id: `${p.id}/${pid}`,
      projectId: p.id,
      project: p.path,
      projectUrl: p.url,
      branch: str(pipeline.ref) ?? p.defaultBranch,
      title: null,
      at: dateOf(pipeline.updated_at) ?? dateOf(pipeline.created_at) ?? now,
      url: webUrl(pipeline.web_url),
      canRetry: true,
    });
  }
  const items = a.reviews ? gitlabReviews(a.reviews.body) : [];
  const meta = rec(a.metadata);
  return {
    service: 'gitlab',
    readAt: now,
    product: 'GitLab',
    version: str(meta.version)?.slice(0, 40) ?? null,
    reviews: a.reviews ? { items, total: a.reviews.total ?? items.length } : null,
    failing: checked || !a.projects.length ? failing.sort((x, y) => y.at.getTime() - x.at.getTime()) : null,
    checked,
    missed: a.projects.length - checked,
    runners: a.runners === null ? null : gitlabRunners(a.runners),
    home,
    history: a.history
      ? historyOf(
          a.projects.map((p) => {
            const body = a.history?.get(p.id);
            return body === undefined || body === null ? null : gitlabHistory(body);
          }),
        )
      : null,
  };
}

async function readGitlab(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  home: string,
): Promise<GitSnapshot> {
  const name = NAMES.gitlab;
  const get = (path: string, query: Record<string, string> = {}) =>
    readJson(services, row, name, path, { query });
  const rarely = (key: string, path: string, canFail = false) =>
    rarelyRead(services, `gitlab-${key}:${row.id}`, row, () => get(path), { optional: canFail });
  const [user, metadata, projectsBody] = await Promise.all([
    rarely('user', '/api/v4/user'),
    rarely('metadata', '/api/v4/metadata', true),
    get('/api/v4/projects', {
      membership: 'true',
      order_by: 'last_activity_at',
      per_page: '20',
      simple: 'true',
      archived: 'false',
    }),
  ]);
  const me = rec(user);
  const username = str(me.username);
  const projects = gitlabProjects(projectsBody, now);
  const [reviews, runners, ...pipelines] = await Promise.all([
    username
      ? optional(
          readAnswer(services, row, name, '/api/v4/merge_requests', {
            query: {
              scope: 'all',
              state: 'opened',
              reviewer_username: username,
              per_page: String(REVIEWS_MAX),
            },
          }).then((r) => ({ body: r.json, total: num(header(r.headers, 'x-total')) })),
        )
      : Promise.resolve(null),
    optional(
      me.is_admin === true
        ? get('/api/v4/runners/all', { per_page: '100' })
        : get('/api/v4/runners', { per_page: '100' }),
    ),
    ...projects.map((p) =>
      optional(
        get(`/api/v4/projects/${encodeURIComponent(p.id)}/pipelines`, {
          ref: p.defaultBranch,
          per_page: '1',
        }),
      ),
    ),
  ]);
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY).toISOString();
  const history = await Promise.all(
    projects.map((p) =>
      optional(
        cachedRead(
          services,
          `gitlab-history:${row.id}:${p.id}:${p.defaultBranch}`,
          row,
          () =>
            get(`/api/v4/projects/${encodeURIComponent(p.id)}/pipelines`, {
              ref: p.defaultBranch,
              created_after: since,
              per_page: String(HISTORY_PAGE.gitlab),
            }),
          HISTORY_KEEP_MS,
        ),
      ),
    ),
  );
  return gitlabSnapshot(
    {
      metadata,
      reviews,
      projects,
      pipelines: new Map(projects.map((p, i) => [p.id, pipelines[i] ?? null])),
      runners,
      history: new Map(projects.map((p, i) => [p.id, history[i] ?? null])),
    },
    now,
    home,
  );
}

/* Forgejo and Gitea ------------------------------------------------------------------------------------------------ */

/** Forgejo says “17.0.0+gitea-1.22.0”; Gitea its own version. */
export function forgeVersion(v: unknown): {
  product: 'Forgejo' | 'Gitea';
  version: string | null;
  major: number | null;
} {
  const s = str(rec(v).version);
  if (!s) return { product: 'Forgejo', version: null, major: null };
  const forgejo = /\+gitea-/.test(s);
  const version = s.replace(/\+.*$/, '').slice(0, 40);
  const major = Number.parseInt(version, 10);
  return { product: forgejo ? 'Forgejo' : 'Gitea', version, major: Number.isFinite(major) ? major : null };
}

export interface ForgeRepo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  url: string | null;
  updated: Date | null;
}

/** The repositories whose default branch is checked: changed in the last 7 days, with Actions, 8 at most. */
export function forgeRepos(body: unknown, now: Date): ForgeRepo[] {
  return list(body)
    .map((raw) => {
      const r = rec(raw);
      const full = str(r.full_name);
      const [owner, name] = full?.split('/') ?? [];
      const branch = str(r.default_branch);
      if (
        !full ||
        !owner ||
        !name ||
        !branch ||
        r.archived === true ||
        r.empty === true ||
        r.has_actions === false
      )
        return null;
      return {
        owner,
        name,
        fullName: full.slice(0, 120),
        defaultBranch: branch.slice(0, 120),
        url: webUrl(r.html_url),
        updated: dateOf(r.updated_at),
      };
    })
    .filter(
      (r): r is ForgeRepo =>
        r !== null && !!r.updated && now.getTime() - r.updated.getTime() <= ACTIVE_DAYS * DAY,
    )
    .sort((a, b) => (b.updated?.getTime() ?? 0) - (a.updated?.getTime() ?? 0))
    .slice(0, PROJECTS_MAX);
}

/** Pull requests waiting for the account's review (`repos/issues/search`). */
export function forgeReviews(body: unknown): GitReview[] {
  return list(body)
    .map((raw) => {
      const p = rec(raw);
      const id = idOf(p.id);
      const createdAt = dateOf(p.created_at);
      if (!id || !createdAt) return null;
      const user = rec(p.user);
      return {
        id,
        title: (str(p.title) ?? 'A pull request').slice(0, 200),
        project: (str(rec(p.repository).full_name) ?? '').slice(0, 120),
        author: (str(user.full_name) ?? str(user.login))?.slice(0, 80) ?? null,
        createdAt,
        url: webUrl(p.html_url),
        draft: rec(p.pull_request).draft === true,
      };
    })
    .filter((r): r is GitReview => r !== null);
}

/** How a run ended: Forgejo says it in `status`, Gitea in `conclusion` once `status` is `completed`. */
export function runOutcome(run: Record<string, unknown>): 'failed' | 'passed' | 'other' | 'running' {
  const status = str(run.status);
  const conclusion = str(run.conclusion);
  const end = status === 'completed' ? conclusion : status;
  if (end === 'failure') return 'failed';
  if (end === 'success') return 'passed';
  if (end === 'cancelled' || end === 'skipped' || end === 'neutral') return 'other';
  return 'running';
}

/** The default branch's newest finished run, not a pull request's. */
export function lastRun(body: unknown, branch: string): Record<string, unknown> | null {
  for (const raw of list(rec(body).workflow_runs)) {
    const r = rec(raw);
    const ref = str(r.head_branch) ?? str(r.prettyref);
    if (ref !== branch || str(r.event)?.startsWith('pull_request')) continue;
    if (runOutcome(r) !== 'running') return r;
  }
  return null;
}

/** Runners: Forgejo's list (`idle`, `active`, `offline`) or Gitea's `{ runners }` (`online`, `offline`, `busy`). */
export function forgeRunners(body: unknown): GitRunner[] {
  const all = Array.isArray(body) ? body : list(rec(body).runners);
  return all
    .map((raw): GitRunner | null => {
      const r = rec(raw);
      const id = idOf(r.id);
      if (!id) return null;
      const status = str(r.status);
      const online = status !== 'offline' && status !== null;
      return {
        id,
        name: (str(r.name) ?? `Runner ${id}`).slice(0, 80),
        online,
        busy: status === 'active' || r.busy === true,
        paused: r.disabled === true,
        ...(r.ephemeral === true && !online ? { gone: 'ephemeral' as const } : {}),
        version: str(r.version)?.slice(0, 40) ?? null,
      };
    })
    .filter((r): r is GitRunner => r !== null);
}

export interface ForgeAnswers {
  version: unknown;
  reviews: { body: unknown; total: number | null } | null;
  repos: ForgeRepo[];
  /** Each checked repository's runs, by full name (null: not answered, as before Actions had an API). */
  runs: Map<string, unknown>;
  runners: unknown;
  /** Each checked repository's latest 50 runs, by full name, for the default branch's runs per day. */
  history?: Map<string, unknown>;
}

/**
 * A repository's runs on its default branch, not a pull request's: when each was made and whether it failed. Forgejo 17
 * ignores a `branch` filter (checked on a throwaway one), so the branch is picked here.
 */
export function forgeHistory(body: unknown, branch: string): { runs: Happened[]; full: Date | null } {
  const raw = list(rec(body).workflow_runs);
  const runs = raw
    .map((x): Happened | null => {
      const r = rec(x);
      if ((str(r.head_branch) ?? str(r.prettyref)) !== branch || str(r.event)?.startsWith('pull_request'))
        return null;
      const at = dateOf(r.created) ?? dateOf(r.created_at);
      return at ? { at, failed: runOutcome(r) === 'failed' } : null;
    })
    .filter((r): r is Happened => r !== null);
  // Other branches' runs fill the page too: the oldest of all of them is where it may stop being whole.
  const all = raw
    .map((x) => dateOf(rec(x).created) ?? dateOf(rec(x).created_at))
    .filter((d): d is Date => !!d);
  return {
    runs,
    full: oldestIfFull(
      all.map((at) => ({ at })),
      raw.length,
      HISTORY_PAGE.forgejo,
    ),
  };
}

/** Forgejo's or Gitea's snapshot from its answers; pure. */
export function forgeSnapshot(a: ForgeAnswers, now: Date, home: string): GitSnapshot {
  const v = forgeVersion(a.version);
  const failing: GitFailure[] = [];
  let checked = 0;
  for (const repo of a.repos) {
    const answer = a.runs.get(repo.fullName);
    if (answer === undefined || answer === null) continue;
    checked++;
    const run = lastRun(answer, repo.defaultBranch);
    const id = run ? idOf(run.id) : null;
    if (!run || !id || runOutcome(run) !== 'failed') continue;
    failing.push({
      id: `${repo.fullName}/${id}`,
      projectId: repo.fullName,
      project: repo.fullName,
      projectUrl: repo.url,
      branch: repo.defaultBranch,
      title: (str(run.display_title) ?? str(run.title))?.slice(0, 120) ?? null,
      at:
        dateOf(run.completed_at) ??
        dateOf(run.stopped) ??
        dateOf(run.updated_at) ??
        dateOf(run.updated) ??
        now,
      url: webUrl(run.html_url),
      // Forgejo 17 re-runs a run (checked against a real one); Gitea says so with `rerun_url`.
      canRetry: v.product === 'Forgejo' ? (v.major ?? 0) >= 17 : !!str(run.rerun_url),
    });
  }
  const items = a.reviews ? forgeReviews(a.reviews.body) : [];
  return {
    service: 'forgejo',
    readAt: now,
    product: v.product,
    version: v.version,
    reviews: a.reviews ? { items, total: a.reviews.total ?? items.length } : null,
    failing: checked || !a.repos.length ? failing.sort((x, y) => y.at.getTime() - x.at.getTime()) : null,
    checked,
    missed: a.repos.length - checked,
    runners: a.runners === null ? null : forgeRunners(a.runners),
    home,
    history: a.history
      ? historyOf(
          a.repos.map((r) => {
            const body = a.history?.get(r.fullName);
            return body === undefined || body === null ? null : forgeHistory(body, r.defaultBranch);
          }),
        )
      : null,
  };
}

async function readForge(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  home: string,
): Promise<GitSnapshot> {
  const name = NAMES.forgejo;
  const get = (path: string, query: Record<string, string> = {}) =>
    readJson(services, row, name, path, { query });
  const rarely = (key: string, path: string, canFail = false) =>
    rarelyRead(services, `forgejo-${key}:${row.id}`, row, () => get(path), { optional: canFail });
  const [version, user, reposBody] = await Promise.all([
    rarely('version', '/api/v1/version', true),
    rarely('user', '/api/v1/user'),
    get('/api/v1/user/repos', { limit: '50' }),
  ]);
  const repos = forgeRepos(reposBody, now);
  const [reviews, runners, ...runs] = await Promise.all([
    optional(
      readAnswer(services, row, name, '/api/v1/repos/issues/search', {
        query: { type: 'pulls', review_requested: 'true', state: 'open', limit: String(REVIEWS_MAX) },
      }).then((r) => ({ body: r.json, total: num(header(r.headers, 'x-total-count')) })),
    ),
    optional(
      rec(user).is_admin === true
        ? get('/api/v1/admin/actions/runners')
        : get('/api/v1/user/actions/runners'),
    ),
    ...repos.map((r) =>
      optional(
        get(`/api/v1/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}/actions/runs`, {
          limit: '10',
        }),
      ),
    ),
  ]);
  const history = await Promise.all(
    repos.map((r) =>
      optional(
        cachedRead(
          services,
          `forgejo-history:${row.id}:${r.fullName}`,
          row,
          () =>
            get(`/api/v1/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}/actions/runs`, {
              limit: String(HISTORY_PAGE.forgejo),
            }),
          HISTORY_KEEP_MS,
        ),
      ),
    ),
  );
  return forgeSnapshot(
    {
      version,
      reviews,
      repos,
      runs: new Map(repos.map((r, i) => [r.fullName, runs[i] ?? null])),
      runners,
      history: new Map(repos.map((r, i) => [r.fullName, history[i] ?? null])),
    },
    now,
    home,
  );
}

/* Reading, both ---------------------------------------------------------------------------------------------------- */

/** The service's own address (`fields.url`). */
export function gitHome(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (row.fields.url ?? row.baseUrl).replace(/\/+$/, '');
}

const keyOf = (service: GitService, row: CatalogConnectionRow) =>
  `${service}:${row.id}:${generationOf(row.id)}`;

function gitLoad(service: GitService, services: Services, row: CatalogConnectionRow, now: Date) {
  return loader(NAMES[service], () =>
    service === 'gitlab'
      ? readGitlab(services, row, now, gitHome(row))
      : readForge(services, row, now, gitHome(row)),
  );
}

/** A forge's read for its page (PS-01), kept 2 minutes, read again after Retry. */
export function gitLatest(
  service: GitService,
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
) {
  return latestRead(services, keyOf(service, row), row, gitLoad(service, services, row, now), {
    ttlMs: GIT_CACHE_MS,
  });
}

function gitSnapshotOf(service: GitService, services: Services, row: CatalogConnectionRow, now: Date) {
  return cachedRead(services, keyOf(service, row), row, gitLoad(service, services, row, now), GIT_CACHE_MS);
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface GitInput {
  snapshot: GitSnapshot;
  now: Date;
  timeZone: string;
  button?: MakeButton;
}

const WORDS: Record<GitService, { review: string; reviews: string; pipeline: string; pipelines: string }> = {
  gitlab: {
    review: 'merge request',
    reviews: 'merge requests',
    pipeline: 'pipeline',
    pipelines: 'Failing pipelines',
  },
  forgejo: { review: 'pull request', reviews: 'pull requests', pipeline: 'run', pipelines: 'Failing runs' },
};

/** The runners that count: not paused, not left over (`gone`). */
export const watched = (runners: readonly GitRunner[]) => runners.filter((r) => !r.paused && !r.gone);

function runnerCounts(runners: readonly GitRunner[]) {
  const counted = watched(runners);
  return { online: counted.filter((r) => r.online).length, total: counted.length };
}

function figures(input: GitInput): ThingPageKpi[] {
  const { snapshot: s } = input;
  const out: ThingPageKpi[] = [];
  if (s.reviews)
    out.push({
      key: 'reviews',
      label: 'Your reviews',
      value: String(s.reviews.total),
      sub: s.reviews.total ? 'Waiting for you' : 'Nothing waiting',
    });
  if (s.failing)
    out.push({
      key: 'failing',
      label: 'Failing',
      value: String(s.failing.length),
      sub: s.checked
        ? `of ${plural(s.checked, 'default branch', 'default branches')}`
        : 'Nothing ran this week',
      ...(s.failing.length ? { tone: 'warn' as const } : {}),
    });
  if (s.runners?.length) {
    const { online, total } = runnerCounts(s.runners);
    if (total)
      out.push({
        key: 'runners',
        label: 'Runners',
        value: `${online} of ${total}`,
        sub: 'online',
        ...(online === 0 ? { tone: 'bad' as const } : online < total ? { tone: 'warn' as const } : {}),
      });
  }
  if (s.version) out.push({ key: 'version', label: 'Version', value: s.version, sub: s.product });
  return out;
}

/** The checks (quiet-notices.md QN-03): a default branch failing, a runner offline. */
export const GIT_CHECKS = { failing: 'git.branch_failing', runner: 'git.runner_offline' } as const;

/** What Whombat watches (QN-15). */
export function gitChecks(service: GitService): KindCheck[] {
  return [
    {
      check: GIT_CHECKS.failing,
      name:
        service === 'gitlab' ? 'Default branches whose pipeline fails' : 'Default branches whose run fails',
      nature: 'problem',
      perItem: true,
      startsOn: false,
    },
    {
      check: GIT_CHECKS.runner,
      name: 'Runners going offline',
      nature: 'problem',
      perItem: true,
      startsOn: true,
    },
  ];
}

/**
 * The checks this read couldn't see whole (QN-11): no pipeline or run could be read, or one of the branches to check
 * didn't answer; no runners' list. Projects past the eight most active aren't “skipped”: a project that goes quiet ends
 * its Ignore like one that passes, else an Ignore of a failing branch would never end.
 */
export function gitSkipped(s: GitSnapshot): string[] {
  const out: string[] = [];
  if (!s.failing || (s.missed ?? 0) > 0) out.push(GIT_CHECKS.failing);
  if (!s.runners) out.push(GIT_CHECKS.runner);
  return out;
}

/** The last part of a project's path: “web” of “acme/web”. */
const shortName = (path: string) => path.split('/').at(-1) || path;

/**
 * Worth a look (SD-64; QN-S*): each failing default branch, a problem that lasts while it stays red (Ignore ends when
 * it passes twice); each offline runner, red when no runner is online, amber when some are, after two reads in a row
 * (a runner restarting). Paused and left-over runners (GitLab's `stale`, `never_contacted`) aren't watched.
 */
export function gitNotices(input: GitInput): KindNotice[] {
  const { snapshot: s, now } = input;
  const words = WORDS[s.service];
  const failing = itemLines(
    s.failing ?? [],
    (f) => {
      const title = clip(`${f.project}’s ${f.branch} is failing`, 120);
      return {
        id: clip(`failing-${f.projectId}`, 120),
        tone: 'warn',
        icon: 'warn',
        title,
        detail: clip(
          `Its last ${words.pipeline} failed ${span(now.getTime() - f.at.getTime())} ago${f.title ? `: ${f.title}` : ''}.`,
          200,
        ),
        ...(f.url ? { link: { kind: 'url' as const, label: 'Show it', url: f.url } } : {}),
        nature: 'problem',
        check: GIT_CHECKS.failing,
        subject: { id: `project:${f.projectId}`.slice(0, 160), name: clip(f.project, 80) },
        ignore: fixed('Until it passes.'),
        ...shortBadge(title, `${shortName(f.project)} is failing`),
      };
    },
    (f) => f.projectId,
    (rest) => ({
      id: 'failing-more',
      tone: 'warn',
      icon: 'warn',
      title: `${plural(rest.length, 'more default branch', 'more default branches')} failing`,
      nature: 'problem',
      check: GIT_CHECKS.failing,
    }),
  );
  return [...failing, ...runnerLines(s.runners ?? [], s.product)];
}

/**
 * Each offline runner, red when no runner is online, amber when some are, after two reads in a row (a runner
 * restarting); paused and left-over ones aren't watched. GitHub Actions' page says it the same way.
 */
export function runnerLines(all: readonly GitRunner[], product: string): KindNotice[] {
  const runners = watched(all);
  const offline = runners.filter((r) => !r.online);
  const none = runners.length > 0 && offline.length === runners.length;
  const tone = none ? 'bad' : 'warn';
  return itemLines(
    [...offline].sort((a, b) => a.name.localeCompare(b.name)),
    (r) => {
      const title = clip(`Runner ${r.name} is offline`, 120);
      return {
        id: clip(`runner-${r.id}`, 120),
        tone,
        icon: 'power',
        title,
        ...(none ? { detail: 'No runner is online: nothing runs until one is back.' } : {}),
        link: lookInto(`Why is the ${product} runner ${r.name} offline?`),
        nature: 'problem',
        check: GIT_CHECKS.runner,
        subject: { id: `runner:${r.id}`.slice(0, 160), name: clip(r.name, 80) },
        ignore: fixed('Until it’s back online.'),
        confirm: 2,
        ...shortBadge(title, none ? 'No runner is online' : 'A runner is offline'),
      };
    },
    (r) => r.id,
    (rest) => ({
      id: 'runner-more',
      tone,
      icon: 'power',
      title: `${plural(rest.length, 'more runner')} offline`,
      nature: 'problem',
      check: GIT_CHECKS.runner,
      confirm: 2,
    }),
  );
}

/** Hosts where the forge is someone else's: no machine of the person's to show. */
const HOSTED = /(^|\.)(gitlab\.com|codeberg\.org|gitea\.com)$/i;

/**
 * Waiting for you (Live): each failing default branch first, with Retry where the service can, then each merge or pull
 * request waiting for the account's review. The failing ones lead here because their check starts off: nothing else on
 * the page would say so.
 */
export function waitingList(input: GitInput) {
  const { snapshot: s, now, button } = input;
  if (!s.failing && !s.reviews) return null;
  const words = WORDS[s.service];
  const failing = (s.failing ?? []).slice(0, ROWS).map(
    (f): ThingPageItem => ({
      id: `failing-${f.id}`.slice(0, 200),
      title: clip(`${f.project} · ${f.branch}`, 160),
      icon: 'warn',
      tone: 'bad',
      detail: clip(
        `Its last ${words.pipeline} failed ${span(now.getTime() - f.at.getTime())} ago${f.title ? `: ${f.title}` : ''}`,
        300,
      ),
      right: 'Failing',
      ...(f.url ? { url: f.url } : f.projectUrl ? { url: f.projectUrl } : {}),
      ...(button && f.canRetry
        ? { actions: [button({ action: 'retry', target: f.id, label: 'Retry', icon: 'retry' })] }
        : {}),
    }),
  );
  const reviews = (s.reviews?.items ?? []).slice(0, ROWS).map(
    (r): ThingPageItem => ({
      id: `review-${r.id}`.slice(0, 200),
      title: clip(r.title, 160),
      detail: clip(
        [r.project, r.author, `open ${span(now.getTime() - r.createdAt.getTime())}`]
          .filter(Boolean)
          .join(' · '),
        300,
      ),
      ...(r.draft ? { right: 'Draft' } : {}),
      ...(r.url ? { url: r.url } : {}),
    }),
  );
  const n = s.failing?.length ?? 0;
  const meta = [n ? `${n} failing` : '', s.reviews?.total ? `${s.reviews.total} to review` : '']
    .filter(Boolean)
    .join(' · ');
  return liveList({
    id: 'waiting',
    title: 'Waiting for you',
    ...(meta ? { meta } : {}),
    items: [...failing, ...reviews],
    empty:
      s.failing && s.reviews
        ? 'Nothing waits for you. Every default branch passes.'
        : s.failing
          ? 'Every default branch passes.'
          : 'Nothing waits for your review.',
  });
}

/** In GitLab (Inventory): the reviews waiting, the default branches checked and how many fail, the runners online. */
export function gitCounts(input: GitInput) {
  const { snapshot: s, now } = input;
  const lines: ThingPageItem[] = [];
  if (s.reviews) {
    const oldest = s.reviews.items.reduce<Date | null>(
      (m, r) => (!m || r.createdAt < m ? r.createdAt : m),
      null,
    );
    lines.push(
      countLine({
        id: 'reviews',
        icon: 'clock',
        title: 'Your reviews',
        value: thousands(s.reviews.total),
        note: oldest ? `oldest ${span(now.getTime() - oldest.getTime())}` : 'Nothing waiting',
      }),
    );
  }
  if (s.failing) {
    const n = s.failing.length;
    lines.push(
      countLine({
        id: 'branches',
        icon: 'log',
        title: 'Default branches',
        detail: `Changed in the last ${ACTIVE_DAYS} days`,
        value: String(s.checked),
        ...(n
          ? { note: `${n} failing`, noteTone: 'bad' as const }
          : s.checked
            ? { note: 'All pass', noteTone: 'ok' as const }
            : { note: 'Nothing changed' }),
      }),
    );
  }
  if (s.runners?.length) {
    const counted = watched(s.runners);
    const { online, total } = runnerCounts(s.runners);
    const busy = counted.filter((r) => r.online && r.busy).length;
    if (total)
      lines.push(
        countLine({
          id: 'runners',
          icon: 'power',
          title: 'Runners',
          value: `${online} of ${total}`,
          ...(online < total
            ? {
                note: `${total - online} offline`,
                noteTone: online === 0 ? ('bad' as const) : ('warn' as const),
              }
            : busy
              ? { note: `${busy} busy` }
              : { note: 'All online', noteTone: 'ok' as const }),
        }),
      );
  }
  return lines.length ? inventory({ id: 'counts', title: `In ${s.product}`, items: lines }) : null;
}

/**
 * This week (Trend): the pipelines or runs on the checked default branches per day, with how many failed and the
 * change on the week before; left out under 2 days with a bar.
 */
export function gitWeek(input: GitInput) {
  const { snapshot: s, now, timeZone } = input;
  if (!s.history) return null;
  const w = weekCounts(s.history.runs, now, timeZone, s.history.since);
  if (w.values.filter((v) => v !== null).length < 2) return null;
  const words = s.service === 'gitlab' ? (['pipeline', 'pipelines'] as const) : (['run', 'runs'] as const);
  const chart = trend({
    id: 'week',
    title: 'This week',
    meta: `${s.service === 'gitlab' ? 'Pipelines' : 'Runs'} on default branches per day`,
    days: w.days,
    values: w.values,
    label: s.service === 'gitlab' ? 'Pipelines' : 'Runs',
    figure: { value: thousands(w.total), rest: `${w.total === 1 ? words[0] : words[1]} this week` },
    change: w.change,
    color: 'blue',
  });
  return w.failed ? withStat(chart, [{ text: String(w.failed), strong: true }, { text: ' failed' }]) : chart;
}

/** Its own line in the machine card: its version, when it runs on the person's own machine. */
export function gitMachineLines(s: GitSnapshot): ThingPageBar[] {
  if (!s.version) return [];
  try {
    if (HOSTED.test(new URL(s.home).hostname)) return [];
  } catch {
    return [];
  }
  return [{ id: 'version', label: s.product, value: clip(s.version, 40), pct: null }];
}

/** Offline ones first, then online, then paused and left over. */
const runnerRank = (r: GitRunner) => (r.paused || r.gone ? 2 : r.online ? 1 : 0);

function runnerItems(s: GitSnapshot): ThingPageItem[] {
  return [...(s.runners ?? [])]
    .sort((a, b) => runnerRank(a) - runnerRank(b) || a.name.localeCompare(b.name))
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      title: r.name,
      ...(r.version ? { detail: r.version } : {}),
      tone: r.paused || r.gone ? 'info' : r.online ? 'ok' : 'bad',
      right: r.paused
        ? 'Paused'
        : r.gone === 'never'
          ? 'Never connected'
          : r.gone === 'stale'
            ? 'Not seen for a while'
            : !r.online
              ? 'Offline'
              : r.busy
                ? 'Busy'
                : 'Online',
    }));
}

/**
 * The page's forge part, from what was read; pure. Its Summary in slots (docs/service-pages.md): what waits for the
 * person beside the counts, this week's pipelines or runs, the version in the machine card; the runners below.
 */
export function gitView(input: GitInput): KindView {
  const { snapshot: s } = input;
  const notices = gitNotices(input);
  const more: ThingPagePanel[] = [];
  if (s.runners?.length) more.push({ kind: 'list', id: 'runners', title: 'Runners', items: runnerItems(s) });
  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`${s.product} **${s.version}**`));
  if (s.reviews?.total) facts.push(line(`**${s.reviews.total}** waiting for your review`));
  return {
    // In slots its figures are in Waiting for you and the counts; the card keeps them (`gitCardView`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices,
    ...slotPanels({
      live: waitingList(input),
      inventory: gitCounts(input),
      trend: gitWeek(input),
      more,
      machine: gitMachineLines(s),
    }),
    tabs: [],
    facts,
    status: statusFrom(notices, s.failing?.length === 0 ? 'Default branches pass' : 'Running'),
    open: { label: `Open ${s.product}`, url: s.home },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Merge requests waiting longest', 'Pipelines that failed this week', 'Slowest pipelines'],
  };
}

/** The page's part as the card reads it: the card keeps Your reviews and Failing. */
export function gitCardView(input: GitInput): KindView {
  return { ...gitView(input), kpis: figures(input) };
}

/* The page and Retry ------------------------------------------------------------------------------------------------ */

function gitPage(service: GitService) {
  return async (ctx: KindCtx): Promise<KindView> => {
    const read = await gitLatest(service, ctx.services, ctx.row, ctx.now);
    const home = gitHome(ctx.row);
    return viewOrProblem(read, NAMES[service], { label: `Open ${NAMES[service]}`, url: home }, (snapshot) =>
      gitView({ snapshot, now: ctx.now, timeZone: ctx.timeZone, button: buttonsFor(ctx) }),
    );
  };
}

/** **Retry** on a failing pipeline or run (SD-64): only one the page shows, where the service can; Done recently. */
function retryAction(service: GitService): KindAction {
  return async (ctx, input) => {
    const name = NAMES[service];
    const target = typeof input.target === 'string' ? input.target : '';
    const snapshot = await gitSnapshotOf(service, ctx.services, ctx.row, ctx.now);
    const failure = snapshot.failing?.find((f) => f.id === target && f.canRetry);
    if (!failure) throw stale(snapshot.product);
    const cut = failure.id.lastIndexOf('/');
    const run = failure.id.slice(cut + 1);
    const project = failure.id.slice(0, cut);
    if (service === 'gitlab')
      await actAs(ctx.services, ctx.row, name, {
        method: 'POST',
        path: `/api/v4/projects/${encodeURIComponent(project)}/pipelines/${encodeURIComponent(run)}/retry`,
      });
    else {
      const [owner, repo] = project.split('/');
      await actAs(ctx.services, ctx.row, snapshot.product, {
        method: 'POST',
        path: `/api/v1/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(repo ?? '')}/actions/runs/${encodeURIComponent(run)}/rerun`,
      });
    }
    bumpGeneration(ctx.row.id);
    const what = WORDS[service].pipeline;
    return {
      message: `Running ${failure.project}’s ${what} again.`,
      title: `Retried ${failure.project}’s ${what} on ${failure.branch}`.slice(0, 200),
    };
  };
}

function gitKind(service: GitService): KindModule {
  return {
    page: gitPage(service),
    prefetch: (services, row, now) => gitLatest(service, services, row, now),
    async seen(services, row, now, timeZone) {
      const snapshot = await gitSnapshotOf(service, services, row, now);
      return seenOfView(
        gitCardView({ snapshot, now, timeZone }),
        ['reviews', 'failing'],
        undefined,
        gitSkipped(snapshot),
      );
    },
    checks: gitChecks(service),
    asksFirst: 'merging and deleting ask first',
    actions: { retry: retryAction(service) },
  };
}

export const GITLAB_KIND = gitKind('gitlab');
export const FORGEJO_KIND = gitKind('forgejo');
