import type { BackupOffsite } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  betterProtection,
  haAgentName,
  haProtection,
  provenProtection,
  synologyProtection,
  truenasProtection,
} from './protection';
import { failingTests } from './runner';
import { offsiteOf, placeChosenAt, pveProtection, sameMachineState, whombatProtection } from './view';

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
    expect(
      synologyProtection([{ name: 'USB', result: 'ok', last: d('2026-11-27T04:00:00Z'), target: 'local' }])
        ?.state,
    ).toBe('local');
    const failed = synologyProtection([
      { name: 'To B2', result: 'failed', last: d('2026-11-27T02:00:00Z'), target: 'cloud' },
    ]);
    expect(failed).toMatchObject({ state: 'none', planned: true, lastAt: null });
    expect(failed?.failedAt).toBe('2026-11-27T02:00:00.000Z');
    expect(synologyProtection(null)).toBeUndefined();
  });
  it('a task that never worked copies nothing: none and planned, or the copy that did work', () => {
    const never = { name: 'To B2', result: 'none', last: null, target: 'cloud' };
    expect(synologyProtection([never])).toMatchObject({ state: 'none', planned: true, lastAt: null });
    expect(
      synologyProtection([
        never,
        { name: 'USB', result: 'ok', last: d('2026-11-27T04:00:00Z'), target: 'local' },
      ]),
    ).toMatchObject({ state: 'local', where: null });
    expect(
      truenasProtection([{ kind: 'replication', name: 'to-backup', result: null, at: null }]),
    ).toMatchObject({ state: 'none', planned: true });
    expect(
      truenasProtection([
        { kind: 'replication', name: 'to-backup', result: 'failed', at: d('2026-11-27T02:00:00Z') },
        { kind: 'snapshot', name: 'tank', result: 'ok', at: d('2026-11-27T01:00:00Z') },
      ]),
    ).toMatchObject({ state: 'local', lastAt: '2026-11-27T01:00:00.000Z' });
  });
  it('a fact kept from before the rule says copied only with a backup that worked', () => {
    expect(provenProtection({ state: 'copied', lastAt: null, where: 'To B2' })).toMatchObject({
      state: 'none',
      planned: true,
      where: null,
    });
    const ok = { state: 'copied' as const, lastAt: '2026-11-27T00:00:00Z', where: 'To B2' };
    expect(provenProtection(ok)).toBe(ok);
    expect(provenProtection(null)).toBeNull();
  });
  it('TrueNAS replication is copied, snapshots alone stay on it', () => {
    expect(
      truenasProtection([
        { kind: 'snapshot', name: 'tank', result: 'ok', at: d('2026-11-27T01:00:00Z') },
        { kind: 'replication', name: 'to-backup', result: 'ok', at: d('2026-11-27T02:00:00Z') },
      ]),
    ).toMatchObject({ state: 'copied', where: 'to-backup' });
    expect(
      truenasProtection([{ kind: 'snapshot', name: 'tank', result: 'ok', at: d('2026-11-27T01:00:00Z') }])
        ?.state,
    ).toBe('local');
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
  const row = (
    guestId: string,
    outcome: 'worked' | 'failed' | 'skipped',
    reason: string | null,
    day: number,
  ) => ({
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
  const offsite: BackupOffsite = {
    provider: 'b2',
    display: 's3.example.com/bk/box',
    endpoint: 's3.example.com',
    bucket: 'bk',
    folder: 'box',
    region: null,
    state: 'ok',
    configuredAt: '2026-11-20T10:00:00Z',
    lastCopyAt: '2026-11-28T03:10:00Z',
    newestInCopyAt: '2026-11-28T03:00:00Z',
    newestBackupAt: '2026-11-28T03:00:00Z',
    backupsInCopy: 4,
    failedAttempts: 0,
    lastFailure: null,
    nextTryAt: null,
    lastClearedAt: null,
  };
  it('names the storage and the last copy the bucket confirmed', () => {
    expect(offsiteOf(offsite)).toEqual({ name: 'Backblaze B2', lastAt: '2026-11-28T03:10:00Z' });
    expect(offsiteOf({ ...offsite, provider: 's3' })?.name).toBe('bk');
  });
  it('has no last copy until the bucket’s own list showed one', () => {
    expect(offsiteOf({ ...offsite, newestInCopyAt: null })?.lastAt).toBeNull();
  });
  it('says when copying there fails', () => {
    const failing = offsiteOf({
      ...offsite,
      state: 'failing',
      failedAttempts: 2,
      lastFailure: { at: '2026-11-28T09:00:00Z', step: 'keys' },
    });
    expect(failing).toMatchObject({ failedAt: '2026-11-28T09:00:00Z', lastAt: '2026-11-28T03:10:00Z' });
  });
  it('is absent without a second place, or when the box can’t say', () => {
    expect(offsiteOf(null)).toBeNull();
    expect(offsiteOf(undefined)).toBeNull();
  });
});

describe('a Proxmox machine’s backups', () => {
  const ok = { result: 'ok', at: '2026-11-27T02:00:00Z' };
  const onPbs = { storageId: 'pbs-01', storage: { type: 'pbs', shared: false }, at: '2026-11-27T02:00:00Z' };
  const read = { last: ok, planned: true, newest: onPbs, listsRead: true };
  it('are on another machine or the same one by the storage the backup is on', () => {
    expect(pveProtection(read)).toMatchObject({ state: 'copied', where: 'pbs-01', lastAt: ok.at });
    expect(
      pveProtection({
        ...read,
        newest: { ...onPbs, storageId: 'local', storage: { type: 'dir', shared: false } },
      }).state,
    ).toBe('local');
  });
  it('are none while a plan never made a backup that worked, never copied', () => {
    expect(pveProtection({ ...read, last: null, newest: null })).toMatchObject({
      state: 'none',
      planned: true,
    });
    expect(pveProtection({ ...read, last: null, planned: false, newest: null }).planned).toBeUndefined();
    const failed = { result: 'error', at: '2026-11-28T02:00:00Z' };
    expect(pveProtection({ ...read, last: failed, newest: null })).toMatchObject({
      state: 'none',
      failedAt: failed.at,
    });
    // After a failure, the backup still on its list is the one that worked before.
    expect(pveProtection({ ...read, last: failed })).toMatchObject({
      state: 'copied',
      lastAt: onPbs.at,
      failedAt: failed.at,
    });
  });
  it('are unseen when their list or the storages weren’t read, never guessed', () => {
    expect(pveProtection({ ...read, newest: undefined }).state).toBe('unseen');
    expect(pveProtection({ ...read, listsRead: false }).state).toBe('unseen');
    expect(pveProtection({ ...read, newest: { ...onPbs, storage: undefined } }).state).toBe('unseen');
    expect(pveProtection({ ...read, newest: null }).state).toBe('unseen');
  });
});

describe('this Whombat’s own backups', () => {
  const status = (over: Partial<Parameters<typeof whombatProtection>[0]> = {}) =>
    ({
      state: 'protected',
      destination: { configured: true, kind: 'rest', repositoryId: 'repo-b' },
      lastSuccess: { at: '2026-11-28T03:00:00Z' },
      lastFailure: null,
      ...over,
    }) as Parameters<typeof whombatProtection>[0];

  it('knows when backups started going to the place in use', () => {
    const sets = [
      { repositoryId: 'repo-a', at: '2026-11-01T10:00:00.000Z' },
      // The same place followed to a new address: not a change.
      { repositoryId: 'repo-a', at: '2026-11-10T10:00:00.000Z' },
      { repositoryId: 'repo-b', at: '2026-11-27T10:00:00.000Z' },
    ];
    expect(placeChosenAt(sets, 'repo-b')).toBe('2026-11-27T10:00:00.000Z');
    expect(placeChosenAt(sets.slice(0, 2), 'repo-a')).toBe('2026-11-01T10:00:00.000Z');
    // Back to an earlier place: from then.
    expect(
      placeChosenAt([...sets, { repositoryId: 'repo-a', at: '2026-11-28T10:00:00.000Z' }], 'repo-a'),
    ).toBe('2026-11-28T10:00:00.000Z');
    // Set some other way: Whombat can't tell.
    expect(placeChosenAt(sets, 'repo-c')).toBeNull();
    expect(placeChosenAt([], 'repo-b')).toBeNull();
  });

  it('is copied only once a backup worked at the place in use', () => {
    expect(whombatProtection(status(), '2026-11-27T10:00:00.000Z')).toEqual({
      state: 'copied',
      lastAt: '2026-11-28T03:00:00Z',
    });
    expect(whombatProtection(status({ destination: { configured: true, kind: 'local' } }), null).state).toBe(
      'local',
    );
    // Before the first backup there, and every backup there failing: a plan and the failure.
    expect(whombatProtection(status({ lastSuccess: null }), '2026-11-27T10:00:00.000Z')).toEqual({
      state: 'none',
      lastAt: null,
      planned: true,
    });
    const failing = status({
      state: 'failing',
      lastFailure: { at: '2026-11-28T09:00:00Z' },
    } as Partial<Parameters<typeof whombatProtection>[0]>);
    expect(whombatProtection(failing, '2026-11-28T08:00:00.000Z')).toEqual({
      state: 'none',
      lastAt: null,
      planned: true,
      failedAt: '2026-11-28T09:00:00Z',
    });
    expect(whombatProtection(status({ destination: { configured: false } }), null)).toEqual({
      state: 'none',
      lastAt: null,
    });
  });
});

describe('Incus and QEMU/KVM machines', () => {
  it('are kept on the same machine only by a snapshot or a backup that worked', () => {
    expect(sameMachineState('incus', { snapshots: 2, last: null })).toBe('local');
    expect(sameMachineState('incus', { snapshots: 0, last: null })).toBe('none');
    expect(sameMachineState('libvirt', { last: { result: 'ok' } })).toBe('local');
    expect(sameMachineState('libvirt', { last: { result: 'error' } })).toBe('none');
    expect(sameMachineState('libvirt', { last: null })).toBe('none');
  });
});
