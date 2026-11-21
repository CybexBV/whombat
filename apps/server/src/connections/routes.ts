/**
 * The connections catalog over HTTP and sessions (contracts `connectionCatalogEndpoints`, `connectorAppEndpoints`,
 * CT-269): thin adapters over `connect.ts`, `oauth-connect.ts`, `nextcloud.ts`, `service-login/` and `box-setup.ts`. The managed dispatcher
 * runs these same handlers over a session (secret ops: `connections.create`, `connections.setSecret`,
 * `connections.finishOAuth`, `connectors.setApp`, CX-16).
 *
 * Not contract endpoints: the OAuth browser callback `GET /api/v1/connections/<catalogId>/callback` (self-hosted; it
 * redirects to the return path) and this Whombat's Client ID Metadata Document (`/api/v1/connections/oauth/client.json`).
 */
import { type AnyEndpoint, api, resolveMcpUrl } from '@whombat/core';
import type { RequestAuth } from '../auth/request';
import { memberships } from '../auth/service';
import { unauthorized } from '../lib/errors';
import { type HandlerContext, route } from '../routes/define';
import type { Services } from '../services';
import { allowConnectionNetwork, removeCatalogApp, saveCatalogApp } from './box-setup';
import { probeMcp } from './checks';
import {
  cleanFields,
  connectableEntry,
  createConnection,
  disconnectConnection,
  recheckConnection,
  replaceConnectionSecret,
  requireDestination,
  setConnectionTool,
  updateConnection,
} from './connect';
import { discoverConnections, hideFoundService } from './discover';
import { connectionError } from './errors';
import { identifyConnection } from './identify';
import { pollNextcloudLogin, startNextcloudLogin } from './nextcloud';
import { discoverProtectedResource } from './oauth';
import { finishConnectionOAuth, startConnectionOAuth } from './oauth-connect';
import { pollServiceLogin, startServiceLogin } from './service-login/index';
import { type ConnectionViewer, visibleConnection, visibleConnections } from './store';
import { setConnectionToolLimits } from './tool-limits';
import { catalogStatus, connectionToolsResponse, connectionView, connectionViews } from './views';

function accountOf(auth: RequestAuth) {
  if (!auth.account) throw unauthorized();
  return auth.account;
}

type BurrowCtx = Pick<HandlerContext<AnyEndpoint>, 'services' | 'access' | 'auth'>;

/** The caller as a viewer of the burrow's connections. */
export async function viewerOf(ctx: BurrowCtx): Promise<ConnectionViewer> {
  const account = accountOf(ctx.auth);
  return {
    accountId: account.id,
    burrowId: ctx.access.burrow.id,
    principal: ctx.access.principal,
  };
}

/** Where the browser goes when a state says nothing: the account's first burrow's Connections tab. */
async function fallbackPath(services: Services, accountId: string | null): Promise<string> {
  const [first] = accountId ? await memberships(services, accountId) : [];
  return first ? `/${first.burrowSlug}/settings?tab=connections` : '/';
}

export const connectionCatalogRoutes = [
  route(api.connections.catalog, async ({ auth, services }) => {
    accountOf(auth);
    return catalogStatus(services);
  }),

  route(api.connections.list, async (ctx) => {
    const viewer = await viewerOf(ctx);
    const rows = await visibleConnections(ctx.services.db, viewer);
    return { connections: await connectionViews(ctx.services.db, rows), count: rows.length };
  }),

  route(api.connections.create, async (ctx) => {
    const viewer = await viewerOf(ctx);
    const { row, eventId } = await createConnection(ctx.services, viewer, ctx.body);
    return { connection: await connectionView(ctx.services.db, row), eventId };
  }),

  route(api.connections.update, async (ctx) => {
    const viewer = await viewerOf(ctx);
    const { row, eventId } = await updateConnection(ctx.services, viewer, ctx.params.connectionId, ctx.body);
    return { connection: await connectionView(ctx.services.db, row), eventId };
  }),

  route(api.connections.setSecret, async (ctx) => {
    const viewer = await viewerOf(ctx);
    const { row, eventId } = await replaceConnectionSecret(
      ctx.services,
      viewer,
      ctx.params.connectionId,
      ctx.body.secret,
      // A session's two-step code (SG-09).
      ctx.body.code,
    );
    return { connection: await connectionView(ctx.services.db, row), eventId };
  }),

  route(api.connections.recheck, async (ctx) => {
    const viewer = await viewerOf(ctx);
    const { row, checks } = await recheckConnection(ctx.services, viewer, ctx.params.connectionId);
    return { connection: await connectionView(ctx.services.db, row), checks };
  }),

  route(api.connections.disconnect, async (ctx) => {
    const viewer = await viewerOf(ctx);
    const { eventId, notice } = await disconnectConnection(ctx.services, viewer, ctx.params.connectionId);
    return { ok: true as const, eventId, notice };
  }),

  route(api.connections.tools, async (ctx) => {
    const viewer = await viewerOf(ctx);
    const row = await visibleConnection(ctx.services.db, viewer, ctx.params.connectionId);
    return connectionToolsResponse(ctx.services.db, row);
  }),

  route(api.connections.setTool, async (ctx) => {
    const viewer = await viewerOf(ctx);
    await setConnectionTool(ctx.services, viewer, ctx.params.connectionId, ctx.params.tool, ctx.body.tier);
    const row = await visibleConnection(ctx.services.db, viewer, ctx.params.connectionId);
    return connectionToolsResponse(ctx.services.db, row);
  }),

  // The person's limits on a tool's arguments (one-whombat-devices.md ONE-DD04, contracts 0.80 CT-341).
  route(api.connections.setToolLimits, async (ctx) => {
    const viewer = await viewerOf(ctx);
    await setConnectionToolLimits(
      ctx.services,
      viewer,
      ctx.params.connectionId,
      ctx.params.tool,
      ctx.body.limits,
    );
    const row = await visibleConnection(ctx.services.db, viewer, ctx.params.connectionId);
    return connectionToolsResponse(ctx.services.db, row);
  }),

  route(api.connections.startOAuth, async (ctx) =>
    startConnectionOAuth(ctx.services, await viewerOf(ctx), ctx.body),
  ),

  // The browser callback's JSON twin (as `connections.finishGoogle`, AG-14): the hosted UI hands over what the service
  // put on its address bar. The state must be this account's.
  route(api.connections.finishOAuth, async ({ auth, body, services }) => {
    const account = accountOf(auth);
    const outcome = await finishConnectionOAuth(
      services,
      body,
      account.id,
      await fallbackPath(services, account.id),
    );
    return { returnPath: outcome.location, connectionId: outcome.connectionId };
  }),

  route(api.connections.startNextcloud, async (ctx) =>
    startNextcloudLogin(ctx.services, await viewerOf(ctx), ctx.body),
  ),

  route(api.connections.pollNextcloud, async ({ auth, params, services }) =>
    pollNextcloudLogin(services, accountOf(auth).id, params.flowId),
  ),

  // Sign in on the service's own page (connection-signin.md SG-01, SG-02): Plex's PIN page.
  route(api.connections.startServiceLogin, async (ctx) =>
    startServiceLogin(ctx.services, await viewerOf(ctx), ctx.body),
  ),

  route(api.connections.pollServiceLogin, async ({ auth, params, services }) =>
    pollServiceLogin(services, accountOf(auth).id, params.flowId),
  ),

  route(api.connections.probe, async ({ auth, body, services }) => {
    accountOf(auth);
    const entry = connectableEntry(body.catalogId);
    const kind = entry.signIn.some((m) => m.kind === 'none') ? 'none' : 'token';
    const mcpUrl = resolveMcpUrl(entry, cleanFields(body.fields), kind);
    if (!mcpUrl) throw connectionError('not_supported', { catalogId: entry.id });
    await requireDestination(services, [mcpUrl]);
    return probeMcp(services, mcpUrl, async (url, header) => {
      const found = await discoverProtectedResource(services, url, header);
      return found ? { issuer: found.issuer } : null;
    });
  }),

  // What is at an address (CS-13): anyone signed in who may connect, as the probe.
  route(api.connections.identify, async ({ auth, body, services }) => {
    accountOf(auth);
    return identifyConnection(services, body);
  }),

  // Found on your network (CS-14): answers at once, the app polls while it scans.
  route(api.connections.discover, async (ctx) =>
    discoverConnections(ctx.services, await viewerOf(ctx), ctx.body),
  ),

  route(api.connections.hideFound, async (ctx) =>
    hideFoundService(ctx.services, await viewerOf(ctx), ctx.body),
  ),

  route(api.connections.allowNetwork, async ({ auth, body, services }) =>
    allowConnectionNetwork(services, accountOf(auth), body),
  ),

  route(api.connectors.setApp, async ({ auth, body, params, services }) => {
    await saveCatalogApp(services, accountOf(auth), params.catalogId, body);
    return catalogStatus(services);
  }),

  route(api.connectors.removeApp, async ({ auth, params, services }) => {
    await removeCatalogApp(services, accountOf(auth), params.catalogId);
    return catalogStatus(services);
  }),
];
