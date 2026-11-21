/**
 * In-process realtime bus (ARCHITECTURE "outbox → in-process realtime bus"). The commit pipeline publishes
 * outbox frames after commit; ephemeral frames (typing, presence, viewer badges) are published directly.
 * The session event log (`managed/events.ts`) is the main listener: it hands frames to the encrypted sessions.
 */
import type { RealtimeEvent } from '@whombat/core';

export interface BusFrame {
  topic: string;
  event: RealtimeEvent;
  /** Signed audit event behind the change, if any. */
  eventId: string | null;
  at: string;
  /** Outbox row id (null for ephemeral frames). */
  outboxId: number | null;
}

/** Revoked credentials the hub and collab must apply to live connections immediately. */
export type BusControl =
  /** Managed (MA-04 §6): an endpoint key was revoked; its sessions close and are told to clear caches. */
  | { type: 'endpoint.revoked'; endpointId: string; accountId: string; generation?: number }
  /** Managed: an account's authorization generation moved (a device revoked); its sessions close. */
  | { type: 'authz.changed'; accountId: string; generation: number };

type Listener<T> = (value: T) => void;

export class RealtimeBus {
  private readonly frames = new Set<Listener<BusFrame>>();
  private readonly controls = new Set<Listener<BusControl>>();

  publish(frame: BusFrame): void {
    for (const listener of this.frames) {
      try {
        listener(frame);
      } catch {
        // A broken listener must not stop fan-out to the others.
      }
    }
  }

  control(message: BusControl): void {
    for (const listener of this.controls) {
      try {
        listener(message);
      } catch {
        // ignore
      }
    }
  }

  onFrame(listener: Listener<BusFrame>): () => void {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  onControl(listener: Listener<BusControl>): () => void {
    this.controls.add(listener);
    return () => this.controls.delete(listener);
  }
}
