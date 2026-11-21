/**
 * What this device remembers about appliances (metadata only, no content — AP-17): the identity it pinned (the
 * appliance's PeerId) and where that pin came from, whether this device's key is enrolled there, and the last appliance
 * used. Local storage (the phone: a file with the same interface), per cloud account.
 *
 * The pin (AP-63): written only from a party that already trusts the appliance — the claim's CPace-confirmed result,
 * a recovery kit that names the identity, an invite, re-enrollment or add-a-device link made by an enrolled device,
 * or the box's screen sign-in once its tag matched (BX-03). The directory never writes or changes it. `put` refuses to change a pin; only a new claim (which proves the
 * new identity to the claimer) may replace one.
 *
 * Storage that fails (full, turned off, a sandboxed frame; AP-594) never throws here: what couldn't be written is kept
 * for this page as changes (per storage and account, so a remount sees them too) and `saved()` says so, so the app
 * can tell the person this device won't remember it. Every read applies those changes to what storage holds now, so
 * other tabs' Whombats, pins and forgets count; a stored pin wins over the page's own unless a claim replaces it; the
 * next write that works merges the changes into storage. Nothing unsaved pretends to be stored: a reload reads storage.
 */

import type { DirectAddresses } from '@whombat/protocol/session';
import type { PinSource } from './pin';

export interface KnownAppliance {
  device: string;
  orgId: string;
  name: string | null;
  /** The pinned content identity (full PeerId). */
  peerId: string;
  /** Who vouched for `peerId` (AP-63). Records from before AP-63 read as `legacy` and keep their pin. */
  pinSource: PinSource;
  enrolled: boolean;
  /**
   * Was: the owner who claimed it still has to save the recovery kit. A claim no longer ends with the kit (BX-01): new
   * records write false and nothing reads it, so an old record's `true` changes nothing.
   */
  kitPending: boolean;
  /** This device's account there, once known (claim, pairing, a session): recovery names it (AP-41). */
  accountId?: string;
  /**
   * The box's direct ways in as its last `welcome` said (CT-1252): the next connection tries them before the relay
   * (HE-50, hermes-engine-app.md AP-5302). Absent until a session opened.
   */
  direct?: DirectAddresses | null;
  /**
   * The box's own address (`https://<label>.box.whombat.app/`, 4.3), from the device link that let this device in or the
   * box's status: the phone tries it first. Kept apart from `direct`, which each `welcome` replaces.
   */
  ownAddress?: string | null;
}

/** A write that would change a pinned identity (AP-63): refused, nothing is stored. */
export class PinConflictError extends Error {
  constructor(
    readonly device: string,
    readonly pinned: string,
    readonly offered: string,
  ) {
    super(`The pinned identity of ${device} can't be changed here.`);
    this.name = 'PinConflictError';
  }
}

const PREFIX = 'whombat:appliances:';

export interface ApplianceRegistry {
  list(): KnownAppliance[];
  get(device: string): KnownAppliance | undefined;
  /**
   * Stores a record. An existing record keeps its pin and its pin's source: a different `peerId` throws
   * `PinConflictError`, unless `replacePin` (only after a claim, AP-63).
   */
  put(appliance: KnownAppliance, options?: { replacePin?: boolean }): void;
  remove(device: string): void;
  lastUsed(): string | null;
  setLastUsed(device: string | null): void;
  clear(): void;
  /** False while something written on this page couldn't be stored (kept for this page only, AP-594). */
  saved(): boolean;
}

interface Stored {
  appliances: KnownAppliance[];
  last: string | null;
}

export type SyncStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The browser's local storage, reached when used (reaching it may throw; the phone passes its own). */
const browserStorage = (): SyncStorage | undefined => globalThis.localStorage;

/**
 * What this page changed but storage didn't take (AP-594), as changes, never as a copy: every read applies them to what
 * storage holds now (other tabs' Whombats, pins and forgets included), and the next write that works merges them in.
 */
interface Unsaved {
  /** Records put on this page; `replacePin` only after a claim. Never also in `removed`. */
  put: Map<string, { record: KnownAppliance; replacePin: boolean }>;
  /** Devices forgotten on this page. */
  removed: Set<string>;
  /** The last used, when set on this page. */
  last?: { device: string | null };
  /** Everything forgotten on this page (a clear storage didn't take): nothing stored counts for it. */
  cleared: boolean;
}

/** Per storage (as passed in) and key. */
const unsaved = new WeakMap<object, Map<string, Unsaved>>();

const EMPTY: Stored = { appliances: [], last: null };

/** A stored record as this version reads it: without a source it was pinned before AP-63 (`legacy`). */
function normalize(a: KnownAppliance): KnownAppliance {
  return a.pinSource ? a : { ...a, pinSource: 'legacy' };
}

/** `changes` over `base`: a stored pin wins over a put unless it may replace pins (a claim, AP-63). */
function applyUnsaved(base: Stored, changes: Unsaved): Stored {
  let appliances = changes.cleared ? [] : base.appliances.filter((a) => !changes.removed.has(a.device));
  for (const { record, replacePin } of changes.put.values()) {
    const existing = appliances.find((a) => a.device === record.device);
    if (existing && !replacePin && existing.peerId !== record.peerId) continue;
    const next = existing && !replacePin ? { ...record, pinSource: existing.pinSource } : record;
    appliances = [...appliances.filter((a) => a.device !== record.device), next];
  }
  let last = changes.last ? changes.last.device : changes.cleared ? null : base.last;
  if (last !== null && !appliances.some((a) => a.device === last) && changes.removed.has(last)) last = null;
  return { appliances, last };
}

export function createRegistry(
  accountId: string,
  storage: SyncStorage | (() => SyncStorage | null | undefined) = browserStorage,
): ApplianceRegistry {
  const key = `${PREFIX}${accountId}`;
  const reach = (): SyncStorage => {
    const s = typeof storage === 'function' ? storage() : storage;
    if (!s) throw new Error('no storage');
    return s;
  };
  const byKey = () => {
    const m = unsaved.get(storage) ?? new Map<string, Unsaved>();
    unsaved.set(storage, m);
    return m;
  };
  /** What storage holds now; throws when it can't be read (a write must not replace what it couldn't see). */
  const storedNow = (): Stored => {
    const raw = reach().getItem(key);
    try {
      const v = raw ? (JSON.parse(raw) as Stored) : EMPTY;
      return { appliances: (v.appliances ?? []).map(normalize), last: v.last ?? null };
    } catch {
      return EMPTY;
    }
  };
  const stored = (): Stored => {
    try {
      return storedNow();
    } catch {
      return EMPTY;
    }
  };
  const read = (): Stored => {
    const changes = byKey().get(key);
    return changes ? applyUnsaved(stored(), changes) : stored();
  };
  /** Adds a change to this page's and stores the result over what storage holds now; kept for the page if it fails. */
  const change = (edit: (c: Unsaved) => void) => {
    const now = byKey().get(key);
    const c: Unsaved = {
      put: new Map(now?.put),
      removed: new Set(now?.removed),
      ...(now?.last && { last: now.last }),
      cleared: now?.cleared ?? false,
    };
    edit(c);
    try {
      const s = reach();
      if (c.cleared) {
        s.removeItem(key);
        c.cleared = false;
      }
      s.setItem(key, JSON.stringify(applyUnsaved(storedNow(), c)));
      byKey().delete(key);
    } catch {
      byKey().set(key, c);
    }
  };
  return {
    list: () => read().appliances,
    get: (device) => read().appliances.find((a) => a.device === device),
    put(appliance, options) {
      const existing = read().appliances.find((a) => a.device === appliance.device);
      const replacePin = options?.replacePin ?? false;
      if (existing && !replacePin && existing.peerId !== appliance.peerId)
        throw new PinConflictError(appliance.device, existing.peerId, appliance.peerId);
      const record = existing && !replacePin ? { ...appliance, pinSource: existing.pinSource } : appliance;
      change((c) => {
        c.removed.delete(appliance.device);
        c.put.set(appliance.device, { record, replacePin });
      });
    },
    remove(device) {
      const wasLast = read().last === device;
      change((c) => {
        c.put.delete(device);
        c.removed.add(device);
        if (wasLast || c.last?.device === device) c.last = { device: null };
      });
    },
    lastUsed: () => read().last,
    setLastUsed(device) {
      change((c) => {
        c.last = { device };
      });
    },
    clear() {
      try {
        reach().removeItem(key);
        byKey().delete(key);
      } catch {
        // Gone for this page even so; storage still has it, so it isn't saved.
        byKey().set(key, { put: new Map(), removed: new Set(), cleared: true });
      }
    },
    saved: () => !byKey().get(key),
  };
}

/**
 * This device got a new key (set up again after it was removed, AP-39): the new key is enrolled nowhere yet, so every
 * appliance it knows asks to let it in again (pairing) instead of first failing a session. The pins stay.
 */
export function forgetEnrollments(registry: ApplianceRegistry): void {
  for (const a of registry.list()) if (a.enrolled) registry.put({ ...a, enrolled: false });
}
