import { describe, expect, it } from 'vitest';
import type { ClaimState, ConsoleState } from './api';
import {
  asksNewLetters,
  burrowNameSize,
  clockOffset,
  codeSize,
  consoleScene,
  countdown,
  justClaimed,
  lettersStayMinutes,
  minutesLeft,
  moreBurrows,
  noAddress,
  nowhereToType,
} from './console';

const claim = (p: Partial<ClaimState> & Pick<ClaimState, 'state'>): ConsoleState => ({
  mode: 'console',
  now: '',
  claim: {
    code: '',
    claimUrl: 'app.whombat.com/claim',
    appUrl: 'app.whombat.com',
    retryAt: null,
    burrows: null,
    ...p,
  },
  footer: '',
  desk: null,
});

describe('consoleScene', () => {
  it('shows starting without a claim', () => {
    expect(consoleScene({ ...claim({ state: 'waiting' }), claim: null })).toBe('starting');
  });

  it('maps every claim state to its scene', () => {
    expect(consoleScene(claim({ state: 'starting' }))).toBe('starting');
    expect(consoleScene(claim({ state: 'waiting' }))).toBe('waiting');
    expect(consoleScene(claim({ state: 'claimable', code: 'KXQM' }))).toBe('claimable');
    expect(consoleScene(claim({ state: 'backoff', retryAt: '2026-09-27T12:05:00Z' }))).toBe('backoff');
    expect(consoleScene(claim({ state: 'claimed' }))).toBe('claimed');
  });

  it('never shows an empty or odd claim code', () => {
    expect(consoleScene(claim({ state: 'claimable', code: '' }))).toBe('waiting');
    expect(consoleScene(claim({ state: 'claimable', code: 'kx<m' }))).toBe('waiting');
  });

  it('shows the claim screen without a code when there is no address to open (LNK-55)', () => {
    const c = claim({ state: 'claimable', claimUrl: '', appUrl: '' });
    expect(consoleScene(c)).toBe('claimable');
    expect(c.claim && noAddress(c.claim)).toBe(true);
    expect(noAddress(claim({ state: 'claimable', code: 'KXQM' }).claim as ClaimState)).toBe(false);
  });

  it('shows the claim screen, not “check the cable”, while a network with IPv6 only leaves no address to name', () => {
    const c = claim({ state: 'waiting', claimUrl: '', appUrl: '', ipv6Only: true });
    expect(consoleScene(c)).toBe('claimable');
    expect(c.claim && nowhereToType(c.claim)).toBe(true);
    // Waiting without that: the network itself is missing.
    expect(consoleScene(claim({ state: 'waiting', claimUrl: '', appUrl: '' }))).toBe('waiting');
  });

  it('shows the code for the app on this network when the box has an address there', () => {
    const c = claim({ state: 'claimable', code: 'KXQM', claimUrl: '', appUrl: '', inApp: '192.0.2.10' });
    expect(consoleScene(c)).toBe('claimable');
    expect(c.claim && nowhereToType(c.claim)).toBe(false);
    expect(nowhereToType(claim({ state: 'claimable', claimUrl: '', appUrl: '' }).claim as ClaimState)).toBe(
      true,
    );
    // Something odd in its place shows the calmer neighbour, as with an address to open.
    expect(consoleScene(claim({ state: 'claimable', code: '', claimUrl: '', inApp: '192.0.2.10' }))).toBe(
      'waiting',
    );
  });
});

describe('backoff countdown', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');

  it('rounds minutes up and never shows less than 1, like the text console', () => {
    expect(minutesLeft('2026-09-27T12:05:00Z', now)).toBe(5);
    expect(minutesLeft('2026-09-27T12:04:01Z', now)).toBe(5);
    expect(minutesLeft('2026-09-27T12:00:20Z', now)).toBe(1);
    expect(minutesLeft('2026-09-27T11:59:00Z', now)).toBe(1);
    expect(minutesLeft(null, now)).toBe(1);
    expect(minutesLeft('garbage', now)).toBe(1);
  });

  it('counts down m:ss to zero', () => {
    expect(countdown('2026-09-27T12:04:30Z', now)).toBe('4:30');
    expect(countdown('2026-09-27T12:00:09.2Z', now)).toBe('0:10');
    expect(countdown('2026-09-27T11:00:00Z', now)).toBe('0:00');
    expect(countdown(null, now)).toBe('0:00');
  });

  it('uses the server clock', () => {
    const local = Date.parse('2026-09-27T11:58:00Z');
    const offset = clockOffset('2026-09-27T12:00:00Z', local);
    expect(offset).toBe(120_000);
    expect(countdown('2026-09-27T12:01:00Z', local + offset)).toBe('1:00');
    expect(clockOffset('not a time', local)).toBe(0);
  });
});

describe('moreBurrows', () => {
  it('says nothing for none and gets the plural right', () => {
    expect(moreBurrows(0)).toBeNull();
    expect(moreBurrows(-1)).toBeNull();
    expect(moreBurrows(1)).toBe('+ 1 more burrow');
    expect(moreBurrows(2)).toBe('+ 2 more burrows');
    expect(moreBurrows(12)).toBe('+ 12 more burrows');
  });
});

describe('justClaimed', () => {
  it('celebrates only a claim that happens while watching', () => {
    expect(justClaimed('claimable', 'claimed')).toBe(true);
    expect(justClaimed('waiting', 'claimed')).toBe(true);
    expect(justClaimed(null, 'claimed')).toBe(false);
    expect(justClaimed('claimed', 'claimed')).toBe(false);
    expect(justClaimed('claimable', 'backoff')).toBe(false);
  });
});

describe('sizes', () => {
  it('shrinks long burrow names', () => {
    expect(burrowNameSize('Acme')).toBe(88);
    expect(burrowNameSize('Harbour Street Studio')).toBe(58);
    expect(burrowNameSize('x'.repeat(80))).toBe(48);
    expect(burrowNameSize('Banjo’s Burrow')).toBe(88);
  });

  it('keeps four letters huge and fits longer codes', () => {
    expect(codeSize(4)).toBe(176);
    expect(codeSize(10) * 10).toBeLessThanOrEqual(700);
  });
});

describe('new letters asked for at the box', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const lan = { state: 'claimable', code: 'KXQM', claimUrl: '', appUrl: '', inApp: '192.0.2.10' } as const;

  it('says for how many minutes the letters stay, as the text console does', () => {
    const until = (lettersUntil: string) => lettersStayMinutes({ ...lan, lettersUntil } as ClaimState, now);
    expect(until('2026-09-27T12:10:00Z')).toBe(10);
    expect(until('2026-09-27T12:00:20Z')).toBe(1);
    // The page read the box's clock a moment ago: ten minutes asked for still start at 10, never 11.
    expect(until('2026-09-27T12:10:01.500Z')).toBe(10);
    expect(until('2026-09-27T12:09:30Z')).toBe(10);
    expect(until('2026-09-27T12:08:30Z')).toBe(9);
    // Past, or none: the letters change after a wrong try.
    expect(until('2026-09-27T11:59:59Z')).toBeNull();
    expect(lettersStayMinutes(lan as unknown as ClaimState, now)).toBeNull();
  });

  it('takes the N key by itself, nothing held with it', () => {
    const key = (key: string, held: Partial<KeyboardEvent> = {}) =>
      asksNewLetters({ key, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...held });
    expect(key('n')).toBe(true);
    expect(key('N')).toBe(true);
    expect(key('m')).toBe(false);
    expect(key('Enter')).toBe(false);
    expect(key('n', { ctrlKey: true })).toBe(false);
    expect(key('n', { repeat: true })).toBe(false);
  });
});
