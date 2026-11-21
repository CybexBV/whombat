import { api, buildPath, microsoftScopesFor } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connections, oauthStates } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent } from '../test/personal';
import { accountOf, sessionFor } from '../test/tokens';
import { personalAccess } from './access';
import { finishGoogle, startGoogle } from './connect';
import { storeGoogleConnection } from './store';

const t = useTestServer({ seed: true, app: true });
afterEach(() => vi.unstubAllGlobals());

describe('Microsoft account boundaries', () => {
  it('binds OAuth to its provider and signed-in account, stores sealed tokens, and consumes the state once', async () => {
    const accountId = await accountOf(t.services, IDS.mara);
    // Another account's finish never takes the state.
    const other = 'acc_someone_else';
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const ep = api.connectors.setMicrosoftApp;
    const saved = await t.api.inject({
      method: ep.method,
      url: ep.base + buildPath(ep.path, {}),
      headers: { cookie },
      payload: { clientId: 'entra-client', clientSecret: 'private-entra-secret', userType: 'external' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('private-entra-secret');
    const { authorizeUrl } = await startGoogle(
      t.services,
      accountId,
      { services: ['mail'], returnTo: '/settings?tab=connections&connection=microsoft' },
      'microsoft',
    );
    const state = new URL(authorizeUrl).searchParams.get('state') as string;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      const data = path.includes('/token')
        ? {
            access_token: 'private-ms-access',
            refresh_token: 'private-ms-refresh',
            expires_in: 3600,
            scope: microsoftScopesFor(['mail']).join(' '),
          }
        : path.includes('/me?')
          ? {
              id: 'ms-user-1',
              mail: 'mara@example.com',
              userPrincipalName: 'mara@example.com',
              displayName: 'Mara',
            }
          : { value: [] };
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetcher);
    await finishGoogle(t.services, { state, code: 'code' }, accountId, '/settings', 'google');
    await finishGoogle(t.services, { state, code: 'code' }, other, '/settings', 'microsoft');
    expect(fetcher).not.toHaveBeenCalled();
    const [unused] = await t.services.db.select().from(oauthStates).where(eq(oauthStates.id, state));
    expect(unused?.usedAt).toBeNull();
    expect(
      (await finishGoogle(t.services, { state, code: 'code' }, accountId, '/settings', 'microsoft')).location,
    ).toContain('connected=microsoft');
    const [stored] = await t.services.db
      .select()
      .from(connections)
      .where(and(eq(connections.accountId, accountId), eq(connections.provider, 'microsoft')));
    expect(stored).toMatchObject({ externalId: 'ms-user-1', services: ['mail'], status: 'active' });
    expect(JSON.stringify(stored)).not.toContain('private-ms-');
    const count = fetcher.mock.calls.length;
    await finishGoogle(t.services, { state, code: 'code' }, accountId, '/settings', 'microsoft');
    expect(fetcher).toHaveBeenCalledTimes(count);
  });

  it('requires an explicit provider when the person has both, and none in an outsiders’ turn (OP-17)', async () => {
    const mara = await accountOf(t.services, IDS.mara);
    const chat = await addPersonalAgent(t.services, t.burrowId, IDS.mara);
    await storeGoogleConnection(t.services, {
      accountId: mara,
      provider: 'microsoft',
      requested: ['mail'],
      tokens: {
        accessToken: 'ms-access',
        refreshToken: 'ms-refresh',
        expiresAt: new Date(Date.now() + 3600000),
        scopes: microsoftScopesFor(['mail']),
      },
      user: { sub: 'ms-user-1', email: 'mara@example.com', name: 'Mara' },
    });
    const access = (accountId: string | null, provider?: 'microsoft') =>
      personalAccess(t.services, t.services.db, chat.agentId, 'mail', provider, accountId);
    await expect(access(mara)).rejects.toMatchObject({
      extra: { details: { reason: 'ambiguous_provider' } },
    });
    expect((await access(mara, 'microsoft')).person.id).toBe(IDS.mara);
    // An outsiders' turn (for nobody) never reaches Mara's.
    await expect(access(null, 'microsoft')).rejects.toMatchObject({
      extra: { details: { reason: 'not_personal' } },
    });
  });
});
