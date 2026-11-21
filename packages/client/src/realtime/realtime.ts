/**
 * The `Realtime` interface every hook and cache reducer uses (`createSessionRealtime` implements it over the appliance
 * session's subscriptions, AP-11), its frames and signals, and the reconnect backoff the session shares.
 */
import type { RealtimeEvent, RealtimeEventOf, RealtimeEventType } from '@whombat/core';

export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** One realtime event as hooks and cache reducers get it: its topic, a per-connection counter, its id and when. */
export interface EventFrame {
  op: 'event';
  topic: string;
  event: RealtimeEvent;
  seq: number;
  eventId: string | null;
  at: string;
}

export interface ResyncSignal {
  /**
   * `reconnect`: the connection came back (anything may be missing); `gap`: a `seq` was skipped on a topic;
   * `snapshot`: the appliance can't resume these topics from our cursor (retention, restart, changed access).
   */
  reason: 'reconnect' | 'gap' | 'snapshot';
  topics: string[];
}

export type RealtimeError = { kind: 'bad_frame'; raw: string };

export interface BackoffOptions {
  /** First retry delay ceiling. Default 500 ms. */
  initialMs?: number;
  /** Maximum delay. Default 30 s. */
  maxMs?: number;
  /** Growth per attempt. Default 2. */
  factor?: number;
}

export interface Realtime {
  /** Connect (no-op when already open or connecting). */
  connect(): void;
  /** Close for good; no reconnects until `connect()` is called again. */
  disconnect(): void;
  /** Skip the backoff wait and reconnect now (network came back, app foregrounded). */
  reconnectNow(): void;
  status(): RealtimeStatus;
  /** Burrow and principal of the held topics, once connected. */
  session(): { burrowId: string; principalId: string } | null;

  /** Ref-counted subscription; the returned function releases it (idempotent). */
  subscribe(topics: string | readonly string[]): () => void;
  /** Topics with at least one subscriber. */
  topics(): string[];
  /** Last per-connection `seq` seen since the current connection's `hello` (undefined before the first event). */
  lastSeq(): number | undefined;

  on<T extends RealtimeEventType>(
    type: T,
    listener: (event: RealtimeEventOf<T>, frame: EventFrame) => void,
  ): () => void;
  onEvent(listener: (event: RealtimeEvent, frame: EventFrame) => void): () => void;
  onStatus(listener: (status: RealtimeStatus) => void): () => void;
  onResync(listener: (signal: ResyncSignal) => void): () => void;
  onError(listener: (error: RealtimeError) => void): () => void;
}

/** Delay before reconnect attempt `attempt` (0-based): exponential ceiling, "equal jitter" below it. */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
) {
  const initial = options.initialMs ?? 500;
  const max = options.maxMs ?? 30_000;
  const factor = options.factor ?? 2;
  const ceiling = Math.min(max, initial * factor ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
