import { describe, expect, it } from 'vitest';
import { DEMO_QR } from '../demo/qr';
import { type ConsoleState, parseState, qrRows } from './api';
import {
  footerShown,
  linkScreen,
  linkShown,
  liveLinkCode,
  noAddressLine,
  reachNotes,
  waitingInApp,
} from './console';
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
    expect(s.reach?.tailscale).toEqual({
      loginUrl: 'login.tailscale.com/a/abc123',
      needsHttps: true,
      loginQr: [],
      first: false,
    });
  });

  it('reads the QR codes the server drew, and nothing else as one', () => {
    const qr = DEMO_QR['https://login.tailscale.com/a/1a2b3c4d5e6f7a'] ?? [];
    const s = con('claimable', {
      link: { ...CODE, qr: DEMO_QR['https://app.whombat.com/link?code=KXQM-TRVW'] },
      tailscale: { loginUrl: 'login.tailscale.com/a/abc123', loginQr: qr, first: true },
    });
    expect(s.reach?.link?.qr.length).toBe(29);
    expect(s.reach?.tailscale).toMatchObject({ loginQr: qr, first: true });
    // Not square, a size no QR code has, or other characters: no QR code, the words stay.
    for (const bad of [qr.slice(1), [...qr, qr[0]], qr.map((r) => r.replace('#', 'x')), 'qr', [1, 2]]) {
      expect(qrRows(bad)).toEqual([]);
    }
    expect(qrRows(qr)).toBe(qr);
    // A Link code that isn't live, or no sign-in link: no QR code either.
    expect(con('claimable', { link: { state: 'starting', qr } }).reach?.link?.qr).toEqual([]);
    expect(
      con('claimable', { tailscale: { needsHttps: true, loginQr: qr } }).reach?.tailscale?.loginQr,
    ).toEqual([]);
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

describe('the footer (the text console’s rule)', () => {
  const shown = (claim: string, reach?: unknown) => {
    const s = con(claim, reach);
    return footerShown(s, linkScreen(s, NOW));
  };

  it('gives way while the box is set up: the claim, and Link’s code or wait before the claim', () => {
    expect(shown('claimable')).toBe(false);
    expect(shown('backoff')).toBe(false);
    expect(shown('starting', { link: CODE })).toBe(false);
    expect(shown('waiting', { link: { ...CODE, waitingForAddress: true } })).toBe(false);
  });

  it('shows under every other screen, a claimed box’s Link code included', () => {
    expect(shown('starting')).toBe(true);
    expect(shown('waiting')).toBe(true);
    expect(shown('claimed')).toBe(true);
    expect(shown('claimed', { link: CODE })).toBe(true);
  });
});

describe('the notes above every claim screen', () => {
  it('are Tailscale’s sign-in and HTTPS, then Link’s grace or end, in the text console’s order', () => {
    const s = con('claimable', {
      link: { state: 'grace', graceEndsOn: '25 November' },
      tailscale: { loginUrl: 'login.tailscale.com/a/abc123', needsHttps: true },
    });
    expect(reachNotes(s)).toEqual([
      { kind: 'tailscaleLogin', url: 'login.tailscale.com/a/abc123', qr: [], first: false },
      { kind: 'tailscaleHttps', first: false },
      { kind: 'linkGrace', day: '25 November' },
    ]);
    // The first of two steps: only Tailscale's first note says “1 · ”.
    const first = (t: object) => reachNotes(con('claimable', { tailscale: { ...t, first: true } }));
    expect(
      first({ loginUrl: 'login.tailscale.com/a/abc123', needsHttps: true }).map(
        (n) => 'first' in n && n.first,
      ),
    ).toEqual([true, false]);
    expect(first({ needsHttps: true })).toEqual([{ kind: 'tailscaleHttps', first: true }]);
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

describe('Link on, the web address still coming', () => {
  /** A box with Link on and no address to open yet: the claim in the app on this network. */
  const onWaiting = (claim: object, reach: unknown = { link: { state: 'on', waitingForAddress: true } }) => {
    const s = parseState({
      mode: 'console',
      now: '2026-09-27T12:00:00Z',
      footer: '',
      claim: { state: 'claimable', code: 'EQMX', claimUrl: '', appUrl: '', inApp: '10.100.0.10', ...claim },
      desk: null,
      reach,
    });
    if (s?.mode !== 'console') throw new Error('not a console state');
    return s;
  };

  it('shows the wait in place of the claim, the app on this network under it', () => {
    const s = onWaiting({});
    expect(linkShown(s)).toBe(true);
    expect(linkScreen(s, NOW)).toBe('waiting');
    expect(waitingInApp(s)).toEqual({ address: '10.100.0.10', letters: 'EQMX' });
    // The same under Link's own wait for an address.
    expect(waitingInApp(onWaiting({}, { link: { state: 'starting', waitingForAddress: true } }))).toEqual({
      address: '10.100.0.10',
      letters: 'EQMX',
    });
  });

  it('names no other way without an address for the app or letters, and leaves other screens alone', () => {
    expect(waitingInApp(onWaiting({ inApp: undefined }))).toBeNull();
    expect(waitingInApp(onWaiting({ code: '' }))).toBeNull();
    expect(waitingInApp(onWaiting({}, { link: { state: 'starting' } }))).toBeNull();
    // `on` without the wait, or on a box that isn't claimable: the claim's own screen.
    expect(linkShown(onWaiting({}, { link: { state: 'on' } }))).toBe(false);
    expect(linkShown(onWaiting({ state: 'backoff', retryAt: '2026-09-27T12:05:00Z' }))).toBe(false);
  });
});

describe('the claim as the second step', () => {
  it('is read on a claim screen only', () => {
    const second = (state: string) =>
      parseState({ mode: 'console', now: '', footer: '', claim: { state, code: 'WADA', second: true } });
    expect(second('claimable')).toMatchObject({ claim: { second: true } });
    expect(second('claimed')).not.toHaveProperty('claim.second');
    expect(second('backoff')).not.toHaveProperty('claim.second');
  });
});
