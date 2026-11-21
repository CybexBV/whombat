/**
 * TanStack Query keys. Every read endpoint has a key `['whombat', endpointId, params, query]` with the
 * params and query normalised through the endpoint schemas (defaults applied), so equal requests share
 * a cache entry and filters can match on partial params (`{ conversationId }`). Infinite (paged)
 * variants append `'infinite'` and leave the page cursor out of the query.
 *
 * Client-only state that realtime maintains lives under the same root: the agent's thinking line.
 */
import type { DataTag, QueryKey } from '@tanstack/query-core';
import { type AnyEndpoint, api } from '@whombat/core/contracts';
import type { Api, ApiArea, CallInput, ReadEndpointOf, ResponseData } from '../http/types';

export const QUERY_ROOT = 'whombat';

export type Params = Record<string, unknown>;

export type EndpointKey<E extends AnyEndpoint> = DataTag<
  readonly [typeof QUERY_ROOT, string, Params, Params],
  ResponseData<E>,
  Error
>;

/** `params` / `query` of an endpoint call, as keys take them. */
export type KeyInput<E extends AnyEndpoint> = Pick<CallInput<E>, 'params' | 'query'>;

type KeyArgs<E extends AnyEndpoint> =
  Record<never, never> extends KeyInput<E> ? [input?: KeyInput<E>] : [input: KeyInput<E>];

function normalise(schema: AnyEndpoint['params'], value: unknown): Params {
  const r = schema.safeParse(value ?? {});
  const out = (r.success ? r.data : (value ?? {})) as Params;
  // Drop undefined so `{ before: undefined }` and `{}` share a key.
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/** Key of one endpoint call. */
export function endpointKey<E extends AnyEndpoint>(ep: E, input: KeyInput<E> = {} as KeyInput<E>) {
  const i = input as { params?: unknown; query?: unknown };
  return [
    QUERY_ROOT,
    ep.id,
    normalise(ep.params, i.params),
    normalise(ep.query, i.query),
  ] as unknown as EndpointKey<E>;
}

/** Key of the infinite (paged) variant: the `before` cursor is the page param, not part of the key. */
export function infiniteEndpointKey<E extends AnyEndpoint>(ep: E, input: KeyInput<E> = {} as KeyInput<E>) {
  const i = input as { params?: unknown; query?: unknown };
  const { before: _before, ...query } = normalise(ep.query, i.query);
  return [QUERY_ROOT, ep.id, normalise(ep.params, i.params), query, 'infinite'] as const;
}

/** Prefix matching every cached call of an endpoint, optionally narrowed by (partial) params. */
export function endpointScope(ep: AnyEndpoint | string, params?: Params): QueryKey {
  const id = typeof ep === 'string' ? ep : ep.id;
  return params ? [QUERY_ROOT, id, params] : [QUERY_ROOT, id];
}

export interface ParsedKey {
  endpointId: string;
  params: Params;
  query: Params;
  infinite: boolean;
}

/** Reads back a key built by `endpointKey` / `infiniteEndpointKey`; null for anything else. */
export function parseKey(key: QueryKey): ParsedKey | null {
  if (key[0] !== QUERY_ROOT || typeof key[1] !== 'string') return null;
  const params = key[2];
  const query = key[3];
  if (typeof params !== 'object' || params === null || typeof query !== 'object' || query === null)
    return null;
  return {
    endpointId: key[1],
    params: params as Params,
    query: query as Params,
    infinite: key[4] === 'infinite',
  };
}

/* Typed factories -------------------------------------------------------------------------------- */

export type QueryKeyFactories = {
  readonly [A in ApiArea]: {
    readonly [K in ReadEndpointOf<A>]: Api[A][K] extends AnyEndpoint
      ? (...args: KeyArgs<Api[A][K]>) => EndpointKey<Api[A][K]>
      : never;
  };
};

function buildFactories(): QueryKeyFactories {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [area, group] of Object.entries(api)) {
    const target: Record<string, unknown> = {};
    for (const [action, ep] of Object.entries(group as Record<string, AnyEndpoint>)) {
      if (ep.method === 'GET') target[action] = (input?: KeyInput<AnyEndpoint>) => endpointKey(ep, input);
    }
    out[area] = target;
  }
  return out as unknown as QueryKeyFactories;
}

/** Local (realtime-maintained) state. */
export interface TypingEntry {
  principalId: string;
  threadRootId: string | null;
  /** The agent's turn that thinks (contracts 0.55, CT-295): what Stop cancels. Absent for older servers. */
  dispatchId?: string;
  /** Local clock (ms) after which the indicator disappears unless refreshed. */
  expiresAt: number;
}

/**
 * What an agent is doing in a conversation (or one of its threads), from `activity.updated` (AP-734): the latest
 * action of its current turn, and when that turn's first action started. Shown beside “{name} is thinking”.
 */
export interface AgentNowEntry {
  principalId: string;
  threadRootId: string | null;
  dispatchId: string;
  /** “Editing Layout.astro”, “Running pnpm test”. */
  title: string;
  status: 'running' | 'waiting' | 'done' | 'failed' | 'interrupted';
  /** The action's sequence in its turn: orders two reports of the same moment. */
  seq: number;
  /** Server time (ms) the turn's first action started: the indicator's “1m 12s”. */
  since: number;
  /** Server time (ms) of this action. */
  at: number;
}

export const queryKeys = {
  ...buildFactories(),
  /** Everything Whombat caches. */
  all: [QUERY_ROOT] as const,
  endpoint: endpointKey,
  infinite: infiniteEndpointKey,
  scope: endpointScope,
  /** Typing / thinking indicators of a conversation (all threads). */
  typing: (conversationId: string) =>
    [QUERY_ROOT, 'typing', { conversationId }] as unknown as DataTag<QueryKey, TypingEntry[], Error>,
  /** What agents are doing in a conversation (all threads), newest action per agent and thread. */
  agentNow: (conversationId: string) =>
    [QUERY_ROOT, 'agentNow', { conversationId }] as unknown as DataTag<QueryKey, AgentNowEntry[], Error>,
};
