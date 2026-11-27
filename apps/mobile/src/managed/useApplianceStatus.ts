/**
 * `appliance.status` for This Whombat's screens (AP-22, AP-27; this-whombat-sections-android.md AP-1240): the Overview,
 * Backups, About and Devices each read it. While an update moves or waits a screen that shows it follows it
 * (AP-258), quietly; `reload` reads it again without going back to loading, and once a status is shown a failed read
 * leaves it there.
 */
import { queryOptions } from '@tanstack/react-query';
import { updatePollMs } from '@whombat/client/managed';
import { type ApplianceStatus, sessionOps } from '@whombat/client/session';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ManagedContextValue, useManagedOrThrow } from './context';

export function useApplianceStatus({ follow = true }: { follow?: boolean } = {}) {
  const { session } = useManagedOrThrow();
  const [status, setStatus] = useState<ApplianceStatus | null>(null);
  const [error, setError] = useState(false);
  const shown = useRef(false);
  const load = useCallback(() => {
    setError(false);
    sessionOps.applianceStatus(session).then(
      (s) => {
        shown.current = true;
        setStatus(s);
      },
      () => !shown.current && setError(true),
    );
  }, [session]);
  useEffect(load, [load]);
  const pollMs = follow ? updatePollMs(status?.update) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new status arms the next ask
  useEffect(() => {
    if (!pollMs) return;
    let live = true;
    const timer = setTimeout(() => {
      sessionOps.applianceStatus(session).then(
        (s) => live && setStatus(s),
        () => {},
      );
    }, pollMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [session, status, pollMs]);
  return { status, error, reload: load };
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
 * The Whombat's `appliance.status` as the Settings list reads it. Other readers (the “Whombat updated” notice) share
 * it by this key, so the app asks once; the Settings tab's dot keeps it fresh every five minutes.
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
