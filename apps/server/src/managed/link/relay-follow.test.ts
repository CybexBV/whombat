import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followLinkWithRelay } from './relay-follow';

describe('the relay follows Link', () => {
  let active = false;
  const calls: string[] = [];
  const follower = () =>
    followLinkWithRelay({
      active: () => active,
      start: () => calls.push('start'),
      close: () => calls.push('close'),
      delayMs: 1_000,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    active = false;
    calls.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('a box starting without Link closes it at once', () => {
    follower().follow();
    expect(calls).toEqual(['close']);
  });

  it('Link stopping closes it a moment later, so the answer to the owner goes out first', () => {
    const relay = follower();
    active = true;
    relay.follow();
    active = false;
    relay.follow();
    relay.follow();
    expect(calls).toEqual(['start']);
    vi.advanceTimersByTime(1_000);
    expect(calls).toEqual(['start', 'close']);
  });

  it('Link back on before then keeps it open', () => {
    const relay = follower();
    active = true;
    relay.follow();
    active = false;
    relay.follow();
    active = true;
    relay.follow();
    vi.advanceTimersByTime(5_000);
    expect(calls).toEqual(['start', 'start']);
  });

  it('the box stopping stops the wait', () => {
    const relay = follower();
    active = true;
    relay.follow();
    active = false;
    relay.follow();
    relay.stop();
    vi.advanceTimersByTime(5_000);
    expect(calls).toEqual(['start']);
  });
});
