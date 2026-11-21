import type { AndroidDownload } from '@whombat/client/managed';
import { describe, expect, it, vi } from 'vitest';
import {
  appUpdateStatus,
  createUpdateCheck,
  newerAppPublished,
  UPDATE_CHECK_FRESH_MS,
  UPDATE_UNASKED,
  updateCheckFor,
} from './appUpdate';

const apk = (versionCode: number): AndroidDownload => ({
  version: `0.${Math.floor(versionCode / 1000)}.${versionCode % 1000}`,
  versionCode,
  size: 1,
  sha256: 'ab'.repeat(32),
  publishedAt: '2026-10-04T10:00:00Z',
  url: 'https://api.whombat.com/v1/downloads/android/whombat.apk',
});

describe('a newer app (AP-701)', () => {
  it('is offered only when the published versionCode is above this build’s', () => {
    expect(newerAppPublished(apk(34_001), 34_000)).toBe(true);
    expect(newerAppPublished(apk(34_000), 34_000)).toBe(false);
    // DEV served 0.17.1 to a 0.34.0 phone: nothing newer to get.
    expect(newerAppPublished(apk(17_001), 34_000)).toBe(false);
    expect(newerAppPublished(null, 34_000)).toBe(false);
    expect(newerAppPublished(apk(34_001), undefined)).toBe(false);
  });

  it('asks control at most every five minutes, one request at a time, a failure counting the same', async () => {
    let t = 0;
    const fetch = vi.fn<() => Promise<AndroidDownload | null>>().mockResolvedValue(apk(34_001));
    const check = createUpdateCheck(fetch, () => t);
    const [a, b] = await Promise.all([check.get(), check.get()]);
    expect(a?.versionCode).toBe(34_001);
    expect(b).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(1);
    t += UPDATE_CHECK_FRESH_MS - 1;
    await check.get();
    expect(fetch).toHaveBeenCalledTimes(1);
    t += 1;
    fetch.mockRejectedValueOnce(new Error('offline'));
    await check.get();
    expect(fetch).toHaveBeenCalledTimes(2);
    t += UPDATE_CHECK_FRESH_MS - 1;
    await check.get();
    expect(fetch).toHaveBeenCalledTimes(2);
    t += 1;
    await check.get();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('asks again at once when forced (AP-2972), joining a request already out', async () => {
    const fetch = vi.fn<() => Promise<AndroidDownload | null>>().mockResolvedValue(null);
    const check = createUpdateCheck(fetch, () => 0);
    await check.get();
    fetch.mockResolvedValueOnce(apk(34_002));
    expect((await check.get(true))?.versionCode).toBe(34_002);
    expect(fetch).toHaveBeenCalledTimes(2);
    await Promise.all([check.get(true), check.get(true)]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('tells every screen the same answer, and keeps a known update through a failed ask (AP-2970)', async () => {
    const fetch = vi.fn<() => Promise<AndroidDownload | null>>().mockResolvedValue(apk(34_001));
    const check = createUpdateCheck(fetch, () => 0);
    const seen = vi.fn();
    const stop = check.subscribe(() => seen(check.state()));
    const asked = check.get();
    expect(check.state().checking).toBe(true);
    await asked;
    expect(check.state()).toMatchObject({ answered: true, checking: false, failed: false });
    expect(check.state().published?.versionCode).toBe(34_001);
    fetch.mockRejectedValueOnce(new Error('offline'));
    expect((await check.get(true))?.versionCode).toBe(34_001);
    expect(check.state()).toMatchObject({ failed: true, checking: false });
    expect(check.state().published?.versionCode).toBe(34_001);
    expect(seen).toHaveBeenCalledTimes(4);
    stop();
    await check.get(true);
    expect(seen).toHaveBeenCalledTimes(4);
  });

  it('keeps one check per control client', () => {
    const control = { androidDownload: async () => null };
    expect(updateCheckFor(control)).toBe(updateCheckFor(control));
    expect(updateCheckFor({ androidDownload: async () => null })).not.toBe(updateCheckFor(control));
  });
});

describe('where this app stands (AP-2972)', () => {
  const answered = { ...UPDATE_UNASKED, answered: true };
  it('is newer when a newer build is out, even while asking again or after a failed ask', () => {
    expect(appUpdateStatus({ ...answered, published: apk(34_001) }, 34_000)).toBe('newer');
    expect(appUpdateStatus({ ...answered, published: apk(34_001), checking: true }, 34_000)).toBe('newer');
    expect(appUpdateStatus({ ...answered, published: apk(34_001), failed: true }, 34_000)).toBe('newer');
  });

  it('is up to date only after an answer, and never for a build that doesn’t know its number', () => {
    expect(appUpdateStatus({ ...answered, published: apk(34_000) }, 34_000)).toBe('newest');
    expect(appUpdateStatus(answered, 34_000)).toBe('newest');
    expect(appUpdateStatus(UPDATE_UNASKED, 34_000)).toBe('unknown');
    expect(appUpdateStatus(answered, undefined)).toBe('unknown');
    expect(appUpdateStatus({ ...answered, checking: true }, 34_000)).toBe('checking');
    expect(appUpdateStatus({ ...answered, failed: true }, 34_000)).toBe('failed');
  });
});

describe('Update available (SS-71)', () => {
  it('names the version and its size in MB, at least 1', async () => {
    const { COPY } = await import('./copy');
    expect(COPY.update.available).toBe('Update available');
    expect(COPY.update.availableMeta('0.37.0', 58_405_289)).toBe(
      '0.37.0 · 58 MB · Download and install it over this app.',
    );
    expect(COPY.update.availableMeta('0.37.1', 1)).toBe(
      '0.37.1 · 1 MB · Download and install it over this app.',
    );
  });
});
