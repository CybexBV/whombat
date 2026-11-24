/**
 * What a connection runs on (connection-pages.md CP-08; connection-pages-server.md CP-S04): the addresses in a Proxmox
 * guest's configuration, the matcher (a guest before its server), names, hrefs, the machine's figures and the index's
 * cache (page-speed.md PS-03).
 */
import type { HostGuest } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { HostsService } from '../hosts/service';
import {
  type AddressIndex,
  addressIndex,
  buildAddressIndex,
  configAddresses,
  connectionHostname,
  guestFigures,
  guestLabel,
  machineHref,
  matchMachine,
  matchServerName,
  metricSeries,
  nicAddresses,
  uptimeHostname,
} from './runs-on';

describe('runs on', () => {
  it('reads ip= from a container’s net lines and a VM’s ipconfig lines, not dhcp', () => {
    expect(
      configAddresses({
        net0: 'name=eth0,bridge=vmbr0,firewall=1,gw=10.100.0.1,hwaddr=BC:24:11:00:00:01,ip=10.100.0.5/23,type=veth',
        net1: 'name=eth1,bridge=vmbr1,ip=dhcp,ip6=fd00::5/64',
        ipconfig0: 'ip=192.168.1.40/24,gw=192.168.1.1',
        ipconfig1: 'ip=dhcp',
        memory: '8192',
      }),
    ).toEqual(['10.100.0.5', 'fd00::5', '192.168.1.40']);
  });

  it('a guest matches before its server; names and hrefs', () => {
    const index: AddressIndex = {
      servers: ['pve-02'],
      machines: [
        { serverId: 'pve-02', guestId: null, name: 'pve-02', addresses: ['10.100.0.5', '10.100.0.12'] },
        { serverId: 'pve-02', guestId: 'pve:131', name: 'pve-02 · CT 131', addresses: ['10.100.0.5'] },
      ],
    };
    expect(matchMachine(index, ['10.100.0.5'])?.guestId).toBe('pve:131');
    expect(matchMachine(index, ['10.100.0.12'])?.guestId).toBeNull();
    expect(matchMachine(index, ['[FD00::1]'])).toBeNull();
    // By the name the service gave itself (SB-09): case and a domain ignored, never an address, one server only.
    const named: AddressIndex = {
      servers: ['blackbox', 'pve-02'],
      machines: [
        {
          serverId: 'blackbox',
          guestId: null,
          name: 'blackbox',
          addresses: ['10.100.1.23'],
          hostname: 'BlackBox',
        },
        ...index.machines,
      ],
    };
    expect(matchServerName(named, 'blackbox')?.serverId).toBe('blackbox');
    expect(matchServerName(named, 'BLACKBOX.local')?.serverId).toBe('blackbox');
    expect(matchServerName(named, 'pve-02')?.serverId).toBe('pve-02');
    expect(matchServerName(named, 'tower')).toBeNull();
    expect(matchServerName(named, '10.100.0.40')).toBeNull();
    const twin = { serverId: 'b2', guestId: null, name: 'b2', addresses: [], hostname: 'blackbox' };
    expect(matchServerName({ ...named, machines: [...named.machines, twin] }, 'blackbox')).toBeNull();
    expect(machineHref('pve-02', 'pve:131')).toBe('/things/server%3Apve-02?guest=pve%3A131');
    expect(machineHref('pve-02', null)).toBe('/things/server%3Apve-02');
    // By its own name; Proxmox's number only for a guest without one.
    expect(
      guestLabel({ platform: 'pve', kind: 'container', vmid: 131, name: 'HomeAssistant', id: 'pve:131' }),
    ).toBe('HomeAssistant');
    expect(guestLabel({ platform: 'pve', kind: 'vm', vmid: 104, name: '', id: 'pve:104' })).toBe('VM 104');
    expect(
      guestLabel({ platform: 'docker', kind: 'container', name: 'homeassistant', id: 'docker:abc' }),
    ).toBe('homeassistant');
  });

  it('the host a person typed; a fixed public API has none', () => {
    expect(
      connectionHostname({
        catalogId: 'homeassistant',
        baseUrl: 'http://10.100.0.5:8123',
        fields: { url: 'http://10.100.0.5:8123' },
      }),
    ).toBe('10.100.0.5');
    expect(
      connectionHostname({
        catalogId: 'unifi_network',
        baseUrl: 'https://unifi.home/proxy/network/integration',
        fields: { url: 'https://Unifi.Home' },
      }),
    ).toBe('unifi.home');
    expect(
      connectionHostname({ catalogId: 'hetzner', baseUrl: 'https://api.hetzner.cloud', fields: {} }),
    ).toBeNull();
  });

  it('a “Website or address” check talks to the host in its address field; a check-in to none', () => {
    const uptime = (fields: Record<string, string>) =>
      connectionHostname({ catalogId: 'uptime', baseUrl: 'whombat-hosts:', fields });
    expect(uptime({ kind: 'http', address: 'https://Status.Example.com:8443/ready' })).toBe(
      'status.example.com',
    );
    expect(uptime({ kind: 'tcp', address: 'nas.local:445' })).toBe('nas.local');
    expect(uptime({ kind: 'tcp', address: '[2001:db8::7]:22' })).toBe('2001:db8::7');
    expect(uptime({ kind: 'ping', address: '10.100.0.9' })).toBe('10.100.0.9');
    expect(uptime({ kind: 'dns', address: 'example.com.' })).toBe('example.com');
    expect(uptime({ kind: 'heartbeat' })).toBeNull();
    expect(uptimeHostname({ kind: 'http', address: 'not a url' })).toBeNull();
  });

  it('a guest’s figures: memory and disk in GB, the 24 hours as CPU % and memory GB', () => {
    const guest = {
      id: 'pve:131',
      serverId: 'pve-02',
      name: 'HomeAssistant',
      platform: 'pve',
      kind: 'container',
      vmid: 131,
      vcpu: 4,
      state: 'running',
      cpuPct: 5,
      memoryUsedMb: 3072,
      memoryLimitMb: 8192,
      diskUsedGb: 32.5,
      uptimeS: 82_800,
      lastBackup: { result: 'ok', at: '2026-10-18T05:31:00Z' },
      backupJob: true,
    } as unknown as HostGuest;
    const f = guestFigures(
      guest,
      'pve-02',
      { disks: [{ size_bytes: 40 * 1024 ** 3 }] },
      {
        timestamps: ['2026-10-18T10:00:00Z', '2026-10-18T10:15:00Z'],
        series: { cpu_pct: [4, 6], mem_pct: [37.5, 50] },
      },
    );
    expect(f).toMatchObject({
      name: 'HomeAssistant (pve-02)',
      label: 'HomeAssistant',
      cores: 4,
      memoryUsedGb: 3,
      memoryTotalGb: 8,
      diskTotalGb: 40,
      backupJob: true,
      series: { cpu: [4, 6], memoryGb: [3, 4] },
    });
    // John's CT 131: the hosts service's 32.5 GB used is 30.3 GiB of the 40 GiB disk (76 %).
    expect(f.diskUsedGb).toBeCloseTo(30.27, 1);
    expect(metricSeries({ timestamps: ['a'], series: {} }, 8)).toBeNull();
    expect(metricSeries({ timestamps: ['a', 'b'], series: { mem_used_mb: [1024, null] } }, null)).toEqual({
      timestamps: ['a', 'b'],
      cpu: [null, null],
      memoryGb: [1, null],
    });
    // A guest's series as the hosts service names it.
    expect(metricSeries({ timestamps: ['a', 'b'], series: { mem_mb: [3072, 3070.8] } }, 8)?.memoryGb[0]).toBe(
      3,
    );
  });

  it('a server answers on every network card it has, but not on an address another server has too', async () => {
    const nic = (...addresses: string[]) => ({ kind: 'ethernet', addresses });
    const details: Record<string, unknown> = {
      // An Unraid server whose agent reports 10.100.1.23, while Unraid, Plex and Seerr answer on 10.100.0.40.
      blackbox: {
        server: { address: '10.100.1.23', hostname: 'BlackBox' },
        network: [
          nic('10.100.0.40/23', 'fe80::1/64'),
          nic('10.100.1.23/23'),
          nic('172.17.0.1/16'),
          nic('127.0.0.1/8'),
        ],
      },
      'pve-01': {
        server: { address: '10.100.0.10' },
        network: [nic('10.100.0.10/23'), nic('172.17.0.1/16')],
      },
    };
    const hosts = {
      fleetRaw: () => Promise.resolve({ servers: [{ id: 'blackbox' }, { id: 'pve-01' }] }),
      call: ({ path }: { path: string }) =>
        Promise.resolve(details[decodeURIComponent(path.split('/').pop() ?? '')]),
      guestsRaw: () => Promise.resolve([]),
    } as unknown as HostsService;
    const index = await buildAddressIndex(hosts);
    expect(index.machines.find((m) => m.serverId === 'blackbox')?.addresses).toEqual([
      '10.100.1.23',
      '10.100.0.40',
    ]);
    expect(matchMachine(index, ['10.100.0.40'])?.serverId).toBe('blackbox');
    expect(matchMachine(index, ['172.17.0.1'])).toBeNull();
    expect(nicAddresses([{ addresses: ['::1/128', 'fd00::40/64', 'not an address'] }, null])).toEqual([
      'fd00::40',
    ]);
  });

  it('serves the last address index while a new one is built (PS-03)', async () => {
    let address = '10.100.0.10';
    let fleet: Promise<Record<string, unknown>> = Promise.resolve({ servers: [{ id: 'pve-01' }] });
    const hosts = {
      fleetRaw: () => fleet,
      call: () => Promise.resolve({ server: { address } }),
      guestsRaw: () => Promise.resolve([]),
    } as unknown as HostsService;
    const t0 = Date.now();
    expect((await addressIndex(hosts, t0)).machines[0]?.addresses).toEqual(['10.100.0.10']);
    // Ten minutes later the hosts service is slow: the last index answers, the new one is built behind it.
    let answer!: (f: Record<string, unknown>) => void;
    fleet = new Promise((resolve) => {
      answer = resolve;
    });
    address = '10.100.0.11';
    const later = t0 + 11 * 60_000;
    expect((await addressIndex(hosts, later)).machines[0]?.addresses).toEqual(['10.100.0.10']);
    answer({ servers: [{ id: 'pve-01' }] });
    await fleet;
    await new Promise((resolve) => setImmediate(resolve));
    expect((await addressIndex(hosts, later + 1)).machines[0]?.addresses).toEqual(['10.100.0.11']);
  });
});
