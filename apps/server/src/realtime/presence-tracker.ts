/**
 * Whether the person is at a screen — the box's own (docs/decisions/essentials-conversations.md EC-27; one-person.md
 * OP-S14). One entry per live connection of the person in a burrow (a managed session once it follows the burrow): a
 * new connection is `active`, `idle` after `IDLE_AFTER_MS` (10 minutes); its close ends it. Nothing is published:
 * contracts 3.0 have no presence between people, so it only holds a push while the person is at a screen (NT-17) and
 * speeds up the GitHub poller while they are around (PL-01).
 *
 * In-process: a restart forgets the person's connections until their clients connect again.
 */
import { type Clock, systemClock } from '../lib/time';
import type { RealtimeBus } from './bus';

/** What the person's connections in a burrow say. */
export type PresenceState = 'active' | 'idle' | 'offline';

/** A connection without a new one this long counts as idle. */
export const IDLE_AFTER_MS = 10 * 60_000;

interface Connection {
  burrowId: string;
  principalId: string;
  state: Exclude<PresenceState, 'offline'>;
  lastActiveAt: number;
}

/** How often quiet connections are looked for. */
const SWEEP_MS = 30_000;

export class PresenceTracker {
  private readonly conns = new Map<string, Connection>();
  private readonly listeners = new Set<(burrowId: string) => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly clock: Clock = systemClock,
    readonly idleAfterMs = IDLE_AFTER_MS,
  ) {}

  /** A principal's presence now, the liveliest of its connections (`offline` without any). */
  stateOf(principalId: string): PresenceState {
    let state: PresenceState = 'offline';
    for (const c of this.conns.values()) {
      if (c.principalId !== principalId) continue;
      if (c.state === 'active') return 'active';
      state = 'idle';
    }
    return state;
  }

  /** Whether one of the person's connections opened in the last `withinMs`: they are at a screen right now (NT-17). */
  activeWithin(principalId: string, withinMs: number): boolean {
    const cutoff = this.now() - withinMs;
    for (const c of this.conns.values())
      if (c.principalId === principalId && c.state === 'active' && c.lastActiveAt >= cutoff) return true;
    return false;
  }

  /** Whether someone is active in a burrow now. */
  activeIn(burrowId: string): boolean {
    for (const c of this.conns.values()) if (c.burrowId === burrowId && c.state === 'active') return true;
    return false;
  }

  /** Called with the burrow whenever a connection there opens (the person is back). */
  onActive(listener: (burrowId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A person's connection opened (active). Connecting a key that is there already makes it active again. */
  connect(key: string, burrowId: string, principalId: string): void {
    this.conns.set(key, { burrowId, principalId, state: 'active', lastActiveAt: this.now() });
    this.arm();
    for (const listener of this.listeners) listener(burrowId);
  }

  /** A connection closed. */
  disconnect(key: string): void {
    if (!this.conns.delete(key)) return;
    if (this.conns.size === 0) this.disarm();
  }

  /** Every connection whose key starts with `prefix` closed (a managed session's, one per burrow). */
  disconnectAll(prefix: string): void {
    for (const key of [...this.conns.keys()]) if (key.startsWith(prefix)) this.disconnect(key);
  }

  /** Whether a connection is tracked. */
  has(key: string): boolean {
    return this.conns.has(key);
  }

  /** Connections quiet for `idleAfterMs` become idle (on a timer; tests call it directly). */
  sweep(): void {
    const cutoff = this.now() - this.idleAfterMs;
    for (const c of this.conns.values())
      if (c.state === 'active' && c.lastActiveAt <= cutoff) c.state = 'idle';
  }

  close(): void {
    this.disarm();
    this.conns.clear();
    this.listeners.clear();
  }

  private now(): number {
    return this.clock().getTime();
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const trackers = new WeakMap<RealtimeBus, PresenceTracker>();

/** The tracker of a service container's bus, started on first use. */
export function presenceFor(services: { bus: RealtimeBus; clock?: Clock }): PresenceTracker {
  let tracker = trackers.get(services.bus);
  if (!tracker) {
    tracker = new PresenceTracker(services.clock ?? systemClock);
    trackers.set(services.bus, tracker);
  }
  return tracker;
}
