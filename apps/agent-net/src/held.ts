/**
 * The policy the daemon holds. Each opening lapses on the daemon's own clock, `ttlMs` after the policy that carried it
 * arrived, whether or not another policy ever comes. The runner renews its openings with every policy it sets (every
 * half minute at least), so a runner that stopped, or whose removal never got here, can't keep a production server
 * open. The rest of the policy stays as it was: production servers closed, the home networks and local network as set.
 */
import type { NetPolicy, TimedOpening } from './rules';

/** A monotonic clock: a changed wall clock can't stretch an opening. */
const monotonic = () => performance.now();

export class HeldPolicy {
  readonly #now: () => number;
  #policy: NetPolicy | null = null;
  #open: { opening: TimedOpening; until: number }[] = [];

  constructor(now: () => number = monotonic) {
    this.#now = now;
  }

  /** A new policy from the runner: its openings hold for their `ttlMs` from now. */
  set(policy: NetPolicy): void {
    const now = this.#now();
    this.#policy = policy;
    this.#open = policy.open.map((opening) => ({ opening, until: now + opening.ttlMs }));
  }

  /** The policy now, with only the openings still holding (`ttlMs`: what is left of each); null until one was set. */
  get(): NetPolicy | null {
    if (!this.#policy) return null;
    const now = this.#now();
    return {
      ...this.#policy,
      open: this.#open
        .filter((o) => o.until > now)
        .map((o) => ({ ...o.opening, ttlMs: Math.ceil(o.until - now) })),
    };
  }
}
