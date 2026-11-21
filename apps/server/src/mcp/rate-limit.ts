/**
 * Token buckets for MCP tool calls (REFERENCE_NOTES §5: Buzz specified rate limits but never enforced
 * them). Every call takes one token from the agent's bucket and one from the dispatch's bucket; either
 * running dry answers `rate_limited` until it refills.
 */
export interface BucketLimit {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  perSecond: number;
}

export interface McpLimits {
  perAgent: BucketLimit;
  perDispatch: BucketLimit;
}

export const DEFAULT_MCP_LIMITS: McpLimits = {
  perAgent: { capacity: 240, perSecond: 4 },
  perDispatch: { capacity: 120, perSecond: 2 },
};

/** Buckets kept before full ones are dropped. */
export const MAX_BUCKETS = 10_000;

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: BucketLimit,
    private readonly now: () => number = Date.now,
  ) {}

  private refill(key: string): Bucket {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      // Prune before a new key goes in, never after: pruning after would drop the bucket just made (it is full), and
      // what the caller then takes from it would be lost, leaving new keys unlimited (feedback-reporters FR-14).
      if (this.buckets.size >= MAX_BUCKETS) this.prune(t);
      b = { tokens: this.limit.capacity, at: t };
      this.buckets.set(key, b);
    }
    const elapsed = Math.max(0, t - b.at) / 1000;
    b.tokens = Math.min(this.limit.capacity, b.tokens + elapsed * this.limit.perSecond);
    b.at = t;
    return b;
  }

  /** Whether one token is available (without taking it). */
  has(key: string): boolean {
    return this.refill(key).tokens >= 1;
  }

  take(key: string): boolean {
    const b = this.refill(key);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Seconds until the next token. */
  retryAfter(key: string): number {
    const b = this.refill(key);
    return b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) / this.limit.perSecond);
  }

  /** Drops every bucket that has refilled to capacity by `t` (a new one starts full anyway). */
  private prune(t: number): void {
    for (const [key, b] of this.buckets) {
      const tokens = b.tokens + (Math.max(0, t - b.at) / 1000) * this.limit.perSecond;
      if (tokens >= this.limit.capacity) this.buckets.delete(key);
    }
  }

  /** Buckets held (tests). */
  get size(): number {
    return this.buckets.size;
  }
}

/** Per-agent and per-dispatch limits together: a call passes only if both have a token. */
export class McpRateLimiter {
  private readonly agents: TokenBuckets;
  private readonly dispatches: TokenBuckets;

  constructor(limits: McpLimits = DEFAULT_MCP_LIMITS, now: () => number = Date.now) {
    this.agents = new TokenBuckets(limits.perAgent, now);
    this.dispatches = new TokenBuckets(limits.perDispatch, now);
  }

  /** Takes a token from both buckets, or none; returns the wait in seconds when limited. */
  take(
    agentId: string,
    dispatchId: string,
  ): { ok: true } | { ok: false; scope: 'agent' | 'dispatch'; retryAfter: number } {
    if (!this.agents.has(agentId))
      return { ok: false, scope: 'agent', retryAfter: this.agents.retryAfter(agentId) };
    if (!this.dispatches.has(dispatchId))
      return { ok: false, scope: 'dispatch', retryAfter: this.dispatches.retryAfter(dispatchId) };
    this.agents.take(agentId);
    this.dispatches.take(dispatchId);
    return { ok: true };
  }
}
