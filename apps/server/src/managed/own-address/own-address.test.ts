/**
 * The own address's pure parts (own-address.md): what the certificate watch calls foreign, the claim link's rotation
 * and its own counter, the notices' words and that they start on, and which kit envelopes count as stored.
 */
import { describe, expect, it } from 'vitest';
import { checkStartsOn } from '../../things/quiet/defaults';
import { storedOf } from '../backup-key';
import { CLAIM_LINK_PEERS, CLAIM_LINK_TRIES_PER_PEER, ClaimLink, newClaimLinkSecret } from './claim-link';
import { coversHost, foreignCertificates, UNCHECKED_AFTER_MS, uncheckedSince } from './ct';
import { DOOR_BUDGETS, OwnAddressDoor } from './door';
import { missedWindowsText, OWN_ADDRESS_CHECKS, OWN_ADDRESS_WORDS } from './notices';
import { summaryFailure } from './state';

const HOST = 'maple-otter-river.dev.whombat.app';
const cert = (spkiSha256: string, dnsNames: string[], notAfter = '2099-01-01T00:00:00Z') => ({
  id: '1',
  spkiSha256,
  dnsNames,
  notBefore: '2026-11-01T00:00:00Z',
  notAfter,
  issuer: 'R11',
});
const key = (c: string) => c.repeat(64);

describe('what is foreign', () => {
  it('covers the host, names under it and the zone’s wildcard, nothing wider', () => {
    expect(coversHost(HOST, HOST)).toBe(true);
    expect(coversHost(`a.b.${HOST}`, HOST)).toBe(true);
    expect(coversHost(`*.${HOST}`, HOST)).toBe(true);
    expect(coversHost('*.dev.whombat.app', HOST)).toBe(true);
    expect(coversHost('*.whombat.app', HOST)).toBe(false);
    expect(coversHost('dev.whombat.app', HOST)).toBe(false);
    expect(coversHost('other-otter-river.dev.whombat.app', HOST)).toBe(false);
    expect(coversHost(`x${HOST}`, HOST)).toBe(false);
  });

  it('is a certificate covering the host whose key isn’t the box’s own, one per key', () => {
    const own = new Set([key('a'), key('b')]);
    const found = foreignCertificates({
      host: HOST,
      own,
      certs: [
        cert(key('a'), [HOST]),
        cert(key('b'), [HOST]),
        cert(key('c'), ['*.whombat.app']),
        cert(key('d'), [`sub.${HOST}`, 'example.com'], '2027-01-01T00:00:00Z'),
        cert(key('d'), [`sub.${HOST}`], '2028-01-01T00:00:00Z'),
        cert(key('e'), ['*.dev.whombat.app']),
      ],
    });
    expect(found.map((f) => f.spkiSha256)).toEqual([key('d'), key('e')]);
    expect(found[0]).toMatchObject({ names: [`sub.${HOST}`], notAfter: '2028-01-01T00:00:00Z' });
  });

  it('counts two days without a fresh check, from the last one or from when checking began', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const recent = new Date(now.getTime() - UNCHECKED_AFTER_MS + 60_000).toISOString();
    const old = new Date(now.getTime() - UNCHECKED_AFTER_MS).toISOString();
    expect(uncheckedSince({ lastFreshAt: recent, checkingSince: '2026-01-01T00:00:00Z' }, now)).toBeNull();
    expect(uncheckedSince({ lastFreshAt: old, checkingSince: '2026-01-01T00:00:00Z' }, now)).toBe(old);
    expect(uncheckedSince({ lastFreshAt: null, checkingSince: old }, now)).toBe(old);
  });
});

/** A wrong link, a different one for each `i`: `z` is not in the claim alphabet, so none is ever the secret. */
const wrong = (i: number) =>
  `zzzz${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;

describe('the claim link', () => {
  it('is six letters of the claim alphabet in lower case', () => {
    for (let i = 0; i < 50; i += 1) expect(newClaimLinkSecret()).toMatch(/^[abcdefghjkmnpqrtvwxy]{6}$/);
  });

  it('is never changed by wrong tries, whoever makes them and however many', () => {
    const link = new ClaimLink(() => 0);
    const first = link.current;
    for (let peer = 0; peer < 50; peer += 1)
      for (let i = 0; i < CLAIM_LINK_TRIES_PER_PEER + 5; i += 1)
        expect(link.check(wrong(i), `203.0.113.${peer}`)).toBe(false);
    expect(link.current).toBe(first);
    // The person, at an address of their own, still gets in with the link from the screen.
    expect(link.check(first, '198.51.100.7')).toBe(true);
  });

  it('gives each visitor address its own tries: ten different wrong links in an hour, then none is read', () => {
    let now = 0;
    const link = new ClaimLink(() => now);
    const stranger = '203.0.113.7';
    expect(link.check(link.current, stranger)).toBe(true);
    for (let i = 0; i < CLAIM_LINK_TRIES_PER_PEER - 1; i += 1)
      expect(link.check(wrong(i), stranger)).toBe(false);
    // One try left: the right link is still read.
    expect(link.spent(stranger)).toBe(false);
    expect(link.check(link.current, stranger)).toBe(true);
    expect(link.check(wrong(CLAIM_LINK_TRIES_PER_PEER - 1), stranger)).toBe(false);
    // Used up: even the right link is refused unread from that address, and only from that one.
    expect(link.spent(stranger)).toBe(true);
    expect(link.check(link.current, stranger)).toBe(false);
    expect(link.check(link.current, '198.51.100.7')).toBe(true);
    // An hour after its first tries the address has them back.
    now += 3_600_000;
    expect(link.spent(stranger)).toBe(false);
    expect(link.check(link.current, stranger)).toBe(true);
  });

  it('counts the same wrong link once, and no link at all never', () => {
    const link = new ClaimLink(() => 0);
    const home = '198.51.100.7';
    // A page left open on an old link connects again and again.
    for (let i = 0; i < 100; i += 1) expect(link.check('zzzzzz', home)).toBe(false);
    for (let i = 0; i < 100; i += 1) expect(link.check(undefined, home)).toBe(false);
    expect(link.spent(home)).toBe(false);
    expect(link.check(link.current, home)).toBe(true);
  });

  it('changes only when asked to, and every address then starts again', () => {
    const link = new ClaimLink(() => 0);
    let told = 0;
    link.onRotate = () => {
      told += 1;
    };
    const first = link.current;
    const home = '198.51.100.7';
    for (let i = 0; i < CLAIM_LINK_TRIES_PER_PEER; i += 1) link.check(wrong(i), home);
    expect(link.spent(home)).toBe(true);
    // Wrong tries told nobody; a change does (the manager, so control never keeps a dead link).
    expect(told).toBe(0);
    link.rotate();
    expect(told).toBe(1);
    expect(link.current).not.toBe(first);
    expect(link.spent(home)).toBe(false);
    expect(link.check(first, home)).toBe(false);
    expect(link.check(link.current, home)).toBe(true);
  });

  it('remembers a bounded number of addresses, and forgetting one never costs another its tries', () => {
    const link = new ClaimLink(() => 0);
    const first = '203.0.113.1';
    for (let i = 0; i < CLAIM_LINK_TRIES_PER_PEER; i += 1) link.check(wrong(i), first);
    expect(link.spent(first)).toBe(true);
    for (let i = 0; i < CLAIM_LINK_PEERS; i += 1) link.check('zzzzzz', `peer-${i}`);
    // The one remembered longest made room.
    expect(link.spent(first)).toBe(false);
    expect(link.check(link.current, 'peer-5')).toBe(true);
  });
});

describe('the notices', () => {
  it('all start on', () => {
    for (const c of OWN_ADDRESS_CHECKS) expect(checkStartsOn(c.check)).toBe(true);
  });

  it('name the address in the foreign one and the dates of each missed window', () => {
    expect(OWN_ADDRESS_WORDS.foreignBody(HOST)).toContain(HOST);
    expect(missedWindowsText([{ from: '2026-11-10T00:00:00Z', to: '2026-11-11T06:00:00Z' }])).toEqual([
      'Whombat couldn’t check certificates from 10 November 2026 to 11 November 2026.',
    ]);
  });
});

describe('the door’s budgets', () => {
  it('keep web and acme apart, and refuse web while browsers may not open the address', () => {
    let open = true;
    const door = new OwnAddressDoor({
      accepts: () => ['web', 'acme'],
      web: () => {},
      webOpen: () => open,
      acmeSocket: '/nonexistent',
      log: { info() {}, warn() {} } as never,
      budgets: { web: 2, acme: 1 },
    });
    const a = door.admit('web');
    expect(door.admit('web')).not.toBeNull();
    expect(door.admit('web')).toBeNull();
    expect(door.admit('acme')).not.toBeNull();
    expect(door.admit('acme')).toBeNull();
    a?.();
    a?.();
    expect(door.counts).toEqual({ web: 1, acme: 1 });
    open = false;
    expect(door.admit('web')).toBeNull();
    expect(DOOR_BUDGETS).toEqual({ web: 64, acme: 8 });
  });
});

describe('kit envelopes stored', () => {
  const batch = [{ credentialId: 'a' }, { credentialId: 'b' }];
  it('are those control didn’t skip, and none when it doesn’t say which', () => {
    expect(storedOf(batch, { skipped: 0 })).toEqual(batch);
    expect(storedOf(batch, { skipped: 1, skippedCredentialIds: ['b'] })).toEqual([{ credentialId: 'a' }]);
    expect(storedOf(batch, { skipped: 1 })).toEqual([]);
  });
});

describe('why there is no certificate', () => {
  it('passes the manager’s reason and next try while it is failing, and nothing otherwise', () => {
    expect(
      summaryFailure({ state: 'failing', error: 'rate_limited', nextAttemptAt: '2026-11-22T14:05:00Z' }),
    ).toEqual({ reason: 'rate_limited', retryAt: '2026-11-22T14:05:00.000Z' });
    expect(summaryFailure({ state: 'failing', error: 'probe_failed' })).toEqual({
      reason: 'probe_failed',
      retryAt: null,
    });
    expect(summaryFailure({ state: 'ordering', error: 'rate_limited' })).toBeUndefined();
    expect(summaryFailure({ state: 'failing' })).toBeUndefined();
    expect(summaryFailure({ state: 'failing', error: 'Odd-Code' })).toBeUndefined();
  });
});
