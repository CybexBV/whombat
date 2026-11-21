/**
 * What happened to a connection, for whoever keeps something of it in memory (CX-24, CX-32): the tools side's pooled MCP
 * client and cached tools subscribe with `onConnectionLifecycle` and drop them. Fired after the change is committed:
 * `removed` (disconnected, or gone with its account or burrow is not reported: those rows cascade), `credential` (a new
 * token, a reconnect, a new address or fields: reconnect with the new credential) and `tiers` (a tool's tier changed).
 */
import type { Services } from '../services';

export interface ConnectionLifecycleEvent {
  type: 'removed' | 'credential' | 'tiers';
  connectionId: string;
}

type Listener = (event: ConnectionLifecycleEvent) => void | Promise<void>;

const listeners = new WeakMap<Services, Set<Listener>>();

/** Subscribes to every connection's lifecycle on these services; returns the unsubscribe. */
export function onConnectionLifecycle(services: Services, listener: Listener): () => void {
  let set = listeners.get(services);
  if (!set) {
    set = new Set();
    listeners.set(services, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

/** Tells every listener (failures are logged, never thrown at the caller). */
export async function emitConnectionLifecycle(
  services: Services,
  event: ConnectionLifecycleEvent,
): Promise<void> {
  for (const listener of listeners.get(services) ?? []) {
    try {
      await listener(event);
    } catch (err) {
      services.log.warn(
        { connectionId: event.connectionId, type: event.type, err: String(err) },
        'connection lifecycle listener failed',
      );
    }
  }
}
