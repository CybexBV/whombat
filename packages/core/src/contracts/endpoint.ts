/**
 * A tiny typed endpoint helper. Each endpoint is plain data (`method`, `path`, Zod schemas for `params`,
 * `query`, `body` and `response`) that the server registers as a route and the client calls through
 * `@whombat/client`. Paths use `:param` segments (Fastify style) and are relative to `base`.
 */
import { z } from 'zod';

/** Prefix of the public REST API. */
export const API_PREFIX = '/api/v1';
/** Prefix of the runner-only API (runner token). */
export const RUNNER_PREFIX = '/internal/runner';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Who may call the endpoint:
 * - `none`: public.
 * - `session`: a person on an enrolled device (the session's endpoint, `@whombat/protocol/session`).
 * - `runner`: the agent runner (runner token).
 */
export type EndpointAuth = 'none' | 'session' | 'runner';

export const NoParams = z.object({});
export const NoQuery = z.object({});
export const NoBody = z.undefined();

/** Names of `:param` segments in a path, as a union type. */
export type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

export interface Endpoint<
  M extends HttpMethod = HttpMethod,
  P extends string = string,
  Params extends z.ZodType = z.ZodType,
  Query extends z.ZodType = z.ZodType,
  Body extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  /** Stable identifier, `area.action`. */
  id: string;
  method: M;
  /** Relative to `base`, e.g. `/burrows/:burrow/runs/:number`. */
  path: P;
  base: string;
  summary: string;
  auth: EndpointAuth;
  params: Params;
  query: Query;
  body: Body;
  response: Res;
  /** Success status. Mutations that go through the keys engine may also answer 202 or 403 (see errors). */
  status: 200 | 201 | 202 | 204;
  /** `text/csv` endpoints return the body as a string. */
  contentType: 'application/json' | 'text/csv';
}

export function endpoint<
  const M extends HttpMethod,
  const P extends string,
  Res extends z.ZodType,
  Params extends z.ZodType = typeof NoParams,
  Query extends z.ZodType = typeof NoQuery,
  Body extends z.ZodType = typeof NoBody,
>(def: {
  id: string;
  method: M;
  path: P;
  summary: string;
  response: Res;
  base?: string;
  auth?: EndpointAuth;
  params?: Params;
  query?: Query;
  body?: Body;
  status?: 200 | 201 | 202 | 204;
  contentType?: 'application/json' | 'text/csv';
}): Endpoint<M, P, Params, Query, Body, Res> {
  return {
    id: def.id,
    method: def.method,
    path: def.path,
    base: def.base ?? API_PREFIX,
    summary: def.summary,
    auth: def.auth ?? 'session',
    params: (def.params ?? NoParams) as Params,
    query: (def.query ?? NoQuery) as Query,
    body: (def.body ?? NoBody) as Body,
    response: def.response,
    status: def.status ?? 200,
    contentType: def.contentType ?? 'application/json',
  };
}

export type AnyEndpoint = Endpoint<HttpMethod, string, z.ZodType, z.ZodType, z.ZodType, z.ZodType>;

export type EndpointParams<E extends AnyEndpoint> = z.input<E['params']>;
export type EndpointQuery<E extends AnyEndpoint> = z.input<E['query']>;
export type EndpointBody<E extends AnyEndpoint> = z.input<E['body']>;
export type EndpointResponse<E extends AnyEndpoint> = z.output<E['response']>;

/** `:param` names in a path, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

/** Fills `:param` segments (URL-encoded). Throws if one is missing. */
export function buildPath(path: string, params: Record<string, string | number> = {}): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new Error(`Missing path param "${name}" for ${path}`);
    return encodeURIComponent(String(value));
  });
}

/** Query string from a flat object (`undefined`/`null` skipped, arrays repeated). Empty → ''. */
export function toQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Full URL path of an endpoint call: base + filled path + query string. */
export function endpointUrl<E extends AnyEndpoint>(
  ep: E,
  params?: Record<string, string | number>,
  query?: Record<string, unknown>,
): string {
  return `${ep.base}${buildPath(ep.path, params)}${toQueryString(query)}`;
}

/** Matches a concrete path (relative to `base`) against an endpoint path; returns raw params or null. */
export function matchPath(path: string, concrete: string): Record<string, string> | null {
  const a = path.split('/');
  const b = concrete.split('?')[0]?.split('/') ?? [];
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i] as string;
    const val = b[i] as string;
    if (seg.startsWith(':')) {
      if (!val) return null;
      params[seg.slice(1)] = decodeURIComponent(val);
    } else if (seg !== val) return null;
  }
  return params;
}

/* Shared param / query schemas ------------------------------------------------------------------ */

/** Path segment of the burrow (its slug). */
export const BurrowParam = z.string().min(1).max(63);
/** Positive integer path segment (`/runs/:number`). */
export const NumberParam = z.coerce.number().int().positive();

/**
 * `?flag=true` style booleans. A boolean passes too: the apps parse a query before they send it over the session, so
 * the box reads `true`, never the text the address would carry.
 */
export const QueryBool = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'),
]);

/** Page size, 1–200 (default per endpoint). */
export function limitQuery(defaultLimit: number, max = 200) {
  return z.coerce.number().int().min(1).max(max).default(defaultLimit);
}
