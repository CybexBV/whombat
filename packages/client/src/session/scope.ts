/**
 * Cache scoping (AP-17): everything cached from an appliance — query data, decrypted resources, locally
 * persisted state — belongs to one scope: organization, appliance, account and `authzGeneration`. A different
 * scope never sees another scope's data: switching account or appliance, a permission change, sign-out and
 * revocation clear it (revocation also at the next connection, when the appliance refuses us).
 *
 * What we can't promise (and the UI doesn't): erasing what was already downloaded to disk by the person, or
 * anything on an offline or modified client.
 */
import type { ApplianceSession, SessionInfo } from './types';

export interface CacheScope {
  orgId: string;
  applianceId: string;
  accountId: string;
  authzGeneration: number;
}

export function scopeKey(scope: CacheScope): string {
  return [scope.orgId, scope.applianceId, scope.accountId, String(scope.authzGeneration)]
    .map((p) => encodeURIComponent(p))
    .join('/');
}

export function sameScope(a: CacheScope | null, b: CacheScope | null): boolean {
  return a === b || (a !== null && b !== null && scopeKey(a) === scopeKey(b));
}

export function scopeFromInfo(orgId: string, info: SessionInfo): CacheScope | null {
  if (!info.account) return null;
  return {
    orgId,
    applianceId: info.appliance.id,
    accountId: info.account.id,
    authzGeneration: info.authzGeneration,
  };
}

export type ClearReason = 'scope_changed' | 'authz_changed' | 'revoked' | 'signed_out';

/** Something that holds scoped data and can drop it. */
export interface ScopedCache {
  clear(reason: ClearReason): void | Promise<void>;
}

export interface ScopeGuard {
  scope(): CacheScope | null;
  /** Set the scope explicitly (sign-in, appliance picked). Clears when it differs. */
  enter(scope: CacheScope | null): void;
  /** Clear everything now (sign-out). */
  clearAll(reason: ClearReason): Promise<void>;
  /** Follow a session: `welcome` scopes, `authz_changed` and `revoked` notices clear. */
  watch(session: ApplianceSession, orgId: string): () => void;
  onClear(listener: (reason: ClearReason, previous: CacheScope | null) => void): () => void;
}

export function createScopeGuard(caches: readonly ScopedCache[]): ScopeGuard {
  let current: CacheScope | null = null;
  const listeners = new Set<(reason: ClearReason, previous: CacheScope | null) => void>();

  async function clearAll(reason: ClearReason) {
    const previous = current;
    await Promise.all(caches.map((c) => c.clear(reason)));
    for (const l of [...listeners]) l(reason, previous);
  }

  function enter(scope: CacheScope | null, reason: ClearReason = 'scope_changed') {
    if (sameScope(current, scope)) return;
    const hadScope = current !== null;
    current = scope;
    // The very first scope has nothing before it to clear (but persisted data of other scopes is the
    // persistence layer's job: it only ever reads its own scope key).
    if (hadScope) void clearAll(reason);
  }

  return {
    scope: () => current,
    enter: (scope) => enter(scope),
    clearAll: async (reason) => {
      await clearAll(reason);
      current = null;
    },
    watch(session, orgId) {
      const offState = session.onState((s) => {
        if (s.status === 'open') {
          const next = scopeFromInfo(orgId, s.info);
          const reason: ClearReason =
            current &&
            next &&
            current.accountId === next.accountId &&
            current.applianceId === next.applianceId
              ? 'authz_changed'
              : 'scope_changed';
          enter(next, reason);
        } else if (s.status === 'closed' && (s.reason === 'revoked' || s.reason === 'not_enrolled')) {
          current = null;
          void clearAll('revoked');
        }
      });
      const offNotice = session.onNotice((n) => {
        if (n.kind === 'revoked') {
          current = null;
          void clearAll('revoked');
        } else if (n.kind === 'authz_changed' && current && n.authzGeneration !== current.authzGeneration) {
          enter({ ...current, authzGeneration: n.authzGeneration }, 'authz_changed');
        }
      });
      return () => {
        offState();
        offNotice();
      };
    },
    onClear(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A `ScopedCache` for anything with a `clear()` (TanStack `QueryClient`, the command tracker…). */
export function clearable(target: { clear(): unknown }): ScopedCache {
  return { clear: () => void target.clear() };
}

/**
 * Local persistence namespaced by scope: keys are `whombat:<scopeKey>:<name>`. Reading uses only the current
 * scope's prefix; `clear` removes every Whombat key (other scopes included: a revoked or signed-out device
 * keeps nothing).
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export function scopedStorage(store: KeyValueStore, scope: () => CacheScope | null) {
  const prefix = () => {
    const s = scope();
    return s ? `whombat:${scopeKey(s)}:` : null;
  };
  return {
    get(name: string): string | null {
      const p = prefix();
      return p ? store.getItem(p + name) : null;
    },
    set(name: string, value: string): void {
      const p = prefix();
      if (p) store.setItem(p + name, value);
    },
    remove(name: string): void {
      const p = prefix();
      if (p) store.removeItem(p + name);
    },
    cache: {
      clear() {
        for (const k of store.keys()) if (k.startsWith('whombat:')) store.removeItem(k);
      },
    } satisfies ScopedCache,
  };
}
