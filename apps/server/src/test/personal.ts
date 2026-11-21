/**
 * Test helpers for a person's Chat with the agent and their connections (docs/decisions/connectors.md, one-agent.md
 * OA-10): the burrow's one agent (made the way the product makes it when the burrow has none, `createTheAgent`), the
 * person's Chat with it (`ensureChatWithAgent`), and the person's Google connection stored the way Google's callback
 * stores it (`storeGoogleConnection`), so the real token store hands out its token.
 */
import { CONNECTOR_SERVICES, type ConnectorService, type GrantInput, googleScopesFor } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { applyContext, loadBurrowRow } from '../commit/pipeline';
import { fakeAccessTokenFor } from '../connectors/oauth';
import { storeGoogleConnection } from '../connectors/store';
import { connections, grants, principals } from '../db/schema/index';
import { personalDmId } from '../domain/personal-dm';
import { createTheAgent, ensureChatWithAgent } from '../domain/the-agent';
import { iso } from '../lib/time';
import { toActor } from '../read/principals';
import type { Services } from '../services';

/** The refresh token of every test connection; the fake Google derives the access token from it. */
export const FAKE_REFRESH_TOKEN = 'fake-refresh';
/** The access token of every test connection (the fake Workspace keeps one mailbox per access token). */
export const FAKE_ACCESS_TOKEN = fakeAccessTokenFor(FAKE_REFRESH_TOKEN);

export interface PersonalSetup {
  agentId: string;
  handle: string;
  dmId: string;
  connectionId: string | null;
}

export async function addPersonalAgent(
  services: Services,
  burrowId: string,
  personId: string,
  options: {
    /** Ignored: the burrow's one agent keeps its name (one-agent.md OA-01). */
    name?: string;
    /** Replaces the default personal grants. */
    grants?: readonly GrantInput[];
    /** Connected services; null: no connection. */
    services?: readonly ConnectorService[] | null;
    status?: 'active' | 'needs_reauth';
  } = {},
): Promise<PersonalSetup> {
  const { result } = await services.pipeline.transact(burrowId, async (session) => {
    const burrow = await loadBurrowRow(session.tx, burrowId);
    const [person] = await session.tx.select().from(principals).where(eq(principals.id, personId));
    if (!burrow || !person) throw new Error(`${personId} is not in ${burrowId}`);
    const now = services.clock();
    const ctx = applyContext(session, {
      burrow,
      actor: toActor(person),
      now,
      at: iso(now),
      decision: null,
      requirement: null,
      approvalId: null,
      onBehalfOf: {},
    });
    const made = { agentId: (await createTheAgent(ctx)).id };
    await ensureChatWithAgent(ctx, person);
    const dmId = await personalDmId(session.tx, made.agentId, personId);
    if (!dmId) throw new Error('no Chat');
    if (options.grants) {
      await session.tx.delete(grants).where(eq(grants.agentId, made.agentId));
      if (options.grants.length)
        await session.tx.insert(grants).values(
          options.grants.map((g, position) => ({
            burrowId,
            agentId: made.agentId,
            keyId: g.keyId,
            tier: g.tier,
            position,
          })),
        );
    }
    const [agent] = await session.tx.select().from(principals).where(eq(principals.id, made.agentId));
    return { agentId: made.agentId, handle: agent?.handle ?? '', dmId, accountId: person.accountId };
  });

  let connectionId: string | null = null;
  const connected = options.services === undefined ? CONNECTOR_SERVICES : options.services;
  if (connected && result.accountId) {
    const row = await storeGoogleConnection(services, {
      accountId: result.accountId,
      requested: connected,
      tokens: {
        accessToken: FAKE_ACCESS_TOKEN,
        refreshToken: FAKE_REFRESH_TOKEN,
        expiresAt: new Date(services.clock().getTime() + 3_600_000),
        scopes: googleScopesFor(connected),
      },
      user: { sub: `sub-${personId}`, email: 'you@example.com', name: 'You' },
    });
    connectionId = row.id;
    if (options.status === 'needs_reauth') await setConnection(services, row.id, { status: 'needs_reauth' });
  }
  return { agentId: result.agentId, handle: result.handle, dmId: result.dmId, connectionId };
}

/** Changes the person's connection (services, status). */
export async function setConnection(
  services: Services,
  connectionId: string,
  values: { services?: ConnectorService[]; status?: 'active' | 'needs_reauth' },
): Promise<void> {
  await services.db
    .update(connections)
    .set({
      ...values,
      ...(values.status === 'needs_reauth' ? { reauthReason: 'revoked' as const } : {}),
      ...(values.status === 'active' ? { reauthReason: null } : {}),
    })
    .where(eq(connections.id, connectionId));
}
