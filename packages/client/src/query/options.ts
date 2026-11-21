/**
 * `createQueries(client)` — `queryOptions`-style factories for every read endpoint:
 * `useQuery(queries.runs.get({ params: { burrow, number } }))`. Paged lists also have infinite variants
 * (`messages.listInfinite`, `audit.listInfinite`, `approvals.listInfinite`, `chats.threadsInfinite`) whose page param
 * is the `before` cursor; page 0 is the newest page.
 */
import type { DataTag, InfiniteData, QueryFunctionContext } from '@tanstack/query-core';
import {
  type AnyEndpoint,
  type Approval,
  type AuditPage,
  api,
  type ChatThreadsResponse,
  type MessagePage,
} from '@whombat/core';
import type { WhombatClient } from '../http/client';
import type { Api, ApiArea, CallInput, ReadEndpointOf, ResponseData } from '../http/types';
import { type EndpointKey, endpointKey, infiniteEndpointKey, type KeyInput } from './keys';

export interface EndpointQueryOptions<E extends AnyEndpoint> {
  queryKey: EndpointKey<E>;
  queryFn: (ctx: QueryFunctionContext) => Promise<ResponseData<E>>;
}

type OptionArgs<E extends AnyEndpoint> =
  Record<never, never> extends KeyInput<E> ? [input?: KeyInput<E>] : [input: KeyInput<E>];

export type QueryOptionFactories = {
  readonly [A in ApiArea]: {
    readonly [K in ReadEndpointOf<A>]: Api[A][K] extends AnyEndpoint
      ? (...args: OptionArgs<Api[A][K]>) => EndpointQueryOptions<Api[A][K]>
      : never;
  };
};

export interface EndpointInfiniteOptions<E extends AnyEndpoint, Page> {
  queryKey: DataTag<ReturnType<typeof infiniteEndpointKey<E>>, InfiniteData<Page, string | undefined>, Error>;
  queryFn: (ctx: QueryFunctionContext<readonly unknown[], string | undefined>) => Promise<Page>;
  initialPageParam: string | undefined;
  getNextPageParam: (last: Page) => string | undefined;
}

/** Input of an infinite list: the call's params and query without the `before` cursor. */
export type ListInput<E extends AnyEndpoint> = Omit<KeyInput<E>, 'query'> & {
  query?: Omit<NonNullable<KeyInput<E>['query']>, 'before'>;
};

/** A page of `approvals.list`. */
export type ApprovalPage = { approvals: Approval[]; before: string | null };

export function createQueries(client: WhombatClient) {
  function options<E extends AnyEndpoint>(
    ep: E,
    input: KeyInput<E> = {} as KeyInput<E>,
  ): EndpointQueryOptions<E> {
    return {
      queryKey: endpointKey(ep, input),
      queryFn: async ({ signal }) => {
        const result = await client.request(ep, { ...input, signal } as CallInput<E>);
        if (result.status !== 'ok') throw new Error(`Unexpected ${result.status} from ${ep.id}`);
        return result.data;
      },
    };
  }

  function infinite<E extends AnyEndpoint, Page>(
    ep: E,
    input: ListInput<E>,
    next: (page: Page) => string | undefined,
  ): EndpointInfiniteOptions<E, Page> {
    const base = input as { params?: unknown; query?: Record<string, unknown> };
    return {
      queryKey: infiniteEndpointKey(ep, input as KeyInput<E>) as EndpointInfiniteOptions<E, Page>['queryKey'],
      queryFn: async ({ signal, pageParam }) => {
        const call = { params: base.params, query: { ...base.query, before: pageParam }, signal };
        const result = await client.request(ep, call as unknown as CallInput<E>);
        if (result.status !== 'ok') throw new Error(`Unexpected ${result.status} from ${ep.id}`);
        return result.data as Page;
      },
      initialPageParam: undefined,
      getNextPageParam: next,
    };
  }

  const factories: Record<string, Record<string, unknown>> = {};
  for (const [area, group] of Object.entries(api)) {
    const target: Record<string, unknown> = {};
    for (const [action, ep] of Object.entries(group as Record<string, AnyEndpoint>)) {
      if (ep.method === 'GET') target[action] = (input?: KeyInput<AnyEndpoint>) => options(ep, input);
    }
    factories[area] = target;
  }
  const typed = factories as unknown as QueryOptionFactories;

  return {
    ...typed,
    /** Options for any endpoint definition. */
    endpoint: options,
    messages: {
      ...typed.messages,
      /** Conversation history, newest page first; `fetchNextPage()` loads older messages. */
      listInfinite: (input: ListInput<typeof api.messages.list>) =>
        infinite<typeof api.messages.list, MessagePage>(api.messages.list, input, (p) =>
          p.hasMore && p.before ? p.before : undefined,
        ),
    },
    audit: {
      ...typed.audit,
      /** Audit log pages, newest first. */
      listInfinite: (input: ListInput<typeof api.audit.list>) =>
        infinite<typeof api.audit.list, AuditPage>(api.audit.list, input, (p) =>
          p.hasMore && p.before ? p.before : undefined,
        ),
    },
    chats: {
      ...typed.chats,
      /** A room's threads, newest activity first; `fetchNextPage()` loads older ones (`next`, app chat-channel.md AP-2408). */
      threadsInfinite: (input: ListInput<typeof api.chats.threads>) =>
        infinite<typeof api.chats.threads, ChatThreadsResponse>(
          api.chats.threads,
          input,
          (p) => p.next ?? undefined,
        ),
    },
    approvals: {
      ...typed.approvals,
      listInfinite: (input: ListInput<typeof api.approvals.list>) =>
        infinite<typeof api.approvals.list, ApprovalPage>(
          api.approvals.list,
          input,
          (p) => p.before ?? undefined,
        ),
    },
  };
}

export type WhombatQueries = ReturnType<typeof createQueries>;
