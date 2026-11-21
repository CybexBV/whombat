/**
 * What the runtime counts for diagnostic bundles (CT-52, MR-42): connectivity events and session error codes per
 * operation, in hourly buckets over the last 7 days (`DIAGNOSTICS_WINDOW_S`). In memory: a restart starts them anew
 * (the bundle's `uptimeS` says how much of the window they cover). Never content: names, codes and counts only.
 */
const HOUR_MS = 3600_000;
const WINDOW_MS = 7 * 24 * HOUR_MS;
/** Distinct error combinations kept (most recent win); a bundle says `truncated` beyond its own limit. */
const MAX_ERROR_KEYS = 1_000;

export type ConnectivityCounter =
  | 'relayConnects'
  | 'relayDisconnects'
  | 'sessionsOpened'
  | 'sessionsRefusedVersion'
  | 'handshakeFailures';

export interface ErrorCount {
  code: string;
  appCode: string | null;
  op: string | null;
  count: number;
  lastAt: Date;
}

export class RuntimeCounters {
  private readonly buckets = new Map<ConnectivityCounter, Map<number, number>>();
  private readonly errors = new Map<string, { entry: ErrorCount; hours: Map<number, number> }>();
  readonly startedAt: Date;
  lastRelayConnectedAt: Date | null = null;
  lastRelayErrorCode: string | null = null;

  constructor(private readonly clock: () => Date = () => new Date()) {
    this.startedAt = clock();
  }

  private hour(): number {
    return Math.floor(this.clock().getTime() / HOUR_MS);
  }

  private prune(hours: Map<number, number>): void {
    const floor = Math.floor((this.clock().getTime() - WINDOW_MS) / HOUR_MS);
    for (const h of hours.keys()) if (h < floor) hours.delete(h);
  }

  bump(counter: ConnectivityCounter): void {
    const hours = this.buckets.get(counter) ?? new Map<number, number>();
    const h = this.hour();
    hours.set(h, (hours.get(h) ?? 0) + 1);
    this.prune(hours);
    this.buckets.set(counter, hours);
  }

  count(counter: ConnectivityCounter): number {
    const hours = this.buckets.get(counter);
    if (!hours) return 0;
    this.prune(hours);
    let n = 0;
    for (const v of hours.values()) n += v;
    return n;
  }

  /** A session error answer: its code, `details.code` and the request's op (null for session-level errors). */
  error(code: string, appCode: string | null, op: string | null): void {
    const key = `${code}\u0000${appCode ?? ''}\u0000${op ?? ''}`;
    const now = this.clock();
    let slot = this.errors.get(key);
    if (!slot) {
      if (this.errors.size >= MAX_ERROR_KEYS) {
        const oldest = [...this.errors.entries()].sort((a, b) => +a[1].entry.lastAt - +b[1].entry.lastAt)[0];
        if (oldest) this.errors.delete(oldest[0]);
      }
      slot = { entry: { code, appCode, op, count: 0, lastAt: now }, hours: new Map() };
      this.errors.set(key, slot);
    }
    const h = this.hour();
    slot.hours.set(h, (slot.hours.get(h) ?? 0) + 1);
    slot.entry.lastAt = now;
  }

  /** Error combinations over the window, most frequent first. */
  errorCounts(): ErrorCount[] {
    const out: ErrorCount[] = [];
    for (const [key, slot] of this.errors) {
      this.prune(slot.hours);
      let n = 0;
      for (const v of slot.hours.values()) n += v;
      if (n === 0) {
        this.errors.delete(key);
        continue;
      }
      out.push({ ...slot.entry, count: n });
    }
    return out.sort((a, b) => b.count - a.count || +b.lastAt - +a.lastAt);
  }
}
