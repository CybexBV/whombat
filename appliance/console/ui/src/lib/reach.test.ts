import { describe, expect, it } from 'vitest';
import { type ConsoleState, parseState } from './api';
import { linkScreen, linkShown, liveLinkCode, noAddressLine, reachNotes } from './console';
import type { DeskState } from './desk';
import { deskActive } from './deskScene';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const CODE = {
  state: 'starting',
  code: 'ABCD-EFGH',
  url: 'app.whombat.com/link',
  expiresAt: '2026-09-27T12:12:30Z',
};

/** The page's state for a server answer with this claim state and reach. */
const con = (claim: string, reach: unknown, desk: unknown = null): ConsoleState => {
  const s = parseState({
    mode: 'console',
    now: '2026-09-27T12:00:00Z',
    footer: '',
    claim: {
      state: claim,
      code: claim === 'claimable' ? 'KXQM' : undefined,
      claimUrl: 'app.whombat.com/claim',
    },
    desk,
    reach,
  });
  if (s?.mode !== 'console') throw new Error('not a console state');
  return s;
};

describe('the reach from the server (CG-404)', () => {
  it('reads Link and Tailscale as sent', () => {
    const s = con('claimable', {
      link: CODE,
      tailscale: { loginUrl: 'login.tailscale.com/a/abc123', needsHttps: true },
    });
    expect(s.reach?.link).toMatchObject({
      state: 'starting',
      code: 'ABCD-EFGH',
      url: 'app.whombat.com/link',
    });
    expect(s.reach?.tailscale).toEqual({ loginUrl: 'login.tailscale.com/a/abc123', needsHttps: true });
  });

  it('drops what it can’t show, part by part, and keeps the claim', () => {
    const s = con('claimable', {
      link: { state: 'starting', code: 'abcd-efgh', url: 'app.whombat.com/link' },
      tailscale: { loginUrl: 'javascript:alert(1)', needsHttps: 'yes' },
    });
    expect(s.reach?.link).toMatchObject({ state: 'starting', code: '', url: '' });
    expect(s.reach?.tailscale).toBeUndefined();
    expect(s.claim?.code).toBe('KXQM');
    // A code without its page means nothing; a newer state and markup are left out.
    expect(con('claimable', { link: { state: 'starting', code: 'ABCD-EFGH' } }).reach?.link?.code).toBe('');
    expect(con('claimable', { link: { state: 'paused' } }).reach).toBeUndefined();
    expect(con('claimable', { tailscale: { loginUrl: '<img src=x>' } }).reach).toBeUndefined();
    expect(con('claimable', 'on').reach).toBeUndefined();
  });
});

describe('the Link screen in place of the claim (the text console’s rule)', () => {
  it('shows the code, waiting for an address, or starting on an unclaimed box', () => {
    expect(linkScreen(con('claimable', { link: CODE }), NOW)).toBe('code');
    expect(linkScreen(con('waiting', { link: CODE }), NOW)).toBe('code');
    expect(linkScreen(con('claimable', { link: { ...CODE, waitingForAddress: true } }), NOW)).toBe('waiting');
    expect(linkScreen(con('claimable', { link: { state: 'starting' } }), NOW)).toBe('starting');
  });

  it('on a claimed box only while there is a code to type', () => {
    expect(linkScreen(con('claimed', { link: CODE }), NOW)).toBe('code');
    expect(
      linkScreen(con('claimed', { link: { state: 'starting', waitingForAddress: true } }), NOW),
    ).toBeNull();
    expect(linkScreen(con('claimed', { link: { state: 'starting' } }), NOW)).toBeNull();
  });

  it('lets the code go once it expired, before the next poll', () => {
    const s = con('claimable', { link: CODE });
    const l = s.reach?.link;
    if (!l) throw new Error('no link');
    expect(liveLinkCode(l, NOW)).toBe('ABCD-EFGH');
    expect(liveLinkCode(l, Date.parse('2026-09-27T12:12:30Z'))).toBe('');
    expect(linkScreen(s, Date.parse('2026-09-27T12:13:00Z'))).toBe('starting');
    expect(linkScreen(con('claimed', { link: CODE }), Date.parse('2026-09-27T12:13:00Z'))).toBeNull();
  });

  it('shows nothing for grace, ended or no Link', () => {
    expect(linkShown(con('claimed', { link: { state: 'grace', graceEndsOn: '25 November' } }))).toBe(false);
    expect(linkScreen(con('claimable', { link: { state: 'ended' } }), NOW)).toBeNull();
    expect(linkScreen(con('claimable', undefined), NOW)).toBeNull();
  });

  it('keeps the desk aside while a Link code shows, as for a claim code', () => {
    // deskActive reads only whether the screen is paired or pairing.
    const paired = { paired: { name: 'Hall' }, pairing: null } as unknown as DeskState;
    expect(deskActive({ ...con('claimed', { link: CODE }), desk: paired })).toBe(false);
    expect(
      deskActive({
        ...con('claimed', { link: { state: 'starting', waitingForAddress: true } }),
        desk: paired,
      }),
    ).toBe(true);
    expect(deskActive({ ...con('claimed', { link: { state: 'ended' } }), desk: paired })).toBe(true);
  });
});

describe('the notes above every claim screen', () => {
  it('are Tailscale’s sign-in and HTTPS, then Link’s grace or end, in the text console’s order', () => {
    const s = con('claimable', {
      link: { state: 'grace', graceEndsOn: '25 November' },
      tailscale: { loginUrl: 'login.tailscale.com/a/abc123', needsHttps: true },
    });
    expect(reachNotes(s)).toEqual([
      { kind: 'tailscaleLogin', url: 'login.tailscale.com/a/abc123' },
      { kind: 'tailscaleHttps' },
      { kind: 'linkGrace', day: '25 November' },
    ]);
    expect(reachNotes(con('claimed', { link: { state: 'ended' } }))).toEqual([{ kind: 'linkEnded' }]);
    expect(reachNotes(con('claimed', { link: { state: 'grace' } }))).toEqual([]);
    expect(reachNotes(con('claimed', undefined))).toEqual([]);
  });
});

describe('the claim line without an address to open', () => {
  it('names only Tailscale’s steps while Tailscale asks for them, else either way to an address', () => {
    expect(noAddressLine(con('claimable', { tailscale: { loginUrl: 'login.tailscale.com/a/abc123' } }))).toBe(
      'claimAfterTailscale',
    );
    expect(noAddressLine(con('claimable', { tailscale: { needsHttps: true } }))).toBe('claimAfterHttps');
    expect(noAddressLine(con('claimable', { link: { state: 'off' } }))).toBe('claimNoAddress');
    expect(noAddressLine(con('claimable', undefined))).toBe('claimNoAddress');
  });
});
