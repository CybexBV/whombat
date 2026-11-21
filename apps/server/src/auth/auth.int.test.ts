/** Who may call what: burrow membership on every burrow route, agent tokens only at MCP. */
import { newId } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { accounts } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { TEST_ACCOUNT_COOKIE } from '../test/api';
import { useTestServer } from '../test/harness';
import { agentTokenFor } from '../test/tokens';
import { verifyAgentToken } from './agent-tokens';

const t = useTestServer({ seed: true, app: true });

describe('burrow membership on every burrow route', () => {
  it('401 without an account, 404 for unknown burrows, 403 for non-members', async () => {
    const anon = await t.api.inject({ method: 'GET', url: '/api/v1/burrows/burrow-hq/bootstrap' });
    expect(anon.statusCode).toBe(401);
    // An enrolled account that is in no burrow here.
    const outsider = newId('account');
    await t.services.db
      .insert(accounts)
      .values({ id: outsider, email: 'outsider@example.com', name: 'Out Sider' });
    const cookie = `${TEST_ACCOUNT_COOKIE}=${outsider}`;
    for (const url of [
      '/api/v1/burrows/burrow-hq/bootstrap',
      '/api/v1/burrows/burrow-hq/audit',
      `/api/v1/burrows/burrow-hq/conversations/${IDS.billing}/messages`,
      '/api/v1/burrows/burrow-hq/search?q=invoice',
    ]) {
      const res = await t.api.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(403);
    }
    const post = await t.api.inject({
      method: 'POST',
      url: `/api/v1/burrows/burrow-hq/conversations/${IDS.billing}/messages`,
      headers: { cookie },
      payload: { text: 'hello?' },
    });
    expect(post.statusCode).toBe(403);
    const unknown = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/nowhere/bootstrap',
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('agent tokens name no account; they verify only while the dispatch is live (MCP)', async () => {
    const { bearer, token, dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    const rest = await t.api.inject({
      method: 'GET',
      url: `/api/v1/burrows/burrow-hq/conversations/${IDS.billing}/messages`,
      headers: { authorization: bearer },
    });
    expect(rest.statusCode).toBe(401);
    expect(await verifyAgentToken(t.services, token)).toMatchObject({
      agentId: IDS.dusty,
      burrowId: t.burrowId,
    });
    await t.services.sql`update dispatches set state = 'done' where id = ${dispatchId}`;
    expect(await verifyAgentToken(t.services, token)).toBeNull();
  });
});
