/**
 * Openings lapse on the daemon's own clock: each comes with how long it holds, so a removal that never arrives (the
 * runner failed to send it, or stopped) can't keep a production server open. The rest of the policy stays.
 */
import { describe, expect, it } from 'vitest';
import { HeldPolicy } from './held';
import { decide, EMPTY_POLICY, type NetPolicy } from './rules';

const host = { hostAddresses: [], deny: [] };
const server = '93.184.216.34';
const withOpening = (ttlMs: number): NetPolicy => ({
  ...EMPTY_POLICY,
  homeNetworks: ['10.1.0.0/16'],
  production: [server],
  open: [{ address: server, port: 22, ttlMs }],
});

function clocked() {
  let t = 5_000;
  const held = new HeldPolicy(() => t);
  const reaches = () => {
    const p = held.get();
    return p !== null && decide(server, 22, p, host).ok;
  };
  return { held, reaches, advance: (ms: number) => (t += ms) };
}

describe('the openings the daemon holds', () => {
  it('holds nothing before the runner set a policy', () => {
    expect(new HeldPolicy(() => 0).get()).toBeNull();
  });

  it('closes an opening when its time is up, without another word from the runner', () => {
    const { held, reaches, advance } = clocked();
    held.set(withOpening(60_000));
    expect(reaches()).toBe(true);
    advance(59_999);
    expect(reaches()).toBe(true);
    expect(held.get()?.open).toEqual([{ address: server, port: 22, ttlMs: 1 }]);
    advance(1);
    expect(reaches()).toBe(false);
    // The production server stays closed, and the rest of the policy stays as it was.
    expect(held.get()).toMatchObject({ production: [server], homeNetworks: ['10.1.0.0/16'], open: [] });
  });

  it('keeps an opening while the runner renews it, and closes it once the renewals stop', () => {
    const { held, reaches, advance } = clocked();
    for (let i = 0; i < 5; i++) {
      held.set(withOpening(90_000));
      advance(30_000);
      expect(reaches()).toBe(true);
    }
    // The runner stopped (crashed, or its updates fail): nothing more arrives.
    advance(59_999);
    expect(reaches()).toBe(true);
    advance(1);
    expect(reaches()).toBe(false);
  });

  it('closes a removed opening even when the update removing it never arrives', () => {
    const { held, reaches, advance } = clocked();
    held.set(withOpening(90_000));
    // The runner tried to remove it, and the update was lost: the daemon still has the old policy.
    advance(90_000);
    expect(reaches()).toBe(false);
  });
});
