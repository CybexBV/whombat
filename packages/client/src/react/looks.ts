/**
 * The step the assistant offers on a look (Whombat look-research.md LR-08; contracts 3.5 `looks.fix`; app
 * look-research-web.md AP-5900…): its button is the person's go-ahead for that one step, or *Go ahead* for its plan
 * (handle-it.md); *Ask {assistant} to handle these* hands a thing to it (`looks.handle`). Home's Needs you and the
 * thing's page say “I’m on it.” the moment it is pressed; the server's answer takes over, and a refusal or a failure
 * puts the card back with the step on it. Home and the page are read again after the answer, as the assistant's
 * report comes through `home.changed`. Works in React DOM and React Native.
 */
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { HomeOverview, LookResearch, ThingPage } from '@whombat/core';
import {
  api,
  type FixLookResponse,
  type GetLookResponse,
  type HandleLookResponse,
} from '@whombat/core/contracts';
import { handedOverThread } from '../home/handoff';
import { handingResearch } from '../home/lookPlan';
import {
  fixingResearch,
  type LookFixOutcome,
  withNeedsYouResearch,
  withThingResearch,
} from '../home/lookResearch';
import { ApiError } from '../http/errors';
import type { CommitResult } from '../http/types';
import { patchEndpoint } from '../query/cache';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

type Snapshot = [readonly unknown[], unknown][];

/** The outcome of `looks.fix`'s answer or error. */
export function lookFixOutcome(
  result: CommitResult<FixLookResponse> | null,
  error?: unknown,
): LookFixOutcome {
  if (error instanceof ApiError)
    return error.status === 403 ? 'forbidden' : error.status === 404 ? 'gone' : 'failed';
  if (error || !result) return 'failed';
  if (result.status === 'ok') return 'ok';
  return result.status === 'blocked' ? 'forbidden' : 'failed';
}

/** A research put wherever Home, the thing's pages and a server page's research (`looks.get`) are cached. */
function applyResearch(qc: QueryClient, burrow: string, research: LookResearch): void {
  patchEndpoint<HomeOverview>(qc, 'home.overview', (d) => withNeedsYouResearch(d, research), { burrow });
  patchEndpoint<ThingPage>(qc, 'things.page', (p) => withThingResearch(p, research), { burrow });
  const key = queryKeys.endpoint(api.looks.get, { params: { burrow }, query: { key: research.key } });
  if (qc.getQueryData(key) !== undefined) qc.setQueryData<GetLookResponse>(key, { research });
}

const SCOPES = ['home.overview', 'things.page', 'looks.get'] as const;

function snapshotOf(qc: QueryClient, burrow: string): Snapshot {
  return SCOPES.flatMap((scope) => qc.getQueriesData({ queryKey: queryKeys.scope(scope, { burrow }) }));
}

function readAgain(qc: QueryClient, burrow: string): void {
  for (const scope of SCOPES) void qc.invalidateQueries({ queryKey: queryKeys.scope(scope, { burrow }) });
}

/**
 * A thing's research for a page that doesn't carry it (a server's page, built in the apps; `looks.get`, 3.11). A
 * Whombat without it answers 404: the page then has no research, as before.
 */
export const useLookResearch = queryHook(api.looks.get);

/**
 * How handing a thing to the assistant went: it looks (`ok`), the Whombat doesn't know `looks.handle` or nothing
 * needs a look there (`ask`: the Ask pane opens with today's question instead), or it failed.
 */
export type HandleLookOutcome = 'ok' | 'ask' | 'failed';

export function handleLookOutcome(
  result: CommitResult<HandleLookResponse> | null,
  error?: unknown,
): HandleLookOutcome {
  if (error instanceof ApiError) return error.status === 404 ? 'ask' : 'failed';
  if (error || !result) return 'failed';
  return result.status === 'ok' ? 'ok' : 'failed';
}

/**
 * *Ask {assistant} to handle these* (`looks.handle`, handle-it.md): `key` the thing's. The card says “{assistant} is
 * looking into these” at once; `onDone` hears how it went, `ask` meaning: open the Ask pane with the question (an
 * older Whombat, or nothing that needs a look any more), and the look's thread the answer names, which the screen
 * opens (backup-places.md BPL-15).
 */
export function useHandleLook(
  burrow: string,
  onDone?: (outcome: HandleLookOutcome, thread: string | null) => void,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<HandleLookResponse>, Error, string, { snapshot: Snapshot }>({
    onMutate: (key) => {
      const snapshot = snapshotOf(qc, burrow);
      applyResearch(qc, burrow, handingResearch(key, Date.now()));
      return { snapshot };
    },
    mutationFn: (key) => client.request(api.looks.handle, { params: { burrow }, body: { key } }),
    onSuccess: (result, _v, ctx) => {
      if (result.status === 'ok') applyResearch(qc, burrow, result.data.research);
      else if (ctx) for (const [key, data] of ctx.snapshot) qc.setQueryData(key, data);
      onDone?.(handleLookOutcome(result), result.status === 'ok' ? handedOverThread(result.data) : null);
    },
    onError: (error, _v, ctx) => {
      if (ctx) for (const [key, data] of ctx.snapshot) qc.setQueryData(key, data);
      onDone?.(handleLookOutcome(null, error), null);
    },
    onSettled: () => readAgain(qc, burrow),
  });
}

/**
 * Take the step on a look (`looks.fix`): `research` the look's as the screen has it (its key is what is sent). It reads
 * `fixing` at once; `onDone` hears how it went (the toast's words are `lookFixOutcomeText`) and the look's thread the
 * answer names, which the screen opens (backup-places.md BPL-15).
 */
export function useFixLook(
  burrow: string,
  onDone?: (outcome: LookFixOutcome, thread: string | null) => void,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<FixLookResponse>, Error, LookResearch, { snapshot: Snapshot }>({
    onMutate: (research) => {
      const snapshot = snapshotOf(qc, burrow);
      applyResearch(qc, burrow, fixingResearch(research, Date.now()));
      return { snapshot };
    },
    mutationFn: (research) =>
      client.request(api.looks.fix, { params: { burrow }, body: { key: research.key } }),
    onSuccess: (result, _v, ctx) => {
      if (result.status === 'ok') applyResearch(qc, burrow, result.data.research);
      else if (ctx) for (const [key, data] of ctx.snapshot) qc.setQueryData(key, data);
      onDone?.(lookFixOutcome(result), result.status === 'ok' ? handedOverThread(result.data) : null);
    },
    onError: (error, _v, ctx) => {
      if (ctx) for (const [key, data] of ctx.snapshot) qc.setQueryData(key, data);
      onDone?.(lookFixOutcome(null, error), null);
    },
    onSettled: () => readAgain(qc, burrow),
  });
}
