/**
 * The console code's state and the console file (CC-01, CC-07, CC-08, CC-13; MR-49…MR-54), without a database: letters,
 * lease, rotation, backoff, claimed, the file's content, mode and atomic replacement, and its rewrite when a backoff
 * or lease runs out.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleState, consoleStateValid } from '@whombat/control-contracts/local';
import {
  CLAIM_CODE_ALPHABET,
  CLAIM_WINDOW_S,
  CLAIM_WINDOW_WRONG,
  CLAIM_WINDOW_WRONG_PER_KEY,
  normalizeClaimCode,
} from '@whombat/protocol/claim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoxPageAsApp } from '../config';
import type { Services } from '../services';
import { ClaimCeremony, NO_ADDRESS_URL, writeConsoleFile } from './claim';

let dir: string;
let file: string;
let now: Date;
const warn = vi.fn();

function services(appUrl: string | null = 'https://app.whombat.test'): Services {
  return {
    config: { WHOMBAT_APP_URL: appUrl ?? undefined, WHOMBAT_CONSOLE_GROUP: 'whombat-console-test-none' },
    clock: () => now,
    log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as Services;
}

const read = () => ConsoleState.parse(JSON.parse(readFileSync(file, 'utf8')));
const lease = (lookup = '4821', ms = 3600_000) => ({ lookup, expiresAt: new Date(now.getTime() + ms) });
const ready = { claimed: false, deviceReady: true, retryAt: null };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-console-'));
  file = join(dir, 'console.json');
  now = new Date('2026-09-26T10:00:00Z');
  warn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('the console of a community box (HE-S207)', () => {
  it('shows the letters whenever it isn’t claimed, without a device id or lease, at the box’s own page', () => {
    const cfg = { WHOMBAT_EDITION: 'community', WHOMBAT_CONSOLE_GROUP: 'whombat-console-test-none' };
    const s = { ...services(), config: cfg } as unknown as Services;
    useBoxPageAsApp(cfg as never, () => 'http://192.168.1.20:4480/');
    const c = new ClaimCeremony(s, file);
    c.setStatus({ claimed: false, deviceReady: false, retryAt: null });
    const shown = read();
    expect(shown).toMatchObject({ state: 'claimable', url: 'http://192.168.1.20:4480/' });
    expect(c.codePassword(now)?.password).toBe(shown.code);
    expect(c.claimed).toBe(false);
    c.failed('code', null);
    expect(read().code).not.toBe(shown.code);
    c.setStatus({ claimed: true, deviceReady: false, retryAt: null });
    expect(read()).toEqual({ v: 1, state: 'claimed', url: 'http://192.168.1.20:4480/' });
    expect(c.codePassword(now)).toBeNull();
  });
});

describe('new letters asked for at the box', () => {
  const community = (page: () => string | null = () => 'http://192.168.1.20:4480/') => {
    const cfg = { WHOMBAT_EDITION: 'community', WHOMBAT_CONSOLE_GROUP: 'whombat-console-test-none' };
    useBoxPageAsApp(cfg as never, page);
    return new ClaimCeremony({ ...services(), config: cfg } as unknown as Services, file);
  };

  it('shows fresh letters over a wait, says until when they stay, and keeps them through wrong tries', () => {
    const c = community();
    c.setStatus({ claimed: false, deviceReady: false, retryAt: new Date(now.getTime() + 600_000) });
    expect(read().state).toBe('backoff');
    const generation = c.generation;
    const until = c.openWindow(now);
    expect(until?.getTime()).toBe(now.getTime() + CLAIM_WINDOW_S * 1000);
    const shown = read();
    expect(shown).toMatchObject({ state: 'claimable', lettersUntil: until?.toISOString() });
    expect(consoleStateValid(shown)).toBe(true);
    // Exchanges begun on the letters from before can't be proved any more.
    expect(c.generation).toBe(generation + 1);
    for (let i = 1; i < CLAIM_WINDOW_WRONG; i++) {
      expect(c.windowFailed(`peer-${i}`, now)).toBe('open');
      expect(read().code).toBe(shown.code);
      expect(c.generation).toBe(generation + 1);
    }
    expect(c.windowFailed('peer-last', now)).toBe('ended');
    expect(c.liveWindow(now)).toBeNull();
  });

  it('counts each device’s wrong tries on its own', () => {
    const c = community();
    c.setStatus({ claimed: false, deviceReady: false, retryAt: null });
    c.openWindow(now);
    for (let i = 0; i < CLAIM_WINDOW_WRONG_PER_KEY; i++) {
      expect(c.windowSpent('one', now)).toBe(false);
      c.windowFailed('one', now);
    }
    expect(c.windowSpent('one', now)).toBe(true);
    expect(c.windowSpent('another', now)).toBe(false);
  });

  it('runs out by itself: new letters again, and the wait the counters gave', () => {
    const c = community();
    c.setStatus({ claimed: false, deviceReady: false, retryAt: null });
    c.openWindow(now);
    const shown = read().code;
    c.windowFailed('one', now);
    c.setRetryAt(new Date(now.getTime() + 3_600_000));
    expect(read()).toMatchObject({ state: 'claimable', code: shown });
    now = new Date(now.getTime() + CLAIM_WINDOW_S * 1000);
    c.refresh();
    expect(read().state).toBe('backoff');
    expect(c.windowFailed('one', now)).toBe('none');
    now = new Date(now.getTime() + 3_600_001);
    c.refresh();
    expect(read().state).toBe('claimable');
    expect(read().code).not.toBe(shown);
    expect(read().lettersUntil).toBeUndefined();
  });

  it('is not for a claimed box, or one that shows no letters of its own', () => {
    const c = community();
    c.setStatus({ claimed: true, deviceReady: false, retryAt: null });
    expect(c.openWindow(now)).toBeNull();
    // A box claimed through control: its letters wait for control's lease, and the manager's claim button.
    const control = new ClaimCeremony(services(), file);
    control.setStatus(ready);
    control.setLease(lease());
    expect(control.openWindow(now)).toBeNull();
  });

  it('says to check the network while nobody can reach the box, and names no address', () => {
    let page: string | null = null;
    const c = community(() => page);
    c.hasWay = () => page !== null;
    c.setStatus({ claimed: false, deviceReady: false, retryAt: null });
    // Never the hosted app's address, never the box's own loopback.
    expect(read()).toEqual({ v: 1, state: 'waiting', url: NO_ADDRESS_URL });
    page = 'http://192.168.1.20:4480/';
    c.refresh();
    expect(read()).toMatchObject({ state: 'claimable', url: page });
    page = null;
    c.setStatus({ claimed: true, deviceReady: false, retryAt: null });
    expect(read()).toEqual({ v: 1, state: 'claimed', url: NO_ADDRESS_URL });
  });

  it('says so when the network gave only IPv6, whether or not the box has an address to name', () => {
    let page: string | null = null;
    let ipv6Only = true;
    const c = community(() => page);
    c.hasWay = () => page !== null;
    c.ipv6Only = () => ipv6Only;
    c.setStatus({ claimed: false, deviceReady: false, retryAt: null });
    // Only a link-local or a public IPv6 address: nothing to name, and still the screen can say what would help.
    expect(read()).toEqual({ v: 1, state: 'waiting', url: NO_ADDRESS_URL, ipv6Only: true });
    page = 'http://[fd00::20]:4480/';
    c.refresh();
    expect(read()).toMatchObject({ state: 'claimable', url: page, ipv6Only: true });
    ipv6Only = false;
    c.refresh();
    expect(read().ipv6Only).toBeUndefined();
    // Claimed, the screen names its address or the app: nothing about the network's addresses.
    ipv6Only = true;
    c.setStatus({ claimed: true, deviceReady: false, retryAt: null });
    expect(read().ipv6Only).toBeUndefined();
    expect(consoleStateValid({ state: 'claimed', ipv6Only: true })).toBe(false);
  });

  it('counts the exchanges a device began on the letters themselves, and goes at once when the box is claimed', () => {
    const c = community();
    c.setStatus({ claimed: false, deviceReady: false, retryAt: null });
    c.openWindow(now);
    const window = c.liveWindow(now);
    if (!window) throw new Error('no window');
    expect(c.windowBegin(window, 'a', 2)).toBe(true);
    expect(c.windowBegin(window, 'a', 2)).toBe(true);
    expect(c.windowBegin(window, 'a', 2)).toBe(false);
    expect(c.windowBegin(window, 'b', 2)).toBe(true);
    // One that couldn't be recorded gives the try back.
    c.windowUnbegin(window, 'a');
    expect(c.windowBegin(window, 'a', 2)).toBe(true);
    // New letters: a new count for everyone.
    c.openWindow(now);
    const next = c.liveWindow(now);
    expect(next && c.windowBegin(next, 'a', 2)).toBe(true);
    c.markClaimed();
    expect(c.liveWindow(now)).toBeNull();
    expect(c.codePassword(now)).toBeNull();
    expect(c.openWindow(now)).toBeNull();
    expect(read()).toMatchObject({ state: 'claimed' });
  });
});

describe('the console of a box that took Whombat Link at its first start (LNK-13)', () => {
  it('shows the claim link once its own address serves its page, the box’s page before that', () => {
    // No control registered it (community here), and it started with its own address only (A3).
    const cfg = { WHOMBAT_EDITION: 'community', WHOMBAT_CONSOLE_GROUP: 'whombat-console-test-none' };
    const s = { ...services(), config: cfg } as unknown as Services;
    useBoxPageAsApp(cfg as never, () => 'https://quiet-river-otter.box.whombat.test/');
    const c = new ClaimCeremony(s, file);
    let link: string | null = null;
    c.ownAddress = {
      local: () => true,
      url: () => link,
      alert: () => undefined,
      fallback: () => null,
      newLink: () => {},
    };
    c.setStatus({ claimed: false, deviceReady: false, retryAt: null });
    expect(read()).toMatchObject({ state: 'claimable', url: 'https://quiet-river-otter.box.whombat.test/' });
    link = 'https://quiet-river-otter.box.whombat.test/c/k7dq2mxw';
    c.refresh();
    expect(read()).toMatchObject({ state: 'claimable', url: link });
  });

  /** A box at its own address whose screen shows the claim link `link()`, with `other()` as its other way in. */
  function atOwnAddress(link: () => string, other: () => string | null, newLink: () => void = () => {}) {
    const cfg = { WHOMBAT_EDITION: 'community', WHOMBAT_CONSOLE_GROUP: 'whombat-console-test-none' };
    const s = { ...services(), config: cfg } as unknown as Services;
    useBoxPageAsApp(cfg as never, () => 'https://quiet-river-otter.box.whombat.test/');
    const c = new ClaimCeremony(s, file);
    c.ownAddress = { local: () => true, url: link, alert: () => undefined, fallback: other, newLink };
    c.setStatus({ claimed: false, deviceReady: false, retryAt: null });
    return c;
  }

  it('names another way in under the claim link, only while the letters show', () => {
    const link = 'https://quiet-river-otter.box.whombat.test/c/kxqmtv';
    let other: string | null = 'http://192.168.1.20:4480/';
    const c = atOwnAddress(
      () => link,
      () => other,
    );
    expect(read()).toMatchObject({ state: 'claimable', url: link, fallbackUrl: 'http://192.168.1.20:4480/' });
    // The Tailscale page when the box has one.
    other = 'https://whombat.tail1234.ts.net:4480/';
    c.refresh();
    expect(read().fallbackUrl).toBe(other);
    // Nothing to add: no other way, the same address twice, or one the file can't carry.
    for (const none of [null, link, 'ftp://192.168.1.20/', `http://${'a'.repeat(300)}/`]) {
      other = none;
      c.refresh();
      expect(read().fallbackUrl).toBeUndefined();
    }
    // In the wait after wrong tries the screen shows no address at all, and a claimed one never a way to claim.
    other = 'http://192.168.1.20:4480/';
    c.setRetryAt(new Date(now.getTime() + 60_000));
    expect(read()).toMatchObject({ state: 'backoff' });
    expect(read().fallbackUrl).toBeUndefined();
    c.markClaimed();
    expect(read().fallbackUrl).toBeUndefined();
    expect(consoleStateValid({ state: 'backoff', retryAt: 'x', fallbackUrl: other })).toBe(false);
    expect(consoleStateValid({ state: 'claimed', fallbackUrl: other })).toBe(false);
  });

  it('changes the claim link with new letters asked for at the box, on the same screen', () => {
    let secret = 'kxqmtv';
    let asked = 0;
    const c = atOwnAddress(
      () => `https://quiet-river-otter.box.whombat.test/c/${secret}`,
      () => null,
      () => {
        asked += 1;
        secret = 'pqrtvw';
      },
    );
    const before = read();
    expect(c.openWindow(now)).not.toBeNull();
    const after = read();
    expect(asked).toBe(1);
    expect(after.url).toBe('https://quiet-river-otter.box.whombat.test/c/pqrtvw');
    expect(after.code).not.toBe(before.code);
    // Nothing else changes it: a wrong try rotates the letters, the link stays as the screen showed it.
    c.failed('code');
    expect(read().url).toBe(after.url);
    expect(asked).toBe(1);
  });
});

describe('the console before the manager says how the box is reached', () => {
  it('says starting until Link’s first answer, then the claim screen; a claimed box shows claimed', () => {
    const cfg = { WHOMBAT_EDITION: 'community', WHOMBAT_CONSOLE_GROUP: 'whombat-console-test-none' };
    const s = { ...services(), config: cfg } as unknown as Services;
    useBoxPageAsApp(cfg as never, () => 'http://192.168.1.20:4480/');
    const c = new ClaimCeremony(s, file);
    let pending = true;
    c.reachPending = () => pending;
    c.setStatus({ claimed: false, deviceReady: false, retryAt: null });
    expect(read()).toMatchObject({ state: 'starting', url: 'http://192.168.1.20:4480/' });
    expect(read().code).toBeUndefined();
    pending = false;
    c.refresh();
    expect(read()).toMatchObject({ state: 'claimable' });
    pending = true;
    c.setStatus({ claimed: true, deviceReady: false, retryAt: null });
    expect(read()).toMatchObject({ state: 'claimed' });
  });
});

describe('the claim console', () => {
  it('goes starting → waiting → claimable, and shows the code only while a lease is live', () => {
    const c = new ClaimCeremony(services(), file);
    c.announceStarting();
    expect(read()).toEqual({ v: 1, state: 'starting', url: 'https://app.whombat.test/claim' });
    expect(statSync(file).mode & 0o777).toBe(0o640);
    // Provisioned but no lookup lease yet (control unreachable): no code.
    c.setStatus(ready);
    expect(read()).toEqual({ v: 1, state: 'waiting', url: 'https://app.whombat.test/claim' });
    expect(c.codePassword(now)).toBeNull();
    c.setLease(lease());
    const s = read();
    expect(s.state).toBe('claimable');
    expect(consoleStateValid(s)).toBe(true);
    // Only the four letters: the lookup number is never on the console (CC-13).
    const letters = s.code ?? '';
    expect(letters).toMatch(/^[A-Z]{4}$/);
    expect(normalizeClaimCode(letters)).toEqual({ kind: 'letters', letters });
    expect([...letters].every((l) => CLAIM_CODE_ALPHABET.includes(l))).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain('4821');
    expect(c.codePassword(now)).toEqual({ password: letters, generation: 0 });
    // A new number keeps the letters (and still doesn't show); clearing the lease takes the code off the console.
    c.setLease(lease('50123'));
    expect(read().code).toBe(letters);
    expect(readFileSync(file, 'utf8')).not.toContain('50123');
    c.setLease(null);
    expect(read().state).toBe('waiting');
    // Not provisioned: waiting even with a lease.
    c.setStatus({ ...ready, deviceReady: false });
    c.setLease(lease());
    expect(read().state).toBe('waiting');
    expect(c.codePassword(now)).toBeNull();
    // The file is replaced atomically: nothing but the file is left in the directory.
    expect(readdirSync(dir)).toEqual(['console.json']);
    c.close();
  });

  it('rotates the letters on a wrong code, shows the backoff, and comes back when it ends', () => {
    vi.useFakeTimers({ now });
    const c = new ClaimCeremony(services(), file);
    c.setStatus(ready);
    c.setLease(lease());
    const first = c.codePassword(now);
    // A wrong card secret: no rotation, but live begins end.
    c.failed('card', null);
    expect(c.codePassword(now)).toEqual({ password: first?.password, generation: 1 });
    // A wrong code: new letters at once.
    c.failed('code', null);
    const second = c.codePassword(now);
    expect(second?.generation).toBe(2);
    expect(read().code).toBe(second?.password);
    expect(second?.password).not.toBe(first?.password);
    // Backoff: the console says so; when it ends the file is written again by itself.
    const retryAt = new Date(now.getTime() + 60_000);
    c.failed('code', retryAt);
    expect(read()).toEqual({
      v: 1,
      state: 'backoff',
      url: 'https://app.whombat.test/claim',
      retryAt: retryAt.toISOString(),
    });
    now = new Date(now.getTime() + 61_000);
    vi.advanceTimersByTime(61_000);
    expect(read().state).toBe('claimable');
    c.close();
  });

  it('takes the code off the console when the lease runs out', () => {
    vi.useFakeTimers({ now });
    const c = new ClaimCeremony(services(), file);
    c.setStatus(ready);
    c.setLease(lease('4821', 10_000));
    expect(read().state).toBe('claimable');
    now = new Date(now.getTime() + 11_000);
    vi.advanceTimersByTime(11_000);
    expect(read().state).toBe('waiting');
    c.close();
  });

  it('claimed: the letters are gone, leases are ignored, and a stopping runtime leaves an unclaimed console at starting', () => {
    const c = new ClaimCeremony(services(), file);
    c.setStatus(ready);
    c.setLease(lease());
    c.setStatus({ claimed: true, deviceReady: true, retryAt: null });
    expect(read()).toEqual({ v: 1, state: 'claimed', url: 'https://app.whombat.test/claim' });
    expect(c.codePassword(now)).toBeNull();
    c.setLease(lease());
    expect(read().state).toBe('claimed');
    c.close();
    expect(read().state).toBe('claimed');

    const d = new ClaimCeremony(services(), file);
    d.setStatus(ready);
    d.setLease(lease());
    expect(read().state).toBe('claimable');
    d.close();
    expect(read().state).toBe('starting');
    expect(d.codePassword(now)).toBeNull();
  });

  it('shows the burrows only once claimed, and rewrites the file when they change (CT-116)', () => {
    const url = 'https://app.whombat.test/claim';
    const c = new ClaimCeremony(services(), file);
    c.setBurrows({ first: 'Dusty’s Burrow', more: 0 });
    c.setStatus(ready);
    c.setLease(lease());
    // Before the claim the console never names a burrow.
    expect(read().state).toBe('claimable');
    expect(read().burrows).toBeUndefined();
    c.setStatus({ claimed: true, deviceReady: true, retryAt: null });
    expect(read()).toEqual({ v: 1, state: 'claimed', url, burrows: { first: 'Dusty’s Burrow', more: 0 } });
    expect(consoleStateValid(read())).toBe(true);
    c.setBurrows({ first: 'Dusty HQ', more: 2 });
    expect(read().burrows).toEqual({ first: 'Dusty HQ', more: 2 });
    // The name is written as UTF-8 text, not escaped.
    expect(readFileSync(file, 'utf8')).toContain('"first":"Dusty HQ"');
    c.setBurrows(undefined);
    expect(read()).toEqual({ v: 1, state: 'claimed', url });
    c.close();
  });

  it('shows a screen sign-in only once claimed and until it runs out (BX-06)', () => {
    vi.useFakeTimers({ now });
    const url = 'https://app.whombat.test/claim';
    const signIn = {
      code: 'KXQMTR',
      name: 'Olive',
      device: 'Pixel 9',
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    };
    const raw = () => JSON.parse(readFileSync(file, 'utf8'));
    const c = new ClaimCeremony(services(), file);
    c.setStatus(ready);
    c.setLease(lease());
    c.setSignIn(signIn);
    expect(raw().signIn).toBeUndefined();
    expect(c.showsScreen).toBe(true);
    c.setStatus({ claimed: true, deviceReady: true, retryAt: null });
    expect(raw()).toEqual({ v: 1, state: 'claimed', url, signIn });
    // One the file can't carry is left out; the rest is still written.
    c.setSignIn({ ...signIn, name: 'Olive\u202e' });
    expect(raw()).toEqual({ v: 1, state: 'claimed', url });
    c.setSignIn(signIn);
    now = new Date(now.getTime() + 301_000);
    vi.advanceTimersByTime(301_000);
    expect(raw()).toEqual({ v: 1, state: 'claimed', url });
    c.close();
    expect(c.showsScreen).toBe(false);
    expect(new ClaimCeremony(services(), undefined).showsScreen).toBe(false);
    expect(new ClaimCeremony(services(null), file).showsScreen).toBe(false);
  });

  it('writes nothing without WHOMBAT_CONSOLE_FILE or WHOMBAT_APP_URL, and logs a failed write without the code', () => {
    const none = new ClaimCeremony(services(), undefined);
    none.setStatus(ready);
    none.setLease(lease());
    expect(none.codePassword(now)).not.toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    const noUrl = new ClaimCeremony(services(null), file);
    noUrl.setStatus(ready);
    expect(readdirSync(dir)).toEqual([]);
    const broken = new ClaimCeremony(services(), join(dir, 'missing', 'console.json'));
    broken.setStatus(ready);
    broken.setLease(lease());
    const letters = broken.codePassword(now)?.password ?? '';
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(letters);
    for (const c of [none, noUrl, broken]) c.close();
  });

  it('replaces an existing file in one rename', () => {
    writeConsoleFile(file, '{"old":true}\n', 'whombat-console-test-none');
    writeConsoleFile(file, '{"new":true}\n', 'whombat-console-test-none');
    expect(readFileSync(file, 'utf8')).toBe('{"new":true}\n');
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(['console.json']);
  });
});
