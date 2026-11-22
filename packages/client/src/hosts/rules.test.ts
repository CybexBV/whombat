import { QueryClient } from '@tanstack/query-core';
import { api } from '@whombat/core/contracts';
import type { HostFleet, HostGuestConfig, HostGuestDetail, HostServer } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors';
import { queryKeys } from '../query/keys';
import { applyHostGuest, applyHostServer } from './apply';
import { seriesPaths } from './chart';
import {
  bootOrder,
  decodeSshKeys,
  editProps,
  encodeSshKeys,
  formatIpConfig,
  formatProps,
  nicModel,
  parseIpConfig,
  parseProps,
  parseSize,
  pendingKeys,
  reviewRows,
  trimDraft,
  withBootOrder,
  withNicModel,
} from './config';
import {
  consoleCloseText,
  consoleSocketUrl,
  consoleSubprotocols,
  decodeFrame,
  encodeControl,
  encodeData,
  FRAME_CONTROL,
  parseControl,
} from './console';
import { CHANGED_MEANWHILE, hostErrorInfo } from './errors';
import { createHostsFixtures } from './fixtures';
import {
  formatAgo,
  formatGb,
  formatGbPair,
  formatMemPair,
  formatPct,
  formatPct1,
  formatTemp,
  formatUptimeWords,
} from './format';
import { sensorLevel, warmFrom } from './thresholds';

describe('formats', () => {
  it('spell numbers as the mock does', () => {
    expect(formatPct(10.4)).toBe('10 %');
    expect(formatPct1(13.62)).toBe('13.6 %');
    expect(formatTemp(75.2)).toBe('75 °C');
    expect(formatGb(871)).toBe('871 GB');
    expect(formatGb(2000)).toBe('2 TB');
    expect(formatGb(1420)).toBe('1.42 TB');
    expect(formatGbPair(76, 118)).toBe('76 / 118 GB');
    expect(formatMemPair(3174, 4096)).toBe('3.1 / 4 GB');
    expect(formatMemPair(380, 1024)).toBe('380 MB / 1 GB');
    expect(formatMemPair(null, 4096)).toBe('—');
    expect(formatUptimeWords(23 * 86_400 + 3600)).toBe('23 days');
    expect(formatAgo(14 * 60)).toBe('14 min ago');
  });

  it('colour temperatures against their limit', () => {
    expect(sensorLevel(60, 85)).toBe('good');
    expect(sensorLevel(73, 85)).toBe('warning');
    expect(sensorLevel(85, 85)).toBe('serious');
    expect(warmFrom(85)).toBe(72);
  });
});

describe('charts', () => {
  it('keep gaps as gaps', () => {
    const p = seriesPaths([1, 2, null, 3], 0, 4, 100, 10);
    expect(p.line.match(/M/g)?.length).toBe(2);
  });
});

describe('configuration rules', () => {
  const cfg: HostGuestConfig = {
    platform: 'pve',
    kind: 'vm',
    digest: 'd1',
    running: true,
    values: {
      memory: '4096',
      cores: '4',
      net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1',
      boot: 'order=scsi0;net0',
    },
    pending: { memory: '8192' },
  };

  it('round-trip property strings', () => {
    const s = 'local-zfs:vm-100-disk-0,iothread=1,size=64G';
    expect(formatProps(parseProps(s, 'file'))).toBe(s);
    expect(editProps(s, { size: '128G', ssd: '1' }, 'file')).toBe(
      'local-zfs:vm-100-disk-0,iothread=1,size=128G,ssd=1',
    );
    expect(parseSize('64G')).toBe(64 * 1024 ** 3);
  });

  it('review a change from the pending value', () => {
    expect(pendingKeys(cfg)).toEqual(['memory']);
    const d = trimDraft(cfg, { set: { memory: '8192', cores: '6' } });
    expect(d).toEqual({ set: { cores: '6' } });
    expect(reviewRows(cfg, { set: { memory: '16384' }, revert: ['memory'] })).toEqual([
      { key: 'memory', old: '8192', new: '4096', op: 'revert' },
      { key: 'memory', old: '8192', new: '16384', op: 'set' },
    ]);
  });

  it('change NICs, boot order and cloud-init in place', () => {
    expect(nicModel(cfg.values.net0)).toEqual({ model: 'virtio', mac: 'BC:24:11:00:00:01' });
    expect(withNicModel(cfg.values.net0 ?? '', 'e1000')).toBe(
      'e1000=BC:24:11:00:00:01,bridge=vmbr0,firewall=1',
    );
    expect(bootOrder(cfg.values.boot)).toEqual(['scsi0', 'net0']);
    expect(withBootOrder('order=scsi0;net0', ['net0', 'scsi0'])).toBe('order=net0;scsi0');
    expect(decodeSshKeys(encodeSshKeys('ssh-ed25519 AAA john@x\n'))).toBe('ssh-ed25519 AAA john@x\n');
    const ip = parseIpConfig('ip=10.0.0.5/24,gw=10.0.0.1');
    expect(ip).toMatchObject({ v4: 'static', ip: '10.0.0.5/24', gw: '10.0.0.1', v6: 'none' });
    expect(formatIpConfig({ ...ip, v4: 'dhcp' }, 'ip=10.0.0.5/24,gw=10.0.0.1')).toBe('ip=dhcp');
  });
});

describe('console frames', () => {
  it('encode and decode', () => {
    const [f] = encodeData(0, 'ls\r');
    const frame = f ? decodeFrame(f) : null;
    expect(frame?.channel).toBe(0);
    expect(new TextDecoder().decode(frame?.payload)).toBe('ls\r');
    const c = decodeFrame(encodeControl({ type: 'resize', cols: 80, rows: 24 }));
    expect(c?.kind).toBe(FRAME_CONTROL);
    expect(parseControl(new TextEncoder().encode('{"type":"closed","reason":"idle_timeout"}'))).toEqual({
      type: 'closed',
      channel: undefined,
      reason: 'idle_timeout',
    });
    expect(parseControl(new TextEncoder().encode('{"type":"nope"}'))).toBeNull();
    expect(consoleCloseText('guest_stopped')).toBe('The guest was switched off.');
  });

  it('opens on Whombat’s path with the token protocol', () => {
    expect(consoleSubprotocols({ token: 'abc' })).toEqual(['whombat.console.v1', 'whombat.token.abc']);
    expect(consoleSocketUrl({ path: '/api/v1/burrows/b/hosts/consoles/c1/ws' }, 'https://box.lan')).toBe(
      'wss://box.lan/api/v1/burrows/b/hosts/consoles/c1/ws',
    );
    expect(consoleSocketUrl({ path: '/burrows/b/hosts/consoles/c1/ws' }, 'http://localhost:5180')).toBe(
      'ws://localhost:5180/api/v1/burrows/b/hosts/consoles/c1/ws',
    );
  });
});

describe('refusals', () => {
  it('ask for another review after a change meanwhile', () => {
    const err = new ApiError(
      409,
      'conflict',
      'The configuration changed meanwhile.',
      {},
      'hosts.manage',
      {},
      {
        code: 'digest_mismatch',
      },
    );
    expect(hostErrorInfo(err)).toMatchObject({ conflict: true, message: CHANGED_MEANWHILE });
    const fields = new ApiError(400, 'validation_failed', 'Check the fields.', {}, 'hosts.manage', {
      memory: ['At least 16.'],
    });
    expect(hostErrorInfo(fields).fields).toEqual({ memory: 'At least 16.' });
    const unknownOp = new ApiError(
      404,
      'unknown',
      'Unknown op.',
      { error: { code: 'unknown_op', message: 'Unknown op.' } },
      'hosts.diskUsage',
      {},
    );
    expect(hostErrorInfo(unknownOp)).toMatchObject({ code: 'unknown_op' });
    expect(hostErrorInfo(unknownOp).message).toMatch(/Update this Whombat/i);
  });
});

describe('realtime', () => {
  it('patches a guest’s state and a server’s row in place', () => {
    const { handle } = createHostsFixtures(Date.parse('2026-10-17T12:00:00Z'));
    const qc = new QueryClient();
    const params = { burrow: 'lumio', serverId: 'pve-02', guestId: 'pve:118' };
    const guestKey = queryKeys.endpoint(api.hosts.getGuest, { params });
    qc.setQueryData(
      guestKey,
      handle({ method: 'GET', path: '/servers/pve-02/guests/pve:118', query: {}, body: {} })
        ?.body as HostGuestDetail,
    );
    applyHostGuest(qc, { type: 'hosts.guest', serverId: 'pve-02', guestId: 'pve:118', state: 'stopped' });
    expect((qc.getQueryData(guestKey) as { state: string }).state).toBe('stopped');

    const fleetKey = queryKeys.endpoint(api.hosts.fleet, { params: { burrow: 'lumio' }, query: {} });
    const fleet = handle({ method: 'GET', path: '/fleet', query: {}, body: {} })?.body as HostFleet;
    qc.setQueryData(fleetKey, fleet);
    const row = fleet.servers.find((s) => s.id === 'pve-02');
    applyHostServer(qc, {
      type: 'hosts.server',
      serverId: 'pve-02',
      server: { ...(row as HostServer), status: 'ok' },
    });
    applyHostServer(qc, { type: 'hosts.server', serverId: 'blackbox', server: null });
    const next = qc.getQueryData(fleetKey) as typeof fleet;
    expect(next.servers.find((s) => s.id === 'pve-02')?.status).toBe('ok');
    expect(next.servers.some((s) => s.id === 'blackbox')).toBe(false);
  });
});
