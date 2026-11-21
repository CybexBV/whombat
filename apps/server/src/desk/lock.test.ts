import { describe, expect, it } from 'vitest';
import {
  DeskLock,
  DeskPairing,
  PAIRING_TRIES,
  PAIRING_TTL_MS,
  UNLOCK_IDLE_MS,
  UNLOCK_REQUEST_TTL_MS,
} from './lock';

/** A byte stream that gives the letters A, B, C, D, E, … in order (each byte picks the alphabet's n-th letter). */
function counting() {
  let n = 0;
  return (size: number) => Uint8Array.from({ length: size }, () => n++ % 20);
}

describe('pairing letters (DK-02)', () => {
  it('shows four letters for 10 minutes, ends when typed right', () => {
    const p = new DeskPairing(counting());
    const { code, expiresAt } = p.start(1_000);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRTVWXY]{4}$/);
    expect(expiresAt).toBe(1_000 + PAIRING_TTL_MS);
    expect(p.live(2_000)?.code).toBe(code);
    expect(p.check(code.toLowerCase(), 2_000)).toEqual({ ok: true });
    expect(p.live(2_000)).toBeNull();
    expect(p.check(code, 2_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('runs out after 10 minutes', () => {
    const p = new DeskPairing(counting());
    const { code } = p.start(0);
    expect(p.check(code, PAIRING_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
  });

  it('draws new letters after five wrong tries, until the same end', () => {
    const p = new DeskPairing(counting());
    const { code, expiresAt } = p.start(0);
    for (let i = 1; i < PAIRING_TRIES; i++)
      expect(p.check('ZZZZ', 10)).toEqual({ ok: false, reason: 'wrong', triesLeft: PAIRING_TRIES - i });
    expect(p.check('ZZZZ', 10)).toEqual({ ok: false, reason: 'wrong', triesLeft: PAIRING_TRIES });
    const next = p.live(10);
    expect(next?.code).not.toBe(code);
    expect(next?.expiresAt).toBe(expiresAt);
    expect(p.check(code, 10)).toMatchObject({ ok: false, reason: 'wrong' });
  });
});

describe('the lock (DK-04)', () => {
  it('stays unlocked 2 minutes past the last touch, locks at once with the button', () => {
    const l = new DeskLock(() => 'dur_1');
    expect(l.view(0, null)).toEqual({ state: 'locked' });
    expect(l.touch(0)).toBeNull();
    expect(l.unlock(0)).toBe(UNLOCK_IDLE_MS);
    expect(l.view(1_000, null)).toEqual({ state: 'unlocked', until: UNLOCK_IDLE_MS });
    expect(l.touch(100_000)).toBe(100_000 + UNLOCK_IDLE_MS);
    expect(l.unlocked(100_000 + UNLOCK_IDLE_MS - 1)).toBe(true);
    expect(l.unlocked(100_000 + UNLOCK_IDLE_MS)).toBe(false);
    l.unlock(0);
    l.lock();
    expect(l.view(1, null).state).toBe('locked');
  });

  it('asks the phone once at a time, for 2 minutes; the answer takes the request', () => {
    let n = 0;
    const l = new DeskLock(() => `dur_${++n}`);
    const first = l.ask(0);
    expect(first).toEqual({ request: { id: 'dur_1', expiresAt: UNLOCK_REQUEST_TTL_MS }, fresh: true });
    expect(l.ask(1_000)).toEqual({ request: first.request, fresh: false });
    expect(l.view(1_000, null)).toEqual({ state: 'phone', expiresAt: UNLOCK_REQUEST_TTL_MS });
    expect(l.take('dur_9', 1_000)).toBeNull();
    expect(l.take('dur_1', 1_000)?.id).toBe('dur_1');
    expect(l.take('dur_1', 1_000)).toBeNull();
    expect(l.ask(UNLOCK_REQUEST_TTL_MS + 1).fresh).toBe(true);
    expect(l.take('dur_2', 2 * UNLOCK_REQUEST_TTL_MS + 1)).toBeNull();
  });

  it('shows the PIN wait while locked, unlocked before it, and resets', () => {
    const l = new DeskLock();
    expect(l.view(0, 60_000)).toEqual({ state: 'backoff', retryAt: 60_000 });
    expect(l.view(60_000, 60_000)).toEqual({ state: 'locked' });
    l.unlock(0);
    expect(l.view(1, 60_000).state).toBe('unlocked');
    l.ask(1);
    l.reset();
    expect(l.view(2, null)).toEqual({ state: 'locked' });
    expect(l.request(2)).toBeNull();
  });
});

describe('an unlock that stays until Lock (DK-74, DK-S71)', () => {
  const DAY = 86_400_000;

  it('is never locked by time; its view says so and moves its 2 minutes on; Lock locks it', () => {
    const l = new DeskLock();
    l.unlock(0, true);
    expect(l.stays).toBe(true);
    expect(l.unlocked(30 * DAY)).toBe(true);
    expect(l.view(30 * DAY, null)).toEqual({
      state: 'unlocked',
      until: 30 * DAY + UNLOCK_IDLE_MS,
      stays: true,
    });
    expect(l.touch(30 * DAY + 5)).toBe(30 * DAY + 5 + UNLOCK_IDLE_MS);
    // The camera keeps nothing of it.
    expect(l.watchFrom(l.epoch, 1)).toBe(false);
    const epoch = l.epoch;
    l.lock();
    expect(l.epoch).toBe(epoch + 1);
    expect(l.stays).toBe(false);
    expect(l.view(30 * DAY + 10, null)).toEqual({ state: 'locked' });
    expect(l.touch(30 * DAY + 10)).toBeNull();
  });

  it('stays from the change when chosen while unlocked, and the change off counts as a touch', () => {
    const l = new DeskLock();
    l.unlock(0);
    const epoch = l.epoch;
    expect(l.stay(true, 60_000)).toBe(true);
    expect(l.unlocked(DAY)).toBe(true);
    expect(l.stay(false, DAY)).toBe(true);
    // Neither is a new unlock: an answer the camera gives for it still counts.
    expect(l.epoch).toBe(epoch);
    expect(l.view(DAY + 1, null)).toEqual({ state: 'unlocked', until: DAY + UNLOCK_IDLE_MS });
    expect(l.unlocked(DAY + UNLOCK_IDLE_MS - 1)).toBe(true);
    expect(l.unlocked(DAY + UNLOCK_IDLE_MS)).toBe(false);
  });

  it('never undoes a lock: a choice on a locked screen unlocks nothing', () => {
    const l = new DeskLock();
    expect(l.stay(true, 0)).toBe(false);
    expect(l.unlocked(1)).toBe(false);
    l.unlock(0);
    expect(l.stay(true, UNLOCK_IDLE_MS)).toBe(false);
    expect(l.stays).toBe(false);
    expect(l.unlocked(UNLOCK_IDLE_MS + 1)).toBe(false);
  });

  it('starts locked again after a reset (paired again, unpaired)', () => {
    const l = new DeskLock();
    l.unlock(0, true);
    l.reset();
    expect(l.view(1, null)).toEqual({ state: 'locked' });
  });
});
