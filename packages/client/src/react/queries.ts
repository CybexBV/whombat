/**
 * One typed hook per read endpoint. Pass the call's `{ params, query }`, or null/undefined to wait
 * (the query stays disabled until the input is known):
 *
 *   const { data } = useRun(burrow ? { params: { burrow, number } } : null);
 */
import {
  type QueryKey,
  skipToken,
  type UseInfiniteQueryOptions,
  type UseQueryOptions,
  useInfiniteQuery,
  useQueries,
  useQuery,
} from '@tanstack/react-query';
import type { Bootstrap, SearchResult } from '@whombat/core';
import { type AnyEndpoint, type AuditPage, api, type MessagePage } from '@whombat/core/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../http/errors';
import type { ResponseData } from '../http/types';
import { type KeyInput, QUERY_ROOT } from '../query/keys';
import type { ListInput, WhombatQueries } from '../query/options';
import { searchKeepsLoading, searchWalk, searchWalkResults } from '../query/searchPages';
import { useWhombat } from './context';
import { useScreenFocusEnabled } from './screenFocus';

export type QueryHookOptions<E extends AnyEndpoint> = Omit<
  UseQueryOptions<ResponseData<E>, Error, ResponseData<E>, QueryKey>,
  'queryKey' | 'queryFn'
>;

export type QueryHook<E extends AnyEndpoint> = ((
  input: KeyInput<E> | null | undefined,
  options?: QueryHookOptions<E>,
) => ReturnType<typeof useQuery<ResponseData<E>, Error>>) & { readonly endpoint: E };

/** Build a query hook for any GET endpoint definition. */
export function queryHook<E extends AnyEndpoint>(ep: E): QueryHook<E> {
  function useEndpointQuery(input: KeyInput<E> | null | undefined, options?: QueryHookOptions<E>) {
    const { queries } = useWhombat();
    const base: Pick<
      UseQueryOptions<ResponseData<E>, Error, ResponseData<E>, QueryKey>,
      'queryKey' | 'queryFn'
    > = input
      ? queries.endpoint(ep, input)
      : { queryKey: [QUERY_ROOT, ep.id, 'waiting'], queryFn: skipToken };
    const enabled = useScreenFocusEnabled(options?.enabled, base.queryKey);
    return useQuery<ResponseData<E>, Error, ResponseData<E>, QueryKey>({
      ...options,
      ...base,
      ...(enabled === undefined ? {} : { enabled }),
    });
  }
  return Object.assign(useEndpointQuery, { endpoint: ep });
}

export const useHealth = queryHook(api.health.get);
export const useMe = queryHook(api.me.get);
export const usePreferences = queryHook(api.me.getPreferences);
export const useSlugCheck = queryHook(api.burrows.slugCheck);
export const useBurrow = queryHook(api.burrows.get);
export const useOnboarding = queryHook(api.onboarding.get);
export const useRepos = queryHook(api.repos.list);
export const useGitHubStatus = queryHook(api.github.status);
/**
 * A GitHub owner's picture as a `data:` URL (contracts 0.72 CT-328, `github.avatar`): the Automations list's tile. Ask
 * only on a Whombat with `automations.glance`; `image` null means draw the GitHub mark.
 */
export const useGitHubAvatar = queryHook(api.github.avatar);
export const useBootstrap = queryHook(api.conversations.bootstrap);

/**
 * A part of the burrow's bootstrap, from `useBootstrap`'s query: the caller renders again only when that part changes
 * (an equal result stays the same object), not on every sidebar, unread or presence change. Pass a stable `select` (a
 * function at module level).
 */
export function useBootstrapSelect<T>(burrow: string, select: (bootstrap: Bootstrap) => T): T | undefined {
  const { queries } = useWhombat();
  return useQuery({ ...queries.endpoint(api.conversations.bootstrap, { params: { burrow } }), select }).data;
}
export const useConversation = queryHook(api.conversations.get);
export const useThread = queryHook(api.messages.thread);
/** A conversation's pinned messages, newest pin first (contracts CT-174). */
export const usePins = queryHook(api.conversations.pins);
export const usePullRequest = queryHook(api.prs.get);
/** A pull request's file, whole, with its removed and added lines (CT-241). */
export const usePullRequestFile = queryHook(api.prs.file);
export const useRuns = queryHook(api.runs.list);
export const useRun = queryHook(api.runs.get);
export const useApprovals = queryHook(api.approvals.list);
export const useApproval = queryHook(api.approvals.get);
/** Shared plans (work-supervision WS-01…WS-10): a conversation's plans, one plan. */
export const usePlans = queryHook(api.plans.list);
export const usePlan = queryHook(api.plans.get);
/** Observed activity of a run, a turn or a conversation (WS-11…WS-17). */
export const useActivity = queryHook(api.activity.list);
/** Recorded deploys, newest first, by environment/service (CT-296; WE-17). */
export const useDeployments = queryHook(api.deployments.list);
/** What is live where: per environment, per service the current, failed and previous deploy (CT-296; WE-17). */
export const useDeployEnvironments = queryHook(api.deployments.environments);

/**
 * Whether “Deploys” shows (work-removal.md AP-850): the Whombat has `deployments` and has recorded a deploy (the
 * board has an environment). The board's own read, so the page finds it in the cache; live through
 * `deployment.recorded`. Quietly no on a refusal or before the answer.
 */
export function useShowsDeploys(burrow: string, has: boolean): boolean {
  const { data } = useDeployEnvironments(has ? { params: { burrow } } : null, { retry: false });
  return has && (data?.environments.length ?? 0) > 0;
}
/** The Whombat's one agent (`agent.get`, Whombat one-agent.md OA-09). */
export const useAgent = queryHook(api.agent.get);
export const useSearch = queryHook(api.search.query);
export const useCanvases = queryHook(api.canvases.list);
export const useCanvas = queryHook(api.canvases.get);
export const useHostInfo = queryHook(api.host.info);
export const useAgentSetup = queryHook(api.host.agents);
/** The Google app, the guided setup facts and my connections (Settings → Connections). */
export const useConnectors = queryHook(api.connectors.status);
/**
 * The connections catalog (contracts 0.48.0, Whombat connections-catalog.md CX-70…CX-72): which entries this Whombat
 * offers (an `app_oauth` entry needs its app), the burrow's shared connections with the caller's personal ones, and one
 * connection's tools with their tiers. Feature `connections.catalog`.
 */
export const useConnectionsCatalog = queryHook(api.connections.catalog);
export const useCatalogConnections = queryHook(api.connections.list);
export const useConnectionTools = queryHook(api.connections.tools);
/**
 * A 1Password connection's page part (Whombat onepassword-sync.md): the last pass's stored state, never a call to
 * 1Password. Only on a box at session minor 8 or later, the only ones that offer 1Password.
 */
export const useOnePassword = queryHook(api.connections.onePassword);
/** Supervised automations (docs/decisions/bp-automations.md). */
export const useAutomations = queryHook(api.automations.list);
export const useAutomation = queryHook(api.automations.get);
export const useAutomationRuns = queryHook(api.automations.runs);
export const useAutomationRun = queryHook(api.automations.run);
/**
 * The Vault (docs/decisions/vault.md): the caller's own entries, one entry with its tools, keys and RECENT USE, and the
 * home network list.
 */
export const useVault = queryHook(api.vault.list);
export const useVaultEntry = queryHook(api.vault.get);
export const useVaultNetworks = queryHook(api.vaultNetworks.list);
/** Whombat Feedback: integrations and one report (docs/decisions/feedback.md). */
export const useFeedbackIntegrations = queryHook(api.feedback.listIntegrations);
export const useFeedbackIntegration = queryHook(api.feedback.getIntegration);
export const useFeedbackReport = queryHook(api.feedback.getReport);
/** Provider sign-ins (CT-70): the person's sign-ins, open attempts and consoles. */
export const useSignIns = queryHook(api.signins.list);
/** The AI clients on this Whombat (Claude Code): installed and latest tested versions, install progress (CT-72). */
export const useClients = queryHook(api.clients.list);

/**
 * Spend (spend.md SP-01, SP-02): Settings → AI → Spend and the agent profile's “This week” line. No realtime frames carry
 * spend, so both read again every time a screen showing them opens (`refetchOnMount: 'always'`).
 */
function freshOnMount<E extends AnyEndpoint>(hook: QueryHook<E>): QueryHook<E> {
  return Object.assign(
    (input: KeyInput<E> | null | undefined, options?: QueryHookOptions<E>) =>
      hook(input, { refetchOnMount: 'always', ...options }),
    { endpoint: hook.endpoint },
  );
}
export const useSpendOverview = freshOnMount(queryHook(api.spend.overview));
/** The agent's week (`spend.week`, was `spend.agent`; Whombat one-agent.md OA-19). */
export const useAgentSpend = freshOnMount(queryHook(api.spend.week));
/**
 * Turns and tokens per day, 30 days, today last (`spend.daily`, contracts 0.78 CT-334; Whombat box-status.md BS-07): the
 * Tokens card of Settings → This Whombat → “How it’s doing”. Ask only on a Whombat with `host.metrics`.
 */
export const useSpendDaily = freshOnMount(queryHook(api.spend.daily));

/*
 * Backup files (contracts 0.79 CT-335; backup-file.md AP-1181…): on a Whombat with `backup.file`. The
 * estimate is read again whenever the download panel opens (what a burrow holds changes without a frame); the list
 * follows `backups.changed` (and `useBackupFiles` reads the list every second while something runs).
 */
export const useBackupDefaults = queryHook(api.backups.defaults);
export const useBackupEstimate = freshOnMount(queryHook(api.backups.estimate));
export const useBackupList = queryHook(api.backups.list);

/* Infinite lists --------------------------------------------------------------------------------- */

type InfiniteHookOptions<Page> = Omit<
  UseInfiniteQueryOptions<
    Page,
    Error,
    { pages: Page[]; pageParams: (string | undefined)[] },
    QueryKey,
    string | undefined
  >,
  'queryKey' | 'queryFn' | 'initialPageParam' | 'getNextPageParam'
>;

interface InfiniteFactoryOptions<Page> {
  queryKey: QueryKey;
  queryFn: (ctx: never) => Promise<Page>;
  initialPageParam: string | undefined;
  getNextPageParam: (page: Page) => string | undefined;
}

function useInfiniteList<Input, Page>(
  pick: (q: WhombatQueries) => (input: Input) => InfiniteFactoryOptions<Page>,
  input: Input | null | undefined,
  options?: InfiniteHookOptions<Page>,
) {
  const { queries } = useWhombat();
  const base = input
    ? pick(queries)(input)
    : {
        queryKey: [QUERY_ROOT, 'infinite', 'waiting'] as QueryKey,
        queryFn: skipToken,
        initialPageParam: undefined,
        getNextPageParam: () => undefined,
      };
  const enabled = useScreenFocusEnabled(options?.enabled, base.queryKey);
  return useInfiniteQuery({
    ...options,
    ...base,
    ...(enabled === undefined ? {} : { enabled }),
  } as UseInfiniteQueryOptions<
    Page,
    Error,
    { pages: Page[]; pageParams: (string | undefined)[] },
    QueryKey,
    string | undefined
  >);
}

/** Conversation history: `data.pages[0]` is the newest page; `fetchNextPage()` loads older messages. */
export function useMessagesInfinite(
  input: ListInput<typeof api.messages.list> | null | undefined,
  options?: InfiniteHookOptions<MessagePage>,
) {
  return useInfiniteList((q) => q.messages.listInfinite, input, options);
}

/** Audit log pages, newest first. */
export function useAuditLogInfinite(
  input: ListInput<typeof api.audit.list> | null | undefined,
  options?: InfiniteHookOptions<AuditPage>,
) {
  return useInfiniteList((q) => q.audit.listInfinite, input, options);
}

export interface SearchPages {
  /** The first page's query: the chip counts, the answer, its error and `refetch`. */
  first: ReturnType<typeof useSearch>;
  /** The results of every page loaded so far, in order, each once. */
  results: SearchResult[];
  /** The last page's `next` once it arrived (even when that page was short or empty); null while it loads. */
  next: string | null;
  /** More may follow: a further page is on its way, failed, or the last one has a `next`. Without it, the end. */
  hasMore: boolean;
  /** A further page is on its way (asked for, or loading by itself). */
  loadingMore: boolean;
  /** A further page failed. */
  moreFailed: boolean;
  /** Nothing to show yet but the search goes on: loading by itself, so not “No results”. */
  searching: boolean;
  /** Load the page after the last one (“Load more”). */
  loadMore: () => void;
  /** Try the failed page again; a cursor the Whombat refused (a 4xx: out of date, SRP-04) starts the walk over. */
  retryMore: () => void;
}

const NO_CURSORS: readonly string[] = [];

/** A number for each answer object, the same while it is the same object: a memo key for a list of answers. */
const answerIds = new WeakMap<object, number>();
let lastAnswerId = 0;
function answerId(data: unknown): number {
  if (!data || typeof data !== 'object') return 0;
  let id = answerIds.get(data);
  if (id === undefined) {
    id = ++lastAnswerId;
    answerIds.set(data, id);
  }
  return id;
}
/**
 * Search with its further pages (Whombat search-pagination.md): the first page (counts, answer) and the pages after it
 * by `next`, each its own cached query so realtime edits reach them too. A page may be short or empty and still have a
 * `next`: while nothing shows yet this loads on by itself (at most `SEARCH_AUTOLOAD_PAGES` pages), so an empty list with
 * no `next` is the only “No results”.
 */
export function useSearchPages(
  input: KeyInput<typeof api.search.query> | null | undefined,
  options?: QueryHookOptions<typeof api.search.query>,
): SearchPages {
  const { queries } = useWhombat();
  const first = useSearch(input, options);
  const key = input ? JSON.stringify(input) : '';
  const [asked, setAsked] = useState<{ key: string; cursors: readonly string[] }>({
    key,
    cursors: NO_CURSORS,
  });
  const cursors = asked.key === key ? asked.cursors : NO_CURSORS;
  const more = useQueries({
    queries: cursors.map((cursor) => ({
      ...queries.search.query({
        ...(input as KeyInput<typeof api.search.query>),
        query: { ...input?.query, cursor },
      } as KeyInput<typeof api.search.query>),
      enabled: !!input,
    })),
  });
  const walk = searchWalk(
    first.data,
    cursors,
    more.map((r) => r.data),
  );
  const live = more.slice(0, walk.length);
  const walkKey = walk.join(' ');
  // Pages after a break in the walk (a first page fetched again that ends elsewhere) are let go: kept, they would be
  // fetched again on every focus and resync, each with the Whombat's count scan (SRP-07).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `walk` is keyed by `walkKey`
  useEffect(() => {
    if (walk.length < cursors.length) setAsked({ key, cursors: walk });
  }, [key, walkKey, cursors.length]);
  // One dependency however many pages: which search and pages, their states, and which answer each holds (a live
  // change, a result removed, replaces a page's data without it being read again).
  const stamp = [
    key,
    `${first.status}:${answerId(first.data)}`,
    walkKey,
    live.map((r) => `${r.status}:${answerId(r.data)}`).join(','),
  ].join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when any page of the walk changes
  const results = useMemo(() => searchWalkResults([first.data, ...live.map((r) => r.data)]), [stamp]);
  const last = walk.length ? live[walk.length - 1]?.data : first.data;
  // A previous search's page kept on screen (`placeholderData`) is not this search's: its cursor would be refused.
  const next = first.isPlaceholderData ? null : (last?.next ?? null);
  const loadingMore = live.some((r) => r.isPending);
  const moreFailed = live.some((r) => r.isError);
  const hasMore = !first.isPlaceholderData && (loadingMore || moreFailed || !!next);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `walk` is keyed by `walkKey`
  const loadMore = useCallback(() => {
    if (next) setAsked({ key, cursors: [...walk, next] });
  }, [key, walkKey, next]);
  const auto =
    !!first.data &&
    searchKeepsLoading({
      shown: results.length,
      next,
      loading: loadingMore,
      failed: moreFailed,
      pages: walk.length,
    });
  useEffect(() => {
    if (auto) loadMore();
  }, [auto, loadMore]);
  const retryMore = () => {
    const failed = live.filter((r) => r.isError);
    if (failed.some((r) => r.error instanceof ApiError && r.error.status >= 400 && r.error.status < 500)) {
      setAsked({ key, cursors: NO_CURSORS });
      void first.refetch();
      return;
    }
    for (const r of failed) void r.refetch();
  };
  return {
    first,
    results,
    next,
    hasMore,
    loadingMore,
    moreFailed,
    searching: results.length === 0 && (auto || loadingMore),
    loadMore,
    retryMore,
  };
}
