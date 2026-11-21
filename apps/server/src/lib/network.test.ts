import { describe, expect, it } from 'vitest';
import { networkOf } from './network';

describe('networkOf (FR-14)', () => {
  it('keys IPv4 by address and IPv6 by its /64', () => {
    expect(networkOf('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(networkOf('::ffff:203.0.113.7')).toBe('v4:203.0.113.7');
    expect(networkOf('2001:db8:1:2::1')).toBe('v6:2001:0db8:0001:0002');
    expect(networkOf('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(networkOf('2001:db8:1:2::1'));
    expect(networkOf('2001:db8:1:3::1')).not.toBe(networkOf('2001:db8:1:2::1'));
    expect(networkOf('fe80::1%eth0')).toBe('v6:fe80:0000:0000:0000');
    expect(networkOf('not an address')).toBe('other:not an address');
  });
});
