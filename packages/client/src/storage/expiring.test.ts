import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  EXPIRING_CLOCK_SKEW_MS,
  type ExpiringRecordOptions,
  expiringRecord,
  type KeyValueStorage,
} from './expiring';

const KEY = 'whombat:test-link';
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 30, 12);

/** A `Storage` in memory whose methods can be made to throw, like a disabled or full browser storage. */
function fakeStorage() {
  const data = new Map<string, string>();
  const fail = { get: false, set: false, remove: false, quota: false };
  const storage: KeyValueStorage = {
    getItem(k) {
      if (fail.get) throw new Error('SecurityError: storage is disabled');
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      if (fail.quota)
        throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
      if (fail.set) throw new Error('SecurityError: storage is disabled');
      data.set(k, v);
    },
    removeItem(k) {
      if (fail.remove) throw new Error('SecurityError: storage is disabled');
      data.delete(k);
    },
  };
  return { storage, data, fail };
}

const Link = z.object({ device: z.string().min(1), secret: z.string().min(1).nullable() });
type Link = z.infer<typeof Link>;

function setup(overrides: Partial<ExpiringRecordOptions<Link>> = {}) {
  const s = fakeStorage();
  const clock = { now: T0 };
  const record = expiringRecord<Link>({
    storage: () => s.storage,
    key: KEY,
    schema: Link,
    ttlMs: HOUR,
    legacy: { ttlMs: HOUR },
    now: () => clock.now,
    ...overrides,
  });
  const stored = () => JSON.parse(s.data.get(KEY) ?? 'null') as unknown;
  const put = (v: unknown) => s.data.set(KEY, typeof v === 'string' ? v : JSON.stringify(v));
  return { ...s, clock, record, stored, put };
}

const link: Link = { device: 'dev_1', secret: 's3cret' };

describe('an expiring record (AP-590)', () => {
  it('holds a value with its absolute expiry and reads it back (a reload resumes)', () => {
    const t = setup();
    expect(t.record.hold(link)).toBe(true);
    expect(t.stored()).toEqual({ v: 1, heldAt: T0, expiresAt: T0 + HOUR, value: link });
    expect(t.record.read()).toEqual(link);
    // Another page on the same storage (the magic link's new tab) reads the same.
    const other = expiringRecord({
      storage: () => t.storage,
      key: KEY,
      schema: Link,
      ttlMs: HOUR,
      now: () => T0 + 1,
    });
    expect(other.read()).toEqual(link);
    expect(t.record.entry()).toEqual({ value: link, heldAt: T0, expiresAt: T0 + HOUR });
  });

  it('is valid until just before its expiry and gone at it exactly, and removed then', () => {
    const t = setup();
    t.record.hold(link);
    t.clock.now = T0 + HOUR - 1;
    expect(t.record.read()).toEqual(link);
    t.clock.now = T0 + HOUR;
    expect(t.record.read()).toBeNull();
    expect(t.data.has(KEY)).toBe(false);
  });

  it('never lasts longer than its lifetime after heldAt, whatever expiresAt says', () => {
    const t = setup();
    t.put({ v: 1, heldAt: T0, expiresAt: T0 + 30 * 24 * HOUR, value: link });
    t.clock.now = T0 + HOUR - 1;
    expect(t.record.read()).toEqual(link);
    t.clock.now = T0 + HOUR;
    expect(t.record.read()).toBeNull();
    expect(t.data.has(KEY)).toBe(false);
  });

  it('accepts a heldAt up to the clock skew in the future, and nothing later', () => {
    const t = setup();
    t.put({
      v: 1,
      heldAt: T0 + EXPIRING_CLOCK_SKEW_MS,
      expiresAt: T0 + EXPIRING_CLOCK_SKEW_MS + HOUR,
      value: link,
    });
    expect(t.record.read()).toEqual(link);
    t.put({
      v: 1,
      heldAt: T0 + EXPIRING_CLOCK_SKEW_MS + 1,
      expiresAt: T0 + EXPIRING_CLOCK_SKEW_MS + 1 + HOUR,
      value: link,
    });
    expect(t.record.read()).toBeNull();
    expect(t.data.has(KEY)).toBe(false);
    expect(EXPIRING_CLOCK_SKEW_MS).toBe(300_000);
  });

  it('drops times that aren’t finite integers, and an expiry not after heldAt', () => {
    const t = setup();
    for (const [heldAt, expiresAt] of [
      [T0, 'Infinity'],
      [T0, null],
      ['1790000000000', T0 + HOUR],
      [T0 + 0.5, T0 + HOUR],
      [-1, T0 + HOUR],
      [T0, T0],
      [T0, T0 - 1],
      [undefined, T0 + HOUR],
    ]) {
      t.put({ v: 1, heldAt, expiresAt, value: link });
      expect(t.record.read(), `${heldAt} → ${expiresAt}`).toBeNull();
      expect(t.data.has(KEY)).toBe(false);
    }
    // JSON can't carry NaN or Infinity: they arrive as null, or as text that isn't JSON at all.
    t.put(`{"v":1,"heldAt":NaN,"expiresAt":Infinity,"value":{"device":"dev_1","secret":"s"}}`);
    expect(t.record.read()).toBeNull();
    expect(t.data.has(KEY)).toBe(false);
  });

  it('drops malformed JSON, wrong shapes and unknown versions', () => {
    const t = setup();
    for (const raw of [
      'not json',
      '',
      'null',
      '42',
      '"dev_1"',
      '[]',
      JSON.stringify({ v: 1, heldAt: T0, expiresAt: T0 + HOUR }),
      JSON.stringify({ v: 1, heldAt: T0, expiresAt: T0 + HOUR, value: { device: 42, secret: 's' } }),
      JSON.stringify({ v: 1, heldAt: T0, expiresAt: T0 + HOUR, value: { device: '', secret: 's' } }),
      JSON.stringify({ v: 2, heldAt: T0, expiresAt: T0 + HOUR, value: link }),
    ]) {
      t.put(raw);
      expect(t.record.read(), raw).toBeNull();
      expect(t.data.has(KEY)).toBe(false);
    }
  });

  it('keeps a legacy record until its original expiry, migrates it with that expiry, never extends it', () => {
    const t = setup();
    t.put({ ...link, at: T0 - HOUR / 2 });
    expect(t.record.read()).toEqual(link);
    // Rewritten in the new format with the expiry it had.
    expect(t.stored()).toEqual({ v: 1, heldAt: T0 - HOUR / 2, expiresAt: T0 + HOUR / 2, value: link });
    t.clock.now = T0 + HOUR / 2 - 1;
    expect(t.record.read()).toEqual(link);
    t.clock.now = T0 + HOUR / 2;
    expect(t.record.read()).toBeNull();
    expect(t.data.has(KEY)).toBe(false);
  });

  it('keeps a legacy record even when it can’t be migrated, with the same expiry', () => {
    const t = setup();
    t.put({ ...link, at: T0 });
    t.fail.set = true;
    expect(t.record.entry()).toEqual({ value: link, heldAt: T0, expiresAt: T0 + HOUR });
    expect(JSON.parse(t.data.get(KEY) ?? '')).toEqual({ ...link, at: T0 });
  });

  it('drops legacy records that are expired, future-dated, badly timed or badly shaped', () => {
    const t = setup();
    for (const v of [
      { ...link, at: T0 - HOUR },
      { ...link, at: T0 + 7 * 24 * HOUR },
      { ...link, at: T0 + EXPIRING_CLOCK_SKEW_MS + 1 },
      { ...link, at: 'yesterday' },
      { ...link, at: null },
      { ...link },
      { device: 'dev_1', at: T0 },
    ]) {
      t.put(v);
      expect(t.record.read(), JSON.stringify(v)).toBeNull();
      expect(t.data.has(KEY)).toBe(false);
    }
  });

  it('a legacy lifetime shorter than the new one is kept; a longer one is cut to the new one', () => {
    const short = setup({ legacy: { ttlMs: HOUR / 4 } });
    short.put({ ...link, at: T0 });
    expect(short.record.entry()?.expiresAt).toBe(T0 + HOUR / 4);
    const long = setup({ legacy: { ttlMs: 7 * 24 * HOUR } });
    long.put({ ...link, at: T0 });
    expect(long.record.entry()?.expiresAt).toBe(T0 + HOUR);
  });

  it('reads no legacy records unless asked to', () => {
    const t = setup({ legacy: undefined });
    t.put({ ...link, at: T0 });
    expect(t.record.read()).toBeNull();
    expect(t.data.has(KEY)).toBe(false);
  });

  it('an update keeps the expiry; a new hold starts a new one', () => {
    const t = setup();
    t.record.hold(link);
    t.clock.now = T0 + HOUR / 2;
    expect(t.record.update((v) => ({ ...v, secret: null }))).toBe(true);
    expect(t.record.entry()).toEqual({
      value: { device: 'dev_1', secret: null },
      heldAt: T0,
      expiresAt: T0 + HOUR,
    });
    // Reading doesn't extend it either.
    t.clock.now = T0 + HOUR;
    expect(t.record.read()).toBeNull();

    t.record.hold(link);
    expect(t.record.entry()).toEqual({ value: link, heldAt: T0 + HOUR, expiresAt: T0 + 2 * HOUR });
  });

  it('an update of nothing, of an expired record, or that declines writes nothing', () => {
    const t = setup();
    expect(t.record.update((v) => v)).toBe(false);
    expect(t.data.has(KEY)).toBe(false);
    t.record.hold(link);
    expect(t.record.update(() => null)).toBe(false);
    expect(t.record.update(() => ({ device: '', secret: null }))).toBe(false);
    expect(t.record.read()).toEqual(link);
    t.clock.now = T0 + HOUR;
    expect(t.record.update((v) => ({ ...v, secret: null }))).toBe(false);
    expect(t.data.has(KEY)).toBe(false);
  });

  it('an update of a legacy record keeps its original expiry', () => {
    const t = setup();
    t.put({ ...link, at: T0 - HOUR / 2 });
    expect(t.record.update((v) => ({ ...v, secret: null }))).toBe(true);
    expect(t.stored()).toEqual({
      v: 1,
      heldAt: T0 - HOUR / 2,
      expiresAt: T0 + HOUR / 2,
      value: { device: 'dev_1', secret: null },
    });
  });

  it('holds only values of its shape; one that isn’t leaves nothing held', () => {
    const t = setup();
    t.record.hold(link);
    expect(t.record.hold({ device: '', secret: 'x' })).toBe(false);
    expect(t.record.read()).toBeNull();
    expect(t.data.has(KEY)).toBe(false);
  });

  it('is cleared, only when it matches if asked to, and never touches another key', () => {
    const t = setup();
    t.data.set('whombat:other', 'kept');
    t.record.hold(link);
    t.record.clear((v) => v.device === 'dev_2');
    expect(t.record.read()).toEqual(link);
    t.record.clear((v) => v.device === 'dev_1');
    expect(t.record.read()).toBeNull();
    t.record.hold(link);
    t.record.clear();
    expect(t.data.has(KEY)).toBe(false);
    expect(t.data.get('whombat:other')).toBe('kept');
    // Cleanup of an invalid record leaves other keys alone too.
    t.put('not json');
    t.record.read();
    expect([...t.data.keys()]).toEqual(['whombat:other']);
  });

  it('reads the clock when used (so a test’s fake timers count)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      const t = setup({ now: undefined });
      t.record.hold(link);
      expect(t.record.entry()?.heldAt).toBe(T0);
      vi.setSystemTime(T0 + HOUR);
      expect(t.record.read()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('when the storage throws', () => {
    it('storage that can’t even be reached: nothing read, nothing held, no crash', () => {
      const r = expiringRecord({
        storage: () => {
          throw new Error('SecurityError: The operation is insecure.');
        },
        key: KEY,
        schema: Link,
        ttlMs: HOUR,
      });
      expect(r.read()).toBeNull();
      expect(r.hold(link)).toBe(false);
      expect(r.update((v) => v)).toBe(false);
      expect(() => r.clear()).not.toThrow();
      const none = expiringRecord({ storage: () => undefined, key: KEY, schema: Link, ttlMs: HOUR });
      expect(none.read()).toBeNull();
      expect(none.hold(link)).toBe(false);
    });

    it('a read that throws is null', () => {
      const t = setup();
      t.record.hold(link);
      t.fail.get = true;
      expect(t.record.read()).toBeNull();
      expect(() => t.record.clear()).not.toThrow();
    });

    it('a full storage: the hold answers false, and an older value doesn’t stand in for the new one', () => {
      const t = setup();
      t.record.hold({ device: 'dev_old', secret: 'old' });
      t.fail.quota = true;
      expect(t.record.hold(link)).toBe(false);
      expect(t.record.read()).toBeNull();
      expect(t.data.has(KEY)).toBe(false);
    });

    it('a write and a remove that both fail: the older value is still never read on this page', () => {
      const t = setup();
      t.record.hold({ device: 'dev_old', secret: 'old' });
      t.fail.set = true;
      t.fail.remove = true;
      expect(t.record.hold(link)).toBe(false);
      expect(t.data.has(KEY)).toBe(true);
      expect(t.record.read()).toBeNull();
      // Another record object on the same storage and key (the same page) knows it too.
      expect(
        expiringRecord({
          storage: () => t.storage,
          key: KEY,
          schema: Link,
          ttlMs: HOUR,
          now: () => T0,
        }).read(),
      ).toBeNull();
    });

    it('a clear whose remove fails leaves a tombstone until the value is really gone or replaced', () => {
      const t = setup();
      t.record.hold(link);
      t.fail.remove = true;
      t.record.clear();
      expect(t.data.has(KEY)).toBe(true);
      expect(t.record.read()).toBeNull();
      expect(t.record.update((v) => v)).toBe(false);
      // Removable again: the next read removes it for good.
      t.fail.remove = false;
      expect(t.record.read()).toBeNull();
      expect(t.data.has(KEY)).toBe(false);
      // A new hold is read again.
      t.record.hold(link);
      t.fail.remove = true;
      t.record.clear();
      t.fail.remove = false;
      t.clock.now = T0 + 1;
      expect(t.record.hold({ device: 'dev_2', secret: 'new' })).toBe(true);
      expect(t.record.read()).toEqual({ device: 'dev_2', secret: 'new' });
    });

    it('a tombstone hides only the value that had to go: one another page wrote later is read', () => {
      const t = setup();
      t.record.hold(link);
      t.fail.remove = true;
      t.record.clear();
      t.put({
        v: 1,
        heldAt: T0 + 1,
        expiresAt: T0 + 1 + HOUR,
        value: { device: 'dev_2', secret: 'other tab' },
      });
      expect(t.record.read()).toEqual({ device: 'dev_2', secret: 'other tab' });
    });

    it('an expired or invalid record that can’t be removed is still never valid (even with the clock set back)', () => {
      const t = setup();
      t.record.hold(link);
      t.fail.remove = true;
      t.clock.now = T0 + HOUR;
      expect(t.record.read()).toBeNull();
      expect(t.data.has(KEY)).toBe(true);
      t.clock.now = T0;
      expect(t.record.read()).toBeNull();
    });

    it('a clear that can’t read or remove hides the value this page last saw until a write succeeds', () => {
      const t = setup();
      t.record.hold(link);
      t.fail.get = true;
      t.fail.remove = true;
      t.record.clear();
      t.fail.get = false;
      expect(t.record.read()).toBeNull();
      t.fail.remove = false;
      expect(t.record.hold(link)).toBe(true);
      expect(t.record.read()).toEqual(link);
    });

    it('…and a different value another page holds later is read, and never removed by this page', () => {
      const t = setup();
      t.record.hold(link);
      t.fail.get = true;
      t.fail.remove = true;
      t.record.clear();
      t.fail.get = false;
      const later = {
        v: 1,
        heldAt: T0 + 1,
        expiresAt: T0 + 1 + HOUR,
        value: { device: 'dev_2', secret: 'new link' },
      };
      t.put(later);
      expect(t.record.read()).toEqual({ device: 'dev_2', secret: 'new link' });
      t.fail.remove = false;
      expect(t.record.read()).toEqual({ device: 'dev_2', secret: 'new link' });
      expect(t.stored()).toEqual(later);
    });

    it('a clear that can’t read or remove, on a page that never saw a value, hides nothing', () => {
      const t = setup();
      t.put({ v: 1, heldAt: T0, expiresAt: T0 + HOUR, value: link });
      t.fail.get = true;
      t.fail.remove = true;
      t.record.clear();
      t.fail.get = false;
      t.fail.remove = false;
      expect(t.record.read()).toEqual(link);
      expect(t.data.has(KEY)).toBe(true);
    });

    it('a clear of one Whombat’s value when storage can’t be read takes only what this page saw of it', () => {
      const t = setup();
      t.record.hold(link);
      t.fail.get = true;
      t.fail.remove = true;
      t.record.clear((v) => v.device === 'dev_2');
      t.fail.get = false;
      expect(t.record.read()).toEqual(link);
      t.fail.get = true;
      t.record.clear((v) => v.device === 'dev_1');
      t.fail.get = false;
      expect(t.record.read()).toBeNull();
    });

    it('a failed update answers false and leaves the previous value', () => {
      const t = setup();
      t.record.hold(link);
      t.fail.quota = true;
      expect(t.record.update((v) => ({ ...v, secret: null }))).toBe(false);
      expect(t.record.read()).toEqual(link);
    });
  });
});
