/**
 * T3 Code's page (docs/decisions/t3code.md T3-10…T3-13): one computer's coding agents. What works now and for how
 * long, with **Stop**; what waits for the person — a question, answered here with one tap when it is one choice among a
 * few, or a permission request, which only T3 Code can approve; the latest threads; the AI programs, ready or what
 * stops them; the projects with their open threads; the scheduled tasks. Worth a look: Whombat's sign-in there ending
 * soon, an AI program in use that can't run, a thread waiting for the person, a thread that failed.
 *
 * Read through T3 Code's own MCP server for outside agents, with the connection's sign-in, and kept a minute: the
 * computer's name and version (15 minutes), the AI programs (5 minutes), the projects, the threads at work and the
 * latest threads across every project, and for each project with a thread at work and the others worked in last (eight
 * in all, more when more are at work) their threads at work and their latest thirty (how many are open, 5 minutes); the
 * latest items of up to six threads at work, the questions of up to four that wait for an answer, and the scheduled
 * tasks. A T3 Code that can't list across projects has its projects read in the order they were changed.
 */
import {
  catalogEntry,
  resolveMcpUrl,
  type ThingGalleryItem,
  type ThingLine,
  type ThingPageBar,
  type ThingPageItem,
  type ThingPageKpi,
  type ThingPagePanel,
  type ThingPageRow,
} from '@whombat/core';
import { externalEffect } from '../../../commit/scope';
import { ConnectionChangedError } from '../../../connections/call-target';
import { connectionsFor } from '../../../connections/pool';
import type { CatalogConnectionRow } from '../../../connections/types';
import { ApiError, conflict, forbidden } from '../../../lib/errors';
import type { Services } from '../../../services';
import { VaultCallError } from '../../../vault/net';
import type { KindCheck } from '../../quiet/types';
import {
  cap,
  clip,
  dateWords,
  dayMonth,
  line,
  list,
  plural,
  rec,
  span,
  str,
  thousands,
  when,
} from '../../words';
import { cachedRead, latestRead, problemOf, ReadProblem } from '../read';
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
  quoted,
  rarelyRead,
  seenOfView,
  shortBadge,
  stale,
  statusFrom,
  todayStart,
  viewOrProblem,
  webUrl,
} from './common';
import { weekCounts, withStat } from './week';

const NAME = 'T3 Code';
const MIN = 60_000;
const DAY = 86_400_000;

/** Kept a minute: what works and what waits moves on quickly. */
export const T3_CACHE_MS = MIN;
/** The AI programs change when someone signs one in or switches it on. */
export const PROGRAMS_KEEP_MS = 5 * MIN;
/** How many threads are open changes slowly, and the page's own lists show what moves. */
export const OPEN_KEEP_MS = 5 * MIN;
/** The projects whose threads are read: every one with a thread at work, then the ones worked in last. */
export const PROJECTS_MAX = 8;
/** Threads at work listed across every project, and the latest threads that say which projects were worked in last. */
export const ACROSS_ACTIVE = 50;
export const ACROSS_RECENT = 100;
/** Each project's latest threads read: enough for a week of finished ones in most projects. */
export const RECENT_PAGE = 30;
/** Threads at work whose latest items are read (how long, what they wait for), and those whose questions are. */
export const READS_MAX = 6;
export const ASKS_MAX = 4;
/** A thread's latest items read: a waiting question or permission request is among them. */
const ITEMS_READ = 4;
/** An AI program counts as in use while a thread used it this recently. */
export const IN_USE_DAYS = 30;
/** Whombat's sign-in there is said to end this long before it does. */
export const SIGNIN_WARN_DAYS = 5;
/** A thread that failed is worth a look this long. */
export const FAILED_WITHIN_MS = DAY;
const CALLS_AT_ONCE = 4;
const ROWS = 10;

/** What Worth a look raises. */
export const T3_CHECKS = {
  signin: 't3code.signin_ends',
  program: 't3code.program_cant_run',
  waiting: 't3code.thread_waiting',
  failed: 't3code.thread_failed',
} as const;

/* What is read -------------------------------------------------------------------------------------------------------- */

export const T3_STATUSES = [
  'idle',
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
] as const;
export type T3Status = (typeof T3_STATUSES)[number];

/** A thread at work: `waiting` is a finished turn whose after-work still runs, not a thread waiting for the person. */
export const AT_WORK: readonly T3Status[] = ['preparing', 'queued', 'starting', 'running', 'waiting'];
export const FINISHED: readonly T3Status[] = [
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
];
/** What Stop can interrupt: a turn under way. */
const STOPPABLE: readonly T3Status[] = ['preparing', 'starting', 'running'];

export interface T3Environment {
  id: string | null;
  /** The computer's name in T3 Code (“thetitan”). */
  name: string | null;
  version: string | null;
  os: string | null;
}

export interface T3Project {
  id: string;
  title: string;
  updatedAt: Date | null;
}

export interface T3Thread {
  id: string;
  projectId: string;
  title: string;
  status: T3Status;
  /** The AI program's instance (`claudeAgent`, `codex`) and the model's id. */
  program: string | null;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
  settled: boolean;
  /** Another thread's helper: Stop is for the threads people start. */
  child: boolean;
  /** Its timeline's length, to read its latest items. */
  items: number;
}

/** What a thread at work is doing, from its latest items. */
export interface T3Activity {
  /** Questions and permission requests it waits on. */
  pending: number;
  /** When its turn started. */
  startedAt: Date | null;
  /** A question waits for an answer. */
  asks: boolean;
  /** What a waiting permission request is about, as T3 Code says it (a file, a command). */
  approval: string | null;
  /** Since when it waits for the person. */
  waitingSince: Date | null;
}

export interface T3Option {
  label: string;
  description: string | null;
}

export interface T3Question {
  id: string;
  question: string;
  options: T3Option[];
  multiSelect: boolean;
}

/** A question request of a thread: its id (long, never shown) and its questions. */
export interface T3Request {
  threadId: string;
  requestId: string;
  questions: T3Question[];
}

export interface T3Program {
  id: string;
  name: string;
  /** Switched on in T3 Code. */
  on: boolean;
  models: { id: string; label: string }[];
  /** Models T3 Code didn't list. */
  more: number;
  /** What stops it, in T3 Code's words; empty when it can run. */
  problems: string[];
}

export type T3Schedule =
  | { type: 'interval'; everyMs: number }
  | { type: 'fixed_time'; time: string; weekdays: number[] | null }
  | { type: 'webhook' };

export interface T3Task {
  id: string;
  title: string;
  enabled: boolean;
  schedule: T3Schedule | null;
  nextRunAt: Date | null;
  last: 'never' | 'running' | 'succeeded' | 'failed' | null;
}

export interface T3Snapshot {
  readAt: Date;
  environment: T3Environment;
  /** Null when T3 Code didn't say. */
  programs: T3Program[] | null;
  /** The projects read (the eight changed last), and how many there are. */
  projects: T3Project[];
  projectCount: number;
  /** Per project read: how many of its threads are open (not settled); absent when that wasn't read. */
  open: ReadonlyMap<string, number>;
  /** Projects whose threads didn't answer. */
  missed: string[];
  /** Every thread read, each once, the latest first. */
  threads: T3Thread[];
  /** Threads before this may not have been read (a project's page of threads was full). */
  seenSince: Date | null;
  /** Per thread at work that was read. */
  activity: ReadonlyMap<string, T3Activity>;
  /** The questions read, per thread that asks. */
  requests: T3Request[];
  /** Null when they couldn't be read. */
  tasks: T3Task[] | null;
}

const dateOf = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
};

const present = <T>(x: T | null): x is T => x !== null;

export const statusOf = (v: unknown): T3Status | null => {
  const s = str(v);
  return s && (T3_STATUSES as readonly string[]).includes(s) ? (s as T3Status) : null;
};

export function environmentOf(body: unknown): T3Environment {
  const r = rec(body);
  return {
    id: str(r.environmentId)?.slice(0, 120) ?? null,
    name: str(r.label)?.slice(0, 60) ?? null,
    version: str(r.serverVersion)?.slice(0, 40) ?? null,
    os: str(rec(r.platform).os)?.slice(0, 20) ?? null,
  };
}

/** The projects that aren't deleted, in T3 Code's order. */
export function projectsOf(body: unknown): T3Project[] {
  return list(rec(body).projects)
    .map((raw): T3Project | null => {
      const p = rec(raw);
      const id = str(p.id);
      if (!id || p.deletedAt) return null;
      return {
        id: id.slice(0, 200),
        title: (str(p.title) ?? 'A project').slice(0, 80),
        updatedAt: dateOf(p.updatedAt),
      };
    })
    .filter(present);
}

/**
 * The projects whose threads are read: every project with a thread at work, then the ones whose threads changed last,
 * eight in all unless more are at work. A project's own `updatedAt` is when its settings changed, not when someone
 * worked in it, so it only orders projects no listed thread speaks for.
 */
export function projectsToRead(
  projects: readonly T3Project[],
  threads: readonly Pick<T3Thread, 'projectId' | 'status' | 'updatedAt'>[] = [],
): T3Project[] {
  const busy = new Set(threads.filter(atWork).map((t) => t.projectId));
  const worked = new Map<string, number>();
  for (const t of threads)
    worked.set(t.projectId, Math.max(worked.get(t.projectId) ?? 0, t.updatedAt.getTime()));
  const ranked = [...projects].sort(
    (a, b) =>
      Number(busy.has(b.id)) - Number(busy.has(a.id)) ||
      Number(worked.has(b.id)) - Number(worked.has(a.id)) ||
      (worked.get(b.id) ?? 0) - (worked.get(a.id) ?? 0) ||
      (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
  );
  const atWorkIn = ranked.filter((p) => busy.has(p.id)).length;
  return ranked.slice(0, Math.max(PROJECTS_MAX, atWorkIn));
}

export function threadsOf(body: unknown): T3Thread[] {
  const r = rec(body);
  const project = str(r.projectId);
  return list(r.threads)
    .map((raw): T3Thread | null => {
      const t = rec(raw);
      const id = str(t.threadId);
      const status = statusOf(t.status);
      const createdAt = dateOf(t.createdAt);
      const projectId = str(t.projectId) ?? project;
      if (!id || !status || !createdAt || !projectId) return null;
      return {
        id: id.slice(0, 200),
        projectId: projectId.slice(0, 200),
        title: (str(t.title) ?? 'A thread').slice(0, 160),
        status,
        program: str(t.providerInstanceId)?.slice(0, 80) ?? null,
        model: str(t.model)?.slice(0, 120) ?? null,
        createdAt,
        updatedAt: dateOf(t.updatedAt) ?? createdAt,
        settled: t.settled === true,
        child: str(t.parentThreadId) !== null,
        items: typeof t.itemCount === 'number' && t.itemCount > 0 ? Math.floor(t.itemCount) : 0,
      };
    })
    .filter(present);
}

/** A list's `total`: how many threads match it. */
export function totalOf(body: unknown): number | null {
  const n = rec(body).total;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

const atWork = (t: Pick<T3Thread, 'status'>) => AT_WORK.includes(t.status);

/** The threads at work whose latest items are read: those running first, the one quiet longest first (it may wait). */
export function threadsToRead(threads: readonly T3Thread[]): T3Thread[] {
  return threads
    .filter(atWork)
    .sort(
      (a, b) =>
        Number(b.status === 'running') - Number(a.status === 'running') ||
        a.updatedAt.getTime() - b.updatedAt.getTime(),
    )
    .slice(0, READS_MAX);
}

/** `t3_thread_read`'s arguments for a thread's latest items. */
export function readArgs(t: Pick<T3Thread, 'id' | 'items'>): Record<string, unknown> {
  return {
    threadId: t.id,
    view: 'activity',
    limit: ITEMS_READ,
    runLimit: 1,
    maxCharsPerItem: 300,
    // Items are numbered from 0; this reads the last few.
    ...(t.items > ITEMS_READ ? { afterPosition: t.items - ITEMS_READ - 1 } : {}),
  };
}

export function activityOf(body: unknown): T3Activity | null {
  const r = rec(body);
  const thread = rec(r.thread);
  if (!str(thread.threadId)) return null;
  const pending =
    typeof thread.pendingRequestCount === 'number' ? Math.max(0, thread.pendingRequestCount) : 0;
  const run = rec(list(r.recentRuns)[0]);
  const waiting = list(r.items)
    .map(rec)
    .filter((i) => str(i.status) === 'waiting');
  const ask = waiting.find((i) => str(i.type) === 'user_input_request');
  const approval = waiting.find((i) => str(i.type) === 'approval_request');
  const since = [ask, approval]
    .map((i) => (i ? dateOf(i.updatedAt) : null))
    .filter(present)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return {
    pending,
    startedAt: dateOf(run.startedAt) ?? dateOf(run.requestedAt),
    asks: !!ask,
    approval: approval ? (str(approval.text)?.split('\n')[0]?.slice(0, 120) ?? null) : null,
    waitingSince: since ?? null,
  };
}

/** Threads that wait for an answer to a question, whose questions are read: the longest waiting first. */
export function threadsToAsk(
  threads: readonly T3Thread[],
  activity: ReadonlyMap<string, T3Activity>,
): T3Thread[] {
  return threads
    .filter((t) => {
      const a = activity.get(t.id);
      // A permission request is counted but never listed as a question: only T3 Code can approve it.
      return !!a && a.pending > 0 && (a.asks || a.pending > (a.approval ? 1 : 0));
    })
    .sort(
      (a, b) =>
        (activity.get(a.id)?.waitingSince?.getTime() ?? 0) -
        (activity.get(b.id)?.waitingSince?.getTime() ?? 0),
    )
    .slice(0, ASKS_MAX);
}

/** A thread's waiting questions' ids (each about 400 characters). */
export function requestIdsOf(body: unknown): string[] {
  return list(rec(body).requestIds)
    .map(str)
    .filter((s): s is string => s !== null && s.length <= 2000);
}

export function requestOf(body: unknown, threadId: string): T3Request | null {
  const r = rec(body);
  const requestId = str(r.requestId);
  if (!requestId) return null;
  const questions = list(r.questions)
    .map((raw): T3Question | null => {
      const q = rec(raw);
      const id = str(q.id);
      const question = str(q.question) ?? str(q.header);
      if (!id || !question) return null;
      return {
        id,
        question: question.slice(0, 300),
        options: list(q.options)
          .map(rec)
          .map((o) => ({ label: str(o.label) ?? '', description: str(o.description)?.slice(0, 200) ?? null }))
          .filter((o) => o.label),
        multiSelect: q.multiSelect === true,
      };
    })
    .filter(present);
  return questions.length ? { threadId, requestId, questions } : null;
}

const DISABLED = 'Provider instance is disabled.';

export function programsOf(body: unknown): T3Program[] {
  return list(rec(body).providers)
    .map((raw): T3Program | null => {
      const p = rec(raw);
      const id = str(p.providerInstanceId);
      if (!id) return null;
      const constraints = list(p.constraints)
        .map(str)
        .filter((s): s is string => s !== null)
        .map((s) => s.slice(0, 300));
      const models = list(p.models)
        .map(rec)
        .map((m) => {
          const mid = str(m.id);
          return mid ? { id: mid.slice(0, 120), label: (str(m.label) ?? mid).slice(0, 80) } : null;
        })
        .filter(present);
      return {
        id: id.slice(0, 80),
        name: (str(p.displayName) ?? id).slice(0, 60),
        on: !constraints.includes(DISABLED),
        models,
        more: typeof p.omittedModels === 'number' && p.omittedModels > 0 ? Math.floor(p.omittedModels) : 0,
        problems: constraints.filter((c) => c !== DISABLED),
      };
    })
    .filter(present);
}

function scheduleOf(v: unknown): T3Schedule | null {
  const s = rec(v);
  switch (str(s.type)) {
    case 'interval':
      return typeof s.everyMs === 'number' && s.everyMs > 0 ? { type: 'interval', everyMs: s.everyMs } : null;
    case 'fixed_time': {
      const time = str(s.timeOfDay);
      if (!time) return null;
      const days = list(s.weekdays).filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6);
      return { type: 'fixed_time', time: time.slice(0, 5), weekdays: days.length ? days : null };
    }
    case 'webhook':
      return { type: 'webhook' };
    default:
      return null;
  }
}

/** The scheduled tasks; their prompts and a webhook's address (it holds a secret) are never kept. */
export function tasksOf(body: unknown): T3Task[] {
  return list(rec(body).tasks)
    .map((raw): T3Task | null => {
      const t = rec(raw);
      const id = str(t.scheduledTaskId);
      if (!id) return null;
      const last = str(t.lastRunStatus);
      return {
        id: id.slice(0, 200),
        title: (str(t.title) ?? 'A task').slice(0, 120),
        enabled: t.enabled !== false,
        schedule: scheduleOf(t.schedule),
        nextRunAt: dateOf(t.nextRunAt),
        last:
          last === 'never' || last === 'running' || last === 'succeeded' || last === 'failed' ? last : null,
      };
    })
    .filter(present);
}

export interface T3Answers {
  environment: unknown;
  /** Null when they didn't answer. */
  capabilities: unknown;
  projects: unknown;
  /** The threads at work and the latest threads across every project (null: T3 Code didn't list them). */
  acrossActive?: unknown;
  acrossRecent?: unknown;
  /** Per project read: its threads at work, its latest threads and its open threads' list (null: didn't answer). */
  active: ReadonlyMap<string, unknown>;
  recent: ReadonlyMap<string, unknown>;
  open: ReadonlyMap<string, unknown>;
  /** Per thread at work read: its latest items. */
  reads: ReadonlyMap<string, unknown>;
  /** Per thread that asks: each of its questions read. */
  requests: ReadonlyMap<string, unknown[]>;
  tasks: unknown;
}

/** The snapshot from T3 Code's answers; pure. */
export function t3Snapshot(a: T3Answers, now: Date): T3Snapshot {
  const all = projectsOf(a.projects);
  const across = threadsOf(a.acrossActive);
  const projects = projectsToRead(all, [...across, ...threadsOf(a.acrossRecent)]);
  const seen = new Map<string, T3Thread>();
  const open = new Map<string, number>();
  const missed: string[] = [];
  let seenSince: Date | null = null;
  for (const p of projects) {
    const active = a.active.get(p.id);
    const recent = a.recent.get(p.id);
    if ((active === undefined || active === null) && (recent === undefined || recent === null)) {
      missed.push(p.title);
      continue;
    }
    const latest = threadsOf(recent);
    if (latest.length >= RECENT_PAGE) {
      const oldest = latest.reduce((m, t) => (t.updatedAt < m ? t.updatedAt : m), now);
      if (!seenSince || oldest > seenSince) seenSince = oldest;
    }
    for (const t of [...threadsOf(active), ...latest]) if (!seen.has(t.id)) seen.set(t.id, t);
    const n = totalOf(a.open.get(p.id));
    if (n !== null) open.set(p.id, n);
  }
  // What works is known even when its project's own lists didn't answer.
  const read = new Set(projects.map((p) => p.id));
  for (const t of across) if (read.has(t.projectId) && !seen.has(t.id)) seen.set(t.id, t);
  const activity = new Map<string, T3Activity>();
  for (const [id, body] of a.reads) {
    const read = activityOf(body);
    if (read) activity.set(id, read);
  }
  const requests: T3Request[] = [];
  for (const [threadId, bodies] of a.requests)
    for (const body of bodies) {
      const r = requestOf(body, threadId);
      if (r) requests.push(r);
    }
  return {
    readAt: now,
    environment: environmentOf(a.environment),
    programs: a.capabilities === null || a.capabilities === undefined ? null : programsOf(a.capabilities),
    projects,
    projectCount: all.length,
    open,
    missed,
    threads: [...seen.values()].sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime()),
    seenSince,
    activity,
    requests,
    tasks: a.tasks === null || a.tasks === undefined ? null : tasksOf(a.tasks),
  };
}

/* Calling T3 Code ----------------------------------------------------------------------------------------------------- */

/** T3 Code declined a call (`OrchestratorMcpFailure`): its code; its own words are only matched, never shown. */
export class T3Failure extends Error {
  override name = 'T3Failure';
  constructor(
    readonly code: string,
    readonly said: string,
  ) {
    super(`T3 Code declined: ${code}`);
  }
}

function failureOf(text: string): T3Failure {
  try {
    const body = rec(JSON.parse(text));
    return new T3Failure(str(body.code) ?? 'error', str(body.message) ?? '');
  } catch {
    return new T3Failure('error', '');
  }
}

/** Whombat's sign-in there was refused or ended (it lasts 30 days and isn't renewed). */
const signedOut = (err: unknown) =>
  err instanceof VaultCallError &&
  (err.status === 401 || err.status === 403 || err.message === 'needs_reauth');

const SIGNED_OUT = 'Whombat’s sign-in to T3 Code has ended. Sign in again with a new pairing code.';

/**
 * One tool call on the connection's MCP server: its JSON answer, or T3 Code's refusal as a `T3Failure`. A read
 * (`things.read`) may be made again; a button's call (`things.action`) is reported once and never resent. The watcher of
 * the threads the agent handed work to reads through it too (`t3code/watch.ts`).
 */
export async function callT3(
  services: Services,
  row: CatalogConnectionRow,
  tool: string,
  args: Record<string, unknown>,
  label: 'things.read' | 'things.action' = 'things.read',
): Promise<unknown> {
  const entry = catalogEntry(row.catalogId);
  const url = entry ? resolveMcpUrl(entry, row.fields, 'token') : null;
  if (!url) throw new ReadProblem(`${NAME} has no address Whombat can read.`);
  // A session T3 Code forgot when it restarted is opened again by the pool itself.
  const service = connectionsFor(services);
  const res = await externalEffect(
    label,
    () => service.pool.call(service.target(row, url), tool, args),
    label === 'things.read'
      ? { idempotent: true }
      : { refused: (err) => signedOut(err) || err instanceof ConnectionChangedError },
  );
  if (res.isError) throw failureOf(res.text);
  if (res.structured) return res.structured;
  try {
    return JSON.parse(res.text);
  } catch {
    throw new ReadProblem(
      res.truncated
        ? `${NAME} answered with more than Whombat reads.`
        : `${NAME} answered with something Whombat can’t read.`,
    );
  }
}

/** A read's failure in words for the page. */
function readProblem(err: unknown): ReadProblem {
  if (err instanceof ReadProblem) return err;
  if (signedOut(err)) return new ReadProblem(SIGNED_OUT, true);
  if (err instanceof T3Failure) return new ReadProblem(`${NAME} answered with an error.`);
  return problemOf(err, NAME);
}

/** `fn` over `items`, a few at a time, the answers in the items' order. */
async function inTurns<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CALLS_AT_ONCE, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

const settle = <T>(p: Promise<T>): Promise<{ body: T } | { error: unknown }> =>
  p.then(
    (body) => ({ body }),
    (error: unknown) => ({ error }),
  );

async function readT3(services: Services, row: CatalogConnectionRow, now: Date): Promise<T3Snapshot> {
  const call = (tool: string, args: Record<string, unknown> = {}) => callT3(services, row, tool, args);
  const generation = generationOf(row.id);
  try {
    const [environment, capabilities, projects, tasks, acrossActive, acrossRecent] = await Promise.all([
      optional(rarelyRead(services, `t3code-env:${row.id}`, row, () => call('t3_environment_read'))),
      optional(
        cachedRead(
          services,
          `t3code-programs:${row.id}`,
          row,
          () => call('orchestrator_capabilities'),
          PROGRAMS_KEEP_MS,
        ),
      ),
      call('t3_project_list', { limit: 100 }),
      optional(call('list_scheduled_tasks')),
      optional(call('t3_thread_list', { allProjects: true, statuses: AT_WORK, limit: ACROSS_ACTIVE })),
      optional(call('t3_thread_list', { allProjects: true, limit: ACROSS_RECENT })),
    ]);
    const chosen = projectsToRead(projectsOf(projects), [
      ...threadsOf(acrossActive),
      ...threadsOf(acrossRecent),
    ]);
    const lists = await inTurns(chosen, async (p) => {
      const [active, recent, open] = await Promise.all([
        settle(call('t3_thread_list', { projectId: p.id, statuses: AT_WORK, limit: 20 })),
        settle(call('t3_thread_list', { projectId: p.id, limit: RECENT_PAGE })),
        optional(
          cachedRead(
            services,
            `t3code-open:${row.id}:${generation}:${p.id}`,
            row,
            () => call('t3_thread_list', { projectId: p.id, settled: false, limit: 1 }),
            OPEN_KEEP_MS,
          ),
        ),
      ]);
      return { project: p, active, recent, open };
    });
    const failed = lists.flatMap((l) => ('error' in l.recent ? [l.recent.error] : []));
    if (chosen.length && failed.length === chosen.length) throw failed[0];
    const body = (s: { body: unknown } | { error: unknown }) => ('body' in s ? s.body : null);
    const read = new Set(chosen.map((p) => p.id));
    const threads = [
      ...threadsOf(acrossActive).filter((t) => read.has(t.projectId)),
      ...lists.flatMap((l) => [...threadsOf(body(l.active)), ...threadsOf(body(l.recent))]),
    ];
    const unique = [...new Map(threads.map((t) => [t.id, t])).values()];
    const toRead = threadsToRead(unique);
    const reads = await inTurns(toRead, (t) => optional(call('t3_thread_read', readArgs(t))));
    const activity = new Map<string, T3Activity>();
    toRead.forEach((t, i) => {
      const a = activityOf(reads[i]);
      if (a) activity.set(t.id, a);
    });
    const toAsk = threadsToAsk(toRead, activity);
    const asked = await inTurns(toAsk, async (t) => {
      const ids = requestIdsOf(
        await optional(call('t3_pending_request', { action: 'list', threadId: t.id })),
      );
      // A thread rarely asks more than one thing at a time; the page shows the first.
      return Promise.all(
        ids
          .slice(0, 2)
          .map((requestId) =>
            optional(call('t3_pending_request', { action: 'read', threadId: t.id, requestId })),
          ),
      );
    });
    return t3Snapshot(
      {
        environment,
        capabilities,
        projects,
        acrossActive,
        acrossRecent,
        active: new Map(lists.map((l) => [l.project.id, body(l.active)])),
        recent: new Map(lists.map((l) => [l.project.id, body(l.recent)])),
        open: new Map(lists.map((l) => [l.project.id, l.open])),
        reads: new Map(toRead.map((t, i) => [t.id, reads[i] ?? null])),
        requests: new Map(toAsk.map((t, i) => [t.id, (asked[i] ?? []).filter((b) => b !== null)])),
        tasks,
      },
      now,
    );
  } catch (err) {
    throw readProblem(err);
  }
}

const keyOf = (row: CatalogConnectionRow) => `t3code:${row.id}:${generationOf(row.id)}`;

const load = (services: Services, row: CatalogConnectionRow, now: Date) =>
  loader(NAME, () => readT3(services, row, now));

/** The page's read, kept a minute, read again after a button. */
export function t3Latest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, keyOf(row), row, load(services, row, now), { ttlMs: T3_CACHE_MS });
}

function snapshotOf(services: Services, row: CatalogConnectionRow, now: Date) {
  return cachedRead(services, keyOf(row), row, load(services, row, now), T3_CACHE_MS);
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface T3Input {
  snapshot: T3Snapshot;
  now: Date;
  timeZone: string;
  /** The address the person gave (`http://192.168.1.20:3773`): Open T3 Code, and each thread's own page there. */
  address: string;
  /** When Whombat's sign-in there ends (`access_expires_at`); null when that isn't known. */
  signedInUntil: Date | null;
  button?: MakeButton;
}

/** A thread's state in words. */
export const STATE: Record<T3Status, { text: string; dot: 'ok' | 'warn' | 'bad' | 'off' }> = {
  idle: { text: 'Idle', dot: 'off' },
  preparing: { text: 'Getting ready', dot: 'ok' },
  queued: { text: 'Queued', dot: 'off' },
  starting: { text: 'Starting', dot: 'ok' },
  running: { text: 'Working', dot: 'ok' },
  waiting: { text: 'Finishing up', dot: 'ok' },
  completed: { text: 'Done', dot: 'ok' },
  interrupted: { text: 'Stopped', dot: 'off' },
  failed: { text: 'Failed', dot: 'bad' },
  cancelled: { text: 'Cancelled', dot: 'off' },
  rolled_back: { text: 'Undone', dot: 'off' },
};
const WAITS = { text: 'Waiting for you', dot: 'warn' } as const;

const OS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows', windows: 'Windows' };

/** The programs' names when T3 Code didn't list them. */
const PROGRAM_NAMES: Record<string, string> = {
  claudeAgent: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

const base = (address: string) => address.replace(/\/+$/, '');

/** T3 Code's own page of a thread on that computer (its web app's `/<environment>/<thread>`), else its address. */
export function threadUrl(input: Pick<T3Input, 'snapshot' | 'address'>, threadId: string): string | null {
  const env = input.snapshot.environment.id;
  const url = env
    ? `${base(input.address)}/${encodeURIComponent(env)}/${encodeURIComponent(threadId)}`
    : input.address;
  return webUrl(url) ?? webUrl(input.address);
}

const programOf = (s: T3Snapshot, id: string | null) =>
  id ? s.programs?.find((p) => p.id === id) : undefined;

function programName(s: T3Snapshot, id: string | null): string {
  if (!id) return '—';
  return programOf(s, id)?.name ?? PROGRAM_NAMES[id] ?? id;
}

function modelName(s: T3Snapshot, t: Pick<T3Thread, 'program' | 'model'>): string | null {
  if (!t.model || t.model === 'default') return null;
  return programOf(s, t.program)?.models.find((m) => m.id === t.model)?.label ?? t.model;
}

const projectTitle = (s: T3Snapshot, id: string) => s.projects.find((p) => p.id === id)?.title ?? 'A project';

/** What a thread waits for: a question (its request), a permission request, or something T3 Code shows. */
export interface Waits {
  thread: T3Thread;
  kind: 'question' | 'permission' | 'other';
  request: T3Request | null;
  /** What the permission is for. */
  approval: string | null;
  since: Date;
}

/** The threads that wait for the person, the longest waiting first. */
export function waitingFor(s: T3Snapshot): Waits[] {
  return s.threads
    .flatMap((thread): Waits[] => {
      const a = s.activity.get(thread.id);
      if (!a || a.pending <= 0) return [];
      const request = s.requests.find((r) => r.threadId === thread.id) ?? null;
      const kind = request || a.asks ? 'question' : a.approval ? 'permission' : 'other';
      return [{ thread, kind, request, approval: a.approval, since: a.waitingSince ?? thread.updatedAt }];
    })
    .sort((x, y) => x.since.getTime() - y.since.getTime());
}

/** The threads at work that don't wait for the person, those running longest first. */
export function workingNow(s: T3Snapshot): T3Thread[] {
  const waits = new Set(waitingFor(s).map((w) => w.thread.id));
  const started = (t: T3Thread) => (s.activity.get(t.id)?.startedAt ?? t.createdAt).getTime();
  return s.threads.filter((t) => atWork(t) && !waits.has(t.id)).sort((a, b) => started(a) - started(b));
}

/**
 * The one question of a request when it can be answered with a tap: a single choice among two or three options, each
 * short enough to send as the button's value. Null otherwise (the person answers it in T3 Code).
 */
export function oneTap(request: T3Request | null): T3Question | null {
  const [q, ...more] = request?.questions ?? [];
  if (!q || more.length || q.multiSelect) return null;
  const labels = q.options.map((o) => o.label);
  if (labels.length < 2 || labels.length > 3 || new Set(labels).size !== labels.length) return null;
  return labels.every((l) => l.length <= 100) ? q : null;
}

/** “Blue, Green or Orange”. */
function orWords(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/** What a thread waits for, in words: its question with its choices, or what it asks permission for. */
function waitWords(w: Waits): string {
  const q = w.request?.questions[0];
  if (w.kind === 'question' && q) {
    const labels = q.options.map((o) => o.label);
    return oneTap(w.request) || !labels.length ? q.question : `${q.question} (${orWords(labels)})`;
  }
  if (w.kind === 'question') return 'It asks you something. Answer it in T3 Code.';
  if (w.kind === 'permission')
    return w.approval
      ? `It asks permission for ${w.approval}. Approve it in T3 Code.`
      : 'It asks your permission. Approve it in T3 Code.';
  return 'It waits for you in T3 Code.';
}

/**
 * Your coding agents (Live): first each thread waiting for the person — its project and what it waits for, a one-tap
 * question's options as buttons — then each thread at work with its project and model, how long it has worked and
 * Stop where it can stop. A thread's own page in T3 Code is its link.
 */
export function nowItems(input: T3Input): ThingGalleryItem[] {
  const { snapshot: s, now, button } = input;
  const waits = waitingFor(s).map((w): ThingGalleryItem => {
    const url = threadUrl(input, w.thread.id);
    const q = oneTap(w.request);
    const project = projectTitle(s, w.thread.projectId);
    // A question leads with itself, so its buttons answer what the row says; the thread's title is under it.
    const asks = w.kind === 'question' && !!w.request?.questions[0];
    const why =
      w.kind === 'permission'
        ? w.approval
          ? `Asks permission for ${w.approval}`
          : 'Asks your permission'
        : w.kind === 'question'
          ? 'Answer it in T3 Code'
          : 'Waits for you in T3 Code';
    return {
      id: w.thread.id.slice(0, 200),
      title: clip(asks ? waitWords(w) : w.thread.title, 120),
      sub: clip(`${project} · ${asks ? w.thread.title : why}`, 120),
      badge: { text: w.kind === 'permission' ? 'Permission' : 'Question', tone: 'warn' },
      noteEnd: clip(`Waiting ${span(now.getTime() - w.since.getTime())}`, 60),
      ...(url ? { url } : {}),
      ...(button && q
        ? {
            actions: q.options.map((o) =>
              button({ action: 'answer', target: w.thread.id, value: o.label, label: clip(o.label, 30) }),
            ),
          }
        : {}),
    };
  });
  const working = workingNow(s).map((t): ThingGalleryItem => {
    const url = threadUrl(input, t.id);
    const started = s.activity.get(t.id)?.startedAt ?? null;
    // The AI program and its model, once: “Claude Opus 5.5”, “Codex · gpt-6-astra”.
    const program = t.program ? programName(s, t.program) : '';
    const model = modelName(s, t);
    const runs = model?.toLowerCase().startsWith(program.toLowerCase()) ? model : [program, model ?? ''];
    const sub = [projectTitle(s, t.projectId), ...[runs].flat()].filter(Boolean).join(' · ');
    return {
      id: t.id.slice(0, 200),
      title: clip(t.title, 120),
      sub: clip(sub, 120),
      ...(started ? { note: clip(`For ${span(now.getTime() - started.getTime())}`, 80) } : {}),
      noteEnd: STATE[t.status].text,
      ...(url ? { url } : {}),
      ...(button && STOPPABLE.includes(t.status) && !t.child
        ? {
            actions: [
              button({
                action: 'stop',
                target: t.id,
                label: 'Stop',
                icon: 'stop',
                tone: 'danger',
                confirm: {
                  title: clip(`Stop ${quoted(t.title, 60)}?`, 80),
                  body: 'T3 Code stops what its agent is doing now. The thread stays, and you can carry on there.',
                  button: 'Stop',
                },
              }),
            ],
          }
        : {}),
    };
  });
  // Waiting threads lead, but never crowd out every thread at work: each half keeps at least half the rows.
  const shownWaits = waits.slice(0, Math.max(ROWS / 2, ROWS - working.length));
  return [...shownWaits, ...working].slice(0, ROWS);
}

/** Recent threads: the latest ten, their state in words, when. */
export function recentRows(input: T3Input): ThingPageRow[] {
  const { snapshot: s, now, timeZone } = input;
  const waits = new Set(waitingFor(s).map((w) => w.thread.id));
  return s.threads.slice(0, ROWS).map((t) => {
    const url = threadUrl(input, t.id);
    const state = waits.has(t.id) ? WAITS : STATE[t.status];
    return {
      id: t.id,
      cells: {
        thread: {
          text: clip(t.title, 200),
          note: clip(projectTitle(s, t.projectId), 80),
          ...(url ? { url } : {}),
        },
        state: { text: state.text, dot: state.dot },
        when: { text: when(t.updatedAt, now, timeZone) },
      },
    };
  });
}

/** What stops an AI program, in plain words, and what to do about it. */
export function programProblem(p: Pick<T3Program, 'problems'>): { words: string; detail: string } | null {
  const all = p.problems;
  if (!all.length) return null;
  const has = (re: RegExp) => all.some((c) => re.test(c));
  // T3 Code's own sentences say what; a program's own message (first) often says what to run.
  const own = all.find((c) => !/^Provider |^No V2 provider adapter/.test(c))?.replace(/`/g, '');
  if (has(/not authenticated|not signed in|log ?in/i))
    return {
      words: 'Not signed in',
      detail: own ?? 'Sign in to it on that computer, then T3 Code can use it.',
    };
  if (has(/not installed|not found|command not found/i))
    return {
      words: 'Not installed',
      detail: own ?? 'Install it on that computer, or switch it off in T3 Code.',
    };
  if (has(/No V2 provider adapter/))
    return {
      words: 'T3 Code can’t run it',
      detail: 'This version of T3 Code can’t run it yet. Updating T3 Code may help.',
    };
  return {
    words: 'Doesn’t start',
    detail: own ?? 'T3 Code can’t start it. Its settings in T3 Code say why.',
  };
}

/** “Claude Opus 5.5, Claude Sonnet 5.5 and 10 more”. */
function modelWords(p: T3Program): string {
  const names = p.models.map((m) => m.label);
  const total = names.length + p.more;
  const shown = names.slice(0, 2);
  if (!shown.length) return '';
  const rest = total - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(' and ');
}

/** The AI programs switched on: those that can't run first, with what stops them; ready ones with their models. */
export function programItems(s: T3Snapshot): ThingPageItem[] {
  return (s.programs ?? [])
    .filter((p) => p.on)
    .map((p) => ({ p, problem: programProblem(p) }))
    .sort((a, b) => Number(!!b.problem) - Number(!!a.problem))
    .map(({ p, problem }) => {
      const detail = problem ? problem.detail : modelWords(p);
      return {
        id: `program:${p.id}`.slice(0, 200),
        title: p.name,
        ...(detail ? { detail: clip(detail, 300) } : {}),
        tone: problem ? ('warn' as const) : ('ok' as const),
        right: problem ? problem.words : 'Ready',
      };
    });
}

function programCounts(s: T3Snapshot) {
  const on = (s.programs ?? []).filter((p) => p.on);
  return {
    on: on.length,
    ready: on.filter((p) => !p.problems.length).length,
    off: (s.programs ?? []).length - on.length,
  };
}

/** Each project read, those with the latest threads first: how many threads are open, what works and waits. */
export function projectItems(s: T3Snapshot): ThingPageItem[] {
  const waits = waitingFor(s);
  const working = workingNow(s);
  const latest = (id: string) => s.threads.find((t) => t.projectId === id)?.updatedAt.getTime() ?? 0;
  return [...s.projects]
    .sort(
      (a, b) => latest(b.id) - latest(a.id) || (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
    )
    .map((p) => {
      const open = s.open.get(p.id);
      const w = working.filter((t) => t.projectId === p.id).length;
      const q = waits.filter((x) => x.thread.projectId === p.id).length;
      const detail = [q ? `${q} waiting for you` : '', w ? `${w} working` : ''].filter(Boolean).join(' · ');
      return {
        id: p.id,
        title: p.title,
        ...(detail ? { detail } : {}),
        ...(q ? { tone: 'warn' as const } : w ? { tone: 'ok' as const } : {}),
        ...(open !== undefined ? { right: open ? `${open} open` : 'Nothing open' } : {}),
      };
    });
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** “Every 30 min”, “Every 2 h”, “Every 7 days”. */
function everyWords(ms: number): string {
  if (ms >= DAY && ms % DAY === 0) return ms === DAY ? 'Every day' : `Every ${ms / DAY} days`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0)
    return ms === 3_600_000 ? 'Every hour' : `Every ${ms / 3_600_000} h`;
  return `Every ${Math.max(1, Math.round(ms / MIN))} min`;
}

/** When a scheduled task runs: “Weekdays at 07:00”, “Every day at 09:30”, “Every 7 days”, “When its webhook is called”. */
export function scheduleWords(s: T3Schedule | null): string {
  if (!s) return '';
  if (s.type === 'interval') return everyWords(s.everyMs);
  if (s.type === 'webhook') return 'When its webhook is called';
  const days = [...new Set(s.weekdays ?? [])].sort();
  const at = `at ${s.time}`;
  if (!days.length || days.length === 7) return `Every day ${at}`;
  if (days.join() === '1,2,3,4,5') return `Weekdays ${at}`;
  if (days.join() === '0,6') return `Weekends ${at}`;
  return `${days.map((d) => WEEKDAYS[d]).join(', ')} ${at}`;
}

const LAST = {
  never: { right: 'Not run yet' },
  running: { right: 'Running', tone: 'info' },
  succeeded: { right: 'Went fine', tone: 'ok' },
  failed: { right: 'Failed', tone: 'bad' },
} as const;

/** “Today 07:00” in a sentence: “today 07:00” (a weekday or a date stays as it is). */
const inSentence = (t: string) =>
  /^(Today|Tomorrow|Yesterday)\b/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;

/** The scheduled tasks: when each runs and next, and how its last run went. */
export function taskItems(input: T3Input): ThingPageItem[] {
  const { snapshot: s, now, timeZone } = input;
  return (s.tasks ?? []).slice(0, 20).map((t) => {
    const next = t.enabled && t.nextRunAt ? dateWords(t.nextRunAt.toISOString(), now, timeZone) : null;
    const detail = [scheduleWords(t.schedule), next ? `next ${inSentence(next)}` : '']
      .filter(Boolean)
      .join(' · ');
    const last = t.last ? LAST[t.last] : null;
    return {
      id: t.id,
      title: t.title,
      ...(detail ? { detail: clip(detail, 300) } : {}),
      ...(t.enabled
        ? { ...(last ? { right: last.right } : {}), ...(last && 'tone' in last ? { tone: last.tone } : {}) }
        : { right: 'Switched off' }),
    };
  });
}

const sameDay = (timeZone: string) => {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  return (a: Date, b: Date) => day(a) === day(b);
};

/** The threads that finished today (the burrow's day), and how many of them failed. */
export function finishedToday(s: T3Snapshot, now: Date, timeZone: string) {
  const start = todayStart(now, timeZone).getTime();
  const done = s.threads.filter((t) => FINISHED.includes(t.status) && t.updatedAt.getTime() >= start);
  const more = !!s.seenSince && sameDay(timeZone)(s.seenSince, now);
  return { done, failed: done.filter((t) => t.status === 'failed').length, more };
}

function figures(input: T3Input): ThingPageKpi[] {
  const { snapshot: s, now, timeZone } = input;
  const working = workingNow(s);
  const waits = waitingFor(s);
  const questions = waits.filter((w) => w.kind !== 'permission').length;
  const permissions = waits.length - questions;
  const projects = new Set(working.map((t) => t.projectId)).size;
  const out: ThingPageKpi[] = [
    {
      key: 'working',
      label: 'Working',
      value: String(working.length),
      sub: working.length ? `in ${plural(projects, 'project')}` : 'Nothing is working',
    },
    {
      key: 'waiting',
      label: 'Waiting for you',
      value: String(waits.length),
      sub: waits.length
        ? [
            questions ? plural(questions, 'question') : '',
            permissions ? plural(permissions, 'permission request') : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : 'Nothing waits',
      ...(waits.length ? { tone: 'warn' as const } : {}),
    },
  ];
  const today = finishedToday(s, now, timeZone);
  const n = today.done.length;
  out.push({
    key: 'today',
    label: 'Today',
    value: `${n}${today.more ? '+' : ''}`,
    rest: n === 1 && !today.more ? 'thread' : 'threads',
    sub: n ? (today.failed ? `${today.failed} failed` : 'None failed') : 'Nothing finished yet',
    ...(today.failed ? { tone: 'warn' as const } : {}),
  });
  if (s.programs) {
    const { on, ready } = programCounts(s);
    if (on)
      out.push({
        key: 'programs',
        label: 'AI programs',
        value: `${ready} of ${on}`,
        sub: ready < on ? `ready · ${on - ready} can’t run` : 'ready',
        ...(ready === 0 ? { tone: 'bad' as const } : {}),
      });
  }
  return out;
}

/** What Whombat watches. */
export const T3_CHECK_LIST: KindCheck[] = [
  {
    check: T3_CHECKS.signin,
    name: 'Whombat’s sign-in to T3 Code ending soon',
    nature: 'you',
    perItem: false,
    startsOn: true,
  },
  {
    check: T3_CHECKS.program,
    name: 'AI programs in use that can’t run',
    nature: 'you',
    perItem: true,
    startsOn: true,
  },
  {
    check: T3_CHECKS.waiting,
    name: 'Threads waiting for you',
    nature: 'you',
    perItem: true,
    startsOn: false,
  },
  { check: T3_CHECKS.failed, name: 'Threads that failed', nature: 'problem', perItem: true, startsOn: false },
];

/** The checks this read couldn't see whole: no AI programs, a project's threads, threads at work not read. */
export function t3Skipped(s: T3Snapshot): string[] {
  const out: string[] = [];
  if (!s.programs || s.missed.length) out.push(T3_CHECKS.program);
  if (s.missed.length || s.threads.filter(atWork).length > s.activity.size) out.push(T3_CHECKS.waiting);
  if (s.missed.length) out.push(T3_CHECKS.failed);
  return out;
}

/** When the sign-in ends, in a sentence: “today”, “tomorrow”, “on 24 Oct”. */
function endWords(at: Date, now: Date, timeZone: string): string {
  const start = todayStart(now, timeZone).getTime();
  const days = Math.floor((todayStart(at, timeZone).getTime() - start + DAY / 2) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `on ${dayMonth(at, timeZone)}`;
}

/** The AI programs that can't run and that a thread used in the last 30 days. */
export function programsDown(s: T3Snapshot, now: Date): T3Program[] {
  const since = now.getTime() - IN_USE_DAYS * DAY;
  const used = new Set(s.threads.filter((t) => t.updatedAt.getTime() >= since).map((t) => t.program));
  return (s.programs ?? []).filter((p) => p.on && p.problems.length && used.has(p.id));
}

/**
 * Worth a look: Whombat's sign-in there ending within five days; each AI program in use that can't run (red when no
 * program switched on can); each thread waiting for the person; each thread that failed in the last day.
 */
export function t3Notices(input: T3Input): KindNotice[] {
  const { snapshot: s, now, timeZone, signedInUntil } = input;
  const out: KindNotice[] = [];
  if (signedInUntil && signedInUntil.getTime() - now.getTime() <= SIGNIN_WARN_DAYS * DAY) {
    const ended = signedInUntil.getTime() <= now.getTime();
    const title = ended
      ? 'Whombat’s sign-in to T3 Code has ended'
      : `Whombat’s sign-in to T3 Code ends ${endWords(signedInUntil, now, timeZone)}`;
    out.push({
      id: 'signin-ends',
      tone: ended ? 'bad' : 'warn',
      icon: 'key',
      title,
      detail: 'Make a new pairing code in T3 Code (Settings → Sharing & access) and sign in again with it.',
      link: { kind: 'tab', label: 'Sign in again', tab: 'settings' },
      nature: 'you',
      check: T3_CHECKS.signin,
      ignore: fixed('Until you sign in again.'),
      ...shortBadge(title, ended ? 'Sign-in has ended' : 'Sign-in ends soon'),
    });
  }
  const down = programsDown(s, now);
  const { ready } = programCounts(s);
  const settings = webUrl(`${base(input.address)}/settings/providers`);
  out.push(
    ...itemLines(
      down,
      (p) => {
        const problem = programProblem(p);
        const title = clip(`${p.name} can’t run in T3 Code`, 120);
        return {
          id: clip(`program-${p.id}`, 120),
          tone: ready === 0 ? 'bad' : 'warn',
          icon: 'plug',
          title,
          detail: clip(`${problem?.words ?? 'Can’t run'}. ${problem?.detail ?? ''}`.trim(), 200),
          ...(settings ? { link: { kind: 'url' as const, label: 'Open T3 Code', url: settings } } : {}),
          nature: 'you',
          check: T3_CHECKS.program,
          subject: { id: `program:${p.id}`.slice(0, 160), name: clip(p.name, 80) },
          ignore: fixed('Until it can run again.'),
          ...shortBadge(title, `${p.name} can’t run`),
        };
      },
      (p) => p.id,
      (rest) => ({
        id: 'program-more',
        tone: ready === 0 ? 'bad' : 'warn',
        icon: 'plug',
        title: `${plural(rest.length, 'more AI program')} can’t run`,
        nature: 'you',
        check: T3_CHECKS.program,
      }),
    ),
  );
  out.push(
    ...itemLines(
      waitingFor(s),
      (w) => {
        const title = clip(`${w.thread.title} waits for you`, 120);
        const url = threadUrl(input, w.thread.id);
        return {
          id: clip(`waiting-${w.thread.id}`, 120),
          tone: 'warn',
          icon: 'clock',
          title,
          detail: clip(waitWords(w), 200),
          ...(url ? { link: { kind: 'url' as const, label: 'Open it', url } } : {}),
          nature: 'you',
          check: T3_CHECKS.waiting,
          subject: { id: `thread:${w.thread.id}`.slice(0, 160), name: clip(w.thread.title, 80) },
          ignore: fixed('Until it’s answered.'),
          ...shortBadge(title, 'A thread waits for you'),
        };
      },
      (w) => w.thread.id,
      (rest) => ({
        id: 'waiting-more',
        tone: 'warn',
        icon: 'clock',
        title: `${plural(rest.length, 'more thread')} waiting for you`,
        nature: 'you',
        check: T3_CHECKS.waiting,
      }),
    ),
  );
  out.push(
    ...itemLines(
      s.threads.filter(
        (t) => t.status === 'failed' && now.getTime() - t.updatedAt.getTime() <= FAILED_WITHIN_MS,
      ),
      (t) => {
        const title = clip(`${t.title} failed`, 120);
        return {
          id: clip(`failed-${t.id}`, 120),
          tone: 'warn',
          icon: 'warn',
          title,
          detail: clip(
            `In ${projectTitle(s, t.projectId)}, ${span(now.getTime() - t.updatedAt.getTime())} ago.`,
            200,
          ),
          link: lookInto(`Why did the T3 Code thread ${quoted(t.title)} fail?`),
          nature: 'problem',
          check: T3_CHECKS.failed,
          subject: { id: `thread:${t.id}`.slice(0, 160), name: clip(t.title, 80) },
          ignore: fixed('Until it runs again.'),
          ...shortBadge(title, 'A thread failed'),
        };
      },
      (t) => t.id,
      (rest) => ({
        id: 'failed-more',
        tone: 'warn',
        icon: 'warn',
        title: `${plural(rest.length, 'more thread')} failed`,
        nature: 'problem',
        check: T3_CHECKS.failed,
      }),
    ),
  );
  return out;
}

/** “2 waiting for you · 2 working”; nothing when nothing does (the panel says so itself). */
function nowWords(s: T3Snapshot): string | undefined {
  const waits = waitingFor(s).length;
  const working = workingNow(s).length;
  return (
    [waits ? `${waits} waiting for you` : '', working ? `${working} working` : '']
      .filter(Boolean)
      .join(' · ') || undefined
  );
}

/**
 * In T3 Code (Inventory): what finished today and how many failed, the open threads, the AI programs ready, the
 * scheduled tasks and when the next runs.
 */
export function t3Counts(input: T3Input) {
  const { snapshot: s, now, timeZone } = input;
  const lines: ThingPageItem[] = [];
  const today = finishedToday(s, now, timeZone);
  const n = today.done.length;
  lines.push(
    countLine({
      id: 'finished',
      icon: 'log',
      title: 'Finished today',
      value: `${n}${today.more ? '+' : ''}`,
      ...(today.failed
        ? { note: `${today.failed} failed`, noteTone: 'warn' as const }
        : { note: n ? 'None failed' : 'Nothing yet' }),
    }),
  );
  if (s.open.size) {
    const open = [...s.open.values()].reduce((a, b) => a + b, 0);
    lines.push(
      countLine({
        id: 'open',
        icon: 'database',
        title: 'Open threads',
        detail: `In ${plural(s.open.size, 'project')}`,
        value: thousands(open),
      }),
    );
  }
  if (s.programs) {
    const { on, ready } = programCounts(s);
    if (on)
      lines.push(
        countLine({
          id: 'programs',
          icon: 'plug',
          title: 'AI programs',
          value: `${ready} of ${on}`,
          ...(ready < on
            ? {
                note: `${on - ready} can’t run`,
                noteTone: ready === 0 ? ('bad' as const) : ('warn' as const),
              }
            : { note: 'Ready', noteTone: 'ok' as const }),
        }),
      );
  }
  if (s.tasks?.length) {
    const failed = s.tasks.filter((t) => t.enabled && t.last === 'failed').length;
    const soonest = s.tasks
      .filter((t) => t.enabled && t.nextRunAt)
      .map((t) => t.nextRunAt as Date)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const next = soonest ? dateWords(soonest.toISOString(), now, timeZone) : null;
    lines.push(
      countLine({
        id: 'tasks',
        icon: 'clock',
        title: 'Scheduled tasks',
        value: String(s.tasks.length),
        ...(failed
          ? { note: `${failed} failed last time`, noteTone: 'bad' as const }
          : next
            ? { note: `next ${inSentence(next)}` }
            : {}),
      }),
    );
  }
  return inventory({ id: 'counts', title: 'In T3 Code', items: lines });
}

/**
 * This week (Trend): the threads that finished per day, by when they last changed, with how many failed; a day before
 * the latest threads read reach back to has no bar.
 */
export function t3Week(input: T3Input) {
  const { snapshot: s, now, timeZone } = input;
  const done = s.threads
    .filter((t) => FINISHED.includes(t.status))
    .map((t) => ({ at: t.updatedAt, failed: t.status === 'failed' }));
  const w = weekCounts(done, now, timeZone, s.seenSince);
  if (w.values.filter((v) => v !== null).length < 2) return null;
  const chart = trend({
    id: 'week',
    title: 'This week',
    meta: 'Threads finished per day',
    days: w.days,
    values: w.values,
    label: 'Finished',
    figure: { value: thousands(w.total), rest: w.total === 1 ? 'thread finished' : 'threads finished' },
    change: w.change,
    color: 'violet',
  });
  return w.failed ? withStat(chart, [{ text: String(w.failed), strong: true }, { text: ' failed' }]) : chart;
}

/** Its own lines in the machine card: T3 Code's version, and the computer it runs on. */
export function t3MachineLines(s: T3Snapshot): ThingPageBar[] {
  const env = s.environment;
  const out: ThingPageBar[] = [];
  if (env.version) out.push({ id: 't3-version', label: 'T3 Code', value: clip(env.version, 40), pct: null });
  const computer = [env.os ? (OS[env.os] ?? cap(env.os)) : '', env.name ?? ''].filter(Boolean).join(' · ');
  if (computer) out.push({ id: 't3-computer', label: 'Computer', value: clip(computer, 40), pct: null });
  return out;
}

/** The latest threads, the projects, the AI programs and the scheduled tasks: below the slots. */
function t3More(input: T3Input): ThingPagePanel[] {
  const { snapshot: s } = input;
  const panels: ThingPagePanel[] = [];
  if (s.threads.length)
    panels.push({
      kind: 'table',
      id: 'recent',
      title: 'Recent threads',
      columns: [
        { key: 'thread', label: 'Thread' },
        { key: 'state', label: 'State' },
        { key: 'when', label: 'When' },
      ],
      rows: recentRows(input),
    });
  if (s.projects.length)
    panels.push({
      kind: 'list',
      id: 'projects',
      title: 'Projects',
      meta:
        s.projectCount > s.projects.length
          ? `${s.projects.length} of ${s.projectCount}`
          : plural(s.projectCount, 'project'),
      items: projectItems(s),
    });
  if (s.programs?.length) {
    const { ready, off } = programCounts(s);
    panels.push({
      kind: 'list',
      id: 'programs',
      title: 'AI programs',
      meta: [`${ready} ready`, off ? `${off} switched off` : ''].filter(Boolean).join(' · '),
      items: programItems(s),
      empty: 'Every AI program is switched off in T3 Code.',
    });
  }
  if (s.tasks?.length)
    panels.push({
      kind: 'list',
      id: 'tasks',
      title: 'Scheduled tasks',
      meta: plural(s.tasks.length, 'task'),
      items: taskItems(input),
    });
  return panels;
}

/**
 * The page (pure), its Summary in slots (docs/service-pages.md): the coding agents now — what waits for the person,
 * then what works — beside the counts, this week's finished threads, the version and computer in the machine card;
 * the latest threads, projects, AI programs and scheduled tasks below.
 */
export function t3View(input: T3Input): KindView {
  const { snapshot: s, now, timeZone } = input;
  const notices = t3Notices(input);
  const waits = waitingFor(s);
  const working = workingNow(s);
  const meta = nowWords(s);
  const env = s.environment;
  const head = [
    env.version ? `T3 Code **${env.version}**` : 'T3 Code',
    env.name ?? '',
    env.os ? (OS[env.os] ?? cap(env.os)) : '',
  ].filter(Boolean);
  const facts: ThingLine[] = [line(head.join(' · '))];
  if (input.signedInUntil && input.signedInUntil.getTime() > now.getTime())
    facts.push(line(`Signed in until **${dayMonth(input.signedInUntil, timeZone)}**`));
  if (s.projectCount > s.projects.length)
    facts.push(line(`Showing the **${s.projects.length}** projects worked in last`));
  for (const name of s.missed.slice(0, 3)) facts.push(line(`**${name}**’s threads didn’t answer`));
  const open = webUrl(input.address);
  return {
    // In slots its figures are in Your coding agents and In T3 Code; the card keeps them (`t3CardView`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices,
    ...slotPanels({
      live: liveRows({
        id: 'now',
        title: 'Your coding agents',
        // Threads have no pictures: the row's square says the title's first letter.
        shape: 'square',
        ...(meta ? { meta } : {}),
        items: nowItems(input),
        ...(waits.length + working.length > ROWS ? { total: waits.length + working.length } : {}),
        empty: 'Nothing is working.',
      }),
      inventory: t3Counts(input),
      trend: t3Week(input),
      more: t3More(input),
      machine: t3MachineLines(s),
    }),
    tabs: [],
    facts,
    status: statusFrom(
      notices,
      working.length ? `${working.length} working` : waits.length ? 'Waiting for you' : 'Ready',
    ),
    ...(open ? { open: { label: 'Open T3 Code', url: open } } : {}),
    actions: [],
    readAt: s.readAt,
    suggestions: [
      'What did my coding agents finish today?',
      'Which threads wait for me?',
      'Start a thread in T3 Code',
    ],
  };
}

/** The page's part as the card reads it: the card keeps Working and Waiting for you. */
export function t3CardView(input: T3Input): KindView {
  return { ...t3View(input), kpis: figures(input) };
}

/* The page and its buttons ------------------------------------------------------------------------------------------ */

const openOf = (row: CatalogConnectionRow) => {
  const url = webUrl(row.baseUrl);
  return url ? { label: 'Open T3 Code', url } : undefined;
};

async function t3Page(ctx: KindCtx): Promise<KindView> {
  const read = await t3Latest(ctx.services, ctx.row, ctx.now);
  return viewOrProblem(read, NAME, openOf(ctx.row), (snapshot) =>
    t3View({
      snapshot,
      now: ctx.now,
      timeZone: ctx.timeZone,
      address: ctx.row.baseUrl,
      signedInUntil: ctx.row.accessExpiresAt ?? null,
      button: buttonsFor(ctx),
    }),
  );
}

/** A button's call failed: plain words for the toast, never T3 Code's own. */
function actProblem(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (signedOut(err)) return conflict(`${NAME} needs you to sign in again first.`);
  if (err instanceof T3Failure) {
    switch (err.code) {
      case 'capability_denied':
      case 'runtime_mode_escalation_denied':
      case 'interaction_mode_escalation_denied':
        return forbidden(
          'T3 Code refused: Whombat’s sign-in there may not change this thread. Sign in again with Full access.',
        );
      case 'thread_not_found':
        return stale(NAME);
      case 'thread_not_interruptible':
        return conflict('It isn’t working any more.');
      case 'invalid_request':
        return conflict(
          /already answered/i.test(err.said)
            ? 'That question was answered already.'
            : 'That question isn’t waiting any more. Look again.',
        );
      default:
        return new ApiError('unavailable', `${NAME} answered with an error and didn’t do it.`);
    }
  }
  if (err instanceof VaultCallError && err.reason === 'timeout')
    return new ApiError(
      'unavailable',
      `${NAME} didn’t answer in time. Look again in a moment: it may have done it.`,
    );
  if (err instanceof VaultCallError && err.reason === 'not_allowed')
    return forbidden(`Whombat may not call ${NAME}’s address any more.`);
  return new ApiError('unavailable', `Whombat couldn’t reach ${NAME} just now.`);
}

/** The thread a button names, as the page showed it; else the page is out of date. */
async function shownThread(ctx: Parameters<KindAction>[0], target: unknown): Promise<T3Thread> {
  const id = typeof target === 'string' ? target : '';
  const snapshot = await snapshotOf(ctx.services, ctx.row, ctx.now).catch(() => null);
  const thread = snapshot?.threads.find((t) => t.id === id);
  if (!thread) throw stale(NAME);
  return thread;
}

/** **Stop** on a thread at work: T3 Code interrupts its turn; the thread stays. */
const stopAction: KindAction = async (ctx, input) => {
  const thread = await shownThread(ctx, input.target);
  if (!STOPPABLE.includes(thread.status) || thread.child) throw stale(NAME);
  let answer: unknown;
  try {
    answer = await callT3(
      ctx.services,
      ctx.row,
      't3_thread_interrupt',
      { threadId: thread.id, reason: 'Stopped from Whombat' },
      'things.action',
    );
  } catch (err) {
    throw actProblem(err);
  }
  bumpGeneration(ctx.row.id);
  if (str(rec(answer).status) === 'no_active_run') throw conflict('It had already stopped.');
  return {
    message: 'T3 Code is stopping it.',
    title: `Stopped ${quoted(thread.title)} in T3 Code`.slice(0, 200),
  };
};

/** What answers a request with an option's label: its one single choice that offers it, keyed by the question's id. */
export function answerFor(request: T3Request | null, label: string): Record<string, string> | null {
  const q = oneTap(request);
  return q?.options.some((o) => o.label === label) ? { [q.id]: label } : null;
}

/**
 * An answer to a thread's question, one option's label: its questions are read again (someone may have answered in T3
 * Code since the page was read), the one whose single choice holds that label is answered.
 */
const answerAction: KindAction = async (ctx, input) => {
  const thread = await shownThread(ctx, input.target);
  const label = typeof input.value === 'string' ? input.value : '';
  if (!label) throw stale(NAME);
  const call = (tool: string, args: Record<string, unknown>) => callT3(ctx.services, ctx.row, tool, args);
  try {
    const ids = requestIdsOf(await call('t3_pending_request', { action: 'list', threadId: thread.id }));
    for (const requestId of ids.slice(0, 4)) {
      const request = requestOf(
        await call('t3_pending_request', { action: 'read', threadId: thread.id, requestId }),
        thread.id,
      );
      const answers = answerFor(request, label);
      if (!answers) continue;
      await callT3(
        ctx.services,
        ctx.row,
        't3_pending_request',
        { action: 'respond', threadId: thread.id, requestId, answers },
        'things.action',
      );
      bumpGeneration(ctx.row.id);
      return {
        message: `Answered: ${clip(label, 60)}.`,
        title: `Answered ${quoted(thread.title, 60)} in T3 Code: ${clip(label, 60)}`.slice(0, 200),
      };
    }
    throw conflict(
      ids.length ? 'That question changed in T3 Code. Look again.' : 'That question was answered already.',
    );
  } catch (err) {
    throw actProblem(err);
  }
};

export const T3CODE_KIND: KindModule = {
  page: t3Page,
  prefetch: (services, row, now) => t3Latest(services, row, now),
  async seen(services, row, now, timeZone) {
    const snapshot = await snapshotOf(services, row, now);
    return seenOfView(
      t3CardView({
        snapshot,
        now,
        timeZone,
        address: row.baseUrl,
        signedInUntil: row.accessExpiresAt ?? null,
      }),
      ['working', 'waiting'],
      undefined,
      t3Skipped(snapshot),
    );
  },
  checks: T3_CHECK_LIST,
  asksFirst: 'deleting asks first',
  actions: { stop: stopAction, answer: answerAction },
};
