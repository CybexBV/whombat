/** The link a service's address names (one-person.md OP-S135): the home network's card, never a virtual one. */
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { homeNetworkAddress } from './home-address';

const card = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) =>
  ({ address, family, internal, netmask: '', mac: '', cidr: null }) as unknown as NetworkInterfaceInfo;

describe('homeNetworkAddress', () => {
  it('takes the home network’s IPv4 address, not a loopback, bridge or Tailscale one', () => {
    expect(
      homeNetworkAddress({
        lo: [card('127.0.0.1', 'IPv4', true)],
        podman0: [card('10.88.0.1')],
        tailscale0: [card('100.64.0.2')],
        enp3s0: [card('fe80::1', 'IPv6'), card('2001:db8::5', 'IPv6'), card('192.168.1.20')],
      }),
    ).toBe('192.168.1.20');
  });

  it('an IPv6 address in brackets when there is no IPv4 one; none at all is null', () => {
    expect(homeNetworkAddress({ eth0: [card('2001:db8::5', 'IPv6')] })).toBe('[2001:db8::5]');
    expect(homeNetworkAddress({ lo: [card('127.0.0.1', 'IPv4', true)] })).toBeNull();
  });
});
