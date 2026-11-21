/**
 * Connectors over HTTP (docs/decisions/connectors.md "Endpoints"): the Google app of this Whombat (the person's,
 * OP-S76), the caller's connections, and Google's browser redirect after consent. Account-level writes (CN-07), not
 * the burrow commit pipeline.
 */
import { api, type ConnectorsStatus } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import type { RequestAuth } from '../auth/request';
import { memberships } from '../auth/service';
import { googleAppStatus, removeGoogleApp, saveGoogleApp } from '../connectors/app';
import { finishGoogle, startGoogle } from '../connectors/connect';
import { connectImap, discoverImap } from '../connectors/imap/service';
import { providerRedirectUri } from '../connectors/providers';
import { googleSetupFacts } from '../connectors/setup';
import {
  checkConnection,
  connectionsOfAccount,
  ownConnection,
  removeConnection,
  toConnection,
} from '../connectors/store';
import { connections } from '../db/schema/index';
import { unauthorized } from '../lib/errors';
import type { Services } from '../services';
import { route } from './define';

function accountOf(auth: RequestAuth) {
  if (!auth.account) throw unauthorized();
  return auth.account;
}

/** Any Google connection on this Whombat works (step 6 of the setup turns green). */
async function googleTested(services: Services): Promise<boolean> {
  const [row] = await services.db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.provider, 'google'),
        eq(connections.status, 'active'),
        sql`${connections.checks} @> '[{"state":"ok"}]'::jsonb`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** `GET /connectors` for the caller. */
export async function connectorsStatus(services: Services, auth: RequestAuth): Promise<ConnectorsStatus> {
  const account = accountOf(auth);
  const app = await googleAppStatus(services);
  const mine = await connectionsOfAccount(services, account.id);
  return {
    mode: services.google.mode,
    microsoft: {
      app: await googleAppStatus(services, 'microsoft'),
      redirectUri: providerRedirectUri(services, 'microsoft'),
    },
    google: {
      app,
      setup: googleSetupFacts(services.config, account.email),
      tested: await googleTested(services),
    },
    // Email (IMAP) needs nothing set up: anyone can connect a mailbox (CM-19).
    imap: { available: true },
    connections: mine.map(toConnection),
  };
}

export const connectorRoutes = [
  // Email (IMAP) (CM-20, CM-22): find an address's servers, then connect it with its password (a secret op).
  route(api.connectors.imapDiscover, async ({ auth, body, services }) => {
    accountOf(auth);
    return discoverImap(services, body.email);
  }),
  route(api.connectors.imapConnect, async ({ auth, body, services }) =>
    toConnection(await connectImap(services, accountOf(auth).id, body)),
  ),
  route(api.connectors.setMicrosoftApp, async ({ auth, body, services }) => {
    const account = accountOf(auth);
    await saveGoogleApp(services, account.id, body, 'microsoft');
    return connectorsStatus(services, auth);
  }),
  route(api.connectors.removeMicrosoftApp, async ({ auth, services }) => {
    const account = accountOf(auth);
    await removeGoogleApp(services, account.id, 'microsoft');
    return connectorsStatus(services, auth);
  }),
  route(api.connections.startMicrosoft, async ({ auth, body, services }) =>
    startGoogle(services, accountOf(auth).id, body, 'microsoft'),
  ),
  route(api.connections.finishMicrosoft, async ({ auth, body, services }) => {
    const account = accountOf(auth);
    const result = await finishGoogle(
      services,
      body,
      account.id,
      await fallbackPath(services, account.id),
      'microsoft',
    );
    return { returnPath: result.location };
  }),
  route(api.connectors.status, async ({ auth, services }) => connectorsStatus(services, auth)),

  route(api.connectors.setGoogleApp, async ({ auth, body, services }) => {
    const account = accountOf(auth);
    await saveGoogleApp(services, account.id, body);
    return connectorsStatus(services, auth);
  }),

  route(api.connectors.removeGoogleApp, async ({ auth, services }) => {
    const account = accountOf(auth);
    await removeGoogleApp(services, account.id);
    return connectorsStatus(services, auth);
  }),

  route(api.connections.startGoogle, async ({ auth, body, services }) =>
    startGoogle(services, accountOf(auth).id, body),
  ),

  // The browser callback's JSON twin (AG-14): the hosted UI hands over what Google put on its address bar, over
  // the session (managed) or with the signed-in account (REST). The state must be this account's.
  route(api.connections.finishGoogle, async ({ auth, body, services }) => {
    const account = accountOf(auth);
    const outcome = await finishGoogle(services, body, account.id, await fallbackPath(services, account.id));
    return { returnPath: outcome.location };
  }),

  route(api.connections.check, async ({ auth, params, services }) => {
    const row = await ownConnection(services, accountOf(auth).id, params.connectionId);
    return toConnection(await checkConnection(services, row));
  }),

  route(api.connections.remove, async ({ auth, params, services }) => {
    const row = await ownConnection(services, accountOf(auth).id, params.connectionId);
    await removeConnection(services, row);
    return { ok: true as const };
  }),
];

/** Where the browser goes when the state says nothing: the account's first burrow's Connections tab. */
async function fallbackPath(services: Services, accountId: string | null): Promise<string> {
  const [first] = accountId ? await memberships(services, accountId) : [];
  return first ? `/${first.burrowSlug}/settings?tab=connections` : '/';
}
