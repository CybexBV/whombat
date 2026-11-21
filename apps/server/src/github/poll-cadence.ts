/**
 * How often the poller reads a repo (docs/decisions/polling.md PL-01): pure, so the cadence decision, when a repo is due
 * and when the refresh without ETags may run are unit-tested apart from the poller (github/poller.ts).
 *
 * - **fast** (`WHOMBAT_GITHUB_POLL_FAST_MS`, 10 s): something an agent does there is live — a run, a push it was just
 *   given a token for, a deploy in flight, or checks still to finish on its own pull request. The checks wake
 *   (health-checks-wake.md HW-01) then reaches the agent 10–20 s after the last result instead of 30–60 s.
 * - **active** (`WHOMBAT_GITHUB_POLL_MS`, 30 s): a person of the burrow is active (presence), so what happens on GitHub
 *   shows while they look.
 * - **idle** (`WHOMBAT_GITHUB_POLL_IDLE_MS`, 3 min): nothing live and nobody there.
 *
 * A change that should be seen at once (a run starts, a push token is handed out, a deploy is dispatched, a person
 * merges or comes back) wakes the poller: the repo is due now, and its cadence is decided again after that poll.
 */

export type PollCadence = 'fast' | 'active' | 'idle';

/** Why a repo has its cadence (logs and tests). */
export type PollReason = 'run' | 'push' | 'deploy' | 'checks' | 'person' | 'quiet';

/** The three cadences, ms. */
export interface PollCadences {
  fast: number;
  active: number;
  idle: number;
}

/** What is going on in one repo of one burrow, as the poller reads it after polling the repo. */
export interface CadenceSignals {
  /** A run of an agent on the repo is live and needs no person (no `attention`). */
  liveRun: boolean;
  /** A push token for the repo was handed to an agent's runner in the last `PUSH_FAST_MS`. */
  freshPush: boolean;
  /** A deploy of the repo was dispatched in the last `DEPLOY_FAST_MS` and has not finished. */
  deploy: boolean;
  /**
   * An agent's own open pull request on the repo has a head whose checks aren't handled yet (still running, or not
   * started), and it moved in the last `AGENT_CHECKS_FAST_MS`.
   */
  agentChecks: boolean;
  /** A person of the burrow is active (the presence tracker). */
  personActive: boolean;
}

/** A push lands seconds after its token is handed out; this covers a slow push or a retry. */
export const PUSH_FAST_MS = 10 * 60_000;
/** Deploys still in flight after this are read at the active or idle cadence. */
export const DEPLOY_FAST_MS = 60 * 60_000;
/**
 * An agent's pull request whose round never finishes (a check that disappeared on a new head stays queued, a known limit
 * of health-checks-wake.md) keeps its repo fast this long after its head moved, not forever.
 */
export const AGENT_CHECKS_FAST_MS = 60 * 60_000;
/** A cycle without ETags this often (G-08)… */
export const REFRESH_MS = 10 * 60_000;
/** …on the idle cadence only, unless the repo never got there for this long (PL-01). */
export const REFRESH_MAX_MS = 30 * 60_000;
/** A woken repo is not read again sooner than this after the poll before. */
export const WAKE_GAP_MS = 2_000;
/** Repos due within this of a tick are read in that tick (repos polled together stay together). */
export const TICK_SLACK_MS = 1_000;
/** The shortest pause between two ticks. */
export const MIN_TICK_MS = 1_000;

/**
 * The cadences from the configuration. `WHOMBAT_GITHUB_POLL_MS` is the active one (0: the poller never runs on its own);
 * the fast one is never slower and the idle one never faster than it, and 0 for either means the active cadence.
 */
export function pollCadences(config: {
  WHOMBAT_GITHUB_POLL_MS: number;
  WHOMBAT_GITHUB_POLL_FAST_MS: number;
  WHOMBAT_GITHUB_POLL_IDLE_MS: number;
}): PollCadences {
  const active = config.WHOMBAT_GITHUB_POLL_MS;
  const fast = config.WHOMBAT_GITHUB_POLL_FAST_MS;
  const idle = config.WHOMBAT_GITHUB_POLL_IDLE_MS;
  return {
    fast: fast > 0 ? Math.min(fast, active) : active,
    active,
    idle: idle > 0 ? Math.max(idle, active) : active,
  };
}

/** A repo's cadence: fast while an agent's work there is live, active while a person is, idle otherwise. */
export function pollCadence(s: CadenceSignals): { cadence: PollCadence; reason: PollReason } {
  if (s.liveRun) return { cadence: 'fast', reason: 'run' };
  if (s.freshPush) return { cadence: 'fast', reason: 'push' };
  if (s.deploy) return { cadence: 'fast', reason: 'deploy' };
  if (s.agentChecks) return { cadence: 'fast', reason: 'checks' };
  if (s.personActive) return { cadence: 'active', reason: 'person' };
  return { cadence: 'idle', reason: 'quiet' };
}

/** The livelier of two cadences. */
export function livelier(a: PollCadence, b: PollCadence): PollCadence {
  const rank: Record<PollCadence, number> = { fast: 0, active: 1, idle: 2 };
  return rank[a] <= rank[b] ? a : b;
}

/** One repo in the poller's schedule (times in ms of the poller's clock). */
export interface RepoSchedule {
  /** When its last poll started; null: not polled by this poller yet. */
  polledAt: number | null;
  cadence: PollCadence;
  /** When something woke it (a change to see at once); null: nothing since. */
  wokenAt: number | null;
}

/** When a repo is due: at once when never polled, soon after a wake that came after its last poll, else its cadence. */
export function pollDueAt(s: RepoSchedule, c: PollCadences): number {
  if (s.polledAt === null) return s.wokenAt ?? 0;
  const regular = s.polledAt + c[s.cadence];
  if (s.wokenAt !== null && s.wokenAt > s.polledAt)
    return Math.min(regular, Math.max(s.wokenAt, s.polledAt + WAKE_GAP_MS));
  return regular;
}

/** When the next tick runs: the earliest due repo, at most `maxSleep` away and at least `MIN_TICK_MS`. */
export function nextTickAt(now: number, dues: readonly number[], maxSleep: number): number {
  const earliest = Math.min(now + maxSleep, ...dues);
  return Math.max(earliest, now + MIN_TICK_MS);
}

/**
 * Whether this poll reads without ETags (G-08's refresh; PL-01): every `REFRESH_MS`, on the idle cadence only — a fast
 * or active repo reads conditionally, so the 10 s polls stay free of rate limit — unless it stayed busy for
 * `REFRESH_MAX_MS`, which takes the refresh at any cadence.
 */
export function refreshDue(p: { refreshedAt: number | null; now: number; cadence: PollCadence }): boolean {
  if (p.refreshedAt === null) return true;
  const age = p.now - p.refreshedAt;
  return age >= REFRESH_MS && (p.cadence === 'idle' || age >= REFRESH_MAX_MS);
}
