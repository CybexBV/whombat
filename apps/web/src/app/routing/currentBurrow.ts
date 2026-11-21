/**
 * Which burrow the burrow-less paths open (AP-361). A switch (an old `/<burrow>/…` link, `?burrow=`, the burrow menu,
 * a burrow just made in onboarding), and since AP-4404 any burrow opened, is remembered for this tab (`sessionStorage`,
 * so a reload stays put) and for the browser (`localStorage`, the last opened, for a new tab). Without one: the first
 * burrow the person belongs to. A
 * managed Whombat remembers its own (the key names the appliance), and only ever offers that appliance's burrows.
 */
import type { Membership } from '@whombat/core';

export interface BurrowMemory {
  /** The remembered burrow slug (this tab's, else this browser's last opened), or null. */
  get(): string | null;
  /** Remember a switch; null forgets. */
  set(slug: string | null): void;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(kind: 'sessionStorage' | 'localStorage'): Store | null {
  try {
    return typeof window === 'undefined' ? null : window[kind];
  } catch {
    // Storage can be blocked (privacy settings): remembering is best effort.
    return null;
  }
}

export function burrowMemoryKey(scope?: string | null): string {
  return scope ? `whombat.burrow.${scope}` : 'whombat.burrow';
}

/** Remembers in the given stores (the browser's by default); in memory only when there are none. */
export function createBurrowMemory(
  scope?: string | null,
  stores: readonly (Store | null)[] = [storage('sessionStorage'), storage('localStorage')],
): BurrowMemory {
  const key = burrowMemoryKey(scope);
  const usable = stores.filter((s): s is Store => s !== null);
  let fallback: string | null = null;
  return {
    get() {
      for (const s of usable) {
        try {
          const v = s.getItem(key);
          if (v) return v;
        } catch {
          // Blocked storage: try the next.
        }
      }
      return fallback;
    },
    set(slug) {
      fallback = slug;
      for (const s of usable) {
        try {
          if (slug) s.setItem(key, slug);
          else s.removeItem(key);
        } catch {
          // Blocked or full: in memory only.
        }
      }
    },
  };
}

/** The burrow to open: the remembered one while still a member, else the first membership; null without any. */
export function chooseBurrow(memberships: readonly Membership[], remembered: string | null): string | null {
  const found = remembered ? memberships.find((m) => m.burrowSlug === remembered) : undefined;
  return (found ?? memberships[0])?.burrowSlug ?? null;
}
