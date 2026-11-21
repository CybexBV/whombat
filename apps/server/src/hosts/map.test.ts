import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HostAlert,
  HostFleet,
  HostGuestConfig,
  HostInspectResult,
  HostManageResult,
  HostSeries,
  HostServerDetail,
  HostTask,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  camel,
  remoteControlFromAgent,
  toHostAlert,
  toHostFleet,
  toHostGuestConfig,
  toHostInspect,
  toHostManageResult,
  toHostSeries,
  toHostServerDetail,
  toHostTask,
  ts,
} from './map';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'testing/fixtures', name), 'utf8')) as Record<
    string,
    unknown
  >;
const NOW = new Date('2026-10-11T14:00:00Z');

describe('hosts mapping', () => {
  it('maps the fleet to the contract, with cpu24h and switches from /agents', () => {
    const fleet = fixture('fleet.json');
    const out = toHostFleet(
      {
        fleet,
        series: { heatmap: { cpu_pct: { basalt: Array.from({ length: 60 }, (_, i) => i) } } },
        agents: [
          {
            server_id: 'basalt',
            version: '0.14.2',
            remote_control: { console: true, power: true, host_shell: false, manage: true },
            agent_policy: { console: true, power: false, host_shell: false, manage: true },
          },
        ],
      },
      NOW,
    );
    expect(HostFleet.safeParse(out).error).toBeUndefined();
    const basalt = out.servers.find((s) => s.id === 'basalt');
    expect(basalt?.cpu24h).toHaveLength(48);
    expect(basalt?.status).toBe('warn');
    expect(basalt?.agent.version).toBe('0.14.2');
    expect(basalt?.remoteControl).toMatchObject({ console: true, power: false, manage: true });
    expect(basalt?.remoteControl.powerReason).toBe('Off in the server’s agent settings.');
    expect(basalt?.guests.map((g) => g.platform)).toEqual(['docker', 'incus', 'libvirt']);
    const marble = out.servers.find((s) => s.id === 'marble');
    expect(marble?.status).toBe('offline');
    const shale = out.servers.find((s) => s.id === 'shale');
    expect(shale?.platform).toBe('proxmox');
    expect(shale?.guests.find((g) => g.platform === 'pve')).toBeTruthy();
  });

  it('maps a standard and a Proxmox detail', () => {
    const fleet = fixture('fleet.json');
    const basalt = toHostServerDetail(fixture('server-basalt.json'), fleet.alerts as unknown[], null, NOW);
    expect(HostServerDetail.safeParse(basalt).error).toBeUndefined();
    expect(basalt.workloads?.docker?.guests.length).toBeGreaterThan(0);
    expect(basalt.server.lastBoot).toBe('2026-08-31T00:00:00Z');
    expect(basalt.alerts?.map((a) => a.id)).toEqual(['al_02']);
    expect(basalt.banner?.section).toBe('storage');
    const shale = toHostServerDetail(fixture('server-shale-proxmox.json'), [], null, NOW);
    expect(HostServerDetail.safeParse(shale).error).toBeUndefined();
    expect(shale.proxmox?.guests.vm?.guests[0]?.id).toBe('pve:100');
    expect(shale.proxmox?.cluster?.nodes.length).toBeGreaterThan(0);
  });

  it('maps alerts, series, tasks, config, inspect and manage answers', () => {
    const alert = toHostAlert({
      id: 'al_1',
      server: '',
      severity: 'warning',
      title: 't',
      detail: 'd',
      opened_at: '2026-10-11T13:00:00Z',
      rule: 'check.down',
      link: '#storage',
    });
    expect(HostAlert.safeParse(alert).error).toBeUndefined();
    expect(alert.serverId).toBeNull();
    expect(alert.section).toBe('storage');
    const series = toHostSeries(fixture('timeseries-basalt-24h.json'), 'basalt', null, NOW);
    expect(HostSeries.safeParse(series).error).toBeUndefined();
    expect(series.series.cpu_pct?.length).toBe(series.timestamps.length);
    const task = toHostTask({
      platform: 'pve',
      type: 'vzdump',
      id: '101',
      node: 'shale',
      user: null,
      start: '2026-10-11T00:00:00Z',
      end: null,
      status: 'running',
      ok: true,
    });
    expect(HostTask.safeParse(task).error).toBeUndefined();
    expect(task.status).toBe('running');
    const failed = toHostTask({
      type: 'qmstart',
      node: 'shale',
      start: '2026-10-11T00:00:00Z',
      end: '2026-10-11T00:01:00Z',
      status: 'start failed',
      ok: false,
    });
    expect(failed.status).toBe('error');
    expect(failed.message).toBe('start failed');
    const config = toHostGuestConfig({
      platform: 'pve',
      kind: 'vm',
      digest: 'abc',
      running: true,
      values: { memory: '8192', net0: 'virtio' },
      pending: { memory: '12288' },
      pending_delete: ['ide2'],
    });
    expect(HostGuestConfig.safeParse(config).error).toBeUndefined();
    expect(config.pendingDelete).toEqual(['ide2']);
    const inspect = toHostInspect(
      {
        kind: 'processes',
        as_of: '2026-10-11T14:00:00Z',
        truncated: false,
        items: [
          {
            PID: 1,
            PPID: 0,
            User: 'root',
            Name: 'systemd',
            Command: '/sbin/init',
            CPUPct: 0.1,
            RSSBytes: 100,
            State: 'S',
          },
        ],
      },
      'processes',
      NOW,
    );
    expect(HostInspectResult.safeParse(inspect).error).toBeUndefined();
    expect(inspect.items[0]).toMatchObject({ pid: 1, cpuPct: 0.1, rssBytes: 100 });
    const result = toHostManageResult({
      ok: true,
      changes: [{ key: 'cores', old: '4', new: '6', pending: true }],
      audit_id: 'au_1',
    });
    expect(HostManageResult.safeParse(result).error).toBeUndefined();
  });

  it('keeps the keys of data maps and reads remote control from both sides', () => {
    expect(camel({ policy_in: 'x', options: { policy_in: 'DROP' } })).toEqual({
      policyIn: 'x',
      options: { policy_in: 'DROP' },
    });
    expect(remoteControlFromAgent({ remote_control: {}, agent_policy: {} })).toMatchObject({
      console: false,
      diagnose: true,
    });
    expect(ts('2026-10-11')).toBe('2026-10-11T00:00:00Z');
    expect(ts('yesterday')).toBeNull();
  });
});
