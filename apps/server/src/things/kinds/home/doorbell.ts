/**
 * A doorbell ringing, as it happens (docs/decisions/desk-display.md; desk-display-server.md): UniFi
 * Protect's event stream (`protect-events.ts`) says so the moment someone presses the button, and whoever listens in the
 * server hears it at once — the screens open the doorbell big. In memory only: nothing is kept here (the stream's
 * follower keeps the ring with the other detections).
 */
import { and, eq } from 'drizzle-orm';
import { catalogConnections } from '../../../db/schema/index';
import type { Services } from '../../../services';
import { dateOf, rec, str } from '../../words';

/** A ring older than this when it arrives (a replay, a late reconnect) is no moment any more. */
export const RING_FRESH_MS = 60_000;

/** Someone pressed a doorbell: which Protect connection, its burrow, the doorbell's camera, Protect's event and when. */
export interface DoorbellRing {
  connectionId: string;
  burrowId: string;
  camera: string;
  eventId: string;
  at: Date;
}

/**
 * A message of Protect's event stream as a ring just now, or null: only the event's first word (`add`, not the
 * `update`s that follow), of type `ring`, from a camera, and fresh at `now`.
 */
export function ringOf(message: unknown, now: Date): Pick<DoorbellRing, 'camera' | 'eventId' | 'at'> | null {
  const m = rec(message);
  if (m.type !== 'add') return null;
  const item = rec(m.item);
  if (item.modelKey !== undefined && item.modelKey !== 'event') return null;
  if (str(item.type) !== 'ring') return null;
  const camera = str(item.device)?.slice(0, 120);
  const eventId = str(item.id)?.slice(0, 200);
  const at = dateOf(item.start);
  if (!camera || !eventId || !at) return null;
  if (Math.abs(now.getTime() - at.getTime()) > RING_FRESH_MS) return null;
  return { camera, eventId, at };
}

type Listener = (ring: DoorbellRing) => void;
const listeners = new WeakMap<Services, Set<Listener>>();

/** Hears every ring of this server's Protect connections; the answer stops it. */
export function onDoorbellRing(services: Services, listener: Listener): () => void {
  let set = listeners.get(services);
  if (!set) {
    set = new Set();
    listeners.set(services, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** A ring, to everyone listening; one listener failing doesn't keep it from the others. */
export function emitDoorbellRing(services: Services, ring: DoorbellRing): void {
  for (const listener of listeners.get(services) ?? []) {
    try {
      listener(ring);
    } catch (err) {
      services.log.warn({ err: String(err) }, 'doorbell: a listener failed');
    }
  }
}

/**
 * Whether the burrow follows a doorbell: it has a UniFi Protect connection that works (Settings → Screens offers *When the
 * doorbell rings* then). Protect's doorbells are its cameras; which of them is one is its page's to know.
 */
export async function followsDoorbell(services: Services, burrowId: string): Promise<boolean> {
  const [row] = await services.db
    .select({ id: catalogConnections.id })
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.burrowId, burrowId),
        eq(catalogConnections.catalogId, 'unifi_protect'),
        eq(catalogConnections.status, 'active'),
      ),
    )
    .limit(1);
  return row !== undefined;
}
