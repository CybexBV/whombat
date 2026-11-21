import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  arrival,
  type InterfaceTable,
  interfaceAddresses,
  lanIpv6Only,
  parseInterfaceSpecs,
  plainAddress,
} from './network';

const v4 = (address: string, cidr: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr,
});
const v6 = (address: string, cidr: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:00:00:00:00:00',
  internal,
  cidr,
  scopeid: 0,
});

const TABLE: InterfaceTable = {
  lo: [v4('127.0.0.1', '127.0.0.1/8', true), v6('::1', '::1/128', true)],
  enp1s0: [
    v4('10.100.1.20', '10.100.1.20/24'),
    v6('2001:db8:abcd:1::20', '2001:db8:abcd:1::20/64'),
    v6('fe80::1', 'fe80::1/64'),
  ],
  tailscale0: [v4('100.101.102.103', '100.101.102.103/32'), v6('fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::1/128')],
  podman1: [v4('10.200.0.1', '10.200.0.1/24')],
};
const BOX = ['lan', 'tailscale0'];

describe('where the direct listener answers', () => {
  it('takes the local network from private, on-link and link-local peers', () => {
    expect(arrival(BOX, '10.100.1.20', '10.100.1.33', TABLE)).toMatchObject({
      network: 'lan',
      iface: 'enp1s0',
    });
    expect(arrival(BOX, '::ffff:10.100.1.20', '::ffff:192.168.5.9', TABLE)).toMatchObject({
      network: 'lan',
      local: '10.100.1.20',
      remote: '192.168.5.9',
    });
    expect(arrival(BOX, '2001:db8:abcd:1::20', '2001:db8:abcd:1::77', TABLE)?.network).toBe('lan');
    expect(arrival(BOX, 'fe80::1%enp1s0', 'fe80::99%enp1s0', TABLE)?.network).toBe('lan');
  });

  it('refuses a public peer on the local network card (a port forward)', () => {
    expect(arrival(BOX, '10.100.1.20', '203.0.113.7', TABLE)).toBeNull();
    expect(arrival(BOX, '2001:db8:abcd:1::20', '2001:db8::7', TABLE)).toBeNull();
  });

  it('takes Tailscale only from Tailscale addresses', () => {
    expect(arrival(BOX, '100.101.102.103', '100.64.1.2', TABLE)?.network).toBe('tailscale');
    expect(arrival(BOX, 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::9', TABLE)?.network).toBe('tailscale');
    expect(arrival(BOX, '100.101.102.103', '10.100.1.33', TABLE)).toBeNull();
  });

  it('never answers on a container bridge, loopback or an unknown address unless named', () => {
    expect(arrival(BOX, '10.200.0.1', '10.200.0.5', TABLE)).toBeNull();
    expect(arrival(BOX, '127.0.0.1', '127.0.0.1', TABLE)).toBeNull();
    expect(arrival(BOX, '10.99.99.99', '10.100.1.33', TABLE)).toBeNull();
    expect(arrival(['loopback'], '127.0.0.1', '127.0.0.1', TABLE)?.network).toBe('loopback');
    expect(arrival(['loopback'], '::1', '::1', TABLE)?.network).toBe('loopback');
    expect(arrival(['loopback'], '10.100.1.20', '10.100.1.33', TABLE)).toBeNull();
    expect(arrival(['tailscale0'], '10.100.1.20', '10.100.1.33', TABLE)).toBeNull();
    expect(arrival(['enp1s0'], '10.100.1.20', '10.100.1.33', TABLE)?.network).toBe('lan');
  });

  it('lists the addresses to tell clients, without link-local ones', () => {
    expect(interfaceAddresses(BOX, TABLE).map((a) => `${a.network} ${a.address}`)).toEqual([
      'lan 10.100.1.20',
      'lan 2001:db8:abcd:1::20',
      'tailscale 100.101.102.103',
      'tailscale fd7a:115c:a1e0::1',
    ]);
  });

  it('knows a network that gave only IPv6, whichever IPv6 addresses those are', () => {
    expect(lanIpv6Only(BOX, TABLE)).toBe(false);
    // Only a link-local and a public address: neither is one to tell anyone, and still the network is IPv6 only.
    const only: InterfaceTable = {
      lo: TABLE.lo,
      enp1s0: [v6('2001:db8:abcd:1::20', '2001:db8:abcd:1::20/64'), v6('fe80::1', 'fe80::1/64')],
      podman1: TABLE.podman1,
      tailscale0: TABLE.tailscale0,
    };
    expect(lanIpv6Only(BOX, only)).toBe(true);
    expect(interfaceAddresses(BOX, only).filter((a) => a.network === 'lan' && a.family === 'IPv4')).toEqual(
      [],
    );
    // No address at all isn't an IPv6-only network: the screen says to check the network.
    expect(lanIpv6Only(BOX, { lo: TABLE.lo })).toBe(false);
    expect(lanIpv6Only(['loopback'], only)).toBe(false);
  });

  it('reads plain addresses and the interface list', () => {
    expect(plainAddress('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(plainAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(parseInterfaceSpecs(' lan, tailscale0,,lan ')).toEqual(['lan', 'tailscale0']);
  });
});
