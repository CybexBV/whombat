/**
 * Expiring records in a key-value storage (AP-590): something a device holds for a while and then forgets — a link's
 * secret between opening the link and signing in (which may open in another tab), a journey's progress across a
 * reload. The web keeps them in `localStorage` or `sessionStorage`; anything with the same three methods works.
 *
 * - **Format.** `{"v":1,"heldAt":…,"expiresAt":…,"value":…}`: both times finite, non-negative integers (ms since the
 *   epoch), `expiresAt` after `heldAt`, and `value` checked against the record's schema on every read.
 * - **Expiry.** Valid while `now < expiresAt`: expired at `expiresAt` exactly. Never longer than `ttlMs` after
 *   `heldAt`, whatever `expiresAt` says.
 * - **Clock skew.** `heldAt` may lie at most `EXPIRING_CLOCK_SKEW_MS` in the future (a clock set back a little since
 *   the write); later than that this clock can't have written it, and the record is invalid.
 * - **Lifetime.** `hold` is a new hold with a new expiry (a new link arrived); `update` changes the value and keeps the
 *   expiry (progress in the same journey); reading and migrating never extend it.
 * - **Legacy.** With `legacy`, a record from before this format (`{…value, at}`) reads as held at `at` for its old
 *   lifetime (never longer than `ttlMs`), and is rewritten in this format with that same expiry.
 * - **Cleanup.** Invalid and expired records are removed when read; only this record's own key is ever touched.
 * - **Failures.** Storage that throws (disabled, a private mode, a sandboxed frame, full) never throws here: a read is
 *   null; a hold that can't be written answers false and leaves nothing held, not even an older value; a record that
 *   can't be removed is remembered as gone for this page (a tombstone of that exact value, per storage and key; when
 *   the storage can't even be read, of the value this page last read or wrote), so it is never read as valid again,
 *   while a different value another page writes later is read (and never removed) as usual.
 *
 * Not a security boundary: whoever controls this device's storage controls these records. The server's expiry,
 * authorization and one-time use of a link are what count; this only keeps a device from resuming a journey it
 * should have forgotten. Pure: no DOM or platform globals (the caller hands the storage in).
 */
import { z } from 'zod';

/** The three methods of the web's `Storage` these records use (the phone's file-backed storage has them too). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** How far in the future a record's `heldAt` may lie (AP-590): five minutes. */
export const EXPIRING_CLOCK_SKEW_MS = 5 * 60_000;

export interface ExpiringRecordOptions<T> {
  /** The storage, looked up on every use: getting it may throw (`window.localStorage` in a sandboxed frame). */
  storage: () => KeyValueStorage | null | undefined;
  key: string;
  /** The value's shape; what doesn't match is invalid (and removed). */
  schema: z.ZodType<T>;
  /** How long a new hold lasts. */
  ttlMs: number;
  /** Reads records from before this format (`{…value, at}`), held `ttlMs` from `at`: their lifetime then. */
  legacy?: { ttlMs: number };
  now?: () => number;
  skewMs?: number;
}

/** A held value and its times. */
export interface HeldEntry<T> {
  value: T;
  heldAt: number;
  expiresAt: number;
}

export interface ExpiringRecord<T> {
  readonly key: string;
  /** The held value while it is valid; null otherwise (anything invalid or expired is removed). */
  read(): T | null;
  /** `read` with the value's times. */
  entry(): HeldEntry<T> | null;
  /** A new hold, expiring `ttlMs` from now. False when it couldn't be stored: then nothing is held. */
  hold(value: T): boolean;
  /**
   * Changes the held value and keeps its expiry. `change` gets the valid held value and answers the next one (null:
   * leave it). False when nothing valid is held, `change` declined, or the write failed (the previous value stays).
   */
  update(change: (current: T) => T | null): boolean;
  /** Forgets the held value (only when `which` matches it, if given). */
  clear(which?: (current: T) => boolean): void;
}

const Time = z.number().int().nonnegative();
const Envelope = z.object({ v: z.literal(1), heldAt: Time, expiresAt: Time, value: z.unknown() });
const Legacy = z.looseObject({ at: Time });

/** Records that had to go but couldn't be removed, per storage and key: the raw value that is gone (AP-590). */
const tombstones = new WeakMap<KeyValueStorage, Map<string, string>>();
/**
 * The raw value this page last read or wrote, per storage and key: what a clear that can't read the storage takes to
 * be there. Never another page's later value, which this page never saw and so never took for valid.
 */
const seen = new WeakMap<KeyValueStorage, Map<string, string>>();

const slot = (m: WeakMap<KeyValueStorage, Map<string, string>>, s: KeyValueStorage, key: string) => ({
  get: () => m.get(s)?.get(key),
  set(raw: string) {
    const byKey = m.get(s) ?? new Map<string, string>();
    byKey.set(key, raw);
    m.set(s, byKey);
  },
  drop: () => void m.get(s)?.delete(key),
});

export function expiringRecord<T>(options: ExpiringRecordOptions<T>): ExpiringRecord<T> {
  const { key, schema, ttlMs } = options;
  // Looked up on every use, so a clock replaced later (a test's fake timers) is the one that counts.
  const now = options.now ?? (() => Date.now());
  const skewMs = options.skewMs ?? EXPIRING_CLOCK_SKEW_MS;

  const open = (): KeyValueStorage | null => {
    try {
      return options.storage() ?? null;
    } catch {
      return null;
    }
  };
  const isGone = (s: KeyValueStorage, raw: string) => slot(tombstones, s, key).get() === raw;
  /** Nothing stored: no tombstone, nothing seen. */
  const settle = (s: KeyValueStorage) => {
    slot(tombstones, s, key).drop();
    slot(seen, s, key).drop();
  };
  /**
   * Removes the stored value (`raw`: what it is, as far as this page knows); when that fails, that value is gone for
   * this page anyway. Unknown (never seen, unreadable): no tombstone, so no value is hidden that this page never read.
   */
  const remove = (s: KeyValueStorage, raw: string | undefined) => {
    try {
      s.removeItem(key);
      settle(s);
    } catch {
      if (raw !== undefined) slot(tombstones, s, key).set(raw);
    }
  };
  const write = (s: KeyValueStorage, e: HeldEntry<T>): boolean => {
    const raw = JSON.stringify({ v: 1, heldAt: e.heldAt, expiresAt: e.expiresAt, value: e.value });
    try {
      s.setItem(key, raw);
    } catch {
      return false;
    }
    slot(tombstones, s, key).drop();
    slot(seen, s, key).set(raw);
    return true;
  };

  /** The stored text as a valid entry at `at`, and whether it was in the legacy format; null when it isn't one. */
  const decode = (raw: string, at: number): { entry: HeldEntry<T>; legacy: boolean } | null => {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    let heldAt: number;
    let expiresAt: number;
    let value: unknown;
    let legacy = false;
    if ('v' in data) {
      const e = Envelope.safeParse(data);
      if (!e.success || e.data.expiresAt <= e.data.heldAt) return null;
      heldAt = e.data.heldAt;
      expiresAt = Math.min(e.data.expiresAt, heldAt + ttlMs);
      value = e.data.value;
    } else if (options.legacy) {
      const l = Legacy.safeParse(data);
      if (!l.success) return null;
      const { at: held, ...rest } = l.data;
      heldAt = held;
      expiresAt = heldAt + Math.min(options.legacy.ttlMs, ttlMs);
      value = rest;
      legacy = true;
    } else return null;
    if (heldAt > at + skewMs || at >= expiresAt) return null;
    const v = schema.safeParse(value);
    return v.success ? { entry: { value: v.data, heldAt, expiresAt }, legacy } : null;
  };

  const entry = (): HeldEntry<T> | null => {
    const s = open();
    if (!s) return null;
    let raw: string | null;
    try {
      raw = s.getItem(key);
    } catch {
      return null;
    }
    if (raw === null) {
      settle(s);
      return null;
    }
    slot(seen, s, key).set(raw);
    if (isGone(s, raw)) {
      remove(s, raw);
      return null;
    }
    const found = decode(raw, now());
    if (!found) {
      remove(s, raw);
      return null;
    }
    // Migrated with the expiry it already had; if the rewrite fails, the legacy record still reads the same.
    if (found.legacy) write(s, found.entry);
    return found.entry;
  };

  const clear = (which?: (current: T) => boolean) => {
    const s = open();
    if (!s) return;
    let raw: string | null | undefined;
    try {
      raw = s.getItem(key);
    } catch {
      raw = undefined;
    }
    if (raw === null) {
      settle(s);
      return;
    }
    if (raw !== undefined) slot(seen, s, key).set(raw);
    // Unreadable: what this page last read or wrote is what it takes to be there.
    const target = raw ?? slot(seen, s, key).get();
    if (which) {
      if (target === undefined) return;
      const found = isGone(s, target) ? null : decode(target, now());
      // A valid value that isn't the one meant stays; anything invalid, expired or gone goes like any invalid one.
      if (found && !which(found.entry.value)) return;
    }
    remove(s, target);
  };

  return {
    key,
    read: () => entry()?.value ?? null,
    entry,
    hold(value) {
      const s = open();
      const parsed = schema.safeParse(value);
      if (s && parsed.success) {
        const at = now();
        if (write(s, { value: parsed.data, heldAt: at, expiresAt: at + ttlMs })) return true;
      }
      // Not held: an older value doesn't stand in for the one that couldn't be stored.
      clear();
      return false;
    },
    update(change) {
      const s = open();
      const current = s ? entry() : null;
      if (!s || !current) return false;
      const next = change(current.value);
      if (next === null) return false;
      const parsed = schema.safeParse(next);
      return parsed.success && write(s, { ...current, value: parsed.data });
    },
    clear,
  };
}
