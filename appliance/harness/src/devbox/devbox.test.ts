import { describe, expect, it } from 'vitest';
import {
  apiCall,
  apiError,
  type BackupStatus,
  parseApiAnswer,
  planBackupVolume,
  statusLine,
  validateSize,
  volumeSerial,
} from './backup-disk.ts';
import {
  backupVolumeDescription,
  consoleState,
  journalArgs,
  keysFor,
  rawQemu,
  unitName,
  type VolumeInfo,
} from './incus.ts';
import { publicView } from './state.ts';

describe('the DEV box VM', () => {
  it('is Proxmox-shaped, with its own serial and the monitor on loopback', () => {
    const q = rawQemu({
      serial: 'WBDEVBOX-ABC123',
      monitorPort: 5801,
      cpus: 4,
      memory: '8GiB',
      disk: '128GiB',
    });
    expect(q).toContain('-device i6300esb -action watchdog=reset');
    expect(q).toContain('-smbios type=1,serial=WBDEVBOX-ABC123');
    expect(q).toContain('-monitor tcp:127.0.0.1:5801,server=on,wait=off');
  });

  it('types a shell command as US-keyboard sendkey names', () => {
    expect(keysFor("sudo sh -c 'echo X-1 >/dev/ttyS0'\n")).toEqual([
      ...'sudo'.split(''),
      'spc',
      's',
      'h',
      'spc',
      'minus',
      'c',
      'spc',
      'apostrophe',
      'e',
      'c',
      'h',
      'o',
      'spc',
      'shift-x',
      'minus',
      '1',
      'spc',
      'shift-dot',
      'slash',
      'd',
      'e',
      'v',
      'slash',
      't',
      't',
      'y',
      'shift-s',
      '0',
      'apostrophe',
      'ret',
    ]);
    expect(keysFor('$?|&;')).toEqual(['shift-4', 'shift-slash', 'shift-backslash', 'shift-7', 'semicolon']);
    expect(() => keysFor('é')).toThrow(/can't type/);
  });

  it('reads the newest console state line of the dev image (NX-120)', () => {
    const log = [
      'Booting…',
      'whombat-dev-console: state=none code=-',
      'whombat-dev-console: state=starting code=-',
      'noise',
      'whombat-dev-console: state=claimable code=KXQM',
    ].join('\r\n');
    expect(consoleState(log)).toEqual({ state: 'claimable', code: 'KXQM' });
    expect(consoleState(`${log}\nwhombat-dev-console: state=claimed code=-`)).toEqual({
      state: 'claimed',
      code: null,
    });
    expect(consoleState('nothing yet')).toBeNull();
  });

  it('shows its state without the person’s secrets', () => {
    const v = publicView({
      v: 1,
      vm: 'whombat-dev-box',
      serial: 'WBDEVBOX-1',
      monitorPort: 5801,
      installedFrom: { releaseId: 'whombat-dev-20260928.1', iso: '/x.iso', isoSha256: 'a' },
      createdAt: 'now',
      owner: { email: 'e', name: 'n', org: 'o' },
      session: { token: 'SECRET-TOKEN', expiresAt: 'later' },
      endpointKey: 'SECRET-KEY',
      recovery: { publicKey: 'p', secretKey: 'SECRET-RECOVERY', kitId: 'kit_1' },
    });
    expect(JSON.stringify(v)).not.toMatch(/SECRET/);
    expect(v).toMatchObject({
      session: { expiresAt: 'later' },
      endpoint: 'kept',
      recovery: { kitId: 'kit_1' },
    });
  });
});

describe('inside the box (NX-143)', () => {
  it('names units the way the box does', () => {
    expect(unitName('manager')).toBe('whombat-manager');
    expect(unitName('whombat-server')).toBe('whombat-server');
    expect(unitName('whombat-*')).toBe('whombat-*');
    expect(unitName('incus')).toBe('incus');
    expect(unitName('postgresql')).toBe('postgresql');
    expect(unitName('nftables.service')).toBe('nftables.service');
  });

  it('turns logs options into journalctl arguments', () => {
    expect(journalArgs({ units: ['manager', 'runner'], follow: true, lines: null, since: null })).toEqual([
      'journalctl',
      '--no-pager',
      '-o',
      'short-iso',
      '-u',
      'whombat-manager',
      '-u',
      'whombat-runner',
      '-n',
      '50',
      '-f',
    ]);
    expect(journalArgs({ units: [], follow: false, lines: 20, since: '-1h' })).toEqual([
      'journalctl',
      '--no-pager',
      '-o',
      'short-iso',
      '--since',
      '-1h',
      '-n',
      '20',
    ]);
  });
});

describe('the backup disk (IN-423)', () => {
  const vol = (over: Partial<VolumeInfo> = {}): VolumeInfo => ({
    name: 'whombat-dev-box-backup',
    description: '',
    usedBy: [],
    createdAt: '2026-10-07T15:02:11.35305982Z',
    ...over,
  });

  it('keeps this box’s volume, sets a previous box’s aside and never takes another instance’s', () => {
    expect(planBackupVolume(null, 'WBDEVBOX-AB12', [])).toEqual({ act: 'create' });
    expect(
      planBackupVolume(vol({ usedBy: ['/1.0/instances/whombat-dev-box'] }), 'WBDEVBOX-AB12', []),
    ).toEqual({
      act: 'keep',
    });
    expect(
      planBackupVolume(vol({ description: backupVolumeDescription('WBDEVBOX-AB12') }), 'WBDEVBOX-AB12', []),
    ).toEqual({ act: 'keep' });
    expect(
      planBackupVolume(vol({ description: backupVolumeDescription('WBDEVBOX-01D1') }), 'WBDEVBOX-AB12', []),
    ).toEqual({ act: 'set-aside', to: 'whombat-dev-box-backup-WBDEVBOX-01D1' });
    // Untagged (made by hand on 2026-10-07): by the day it was made, a free name.
    expect(
      planBackupVolume(vol(), 'WBDEVBOX-AB12', ['whombat-dev-box-backup', 'whombat-dev-box-backup-20261007']),
    ).toEqual({ act: 'set-aside', to: 'whombat-dev-box-backup-20261007-2' });
    expect(planBackupVolume(vol({ usedBy: ['/1.0/instances/other'] }), 'WBDEVBOX-AB12', [])).toMatchObject({
      act: 'refuse',
    });
    expect(volumeSerial(backupVolumeDescription('WBDEVBOX-1A2B3C'))).toBe('WBDEVBOX-1A2B3C');
  });

  it('takes sizes of at least a GiB', () => {
    expect(validateSize('64GiB')).toBe('64GiB');
    expect(validateSize('1024MiB')).toBe('1024MiB');
    expect(() => validateSize('512MiB')).toThrow(/at least 1GiB/);
    expect(() => validateSize('64G')).toThrow(/--size/);
  });

  it('calls the backup service as the runtime’s user and reads its answer', () => {
    const a = apiCall('PUT', '/v1/destination', { repository: 'disk:', allowInit: true }, 600);
    expect(a.slice(0, 5)).toEqual(['runuser', '-u', 'whombat', '--', 'curl']);
    expect(a).toContain('/run/whombat-backup/api.sock');
    expect(a).toContain('{"repository":"disk:","allowInit":true}');
    expect(a.at(-1)).toBe('http://backup/v1/destination');
    expect(apiCall('GET', '/v1/status')).not.toContain('--data-binary');
    expect(parseApiAnswer('{"kind":"disk","generation":1}\n200')).toEqual({
      status: 200,
      body: { kind: 'disk', generation: 1 },
    });
    const refused = parseApiAnswer(
      '{"error":{"code":"destination_failed","message":"Attach only one."}}\n502',
    );
    expect(refused.status).toBe(502);
    expect(apiError(refused.body)).toContain('destination_failed');
    expect(parseApiAnswer('\n000').status).toBe(0);
  });

  it('says the status in one line', () => {
    const s: BackupStatus = {
      state: 'protected',
      protected: true,
      destination: { configured: true, kind: 'disk', display: 'disk:' },
      lastSuccess: { id: 'ck-1', at: '2026-10-24T00:00:00Z', snapshotId: 'abc123' },
      lastFailure: null,
    };
    expect(statusLine(s)).toContain('protected');
    expect(statusLine(s)).toContain('abc123');
    expect(
      statusLine({ ...s, state: 'unprotected', destination: { configured: false }, lastSuccess: null }),
    ).toContain('no destination');
  });
});
