import { DESK_SCREEN_CODE_RE, DESK_TRIES } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_CODE_TTL_MS,
  DISPLAY_KEEP_MS,
  DISPLAY_REQUESTS_PER_KEY,
  DISPLAY_REQUESTS_PER_MINUTE,
  DISPLAY_TRIES_WINDOW_MS,
  DISPLAY_WAITING_MAX,
  DisplayRequests,
} from './display-requests';

const T0 = Date.parse('2026-10-27T12:00:00.000Z');
const TABLET = { label: 'Safari on iPad', platform: 'web' as const };
const key = (n: number) => ({ peerId: `peer-${n}`, publicKey: `pub-${n}` });

function asked(requests: DisplayRequests, n: number, now = T0) {
  const r = requests.request(key(n), TABLET, now);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.request;
}

describe('a device asking to become a screen', () => {
  it('shows six letters for ten minutes, and only the device that asked hears how it goes', () => {
    const requests = new DisplayRequests();
    const r = asked(requests, 1);
    expect(r.code).toMatch(DESK_SCREEN_CODE_RE);
    expect(r.expiresAt).toBe(T0 + DISPLAY_CODE_TTL_MS);
    expect(requests.status('peer-1', r.requestId, T0)).toEqual({ state: 'waiting' });
    expect(requests.status('peer-2', r.requestId, T0)).toBeNull();
    expect(requests.status('peer-1', r.requestId, r.expiresAt)).toEqual({ state: 'expired' });
    // Long gone: as if it never was.
    expect(requests.status('peer-1', r.requestId, r.expiresAt + DISPLAY_KEEP_MS)).toBeNull();
  });

  it('a new request of the same key replaces its letters', () => {
    const requests = new DisplayRequests();
    const first = asked(requests, 1);
    const second = asked(requests, 1, T0 + 1000);
    expect(requests.status('peer-1', first.requestId, T0 + 1000)).toBeNull();
    expect(requests.take(first.code, T0 + 1000)).toEqual({ ok: false, reason: 'wrong' });
    expect(requests.take(second.code, T0 + 1000)).toMatchObject({ ok: true });
    expect(requests.waiting(T0 + 1000)).toBe(1);
  });

  it('a key asks at most ten times an hour', () => {
    const requests = new DisplayRequests();
    for (let i = 0; i < DISPLAY_REQUESTS_PER_KEY; i++) asked(requests, 1, T0 + i);
    expect(requests.request(key(1), TABLET, T0 + 100)).toEqual({ ok: false, reason: 'key_limit' });
    expect(requests.request(key(2), TABLET, T0 + 100).ok).toBe(true);
    expect(requests.request(key(1), TABLET, T0 + 3600_000 + 1).ok).toBe(true);
  });

  it('at most 32 devices wait in each pool: strangers through the relay don’t take the local network’s places', () => {
    const requests = new DisplayRequests();
    // Spread out, so the minute's limit isn't what refuses.
    const at = (i: number) => T0 + i * 2_100;
    for (let i = 0; i < DISPLAY_WAITING_MAX; i++) asked(requests, i, at(i));
    const later = at(DISPLAY_WAITING_MAX);
    expect(requests.request(key(999), TABLET, later, 'relay')).toEqual({ ok: false, reason: 'full' });
    expect(requests.request(key(998), TABLET, later, 'direct').ok).toBe(true);
    // A waiting device asking again replaces its own place; one that ran out makes room.
    expect(requests.request(key(0), TABLET, later + 1, 'relay').ok).toBe(true);
    expect(requests.request(key(999), TABLET, later + DISPLAY_CODE_TTL_MS + 2, 'relay').ok).toBe(true);
  });

  it('the box takes at most 30 new requests a minute, from anyone', () => {
    const requests = new DisplayRequests();
    for (let i = 0; i < DISPLAY_REQUESTS_PER_MINUTE; i++) asked(requests, i, T0 + i);
    expect(requests.request(key(100), TABLET, T0 + 100, 'direct')).toEqual({ ok: false, reason: 'busy' });
    expect(requests.request(key(100), TABLET, T0 + 60_001, 'direct').ok).toBe(true);
  });

  it('draws other letters while the ones it drew are showing', () => {
    // A source that repeats itself: the first letters again, then new ones.
    let calls = 0;
    const random = (n: number) =>
      Uint8Array.from({ length: n }, (_, i) => (calls++ < 6 + 18 + 6 ? i : i + 7));
    const requests = new DisplayRequests(random);
    const a = asked(requests, 1);
    const b = asked(requests, 2);
    expect(b.code).not.toBe(a.code);
  });
});

describe('typing the letters', () => {
  it('takes a waiting device once; letters no device shows are wrong', () => {
    const requests = new DisplayRequests();
    const r = asked(requests, 1);
    expect(requests.take('ABCDEF' === r.code ? 'ABCDEG' : 'ABCDEF', T0)).toEqual({
      ok: false,
      reason: 'wrong',
    });
    const taken = requests.take(r.code, T0);
    expect(taken).toEqual({ ok: true, request: r });
    // Being added: nobody else takes it meanwhile.
    expect(requests.take(r.code, T0)).toEqual({ ok: false, reason: 'wrong' });
    requests.added(r, { id: 'scr_kitchen01', name: 'Kitchen' });
    expect(requests.status('peer-1', r.requestId, T0)).toEqual({
      state: 'added',
      screen: { id: 'scr_kitchen01', name: 'Kitchen' },
    });
    expect(requests.take(r.code, T0)).toEqual({ ok: false, reason: 'wrong' });
    expect(requests.waiting(T0)).toBe(0);
  });

  it('letters that ran out say so for a while, then are just wrong', () => {
    const requests = new DisplayRequests();
    const r = asked(requests, 1);
    expect(requests.take(r.code, r.expiresAt)).toEqual({ ok: false, reason: 'expired' });
    expect(requests.take(r.code, r.expiresAt + DISPLAY_KEEP_MS)).toEqual({ ok: false, reason: 'wrong' });
  });

  it('a commit that failed for a moment gives the letters back; one that can never work ends them', () => {
    const requests = new DisplayRequests();
    const r = asked(requests, 1);
    const taken = requests.take(r.code, T0);
    if (!taken.ok) throw new Error('not taken');
    requests.release(taken.request);
    expect(requests.status('peer-1', r.requestId, T0)).toEqual({ state: 'waiting' });
    const again = requests.take(r.code, T0);
    if (!again.ok) throw new Error('not taken again');
    requests.drop(again.request);
    expect(requests.take(r.code, T0)).toEqual({ ok: false, reason: 'wrong' });
    expect(requests.status('peer-1', r.requestId, T0)).toEqual({ state: 'expired' });
  });

  it('a request someone is adding isn’t thrown away by the device asking again', () => {
    const requests = new DisplayRequests();
    const r = asked(requests, 1);
    const taken = requests.take(r.code, T0);
    if (!taken.ok) throw new Error('not taken');
    asked(requests, 1, T0 + 1);
    requests.added(taken.request, { id: 'scr_kitchen01', name: 'Kitchen' });
    expect(requests.status('peer-1', r.requestId, T0 + 2)).toMatchObject({ state: 'added' });
  });

  it('the person has five wrong tries in ten minutes', () => {
    const requests = new DisplayRequests();
    expect(requests.triesLeft('acc', T0)).toBe(DESK_TRIES);
    for (let i = 1; i <= DESK_TRIES; i++) expect(requests.wrongTry('acc', T0 + i)).toBe(DESK_TRIES - i);
    expect(requests.triesLeft('acc', T0 + 10)).toBe(0);
    expect(requests.triesLeft('other', T0 + 10)).toBe(DESK_TRIES);
    expect(requests.retryAt('acc', T0 + 10)).toBe(T0 + 1 + DISPLAY_TRIES_WINDOW_MS);
    expect(requests.triesLeft('acc', T0 + 1 + DISPLAY_TRIES_WINDOW_MS)).toBe(1);
  });
});
