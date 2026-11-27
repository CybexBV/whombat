/**
 * `appliance.status` for This Whombat's screens (AP-22, AP-27; this-whombat-sections-android.md AP-1240): the Overview,
 * Backups, About and Devices each read it. While an update moves or waits a screen that shows it follows it
 * (AP-258), quietly; `reload` reads it again without going back to loading, and once a status is shown a failed read
 * leaves it there.
 */
import { queryOptions, useQuery } from '@tanstack/react-query';
import { updatePollMs } from '@whombat/client/managed';
import { sessionOps } from '@whombat/client/session';
import { useCallback, useEffect, useState } from 'react';
import { type ManagedContextValue, useManagedOrThrow } from './context';

export function useApplianceStatus({ follow = true }: { follow?: boolean } = {}) {
  const managed = useManagedOrThrow();
  const { data, isError, isFetching, refetch } = useQuery({
    ...applianceStatusQuery(managed),
    refetchOnMount: 'always',
    refetchInterval: (query) => (follow ? (updatePollMs(query.state.data?.update) ?? false) : false),
  });
  const reload = useCallback(() => void refetch(), [refetch]);
  return { status: data ?? null, error: !data && isError && !isFetching, reload };
}

/** What control says a release brought (`rollout.releaseSummary`); null while unknown or when it has none. */
export function useReleaseSummary(release: string | null): string | null {
  const { control } = useManagedOrThrow();
  const [summary, setSummary] = useState<{ release: string; text: string } | null>(null);
  useEffect(() => {
    // A community box has no control to say it (AP-5470).
    if (!release || !control) return;
    let live = true;
    control.releaseSummary(release).then(
      (r) => live && setSummary(r?.summary ? { release, text: r.summary } : null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [release, control]);
  return summary && summary.release === release ? summary.text : null;
}

/**
 * Settings, its detail pages and the update notice share one read. A language change refreshes any open reader.
 */
export function applianceStatusQuery(managed: Pick<ManagedContextValue, 'session' | 'cacheScope'> | null) {
  return queryOptions({
    queryKey: ['settings', 'appliance-status', managed?.cacheScope ?? null],
    queryFn: () => {
      if (!managed) throw new Error('not a managed Whombat');
      return sessionOps.applianceStatus(managed.session);
    },
    enabled: !!managed,
    retry: false,
    staleTime: 60_000,
  });
}
