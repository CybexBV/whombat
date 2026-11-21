import type { NetworkInterfaceInfo } from 'node:os';
import { TAILSCALE_OFF, type TailscaleStatus } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { directAddresses } from './routes';

const info = (address: string, family: 'IPv4' | 'IPv6', internal = false): NetworkInterfaceInfo =>
  ({
    address,
    netmask: family === 'IPv4' ? '255.255.255.0' : 'ffff:ffff:ffff:ffff::',
    family,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/${family === 'IPv4' ? 24 : 64}`,
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  }) as NetworkInterfaceInfo;

const interfaceTable = {
  lo: [info('127.0.0.1', 'IPv4', true)],
  enp1s0: [info('fd00:1::20', 'IPv6'), info('10.100.1.20', 'IPv4'), info('fe80::20', 'IPv6')],
  tailscale0: [info('100.101.102.103', 'IPv4')],
};
const on: TailscaleStatus = {
  state: 'on',
  loginUrl: null,
  name: 'box.tail0000.ts.net',
  addresses: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
  tailnet: 'mara@example.com',
  https: true,
  problem: null,
};
const base = { port: 4480, interfaces: ['lan', 'tailscale0'], interfaceTable };

describe('the direct ways the box tells its clients', () => {
  it('names only private addresses: a public IPv6 address the firewall keeps closed is left out', () => {
    const home = {
      eno1: [info('10.100.1.81', 'IPv4'), info('2001:db8:8355::71f', 'IPv6'), info('fd00:1::81', 'IPv6')],
      wlan0: [info('10.100.1.97', 'IPv4'), info('2001:db8:8355::7ed6', 'IPv6')],
    };
    const ways = directAddresses({ ...base, interfaceTable: home, tailscale: TAILSCALE_OFF });
    expect(ways.lan).toEqual(['10.100.1.81', '10.100.1.97', 'fd00:1::81']);
    expect(ways.routes.map((r) => r.socket)).toEqual([
      'ws://10.100.1.81:4480/v1/direct',
      'ws://10.100.1.97:4480/v1/direct',
      'ws://[fd00:1::81]:4480/v1/direct',
    ]);
  });

  it('lists the local network first (IPv4, then IPv6), then the Tailscale name over TLS', () => {
    expect(directAddresses({ ...base, tailscale: on })).toEqual({
      port: 4480,
      lan: ['10.100.1.20', 'fd00:1::20'],
      tailscale: 'box.tail0000.ts.net',
      routes: [
        { way: 'lan', socket: 'ws://10.100.1.20:4480/v1/direct', web: 'http://10.100.1.20:4480/' },
        { way: 'lan', socket: 'ws://[fd00:1::20]:4480/v1/direct', web: 'http://[fd00:1::20]:4480/' },
        {
          way: 'tailscale',
          socket: 'wss://box.tail0000.ts.net:4480/v1/direct',
          web: 'https://box.tail0000.ts.net:4480/',
        },
      ],
    });
  });

  it('keeps the Tailscale name plain without certificates, and leaves it out while Tailscale is off', () => {
    expect(directAddresses({ ...base, tailscale: { ...on, https: false } }).routes[2]).toEqual({
      way: 'tailscale',
      socket: 'ws://box.tail0000.ts.net:4480/v1/direct',
      web: 'http://box.tail0000.ts.net:4480/',
    });
    const off = directAddresses({ ...base, tailscale: TAILSCALE_OFF });
    expect(off.tailscale).toBeNull();
    expect(off.routes.map((r) => r.way)).toEqual(['lan', 'lan']);
    expect(directAddresses({ ...base, interfaces: ['lan'], tailscale: on }).tailscale).toBeNull();
  });

  it('has no ways in on loopback (development)', () => {
    expect(directAddresses({ ...base, interfaces: ['loopback'], tailscale: TAILSCALE_OFF })).toEqual({
      port: 4480,
      lan: [],
      tailscale: null,
      routes: [],
    });
  });
});
