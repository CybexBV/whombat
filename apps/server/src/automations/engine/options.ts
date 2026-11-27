import { FIX_TRIES_MAX } from '../again';

/** The automations engine's cadences, lease and limits (bp-automations BP-C05, server-efficiency SV-03). */
export interface EngineOptions {
  /**
   * How often the loop runs while it has work (a live run, or a live automation that reads events) and nothing kicked
   * it (server-efficiency.md SV-03).
   */
  tickMs: number;
  /** …and with no work at all; a schedule's next fire and `nudge` still run it on time. */
  idleTickMs: number;
  /** While it has work, a commit with a signed event or a dispatch or approval changing runs the loop this soon. */
  kickMs: number;
  /** A run's lease (the engine renews it each time it advances the run). */
  leaseMs: number;
  /** How often the approvals engine's recovery runs. */
  recoverEveryMs: number;
  /** How often a passive process tries to become the active one. */
  lockRetryMs: number;
  /**
   * How often the active engine checks that the session holding its lock still does (CS-11). A new holder waits two
   * of these before it acts, so one whose session ended has stepped down by then. Same on every process.
   */
  lockCheckMs: number;
  /** Automation-caused events deeper than this trigger nothing. */
  maxCausalDepth: number;
  /** Runs one burrow may start per hour (all automations together). */
  burrowRunsPerHour: number;
  /** A schedule fire older than this when noticed counts as missed (downtime). */
  missedGraceMs: number;
  /** The most tries a run makes at a fix that doesn't get through (`again.ts`): the first and the ones after it. */
  fixTriesMax: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  tickMs: 10_000,
  idleTickMs: 30_000,
  kickMs: 1000,
  leaseMs: 60_000,
  recoverEveryMs: 60_000,
  lockRetryMs: 5000,
  lockCheckMs: 5000,
  maxCausalDepth: 2,
  burrowRunsPerHour: 120,
  missedGraceMs: 120_000,
  fixTriesMax: FIX_TRIES_MAX,
};
