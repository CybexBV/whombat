/**
 * Straight to production for chosen reporters (docs/decisions/report-trackers.md TA-135…TA-140): a production tracker
 * connection may name reporters (`releaseFor`, email addresses) whose bug fixes are released as soon as development runs
 * them. Whombat starts one T3 Code thread in the repository's project that runs the repository's own production
 * release procedure for exactly the revision development runs, and reads how it went; the fix follower tells the
 * customer once production runs the fix, or the person when the release stopped. The addresses are read here only: an
 * agent never sees them, nor who filed a report.
 */
import type { AutomationDefinition } from '@whombat/core';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db } from '../db/client';
import {
  automationRunSteps,
  automationRuns,
  automations,
  automationVersions,
  catalogConnections,
  type TrackerFixRelease,
  trackerFixes,
} from '../db/schema/index';
import type { Services } from '../services';
import { readLastAnswer } from '../t3code/answer';
import { runEndedOf } from '../t3code/handoff';
import { settleRefusal, T3_SETTLE_QUIET_MS } from '../t3code/settle';
import { needsOf, stateArgs, threadStateOf } from '../t3code/threads';
import { AT_WORK, callT3, T3Failure } from '../things/kinds/business/t3code';
import { list, rec, str } from '../things/words';
import type { BoundDriver } from './drivers';
import { scopeReport } from './items';

type FixRow = typeof trackerFixes.$inferSelect;

const T3_CATALOG_ID = 't3code';
/**
 * A release that hasn't put the fix on production after this long has stopped as far as the customer goes. Long, so a
 * release that rightly waits behind another one isn't cut off (the repository's own release may wait eight hours): a
 * thread that doesn't move is asked, or the person told, long before.
 */
export const RELEASE_TIMEOUT_MS = 12 * 60 * 60_000;
/** A thread whose turn ended without “Released:” or “Stopped:” and that hasn't moved for this long is asked where it is. */
export const RELEASE_QUIET_MS = 45 * 60_000;
/** A thread that was asked and didn't move after this long, whatever T3 Code says it is doing, has stopped. */
export const RELEASE_NUDGE_ANSWER_MS = 20 * 60_000;
/** A thread that hasn't moved for this long, whatever T3 Code says it is doing: the person hears, once; it is followed on. */
export const RELEASE_SLOW_MS = 90 * 60_000;
/** A release production doesn't run this long after it started tells the person, once, and is followed on. */
export const RELEASE_SLOW_TOTAL_MS = 3 * 60 * 60_000;
/** How many releases Whombat starts for one fix (tries that couldn't start don't count). */
export const RELEASE_ATTEMPTS = 3;
/** The last release for a fix waits this long after the stop before it, so the person can act on what stopped it. */
export const RELEASE_LAST_RETRY_MS = 12 * 60 * 60_000;
/** A release that couldn't start (T3 Code away) is tried again for the same revision after this long. */
export const RELEASE_START_RETRY_MS = 30 * 60_000;
/**
 * A stopped release is tried again for the same development revision after this long: what stopped it may have been
 * mended outside the code (the person decided, a check that failed once passes now). It stops again at once if not.
 */
export const RELEASE_SAME_RETRY_MS = 3 * 60 * 60_000;
/**
 * What a quiet release thread is asked: an instruction for the agent there, never shown to the customer. T3 Code can't
 * say from outside whether a thread between turns still has a background wait running, so the thread is asked.
 */
export const RELEASE_NUDGE =
  'Whombat here: this release has been quiet for a while, and its last turn ended without “Released:” or “Stopped:”. If a step you started is still running, or another release you wait for is still going, check it now and wait again with one background wait. If nothing runs any more, go on with the next step of the procedure, or end with “Stopped: <why, in one plain sentence>.”';
/**
 * How long a chosen reporter's fix that development runs waits for that reporter's other reports still being fixed, so
 * they reach beta and production in one release. After this it goes alone (the thread's words say “two hours”).
 */
export const RELEASE_HOLD_MS = 2 * 60 * 60_000;
/**
 * How long a merged bug fix eligible for straight-to-production release waits for development to run it before Whombat
 * starts the repository's release procedure directly from the merged commit (for repositories whose development/beta
 * channel is built by the release procedure itself rather than auto-deployed on every merge).
 */
export const RELEASE_DEV_GRACE_MS = 10 * 60_000;
/** How long Whombat keeps trying to settle a release thread that is over, after it could first have settled. */
export const RELEASE_SETTLE_TRY_MS = 24 * 60 * 60_000;
/** A release thread that couldn't be settled yet (it waits for something, T3 Code didn't answer) is looked at again then. */
const RELEASE_SETTLE_LOOK_MS = 10 * 60_000;
/** How many of the other reports are read from the tracker at most, to see who filed them. */
const PENDING_MAX = 20;
/** The first line of the release thread's last answer when it stopped, or when it released (the brief asks for them). */
const STOPPED = /^\W*stopped\b/i;
const RELEASED = /^\W*released\b/i;

/** Whether the connection sends every bug fix straight to production (`releaseFor` set to `*`). */
export function releasesForAll(fields: Readonly<Record<string, string>>): boolean {
  return (fields.releaseFor ?? '').trim() === '*';
}

/** The reporters (lowercase email addresses) whose bug fixes go straight to production, from the connection's setting. */
export function releaseReporters(fields: Readonly<Record<string, string>>): string[] {
  return (fields.releaseFor ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^\s@]+@[^\s@]+$/.test(s));
}

/** Whether the connection has any straight-to-production release target (email addresses or `*`). */
export function hasReleaseTargets(fields: Readonly<Record<string, string>>): boolean {
  return releasesForAll(fields) || releaseReporters(fields).length > 0;
}

/** Why a release couldn't start or stopped, in plain words for the person. */
export class ReleaseProblem extends Error {
  override name = 'ReleaseProblem';
}

/**
 * Whether a fix is released straight away: a bug report on a production installation, matching the connection's
 * `releaseFor` setting (`*` for every bug report, or a listed email address read from the report itself and never
 * kept), with no release started yet — or, `again`, whatever earlier release it had.
 */
export async function releasesStraightAway(
  driver: BoundDriver,
  connection: CatalogConnectionRow,
  fix: FixRow,
  reportEnvironment: 'production' | 'development',
  again = false,
): Promise<boolean> {
  if (reportEnvironment !== 'production' || fix.kind !== 'bug' || (fix.release && !again)) return false;
  if (releasesForAll(connection.fields)) return true;
  const reporters = releaseReporters(connection.fields);
  if (!reporters.length) return false;
  const report = await driver.item(fix.reportId);
  const email = report.reporter.email?.trim().toLowerCase();
  return !!email && reporters.includes(email);
}

/** The T3 Code connection a fix's release runs in: its automation's own (`recipe.t3`), else the burrow's only one. */
async function t3ConnectionFor(db: Db, fix: FixRow): Promise<CatalogConnectionRow | null> {
  const rows = await db
    .select()
    .from(catalogConnections)
    .where(
      and(eq(catalogConnections.burrowId, fix.burrowId), eq(catalogConnections.catalogId, T3_CATALOG_ID)),
    );
  if (fix.automationId) {
    const [live] = await db
      .select({ definition: automationVersions.definition })
      .from(automations)
      .innerJoin(
        automationVersions,
        and(
          eq(automationVersions.automationId, automations.id),
          eq(automationVersions.n, automations.currentVersion),
        ),
      )
      .where(eq(automations.id, fix.automationId));
    const handle = (live?.definition as AutomationDefinition | undefined)?.recipe?.t3;
    const named = handle ? rows.find((r) => r.handle === handle) : undefined;
    if (named) return named;
  }
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

/**
 * The T3 Code project of `repo` among `t3_project_list`'s answer: the one whose repository is `repo` (its origin), else
 * the only one whose folder or title is the repository's name. Archived projects only when nothing else fits.
 */
export function projectOf(body: unknown, repo: string): string | null {
  const want = repo.toLowerCase();
  const name = want.split('/').at(-1) ?? want;
  const projects = list(rec(body).projects)
    .map(rec)
    .filter((p) => !p.deletedAt && str(p.id));
  const ofRepo = (p: Record<string, unknown>) => {
    const r = rec(p.repositoryIdentity);
    const owner = str(r.owner);
    const repoName = str(r.name);
    return (
      str(r.displayName)?.toLowerCase() === want ||
      (owner && repoName ? `${owner}/${repoName}`.toLowerCase() === want : false) ||
      !!str(r.canonicalKey)?.toLowerCase().endsWith(`/${want}`)
    );
  };
  const named = (p: Record<string, unknown>) =>
    (str(p.workspaceRoot) ?? '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1)
      ?.toLowerCase() === name || (str(p.title) ?? '').toLowerCase() === name;
  for (const pick of [ofRepo, named]) {
    const found = projects.filter(pick);
    const live = found.filter((p) => !p.archivedAt);
    const one = live.length === 1 ? live[0] : found.length === 1 ? found[0] : undefined;
    if (one) return str(one.id);
  }
  return null;
}

/** What the release thread is told: the repository's own procedure for one exact revision, and the line to end with. */
export function releaseBrief(p: {
  repo: string;
  revision: string;
  product: string;
  host: string;
  version: string | null;
  prUrl: string | null;
  prNumber: number;
  mergeSha: string | null;
  /** The paths the fix changes that reach customers with a release of their own (null: none). */
  separate?: readonly string[] | null;
  /** True when the connection sends every bug fix straight to production (`releaseFor: "*"`). */
  allReporters?: boolean;
  /** True when starting straight from the merged commit because development does not run the fix yet. */
  fromMerge?: boolean;
}): string {
  const runs = p.version ? `${p.product} ${p.version}` : p.product;
  const pr = p.prUrl ? `${p.prUrl} (pull request #${p.prNumber})` : `pull request #${p.prNumber}`;
  const who = p.allReporters ? 'bug fixes for this tracker' : 'the bug fixes of this reporter';
  const when = p.fromMerge ? 'straight away' : 'as soon as development runs them';
  const why = `Why: the person who runs Whombat decided that ${who} go to production ${when}. It is their standing decision, so you don’t ask them first. It is no hotfix and no shortcut: follow the procedure this repository documents for a production release (its AGENTS.md and its release docs) from start to end${p.fromMerge ? ', including building and deploying development or beta first if it does not run this fix yet' : ''}.`;
  const what = p.fromMerge
    ? `What: ${p.repo} including ${pr}${p.mergeSha ? `, merged as ${p.mergeSha}` : ''}. ${p.host} (${runs}) does not run this fix yet, so start from the current main revision containing ${p.revision} and take it through the full release procedure (development or beta and every required check, then production). Everything merged before it goes along, as with any release.`
    : `What: ${p.repo} at revision ${p.revision}, exactly. ${p.host} runs it (${runs}) and it has the fix: ${pr}${p.mergeSha ? `, merged as ${p.mergeSha}` : ''}. Everything merged before it goes along, as with any release.`;
  return [
    `Release this fix to production now, with ${p.repo}'s own normal production release procedure.`,
    '',
    why,
    '',
    what,
    ...(p.separate?.length
      ? [
          '',
          `The fix changes what reaches customers with a release of its own (${p.separate.map((x) => `\`${x}\``).join(', ')}): this release must also make that part's new release and offer it to customers, as the repository's release docs say. Whombat counts the fix as live only once production offers it.`,
        ]
      : []),
    '',
    'Rules:',
    '- Every step and check of the procedure, in its order, each waited for until it ends. Never skip one. Use an emergency, skip or override option only where the repository’s release docs explicitly allow it for a report fix’s release like this one and every condition they set is met, with the reason they ask for; otherwise never.',
    '- When another release is being prepared, tried or deployed, wait until it has finished, checking every few minutes, then start yours. When production then already runs a revision that contains this one, it is released.',
    '- The goal is production running this fix. When a step fails or a check isn’t green, find the cause and fix it the way the repository’s instructions say for a direct instruction (your own worktree, its checks, merged into main and pushed, development deployed), then release the new main revision, which still contains this fix. Never skip, weaken or waive a check or test to get past it.',
    '- Stop only where the repository’s instructions say to, after three rounds of fixes that didn’t get it through, or for a decision only a person can take.',
    '- The first line of your last message is “Released: <version> is live on production.” or “Stopped: <why, in one plain sentence>.”',
  ].join('\n');
}

/**
 * Starts the release of `revision` for `fix` in T3 Code: one thread in the repository's project, full access (nobody is
 * there to approve its commands), with `releaseBrief`. A `ReleaseProblem` says why it couldn't start.
 */
export async function startRelease(
  services: Services,
  fix: FixRow,
  p: {
    label: string;
    product: string;
    host: string;
    version: string | null;
    revision: string;
    separate?: readonly string[] | null;
    allReporters?: boolean;
    fromMerge?: boolean;
  },
): Promise<TrackerFixRelease> {
  const connection = await t3ConnectionFor(services.db, fix);
  if (!connection) throw new ReleaseProblem('T3 Code isn’t connected to this Whombat');
  let threadId: string | null = null;
  try {
    const projectId = projectOf(
      await callT3(services, connection, 't3_project_list', { limit: 100 }),
      fix.repo,
    );
    if (!projectId) throw new ReleaseProblem(`T3 Code has no project for ${fix.repo}`);
    const body = await callT3(
      services,
      connection,
      't3_thread_launch',
      {
        projectId,
        title: `Release the fix for ${p.label} #${fix.number} to production`,
        message: releaseBrief({
          repo: fix.repo,
          revision: p.revision,
          product: p.product,
          host: p.host,
          version: p.version,
          prUrl: fix.prUrl,
          prNumber: fix.prNumber,
          mergeSha: fix.mergeSha,
          separate: p.separate ?? null,
          allReporters: p.allReporters,
          fromMerge: p.fromMerge,
        }),
        runtimeMode: 'full-access',
      },
      'things.action',
    );
    threadId = str(rec(body).threadId);
  } catch (err) {
    if (err instanceof ReleaseProblem) throw err;
    throw new ReleaseProblem(
      err instanceof T3Failure && err.said
        ? `T3 Code said: ${err.said.slice(0, 200)}`
        : 'T3 Code couldn’t start it',
    );
  }
  if (!threadId) throw new ReleaseProblem('T3 Code started no thread');
  return {
    t3ConnectionId: connection.id,
    threadId,
    revision: p.revision,
    startedAt: services.clock().toISOString(),
  };
}

/**
 * How a started release stands while production doesn't run the fix yet: stopped with why — its thread says it stopped
 * or was stopped in T3 Code, it waits for an answer nobody gives, T3 Code is gone, or it took too long — or still going:
 * then how long its timeline is, and whether it is `quiet` (its turn ended without “Released:” or “Stopped:”, so it
 * waits for something long, or for nothing). One that says it released is going: the next look at production finds it.
 * `run` is the thread's latest run, when T3 Code showed it.
 */
export type ReleaseState =
  | { going: true; items: number | null; quiet: boolean; run?: string }
  | { stopped: string; run?: string };

export async function releaseState(
  services: Services,
  release: TrackerFixRelease,
  now: Date,
): Promise<ReleaseState> {
  const late = now.getTime() - Date.parse(release.startedAt) > RELEASE_TIMEOUT_MS;
  const stoppedLate = { stopped: 'it ran for twelve hours without production running the fix' };
  const unknown = { going: true as const, items: null, quiet: false };
  if (!release.t3ConnectionId || !release.threadId) return { stopped: release.why ?? 'it didn’t start' };
  const [connection] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, release.t3ConnectionId));
  if (!connection) return { stopped: 'T3 Code isn’t connected any more' };
  let state: ReturnType<typeof threadStateOf>;
  try {
    state = threadStateOf(
      await callT3(services, connection, 't3_thread_read', stateArgs(release.threadId, 0)),
    );
  } catch (err) {
    // A thread T3 Code no longer has can't release it. T3 Code not answering for a moment is no answer: asked again on
    // the next pass (and the person hears if it stays so).
    if (err instanceof T3Failure && /not_found/i.test(err.code))
      return { stopped: 'its T3 Code thread is gone' };
    return late ? stoppedLate : unknown;
  }
  if (!state) return late ? stoppedLate : unknown;
  const run = state.latestRunId ?? undefined;
  const needs = needsOf(state);
  if (needs.kind === 'pending') return { stopped: 'it asks something in T3 Code', run };
  if (needs.kind === 'ended' && state.status !== 'completed' && state.status !== 'idle')
    return { stopped: 'its T3 Code thread was stopped before it released it', run };
  if (needs.kind !== 'ended')
    return late ? { ...stoppedLate, run } : { going: true, items: state.items, quiet: false, run };
  const answer = await readLastAnswer(services, connection, release.threadId, state.items).catch(() => null);
  const first =
    answer
      ?.split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  if (STOPPED.test(first)) {
    const why = first.replace(/^\W*stopped\s*:\s*/i, '').replace(/[.\s]+$/, '');
    return { stopped: why ? why.slice(0, 300) : 'its T3 Code thread stopped without saying why', run };
  }
  // A turn that ends with neither line waits for something long (checks, a build, beta), and T3 Code wakes the
  // thread when it ends; one that released waits for production to run it.
  return late
    ? { ...stoppedLate, run }
    : { going: true, items: state.items, quiet: !RELEASED.test(first), run };
}

/**
 * Whether a stopped release's thread went on after the stop: it has a later run than the one it stopped in (someone
 * wrote to it, or T3 Code woke it) and is going by `releaseState`, within the release's twelve hours. Then Whombat
 * follows that thread again rather than starting another release beside it: its timeline's length. Null otherwise, or
 * while T3 Code can't say.
 */
export async function releaseRevived(
  services: Services,
  release: TrackerFixRelease,
  now: Date,
): Promise<{ items: number } | null> {
  if (!release.stoppedRun || !release.threadId) return null;
  if (now.getTime() - Date.parse(release.startedAt) > RELEASE_TIMEOUT_MS) return null;
  const state = await releaseState(services, release, now);
  return 'going' in state && state.items !== null && state.run && state.run !== release.stoppedRun
    ? { items: state.items }
    : null;
}

/**
 * Another fix of the same repository whose release is under way (its thread started and hasn't stopped): one release of
 * a repository at a time, so two threads don't race each other through the same procedure and both mend what fails.
 */
export async function releaseUnderWay(db: Db, fix: FixRow): Promise<{ id: string; number: number } | null> {
  const [other] = await db
    .select({ id: trackerFixes.id, number: trackerFixes.number })
    .from(trackerFixes)
    .where(
      and(
        eq(trackerFixes.burrowId, fix.burrowId),
        ne(trackerFixes.id, fix.id),
        inArray(trackerFixes.state, ['merged', 'development']),
        sql`lower(${trackerFixes.repo}) = ${fix.repo.toLowerCase()}`,
        sql`${trackerFixes.release} ->> 'threadId' is not null`,
        sql`${trackerFixes.release} ->> 'stoppedAt' is null`,
      ),
    )
    .limit(1);
  return other ?? null;
}

/**
 * The numbers of the connection's other bug reports, matching its `releaseFor` setting, that are still being fixed
 * for the fix's repository: a run of the report goes on by itself (not one waiting for a person's approval), or its fix
 * is open — and when waiting on development (`!fromMerge`), also merged fixes development doesn't run yet. When
 * releasing straight from main (`fromMerge`), already-merged fixes are included in main so we only wait for open PRs
 * and active runs. Who filed a report is read from the tracker and kept nowhere.
 */
export async function reportsBeingFixed(
  db: Db,
  driver: BoundDriver,
  connection: CatalogConnectionRow,
  fix: FixRow,
  opts: { fromMerge?: boolean } = {},
): Promise<number[]> {
  const all = releasesForAll(connection.fields);
  const reporters = all ? [] : releaseReporters(connection.fields);
  if (!all && !reporters.length) return [];
  const repo = fix.repo.toLowerCase();
  const fixes = await db
    .select({ reportId: trackerFixes.reportId, number: trackerFixes.number })
    .from(trackerFixes)
    .where(
      and(
        eq(trackerFixes.burrowId, fix.burrowId),
        eq(trackerFixes.connectionId, fix.connectionId),
        ne(trackerFixes.reportId, fix.reportId),
        inArray(trackerFixes.state, opts.fromMerge ? ['open'] : ['open', 'merged']),
        eq(trackerFixes.kind, 'bug'),
        sql`lower(${trackerFixes.repo}) = ${repo}`,
      ),
    )
    .limit(PENDING_MAX);
  const runs = await db
    .select({ scope: automationRuns.scope })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.burrowId, fix.burrowId),
        eq(automationRuns.test, false),
        inArray(automationRuns.status, ['queued', 'running', 'waiting']),
        sql`${automationRuns.scope}->>'kind' = 'tracker'`,
        sql`${automationRuns.scope}->>'connectionId' = ${fix.connectionId}`,
        sql`${automationRuns.scope}->>'reportId' <> ${fix.reportId}`,
        sql`coalesce(${automationRuns.scope}->>'type', '') <> 'feature'`,
        sql`coalesce(lower(${automationRuns.definition}->'recipe'->>'repo'), ${repo}) = ${repo}`,
        // A run waiting for a person's yes waits on them, not on its fix: the person decides when that comes.
        sql`not exists (select 1 from ${automationRunSteps} s where s.run_id = ${automationRuns.id}
          and s.state = 'waiting' and s.approval_id is not null)`,
      ),
    )
    .limit(PENDING_MAX);
  const reports = new Map<string, number>();
  for (const f of fixes) reports.set(f.reportId, f.number);
  for (const r of runs) {
    const report = scopeReport(r.scope);
    if (report) reports.set(report.reportId, report.number);
  }
  if (all) return [...reports.values()].slice(0, PENDING_MAX).sort((a, b) => a - b);
  const numbers: number[] = [];
  for (const [reportId, number] of [...reports].slice(0, PENDING_MAX)) {
    const report = await driver.item(reportId).catch(() => null);
    const email = report?.reporter.email?.trim().toLowerCase();
    if (email && reporters.includes(email)) numbers.push(number);
  }
  return numbers.sort((a, b) => a - b);
}

/** Whether a release's thread has finished (its turn ended, or T3 Code no longer has it): another may start. */
export async function releaseEnded(services: Services, release: TrackerFixRelease): Promise<boolean> {
  if (!release.t3ConnectionId || !release.threadId) return true;
  const [connection] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, release.t3ConnectionId));
  if (!connection) return true;
  try {
    const state = threadStateOf(
      await callT3(services, connection, 't3_thread_read', stateArgs(release.threadId, 0)),
    );
    return !!state && needsOf(state).kind === 'ended';
  } catch (err) {
    return err instanceof T3Failure && /not_found/i.test(err.code);
  }
}

/**
 * Asks a quiet release thread where it stands (`RELEASE_NUDGE`). Returns the thread's timeline length with the question
 * in it, read right after sending — so the question itself isn't taken for the thread moving — or null when T3 Code
 * didn't take it.
 */
export async function nudgeRelease(
  services: Services,
  release: TrackerFixRelease,
  items: number,
): Promise<number | null> {
  if (!release.t3ConnectionId || !release.threadId) return null;
  const [connection] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, release.t3ConnectionId));
  if (!connection) return null;
  try {
    await callT3(
      services,
      connection,
      't3_thread_send',
      { threadId: release.threadId, message: RELEASE_NUDGE, mode: 'auto' },
      'things.action',
    );
  } catch (err) {
    services.log.warn(
      { threadId: release.threadId, err: String(err).slice(0, 200) },
      'tracker: a quiet release thread couldn’t be asked where it is',
    );
    return null;
  }
  // The question is at least one item on T3 Code's timeline (it may add one as the turn starts); what comes after a
  // read right after sending is the thread's own.
  const after = await callT3(services, connection, 't3_thread_read', stateArgs(release.threadId, 0))
    .then((body) => threadStateOf(body)?.items ?? 0)
    .catch(() => 0);
  return Math.max(after, items + 1);
}

/** A release thread that is over and waits to be settled in T3 Code: its fix is live, or a newer release replaced it. */
export interface ReleaseThread {
  t3ConnectionId: string;
  threadId: string;
  /** When it was over for Whombat; it is quiet from then, or from its last run's end when that is later. */
  from: string;
}

/**
 * Settles a release thread that is over, so the person's list in T3 Code keeps only what still needs them. Settling stops
 * whatever the thread left running (a copy it makes after a deploy), so only once it has been quiet for
 * `T3_SETTLE_QUIET_MS`, as every thread Whombat settles, and waits for nothing (`settleRefusal`). `done`: settled, or
 * nothing more to do (T3 Code no longer has it, or it couldn't be settled for `RELEASE_SETTLE_TRY_MS`); else when to look
 * again.
 */
export async function settleReleaseThread(
  services: Services,
  thread: ReleaseThread,
  now: Date,
): Promise<{ done: true } | { later: Date }> {
  const from = Date.parse(thread.from);
  const giveUp = now.getTime() - from > T3_SETTLE_QUIET_MS + RELEASE_SETTLE_TRY_MS;
  const later = (ms: number) => (giveUp ? { done: true as const } : { later: new Date(now.getTime() + ms) });
  const gone = (err: unknown) => err instanceof T3Failure && /not_found/i.test(err.code);
  const [connection] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, thread.t3ConnectionId));
  if (!connection) return { done: true };
  let body: unknown;
  try {
    body = await callT3(services, connection, 't3_thread_read', stateArgs(thread.threadId, 0));
  } catch (err) {
    return gone(err) ? { done: true } : later(RELEASE_SETTLE_LOOK_MS);
  }
  const state = threadStateOf(body);
  if (!state) return later(RELEASE_SETTLE_LOOK_MS);
  // Someone works in it again (the person wrote to it): quiet only once that is over.
  if (state.activeRunId !== null || AT_WORK.includes(state.status)) return later(T3_SETTLE_QUIET_MS);
  const quietAt = Math.max(from, runEndedOf(body)?.getTime() ?? 0) + T3_SETTLE_QUIET_MS;
  if (quietAt > now.getTime()) return { later: new Date(quietAt) };
  try {
    if (await settleRefusal(services, connection, { action: 'settle', threadId: thread.threadId }))
      return later(RELEASE_SETTLE_LOOK_MS);
    await callT3(
      services,
      connection,
      't3_thread_organize',
      { action: 'settle', threadId: thread.threadId },
      'things.action',
    );
  } catch (err) {
    if (gone(err)) return { done: true };
    services.log.debug(
      { threadId: thread.threadId, err: String(err).slice(0, 200) },
      'tracker: a release thread that is over couldn’t be settled yet',
    );
    return later(RELEASE_SETTLE_LOOK_MS);
  }
  return { done: true };
}
