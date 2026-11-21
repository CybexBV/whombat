import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES } from './errors.js';
import {
  CABLE_ERROR_CODES,
  CABLE_ERROR_STATUS,
  type HostNetwork,
  HostNetworkOutput,
  hostNetworkValid,
  sameSubnet,
} from './network.js';
import { SESSION_OPERATIONS } from './operations.js';

const base: HostNetwork = {
  online: true,
  checkedAt: '2026-11-03T15:35:54Z',
  wired: [{ interface: 'enp1s0', connected: true, address: '10.100.1.81', prefixLength: 23, plugged: true }],
  wifi: {
    interface: 'wlan0',
    state: 'connected',
    ssid: 'Home 2.0',
    signal: 4,
    address: '10.100.1.97',
    prefixLength: 23,
    mac: 'ae:00:00:16:47:58',
    saved: [],
  },
  change: null,
};

describe('Wi-Fi only (network-move.md)', () => {
  it('compares subnets by the shorter prefix', () => {
    expect(
      sameSubnet({ address: '10.100.1.81', prefixLength: 23 }, { address: '10.100.0.40', prefixLength: 23 }),
    ).toBe(true);
    expect(
      sameSubnet({ address: '10.100.1.81', prefixLength: 24 }, { address: '10.100.2.5', prefixLength: 24 }),
    ).toBe(false);
    expect(
      sameSubnet(
        { address: '2001:db8:8355::1', prefixLength: 64 },
        { address: '2001:db8:8355:0:aae2::5', prefixLength: 64 },
      ),
    ).toBe(true);
    expect(
      sameSubnet({ address: '10.100.1.81', prefixLength: 23 }, { address: 'fd00::1', prefixLength: 64 }),
    ).toBeNull();
    expect(sameSubnet({ address: '10.100.1.81' }, { address: '10.100.1.97', prefixLength: 23 })).toBeNull();
    expect(
      sameSubnet({ address: '10.100.1.300', prefixLength: 23 }, { address: '10.100.1.97', prefixLength: 23 }),
    ).toBeNull();
  });

  it('checks prefixes and the cable change', () => {
    expect(hostNetworkValid(base)).toBe(true);
    expect(
      hostNetworkValid({ ...base, wired: [{ interface: 'enp1s0', connected: false, prefixLength: 23 }] }),
    ).toBe(false);
    const cableChange = {
      id: 'c-w7m2p9qa',
      use: 'wifi',
      by: 'person',
      phase: 'reverted',
      deadline: '2026-11-03T16:00:00Z',
    } as const;
    expect(hostNetworkValid({ ...base, cableChange })).toBe(false);
    expect(hostNetworkValid({ ...base, cableChange: { ...cableChange, failure: 'no_internet' } })).toBe(true);
  });

  it('registers host.cable.set and its refusals', () => {
    expect(SESSION_OPERATIONS.has('host.cable.set')).toBe(true);
    for (const code of CABLE_ERROR_CODES) {
      expect(Object.keys(APP_ERROR_CODES)).toContain(code);
      expect(CABLE_ERROR_STATUS[code]).toBeTruthy();
    }
  });

  it('reads an older answer without the move', () => {
    expect(HostNetworkOutput.parse({ network: base }).move).toBeUndefined();
  });
});
