import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions } from '@whombat/release';
import { describe, expect, it } from 'vitest';
import { TMP_DIR } from '../lib/paths.ts';
import { DEV_MANAGER_VERSION, devManagerVersion, firstReleaseId, nextReleaseId } from './releases.ts';

describe('the development releases’ manager version', () => {
  it('equals what the development manager reports, so control never holds a candidate as older', () => {
    const reported = devManagerVersion('b666dcfaaf21a9512d620aa203526fbdb5773482');
    expect(reported).toBe('0.2.0-0.dev+b666dcfaaf21');
    expect(compareVersions(DEV_MANAGER_VERSION, reported)).toBe(0);
    // Below every release build's manager (NX-105).
    expect(compareVersions(DEV_MANAGER_VERSION, '0.3.0-20261115171422.3734f94')).toBeLessThan(0);
    // TUF refuses build metadata in a tuple.
    expect(DEV_MANAGER_VERSION).not.toContain('+');
  });
});

describe('release ids of the environment’s repository (a channel lists ordered ids only)', () => {
  const repo = () => {
    const dir = mkdtempSync(join(TMP_DIR, 'wb-releases-'));
    mkdirSync(join(dir, 'artifacts'));
    return { tuf: join(dir, 'tuf'), art: join(dir, 'artifacts'), dir };
  };
  const day = new Date('2026-11-20T23:30:00Z');

  it('starts at the day’s first id and counts on from the ids published before', () => {
    const r = repo();
    expect(nextReleaseId(r.tuf, day)).toBe('whombat-dev-20261120.1');
    for (const id of ['whombat-dev-20261120.1', 'whombat-dev-20261120.9', 'whombat-dev-20261119.40'])
      writeFileSync(join(r.art, `${id}.tuple.json`), '{}');
    // A file of another kind and an id of no family don't count.
    writeFileSync(join(r.art, 'whombat-dev-20261120.30.runtime.json'), '{}');
    writeFileSync(join(r.art, 'rt-0.284.0.tuple.json'), '{}');
    expect(nextReleaseId(r.tuf, day)).toBe('whombat-dev-20261120.10');
  });

  it('never goes back: every id sorts after the ones before, also over midnight and a clock set back', () => {
    const r = repo();
    writeFileSync(join(r.art, 'whombat-dev-20261120.7.tuple.json'), '{}');
    const next = nextReleaseId(r.tuf, new Date('2026-11-21T00:10:00Z'));
    expect(next).toBe('whombat-dev-20261121.1');
    expect(compareVersions('whombat-dev-20261120.7', next)).toBeLessThan(0);
    writeFileSync(join(r.art, `${next}.tuple.json`), '{}');
    // The clock went back a day: the newest published day still counts.
    expect(nextReleaseId(r.tuf, day)).toBe('whombat-dev-20261121.2');
  });

  it('the box’s first release is the repository’s first id, or the pins’ own before channels', () => {
    const r = repo();
    expect(firstReleaseId(r.tuf, 'rt-0.284.0')).toBe('rt-0.284.0');
    writeFileSync(join(r.dir, 'first-release'), 'whombat-dev-20261120.1\n');
    expect(firstReleaseId(r.tuf, 'rt-0.284.0')).toBe('whombat-dev-20261120.1');
  });
});
