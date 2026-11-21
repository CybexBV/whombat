import { GOOGLE_SCOPES, googleScopesFor } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { checkGoogleServices, fakeGoogleChecks, GOOGLE_CHECK_URLS } from './checks';
import { currentReturnPath, withParam } from './connect';
import { consoleLink, type FetchLike, googleApiError, googleFetch } from './google-http';
import { codeChallengeS256, FakeGoogleOAuth, newCodeVerifier, RealGoogleOAuth } from './oauth';
import { authorizedDomainOf } from './setup';
import { invalidGrantReason } from './tokens';
import { GoogleOAuthError } from './types';

const app = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-s',
  userType: null,
  source: 'settings' as const,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch that answers from a table of `url prefix → response` and records every call. */
function mockFetch(routes: [string, () => Response][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const hit = routes.find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    return hit[1]();
  });
  return { fn, calls };
}

const DISABLED = {
  error: {
    code: 403,
    message:
      'Gmail API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123 then retry.',
    status: 'PERMISSION_DENIED',
    errors: [{ reason: 'accessNotConfigured', message: '…' }],
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'SERVICE_DISABLED',
        domain: 'googleapis.com',
        metadata: {
          service: 'gmail.googleapis.com',
          activationUrl:
            'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123',
        },
      },
    ],
  },
};

describe('PKCE', () => {
  it('makes an 86-character verifier and its S256 challenge (RFC 7636 appendix B)', () => {
    expect(newCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('RealGoogleOAuth', () => {
  it('builds the consent URL with offline access, consent, granted scopes and PKCE S256', () => {
    const oauth = new RealGoogleOAuth(mockFetch([]).fn);
    const url = new URL(
      oauth.authorizeUrl({
        app,
        redirectUri: 'https://whombat.example/api/v1/connectors/google/callback',
        scopes: googleScopesFor(['mail', 'calendar']),
        state: 'oas_abc',
        codeChallenge: 'challenge',
        loginHint: 'mara@gmail.com',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: app.clientId,
      redirect_uri: 'https://whombat.example/api/v1/connectors/google/callback',
      response_type: 'code',
      scope: `openid email profile ${GOOGLE_SCOPES.mail} ${GOOGLE_SCOPES.calendar}`,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: 'oas_abc',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      login_hint: 'mara@gmail.com',
    });
  });

  it('exchanges a code with the verifier and reads the token response', async () => {
    const now = new Date('2026-09-24T10:00:00Z');
    const { fn, calls } = mockFetch([
      [
        'https://oauth2.googleapis.com/token',
        () =>
          json(200, {
            access_token: 'ya29.a',
            expires_in: 3599,
            refresh_token: '1//r',
            scope: `openid ${GOOGLE_SCOPES.mail} email`,
            token_type: 'Bearer',
          }),
      ],
    ]);
    const tokens = await new RealGoogleOAuth(fn, () => now).exchangeCode({
      app,
      code: '4/code',
      codeVerifier: 'verifier',
      redirectUri: 'https://w.example/cb',
    });
    expect(tokens).toEqual({
      accessToken: 'ya29.a',
      expiresAt: new Date(now.getTime() + 3599_000),
      refreshToken: '1//r',
      scopes: ['openid', GOOGLE_SCOPES.mail, 'email'],
    });
    const form = new URLSearchParams(String(calls[0]?.init?.body));
    expect(calls[0]?.init?.method).toBe('POST');
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: '4/code',
      code_verifier: 'verifier',
      redirect_uri: 'https://w.example/cb',
      client_id: app.clientId,
      client_secret: 'GOCSPX-s',
    });
  });

  it('turns Google’s invalid_grant into GoogleOAuthError(invalid_grant)', async () => {
    const { fn } = mockFetch([
      [
        'https://oauth2.googleapis.com/token',
        () => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      ],
    ]);
    const err = await new RealGoogleOAuth(fn).refresh({ app, refreshToken: '1//r' }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect(err.code).toBe('invalid_grant');
    expect(err.status).toBe(400);
  });

  it('maps invalid_client, other errors and network failures', async () => {
    const bad = mockFetch([
      ['https://oauth2.googleapis.com/token', () => json(401, { error: 'invalid_client' })],
    ]);
    expect((await new RealGoogleOAuth(bad.fn).refresh({ app, refreshToken: 'r' }).catch((e) => e)).code).toBe(
      'invalid_client',
    );
    const odd = mockFetch([
      ['https://oauth2.googleapis.com/token', () => new Response('<html>', { status: 500 })],
    ]);
    expect((await new RealGoogleOAuth(odd.fn).refresh({ app, refreshToken: 'r' }).catch((e) => e)).code).toBe(
      'other',
    );
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect((await new RealGoogleOAuth(down).refresh({ app, refreshToken: 'r' }).catch((e) => e)).code).toBe(
      'network',
    );
  });

  it('revokes at oauth2.googleapis.com/revoke, and an already-dead token is fine', async () => {
    const { fn, calls } = mockFetch([
      ['https://oauth2.googleapis.com/revoke', () => json(400, { error: 'invalid_token' })],
    ]);
    await new RealGoogleOAuth(fn).revoke('1//r');
    expect(String(calls[0]?.init?.body)).toBe('token=1%2F%2Fr');
  });
});

describe('googleFetch', () => {
  it('only ever calls Google’s hosts', async () => {
    const { fn } = mockFetch([['https://', () => json(200, {})]]);
    await expect(googleFetch(fn, 'https://evil.example/token')).rejects.toThrow(/isn’t Google’s/);
    await expect(googleFetch(fn, 'http://oauth2.googleapis.com/token')).rejects.toThrow();
    await expect(googleFetch(fn, 'https://oauth2.googleapis.com.evil.example/')).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
    await googleFetch(fn, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('googleApiError', () => {
  it('keeps the activation link of a turned-off API', () => {
    const err = googleApiError(403, DISABLED);
    expect(err.reason).toBe('api_disabled');
    expect(err.enableUrl).toBe(
      'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123',
    );
  });

  it('finds the link in the Help details or the message when ErrorInfo has none', () => {
    const help = googleApiError(403, {
      error: {
        message: 'Google Calendar API has not been used in project 9 before or it is disabled.',
        errors: [{ reason: 'accessNotConfigured' }],
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.Help',
            links: [
              {
                url: 'https://console.cloud.google.com/apis/api/calendar-json.googleapis.com/overview?project=9',
              },
            ],
          },
        ],
      },
    });
    expect(help.enableUrl).toContain('calendar-json.googleapis.com');
    const text = googleApiError(403, {
      error: {
        message:
          'People API has not been used in project 9 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=9 then retry.',
      },
    });
    expect(text.reason).toBe('api_disabled');
    expect(text.enableUrl).toBe(
      'https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=9',
    );
  });

  it('never keeps a link off Google’s console', () => {
    expect(consoleLink('https://evil.example/apis')).toBeNull();
    expect(consoleLink('javascript:alert(1)')).toBeNull();
    const err = googleApiError(403, {
      error: {
        errors: [{ reason: 'accessNotConfigured' }],
        details: [{ metadata: { activationUrl: 'https://evil.example/' } }],
      },
    });
    expect(err.reason).toBe('api_disabled');
    expect(err.enableUrl).toBeNull();
  });

  it('tells a missing scope, a dead token and other errors apart', () => {
    expect(googleApiError(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }).reason).toBe(
      'no_scope',
    );
    expect(
      googleApiError(403, { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }).reason,
    ).toBe('no_scope');
    expect(googleApiError(401, { error: { message: 'Invalid Credentials' } }).reason).toBe('unauthorized');
    expect(googleApiError(429, null).reason).toBe('rate_limited');
    expect(googleApiError(500, null).message).toBe('Google answered 500.');
  });
});

describe('service checks', () => {
  const all = googleScopesFor(['mail', 'calendar', 'files', 'docs', 'sheets', 'contacts']);

  it('makes one cheap call per service, Docs and Sheets riding on Drive’s', async () => {
    const { fn, calls } = mockFetch([
      [GOOGLE_CHECK_URLS.mail, () => json(403, DISABLED)],
      [GOOGLE_CHECK_URLS.calendar, () => json(200, { items: [] })],
      [GOOGLE_CHECK_URLS.files, () => json(200, { user: {} })],
      [GOOGLE_CHECK_URLS.contacts, () => json(500, { error: { message: 'Backend Error' } })],
    ]);
    const checks = await checkGoogleServices(
      'ya29.a',
      ['contacts', 'sheets', 'docs', 'files', 'calendar', 'mail'],
      all,
      fn,
    );
    expect(checks).toEqual([
      {
        service: 'mail',
        state: 'api_disabled',
        enableUrl: 'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123',
      },
      { service: 'calendar', state: 'ok' },
      { service: 'files', state: 'ok' },
      { service: 'docs', state: 'ok' },
      { service: 'sheets', state: 'ok' },
      { service: 'contacts', state: 'error', message: 'Backend Error' },
    ]);
    expect(calls.map((c) => c.url).sort()).toEqual(Object.values(GOOGLE_CHECK_URLS).sort());
    for (const c of calls) expect(new Headers(c.init?.headers).get('authorization')).toBe('Bearer ya29.a');
  });

  it('marks services whose scope wasn’t granted without calling Google', async () => {
    const { fn } = mockFetch([]);
    const checks = await checkGoogleServices('t', ['mail', 'docs'], googleScopesFor(['docs']), fn);
    expect(checks).toEqual([
      { service: 'mail', state: 'no_scope' },
      { service: 'docs', state: 'ok' },
    ]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports a network failure as an error', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const [check] = await checkGoogleServices('t', ['mail'], all, down);
    expect(check).toMatchObject({ service: 'mail', state: 'error' });
    expect(check?.message).toContain('Couldn’t reach Google');
  });

  it('the fake checks scopes only', () => {
    expect(fakeGoogleChecks(['mail', 'files'], googleScopesFor(['mail']))).toEqual([
      { service: 'mail', state: 'ok' },
      { service: 'files', state: 'no_scope' },
    ]);
  });
});

describe('FakeGoogleOAuth', () => {
  it('skips Google: the consent URL is the callback, and the code grants what was asked for', async () => {
    const fake = new FakeGoogleOAuth();
    const url = new URL(
      fake.authorizeUrl({
        app,
        redirectUri: 'http://localhost:5180/api/v1/connectors/google/callback',
        scopes: googleScopesFor(['mail']),
        state: 'oas_x',
        codeChallenge: 'c',
      }),
    );
    expect(url.pathname).toBe('/api/v1/connectors/google/callback');
    expect(url.searchParams.get('state')).toBe('oas_x');
    const tokens = await fake.exchangeCode({ code: url.searchParams.get('code') ?? '' });
    expect(tokens.scopes).toEqual(googleScopesFor(['mail']));
    expect(tokens.refreshToken).toMatch(/^fake-refresh-/);
    expect(await fake.userinfo()).toEqual({ sub: 'fake-google-you', email: 'you@example.com', name: 'You' });
    await fake.revoke(tokens.refreshToken ?? '');
    await expect(fake.refresh({ refreshToken: tokens.refreshToken ?? '' })).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });
});

describe('invalidGrantReason', () => {
  const granted = new Date('2026-09-01T00:00:00Z');
  const days = (n: number) => new Date(granted.getTime() + n * 86_400_000);

  it('is testing_expired only for a 6–8 day old grant of an app that isn’t internal', () => {
    expect(invalidGrantReason(granted, days(7), 'external')).toBe('testing_expired');
    expect(invalidGrantReason(granted, days(6), null)).toBe('testing_expired');
    expect(invalidGrantReason(granted, days(8), 'external')).toBe('testing_expired');
    expect(invalidGrantReason(granted, days(7), 'internal')).toBe('revoked');
    expect(invalidGrantReason(granted, days(2), 'external')).toBe('revoked');
    expect(invalidGrantReason(granted, days(30), 'external')).toBe('revoked');
  });
});

describe('setup facts', () => {
  it('authorizes the registrable domain of PUBLIC_URL’s host', () => {
    expect(authorizedDomainOf('dev.whombat.com')).toBe('whombat.com');
    expect(authorizedDomainOf('whombat.com')).toBe('whombat.com');
    expect(authorizedDomainOf('app.example.co.uk')).toBe('example.co.uk');
    expect(authorizedDomainOf('localhost')).toBe('localhost');
    expect(authorizedDomainOf('127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('withParam', () => {
  it('never leaves this Whombat, whatever the stored path normalizes to (IN-19)', () => {
    for (const path of ['/.//evil.com', '/a/..//evil.com', '/%2e//evil.com', '//evil.com'])
      expect(withParam(path, 'connected', 'google', '/burrow-hq/settings?tab=connections')).toBe(
        '/burrow-hq/settings?tab=connections&connected=google',
      );
    expect(withParam('/.//evil.com', 'connect_error', 'no_app')).toBe('/?connect_error=no_app');
  });
});

describe('currentReturnPath', () => {
  it('takes an old connect card back to the Chat with its thread open', () => {
    expect(currentReturnPath('/moss-co/dm/dusty?guide=msg_card1')).toBe(
      '/moss-co/chat?guide=msg_card1&thread=msg_card1',
    );
    expect(currentReturnPath('/moss-co/dm/dusty')).toBe('/moss-co/chat');
    for (const path of [
      '/moss-co/chat?thread=msg_root&guide=msg_card1',
      '/burrow-hq/settings?tab=connections',
      '//evil.com/dm/x',
    ])
      expect(currentReturnPath(path)).toBe(path);
  });
});
