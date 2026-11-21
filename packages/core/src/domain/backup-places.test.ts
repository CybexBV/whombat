import { describe, expect, it } from 'vitest';
import {
  type BackupPlace,
  backupPlaceClient,
  backupPlaceId,
  bestBackupPlace,
  parseBackupPlaceId,
} from './backup-places.js';

const place = (over: Partial<BackupPlace>): BackupPlace => ({
  id: 'server:x',
  kind: 'linux',
  name: 'x',
  address: null,
  state: 'ready',
  reason: null,
  byHand: false,
  kept: null,
  locations: [],
  location: null,
  ...over,
});
const free = (n: number) => ({
  usedBytes: 0,
  freeBytes: n,
  cleanup: { on: false, keepDays: 90, lastAt: null, ok: null },
  byHand: false,
});

describe('backup place ids', () => {
  it('round-trips every kind of place', () => {
    for (const ref of [
      { type: 'server', id: 'blackbox' },
      { type: 'connection', id: 'con_1' },
      { type: 'found', host: '10.0.0.5' },
    ] as const)
      expect(parseBackupPlaceId(backupPlaceId(ref))).toEqual(ref);
    expect(parseBackupPlaceId('nas-01')).toBeNull();
  });
});

describe('bestBackupPlace', () => {
  it('prefers a ready NAS, then a ready server with most space, then a NAS to connect', () => {
    const nas = place({ id: 'server:blackbox', kind: 'unraid', name: 'BlackBox' });
    const big = place({ id: 'server:the-titan', name: 'The Titan', kept: free(10e12) });
    const found = place({ id: 'found:10.0.0.9', kind: 'synology', state: 'connect_first' });
    expect(bestBackupPlace([big, found, nas])?.id).toBe('server:blackbox');
    expect(bestBackupPlace([found, big, place({ id: 'server:small', kept: free(1) })])?.id).toBe(
      'server:the-titan',
    );
    expect(bestBackupPlace([found, place({ state: 'manage_first' })])?.id).toBe('found:10.0.0.9');
    expect(bestBackupPlace([place({ state: 'unsupported' })])).toBeNull();
  });
});

describe('backupPlaceClient', () => {
  it('names a Whombat’s backups as the backup app takes it', () => {
    const re = /^[a-z0-9][a-z0-9-]{2,62}$/;
    expect(backupPlaceClient('Home', '3fkq')).toBe('whombat-home-3fkq');
    expect(backupPlaceClient('Café Ünïcode!!', 'AB12')).toBe('whombat-cafe-unicode-ab12');
    expect(backupPlaceClient('', '3fkq')).toBe('whombat-3fkq');
    const long = backupPlaceClient('x'.repeat(200), 'abcd');
    expect(long).toMatch(re);
    expect(long.endsWith('-abcd')).toBe(true);
    expect(backupPlaceClient('---', '')).toMatch(re);
  });
});
