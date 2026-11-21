/**
 * Connectors with the fake Google (docs/decisions/connectors.md CN-02…CN-08): the person's app, connecting
 * (start → the hosted UI hands the redirect over → stored, encrypted tokens), the state's rules, tokens and reauth,
 * checks, disconnect.
 */
import {
  type AnyEndpoint,
  api,
  buildPath,
  type ConnectorsStatus,
  GOOGLE_SCOPES,
  googleScopesFor,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { runInCommandScope } from '../commit/scope';
import { connections, connectorApps, oauthStates, principals } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { openAppSecret, openConnectionToken } from './crypto';
import { type FakeGoogleOAuth, fakeAccessTokenFor } from './oauth';
import { storeGoogleConnection } from './store';
import { ConnectionUnavailableError } from './types';

const t = useTestServer({ seed: true, app: true });
let mara = '';
let maraAccount = '';

beforeAll(async () => {
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
  const [row] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  maraAccount = row?.accountId ?? '';
});

const fake = () => t.services.google.oauth as FakeGoogleOAuth;

async function call(
  ep: AnyEndpoint,
  opts: { params?: Record<string, string>; body?: unknown; cookie?: string } = {},
) {
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, opts.params ?? {})}`,
    headers: { cookie: opts.cookie ?? mara },
    ...(opts.body === undefined ? {} : { payload: opts.body as object }),
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

async function status(cookie = mara): Promise<ConnectorsStatus> {
  const res = await call(api.connectors.status, { cookie });
  expect(res.status).toBe(200);
  return res.body;
}

async function start(services = ['mail', 'calendar', 'files'], cookie = mara): Promise<URL> {
  const res = await call(api.connections.startGoogle, {
    cookie,
    body: { services, returnTo: '/burrow-hq/settings?tab=connections' },
  });
  expect(res.status).toBe(200);
  return new URL(res.body.authorizeUrl);
}

/**
 * What the hosted UI does with Google's redirect (AG-14): hands its `code`, `state` and `error` over the session
 * (`connections.finishGoogle`); the answer is where it goes next.
 */
async function callback(url: URL, cookie = mara) {
  const param = (name: string) => url.searchParams.get(name) ?? undefined;
  const res = await call(api.connections.finishGoogle, {
    cookie,
    body: { state: param('state'), code: param('code'), error: param('error') },
  });
  expect(res.status).toBe(200);
  return String(res.body.returnPath);
}

async function maraConnection() {
  const [row] = await t.services.db.select().from(connections).where(eq(connections.accountId, maraAccount));
  return row;
}

describe('connectors with the fake Google', () => {
  it('shows the setup facts', async () => {
    const s = await status();
    expect(s).toMatchObject({
      mode: 'fake',
      connections: [],
      google: {
        tested: false,
        app: { configured: false, source: null, secretSet: false, clientIdHint: null },
        setup: {
          redirectUri: 'http://localhost:5180/connect/google',
          appName: 'Whombat',
          supportEmail: 'mara@burrowhq.example',
          authorizedDomain: 'localhost',
        },
      },
    });
    expect(s.google.setup.scopes).toContain(GOOGLE_SCOPES.files);
  });

  it('saves the app, sealing the secret', async () => {
    const body = {
      clientId: '1234567890-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret',
      userType: 'external',
    };
    const saved = await call(api.connectors.setGoogleApp, { body });
    expect(saved.status).toBe(200);
    expect(saved.body.google.app).toMatchObject({
      configured: true,
      source: 'settings',
      clientIdHint: '1234567890-a…',
      secretSet: true,
      userType: 'external',
    });
    expect(JSON.stringify(saved.body)).not.toContain('GOCSPX');
    const [row] = await t.services.db.select().from(connectorApps);
    expect(row?.clientSecretEnc).not.toContain('GOCSPX');
    expect(openAppSecret(t.services.custody, 'google', row?.clientSecretEnc ?? '')).toBe('GOCSPX-secret');

    // The audience changes without pasting the secret again.
    const again = await call(api.connectors.setGoogleApp, {
      body: { userType: 'internal' },
    });
    expect(again.body.google.app.userType).toBe('internal');
    const [kept] = await t.services.db.select().from(connectorApps);
    expect(kept?.clientId).toBe(body.clientId);
    expect(openAppSecret(t.services.custody, 'google', kept?.clientSecretEnc ?? '')).toBe('GOCSPX-secret');
    // The same id pasted again keeps the secret too; another client's id needs its own (IN-27).
    expect(
      (await call(api.connectors.setGoogleApp, { body: { clientId: body.clientId, userType: 'external' } }))
        .status,
    ).toBe(200);
    const replaced = await call(api.connectors.setGoogleApp, {
      body: { clientId: '999-other.apps.googleusercontent.com', userType: 'external' },
    });
    expect(replaced.status).toBe(400);
    expect(replaced.body.error).toMatchObject({
      code: 'validation_failed',
      fields: { clientSecret: ['A new Client ID needs its client secret too.'] },
    });
    const [unchanged] = await t.services.db.select().from(connectorApps);
    expect(unchanged?.clientId).toBe(body.clientId);
    await call(api.connectors.setGoogleApp, { body });
  });

  it('connects: start → callback → a connection with sealed tokens and checks', async () => {
    const url = await start();
    expect(url.pathname).toBe('/connect/google');
    const state = url.searchParams.get('state') ?? '';
    expect(state).toMatch(/^oas_[A-Za-z0-9_-]{43}$/);
    const [stored] = await t.services.db.select().from(oauthStates).where(eq(oauthStates.id, state));
    expect(stored).toMatchObject({
      accountId: maraAccount,
      services: ['mail', 'calendar', 'files'],
      usedAt: null,
    });
    expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

    expect(await callback(url)).toBe('/burrow-hq/settings?tab=connections&connected=google');

    const row = await maraConnection();
    expect(row).toMatchObject({
      provider: 'google',
      email: 'you@example.com',
      externalId: 'fake-google-you',
      services: ['mail', 'calendar', 'files'],
      status: 'active',
      reauthReason: null,
    });
    expect(row?.refreshTokenEnc.startsWith('v1:')).toBe(true);
    const refresh = openConnectionToken(
      t.services.custody,
      row?.id ?? '',
      'refresh',
      row?.refreshTokenEnc ?? '',
    );
    const access = fakeAccessTokenFor(refresh);
    expect(row?.accessTokenEnc).not.toContain(access);
    expect(openConnectionToken(t.services.custody, row?.id ?? '', 'access', row?.accessTokenEnc ?? '')).toBe(
      access,
    );
    const s = await status();
    expect(s.google.tested).toBe(true);
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0]).toMatchObject({
      email: 'you@example.com',
      services: ['mail', 'calendar', 'files'],
      status: 'active',
      checks: [
        { service: 'mail', state: 'ok' },
        { service: 'calendar', state: 'ok' },
        { service: 'files', state: 'ok' },
      ],
    });
    expect(JSON.stringify(s)).not.toContain('v1:');
  });

  it('reconnecting adds services to the same row', async () => {
    const before = await maraConnection();
    await callback(await start(['contacts']));
    const after = await maraConnection();
    expect(after?.id).toBe(before?.id);
    expect(after?.services).toEqual(['mail', 'calendar', 'files', 'contacts']);
  });

  it('a state is single use, expires after 10 minutes and belongs to its account', async () => {
    const url = await start();
    expect(await callback(url)).toContain('connected=google');
    expect(await callback(url)).toBe('/burrow-hq/settings?tab=connections&connect_error=invalid_state');

    const late = await start();
    await t.services.db
      .update(oauthStates)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthStates.id, late.searchParams.get('state') ?? ''));
    expect(await callback(late)).toContain('connect_error=invalid_state');

    const made = new URL('http://localhost:5180/connect/google?code=fake.x&state=oas_unknown');
    expect(await callback(made)).toContain('connect_error=invalid_state');
  });

  it('access_denied comes back as connect_error=access_denied', async () => {
    const url = await start();
    const denied = new URL(url);
    denied.searchParams.delete('code');
    denied.searchParams.set('error', 'access_denied');
    expect(await callback(denied)).toBe('/burrow-hq/settings?tab=connections&connect_error=access_denied');
  });

  it('refuses a returnTo on another origin', async () => {
    const res = await call(api.connections.startGoogle, {
      body: { services: ['mail'], returnTo: '//evil.example/x' },
    });
    expect(res.status).toBe(400);
  });

  it('hands out the stored token, refreshing once when under a minute is left', async () => {
    const tokens = t.services.google.tokens;
    const before = fake().refreshes;
    const stored = await tokens.accessFor(maraAccount, 'google');
    expect(stored).toMatch(/^fake-token\./);
    expect(fake().refreshes).toBe(before);

    const row = await maraConnection();
    await t.services.db
      .update(connections)
      .set({ accessExpiresAt: new Date(Date.now() + 30_000) })
      .where(eq(connections.id, row?.id ?? ''));
    const all = await Promise.all([1, 2, 3, 4].map(() => tokens.accessFor(maraAccount, 'google')));
    // The fake Google hands the connection the same token on every refresh: its mailbox stays.
    expect(all).toEqual(Array(4).fill(stored));
    expect(fake().refreshes).toBe(before + 1);
    const fresh = await maraConnection();
    expect(fresh?.accessExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    // The refresh is not a check: “Checked … ago” stays when the checks ran (IN-29).
    expect(row?.checkedAt).toBeInstanceOf(Date);
    expect(fresh?.checkedAt?.getTime()).toBe(row?.checkedAt?.getTime());
    expect((await status()).connections[0]?.checkedAt).toBe(row?.checkedAt?.toISOString());
  });

  it('a refresh a session command started is not that command’s: cancelling it loses nothing (command-safety.md CS-07)', async () => {
    const tokens = t.services.google.tokens;
    const oauth = fake();
    const refresh = oauth.refresh.bind(oauth);
    const row = await maraConnection();
    await t.services.db
      .update(connections)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(connections.id, row?.id ?? ''));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    oauth.refresh = async (input) => {
      entered();
      await gate;
      return refresh(input);
    };
    // `connections.check` over a session whose request is cancelled: each transaction it commits rolls back.
    let commits = 0;
    const scope = {
      active: true,
      accepted: false,
      op: 'connections.check',
      beforeCommit: async () => {
        commits++;
        throw new Error('cancelled before the command was accepted');
      },
      afterCommit: () => {},
    };
    try {
      const inCommand = runInCommandScope(scope, () => tokens.accessFor(maraAccount, 'google'));
      await started;
      // An agent's tool call joins the refresh under way.
      const joined = tokens.accessFor(maraAccount, 'google');
      release();
      const [a, b] = await Promise.allSettled([inCommand, joined]);
      expect(a).toMatchObject({ status: 'fulfilled', value: expect.stringMatching(/^fake-token\./) });
      expect(b).toMatchObject({ status: 'fulfilled', value: expect.stringMatching(/^fake-token\./) });
    } finally {
      oauth.refresh = refresh;
      scope.active = false;
    }
    // The tokens Google issued are stored, and the command's scope was never asked to commit them.
    expect(commits).toBe(0);
    expect((await maraConnection())?.accessExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('refreshes a token Google refused before it expired (forceRefresh)', async () => {
    const tokens = t.services.google.tokens;
    const stored = await tokens.accessFor(maraAccount, 'google');
    const before = fake().refreshes;
    expect(await tokens.accessFor(maraAccount, 'google', { forceRefresh: true })).toBe(stored);
    expect(fake().refreshes).toBe(before + 1);
    expect(await tokens.accessFor(maraAccount, 'google')).toBe(stored);
    expect(fake().refreshes).toBe(before + 1);
  });

  it('invalid_grant makes the connection need reauth: testing_expired or revoked', async () => {
    const tokens = t.services.google.tokens;
    const expire = async (grantedDaysAgo: number) => {
      const row = await maraConnection();
      const refresh = openConnectionToken(
        t.services.custody,
        row?.id ?? '',
        'refresh',
        row?.refreshTokenEnc ?? '',
      );
      fake().revoked.add(refresh);
      await t.services.db
        .update(connections)
        .set({
          accessExpiresAt: new Date(Date.now() - 1000),
          grantedAt: new Date(Date.now() - grantedDaysAgo * 86_400_000),
        })
        .where(eq(connections.id, row?.id ?? ''));
    };
    await call(api.connectors.setGoogleApp, {
      body: { clientId: '1234567890-abc.apps.googleusercontent.com', userType: 'external' },
    });

    await expire(7);
    const err = await tokens.accessFor(maraAccount, 'google').catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionUnavailableError);
    expect(err.reason).toBe('needs_reauth');
    expect(await maraConnection()).toMatchObject({
      status: 'needs_reauth',
      reauthReason: 'testing_expired',
      accessTokenEnc: null,
    });
    expect((await status()).connections[0]).toMatchObject({
      status: 'needs_reauth',
      reauthReason: 'testing_expired',
    });
    await expect(tokens.accessFor(maraAccount, 'google')).rejects.toMatchObject({ reason: 'needs_reauth' });

    // Reconnecting makes it active again; a revoked grant a day later reads `revoked`.
    await callback(await start());
    expect(await maraConnection()).toMatchObject({ status: 'active', reauthReason: null });
    await expire(1);
    await expect(tokens.accessFor(maraAccount, 'google')).rejects.toMatchObject({ reason: 'needs_reauth' });
    expect(await maraConnection()).toMatchObject({ reauthReason: 'revoked' });

    await callback(await start());
    await expect(tokens.accessFor('acc_nobody', 'google')).rejects.toMatchObject({ reason: 'not_connected' });
  });

  it('a refresh that finishes after a reconnect keeps the new grant (IN-22, IN-23)', async () => {
    const tokens = t.services.google.tokens;
    const oauth = fake();
    const refresh = oauth.refresh.bind(oauth);
    const reconnect = async (n: number) =>
      storeGoogleConnection(t.services, {
        accountId: maraAccount,
        requested: ['mail'],
        tokens: {
          accessToken: fakeAccessTokenFor(`race-refresh-${n}`),
          refreshToken: `race-refresh-${n}`,
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: googleScopesFor(['mail']),
        },
        user: { sub: `sub-race-${n}`, email: `race${n}@gmail.com`, name: 'Mara' },
      });
    const expireNow = async () => {
      const row = await maraConnection();
      await t.services.db
        .update(connections)
        .set({ accessExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(connections.id, row?.id ?? ''));
    };
    try {
      // Google answers the old grant after the person connected another account: the new one's token wins.
      await expireNow();
      oauth.refresh = async (input) => {
        const out = await refresh(input);
        await reconnect(1);
        return out;
      };
      expect(await tokens.accessFor(maraAccount, 'google')).toBe(fakeAccessTokenFor('race-refresh-1'));
      const row = await maraConnection();
      expect(row).toMatchObject({ status: 'active', email: 'race1@gmail.com' });
      expect(
        openConnectionToken(t.services.custody, row?.id ?? '', 'access', row?.accessTokenEnc ?? ''),
      ).toBe(fakeAccessTokenFor('race-refresh-1'));

      // The old grant was revoked meanwhile: its late invalid_grant does not sign the new connection out.
      await expireNow();
      oauth.refresh = async (input) => {
        await reconnect(2);
        oauth.revoked.add(input.refreshToken);
        return refresh(input);
      };
      expect(await tokens.accessFor(maraAccount, 'google')).toBe(fakeAccessTokenFor('race-refresh-2'));
      expect(await maraConnection()).toMatchObject({ status: 'active', reauthReason: null });

      // Connecting another Google account revokes the replaced account's grant (IN-23); the same account's
      // reconnect keeps it.
      expect(oauth.revoked.has('race-refresh-1')).toBe(true);
      expect(oauth.revoked.has('race-refresh-2')).toBe(false);
      oauth.refresh = refresh;
      await storeGoogleConnection(t.services, {
        accountId: maraAccount,
        requested: ['mail'],
        tokens: {
          accessToken: fakeAccessTokenFor('race-refresh-2b'),
          refreshToken: 'race-refresh-2b',
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: googleScopesFor(['mail']),
        },
        user: { sub: 'sub-race-2', email: 'race2@gmail.com', name: 'Mara' },
      });
      expect(oauth.revoked.has('race-refresh-2')).toBe(false);
    } finally {
      oauth.refresh = refresh;
      await callback(await start());
    }
  });

  it('checks again', async () => {
    const row = await maraConnection();
    const mine = await call(api.connections.check, { params: { connectionId: row?.id ?? '' } });
    expect(mine.status).toBe(200);
    expect(mine.body.checks.every((c: { state: string }) => c.state === 'ok')).toBe(true);
  });

  it('removing the app makes every connection need reauth; a new start still works in fake mode', async () => {
    const removed = await call(api.connectors.removeGoogleApp);
    expect(removed.status).toBe(200);
    expect(removed.body.google.app.configured).toBe(false);
    expect(removed.body.connections[0]).toMatchObject({
      status: 'needs_reauth',
      reauthReason: 'app_removed',
    });
    await expect(t.services.google.tokens.accessFor(maraAccount, 'google')).rejects.toMatchObject({
      reason: 'needs_reauth',
    });
    await callback(await start());
    expect(await maraConnection()).toMatchObject({ status: 'active' });
  });

  it('disconnect revokes at Google and forgets the connection', async () => {
    const row = await maraConnection();
    const refresh = openConnectionToken(
      t.services.custody,
      row?.id ?? '',
      'refresh',
      row?.refreshTokenEnc ?? '',
    );
    const res = await call(api.connections.remove, { params: { connectionId: row?.id ?? '' } });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(fake().revoked.has(refresh)).toBe(true);
    expect(await maraConnection()).toBeUndefined();
    expect((await status()).connections).toEqual([]);
  });
});
