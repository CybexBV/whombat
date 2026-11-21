/**
 * The GitHub poller (S-08, docs/github.md "Polling"): a self-hosted box behind a tailnet is not reachable by
 * GitHub, so instead of webhooks the server reads every switched-on repo of every connected burrow: open PRs (new,
 * pushed to, edited, closed, merged, reopened), the check runs and reviews on each open PR's head, agents' branches
 * before they have a PR, and the workflow runs of deploys in flight. What changed goes through the mirror
 * (github/sync.ts).
 *
 * - Each repo has its own cadence (docs/decisions/polling.md PL-01, `poll-cadence.ts`): 10 s while an agent's run,
 *   push, deploy or pull request checks are live there, 30 s (`WHOMBAT_GITHUB_POLL_MS`) while a person of the burrow is
 *   active, 3 min otherwise. A change that should be seen at once wakes the poller (`wake`: a push token handed out, a
 *   deploy dispatched, a repo added; from the bus: a run going live, a merge, a person coming back).
 * - Every read is conditional (the ETag of the last successful answer, kept per burrow and repo in
 *   `github_poll_cursors`): a 304 costs no rate limit. An ETag is only stored once its answer was applied,
 *   so a crash re-reads and re-applies — safely, because the plan is a diff against the burrow's state and
 *   pushes and reviews are recorded in the same transaction as their mirror (no duplicate messages).
 * - Every 10 minutes a repo on the idle cadence is read without ETags (the burrow may have diverged: a rewind, a
 *   failure); a busy repo takes it after 30 minutes at the latest.
 * - A head without check runs is handled after a later poll still finds none (PL-02), and read for checks on the idle
 *   rhythm only from then on.
 * - Rate limits: below `RATE_RESERVE` requests left, or when GitHub says stop (403/429, `retry-after`), the
 *   poller waits until the window resets; people's own actions keep the reserve.
 * - Every `OWNED_SYNC_MS` the scheduled tick reads which repositories each burrow's GitHub account owns, so one made on
 *   GitHub joins by itself (owned-repos.ts, agent-repos.md AGR-09).
 * - One poller per server, one cycle at a time (`pollNow` and the scheduled `pollDue` queue behind the running one);
 *   `stop()` waits for the cycle in flight. It skips everything while gh is not logged in.
 */
import { parseTopic } from '@whombat/core';
import { and, asc, count, eq, gt, inArray, isNull, max, or, sql } from 'drizzle-orm';
import { outsideCommandScope } from '../commit/scope';
import {
  automations,
  automationVersions,
  githubBranchHeads,
  githubDeploys,
  githubIdentities,
  githubIssues,
  githubPollCursors,
  githubPushGrants,
  githubSeen,
  prChecks,
  prCommits,
  principals,
  prReviewers,
  pullRequests,
  repos,
  runs,
} from '../db/schema/index';
import type { Clock } from '../lib/time';
import { githubScope } from '../managed/providers/github-adapter';
import type { BusFrame } from '../realtime/bus';
import { presenceFor } from '../realtime/presence-tracker';
import type { Services } from '../services';
import { pushGrantForSha, systemActor } from './actors';
import {
  type GhCommit,
  type GhPullRequest,
  type GitHubAdapter,
  GitHubError,
  GitHubNotConnectedError,
  GitHubRateLimitedError,
  prBranch,
} from './adapter';
import { OWNED_SYNC_MS, syncOwnedRepos } from './owned-repos';
import {
  AGENT_CHECKS_FAST_MS,
  type CadenceSignals,
  DEPLOY_FAST_MS,
  livelier,
  nextTickAt,
  type PollCadence,
  type PollCadences,
  type PollReason,
  PUSH_FAST_MS,
  pollCadence,
  pollCadences,
  pollDueAt,
  type RepoSchedule,
  refreshDue,
  TICK_SLACK_MS,
} from './poll-cadence';
import {
  checksDue,
  checksToMirror,
  deployRuns,
  formatNoChecks,
  type KnownPr,
  noChecksAfter,
  parseNoChecks,
  planPulls,
  pushCommits,
  readChecksNow,
  reviewsToMirror,
  sameSha,
} from './poll-plan';
import { followRepoRename } from './rename';
import type { GitHubService } from './service';

export { REFRESH_MS } from './poll-cadence';

/** Requests kept for people's own actions (merge, open PR) when the poller runs low. */
export const RATE_RESERVE = 200;
/** How far back an open PR's last activity may be for the poller to give it a branch room on first sight. */
export const LOOKBACK_MS = 14 * 24 * 60 * 60_000;
/** PRs opened per repo per cycle (the rest follow in the next cycles). */
export const MAX_OPENED = 20;
/**
 * How much earlier than the issues baseline GitHub may say an issue was opened and it still counts as new: clocks
 * differ (automation-recipes.md). The number has to be above the baseline's too.
 */
export const ISSUE_CLOCK_SLACK_MS = 60 * 60_000;
/** Wakes that come together run as one tick. */
/** The ETag of the repository's own answer (`followRename`). */
const REPO_ETAG = 'repo';
const WAKE_DEBOUNCE_MS = 250;
/**
 * How old a repo's last poll in its cursor (the GitHub status's `polledAt`) may get before a poll that changed nothing
 * else saves it: a busy repo is polled every 10 s, and the status needs the minute, not a write each time.
 */
export const POLLED_AT_EVERY_MS = 60_000;

const ZERO_SHA = '0'.repeat(40);

/** The stored ETag keys of a paged read (`<prefix><page>`), in page order. */
function pagedKeys(etags: Record<string, string>, prefix: string): string[] {
  return Object.keys(etags)
    .filter((k) => k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
}

export interface PollTarget {
  burrowId: string;
  repo: string;
  /** The burrow's repo row; null for a repo only watched for a deploy in flight. */
  repoId: string | null;
  defaultBranch: string;
  /** `all` for switched-on repos; `deploys` for a repo only watched for a deploy in flight. */
  phases: 'all' | 'deploys';
}

export interface PollReport {
  repos: number;
  changes: number;
  skipped: 'off' | 'not_connected' | 'rate_limited' | null;
  errors: string[];
}

/** One repo in the schedule, with why it has its cadence. */
export interface RepoPlan extends RepoSchedule {
  burrowId: string;
  repo: string;
  reason: PollReason;
}

type Cursor = typeof githubPollCursors.$inferSelect;

/** The repos of a burrow (lowercase) whose new issues an automation listens to (`GitHubPoller.issueRepos`). */
type IssueRepos = (burrowId: string) => Promise<Set<string>>;

/** Whether saving `set` changes what the cursor says (its ETags, error, issue watch, refresh). */
function changesCursor(cursor: Cursor, set: Partial<Cursor>): boolean {
  return (Object.keys(set) as (keyof Cursor)[]).some((key) => !sameValue(cursor[key], set[key]));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date)
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    // ETags by key: Postgres keeps a jsonb object's keys in its own order.
    const entries = Object.entries(a);
    return (
      entries.length === Object.keys(b).length &&
      entries.every(([key, value]) => (b as Record<string, unknown>)[key] === value)
    );
  }
  return a === b;
}

/** The cursor's last poll is less than `POLLED_AT_EVERY_MS` before `now` (a clock that went back counts as old). */
function recentlyPolled(cursor: Cursor, now: Date): boolean {
  const age = cursor.polledAt ? now.getTime() - cursor.polledAt.getTime() : Number.POSITIVE_INFINITY;
  return age >= 0 && age < POLLED_AT_EVERY_MS;
}

const planKey = (burrowId: string, repo: string) => `${burrowId}\u0000${repo}`;

export class GitHubPoller {
  private timer: NodeJS.Timeout | null = null;
  /** When the armed timer fires (wall clock). */
  private timerAt = 0;
  /** A scheduled tick is running; a wake meanwhile asks for the next one soon (`kicked`). */
  private ticking = false;
  private kicked = false;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = true;
  /** `stop()` was called: a cycle in flight ends after the repo it is on. */
  private closing = false;
  private backoffUntil = 0;
  private lastProblem: string | null = null;
  private offBus: (() => void) | null = null;
  private offPresence: (() => void) | null = null;
  /** Each repo's last poll, cadence and wake (PL-01), by `planKey`. */
  private readonly plans = new Map<string, RepoPlan>();
  /** Repo id → `planKey` (a run names its repo by id). */
  private readonly repoKeys = new Map<string, string>();
  /** When each burrow's own repositories were last read (the poller's clock), by burrow id. */
  private readonly ownedAt = new Map<string, number>();
  /** Runs seen live on the bus, and merged PRs: each wakes once. */
  private readonly liveRuns = new Set<string>();
  private readonly mergedPrs = new Set<string>();
  /** Someone is active in a connected burrow (the last tick's look): the next tick is no further than the active cadence. */
  private anyoneActive = false;
  private readonly clock: Clock;
  readonly cadences: PollCadences;
  /** How soon after `start` the first tick runs (at most the active cadence). */
  private readonly firstTickMs: number;
  /** How often a scheduled tick reads each burrow's own repositories (0: never). */
  private readonly ownedEveryMs: number;

  constructor(
    private readonly services: Services,
    private readonly github: GitHubService,
    /**
     * Tests: a clock to step through time, cadences other than the configuration's, a sooner first tick than 2 s
     * (test-speed.md TS-S09), and the account's repositories read at another interval or never (0), so a test counts
     * only the repos' own reads.
     */
    options: { clock?: Clock; cadences?: PollCadences; firstTickMs?: number; ownedEveryMs?: number } = {},
  ) {
    this.clock = options.clock ?? (() => this.services.clock());
    this.cadences = options.cadences ?? pollCadences(services.config);
    this.firstTickMs = options.firstTickMs ?? 2_000;
    this.ownedEveryMs = options.ownedEveryMs ?? OWNED_SYNC_MS;
  }

  private get adapter(): GitHubAdapter | null {
    return this.github.adapter;
  }

  private now(): number {
    return this.clock().getTime();
  }

  /**
   * Polls each repo on its cadence (the first tick soon after start) and listens on the bus for what wakes it. No-op
   * when GitHub is off or `WHOMBAT_GITHUB_POLL_MS` is 0.
   */
  start(): void {
    if (this.timer || !this.stopped || !this.adapter || this.cadences.active <= 0) return;
    this.stopped = false;
    this.closing = false;
    this.listen();
    this.arm(Math.min(this.cadences.active, this.firstTickMs));
  }

  /** Listens on the bus for what wakes repos (`start` does; tests listen without the timer). */
  listen(): void {
    this.offBus ??= this.services.bus.onFrame((frame) => this.onFrame(frame));
    // The person coming back to a screen (one-person.md OP-S14: the box's own record of their connections).
    this.offPresence ??= presenceFor(this.services).onActive((burrowId) => this.personActive(burrowId));
  }

  /** Stops the timer and the bus listener, and waits for the cycle in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.closing = true;
    this.offBus?.();
    this.offBus = null;
    this.offPresence?.();
    this.offPresence = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.idle();
  }

  /** Resolves once no cycle is running or queued. */
  async idle(): Promise<void> {
    for (;;) {
      const current = this.chain;
      await current.catch(() => {});
      if (current === this.chain) return;
    }
  }

  private arm(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, delay);
    this.timerAt = Date.now() + wait;
    // `wake` comes from commands (a push token, a deploy): the tick commits as itself, outside that command's scope.
    this.timer = outsideCommandScope(() =>
      setTimeout(() => {
        this.timer = null;
        void this.tick();
      }, wait),
    );
    this.timer.unref?.();
  }

  /** One scheduled tick: the repos that are due, then the timer for the next one. */
  private async tick(): Promise<void> {
    this.ticking = true;
    this.kicked = false;
    let delay = this.cadences.active;
    try {
      // Draining (MR-15), or a lapsed licence (LC-10): the poller rests until the resume.
      if (!(this.services.maintenance.paused || this.services.licence.lapsed)) {
        const report = await this.pollDue();
        if (!report.skipped) delay = this.nextDueAt() - this.now();
      }
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'github poll failed');
    } finally {
      this.ticking = false;
      this.arm(this.kicked ? WAKE_DEBOUNCE_MS : delay);
    }
  }

  /** Something woke the poller: the next tick soon (a scheduled poller only; tests and scripts poll by hand). */
  private kick(): void {
    if (this.stopped) return;
    if (this.ticking) this.kicked = true;
    else if (!this.timer || this.timerAt - Date.now() > WAKE_DEBOUNCE_MS) this.arm(WAKE_DEBOUNCE_MS);
  }

  /**
   * A change in a repo that should be seen at once (PL-01): a push token handed out, a deploy dispatched, a repo added
   * or switched on. The repo is read in the next tick (a repo not polled yet is due anyway), and its cadence is decided
   * again after that read.
   */
  wake(burrowId: string, repo: string): void {
    const plan = this.plans.get(planKey(burrowId, repo));
    if (plan) plan.wokenAt = this.now();
    this.kick();
  }

  /** `wake` by the repo's id (a run names its repo so). */
  private wakeRepoId(repoId: string): void {
    const key = this.repoKeys.get(repoId);
    const plan = key ? this.plans.get(key) : undefined;
    if (plan) plan.wokenAt = this.now();
    this.kick();
  }

  /** A person of the burrow became active: its repos are read at least on the active cadence from now. */
  private personActive(burrowId: string): void {
    for (const plan of this.plans.values())
      if (plan.burrowId === burrowId && plan.cadence === 'idle') {
        plan.cadence = livelier(plan.cadence, 'active');
        plan.reason = 'person';
      }
    this.anyoneActive = true;
    this.kick();
  }

  /** What on the bus wakes the poller: a run going live, a merge (after their commit). */
  private onFrame(frame: BusFrame): void {
    const event = frame.event;
    if (event.type === 'run.updated') {
      const run = event.run;
      if (run.status !== 'live') this.liveRuns.delete(run.id);
      else if (!this.liveRuns.has(run.id)) {
        this.liveRuns.add(run.id);
        if (run.repoId) this.wakeRepoId(run.repoId);
      }
    } else if (event.type === 'pr.updated') {
      const topic = parseTopic(frame.topic);
      if (event.pr.state !== 'merged' || topic?.kind !== 'burrow' || this.mergedPrs.has(event.pr.id)) return;
      if (this.mergedPrs.size > 1000) this.mergedPrs.clear();
      this.mergedPrs.add(event.pr.id);
      this.wake(topic.id, event.pr.repoFullName);
    }
  }

  /** When the next repo is due (the poller's clock), at most the idle cadence away (the active one while someone is). */
  nextDueAt(): number {
    const now = this.now();
    const dues = [...this.plans.values()].map((p) => pollDueAt(p, this.cadences));
    return nextTickAt(now, dues, this.anyoneActive ? this.cadences.active : this.cadences.idle);
  }

  /** A repo's place in the schedule (tests, logs). */
  planOf(burrowId: string, repo: string): RepoPlan | null {
    return this.plans.get(planKey(burrowId, repo)) ?? null;
  }

  /** Runs a cycle over every repo now, after the one in flight (the demo, tests, "Sync repos"). */
  pollNow(filter: { burrowId?: string } = {}): Promise<PollReport> {
    return this.enqueue(() => this.cycle(filter, false));
  }

  /** Runs a cycle over the repos that are due by their cadence or a wake (the scheduled tick). */
  pollDue(): Promise<PollReport> {
    return this.enqueue(() => this.cycle({}, true));
  }

  private enqueue(run: () => Promise<PollReport>): Promise<PollReport> {
    const next = this.chain.catch(() => {}).then(run);
    this.chain = next;
    return next;
  }

  private problem(message: string | null): void {
    if (message && message !== this.lastProblem)
      this.services.log.warn({ problem: message }, 'github poller');
    else if (!message && this.lastProblem) this.services.log.info({}, 'github poller: working again');
    this.lastProblem = message;
  }

  private async cycle(filter: { burrowId?: string }, dueOnly: boolean): Promise<PollReport> {
    const report: PollReport = { repos: 0, changes: 0, skipped: null, errors: [] };
    const adapter = this.adapter;
    if (!adapter) return { ...report, skipped: 'off' };
    // Rate-limit windows are GitHub's wall clock, not the burrow's.
    const wall = Date.now();
    if (wall < this.backoffUntil) return { ...report, skipped: 'rate_limited' };
    // Each burrow's repos are read as the person who connected it (checked per repo), not one host account.
    const rate = adapter.rateLimit();
    if (rate.remaining !== null && rate.remaining < RATE_RESERVE && rate.resetAt && rate.resetAt > wall) {
      this.backoffUntil = rate.resetAt;
      this.problem(`GitHub rate limit low (${rate.remaining} left): waiting until the window resets.`);
      return { ...report, skipped: 'rate_limited' };
    }
    // Read once per cycle: the connected burrows, and per burrow the repos whose issues automations listen to.
    const connected = await this.github.connectedBurrowIds();
    if (dueOnly && !filter.burrowId && this.ownedEveryMs > 0) await this.bringInOwned(connected);
    const { targets, burrowIds } = await this.targetsAndBurrows(filter, connected);
    const issueRepos = this.issueReposOnce();
    if (!filter.burrowId) this.forget(targets);
    if (!filter.burrowId) this.anyoneActive = burrowIds.some((id) => this.someoneActive(id));
    const now = this.now();
    for (const target of targets) {
      if (this.closing) break;
      const key = planKey(target.burrowId, target.repo);
      if (target.repoId) this.repoKeys.set(target.repoId, key);
      const plan = this.plans.get(key);
      if (dueOnly && plan && pollDueAt(plan, this.cadences) > now + TICK_SLACK_MS) continue;
      report.repos++;
      const startedAt = this.now();
      try {
        const res = await githubScope.run({ burrowId: target.burrowId }, () =>
          this.syncRepo(adapter, target, plan?.cadence ?? 'idle', issueRepos),
        );
        report.changes += res.changes;
        for (const message of res.errors) {
          report.errors.push(`${target.repo}: ${message}`);
          this.services.log.warn(
            { burrowId: target.burrowId, repo: target.repo, err: message },
            'github poll',
          );
        }
      } catch (err) {
        if (err instanceof GitHubRateLimitedError) {
          this.backoffUntil = err.until;
          this.problem(err.message);
          return { ...report, skipped: 'rate_limited' };
        }
        if (err instanceof GitHubNotConnectedError) {
          this.github.forgetConnection();
          this.problem(err.message);
          return { ...report, skipped: 'not_connected' };
        }
        const message = err instanceof Error ? err.message : String(err);
        report.errors.push(`${target.repo}: ${message}`);
        this.services.log.warn({ burrowId: target.burrowId, repo: target.repo, err: message }, 'github poll');
      }
      await this.plan(target, key, startedAt);
    }
    if (!report.errors.length) this.problem(null);
    return report;
  }

  /**
   * The repositories each connected burrow's GitHub account owns join it, read again every `ownedEveryMs` (AGR-09),
   * signed by GitHub. A failure is logged and tried again then; the repos' own polls go on.
   */
  private async bringInOwned(connected: readonly string[]): Promise<void> {
    for (const burrowId of connected) {
      if (this.closing) return;
      const at = this.ownedAt.get(burrowId);
      if (at !== undefined && this.now() - at < this.ownedEveryMs) continue;
      this.ownedAt.set(burrowId, this.now());
      try {
        const actor = await systemActor(this.services, burrowId);
        await syncOwnedRepos(this.services, burrowId, actor.principalId);
      } catch (err) {
        if (err instanceof GitHubRateLimitedError) this.backoffUntil = err.until;
        this.services.log.warn(
          { burrowId, err: String(err) },
          'github: could not bring in the account’s repositories',
        );
      }
    }
  }

  /** Decides a repo's cadence after polling it; a wake that came in meanwhile stands. */
  private async plan(target: PollTarget, key: string, polledAt: number): Promise<void> {
    const before = this.plans.get(key);
    // Asked now, not when the cycle began: a person who came back during the read counts.
    const personActive = this.someoneActive(target.burrowId);
    let decided: { cadence: PollCadence; reason: PollReason };
    try {
      decided = pollCadence({ ...(await this.signals(target)), personActive });
    } catch (err) {
      this.services.log.warn({ repo: target.repo, err: String(err) }, 'github poll: cadence');
      decided = { cadence: personActive ? 'active' : 'idle', reason: personActive ? 'person' : 'quiet' };
    }
    const woken = before?.wokenAt ?? null;
    const wokenAt = woken !== null && woken > polledAt ? woken : null;
    this.plans.set(key, {
      burrowId: target.burrowId,
      repo: target.repo,
      polledAt,
      wokenAt,
      ...decided,
    });
  }

  /** A person of the burrow is active (the presence tracker). */
  private someoneActive(burrowId: string): boolean {
    return presenceFor(this.services).activeIn(burrowId);
  }

  /** Repos that are no targets any more leave the schedule. */
  private forget(targets: readonly PollTarget[]): void {
    const keep = new Set(targets.map((t) => planKey(t.burrowId, t.repo)));
    for (const key of this.plans.keys()) if (!keep.has(key)) this.plans.delete(key);
    for (const [id, key] of this.repoKeys) if (!keep.has(key)) this.repoKeys.delete(id);
  }

  /**
   * What makes a repo fast (PL-01, `CadenceSignals`), in one statement: a live run that needs no person, a push token
   * handed out in the last 10 minutes, a deploy in flight dispatched in the last hour, an agent's open pull request whose
   * head's checks aren't handled yet and that moved in the last hour.
   */
  private async signals(t: PollTarget): Promise<Omit<CadenceSignals, 'personActive'>> {
    const now = this.now();
    const at = (ms: number) => new Date(ms).toISOString();
    const [row] = await this.services.db.execute<{
      run: boolean;
      push: boolean;
      deploy: boolean;
      checks: boolean;
    }>(sql`
      select
        ${
          t.repoId
            ? sql`exists (select 1 from ${runs} r where r.repo_id = ${t.repoId} and r.status = 'live' and r.attention is null)`
            : sql`false`
        } as run,
        exists (select 1 from ${githubPushGrants} g where g.burrow_id = ${t.burrowId} and g.repo = ${t.repo}
          and g.issued_at > ${at(now - PUSH_FAST_MS)}::timestamptz and g.expires_at > ${at(now)}::timestamptz) as push,
        exists (select 1 from ${githubDeploys} d where d.burrow_id = ${t.burrowId} and d.repo = ${t.repo}
          and d.state in ('dispatched', 'running') and d.dispatched_at > ${at(now - DEPLOY_FAST_MS)}::timestamptz) as deploy,
        ${
          t.repoId
            ? sql`exists (select 1 from ${pullRequests} p join ${principals} a on a.id = p.author_id
          where p.repo_id = ${t.repoId} and p.state = 'open' and not p.local_only
            and a.kind = 'agent' and a.system is null
            and p.updated_at > ${at(now - AGENT_CHECKS_FAST_MS)}::timestamptz
            and (p.checks_handled_sha is null
              or not (starts_with(p.head_sha, p.checks_handled_sha) or starts_with(p.checks_handled_sha, p.head_sha))))`
            : sql`false`
        } as checks`);
    return {
      liveRun: !!row?.run,
      freshPush: !!row?.push,
      deploy: !!row?.deploy,
      agentChecks: !!row?.checks,
    };
  }

  /** Switched-on repos of connected burrows, then repos with a deploy in flight. */
  async targets(filter: { burrowId?: string } = {}): Promise<PollTarget[]> {
    return (await this.targetsAndBurrows(filter)).targets;
  }

  private async targetsAndBurrows(
    filter: { burrowId?: string } = {},
    /** The connected burrows, when the cycle already read them. */
    connected?: readonly string[],
  ): Promise<{ targets: PollTarget[]; burrowIds: string[] }> {
    const db = this.services.db;
    const burrowIds = (connected ?? (await this.github.connectedBurrowIds())).filter(
      (id) => !filter.burrowId || id === filter.burrowId,
    );
    const out: PollTarget[] = [];
    if (burrowIds.length) {
      const rows = await db
        .select()
        .from(repos)
        // Repos created on the Whombat have nothing on GitHub to poll (repositories.md RP-05).
        .where(and(inArray(repos.burrowId, burrowIds), eq(repos.enabled, true), eq(repos.source, 'github')))
        .orderBy(asc(repos.burrowId), asc(repos.position));
      for (const r of rows)
        if (await this.github.hasRepo(r.fullName))
          out.push({
            burrowId: r.burrowId,
            repo: r.fullName,
            repoId: r.id,
            defaultBranch: r.defaultBranch,
            phases: 'all',
          });
    }
    const deploys = await db
      .select({ burrowId: githubDeploys.burrowId, repo: githubDeploys.repo })
      .from(githubDeploys)
      .where(inArray(githubDeploys.state, ['dispatched', 'running']));
    for (const d of deploys) {
      if (filter.burrowId && d.burrowId !== filter.burrowId) continue;
      if (out.some((t) => t.burrowId === d.burrowId && t.repo === d.repo)) continue;
      out.push({
        burrowId: d.burrowId,
        repo: d.repo,
        repoId: null,
        defaultBranch: 'main',
        phases: 'deploys',
      });
    }
    return { targets: out, burrowIds };
  }

  /* One repo of one burrow --------------------------------------------------------------------- */

  private async cursor(t: PollTarget): Promise<Cursor> {
    const where = and(eq(githubPollCursors.burrowId, t.burrowId), eq(githubPollCursors.repo, t.repo));
    const [row] = await this.services.db.select().from(githubPollCursors).where(where);
    if (row) return row;
    // First sight: the PRs the burrow has now are known, closed ones too (reopened later, their older
    // reviews are still history).
    const had = await this.services.db
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(and(eq(pullRequests.burrowId, t.burrowId), eq(repos.fullName, t.repo)));
    const now = this.clock();
    await this.services.pipeline.transactAccount((tx) =>
      tx
        .insert(githubPollCursors)
        .values({
          burrowId: t.burrowId,
          repo: t.repo,
          baselineAt: now,
          etags: {},
          knownPrs: had.map((p) => p.number).sort((a, b) => a - b),
          refreshedAt: now,
        })
        .onConflictDoNothing(),
    );
    const [created] = await this.services.db.select().from(githubPollCursors).where(where);
    if (!created) throw new Error('github poll cursor vanished');
    return created;
  }

  private async saveCursor(t: PollTarget, set: Partial<Cursor>): Promise<void> {
    await this.services.pipeline.transactAccount((tx) =>
      tx
        .update(githubPollCursors)
        .set(set)
        .where(and(eq(githubPollCursors.burrowId, t.burrowId), eq(githubPollCursors.repo, t.repo))),
    );
  }

  /**
   * Reads one repo for one burrow and mirrors what changed. Returns the number of changes applied and what
   * failed on single PRs (the rest of the repo is still read). The refresh without ETags counts as done
   * even when part of it failed: one bad PR must not make every read unconditional. `cadence`: the repo's
   * cadence when this poll started (the refresh waits for the idle one, PL-01).
   */
  async syncRepo(
    adapter: GitHubAdapter,
    t: PollTarget,
    cadence: PollCadence = 'idle',
    issueRepos: IssueRepos = (burrowId) => this.issueRepos(burrowId),
  ): Promise<{ changes: number; errors: string[] }> {
    const cursor = await this.cursor(t);
    const now = this.clock();
    const force = refreshDue({
      refreshedAt: cursor.refreshedAt?.getTime() ?? null,
      now: now.getTime(),
      cadence,
    });
    const old = force ? {} : cursor.etags;
    const next: Record<string, string> = {};
    const errors: string[] = [];
    let changes = 0;
    let issues: Partial<Cursor> = {};
    try {
      if (t.phases === 'all' && t.repoId && (await this.followRename(adapter, t, cursor, next)))
        // Renamed with its cursor: the next cycle reads it by its new name.
        return { changes: 1, errors };
      if (t.phases === 'all') {
        changes += await this.syncPulls(adapter, t, cursor, old, next);
        const read = await this.syncIssues(adapter, t, cursor, old, next, issueRepos);
        changes += read.changes;
        issues = read.cursor;
        changes += await this.syncPrDetails(adapter, t, cursor, old, next, errors, force);
        changes += await this.syncBranches(adapter, t, old, next);
      }
      changes += await this.syncDeploys(adapter, t, old, next);
    } catch (err) {
      // Keep what this cycle learned; the rest is read again next time.
      await this.saveCursor(t, {
        ...issues,
        etags: { ...cursor.etags, ...next },
        polledAt: now,
        error: [...errors, err instanceof Error ? err.message : String(err)].join('; ').slice(0, 1000),
        ...(force ? { refreshedAt: now } : {}),
      });
      throw err;
    }
    const set: Partial<Cursor> = {
      ...issues,
      etags: next,
      error: errors.length ? errors.join('; ').slice(0, 1000) : null,
      ...(force ? { refreshedAt: now } : {}),
    };
    // A poll that changed nothing (every answer a 304) saves only when the last poll it says is a minute old.
    if (changesCursor(cursor, set) || !recentlyPolled(cursor, now))
      await this.saveCursor(t, { ...set, polledAt: now });
    return { changes, errors };
  }

  /**
   * Whether GitHub names the repository differently now (renamed, or moved to another owner; agent-repos.md AGR-15),
   * and then renames it here with what names it. One read, conditional on the last answer's ETag even in a refresh: a
   * 304 is the name checked then, and costs no rate limit.
   */
  private async followRename(
    adapter: GitHubAdapter,
    t: PollTarget,
    cursor: Cursor,
    next: Record<string, string>,
  ): Promise<boolean> {
    const etag = cursor.etags[REPO_ETAG] ?? null;
    const res = await adapter.repoInfo(t.repo, etag);
    if (!res.modified) {
      if (etag) next[REPO_ETAG] = etag;
      return false;
    }
    if (res.etag) next[REPO_ETAG] = res.etag;
    if (!t.repoId || res.data.fullName.toLowerCase() === t.repo.toLowerCase()) return false;
    const out = await followRepoRename(this.services, {
      burrowId: t.burrowId,
      repoId: t.repoId,
      fullName: res.data.fullName,
      githubRepoId: res.data.id,
    });
    return 'from' in out;
  }

  /** Keeps an unchanged answer's ETag for the next cycle. */
  private keep(old: Record<string, string>, next: Record<string, string>, key: string): void {
    const etag = old[key];
    if (etag) next[key] = etag;
  }

  private async knownPrs(t: PollTarget): Promise<KnownPr[]> {
    const db = this.services.db;
    const rows = await db
      .select({ pr: pullRequests })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(and(eq(pullRequests.burrowId, t.burrowId), eq(repos.fullName, t.repo)));
    const ids = rows.map((r) => r.pr.id);
    const reviewers = ids.length
      ? await db
          .select({ prId: prReviewers.prId, login: githubIdentities.login })
          .from(prReviewers)
          .innerJoin(
            githubIdentities,
            and(
              eq(githubIdentities.principalId, prReviewers.principalId),
              eq(githubIdentities.burrowId, t.burrowId),
            ),
          )
          .where(inArray(prReviewers.prId, ids))
      : [];
    const commits = ids.length
      ? await db
          .select({ prId: prCommits.prId, n: count() })
          .from(prCommits)
          .where(inArray(prCommits.prId, ids))
          .groupBy(prCommits.prId)
      : [];
    return rows.map(({ pr }) => ({
      number: pr.number,
      state: pr.state,
      headSha: pr.headSha,
      title: pr.title,
      branch: pr.branch,
      baseBranch: pr.baseBranch,
      reviewerLogins: reviewers.filter((r) => r.prId === pr.id).map((r) => r.login),
      localOnly: pr.localOnly,
      commits: commits.find((c) => c.prId === pr.id)?.n ?? 0,
      draft: pr.draft,
    }));
  }

  /**
   * Repos of the burrow (lowercase) that a live automation listens to with new issues: published and not deleted, with
   * an `issue_opened` trigger in its current version (automation-recipes.md). Only those have their issues read.
   */
  private async issueRepos(burrowId: string): Promise<Set<string>> {
    const rows = await this.services.db
      .select({ definition: automationVersions.definition })
      .from(automations)
      .innerJoin(
        automationVersions,
        and(
          eq(automationVersions.automationId, automations.id),
          eq(automationVersions.n, automations.currentVersion),
        ),
      )
      .where(
        and(
          eq(automations.burrowId, burrowId),
          eq(automations.status, 'published'),
          isNull(automations.deletedAt),
          sql`exists (select 1 from jsonb_array_elements(${automationVersions.definition} -> 'triggers') as t
            where t ->> 'kind' = 'github' and t ->> 'event' = 'issue_opened')`,
        ),
      );
    const out = new Set<string>();
    for (const { definition } of rows)
      for (const t of definition.triggers)
        if (t.kind === 'github' && t.event === 'issue_opened') out.add(t.repo.toLowerCase());
    return out;
  }

  /**
   * `issueRepos` read at most once per burrow (a cycle's): every repo of the burrow asks the same. A failed read is
   * asked again by the next repo.
   */
  private issueReposOnce(): IssueRepos {
    const read = new Map<string, Promise<Set<string>>>();
    return (burrowId) => {
      let found = read.get(burrowId);
      if (!found) {
        found = this.issueRepos(burrowId);
        read.set(burrowId, found);
        found.catch(() => read.delete(burrowId));
      }
      return found;
    };
  }

  /**
   * New issues of a repo an automation listens to (automation-recipes.md): one conditional read of the open issues
   * (newest 50). The first read is the baseline — what is open then, and every number up to the highest known, never
   * starts anything; after it, an issue with a higher number that GitHub says was opened since is mirrored once
   * (`github_issues`, its signed `issue.opened`). When nothing listens any more the watch ends, and the next one starts
   * with a new baseline (issues opened meanwhile are history). Returns the changes and what the cursor keeps.
   */
  private async syncIssues(
    adapter: GitHubAdapter,
    t: PollTarget,
    cursor: Cursor,
    old: Record<string, string>,
    next: Record<string, string>,
    issueRepos: IssueRepos,
  ): Promise<{ changes: number; cursor: Partial<Cursor> }> {
    if (!(await issueRepos(t.burrowId)).has(t.repo.toLowerCase()))
      return { changes: 0, cursor: cursor.issuesSince ? { issuesSince: null, issuesAfter: null } : {} };
    const key = 'issues:1';
    const since = cursor.issuesSince;
    const res = await adapter.openIssues(t.repo, since ? (old[key] ?? null) : null);
    if (!res.modified) {
      this.keep(old, next, key);
      return { changes: 0, cursor: {} };
    }
    if (!since) {
      // The baseline: nothing that exists now is new. Pull requests share the numbers, so the highest known counts too.
      const [known] = await this.services.db
        .select({ n: max(pullRequests.number) })
        .from(pullRequests)
        .innerJoin(repos, eq(repos.id, pullRequests.repoId))
        .where(and(eq(pullRequests.burrowId, t.burrowId), eq(repos.fullName, t.repo)));
      const after = Math.max(0, Number(known?.n ?? 0), ...res.data.map((i) => i.number));
      if (res.etag) next[key] = res.etag;
      return { changes: 0, cursor: { issuesSince: this.clock(), issuesAfter: after } };
    }
    const after = cursor.issuesAfter ?? 0;
    const from = since.getTime() - ISSUE_CLOCK_SLACK_MS;
    const candidates = res.data.filter(
      (i) => i.number > after && (i.createdAt === null || Date.parse(i.createdAt) >= from),
    );
    const stored = candidates.length
      ? await this.services.db
          .select({ number: githubIssues.number })
          .from(githubIssues)
          .where(
            and(
              eq(githubIssues.burrowId, t.burrowId),
              eq(githubIssues.repo, t.repo),
              inArray(
                githubIssues.number,
                candidates.map((i) => i.number),
              ),
            ),
          )
      : [];
    const have = new Set(stored.map((r) => r.number));
    const fresh = candidates.filter((i) => !have.has(i.number)).sort((a, b) => a.number - b.number);
    let changes = 0;
    for (const issue of fresh.slice(0, MAX_OPENED))
      if (await this.github.sync.issue(t.burrowId, t.repo, issue)) changes++;
    // More than one cycle mirrors: no ETag, so the next cycle reads the list again.
    if (fresh.length <= MAX_OPENED && res.etag) next[key] = res.etag;
    return { changes, cursor: {} };
  }

  /** GitHub has no PR with this number: the burrow's is Whombat's own from now on (operational, unsigned). */
  private async markLocalOnly(t: PollTarget, number: number): Promise<void> {
    const [repo] = await this.services.db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.burrowId, t.burrowId), eq(repos.fullName, t.repo)));
    if (!repo) return;
    await this.services.pipeline.transactAccount((tx) =>
      tx
        .update(pullRequests)
        .set({ localOnly: true })
        .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.number, number))),
    );
  }

  /** Open PRs: new ones get a branch room, pushes move heads, edits, merges, closes and reopens. */
  private async syncPulls(
    adapter: GitHubAdapter,
    t: PollTarget,
    cursor: Cursor,
    old: Record<string, string>,
    next: Record<string, string>,
  ): Promise<number> {
    const keys = pagedKeys(old, 'pulls:');
    const res = await adapter.openPullRequests(
      t.repo,
      keys.map((k) => old[k] ?? ''),
    );
    if (!res.modified) {
      for (const k of keys) this.keep(old, next, k);
      return 0;
    }
    const sync = this.github.sync;
    const linked = await this.services.db
      .select({ login: githubIdentities.login })
      .from(githubIdentities)
      .where(eq(githubIdentities.burrowId, t.burrowId));
    const plan = planPulls(await this.knownPrs(t), res.data, {
      since: cursor.baselineAt.getTime() - LOOKBACK_MS,
      maxOpened: MAX_OPENED,
      linkedLogins: new Set(linked.map((l) => l.login.toLowerCase())),
    });
    let changes = 0;
    for (const pr of plan.opened) {
      const [commits, files] = await Promise.all([
        adapter.listPullRequestCommits(t.repo, pr.number).catch(() => null),
        adapter.listPullRequestFiles(t.repo, pr.number).catch(() => null),
      ]);
      await sync.pullRequest(t.burrowId, t.repo, 'opened', pr, { commits, files });
      changes++;
    }
    for (const { pr, before } of plan.headMoved) {
      const [commits, files] = await Promise.all([
        adapter.listPullRequestCommits(t.repo, pr.number),
        adapter.listPullRequestFiles(t.repo, pr.number).catch(() => null),
      ]);
      const actor = await sync.push(t.burrowId, t.repo, {
        branch: prBranch(pr),
        before,
        after: pr.headSha,
        commits: pushCommits(commits, before),
        prNumber: pr.number,
        fork: pr.fork !== null,
      });
      await sync.pullRequest(t.burrowId, t.repo, 'synchronize', pr, { commits, files, actor });
      changes++;
    }
    for (const pr of plan.edited) {
      await sync.pullRequest(
        t.burrowId,
        t.repo,
        pr.requestedReviewers.length ? 'review_requested' : 'edited',
        pr,
      );
      changes++;
    }
    for (const pr of plan.refresh) {
      const [commits, files] = await Promise.all([
        adapter.listPullRequestCommits(t.repo, pr.number).catch((): GhCommit[] => []),
        adapter.listPullRequestFiles(t.repo, pr.number).catch(() => null),
      ]);
      if (!commits.length) continue; // nothing to add yet: asked again when the list changes
      await sync.pullRequest(t.burrowId, t.repo, 'edited', pr, { commits, files });
      changes++;
    }
    if (plan.collisions.length)
      this.services.log.warn(
        { burrowId: t.burrowId, repo: t.repo, numbers: plan.collisions },
        'github poll: GitHub PRs numbered like PRs only Whombat has are not mirrored',
      );
    for (const pr of plan.reopened) {
      await sync.pullRequest(t.burrowId, t.repo, 'reopened', pr);
      changes++;
    }
    for (const number of plan.vanished) {
      let pr: GhPullRequest;
      try {
        pr = await adapter.getPullRequest(t.repo, number);
      } catch (err) {
        // Not a GitHub PR (opened in Whombat before the burrow was connected): left alone from now on.
        if (err instanceof GitHubError && err.status === 404) {
          await this.markLocalOnly(t, number);
          continue;
        }
        throw err;
      }
      if (pr.state !== 'closed') continue; // open after all (the list moved under us): next cycle
      const closedBy = pr.merged ? null : await adapter.closedBy(t.repo, number).catch(() => null);
      await sync.pullRequest(t.burrowId, t.repo, 'closed', pr, { closedBy });
      changes++;
    }
    // More PRs to open than one cycle opens: no ETag, so the next cycle reads the list again.
    if (!plan.truncated) for (const [i, etag] of res.etags.entries()) if (etag) next[`pulls:${i + 1}`] = etag;
    return changes;
  }

  /**
   * Check runs and reviews on every open PR's head (PRs only Whombat has are not on GitHub). A PR GitHub
   * refuses is skipped (its ETags kept, its error reported) and the others are still read.
   */
  private async syncPrDetails(
    adapter: GitHubAdapter,
    t: PollTarget,
    cursor: Cursor,
    old: Record<string, string>,
    next: Record<string, string>,
    errors: string[],
    refresh: boolean,
  ): Promise<number> {
    const open = await this.services.db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        headSha: pullRequests.headSha,
        checksHandledSha: pullRequests.checksHandledSha,
      })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.burrowId, t.burrowId),
          eq(repos.fullName, t.repo),
          eq(pullRequests.state, 'open'),
          eq(pullRequests.localOnly, false),
        ),
      )
      .orderBy(asc(pullRequests.number));
    const known = new Set(cursor.knownPrs);
    let changes = 0;
    for (const pr of open) {
      const mine = (k: string) =>
        k.startsWith(`checks:${pr.number}:`) || k.startsWith(`reviews:${pr.number}:`);
      const before = new Set(Object.keys(next));
      try {
        changes += await this.prDetails(adapter, t, cursor, known, old, next, pr, refresh);
      } catch (err) {
        if (err instanceof GitHubRateLimitedError || err instanceof GitHubNotConnectedError) throw err;
        // Read again next cycle: this PR's ETags stay what they were.
        for (const k of Object.keys(next)) if (mine(k) && !before.has(k)) delete next[k];
        for (const k of Object.keys(old)) if (mine(k)) this.keep(old, next, k);
        errors.push(`PR #${pr.number}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return changes;
  }

  /** One open PR's check runs and reviews; a finished round wakes the agent whose work the PR is. */
  private async prDetails(
    adapter: GitHubAdapter,
    t: PollTarget,
    cursor: Cursor,
    knownPrs: ReadonlySet<number>,
    old: Record<string, string>,
    next: Record<string, string>,
    pr: { id: string; number: number; headSha: string; checksHandledSha: string | null },
    refresh: boolean,
  ): Promise<number> {
    const db = this.services.db;
    const sync = this.github.sync;
    const now = this.now();
    let changes = 0;
    let checksChanged = false;
    // Per PR: two open PRs on one head each need their own first read (checks are stored per PR).
    const checksKey = `checks:${pr.number}:${pr.headSha}`;
    // A head without check runs (PL-02): when the answers were empty since, and when it was last asked.
    const noneKey = `${checksKey}:none`;
    const none = parseNoChecks(cursor.etags[noneKey]);
    let handled = !!pr.checksHandledSha && sameSha(pr.checksHandledSha, pr.headSha);
    let answer: 'runs' | 'empty' | 'unchanged' | null = null;
    if (readChecksNow({ handled, none, now, recheckMs: this.cadences.idle, refresh })) {
      const runs = await adapter.checkRuns(t.repo, pr.headSha, old[checksKey] ?? null);
      if (runs.modified) {
        answer = runs.data.length ? 'runs' : 'empty';
        // Runs on a head handled as one without checks: their round is news after all (PL-02).
        if (answer === 'runs' && handled && none) {
          await this.setChecksHandled(pr, null);
          handled = false;
        }
        const known = await db.select().from(prChecks).where(eq(prChecks.prId, pr.id));
        for (const { check, headSha } of checksToMirror(known, runs.data)) {
          await sync.check(t.burrowId, t.repo, pr.number, headSha, check);
          changes++;
          checksChanged = true;
        }
        if (runs.etag) next[checksKey] = runs.etag;
      } else {
        answer = 'unchanged';
        this.keep(old, next, checksKey);
      }
    } else {
      // Handled without checks and asked recently: asked again on the idle rhythm.
      this.keep(old, next, checksKey);
      if (none) next[noneKey] = formatNoChecks(none);
    }
    if (answer) {
      const after = noChecksAfter({ answer, none, handled, now });
      if (after.none) next[noneKey] = formatNoChecks(after.none);
      if (after.mark) {
        await this.setChecksHandled(pr, pr.headSha);
        handled = true;
      }
    }

    const reviewsKey = `reviews:${pr.number}:`;
    const reviewKeys = pagedKeys(old, reviewsKey);
    const reviews = await adapter.reviews(
      t.repo,
      pr.number,
      reviewKeys.map((k) => old[k] ?? ''),
    );
    if (reviews.modified) {
      const seenRows = await db
        .select({ key: githubSeen.key })
        .from(githubSeen)
        .where(and(eq(githubSeen.burrowId, t.burrowId), eq(githubSeen.repo, t.repo)));
      const seen = new Set(
        seenRows.filter((r) => r.key.startsWith('review:')).map((r) => Number(r.key.slice(7))),
      );
      const historyBefore = knownPrs.has(pr.number) ? cursor.baselineAt.getTime() : null;
      const plan = reviewsToMirror(reviews.data, seen, historyBefore);
      if (plan.history.length) {
        const at = this.clock();
        await this.services.pipeline.transactAccount((tx) =>
          tx
            .insert(githubSeen)
            .values(
              plan.history.map((r) => ({
                burrowId: t.burrowId,
                repo: t.repo,
                key: `review:${r.id}`,
                seenAt: at,
              })),
            )
            .onConflictDoNothing(),
        );
      }
      for (const review of plan.mirror) {
        const comments =
          review.state === 'approved' && !review.body
            ? []
            : await adapter.listReviewComments(t.repo, pr.number, review.id).catch(() => []);
        await sync.review(t.burrowId, t.repo, pr.number, review, comments);
        changes++;
      }
      for (const [i, etag] of reviews.etags.entries()) if (etag) next[`${reviewsKey}${i + 1}`] = etag;
    } else for (const k of reviewKeys) this.keep(old, next, k);

    // The head's round finished in an earlier poll and is unchanged now: handled once per head (health-checks-wake.md).
    // A head without check runs has no round to look for (PL-02).
    const withoutChecks = answer === null || answer === 'empty' || (answer === 'unchanged' && !!none);
    if (!checksChanged && !handled && !withoutChecks) {
      const stored = await db
        .select({ state: prChecks.state })
        .from(prChecks)
        .where(eq(prChecks.prId, pr.id));
      if (checksDue({ headSha: pr.headSha, checksHandledSha: null }, stored, checksChanged)) {
        const { woken, told } = await sync.checksFinished(t.burrowId, t.repo, pr.number, pr.headSha);
        if (woken.length || told.length)
          this.services.log.info(
            { burrowId: t.burrowId, repo: t.repo, pr: pr.number, head: pr.headSha, woken, told },
            'github poll: checks finished, told the agents whose work it is',
          );
        changes++;
      }
    }
    return changes;
  }

  /**
   * Marks a head handled as one without check runs, or lifts that mark when runs appear on it (PL-02). Operational and
   * unsigned like `markLocalOnly`; only while the pull request is still on that head.
   */
  private async setChecksHandled(
    pr: { id: string; headSha: string; checksHandledSha: string | null },
    sha: string | null,
  ): Promise<void> {
    await this.services.pipeline.transactAccount((tx) =>
      tx
        .update(pullRequests)
        .set({ checksHandledSha: sha })
        .where(and(eq(pullRequests.id, pr.id), eq(pullRequests.headSha, pr.headSha))),
    );
  }

  /** Agents' branches without an open PR (live push grants): their pushes are mirrored too. */
  private async syncBranches(
    adapter: GitHubAdapter,
    t: PollTarget,
    old: Record<string, string>,
    next: Record<string, string>,
  ): Promise<number> {
    const db = this.services.db;
    const now = this.clock();
    const grants = await db
      .selectDistinct({ branch: githubPushGrants.branch })
      .from(githubPushGrants)
      .where(
        and(
          eq(githubPushGrants.burrowId, t.burrowId),
          eq(githubPushGrants.repo, t.repo),
          gt(githubPushGrants.expiresAt, now),
        ),
      );
    if (!grants.length) return 0;
    const withPr = await db
      .select({ branch: pullRequests.branch })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.burrowId, t.burrowId),
          eq(repos.fullName, t.repo),
          eq(pullRequests.state, 'open'),
        ),
      );
    const skip = new Set([t.defaultBranch, ...withPr.map((p) => p.branch)]);
    let changes = 0;
    for (const { branch } of grants) {
      if (skip.has(branch)) continue;
      const key = `branch:${branch}`;
      const res = await adapter.branchHead(t.repo, branch, old[key] ?? null);
      if (!res.modified) {
        this.keep(old, next, key);
        continue;
      }
      const head = res.data;
      if (head) {
        const [stored] = await db
          .select({ sha: githubBranchHeads.sha })
          .from(githubBranchHeads)
          .where(
            and(
              eq(githubBranchHeads.burrowId, t.burrowId),
              eq(githubBranchHeads.repo, t.repo),
              eq(githubBranchHeads.branch, branch),
            ),
          );
        if (stored && !sameSha(stored.sha, head)) {
          const commits = await adapter.compare(t.repo, stored.sha, head);
          await this.github.sync.push(t.burrowId, t.repo, {
            branch,
            before: stored.sha,
            after: head,
            commits,
          });
          changes++;
        } else if (!stored) {
          // First sight: a push when Whombat pushed this head for an agent, else just where the branch is.
          if (await pushGrantForSha(db, t.burrowId, t.repo, branch, head, now)) {
            const commits = await adapter.compare(t.repo, t.defaultBranch, head);
            await this.github.sync.push(t.burrowId, t.repo, {
              branch,
              before: ZERO_SHA,
              after: head,
              commits: commits.slice(-20),
            });
            changes++;
          } else {
            await this.services.pipeline.transactAccount((tx) =>
              tx
                .insert(githubBranchHeads)
                .values({ burrowId: t.burrowId, repo: t.repo, branch, sha: head, updatedAt: now })
                .onConflictDoNothing(),
            );
          }
        }
      }
      if (res.etag) next[key] = res.etag;
    }
    return changes;
  }

  /** Deploys in flight: their workflow runs move the approvals along (github/deploy.ts). */
  private async syncDeploys(
    adapter: GitHubAdapter,
    t: PollTarget,
    old: Record<string, string>,
    next: Record<string, string>,
  ): Promise<number> {
    const open = await this.services.db
      .select({ dispatchedAt: githubDeploys.dispatchedAt })
      .from(githubDeploys)
      .where(
        and(
          eq(githubDeploys.burrowId, t.burrowId),
          eq(githubDeploys.repo, t.repo),
          or(eq(githubDeploys.state, 'dispatched'), eq(githubDeploys.state, 'running')),
        ),
      );
    if (!open.length) return 0;
    const res = await adapter.workflowRuns(t.repo, old.runs ?? null);
    if (!res.modified) {
      this.keep(old, next, 'runs');
      return 0;
    }
    let changes = 0;
    for (const run of deployRuns(
      res.data,
      open.map((d) => d.dispatchedAt),
    ))
      if (await this.github.deploys.onWorkflowRun(t.burrowId, t.repo, run)) changes++;
    if (res.etag) next.runs = res.etag;
    return changes;
  }
}
