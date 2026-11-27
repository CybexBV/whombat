/**
 * GitHub Actions' page (docs/decisions/service-dashboards.md “GitHub Actions”): what runs now, on which runner and at
 * which step, how far it is against the workflow's usual time; what waits for a runner; each workflow's last result on
 * its repository's default branch, a failed one with **Retry** (its failed jobs again); the latest runs on any branch;
 * the self-hosted runners. Worth a look: a workflow failing on a default branch, a runner offline (said as GitLab's and
 * Forgejo's), a job waiting for a runner that nothing online can take, or waiting half an hour.
 *
 * Read with the connection's fine-grained token and kept a minute. Per repository: its latest runs, its runners (a
 * token without Administration read gets none, and the page says so), the default branch's finished runs (5 minutes),
 * the workflows' names (15 minutes), and the jobs of up to six runs that haven't finished; an organisation's own runners
 * once per organisation. The repositories are the connection's list, else the ones the token sees that changed last.
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageRow,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { ApiError, forbidden } from '../../../lib/errors';
import type { Services } from '../../../services';
import type { KindCheck } from '../../quiet/types';
import { cap, clip, line, list, num, plural, rec, span, str, thousands, when } from '../../words';
import { actAs } from '../act';
import { cachedRead, latestRead } from '../read';
import type { KindAction, KindModule } from '../registry';
import { countLine, inventory, liveRows, slotPanels, trend } from '../slots';
import { fixed, itemLines, type KindNotice, lookInto } from '../storage/lines';
import type { KindCtx, KindView } from '../types';
import {
  bumpGeneration,
  buttonsFor,
  generationOf,
  loader,
  type MakeButton,
  optional,
  rarelyRead,
  readJson,
  seenOfView,
  shortBadge,
  stale,
  statusFrom,
  viewOrProblem,
  webUrl,
} from './common';
import { GIT_CHECKS, type GitRunner, runnerLines, watched } from './git';
import { type Happened, weekCounts, withStat } from './week';

const NAME = 'GitHub Actions';
const HOME = 'https://github.com';
const DAY = 86_400_000;
const MIN = 60_000;

/** Kept a minute: what runs moves on quickly, and a read is a few calls per repository. */
export const ACTIONS_CACHE_MS = MIN;
/** The default branch's finished runs change only when one ends, which the latest runs show at once. */
export const MAIN_KEEP_MS = 5 * MIN;
/** Without a list, the repositories the token sees that changed last, at most this many; a list, at most… */
export const AUTO_REPOS = 5;
export const REPOS_MAX = 10;
/** Which repositories were pushed to last: a push to another one shows its run within a couple of minutes. */
export const AUTO_REPOS_KEEP_MS = 2 * MIN;
const RUNS_PAGE = '30';
/** The runs of the last two weeks per repository, for runs per day: a page of 100 (GitHub's most), kept 10 minutes. */
export const HISTORY_PAGE = 100;
export const HISTORY_KEEP_MS = 10 * MIN;
const HISTORY_DAYS = 15;
/** Runs not finished whose jobs are read (which runner, which step, what waits). */
export const JOBS_MAX = 6;
/** A workflow's last result on the default branch counts while it is this recent. */
export const RESULT_DAYS = 30;
/** A job has waited too long when nothing online can take it… */
export const WAIT_NOBODY_MS = 5 * MIN;
/** …and when every runner that could is busy, or it waits for GitHub's own runners. */
export const WAIT_LONG_MS = 30 * MIN;
const ROWS = 10;

/** What a job waiting for a runner raises (the others are the forges' own). */
export const ACTIONS_CHECKS = { ...GIT_CHECKS, waiting: 'git.job_waiting' } as const;

/* What is read -------------------------------------------------------------------------------------------------------- */

export interface ActionsRepo {
  /** `owner/name`. */
  fullName: string;
  defaultBranch: string;
  url: string | null;
  /** Its owner is an organisation, whose own runners may serve it. */
  org: boolean;
}

export type RunState = 'queued' | 'waiting' | 'running' | 'passed' | 'failed' | 'other';

export interface ActionsRun {
  /** `owner/name/<run id>`: what Retry names. */
  id: string;
  repo: string;
  runId: string;
  workflowId: string;
  /** The workflow's own name (“Main checks”), not the run's (“Main checks: e1060cc…”). */
  workflow: string;
  branch: string;
  event: string | null;
  /** The commit's or pull request's title, when the run has one of its own. */
  title: string | null;
  state: RunState;
  /** GitHub's `conclusion` once finished (`cancelled`, `skipped`, …), for the words of one that didn't pass or fail. */
  conclusion: string | null;
  createdAt: Date;
  startedAt: Date | null;
  /** When it finished. */
  endedAt: Date | null;
  url: string | null;
}

export interface ActionsJob {
  id: string;
  name: string;
  state: 'queued' | 'waiting' | 'running';
  runner: string | null;
  labels: string[];
  queuedAt: Date;
  startedAt: Date | null;
  /** The step it is at, and how many of its steps are done. */
  step: string | null;
  stepsDone: number;
  steps: number;
}

export interface ActiveRun extends ActionsRun {
  /** Its jobs that haven't finished; null when they weren't read. */
  jobs: ActionsJob[] | null;
  /** How long the workflow usually takes there (the middle of its last passing runs), when known. */
  usualMs: number | null;
}

export interface ActionsRunner extends GitRunner {
  /** Every label, for which jobs it can take, and its own (`falcon-ci`, `main`), for what it is for. */
  labels: string[];
  custom: string[];
  /** The organisation it serves, for an organisation's runner. */
  org: string | null;
}

export interface ActionsSnapshot {
  readAt: Date;
  repos: ActionsRepo[];
  /** Repositories of the connection's list that the token can't see. */
  unseen: string[];
  /** Repositories whose runs didn't answer. */
  missed: string[];
  /** Runs not finished, the oldest first. */
  active: ActiveRun[];
  /** Each workflow's last result on its repository's default branch: failed first, then by name. */
  latest: ActionsRun[];
  /** Every finished run read, the newest first. */
  recent: ActionsRun[];
  /** Runs before this may not have been read (a repository's page of runs was full). */
  seenSince: Date | null;
  /** Null when no runners' list could be read. */
  runners: ActionsRunner[] | null;
  /** Every run of the last two weeks, when they were made and whether they failed; whole from `since`. Null: not read. */
  history?: { runs: Happened[]; since: Date | null } | null;
}

const dateOf = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
};

const idOf = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : (str(v)?.slice(0, 80) ?? null);

const present = <T>(x: T | null): x is T => x !== null;

/** `owner/name` for a path, each part encoded. */
export const repoPath = (fullName: string) => fullName.split('/').map(encodeURIComponent).join('/');

/** The connection's list: `owner/name`, each once, at most `REPOS_MAX`. */
export function repoList(field: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (field ?? '').split(',')) {
    const name = part.trim().replace(/\.git$/, '');
    if (/^[\w.-]+\/[\w.-]+$/.test(name) && !out.some((n) => n.toLowerCase() === name.toLowerCase()))
      out.push(name);
  }
  return out.slice(0, REPOS_MAX);
}

export function repoOf(body: unknown): ActionsRepo | null {
  const r = rec(body);
  const fullName = str(r.full_name);
  const branch = str(r.default_branch);
  if (!fullName || !branch) return null;
  return {
    fullName: fullName.slice(0, 120),
    defaultBranch: branch.slice(0, 120),
    url: webUrl(r.html_url),
    org: rec(r.owner).type === 'Organization',
  };
}

/** The repositories the token sees that changed last (`/user/repos?sort=pushed`), archived ones left out. */
export function autoRepos(body: unknown): ActionsRepo[] {
  return list(body)
    .filter((r) => rec(r).archived !== true)
    .map(repoOf)
    .filter(present)
    .slice(0, AUTO_REPOS);
}

/** How a run or a job stands, from GitHub's `status` and `conclusion`. */
export function runState(status: string | null, conclusion: string | null): RunState {
  switch (status) {
    case 'completed':
      if (conclusion === 'success') return 'passed';
      if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure')
        return 'failed';
      return 'other';
    case 'in_progress':
      return 'running';
    case 'queued':
      return 'queued';
    // An approval for an environment, a concurrency group's turn.
    case 'waiting':
    case 'pending':
    case 'requested':
      return 'waiting';
    default:
      return 'other';
  }
}

const finished = (s: RunState) => s === 'passed' || s === 'failed' || s === 'other';

/** A workflow's file name without its folder and extension, when GitHub gave no name. */
const fileName = (path: string | null) =>
  path
    ?.split('/')
    .at(-1)
    ?.replace(/\.ya?ml$/, '') || null;

/** The workflows' names by id, and those switched off. */
export function workflowsOf(body: unknown): { names: Map<string, string>; off: Set<string> } {
  const names = new Map<string, string>();
  const off = new Set<string>();
  for (const raw of list(rec(body).workflows)) {
    const w = rec(raw);
    const id = idOf(w.id);
    const name = str(w.name) ?? fileName(str(w.path));
    if (!id || !name) continue;
    names.set(id, name.slice(0, 80));
    if (str(w.state)?.startsWith('disabled')) off.add(id);
  }
  return { names, off };
}

export function runsOf(body: unknown, repo: string, names: ReadonlyMap<string, string>): ActionsRun[] {
  return list(rec(body).workflow_runs)
    .map((raw): ActionsRun | null => {
      const r = rec(raw);
      const runId = idOf(r.id);
      const createdAt = dateOf(r.created_at);
      if (!runId || !createdAt) return null;
      const workflowId = idOf(r.workflow_id) ?? '';
      const own = str(r.name);
      const workflow = names.get(workflowId) ?? own ?? fileName(str(r.path)) ?? 'A workflow';
      const display = str(r.display_title);
      const state = runState(str(r.status), str(r.conclusion));
      return {
        id: `${repo}/${runId}`,
        repo,
        runId,
        workflowId,
        workflow: workflow.slice(0, 80),
        branch: (str(r.head_branch) ?? '').slice(0, 120),
        event: str(r.event),
        // A run named by its workflow (`run-name`) has no title of its own.
        title: display && display !== own && display !== workflow ? display.slice(0, 120) : null,
        state,
        conclusion: finished(state) ? (str(r.conclusion)?.slice(0, 40) ?? null) : null,
        createdAt,
        startedAt: dateOf(r.run_started_at),
        endedAt: finished(state) ? dateOf(r.updated_at) : null,
        url: webUrl(r.html_url),
      };
    })
    .filter(present);
}

/** A run's jobs that haven't finished. */
export function jobsOf(body: unknown): ActionsJob[] {
  return list(rec(body).jobs)
    .map((raw): ActionsJob | null => {
      const j = rec(raw);
      const id = idOf(j.id);
      const queuedAt = dateOf(j.created_at);
      const state = runState(str(j.status), str(j.conclusion));
      if (!id || !queuedAt || (state !== 'queued' && state !== 'waiting' && state !== 'running')) return null;
      const steps = list(j.steps).map(rec);
      const current = steps.find((s) => str(s.status) === 'in_progress');
      return {
        id,
        name: (str(j.name) ?? 'A job').slice(0, 80),
        state,
        runner: state === 'running' ? (str(j.runner_name)?.slice(0, 80) ?? null) : null,
        labels: list(j.labels)
          .map(str)
          .filter(present)
          .map((l) => l.slice(0, 60))
          .slice(0, 20),
        queuedAt,
        startedAt: state === 'running' ? dateOf(j.started_at) : null,
        step: current ? (str(current.name)?.slice(0, 80) ?? null) : null,
        stepsDone: steps.filter((s) => str(s.status) === 'completed').length,
        steps: steps.length,
      };
    })
    .filter(present);
}

/** A repository's or an organisation's self-hosted runners; `scope` keeps their ids apart (each counts from 1). */
export function runnersOf(body: unknown, scope: string, org: string | null): ActionsRunner[] {
  return list(rec(body).runners)
    .map((raw): ActionsRunner | null => {
      const r = rec(raw);
      const id = idOf(r.id);
      if (!id) return null;
      const online = str(r.status) === 'online';
      const labels = list(r.labels).map(rec);
      const names = (type?: string) =>
        labels
          .filter((l) => !type || str(l.type) === type)
          .map((l) => str(l.name))
          .filter(present)
          .map((l) => l.slice(0, 60))
          .slice(0, 20);
      return {
        id: `${scope}/${id}`.slice(0, 140),
        name: (str(r.name) ?? `Runner ${id}`).slice(0, 80),
        online,
        busy: online && r.busy === true,
        paused: false,
        // A runner made for one job (just in time) is offline between jobs: left over, not watched.
        ...(r.ephemeral === true && !online ? { gone: 'ephemeral' as const } : {}),
        version: str(r.version)?.slice(0, 40) ?? null,
        labels: names(),
        custom: names('custom'),
        org,
      };
    })
    .filter(present);
}

/** How long a workflow usually takes on a branch: the middle of its last five passing runs there, else anywhere. */
export function usualMs(
  runs: readonly ActionsRun[],
  of: Pick<ActionsRun, 'repo' | 'workflowId' | 'branch'>,
): number | null {
  const took = (r: ActionsRun) =>
    r.startedAt && r.endedAt ? r.endedAt.getTime() - r.startedAt.getTime() : 0;
  const passing = runs.filter(
    (r) => r.repo === of.repo && r.workflowId === of.workflowId && r.state === 'passed' && took(r) > 0,
  );
  const here = passing.filter((r) => r.branch === of.branch);
  const times = (here.length ? here : passing)
    .slice(0, 5)
    .map(took)
    .sort((a, b) => a - b);
  return times.length ? (times[Math.floor(times.length / 2)] ?? null) : null;
}

export interface ActionsAnswers {
  repos: ActionsRepo[];
  unseen: string[];
  /** Per repository: its latest runs (null: they didn't answer), its default branch's finished runs, its workflows. */
  runs: ReadonlyMap<string, unknown>;
  main: ReadonlyMap<string, unknown>;
  workflows: ReadonlyMap<string, unknown>;
  /** Per run (`ActionsRun.id`): its jobs. */
  jobs: ReadonlyMap<string, unknown>;
  /** Each runners' list that answered: a repository's (`org` null) or an organisation's. Null: none did. */
  runners: { scope: string; org: string | null; body: unknown }[] | null;
  /** Per repository: its runs created in the last two weeks (`created=>=…`), null where they didn't answer. */
  history?: ReadonlyMap<string, unknown>;
}

/**
 * A repository's runs of the last two weeks: when each was made and whether it failed, and from when they are whole
 * (GitHub counts them all in `total_count`; a page holds 100).
 */
export function historyOf(body: unknown): { runs: Happened[]; full: Date | null } {
  const raw = list(rec(body).workflow_runs);
  const runs = raw
    .map((x): Happened | null => {
      const r = rec(x);
      const at = dateOf(r.created_at);
      return at ? { at, failed: runState(str(r.status), str(r.conclusion)) === 'failed' } : null;
    })
    .filter(present);
  const total = num(rec(body).total_count) ?? raw.length;
  const full =
    total > raw.length && runs.length
      ? runs.reduce((m, r) => (r.at < m ? r.at : m), runs[0]?.at as Date)
      : null;
  return { runs, full };
}

/** Every repository's runs of the last two weeks, whole from the latest of their cut-offs; null when none answered. */
function historyAll(a: ActionsAnswers): ActionsSnapshot['history'] {
  if (!a.history) return null;
  const got = a.repos.flatMap((r) => {
    const body = a.history?.get(r.fullName);
    return body === undefined || body === null ? [] : [historyOf(body)];
  });
  if (!got.length) return null;
  let since: Date | null = null;
  for (const g of got) if (g.full && (!since || g.full > since)) since = g.full;
  return { runs: got.flatMap((g) => g.runs), since };
}

/** The snapshot from GitHub's answers; pure. */
export function actionsSnapshot(a: ActionsAnswers, now: Date): ActionsSnapshot {
  const seen = new Map<string, ActionsRun>();
  const off = new Set<string>();
  const missed: string[] = [];
  let seenSince: Date | null = null;
  for (const repo of a.repos) {
    const answer = a.runs.get(repo.fullName);
    if (answer === undefined || answer === null) {
      missed.push(repo.fullName);
      continue;
    }
    const w = workflowsOf(a.workflows.get(repo.fullName));
    for (const id of w.off) off.add(`${repo.fullName}/${id}`);
    const latest = runsOf(answer, repo.fullName, w.names);
    if (latest.length >= Number(RUNS_PAGE)) {
      const oldest = latest.reduce((m, r) => (r.createdAt < m ? r.createdAt : m), now);
      if (!seenSince || oldest > seenSince) seenSince = oldest;
    }
    // The latest runs first: they are the freshest word on a run both lists have.
    for (const r of [...latest, ...runsOf(a.main.get(repo.fullName), repo.fullName, w.names)])
      if (!seen.has(r.id)) seen.set(r.id, r);
  }
  const runs = [...seen.values()].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
  const active: ActiveRun[] = runs
    .filter((r) => !finished(r.state))
    .reverse()
    .map((r) => {
      const jobs = a.jobs.get(r.id);
      return {
        ...r,
        jobs: jobs === undefined || jobs === null ? null : jobsOf(jobs),
        usualMs: usualMs(runs, r),
      };
    });
  const latest: ActionsRun[] = [];
  for (const repo of a.repos) {
    const mine = runs.filter(
      (r) =>
        r.repo === repo.fullName &&
        r.branch === repo.defaultBranch &&
        finished(r.state) &&
        !r.event?.startsWith('pull_request') &&
        !off.has(`${r.repo}/${r.workflowId}`) &&
        now.getTime() - (r.endedAt ?? r.createdAt).getTime() <= RESULT_DAYS * DAY,
    );
    for (const id of new Set(mine.map((r) => r.workflowId))) {
      const of = mine.filter((r) => r.workflowId === id);
      // A cancelled or skipped run says nothing about how it stands: the last one that passed or failed does.
      const last = of.find((r) => r.state !== 'other') ?? of[0];
      if (last) latest.push(last);
    }
  }
  latest.sort(
    (x, y) =>
      Number(y.state === 'failed') - Number(x.state === 'failed') ||
      x.workflow.localeCompare(y.workflow) ||
      x.repo.localeCompare(y.repo),
  );
  const runners = a.runners === null ? null : a.runners.flatMap((l) => runnersOf(l.body, l.scope, l.org));
  return {
    readAt: now,
    repos: a.repos,
    unseen: a.unseen,
    missed,
    active,
    latest,
    recent: runs.filter((r) => finished(r.state)),
    seenSince,
    runners,
    history: historyAll(a),
  };
}

/* Reading -------------------------------------------------------------------------------------------------------------- */

async function readActions(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<ActionsSnapshot> {
  const get = (path: string, query: Record<string, string> = {}) =>
    readJson(services, row, NAME, path, { query });
  const named = repoList(row.fields.repos);
  const unseen: string[] = [];
  let repos: ActionsRepo[];
  if (named.length) {
    const found = await Promise.all(
      named.map((n) =>
        rarelyRead(services, `gha-repo:${row.id}:${n}`, row, () => get(`/repos/${repoPath(n)}`), {
          optional: true,
        }),
      ),
    );
    repos = [];
    named.forEach((n, i) => {
      const repo = repoOf(found[i]);
      if (repo) repos.push(repo);
      else unseen.push(n);
    });
    // None seen: a refused token says so rather than “can't see”.
    if (!repos.length) await get('/user');
  } else
    repos = autoRepos(
      await cachedRead(
        services,
        `gha-repos:${row.id}`,
        row,
        () => get('/user/repos', { sort: 'pushed', per_page: '30' }),
        AUTO_REPOS_KEEP_MS,
      ),
    );
  const generation = generationOf(row.id);
  const per = await Promise.all(
    repos.map(async (repo) => {
      const base = `/repos/${repoPath(repo.fullName)}/actions`;
      const [runs, main, workflows, runners] = await Promise.all([
        get(`${base}/runs`, { per_page: RUNS_PAGE }).then(
          (body) => ({ body }),
          (error: unknown) => ({ error }),
        ),
        optional(
          cachedRead(
            services,
            `gha-main:${row.id}:${generation}:${repo.fullName}`,
            row,
            () =>
              get(`${base}/runs`, {
                branch: repo.defaultBranch,
                status: 'completed',
                exclude_pull_requests: 'true',
                per_page: RUNS_PAGE,
              }),
            MAIN_KEEP_MS,
          ),
        ),
        rarelyRead(
          services,
          `gha-workflows:${row.id}:${repo.fullName}`,
          row,
          () => get(`${base}/workflows`),
          {
            optional: true,
          },
        ),
        optional(get(`${base}/runners`, { per_page: '100' })),
      ]);
      const history = await optional(
        cachedRead(
          services,
          `gha-history:${row.id}:${repo.fullName}`,
          row,
          () =>
            get(`${base}/runs`, {
              created: `>=${new Date(now.getTime() - HISTORY_DAYS * DAY).toISOString().slice(0, 10)}`,
              per_page: String(HISTORY_PAGE),
            }),
          HISTORY_KEEP_MS,
        ),
      );
      return { repo, runs, main, workflows, runners, history };
    }),
  );
  const failed = per.map((p) => ('error' in p.runs ? p.runs.error : null)).filter((e) => e !== null);
  if (repos.length && failed.length === repos.length) throw failed[0];
  const orgs = [...new Set(repos.filter((r) => r.org).map((r) => r.fullName.split('/')[0] ?? ''))].filter(
    Boolean,
  );
  const orgRunners = await Promise.all(
    orgs.map((org) => optional(get(`/orgs/${encodeURIComponent(org)}/actions/runners`, { per_page: '100' }))),
  );
  const bodies = (p: (typeof per)[number]) => ('body' in p.runs ? p.runs.body : null);
  const waiting = per
    .flatMap((p) => runsOf(bodies(p), p.repo.fullName, new Map()))
    .filter((r) => !finished(r.state))
    .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())
    .slice(0, JOBS_MAX);
  const jobs = await Promise.all(
    waiting.map((r) =>
      optional(
        get(`/repos/${repoPath(r.repo)}/actions/runs/${encodeURIComponent(r.runId)}/jobs`, {
          filter: 'latest',
          per_page: '30',
        }),
      ),
    ),
  );
  const lists = [
    ...per.flatMap((p) =>
      p.runners === null ? [] : [{ scope: p.repo.fullName, org: null, body: p.runners }],
    ),
    ...orgs.flatMap((org, i) =>
      orgRunners[i] === null || orgRunners[i] === undefined ? [] : [{ scope: org, org, body: orgRunners[i] }],
    ),
  ];
  return actionsSnapshot(
    {
      repos,
      unseen,
      runs: new Map(per.map((p) => [p.repo.fullName, bodies(p)])),
      main: new Map(per.map((p) => [p.repo.fullName, p.main])),
      workflows: new Map(per.map((p) => [p.repo.fullName, p.workflows])),
      jobs: new Map(waiting.map((r, i) => [r.id, jobs[i] ?? null])),
      runners: lists.length ? lists : null,
      history: new Map(per.map((p) => [p.repo.fullName, p.history])),
    },
    now,
  );
}

const keyOf = (row: CatalogConnectionRow) => `github_actions:${row.id}:${generationOf(row.id)}`;

const load = (services: Services, row: CatalogConnectionRow, now: Date) =>
  loader(NAME, () => readActions(services, row, now));

/** The page's read, kept a minute, read again after Retry. */
export function actionsLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, keyOf(row), row, load(services, row, now), { ttlMs: ACTIONS_CACHE_MS });
}

function snapshotOf(services: Services, row: CatalogConnectionRow, now: Date) {
  return cachedRead(services, keyOf(row), row, load(services, row, now), ACTIONS_CACHE_MS);
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface ActionsInput {
  snapshot: ActionsSnapshot;
  now: Date;
  timeZone: string;
  button?: MakeButton;
}

/** The last part of `owner/name`. */
const shortName = (fullName: string) => fullName.split('/').at(-1) || fullName;

/** “main” when every repository's default branch is called so, else “the default branch”. */
function branchWords(s: ActionsSnapshot): string {
  const names = new Set(s.repos.map((r) => r.defaultBranch));
  return names.size === 1 ? ([...names][0] ?? 'the default branch') : 'the default branch';
}

const many = (s: ActionsSnapshot) => s.repos.length > 1;

/** What started a run, in words (GitHub's `event`). */
const EVENTS: Record<string, string> = {
  push: 'Push',
  pull_request: 'Pull request',
  pull_request_target: 'Pull request',
  schedule: 'Scheduled',
  workflow_dispatch: 'By hand',
  merge_group: 'Merge queue',
  release: 'Release',
  workflow_run: 'After another workflow',
  workflow_call: 'From another workflow',
  repository_dispatch: 'From outside',
};

export function eventWords(event: string | null): string | null {
  if (!event) return null;
  return EVENTS[event] ?? cap(event.replace(/_/g, ' '));
}

const RESULT = {
  passed: { text: 'Passed', dot: 'ok' },
  failed: { text: 'Failed', dot: 'bad' },
} as const;

/** How a run that neither passed nor failed ended. */
const ENDED: Record<string, string> = {
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  action_required: 'Needs approval',
  neutral: 'Neutral',
  stale: 'Stale',
};

function resultCell(r: ActionsRun) {
  if (r.state === 'passed' || r.state === 'failed')
    return { text: RESULT[r.state].text, dot: RESULT[r.state].dot };
  return { text: (r.conclusion && ENDED[r.conclusion]) || 'Didn’t finish', dot: 'off' as const };
}

const tookMs = (r: ActionsRun) =>
  r.startedAt && r.endedAt ? Math.max(0, r.endedAt.getTime() - r.startedAt.getTime()) : null;

/** Can this runner take a job with these labels (GitHub matches every label, in any case)? */
export function canTake(runner: ActionsRunner, labels: readonly string[]): boolean {
  const own = new Set(runner.labels.map((l) => l.toLowerCase()));
  return labels.every((l) => own.has(l.toLowerCase()));
}

const SELF_HOSTED = 'self-hosted';
const selfHosted = (labels: readonly string[]) => labels.some((l) => l.toLowerCase() === SELF_HOSTED);
/** A job's labels a person reads: without `self-hosted`, the one every such job has. */
const ownLabels = (labels: readonly string[]) => labels.filter((l) => l.toLowerCase() !== SELF_HOSTED);

/** What a run is doing now, in words, and how far it is (0…1) when that is known. */
export function progressOf(
  a: ActiveRun,
  now: Date,
): { elapsedMs: number | null; meter?: number; words: string; late?: boolean } {
  if (a.state === 'waiting') return { elapsedMs: null, words: 'Waiting its turn' };
  const running = a.jobs?.filter((j) => j.state === 'running') ?? [];
  const queued = a.jobs?.filter((j) => j.state === 'queued') ?? [];
  if (a.state === 'queued' || (a.jobs && !running.length && queued.length)) {
    const since = queued.reduce((m, j) => (j.queuedAt < m ? j.queuedAt : m), a.createdAt);
    const waited = now.getTime() - since.getTime();
    return { elapsedMs: null, words: waited < MIN ? 'Just queued' : `Waiting ${span(waited)}` };
  }
  const elapsed = Math.max(0, now.getTime() - (a.startedAt ?? a.createdAt).getTime());
  if (a.usualMs) {
    const left = a.usualMs - elapsed;
    if (left < 0 && elapsed > a.usualMs * 1.25 && -left > 2 * MIN)
      return { elapsedMs: elapsed, meter: 0.99, words: 'Longer than usual', late: true };
    return {
      elapsedMs: elapsed,
      meter: Math.min(0.99, elapsed / a.usualMs),
      words: left >= MIN ? `About ${span(left)} left` : 'Almost done',
    };
  }
  const steps = running.reduce((n, j) => n + j.steps, 0);
  const done = running.reduce((n, j) => n + j.stepsDone, 0);
  return {
    elapsedMs: elapsed,
    ...(steps ? { meter: Math.min(0.99, done / steps) } : {}),
    words: steps ? `Step ${Math.min(done + 1, steps)} of ${steps}` : 'Running',
  };
}

/** Where a run is: its branch, and its repository's name when there are several. */
const whereOf = (s: ActionsSnapshot, r: Pick<ActionsRun, 'repo' | 'branch'>) =>
  clip(many(s) ? `${shortName(r.repo)} · ${r.branch}` : r.branch, 80);

/**
 * What runs now and what waits (the oldest first): the workflow; its branch, runner and step; how far against its usual
 * time, how long it has run and how long is left. A job that has waited too long for a runner, or a run taking longer
 * than usual, says so as its tag.
 */
export function runningItems(input: ActionsInput): ThingGalleryItem[] {
  const { snapshot: s, now } = input;
  const late = new Map(waitingTooLong(s, now).map((w) => [w.run.id, w.why]));
  return s.active.slice(0, ROWS).map((a) => {
    const running = a.jobs?.filter((j) => j.state === 'running') ?? [];
    const runners = [...new Set(running.map((j) => j.runner).filter(present))];
    const step =
      running.length === 1 ? running[0]?.step : running.length > 1 ? plural(running.length, 'job') : null;
    const p = progressOf(a, now);
    const sub = [a.branch ? whereOf(s, a) : '', runners.join(', '), step ?? ''].filter(Boolean).join(' · ');
    const waits = late.get(a.id);
    return {
      id: a.id.slice(0, 200),
      title: clip(a.workflow, 120),
      ...(sub ? { sub: clip(sub, 120) } : {}),
      ...(p.meter !== undefined ? { progress: p.meter } : {}),
      // How long it has run; a run that waits has no start yet, its end says how long it has waited.
      ...(p.elapsedMs !== null ? { note: span(p.elapsedMs) } : {}),
      noteEnd: clip(p.words, 60),
      ...(waits
        ? { badge: { text: 'Waiting', tone: waits === 'nobody' ? ('bad' as const) : ('warn' as const) } }
        : p.late
          ? { badge: { text: 'Late', tone: 'warn' as const } }
          : {}),
      ...(a.url ? { url: a.url } : {}),
    };
  });
}

/** Each workflow's last result on the default branch, Retry on a failed one. */
export function latestRows(input: ActionsInput): ThingPageRow[] {
  const { snapshot: s, now, timeZone, button } = input;
  return s.latest.slice(0, 20).map((r) => {
    const took = tookMs(r);
    return {
      id: r.id.slice(0, 200),
      cells: {
        workflow: {
          text: clip(r.workflow, 200),
          ...(many(s) ? { note: clip(shortName(r.repo), 80) } : {}),
          ...(r.url ? { url: r.url } : {}),
        },
        result: resultCell(r),
        when: { text: when(r.endedAt ?? r.createdAt, now, timeZone) },
        took: { text: took === null ? '—' : span(took) },
        ...(button && r.state === 'failed'
          ? {
              retry: {
                text: 'Retry',
                action: button({ action: 'retry', target: r.id, label: 'Retry', icon: 'retry' }),
              },
            }
          : {}),
      },
    };
  });
}

/** The latest finished runs on any branch, the newest first. */
export function recentRows(input: ActionsInput): ThingPageRow[] {
  const { snapshot: s, now, timeZone } = input;
  return s.recent.slice(0, ROWS).map((r) => {
    const took = tookMs(r);
    return {
      id: r.id.slice(0, 200),
      cells: {
        workflow: {
          text: clip(r.workflow, 200),
          ...(r.branch ? { note: whereOf(s, r) } : {}),
          ...(r.url ? { url: r.url } : {}),
        },
        event: { text: eventWords(r.event) ?? '—' },
        result: resultCell(r),
        when: { text: when(r.endedAt ?? r.createdAt, now, timeZone) },
        took: { text: took === null ? '—' : span(took) },
      },
    };
  });
}

/** Offline ones first, then busy, then idle; left-over ones last. */
const runnerRank = (r: ActionsRunner) => (r.gone ? 3 : !r.online ? 0 : r.busy ? 1 : 2);

/** The runners: what each is busy with, else what it is for (its own labels). */
export function runnerItems(s: ActionsSnapshot): ThingPageItem[] {
  const doing = new Map<string, string>();
  for (const a of s.active)
    for (const j of a.jobs ?? []) if (j.runner && !doing.has(j.runner)) doing.set(j.runner, a.workflow);
  return [...(s.runners ?? [])]
    .sort((a, b) => runnerRank(a) - runnerRank(b) || a.name.localeCompare(b.name))
    .slice(0, 20)
    .map((r) => {
      const busyWith = r.busy ? doing.get(r.name) : undefined;
      const what = busyWith ? `Running ${busyWith}` : r.custom.join(' · ');
      const detail = [what, r.org ? `Shared by ${r.org}` : ''].filter(Boolean).join(' · ');
      return {
        id: r.id.slice(0, 200),
        title: r.name,
        ...(detail ? { detail: clip(detail, 300) } : {}),
        tone: r.gone ? 'info' : r.online ? 'ok' : 'bad',
        right: r.gone ? 'Between jobs' : !r.online ? 'Offline' : r.busy ? 'Busy' : 'Idle',
      };
    });
}

function runnerCounts(runners: readonly ActionsRunner[]) {
  const counted = watched(runners);
  return {
    online: counted.filter((r) => r.online).length,
    busy: counted.filter((r) => r.busy).length,
    total: counted.length,
  };
}

/** Whether a run started on the burrow's day of `now`. */
const startedToday = (now: Date, timeZone: string) => {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  return (r: { createdAt: Date }) => day(r.createdAt) === day(now);
};

/** Today's runs: how many (“7+” when the read may not reach back to midnight), passed and failed. */
function runsToday(input: ActionsInput) {
  const { snapshot: s, now, timeZone } = input;
  const today = startedToday(now, timeZone);
  const done = s.recent.filter(today);
  const all = done.length + s.active.filter(today).length;
  const more = !!s.seenSince && today({ createdAt: s.seenSince });
  const passed = done.filter((r) => r.state === 'passed').length;
  const failed = done.filter((r) => r.state === 'failed').length;
  return {
    value: `${all}${more ? '+' : ''}`,
    one: all === 1 && !more,
    failed,
    sub: all
      ? [`${passed} passed`, failed ? `${failed} failed` : ''].filter(Boolean).join(' · ')
      : 'Nothing ran yet',
  };
}

function figures(input: ActionsInput): ThingPageKpi[] {
  const { snapshot: s } = input;
  const running = s.active.filter((a) => a.state === 'running').length;
  const waiting = s.active.length - running;
  const out: ThingPageKpi[] = [
    {
      key: 'running',
      label: 'Running',
      value: String(running),
      sub: waiting ? `${waiting} waiting` : 'Nothing waits',
    },
  ];
  if (s.latest.length) {
    const failing = s.latest.filter((r) => r.state === 'failed').length;
    out.push({
      key: 'failing',
      label: 'Failing',
      value: String(failing),
      sub: `of ${plural(s.latest.length, 'workflow')} on ${branchWords(s)}`,
      ...(failing ? { tone: 'warn' as const } : {}),
    });
  }
  if (s.runners?.length) {
    const { online, busy, total } = runnerCounts(s.runners);
    if (total)
      out.push({
        key: 'runners',
        label: 'Runners',
        value: `${online} of ${total}`,
        sub: busy ? `online · ${busy} busy` : 'online',
        ...(online === 0 ? { tone: 'bad' as const } : online < total ? { tone: 'warn' as const } : {}),
      });
  }
  const today = runsToday(input);
  out.push({
    key: 'today',
    label: 'Today',
    value: today.value,
    rest: today.one ? 'run' : 'runs',
    sub: today.sub,
  });
  return out;
}

/** What Whombat watches. */
export const ACTIONS_CHECK_LIST: KindCheck[] = [
  {
    check: ACTIONS_CHECKS.failing,
    name: 'Workflows failing on a default branch',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: ACTIONS_CHECKS.runner,
    name: 'Runners going offline',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: ACTIONS_CHECKS.waiting,
    name: 'Jobs waiting long for a runner',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
];

/** The checks this read couldn't see whole: a repository's runs didn't answer; no runners' list. */
export function actionsSkipped(s: ActionsSnapshot): string[] {
  const out: string[] = [];
  if (s.missed.length) out.push(ACTIONS_CHECKS.failing, ACTIONS_CHECKS.waiting);
  if (!s.runners) out.push(ACTIONS_CHECKS.runner);
  return out;
}

export interface Waiting {
  run: ActiveRun;
  /** The job (null: the run's jobs weren't read), since when, its labels. */
  job: ActionsJob | null;
  since: Date;
  /** `nobody`: no runner online has its labels; `busy`: those that could are busy; `github`: GitHub's own runners. */
  why: 'nobody' | 'busy' | 'github' | 'unknown';
}

/** The jobs that have waited too long for a runner, the longest first. */
export function waitingTooLong(s: ActionsSnapshot, now: Date): Waiting[] {
  const out: Waiting[] = [];
  for (const run of s.active) {
    if (run.state === 'waiting') continue;
    const jobs = run.jobs?.filter((j) => j.state === 'queued');
    const each: (ActionsJob | null)[] = jobs ? jobs : run.state === 'queued' ? [null] : [];
    for (const job of each) {
      const since = job?.queuedAt ?? run.createdAt;
      const waited = now.getTime() - since.getTime();
      const labels = job?.labels ?? [];
      let why: Waiting['why'];
      if (!job) why = 'unknown';
      else if (!selfHosted(labels)) why = 'github';
      else if (!s.runners) why = 'unknown';
      else why = s.runners.some((r) => r.online && !r.paused && canTake(r, labels)) ? 'busy' : 'nobody';
      if (waited >= (why === 'nobody' ? WAIT_NOBODY_MS : WAIT_LONG_MS)) out.push({ run, job, since, why });
    }
  }
  return out.sort((x, y) => x.since.getTime() - y.since.getTime());
}

function waitingDetail(w: Waiting, now: Date): string {
  const waited = `It has waited ${span(now.getTime() - w.since.getTime())}`;
  const labels = ownLabels(w.job?.labels ?? []);
  switch (w.why) {
    case 'nobody':
      return labels.length
        ? `${waited} and no runner that’s online has the labels ${labels.join(', ')}.`
        : `${waited} and no runner that can take it is online.`;
    case 'busy':
      return `${waited}: every runner that can take it is busy.`;
    case 'github':
      return `${waited} for one of GitHub’s own runners.`;
    default:
      return `${waited}.`;
  }
}

/**
 * Worth a look: each workflow failing on a default branch (until it passes), each runner offline, each job that has
 * waited too long for a runner — red when nothing online can take it, after two reads in a row.
 */
export function actionsNotices(input: ActionsInput): KindNotice[] {
  const { snapshot: s, now } = input;
  const failing = itemLines(
    s.latest.filter((r) => r.state === 'failed'),
    (r) => {
      const where = many(s) ? `${shortName(r.repo)}’s ${r.branch}` : r.branch;
      const title = clip(`${r.workflow} is failing on ${where}`, 120);
      return {
        id: clip(`failing-${r.repo}/${r.workflowId}`, 120),
        tone: 'warn',
        icon: 'warn',
        title,
        detail: clip(
          `Its last run failed ${span(now.getTime() - (r.endedAt ?? r.createdAt).getTime())} ago${r.title ? `: ${r.title}` : ''}.`,
          200,
        ),
        ...(r.url ? { link: { kind: 'url' as const, label: 'Show it', url: r.url } } : {}),
        nature: 'problem',
        check: ACTIONS_CHECKS.failing,
        subject: { id: `workflow:${r.repo}/${r.workflowId}`.slice(0, 160), name: clip(r.workflow, 80) },
        ignore: fixed('Until it passes.'),
        ...shortBadge(title, `${r.workflow} is failing`),
      };
    },
    (r) => `${r.repo}/${r.workflowId}`,
    (rest) => ({
      id: 'failing-more',
      tone: 'warn',
      icon: 'warn',
      title: `${plural(rest.length, 'more workflow')} failing`,
      nature: 'problem',
      check: ACTIONS_CHECKS.failing,
    }),
  );
  const late = waitingTooLong(s, now);
  const waiting = itemLines(
    late,
    (w) => {
      const title = clip(`${w.run.workflow} is waiting for a runner`, 120);
      return {
        id: clip(`waiting-${w.run.id}/${w.job?.id ?? 'run'}`, 120),
        tone: w.why === 'nobody' ? 'bad' : 'warn',
        icon: 'clock',
        title,
        detail: clip(waitingDetail(w, now), 200),
        link: lookInto(`Why is ${w.run.workflow} waiting for a runner?`),
        nature: 'problem',
        check: ACTIONS_CHECKS.waiting,
        subject: {
          id: `job:${w.run.id}/${w.job?.id ?? 'run'}`.slice(0, 160),
          name: clip(
            w.job && w.job.name !== w.run.workflow ? `${w.run.workflow} · ${w.job.name}` : w.run.workflow,
            80,
          ),
        },
        ignore: fixed('Until it starts.'),
        confirm: 2,
        ...shortBadge(title, 'A job waits for a runner'),
      };
    },
    (w) => `${w.run.id}/${w.job?.id ?? 'run'}`,
    (rest) => ({
      id: 'waiting-more',
      tone: rest.some((w) => w.why === 'nobody') ? 'bad' : 'warn',
      icon: 'clock',
      title: `${plural(rest.length, 'more job')} waiting for a runner`,
      nature: 'problem',
      check: ACTIONS_CHECKS.waiting,
      confirm: 2,
    }),
  );
  return [...waiting, ...failing, ...runnerLines(s.runners ?? [], NAME)];
}

/** “1 running · 1 waiting”, “2 waiting”; nothing while nothing runs (the panel says so itself). */
function runningWords(s: ActionsSnapshot): string | undefined {
  const running = s.active.filter((a) => a.state === 'running').length;
  const waiting = s.active.length - running;
  return (
    [running ? `${running} running` : '', waiting ? `${waiting} waiting` : ''].filter(Boolean).join(' · ') ||
    undefined
  );
}

/** Running now (Live): each run with its bar and the time it has left, what waits for a runner. */
function runningLive(input: ActionsInput) {
  const meta = runningWords(input.snapshot);
  return liveRows({
    id: 'running',
    title: 'Running now',
    // Runs have no pictures: the row's square says the workflow's first letter.
    shape: 'square',
    ...(meta ? { meta } : {}),
    items: runningItems(input),
    empty: 'Nothing is running.',
  });
}

/** Builds (Inventory): the workflows on the default branch and how many fail, today's runs, the runners, the repositories. */
export function actionsCounts(input: ActionsInput) {
  const { snapshot: s } = input;
  const lines: ThingPageItem[] = [];
  if (s.latest.length) {
    const failing = s.latest.filter((r) => r.state === 'failed').length;
    lines.push(
      countLine({
        id: 'workflows',
        icon: 'log',
        title: 'Workflows',
        detail: `Last result on ${branchWords(s)}`,
        value: String(s.latest.length),
        ...(failing
          ? { note: `${failing} failing`, noteTone: 'bad' as const }
          : { note: 'All pass', noteTone: 'ok' as const }),
      }),
    );
  }
  const today = runsToday(input);
  lines.push(
    countLine({
      id: 'today',
      icon: 'clock',
      title: 'Runs today',
      figureKey: 'f-runs-today',
      value: today.value,
      note: today.sub,
      ...(today.failed ? { noteTone: 'warn' as const } : {}),
    }),
  );
  if (s.runners?.length) {
    const { online, busy, total } = runnerCounts(s.runners);
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
  if (many(s) || s.unseen.length)
    lines.push(
      countLine({
        id: 'repositories',
        icon: 'database',
        title: 'Repositories',
        value: String(s.repos.length),
        ...(s.unseen.length
          ? { detail: `The token can’t see ${s.unseen.length}`, tone: 'warn' as const }
          : { detail: 'Watched' }),
      }),
    );
  return inventory({ id: 'counts', title: 'Builds', items: lines });
}

/** This week (Trend): the runs on every branch per day, how many failed, and the change on the week before. */
export function actionsWeek(input: ActionsInput) {
  const { snapshot: s, now, timeZone } = input;
  if (!s.history) return null;
  const w = weekCounts(s.history.runs, now, timeZone, s.history.since);
  if (w.values.filter((v) => v !== null).length < 2) return null;
  const chart = trend({
    id: 'week',
    title: 'This week',
    meta: 'Runs per day, every branch',
    days: w.days,
    values: w.values,
    label: 'Runs',
    figure: { value: thousands(w.total), rest: w.total === 1 ? 'run this week' : 'runs this week' },
    change: w.change,
    color: 'blue',
  });
  return w.failed ? withStat(chart, [{ text: String(w.failed), strong: true }, { text: ' failed' }]) : chart;
}

/** Each workflow's last results, the latest runs and the runners: below the slots. */
function actionsMore(input: ActionsInput): ThingPagePanel[] {
  const { snapshot: s } = input;
  const branch = branchWords(s);
  const panels: ThingPagePanel[] = [];
  if (s.latest.length || s.repos.length) {
    const retry = !!input.button && s.latest.some((r) => r.state === 'failed');
    panels.push({
      kind: 'table',
      id: 'latest',
      title: clip(`Last runs on ${branch}`, 60),
      meta: [
        plural(s.latest.length, 'workflow'),
        many(s) ? plural(s.repos.length, 'repository', 'repositories') : '',
      ]
        .filter(Boolean)
        .join(' · '),
      columns: [
        { key: 'workflow', label: 'Workflow' },
        { key: 'result', label: 'Result' },
        { key: 'when', label: 'When' },
        { key: 'took', label: 'Took', numeric: true },
        ...(retry ? [{ key: 'retry', label: '' }] : []),
      ],
      rows: latestRows(input),
      empty: `Nothing ran on ${branch} in the last ${RESULT_DAYS} days.`,
    });
  }
  if (s.recent.length)
    panels.push({
      kind: 'table',
      id: 'recent',
      title: 'Recent runs',
      meta: 'Every branch',
      columns: [
        { key: 'workflow', label: 'Workflow' },
        { key: 'event', label: 'Event' },
        { key: 'result', label: 'Result' },
        { key: 'when', label: 'When' },
        { key: 'took', label: 'Took', numeric: true },
      ],
      rows: recentRows(input),
    });
  if (s.runners?.length) {
    const { online, busy, total } = runnerCounts(s.runners);
    panels.push({
      kind: 'list',
      id: 'runners',
      title: 'Runners',
      meta: [`${online} of ${total} online`, busy ? `${busy} busy` : ''].filter(Boolean).join(' · '),
      items: runnerItems(s),
    });
  }
  return panels;
}

/**
 * The page (pure), its Summary in slots (docs/service-pages.md): what runs now beside the counts, this week's runs;
 * the last results on the default branch (with Retry), the latest runs and the runners below. No machine card: it runs
 * at GitHub.
 */
export function actionsView(input: ActionsInput): KindView {
  const { snapshot: s } = input;
  const notices = actionsNotices(input);
  const branch = branchWords(s);
  const facts: ThingLine[] = [];
  const only = s.repos.length === 1 ? s.repos[0] : undefined;
  if (only) facts.push(line(`Watching **${only.fullName}**`));
  else if (s.repos.length)
    facts.push(line(`Watching **${plural(s.repos.length, 'repository', 'repositories')}**`));
  for (const name of s.unseen.slice(0, 3)) facts.push(line(`The token can’t see **${name}**`));
  for (const name of s.missed.slice(0, 3)) facts.push(line(`**${name}**’s runs didn’t answer`));
  if (!s.runners && s.repos.length)
    facts.push(line('Give the token **Administration** read access to see the runners'));
  return {
    // In slots its figures are in Running now and Builds; the card keeps them (`actionsCardView`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices,
    ...slotPanels({
      live: runningLive(input),
      inventory: actionsCounts(input),
      trend: actionsWeek(input),
      more: actionsMore(input),
    }),
    tabs: [],
    facts,
    status: statusFrom(notices, s.latest.length ? `All pass on ${branch}` : 'Watching'),
    open: only?.url
      ? { label: 'Open in GitHub', url: `${only.url.replace(/\/+$/, '')}/actions` }
      : { label: 'Open GitHub', url: HOME },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Why did the last run fail?', 'Slowest workflows this week', 'Which runner is busiest?'],
  };
}

/** The page's part as the card reads it: the card keeps Running and Failing. */
export function actionsCardView(input: ActionsInput): KindView {
  return { ...actionsView(input), kpis: figures(input) };
}

/* The page and Retry ------------------------------------------------------------------------------------------------ */

async function actionsPage(ctx: KindCtx): Promise<KindView> {
  const read = await actionsLatest(ctx.services, ctx.row, ctx.now);
  return viewOrProblem(read, NAME, { label: 'Open GitHub', url: HOME }, (snapshot) =>
    actionsView({ snapshot, now: ctx.now, timeZone: ctx.timeZone, button: buttonsFor(ctx) }),
  );
}

/** **Retry** on a workflow failing on a default branch: its failed jobs again (the token needs Actions write). */
const retryAction: KindAction = async (ctx, input) => {
  const target = typeof input.target === 'string' ? input.target : '';
  const snapshot = await snapshotOf(ctx.services, ctx.row, ctx.now);
  const run = snapshot.latest.find((r) => r.id === target && r.state === 'failed');
  if (!run) throw stale(NAME);
  try {
    await actAs(ctx.services, ctx.row, NAME, {
      method: 'POST',
      path: `/repos/${repoPath(run.repo)}/actions/runs/${encodeURIComponent(run.runId)}/rerun-failed-jobs`,
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'forbidden' && err.message.startsWith(`${NAME} refused`))
      throw forbidden(
        'GitHub refused: the token may only look. Give it Actions read and write access to re-run from here.',
      );
    throw err;
  }
  bumpGeneration(ctx.row.id);
  return {
    message: `Running ${run.workflow}’s failed jobs again.`,
    title: `Re-ran ${run.workflow}’s failed jobs on ${run.branch}`.slice(0, 200),
  };
};

export const GITHUB_ACTIONS_KIND: KindModule = {
  page: actionsPage,
  prefetch: (services, row, now) => actionsLatest(services, row, now),
  async seen(services, row, now, timeZone) {
    const snapshot = await snapshotOf(services, row, now);
    return seenOfView(
      actionsCardView({ snapshot, now, timeZone }),
      ['running', 'failing'],
      undefined,
      actionsSkipped(snapshot),
    );
  },
  checks: ACTIONS_CHECK_LIST,
  asksFirst: 'cancelling a run and deleting ask first',
  actions: { retry: retryAction },
};
