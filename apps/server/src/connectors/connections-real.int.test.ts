/**
 * Connectors with the real Google adapter (docs/decisions/connectors.md CN-02…CN-06) and Google's answers
 * played by a stubbed `fetch`: the consent URL, the code exchange with the PKCE verifier, checks with a
 * turned-off API, `no_app`, refresh and `invalid_grant`, disconnect. Also the app set in config (read-only).
 */
import { type AnyEndpoint, api, buildPath, GOOGLE_SCOPES, googleScopesFor } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { connections, oauthStates, principals } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { type TestServer, useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { GOOGLE_CHECK_URLS } from './checks';
import { codeChallengeS256 } from './oauth';
import { GOOGLE_HOSTS } from './types';

/** The hosted UI: Google's redirect lands there, and it hands what Google sent over the session (AG-14). */
const APP_URL = 'https://whombat.example';
const REDIRECT = `${APP_URL}/connect/google`;
const CLIENT_ID = '99887766-real.apps.googleusercontent.com';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Handler = (url: string, init?: RequestInit) => Response;

/** Stubs the global `fetch` with Google's answers; returns every call. */
function playGoogle(handlers: Record<string, Handler>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(handlers).find((prefix) => url.startsWith(prefix));
      if (!key) throw new Error(`unexpected fetch ${url}`);
      return (handlers[key] as Handler)(url, init);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const DISABLED = {
  error: {
    code: 403,
    message: 'Gmail API has not been used in project 42 before or it is disabled.',
    errors: [{ reason: 'accessNotConfigured' }],
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'SERVICE_DISABLED',
        metadata: {
          activationUrl:
            'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=42',
        },
      },
    ],
  },
};

function helpers(t: TestServer) {
  const cookies = { mara: '' };
  let account = '';
  beforeAll(async () => {
    cookies.mara = (await sessionFor(t.services, IDS.mara)).cookie;
    const [row] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    account = row?.accountId ?? '';
  });
  async function call(
    ep: AnyEndpoint,
    opts: { params?: Record<string, string>; body?: unknown; cookie?: string } = {},
  ) {
    const res = await t.api.inject({
      method: ep.method,
      url: `${ep.base}${buildPath(ep.path, opts.params ?? {})}`,
      headers: { cookie: opts.cookie ?? cookies.mara },
      ...(opts.body === undefined ? {} : { payload: opts.body as object }),
    });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  }
  async function start(services: string[] = ['mail', 'calendar']) {
    const res = await call(api.connections.startGoogle, {
      body: { services, returnTo: '/burrow-hq/settings?tab=connections' },
    });
    return res;
  }
  /** What Google put on the redirect, handed over the session (`connections.finishGoogle`): where to go next. */
  async function callback(query: { code?: string; state: string; error?: string }) {
    const res = await call(api.connections.finishGoogle, { body: query });
    expect(res.status).toBe(200);
    return String(res.body.returnPath);
  }
  async function connection() {
    const [row] = await t.services.db.select().from(connections).where(eq(connections.accountId, account));
    return row;
  }
  return { cookies, call, start, callback, connection, account: () => account };
}

describe('the real adapter, Google played by fetch', () => {
  const t = useTestServer({
    seed: true,
    app: true,
    env: { WHOMBAT_GOOGLE: 'real', WHOMBAT_APP_URL: APP_URL },
  });
  const h = helpers(t);

  const tokenOk =
    (access: string, refresh: string | null = '1//refresh-a') =>
    () =>
      json(200, {
        access_token: access,
        expires_in: 3599,
        ...(refresh ? { refresh_token: refresh } : {}),
        scope: ['openid', 'email', 'profile', GOOGLE_SCOPES.mail, GOOGLE_SCOPES.calendar].join(' '),
      });

  it('refuses to start before Google is set up', async () => {
    const res = await h.start();
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('isn’t set up');
  });

  it('builds Google’s consent URL with PKCE for the stored verifier', async () => {
    const saved = await h.call(api.connectors.setGoogleApp, {
      body: { clientId: CLIENT_ID, clientSecret: 'GOCSPX-real', userType: 'internal' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.google.setup).toMatchObject({
      redirectUri: REDIRECT,
      authorizedDomain: 'whombat.example',
    });
    const res = await h.start();
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.host).toBe('accounts.google.com');
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: googleScopesFor(['mail', 'calendar']).join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge_method: 'S256',
    });
    const [state] = await t.services.db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.id, q.state ?? ''));
    expect(q.code_challenge).toBe(codeChallengeS256(state?.codeVerifier ?? ''));
  });

  it('exchanges the code, reads the account and checks each service', async () => {
    const res = await h.start();
    const state = new URL(res.body.authorizeUrl).searchParams.get('state') ?? '';
    const [row] = await t.services.db.select().from(oauthStates).where(eq(oauthStates.id, state));
    const calls = playGoogle({
      'https://oauth2.googleapis.com/token': tokenOk('ya29.first'),
      'https://openidconnect.googleapis.com/v1/userinfo': () =>
        json(200, { sub: '1170001', email: 'mara.oduya@gmail.com', name: 'Mara Oduya' }),
      [GOOGLE_CHECK_URLS.mail]: () => json(403, DISABLED),
      [GOOGLE_CHECK_URLS.calendar]: () => json(200, { items: [] }),
    });
    expect(await h.callback({ code: '4/0Aabc', state })).toBe(
      '/burrow-hq/settings?tab=connections&connected=google',
    );

    const form = new URLSearchParams(String(calls[0]?.init?.body));
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: 'authorization_code',
      code: '4/0Aabc',
      code_verifier: row?.codeVerifier,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: 'GOCSPX-real',
    });
    for (const c of calls) expect(GOOGLE_HOSTS).toContain(new URL(c.url).hostname);
    for (const c of calls.slice(2))
      expect(new Headers(c.init?.headers).get('authorization')).toBe('Bearer ya29.first');

    const status = await h.call(api.connectors.status);
    expect(status.body.connections[0]).toMatchObject({
      email: 'mara.oduya@gmail.com',
      name: 'Mara Oduya',
      services: ['mail', 'calendar'],
      status: 'active',
      checks: [
        {
          service: 'mail',
          state: 'api_disabled',
          enableUrl:
            'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=42',
        },
        { service: 'calendar', state: 'ok' },
      ],
    });
    expect(status.body.google.tested).toBe(true);
    expect((await h.connection())?.externalId).toBe('1170001');
  });

  it('“Check again” runs the checks with the stored token', async () => {
    const row = await h.connection();
    playGoogle({
      [GOOGLE_CHECK_URLS.mail]: () => json(200, { emailAddress: 'mara.oduya@gmail.com' }),
      [GOOGLE_CHECK_URLS.calendar]: () => json(200, { items: [] }),
    });
    const res = await h.call(api.connections.check, { params: { connectionId: row?.id ?? '' } });
    expect(res.body.checks).toEqual([
      { service: 'mail', state: 'ok' },
      { service: 'calendar', state: 'ok' },
    ]);
  });

  it('a failed exchange and a removed app come back as connect_error', async () => {
    let state = new URL((await h.start()).body.authorizeUrl).searchParams.get('state') ?? '';
    playGoogle({ 'https://oauth2.googleapis.com/token': () => json(400, { error: 'invalid_grant' }) });
    expect(await h.callback({ code: 'bad', state })).toContain('connect_error=exchange_failed');

    state = new URL((await h.start()).body.authorizeUrl).searchParams.get('state') ?? '';
    playGoogle({ 'https://oauth2.googleapis.com/token': tokenOk('ya29.x', null) });
    expect(await h.callback({ code: 'no-refresh', state })).toContain('connect_error=exchange_failed');

    state = new URL((await h.start()).body.authorizeUrl).searchParams.get('state') ?? '';
    expect(await t.services.db.select().from(connections)).toHaveLength(1);
    await h.call(api.connectors.removeGoogleApp);
    expect(await h.callback({ code: '4/x', state })).toBe(
      '/burrow-hq/settings?tab=connections&connect_error=no_app',
    );
    expect((await h.connection())?.status).toBe('needs_reauth');
  });

  it('refreshes through Google, and an internal app’s invalid_grant reads revoked', async () => {
    await h.call(api.connectors.setGoogleApp, {
      body: { clientId: CLIENT_ID, clientSecret: 'GOCSPX-real', userType: 'internal' },
    });
    const state = new URL((await h.start()).body.authorizeUrl).searchParams.get('state') ?? '';
    playGoogle({
      'https://oauth2.googleapis.com/token': tokenOk('ya29.second', '1//refresh-b'),
      'https://openidconnect.googleapis.com/v1/userinfo': () =>
        json(200, { sub: '1170001', email: 'mara.oduya@gmail.com', name: 'Mara Oduya' }),
      'https://gmail.googleapis.com/': () => json(200, {}),
      'https://www.googleapis.com/': () => json(200, {}),
    });
    expect(await h.callback({ code: '4/y', state })).toContain('connected=google');
    const row = await h.connection();
    await t.services.db
      .update(connections)
      .set({ accessExpiresAt: new Date(Date.now() + 10_000) })
      .where(eq(connections.id, row?.id ?? ''));

    const calls = playGoogle({ 'https://oauth2.googleapis.com/token': tokenOk('ya29.third', null) });
    expect(await t.services.google.tokens.accessFor(h.account(), 'google')).toBe('ya29.third');
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init?.body)))).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: '1//refresh-b',
      client_id: CLIENT_ID,
    });
    expect(await t.services.google.tokens.accessFor(h.account(), 'google')).toBe('ya29.third');
    expect(calls).toHaveLength(1);

    await t.services.db
      .update(connections)
      .set({ accessExpiresAt: new Date(Date.now() - 1), grantedAt: new Date(Date.now() - 7 * 86_400_000) })
      .where(eq(connections.id, row?.id ?? ''));
    playGoogle({ 'https://oauth2.googleapis.com/token': () => json(400, { error: 'invalid_grant' }) });
    await expect(t.services.google.tokens.accessFor(h.account(), 'google')).rejects.toMatchObject({
      reason: 'needs_reauth',
    });
    expect(await h.connection()).toMatchObject({ status: 'needs_reauth', reauthReason: 'revoked' });
  });

  it('disconnect revokes at Google, and forgets the connection even when Google fails', async () => {
    const row = await h.connection();
    const calls = playGoogle({ 'https://oauth2.googleapis.com/revoke': () => json(503, {}) });
    const res = await h.call(api.connections.remove, { params: { connectionId: row?.id ?? '' } });
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(String(calls[0]?.init?.body)).toBe(`token=${encodeURIComponent('1//refresh-b')}`);
    expect(await h.connection()).toBeUndefined();
  });
});

describe('the Google app set in config', () => {
  const t = useTestServer({
    seed: true,
    app: true,
    env: {
      WHOMBAT_GOOGLE: 'real',
      WHOMBAT_GOOGLE_CLIENT_ID: '5550001-config.apps.googleusercontent.com',
      WHOMBAT_GOOGLE_CLIENT_SECRET: 'GOCSPX-config',
    },
  });
  const h = helpers(t);

  it('is read-only: nobody can replace or remove it here', async () => {
    const status = await h.call(api.connectors.status);
    expect(status.body.google.app).toMatchObject({
      configured: true,
      source: 'config',
      clientIdHint: '5550001-conf…',
      secretSet: true,
      userType: null,
    });
    expect(JSON.stringify(status.body)).not.toContain('GOCSPX');
    const body = { clientId: CLIENT_ID, clientSecret: 'GOCSPX-other', userType: 'external' };
    expect((await h.call(api.connectors.setGoogleApp, { body })).status).toBe(409);
    expect((await h.call(api.connectors.removeGoogleApp)).status).toBe(409);
  });

  it('signs in with the config client', async () => {
    const res = await h.start(['files']);
    expect(new URL(res.body.authorizeUrl).searchParams.get('client_id')).toBe(
      '5550001-config.apps.googleusercontent.com',
    );
  });
});
