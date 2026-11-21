import { describe, expect, it } from 'vitest';
import type { Guest } from '../../api/types';
import { guestPowerActions, guestStateInfo, hasSnapshots, needsConfirm, snapshotMemory, snapshotNameError } from './guestActions';

const g = (platform: Guest['platform'], kind: Guest['kind'], state: Guest['state']) => ({ platform, kind, state });

describe('guestPowerActions', () => {
  it('offers start for any stopped guest', () => {
    for (const x of [g('docker', 'container', 'stopped'), g('incus', 'vm', 'stopped'), g('pve', 'container', 'stopped')]) {
      expect(guestPowerActions(x)).toEqual(['start']);
    }
  });
  it('gives VMs shutdown, reboot, pause and force stop', () => {
    expect(guestPowerActions(g('libvirt', 'vm', 'running'))).toEqual(['shutdown', 'reboot', 'pause', 'force_stop']);
    expect(guestPowerActions(g('pve', 'vm', 'running'))).toEqual(['shutdown', 'reboot', 'pause', 'force_stop']);
  });
  it('gives containers restart, pause and stop (no force stop)', () => {
    expect(guestPowerActions(g('docker', 'container', 'running'))).toEqual(['restart', 'pause', 'stop']);
    expect(guestPowerActions(g('docker', 'container', 'unhealthy'))).toEqual(['restart', 'pause', 'stop']);
    expect(guestPowerActions(g('incus', 'container', 'running'))).toEqual(['restart', 'pause', 'stop']);
  });
  it('does not pause Proxmox containers', () => {
    expect(guestPowerActions(g('pve', 'container', 'running'))).toEqual(['restart', 'stop']);
  });
  it('resumes paused guests (or stops them hard)', () => {
    expect(guestPowerActions(g('incus', 'vm', 'paused'))).toEqual(['resume', 'force_stop']);
    expect(guestPowerActions(g('docker', 'container', 'paused'))).toEqual(['resume', 'stop']);
  });
  it('confirms what the hub calls destructive', () => {
    expect(['start', 'pause', 'resume'].some((a) => needsConfirm(a as never))).toBe(false);
    expect(['shutdown', 'reboot', 'restart', 'stop', 'force_stop'].every((a) => needsConfirm(a as never))).toBe(true);
  });
});

describe('guest state', () => {
  it('labels paused and unknown states', () => {
    expect(guestStateInfo('paused')).toEqual({ label: 'Paused', color: 'var(--warning)' });
    expect(guestStateInfo('frozen').label).toBe('Frozen');
  });
});

describe('snapshots', () => {
  it('exist for every platform but Docker; memory for Proxmox and libvirt VMs', () => {
    expect(hasSnapshots({ platform: 'docker' })).toBe(false);
    expect(hasSnapshots({ platform: 'incus' })).toBe(true);
    expect(snapshotMemory({ platform: 'pve', kind: 'vm' })).toBe(true);
    expect(snapshotMemory({ platform: 'incus', kind: 'vm' })).toBe(false);
    expect(snapshotMemory({ platform: 'libvirt', kind: 'vm' })).toBe(true);
  });
  it('checks names like the hub and Proxmox', () => {
    expect(snapshotNameError('', 'incus')).toBeNull();
    expect(snapshotNameError('pre-upgrade.1', 'incus')).toBeNull();
    expect(snapshotNameError('-x', 'incus')).not.toBeNull();
    expect(snapshotNameError('x;rm', 'incus')).not.toBeNull();
    expect(snapshotNameError('a'.repeat(41), 'incus')).not.toBeNull();
    expect(snapshotNameError('1st', 'incus')).toBeNull();
    expect(snapshotNameError('1st', 'pve')).not.toBeNull();
    expect(snapshotNameError('before.upgrade', 'pve')).not.toBeNull();
    expect(snapshotNameError('before_upgrade', 'pve')).toBeNull();
  });
});
