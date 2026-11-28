import { describe, expect, it } from 'vitest';
import {
  betterProtection,
  haAgentName,
  haProtection,
  synologyProtection,
  truenasProtection,
} from './protection';
import { failingTests } from './runner';
import { offsiteOf } from './view';

const d = (s: string) => new Date(s);

describe('Home Assistant’s backups', () => {
  it('count as copied when the newest copy went somewhere else', () => {
    const got = haProtection([
      { at: d('2026-11-27T03:00:00Z'), elsewhere: [] },
      { at: d('2026-11-26T03:00:00Z'), elsewhere: ['cloud.cloud', 'hassio.nas_backups'] },
    ]);
    expect(got).toMatchObject({ state: 'copied', lastAt: '2026-11-26T03:00:00.000Z' });
    expect(got?.where).toContain('Home Assistant Cloud');
    expect(got?.where).toContain('nas backups');
  });
  it('stay on the same machine, none, or unknown when not read', () => {
    expect(haProtection([{ at: d('2026-11-27T03:00:00Z'), elsewhere: [] }])?.state).toBe('local');
    expect(haProtection([])?.state).toBe('none');
    expect(haProtection(null)).toBeUndefined();
    expect(haAgentName('google_drive.abc')).toBe('Google Drive');
  });
});

describe('a NAS’s own backups', () => {
  it('Hyper Backup to the cloud or another NAS is copied; to a USB disk on it, the same machine', () => {
    expect(
      synologyProtection([
        { name: 'To B2', result: 'ok', last: d('2026-11-27T02:00:00Z'), target: 'cloud' },
        { name: 'USB', result: 'ok', last: d('2026-11-27T04:00:00Z'), target: 'local' },
      ]),
    ).toMatchObject({ state: 'copied', where: 'To B2', lastAt: '2026-11-27T02:00:00.000Z' });
    expect(synologyProtection([{ name: 'USB', result: 'ok', last: d('2026-11-27T04:00:00Z'), target: 'local' }])?.state).toBe(
      'local',
    );
    const failed = synologyProtection([
      { name: 'To B2', result: 'failed', last: d('2026-11-27T02:00:00Z'), target: 'cloud' },
    ]);
    expect(failed?.failedAt).toBe('2026-11-27T02:00:00.000Z');
    expect(failed?.lastAt).toBeNull();
    expect(synologyProtection(null)).toBeUndefined();
  });
  it('TrueNAS replication is copied, snapshots alone stay on it', () => {
    expect(
      truenasProtection([
        { kind: 'snapshot', name: 'tank', result: 'ok', at: d('2026-11-27T01:00:00Z') },
        { kind: 'replication', name: 'to-backup', result: 'ok', at: d('2026-11-27T02:00:00Z') },
      ]),
    ).toMatchObject({ state: 'copied', where: 'to-backup' });
    expect(truenasProtection([{ kind: 'snapshot', name: 'tank', result: 'ok', at: d('2026-11-27T01:00:00Z') }])?.state).toBe(
      'local',
    );
    expect(truenasProtection([])?.state).toBe('none');
  });
  it('the better of a service’s own facts and its machine’s wins', () => {
    const own = { state: 'local' as const, lastAt: '2026-11-27T00:00:00Z', where: null };
    const machine = { state: 'copied' as const, lastAt: '2026-11-26T00:00:00Z', where: 'pbs-01' };
    expect(betterProtection(own, machine)).toBe(machine);
    expect(betterProtection(null, own)).toBe(own);
  });
});

describe('restore test problems', () => {
  const row = (guestId: string, outcome: 'worked' | 'failed' | 'skipped', reason: string | null, day: number) => ({
    serverId: 'pve-01',
    guestId,
    outcome,
    reason,
    startedAt: new Date(Date.UTC(2026, 10, day)),
  });
  it('one per machine whose newest verdict failed, while tests are on', () => {
    const rows = [
      row('pve:101', 'failed', 'start_failed', 20),
      row('pve:102', 'failed', 'no_boot', 20),
      row('pve:102', 'worked', null, 27),
      row('pve:103', 'failed', 'restore_failed', 20),
      row('pve:103', 'skipped', 'no_space', 27),
    ];
    expect(failingTests(rows, ['pve-01']).map((r) => r.guestId)).toEqual(['pve:101', 'pve:103']);
    expect(failingTests(rows, [])).toEqual([]);
  });
});

describe('the off-site copy of this Whombat’s backups', () => {
  it('reads it when the status has one', () => {
    expect(offsiteOf({ offsite: { name: 'Backblaze', lastCopy: { at: '2026-11-28T03:10:00Z' } } })).toEqual({
      name: 'Backblaze',
      lastAt: '2026-11-28T03:10:00Z',
    });
    expect(offsiteOf({ offsite: { provider: 'S3', lastCopyAt: null } })).toEqual({ name: 'S3', lastAt: null });
    expect(offsiteOf({})).toBeNull();
    expect(offsiteOf({ offsite: { configured: false } })).toBeNull();
  });
});
