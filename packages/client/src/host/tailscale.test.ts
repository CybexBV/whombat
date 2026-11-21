import { TAILSCALE_HEADSCALE, TAILSCALE_STATES_FIXTURE } from '@whombat/fixtures';
import { TAILSCALE_POLL_MS } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import {
  loginServerHost,
  readLoginServer,
  TAILSCALE_TEXT,
  tailscaleErrorText,
  tailscaleView,
} from './tailscale';
import { createFakeTailscale } from './tailscale-fake';

const S = TAILSCALE_STATES_FIXTURE;

describe('Tailscale on This Whombat (AP-5305)', () => {
  it('off: Turn on', () => {
    expect(tailscaleView({ tailscale: S.off })).toMatchObject({ dot: 'mut', actions: ['turn_on'] });
  });

  it('waiting for a sign-in: Tailscale’s own link, asked again while it waits', () => {
    const v = tailscaleView({ tailscale: S.needs_sign_in });
    expect(v).toMatchObject({ dot: 'warn', actions: ['sign_in', 'turn_off'], pollMs: TAILSCALE_POLL_MS });
    expect(v.loginUrl).toMatch(/^https:\/\/login\.tailscale\.com\//);
    expect(tailscaleView({ tailscale: S.starting }).pollMs).toBe(TAILSCALE_POLL_MS);
  });

  it('on: its name and tailnet, Turn off; without HTTPS it says what a browser needs', () => {
    const on = tailscaleView({ tailscale: S.on });
    expect(on).toMatchObject({ dot: 'ok', actions: ['turn_off'], pollMs: null });
    expect(on.title).toBe('On');
    expect(on.meta).toContain(S.on.name as string);
    expect(tailscaleView({ tailscale: { ...S.on, https: false } }).meta).toContain('HTTPS');
  });

  it('a problem in words; nothing on a development box; Try again when it didn’t answer', () => {
    expect(tailscaleView({ tailscale: S.error })).toMatchObject({ dot: 'bad' });
    expect(tailscaleView({ tailscale: null, reason: 'not_managed' }).hidden).toBe(true);
    expect(tailscaleView({ tailscale: null, reason: 'unavailable' }).actions).toEqual(['try_again']);
    expect(
      tailscaleErrorText(
        new OperationError('host.tailscale.on', 409, 'conflict', 'x', { code: 'tailscale.busy' }),
      ),
    ).toContain('busy');
  });

  it('the fake turns on, gives a link, comes on once signed in, and off again', () => {
    const t = createFakeTailscale();
    expect(t.call('host.tailscale.on', {})?.body).toMatchObject({
      tailscale: { state: 'needs_sign_in' },
    });
    t.signedIn();
    expect(t.status().state).toBe('on');
    t.call('host.tailscale.off', {});
    expect(t.status().state).toBe('off');
    expect(t.call('host.network', {})).toBeNull();
  });
});

describe('Tailscale’s own login server (AP-5404)', () => {
  it('signs in on the person’s own server, says where, and shows only a link on it', () => {
    const v = tailscaleView({ tailscale: TAILSCALE_HEADSCALE.needs_sign_in });
    expect(v.loginServer).toBe('https://hs.lumio.example.org');
    expect(v.loginUrl).toBe(TAILSCALE_HEADSCALE.needs_sign_in.loginUrl);
    expect(v.meta).toContain('hs.lumio.example.org');
    const elsewhere = tailscaleView({
      tailscale: { ...TAILSCALE_HEADSCALE.needs_sign_in, loginUrl: 'https://evil.example/register/x' },
    });
    expect(elsewhere.loginUrl).toBeNull();
    expect(elsewhere.actions).toEqual(['turn_off']);
  });

  it('reads a typed server: empty is Tailscale’s own, plain http is said, problems in words', () => {
    expect(readLoginServer('  ')).toEqual({ ok: true, value: null, plainHttp: false });
    expect(readLoginServer('HTTPS://HS.Example.org:8080/')).toEqual({
      ok: true,
      value: 'https://hs.example.org:8080',
      plainHttp: false,
    });
    expect(readLoginServer('http://10.0.0.5:8080')).toMatchObject({ ok: true, plainHttp: true });
    expect(readLoginServer('ftp://hs.example.org')).toEqual({
      ok: false,
      problem: TAILSCALE_TEXT.problems_server.scheme,
    });
    expect(loginServerHost('https://hs.lumio.example.org:8080/x')).toBe('hs.lumio.example.org');
  });

  it('the fake moves to another server with a fresh sign-in there, and keeps it', () => {
    const t = createFakeTailscale('on');
    const moved = t.call('host.tailscale.on', { loginServer: 'https://hs.lumio.example.org' })?.body as {
      tailscale: { state: string; loginUrl: string; loginServer?: string };
    };
    expect(moved.tailscale).toMatchObject({
      state: 'needs_sign_in',
      loginServer: 'https://hs.lumio.example.org',
    });
    expect(moved.tailscale.loginUrl.startsWith('https://hs.lumio.example.org/')).toBe(true);
    t.signedIn();
    expect(t.status()).toMatchObject({ state: 'on', loginServer: 'https://hs.lumio.example.org' });
    t.call('host.tailscale.off', {});
    expect(t.status().loginServer).toBe('https://hs.lumio.example.org');
    t.call('host.tailscale.on', { loginServer: null });
    expect(t.status().loginServer).toBeUndefined();
  });
});
