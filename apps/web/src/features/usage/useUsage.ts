/**
 * Reading and refreshing subscription usage (contracts CT-154): `usage.list` kept fresh by the `usage.updated` event
 * (the client refetches it) and read again every time the screen opens; `usage.refresh` probes the caller's own
 * sign-in for one provider, at most once a minute (429 `rate_limited`, `details.retryAfter` in seconds).
 */

import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { queryHook, useWhombat } from '@whombat/client/react';
import { api, type UsageListOutput, UsageRefreshTooSoon } from '@whombat/core/contracts';
import {
  type SubscriptionUsage,
  USAGE_REFRESH_MIN_INTERVAL_MS,
  type UsageProvider,
} from '@whombat/core/domain';
import { useCallback, useEffect, useState } from 'react';
import { useTicker } from '../messaging/useRoom';
import { withUsage } from './model';

export const useUsageList = queryHook(api.usage.list);

/** Everything a Refresh button needs: whether it runs, when it may run again, and what went wrong. */
export interface UsageRefreshState {
  pending: boolean;
  /** Seconds until the next refresh is taken (a 429's `retryAfter`, or a minute after a refresh), else 0. */
  waitSeconds: number;
  /** Why the last refresh didn't happen, for a status line. */
  problem: string | null;
  refresh: () => void;
}

export type RefreshOutcome =
  | { kind: 'ok'; usage: SubscriptionUsage }
  | { kind: 'too_soon'; retryAfter: number }
  | { kind: 'not_signed_in' }
  | { kind: 'failed' };

/** What a `usage.refresh` error means for the button: too soon (with the wait), not signed in, or a failure. */
export function refreshOutcomeOf(error: unknown): RefreshOutcome {
  if (error instanceof ApiError || (error && typeof error === 'object' && 'status' in error)) {
    const e = error as { status?: number; code?: string; details?: unknown };
    if (e.status === 429 || e.code === 'rate_limited') {
      const details = UsageRefreshTooSoon.safeParse(e.details);
      return {
        kind: 'too_soon',
        retryAfter: details.success ? details.data.retryAfter : USAGE_REFRESH_MIN_INTERVAL_MS / 1000,
      };
    }
    if (e.status === 404 || e.code === 'not_found') return { kind: 'not_signed_in' };
  }
  return { kind: 'failed' };
}

/**
 * Refresh one of the caller's own subscriptions. A fresh snapshot replaces the old one in every cached `usage.list`;
 * the button then waits the minute the server would refuse anyway, or the `retryAfter` of a 429.
 */
export function useUsageRefresh(
  burrow: string,
  provider: UsageProvider,
  messages: { failed: string; notSignedIn: string },
): UsageRefreshState {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [until, setUntil] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const now = useTicker(until !== null);
  const waitSeconds = until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
  useEffect(() => {
    if (until !== null && waitSeconds === 0) setUntil(null);
  }, [until, waitSeconds]);

  const refresh = useCallback(() => {
    setPending(true);
    setProblem(null);
    client
      .request(api.usage.refresh, { params: { burrow }, body: { provider } })
      .then(
        (result): RefreshOutcome =>
          result.status === 'ok' ? { kind: 'ok', usage: result.data.usage } : { kind: 'failed' },
        refreshOutcomeOf,
      )
      .then((outcome) => {
        const scope = queryKeys.scope(api.usage.list);
        if (outcome.kind === 'ok') {
          qc.setQueriesData<UsageListOutput>({ queryKey: scope }, (list) =>
            list ? withUsage(list, outcome.usage) : list,
          );
          setUntil(Date.now() + USAGE_REFRESH_MIN_INTERVAL_MS);
        } else if (outcome.kind === 'too_soon') {
          setUntil(Date.now() + outcome.retryAfter * 1000);
        } else if (outcome.kind === 'not_signed_in') {
          setProblem(messages.notSignedIn);
          void qc.invalidateQueries({ queryKey: scope });
        } else {
          setProblem(messages.failed);
        }
      })
      .finally(() => setPending(false));
  }, [client, qc, burrow, provider, messages.failed, messages.notSignedIn]);

  return { pending, waitSeconds, problem, refresh };
}
