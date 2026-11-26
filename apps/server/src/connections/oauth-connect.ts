/**
 * OAuth sign-ins of catalog connections (CX-12…CX-15):
 * - `ha_oauth`: Home Assistant's own OAuth — `client_id` is this Whombat's address, the redirect on the same host,
 *   `/auth/authorize` and `/auth/token` on the connection's address, an access token for 30 minutes and a refresh token;
 * - `mcp_oauth`: MCP authorization — the server's 401 challenge or well-known protected-resource metadata (RFC 9728),
 *   its authorization server's metadata (RFC 8414 / OpenID), a Client ID Metadata Document or a dynamic registration,
 *   PKCE S256, the `resource` parameter (RFC 8707), and RFC 9207's `iss` checked on the way back;
 * - `app_oauth`: the app the person registered (Dropbox: PKCE, `token_access_type=offline`).
 *
 * `startConnectionOAuth` keeps a single-use pending state for 10 minutes and answers the consent URL;
 * `finishConnectionOAuth` is the redirect — the browser callback (self-hosted) and `connections.finishOAuth` (the
 * hosted UI on a managed appliance) run exactly this — and says where the browser goes next (`connected=<catalogId>`
 * and `connection=<id>`, or `connect_error=<code>`).
 */
import {
  type ConnectionAccessLevel,
  type ConnectionConnectError,
  catalogEntry,
  catalogSignIn,
  fieldsFromCheck,
  resolveMcpUrl,
  type StartConnectionOAuthBody,
} from '@whombat/core';
import type { z } from 'zod';
import { codeChallengeS256, newCodeVerifier } from '../connectors/oauth';
import { parseGuideReturn } from '../guides/service';
import { ApiError } from '../lib/errors';
import type { OutboundResponse } from '../lib/outbound';
import type { Services } from '../services';
import { externalNameFrom, mcpInitialize, runCatalogCheck } from './checks';
import { appClient, dropDeadRegistration, mcpClientFor } from './clients';
import {
  cleanFields,
  connectableEntry,
  requireBaseUrl,
  requireDestination,
  requireFields,
  saveNewConnection,
  saveReconnect,
  viewerFor,
} from './connect';
import { connectionError } from './errors';
import { outboundText } from './http';
import {
  discoverAuthServer,
  discoverProtectedResource,
  mcpSignInScope,
  type OAuthClient,
  OAuthFlowError,
  OAuthTokenError,
  parseWwwAuthenticate,
  tokenRequest,
} from './oauth';
import { createPending, pendingState, takePending } from './pending';
import { appRedirectUri, haClientId, returnAddressProblem } from './redirect';
import { type ConnectionViewer, connectionRow, isVisibleTo, requireRoom, visibleConnection } from './store';

export const OAUTH_SIGN_INS = ['ha_oauth', 'mcp_oauth', 'app_oauth'] as const;
type OAuthKind = (typeof OAUTH_SIGN_INS)[number];

/** What a pending OAuth sign-in keeps (sealed). */
interface OAuthPendingState {
  kind: OAuthKind;
  verifier: string;
  redirectUri: string;
  labelGiven: string | null;
  fields: Record<string, string>;
  baseUrl: string;
  mcpUrl: string | null;
  tokenEndpoint: string;
  issuer: string | null;
  issParameter: boolean;
  resource: string | null;
  /** What the connection's `client_id` column records (CX-D05). */
  clientRef: string | null;
  /** Home Assistant's and MCP's client; the person's app is read again at the finish. */
  client: OAuthClient | null;
  /** The scope asked (MCP): what the connection holds when the token answer names none. Absent: none asked. */
  scope?: string | null;
  /** The access level chosen for a new connection (Look only or Manage); omitted on reconnect or older clients. */
  access?: ConnectionAccessLevel;
}

const LOCAL_ORIGIN = 'http://whombat.invalid';

/**
 * `path?…&key=value…`, keeping what the path already has. A path that would leave this Whombat once normalized goes to
 * `fallback` instead (IN-19, as `withParam` for Google).
 */
export function withParams(path: string, params: Record<string, string>, fallback = '/'): string {
  const url = new URL(path, LOCAL_ORIGIN);
  if (url.origin !== LOCAL_ORIGIN || !url.pathname.startsWith('/') || url.pathname.startsWith('//'))
    return fallback === '/' || fallback === path
      ? `/?${new URLSearchParams(params)}`
      : withParams(fallback, params);
  url.searchParams.delete('connected');
  url.searchParams.delete('connect_error');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return `${url.pathname}${url.search}${url.hash}`;
}

function oauthFailure(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof OAuthFlowError) return connectionError('check_failed', {}, err.message);
  return connectionError('check_failed', {}, outboundText(err));
}

/** `connections.startOAuth`: the consent URL for this entry and method (a single-use state for 10 minutes). */
export async function startConnectionOAuth(
  services: Services,
  viewer: ConnectionViewer,
  body: z.output<typeof StartConnectionOAuthBody>,
): Promise<{ authorizeUrl: string }> {
  const entry = connectableEntry(body.catalogId);
  const kind = body.method;
  const method = catalogSignIn(entry, kind);
  if (!method) throw connectionError('not_supported', { catalogId: entry.id });
  let fields: Record<string, string>;
  let labelGiven = body.label ?? null;
  let connectionId: string | null = null;
  /** A reconnect's scopes: what it holds, and what calls asked for beyond the sign-in's list (step-up). */
  let reconnect: { held: string[]; wanted: string[] } | null = null;
  if (body.connectionId) {
    // A reconnect keeps the connection's entry and fields.
    const row = await visibleConnection(services.db, viewer, body.connectionId);
    if (row.catalogId !== entry.id) throw connectionError('not_supported', { catalogId: entry.id });
    fields = row.fields;
    labelGiven = row.label;
    connectionId = row.id;
    if (row.signIn === kind) reconnect = { held: row.scopes, wanted: row.scopesWanted };
  } else {
    fields = cleanFields(body.fields);
    requireFields(entry, kind, fields);
    await requireRoom(services.db, viewer.burrowId);
  }
  const baseUrl = requireBaseUrl(entry, fields);
  // A box without a secure address has nowhere for the sign-in to come back to (whombat-link.md LNK-16).
  const noReturn = returnAddressProblem(services.config);
  if (noReturn) throw connectionError('not_supported', { catalogId: entry.id }, noReturn);
  const redirectUri = appRedirectUri(services.config, entry.id);
  const verifier = newCodeVerifier();
  let state: OAuthPendingState;
  let authorize: URL;
  const common = {
    verifier,
    redirectUri,
    labelGiven,
    fields,
    baseUrl,
    ...(!connectionId && body.access ? { access: body.access } : {}),
  };
  if (method.kind === 'ha_oauth') {
    await requireDestination(services, [baseUrl]);
    const clientId = haClientId(services.config);
    state = {
      ...common,
      kind,
      mcpUrl: resolveMcpUrl(entry, fields, kind),
      tokenEndpoint: `${baseUrl}${method.tokenPath}`,
      issuer: null,
      issParameter: false,
      resource: null,
      clientRef: clientId,
      client: { clientId, authMethod: 'none' },
    };
    authorize = new URL(`${baseUrl}${method.authorizePath}`);
    authorize.searchParams.set('client_id', clientId);
  } else if (method.kind === 'mcp_oauth') {
    const mcpUrl = resolveMcpUrl(entry, fields, kind);
    if (!mcpUrl) throw connectionError('not_supported', { catalogId: entry.id });
    await requireDestination(services, [mcpUrl]);
    try {
      const res: OutboundResponse = await mcpInitialize(services, mcpUrl);
      if (res.status >= 200 && res.status < 300)
        throw connectionError(
          'not_supported',
          { catalogId: entry.id },
          'This server needs no sign-in: connect it without one.',
        );
      const header = res.headers['www-authenticate'];
      const challenge =
        parseWwwAuthenticate(Array.isArray(header) ? header.join(', ') : (header ?? '')) ?? null;
      const resource = await discoverProtectedResource(services, mcpUrl, challenge?.resourceMetadata ?? null);
      if (!resource) throw new OAuthFlowError('discovery', 'This server doesn’t say how to sign in.');
      const meta = await discoverAuthServer(services, resource.issuer);
      // MCP authorization: no PKCE S256 in the metadata, no sign-in.
      if (!meta.pkceS256)
        throw new OAuthFlowError(
          'no_pkce',
          'This server’s sign-in doesn’t support PKCE, so Whombat can’t use it.',
        );
      // Signing in again keeps what calls asked for since. An entry with its own list asks that list again rather
      // than all it held, so an older sign-in's wider grant (Cloudflare's Full access) narrows to it; one without
      // keeps all it held. Never what the entry never asks for.
      const never = new Set(method.scopesNever ?? []);
      const again = reconnect
        ? method.scopes
          ? reconnect.wanted
          : [...reconnect.held, ...reconnect.wanted]
        : [];
      const asked = mcpSignInScope(
        challenge?.scope ?? (resource.scopes.length ? resource.scopes.join(' ') : null),
        [...(method.scopes ?? []), ...again].filter((s) => !never.has(s)),
      );
      const { client, ref, scope: scopeParam } = await mcpClientFor(services, meta, asked, redirectUri);
      state = {
        ...common,
        kind,
        mcpUrl,
        tokenEndpoint: meta.tokenEndpoint,
        issuer: meta.issuer,
        issParameter: meta.issParameter,
        resource: resource.resource,
        clientRef: ref,
        client,
        scope: scopeParam,
      };
      authorize = new URL(meta.authorizationEndpoint);
      authorize.searchParams.set('client_id', client.clientId);
      authorize.searchParams.set('resource', resource.resource);
      if (scopeParam) authorize.searchParams.set('scope', scopeParam);
    } catch (err) {
      throw oauthFailure(err);
    }
  } else if (method.kind === 'app_oauth') {
    const client = await appClient(services, entry.id);
    if (!client) throw connectionError('app_not_configured', { catalogId: entry.id });
    state = {
      ...common,
      kind,
      mcpUrl: null,
      tokenEndpoint: method.tokenUrl,
      issuer: null,
      issParameter: false,
      resource: null,
      clientRef: null,
      client: null,
    };
    authorize = new URL(method.authorizeUrl);
    authorize.searchParams.set('client_id', client.clientId);
    if (method.scopes.length) authorize.searchParams.set('scope', method.scopes.join(' '));
    for (const [k, v] of Object.entries(method.authorizeParams)) authorize.searchParams.set(k, v);
  } else {
    throw connectionError('not_supported', { catalogId: entry.id });
  }
  const { id } = await createPending(services, {
    accountId: viewer.accountId,
    burrowId: viewer.burrowId,
    catalogId: entry.id,
    connectionId,
    signIn: kind,
    returnPath: body.returnTo,
    state,
  });
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('state', id);
  authorize.searchParams.set('code_challenge', codeChallengeS256(verifier));
  authorize.searchParams.set('code_challenge_method', 'S256');
  return { authorizeUrl: authorize.toString() };
}

export interface FinishQuery {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
  iss?: string | undefined;
}

export interface FinishOutcome {
  location: string;
  connectionId: string | null;
}

function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * The redirect after consent (CX-15). `accountId` is the signed-in account (cookie or session): the state must be its
 * own (a sign-in started by someone else must not connect their account here, or this one's there).
 */
export async function finishConnectionOAuth(
  services: Services,
  query: FinishQuery,
  accountId: string | null,
  fallbackPath: string,
): Promise<FinishOutcome> {
  const taken = await takePending(services, query.state, accountId, OAUTH_SIGN_INS);
  const returnPath = taken.kind === 'unknown' ? null : taken.row.returnPath;
  const pendingForFail = taken.kind === 'taken' && accountId ? taken.row : null;
  const fail = async (code: ConnectionConnectError): Promise<FinishOutcome> => {
    if (pendingForFail?.burrowId && accountId && parseGuideReturn(pendingForFail.returnPath)) {
      await services.guides.afterConnectionOAuth({
        accountId,
        burrowId: pendingForFail.burrowId,
        returnPath: pendingForFail.returnPath,
        catalogId: pendingForFail.catalogId,
        outcome: { error: code },
      });
    }
    return {
      location: withParams(returnPath ?? fallbackPath, { connect_error: code }, fallbackPath),
      connectionId: null,
    };
  };
  if (taken.kind !== 'taken' || !accountId) return fail('invalid_state');
  const pending = taken.row;
  const st = pendingState<OAuthPendingState>(services, pending);
  // RFC 9207: an `iss` must be the issuer the sign-in started with; a server that promises one must send it. Checked
  // before an `error` is acted on: an error from another server means nothing here (connection-signin.md SG-19d).
  if (st.issuer && (query.iss ? !sameIssuer(query.iss, st.issuer) : st.issParameter))
    return fail('issuer_mismatch');
  if (query.error) return fail(query.error === 'access_denied' ? 'access_denied' : 'exchange_failed');
  if (!query.code) return fail('invalid_state');
  const entry = catalogEntry(pending.catalogId);
  const viewer = pending.burrowId ? await viewerFor(services, accountId, pending.burrowId) : null;
  if (!entry || !viewer) return fail('invalid_state');
  const client = st.kind === 'app_oauth' ? await appClient(services, entry.id) : st.client;
  if (!client) return fail('no_app');

  let tokens: Awaited<ReturnType<typeof tokenRequest>>;
  try {
    tokens = await tokenRequest(
      services,
      st.tokenEndpoint,
      client,
      {
        grant_type: 'authorization_code',
        code: query.code,
        redirect_uri: st.redirectUri,
        code_verifier: st.verifier,
        ...(st.resource ? { resource: st.resource } : {}),
      },
      'connections.exchange',
    );
  } catch (err) {
    services.log.warn(
      { accountId, catalogId: entry.id, err: String(err) },
      'connection oauth: exchange failed',
    );
    // The server no longer knows Whombat's registration: the next sign-in registers afresh (SG-19b).
    if (st.kind === 'mcp_oauth' && err instanceof OAuthTokenError && err.code === 'invalid_client')
      await dropDeadRegistration(services, st.clientRef, client.clientId);
    return fail('exchange_failed');
  }
  const outcome = await runCatalogCheck(services, {
    entry,
    signIn: st.kind,
    baseUrl: st.baseUrl,
    mcpUrl: st.mcpUrl,
    fields: st.fields,
    credential: { headers: { Authorization: `Bearer ${tokens.accessToken}` }, query: {} },
  });
  if (!outcome.ok) {
    services.log.warn(
      { accountId, catalogId: entry.id, status: outcome.status },
      'connection oauth: check failed',
    );
    return fail('check_failed');
  }
  // A token answer that names no scopes holds what was asked (RFC 6749 §5.1: the scope is then as requested).
  if (!tokens.scopes.length && st.scope)
    tokens = { ...tokens, scopes: st.scope.split(/\s+/).filter((s) => s && s !== 'offline_access') };
  const credential = {
    signIn: st.kind,
    // What the check's answer fills (`fromCheck`, connection-signin.md SG-15a), as for every sign-in.
    fields: { ...st.fields, ...fieldsFromCheck(entry, outcome.json) },
    auth: null,
    secret: null,
    tokens,
    clientId: st.clientRef,
    issuer: st.issuer,
    resource: st.resource,
    externalName: externalNameFrom(outcome.json),
    checks: outcome.checks,
  };
  try {
    const existing = pending.connectionId ? await connectionRow(services.db, pending.connectionId) : null;
    const hasGuide = parseGuideReturn(pending.returnPath) !== null;
    let saved: { row: { id: string; label: string } };
    let reconnected = false;
    if (existing && isVisibleTo(existing, viewer)) {
      reconnected = true;
      saved = await saveReconnect(
        services,
        viewer,
        existing,
        { ...credential, baseUrl: st.baseUrl },
        { closeConnectCards: !hasGuide },
      );
    } else {
      await requireDestination(services, [st.baseUrl, st.mcpUrl]);
      saved = await saveNewConnection(services, viewer, {
        ...credential,
        entry,
        labelGiven: st.labelGiven,
        baseUrl: st.baseUrl,
        ...(st.access ? { access: st.access } : {}),
        closeConnectCards: !hasGuide,
      });
    }
    if (hasGuide && pending.burrowId) {
      await services.guides.afterConnectionOAuth({
        accountId,
        burrowId: pending.burrowId,
        returnPath: pending.returnPath,
        catalogId: entry.id,
        outcome: { connectionId: saved.row.id, label: saved.row.label, reconnected },
      });
    }
    services.log.info(
      { accountId, catalogId: entry.id, connectionId: saved.row.id },
      'catalog connection signed in',
    );
    return {
      location: withParams(
        pending.returnPath,
        { connected: entry.id, connection: saved.row.id },
        fallbackPath,
      ),
      connectionId: saved.row.id,
    };
  } catch (err) {
    const code =
      err instanceof ApiError ? (err.extra.details as { code?: string } | undefined)?.code : undefined;
    if (code === 'limit_reached' || code === 'destination_refused') return fail(code);
    services.log.warn(
      { accountId, catalogId: entry.id, err: String(err) },
      'connection oauth: saving failed',
    );
    return fail('exchange_failed');
  }
}
