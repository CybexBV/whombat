/**
 * The kinds' read cache (page-speed.md PS-01): what `cachedRead` (the health pass) and `latestRead` (a page) give, from
 * the same entry; a live part kept 4 seconds (`liveRead`, service-dashboards.md SD-S05).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../services';
import { cachedRead, forgetConnectionReads, LIVE_CACHE_MS, latestRead, liveRead } from './read';

const row = { credentialVersion: 1, updatedAt: new Date('2026-10-19T12:00:00Z') };

/** A read that answers when told to. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A loader counting its calls, answering with `values` in turn or with what `next` is given. */
function loader<T>(values: T[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    load: () => {
      const v = values[calls++];
      return v === undefined ? Promise.reject(new Error('down')) : Promise.resolve(v);
    },
  };
}

describe('latestRead', () => {
  it('waits for a connection’s first read, then serves it while it is fresh', async () => {
    const services = {} as Services;
    const l = loader(['first']);
    expect(await latestRead(services, 'k', row, l.load)).toMatchObject({
      ok: true,
      value: 'first',
      refreshing: false,
    });
    expect(await latestRead(services, 'k', row, l.load)).toMatchObject({ ok: true, value: 'first' });
    expect(l.calls).toBe(1);
  });

  it('serves a fresh read when it answers within the wait', async () => {
    const services = {} as Services;
    const l = loader(['old', 'new']);
    await latestRead(services, 'k', row, l.load);
    expect(await latestRead(services, 'k', row, l.load, { ttlMs: -1 })).toMatchObject({
      value: 'new',
      refreshing: false,
    });
  });

  it('serves the last read while a slow one is under way, then the new one', async () => {
    const services = {} as Services;
    await latestRead(services, 'k', row, () => Promise.resolve('old'));
    const slow = deferred<string>();
    const shown = await latestRead(services, 'k', row, () => slow.promise, { ttlMs: -1, waitMs: 10 });
    expect(shown).toMatchObject({ ok: true, value: 'old', refreshing: true });
    // Asked again meanwhile: the same read, not a second one.
    let second = 0;
    const meanwhile = await latestRead(
      services,
      'k',
      row,
      () => {
        second++;
        return Promise.resolve('other');
      },
      { ttlMs: -1, waitMs: 10 },
    );
    expect(meanwhile).toMatchObject({ value: 'old', refreshing: true });
    expect(second).toBe(0);
    slow.resolve('new');
    await slow.promise;
    expect(await latestRead(services, 'k', row, () => slow.promise)).toMatchObject({
      value: 'new',
      refreshing: false,
    });
  });

  it('keeps a failure for a page, so a service that doesn’t answer doesn’t hold every page', async () => {
    const services = {} as Services;
    const l = loader<string>([]);
    const failed = await latestRead(services, 'k', row, l.load);
    expect(failed).toMatchObject({ ok: false, refreshing: false });
    expect(await latestRead(services, 'k', row, l.load)).toMatchObject({ ok: false });
    expect(l.calls).toBe(1);
    // The health pass reads again.
    await expect(cachedRead(services, 'k', row, l.load)).rejects.toThrow('down');
    expect(l.calls).toBe(2);
  });

  it('shares its entry with cachedRead and reads again for a new credential', async () => {
    const services = {} as Services;
    const l = loader(['by the health pass', 'after reconnecting']);
    await cachedRead(services, 'k', row, l.load);
    expect(await latestRead(services, 'k', row, l.load)).toMatchObject({ value: 'by the health pass' });
    expect(await latestRead(services, 'k', { ...row, credentialVersion: 2 }, l.load)).toMatchObject({
      value: 'after reconnecting',
    });
    expect(l.calls).toBe(2);
  });
});

describe('liveRead (SD-S05)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a live part 4 seconds, then reads it again; the module’s liveS replaces that', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    const services = {} as Services;
    const l = loader(['queue 1', 'queue 2', 'queue 3']);
    expect(await liveRead(services, 'sab-live:1', row, l.load)).toMatchObject({ value: 'queue 1' });
    vi.setSystemTime(Date.now() + LIVE_CACHE_MS - 500);
    expect(await liveRead(services, 'sab-live:1', row, l.load)).toMatchObject({ value: 'queue 1' });
    vi.setSystemTime(Date.now() + 1_000);
    expect(await liveRead(services, 'sab-live:1', row, l.load)).toMatchObject({
      value: 'queue 2',
      refreshing: false,
    });
    expect(l.calls).toBe(2);
    // Kept 10 seconds when the kind says so.
    vi.setSystemTime(Date.now() + 6_000);
    expect(await liveRead(services, 'sab-live:1', row, l.load, { liveS: 10 })).toMatchObject({
      value: 'queue 2',
    });
    expect(l.calls).toBe(2);
  });
});

describe('cachedRead kept long', () => {
  it('keeps a read kept an hour past the usual 15 minutes, while other reads come and go', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));
    const services = {} as Services;
    const hourly = loader(['bases']);
    const other = loader(['a', 'b']);
    expect(await cachedRead(services, 'airtable:1', row, hourly.load, 3_600_000)).toBe('bases');
    vi.setSystemTime(Date.now() + 20 * 60_000);
    // Another read drops what nobody can use any more; the hourly one stays.
    await cachedRead(services, 'other:1', row, other.load);
    expect(await cachedRead(services, 'airtable:1', row, hourly.load, 3_600_000)).toBe('bases');
    expect(hourly.calls).toBe(1);
  });
});

describe('forgetConnectionReads (SD-S10)', () => {
  it('reads a connection again after a button, every part of it, and leaves the others kept', async () => {
    const services = {} as Services;
    const one = { ...row, id: 'con_1' };
    const other = { ...row, id: 'con_2' };
    const whole = loader(['before', 'after']);
    const live = loader(['paused', 'running']);
    const elsewhere = loader(['kept']);
    await latestRead(services, 'sab:con_1', one, whole.load);
    await liveRead(services, 'sab-live:con_1', one, live.load);
    await latestRead(services, 'sab:con_2', other, elsewhere.load);
    forgetConnectionReads(services, 'con_1');
    expect(await latestRead(services, 'sab:con_1', one, whole.load)).toMatchObject({ value: 'after' });
    expect(await liveRead(services, 'sab-live:con_1', one, live.load)).toMatchObject({ value: 'running' });
    expect(await latestRead(services, 'sab:con_2', other, elsewhere.load)).toMatchObject({ value: 'kept' });
    expect(elsewhere.calls).toBe(1);
  });
});
