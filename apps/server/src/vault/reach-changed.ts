/**
 * Where Vault entries may connect changed (the home network list, or “Agents may reach your local network”): who keeps
 * something held for an address Whombat may not reach (the 1Password sync's items and pairs) hears it after the change
 * is committed. Nothing here imports the listeners, so the commands that change the list don't load them.
 */
type Listener = () => void;

const listeners = new WeakMap<object, Set<Listener>>();

/** Hears every change of where Vault entries may connect, for these services; returns the unsubscribe. */
export function onVaultReachChanged(services: object, listener: Listener): () => void {
  let set = listeners.get(services);
  if (!set) {
    set = new Set();
    listeners.set(services, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

/** Tells the listeners (after the change is committed). */
export function vaultReachChanged(services: object): void {
  for (const listener of listeners.get(services) ?? []) listener();
}
