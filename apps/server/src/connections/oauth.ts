/**
 * OAuth plumbing of catalog sign-ins (CX-12…CX-15; MCP authorization revision 2026-07-28, CT-268):
 * - the `WWW-Authenticate` challenge (RFC 6750 / RFC 9728 `resource_metadata`);
 * - protected-resource metadata (RFC 9728) and authorization-server metadata (RFC 8414, OpenID discovery), with the
 *   issuer checked to be the one asked for;
 * - dynamic client registration (RFC 7591) for servers without Client ID Metadata Documents;
 * - the token endpoint (authorization code with PKCE and `resource`, refresh) and revocation (RFC 7009).
 *
 * Every request goes through `connectionFetch` (the destination policy, no redirects, a deadline).
 */
import type { Services } from '../services';
import { connectionFetch, formBody, jsonOf } from './http';

/* The challenge ------------------------------------------------------------------------------------ */

export interface BearerChallenge {
  scheme: string;
  resourceMetadata: string | null;
  scope: string | null;
  error: string | null;
}

/** Parses `Bearer realm="…", resource_metadata="…", scope="a b"` (quoted or token values). */
export function parseWwwAuthenticate(header: string): BearerChallenge | null {
  const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*(.*)$/s.exec(header);
  if (!m?.[1]) return null;
  const params: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const p of (m[2] ?? '').matchAll(re)) {
    const key = (p[1] as string).toLowerCase();
    if (!(key in params)) params[key] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : (p[3] ?? '');
  }
  return {
    scheme: m[1],
    resourceMetadata: params.resource_metadata ?? null,
    scope: params.scope ?? null,
    error: params.error ?? null,
  };
}

/* Discovery ---------------------------------------------------------------------------------------- */

/** RFC 9728 §3.1: the well-known address inserted before the path, then at the root. */
export function protectedResourceCandidates(resourceUrl: string): string[] {
  const u = new URL(resourceUrl);
  const path = u.pathname.replace(/\/+$/, '');
  const root = `${u.origin}/.well-known/oauth-protected-resource`;
  return path ? [`${root}${path}`, root] : [root];
}

/** RFC 8414 §3.1 and OpenID discovery, path-inserted first (as the MCP authorization spec orders them). */
export function authServerCandidates(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, '');
  if (!path)
    return [
      `${u.origin}/.well-known/oauth-authorization-server`,
      `${u.origin}/.well-known/openid-configuration`,
    ];
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Why discovery or a token call failed, in words for the form. */
export class OAuthFlowError extends Error {
  constructor(
    readonly code: 'discovery' | 'no_pkce' | 'no_registration' | 'registration' | 'exchange',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

export interface ProtectedResource {
  /** The resource identifier tokens are asked for (`resource`). */
  resource: string;
  issuer: string;
  scopes: string[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** Protected-resource metadata of an MCP server: from the challenge's `resource_metadata`, else the well-known one. */
export async function discoverProtectedResource(
  services: Services,
  mcpUrl: string,
  metadataUrl: string | null,
): Promise<ProtectedResource | null> {
  const candidates = metadataUrl ? [metadataUrl] : protectedResourceCandidates(mcpUrl);
  for (const url of candidates) {
    let res: Awaited<ReturnType<typeof connectionFetch>>;
    try {
      res = await connectionFetch(services, url, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
      continue;
    }
    if (res.status !== 200) continue;
    const doc = jsonOf(res) as Record<string, unknown> | null;
    const resource = str(doc?.resource);
    const issuer = strings(doc?.authorization_servers)[0];
    if (!resource || !issuer) continue;
    // The metadata must describe this server (RFC 9728 §3.3): same origin, and a resource the URL lives under.
    let ok = false;
    try {
      const r = new URL(resource);
      const m = new URL(mcpUrl);
      ok = r.origin === m.origin && m.pathname.startsWith(r.pathname.replace(/\/+$/, ''));
    } catch {
      ok = false;
    }
    if (!ok) continue;
    return { resource, issuer, scopes: strings(doc?.scopes_supported) };
  }
  return null;
}

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  /** `client_id_metadata_document_supported`. */
  clientMetadataDocuments: boolean;
  /** RFC 9207: the authorization response carries `iss`. */
  issParameter: boolean;
  pkceS256: boolean;
  scopes: string[];
}

const metadataCache = new WeakMap<Services, Map<string, { at: number; meta: AuthServerMetadata }>>();
const METADATA_TTL_MS = 60 * 60_000;

/** The authorization server's metadata (cached an hour); throws `OAuthFlowError` when there is none to trust. */
export async function discoverAuthServer(services: Services, issuer: string): Promise<AuthServerMetadata> {
  let cache = metadataCache.get(services);
  if (!cache) {
    cache = new Map();
    metadataCache.set(services, cache);
  }
  const hit = cache.get(issuer);
  if (hit && services.clock().getTime() - hit.at < METADATA_TTL_MS) return hit.meta;
  for (const url of authServerCandidates(issuer)) {
    let res: Awaited<ReturnType<typeof connectionFetch>>;
    try {
      res = await connectionFetch(services, url, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
      continue;
    }
    if (res.status !== 200) continue;
    const doc = jsonOf(res) as Record<string, unknown> | null;
    const found = str(doc?.issuer);
    const authorizationEndpoint = str(doc?.authorization_endpoint);
    const tokenEndpoint = str(doc?.token_endpoint);
    // RFC 8414 §3.3: the issuer in the document must be the one asked for.
    if (!found || !sameIssuer(found, issuer) || !authorizationEndpoint || !tokenEndpoint) continue;
    const meta: AuthServerMetadata = {
      issuer: found,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: str(doc?.registration_endpoint),
      revocationEndpoint: str(doc?.revocation_endpoint),
      clientMetadataDocuments: doc?.client_id_metadata_document_supported === true,
      issParameter: doc?.authorization_response_iss_parameter_supported === true,
      pkceS256: strings(doc?.code_challenge_methods_supported).includes('S256'),
      scopes: strings(doc?.scopes_supported),
    };
    cache.set(issuer, { at: services.clock().getTime(), meta });
    return meta;
  }
  throw new OAuthFlowError('discovery', 'Whombat couldn’t find how this server signs in.');
}

/* Clients ------------------------------------------------------------------------------------------ */

export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface OAuthClient {
  clientId: string;
  clientSecret?: string | null;
  authMethod: ClientAuthMethod;
  /** A dynamic registration: the scope it was registered with (null: none sent; absent: registered before SG-19a). */
  scope?: string | null;
}

const OFFLINE_ACCESS = 'offline_access';

const scopeHas = (scope: string | null | undefined, wanted: string) =>
  (scope ?? '').split(/\s+/).includes(wanted);

/**
 * The scope with `offline_access` when the authorization server lists it and the scope lacks it (connection-signin.md
 * SG-19a): some servers (Vercel's) issue a refresh token only then. A sign-in that asks no scope stays without one:
 * `offline_access` alone could narrow what the server grants (SG-S42).
 */
export function withOfflineAccess(scope: string | null, supported: readonly string[]): string | null {
  if (!scope || !supported.includes(OFFLINE_ACCESS) || scopeHas(scope, OFFLINE_ACCESS)) return scope;
  return `${scope.trim()} ${OFFLINE_ACCESS}`;
}

/**
 * The scope an MCP sign-in asks: the server's own (its challenge's, or what its metadata lists), then what the entry
 * asks besides (Cloudflare's list, so its consent page shows exactly that), then on a reconnect what the connection
 * holds and what a call needed since (step-up: what was allowed before stays). Null when nothing is asked.
 */
export function mcpSignInScope(server: string | null, extra: readonly string[]): string | null {
  const all = [...(server ?? '').split(/\s+/), ...extra].filter((s) => s && s !== OFFLINE_ACCESS);
  const unique = [...new Set(all)];
  return unique.length ? unique.join(' ') : null;
}

/** Whether a scope asks for `offline_access`. */
export const asksOfflineAccess = (scope: string | null | undefined) => scopeHas(scope, OFFLINE_ACCESS);

/** A redirect back to this machine itself (`localhost`, `127.0.0.1`, `[::1]`): an OAuth “native” client's. */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * Why a registration was refused, in words (SG-19e): MCP servers take only https redirects (or loopback ones), so a
 * Whombat at a plain http address is the likely reason.
 */
export function registrationRefusedText(redirectUris: readonly string[]): string {
  return redirectUris.some((uri) => uri.startsWith('http:') && !isLoopbackRedirect(uri))
    ? 'Signing in needs this Whombat at an https address.'
    : 'This server didn’t let Whombat register.';
}

/**
 * RFC 7591: registers Whombat as a public client (or whatever the server insists on) for these redirect URIs, as a
 * `web` application, or `native` for a loopback redirect (MCP 2026-07-28 asks for `application_type`, SG-19c).
 */
export async function registerClient(
  services: Services,
  registrationEndpoint: string,
  input: { redirectUris: string[]; clientUri: string; scope?: string | null },
): Promise<OAuthClient> {
  const res = await connectionFetch(
    services,
    registrationEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Whombat',
        client_uri: input.clientUri,
        redirect_uris: input.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: input.redirectUris.every(isLoopbackRedirect) ? 'native' : 'web',
        ...(input.scope ? { scope: input.scope } : {}),
      }),
    },
    // Registering again is harmless (another client id; the newest is kept).
    { effect: 'connections.register_client', idempotent: true },
  );
  const doc = jsonOf(res) as Record<string, unknown> | null;
  const clientId = str(doc?.client_id);
  if (res.status < 200 || res.status >= 300 || !clientId)
    throw new OAuthFlowError('registration', registrationRefusedText(input.redirectUris));
  const secret = str(doc?.client_secret);
  const method = str(doc?.token_endpoint_auth_method);
  const authMethod: ClientAuthMethod = secret
    ? method === 'client_secret_post'
      ? 'client_secret_post'
      : 'client_secret_basic'
    : 'none';
  return { clientId, clientSecret: secret, authMethod, scope: input.scope ?? null };
}

/* Tokens ------------------------------------------------------------------------------------------- */

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

/** The token endpoint refused: `invalid_grant` (the grant is dead), `invalid_client`, or anything else. */
export class OAuthTokenError extends Error {
  constructor(
    readonly code: 'invalid_grant' | 'invalid_client' | 'access_denied' | 'other',
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthTokenError';
  }
}

function clientAuth(
  client: OAuthClient,
  params: Record<string, string | undefined | null>,
): { params: Record<string, string | undefined | null>; headers: Record<string, string> } {
  if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
    const basic = Buffer.from(
      `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`,
    ).toString('base64');
    return { params, headers: { authorization: `Basic ${basic}` } };
  }
  return {
    params: {
      ...params,
      client_id: client.clientId,
      ...(client.authMethod === 'client_secret_post' && client.clientSecret
        ? { client_secret: client.clientSecret }
        : {}),
    },
    headers: {},
  };
}

/** One token-endpoint call (authorization code or refresh). Throws `OAuthTokenError` or `OutboundError`. */
export async function tokenRequest(
  services: Services,
  tokenEndpoint: string,
  client: OAuthClient,
  params: Record<string, string | undefined | null>,
  effect = 'connections.token',
): Promise<TokenSet> {
  const auth = clientAuth(client, params);
  const res = await connectionFetch(
    services,
    tokenEndpoint,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        ...auth.headers,
      },
      body: formBody(auth.params),
    },
    // A code is single-use and a refresh may rotate the refresh token: neither may be repeated blindly.
    { effect, idempotent: false },
  );
  const doc = (jsonOf(res) ?? {}) as Record<string, unknown>;
  if (res.status < 200 || res.status >= 300) {
    const error = str(doc.error);
    const code =
      error === 'invalid_grant'
        ? 'invalid_grant'
        : error === 'invalid_client' || error === 'unauthorized_client'
          ? 'invalid_client'
          : error === 'access_denied'
            ? 'access_denied'
            : 'other';
    throw new OAuthTokenError(
      code,
      res.status,
      `The token endpoint answered ${res.status}${error ? ` (${error})` : ''}.`,
    );
  }
  const accessToken = str(doc.access_token);
  if (!accessToken)
    throw new OAuthTokenError('other', res.status, 'The token endpoint sent no access token.');
  const expiresIn = typeof doc.expires_in === 'number' ? doc.expires_in : Number(doc.expires_in);
  return {
    accessToken,
    refreshToken: str(doc.refresh_token),
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(services.clock().getTime() + expiresIn * 1000)
        : null,
    scopes: (str(doc.scope) ?? '').split(/\s+/).filter(Boolean),
  };
}

/** RFC 7009 revocation, best effort: failures are logged, never thrown. */
export async function revokeToken(
  services: Services,
  endpoint: string,
  client: OAuthClient | null,
  token: string,
  hint: 'refresh_token' | 'access_token',
): Promise<void> {
  try {
    const auth = client
      ? clientAuth(client, { token, token_type_hint: hint })
      : { params: { token, token_type_hint: hint }, headers: {} };
    await connectionFetch(
      services,
      endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...auth.headers },
        body: formBody(auth.params),
      },
      { effect: 'connections.revoke' },
    );
  } catch (err) {
    services.log.warn({ endpoint, err: String(err) }, 'connection token revoke failed');
  }
}
