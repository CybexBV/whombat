import { describe, expect, it } from 'vitest';
import { DirectGuard, peerKey } from './limits';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('the direct listener’s limits per address', () => {
  it('counts a local IPv6 device by its /64 and everything else by its address', () => {
    expect(peerKey('2001:db8:abcd:1:aaaa::1')).toBe(peerKey('2001:db8:abcd:1:bbbb::2'));
    expect(peerKey('2001:db8:abcd:1::1')).not.toBe(peerKey('2001:db8:abcd:2::1'));
    expect(peerKey('fd7a:115c:a1e0:ab12::1')).not.toBe(peerKey('fd7a:115c:a1e0:ab12::2'));
    expect(peerKey('::ffff:10.0.0.5')).toBe('10.0.0.5');
  });

  it('lets a burst of new WebSockets through, then one a second', () => {
    const c = clock();
    const guard = new DirectGuard({ upgradeBurst: 3, upgradesPerSecond: 1 }, c.now);
    expect([1, 2, 3, 4].map(() => guard.upgrade('10.0.0.5'))).toEqual(['ok', 'ok', 'ok', 'rate_limited']);
    expect(guard.upgrade('10.0.0.6')).toBe('ok');
    c.advance(1_000);
    expect(guard.upgrade('10.0.0.5')).toBe('ok');
    expect(guard.upgrade('10.0.0.5')).toBe('rate_limited');
  });

  it('turns an address away after too many failures, for a while', () => {
    const c = clock();
    const guard = new DirectGuard({ failures: 3, failureWindowMs: 60_000, lockoutMs: 120_000 }, c.now);
    guard.failed('10.0.0.5');
    guard.failed('10.0.0.5');
    c.advance(61_000);
    guard.failed('10.0.0.5');
    expect(guard.locked('10.0.0.5')).toBe(false);
    guard.failed('10.0.0.5');
    guard.failed('10.0.0.5');
    expect(guard.locked('10.0.0.5')).toBe(true);
    expect(guard.upgrade('10.0.0.5')).toBe('locked');
    expect(guard.openSocket('10.0.0.5')).toBe(false);
    expect(guard.upgrade('10.0.0.6')).toBe('ok');
    c.advance(120_001);
    expect(guard.locked('10.0.0.5')).toBe(false);
    expect(guard.stats.lockouts).toBe(1);
  });

  it('bounds handshakes at once per address and overall', () => {
    const guard = new DirectGuard({ handshakesPerPeer: 2, handshakes: 3 });
    expect(guard.beginHandshake('10.0.0.5')).toBe(true);
    expect(guard.beginHandshake('10.0.0.5')).toBe(true);
    expect(guard.beginHandshake('10.0.0.5')).toBe(false);
    expect(guard.beginHandshake('10.0.0.6')).toBe(true);
    expect(guard.beginHandshake('10.0.0.7')).toBe(false);
    guard.endHandshake('10.0.0.5');
    expect(guard.beginHandshake('10.0.0.7')).toBe(true);
    expect(guard.inFlightHandshakes).toBe(3);
  });

  it('bounds sockets per address and overall', () => {
    const guard = new DirectGuard({ socketsPerPeer: 1, sockets: 2 });
    expect(guard.openSocket('10.0.0.5')).toBe(true);
    expect(guard.openSocket('10.0.0.5')).toBe(false);
    expect(guard.openSocket('10.0.0.6')).toBe(true);
    expect(guard.openSocket('10.0.0.7')).toBe(false);
    guard.closeSocket('10.0.0.5');
    expect(guard.openSocket('10.0.0.7')).toBe(true);
    expect(guard.openSockets).toBe(2);
  });

  it('remembers a bounded number of addresses, forgetting idle ones first', () => {
    const c = clock();
    const guard = new DirectGuard({ maxPeers: 2 }, c.now);
    expect(guard.upgrade('10.0.0.1')).toBe('ok');
    expect(guard.upgrade('10.0.0.2')).toBe('ok');
    expect(guard.upgrade('10.0.0.3')).toBe('rate_limited');
    c.advance(61_000);
    expect(guard.upgrade('10.0.0.3')).toBe('ok');
  });
});
