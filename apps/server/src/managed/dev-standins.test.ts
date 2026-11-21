import { describe, expect, it } from 'vitest';
import { StandInTailscale, standInAnswer } from './dev-standins';

describe('the development stand-in’s Tailscale (HE-S236)', () => {
  it('shows a login link on the person’s login server, signs itself in a little later, and turns off', () => {
    let now = 0;
    const ts = new StandInTailscale(() => now, 5_000);
    expect(ts.status().state).toBe('off');
    const hs = 'http://hs.home.test:8080';
    expect(ts.on({ loginServer: hs })).toMatchObject({
      state: 'needs_sign_in',
      loginServer: hs,
      loginUrl: `${hs}/register/nodekey:whombatdev`,
    });
    now = 5_000;
    expect(ts.status()).toMatchObject({ state: 'on', https: false, loginServer: hs });
    expect(ts.off({ signOut: true }).state).toBe('off');
    expect(ts.on({}).loginUrl).toBe('https://login.tailscale.com/a/whombatdev');
  });

  it('answers the manager’s Tailscale paths with that state, and no certificate', () => {
    const ts = new StandInTailscale(() => 0);
    expect(standInAnswer('/v1/tailscale/on', {}, ts)).toMatchObject({
      status: 200,
      body: { tailscale: { state: 'needs_sign_in' } },
    });
    expect(standInAnswer('/v1/tailscale/cert', {}, ts)).toMatchObject({ status: 409 });
  });
});

describe('the development stand-in’s own address (own-address.md)', () => {
  it('has none, so a development box stays outside A3 and draws no label', () => {
    expect(standInAnswer('/v1/own-address/state')).toEqual({
      status: 200,
      body: { v: 1, enabled: false, acme: { state: 'idle' } },
    });
    expect(standInAnswer('/v1/own-address/register', { v: 1, label: 'maple-otter-river' })).toMatchObject({
      status: 404,
    });
  });
});
