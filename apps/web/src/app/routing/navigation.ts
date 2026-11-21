import { useRouter, useRouterState } from '@tanstack/react-router';
import { useCallback } from 'react';

type SearchRecord = Record<string, unknown>;

function withoutUndefined(search: SearchRecord): SearchRecord {
  return Object.fromEntries(Object.entries(search).filter(([, v]) => v !== undefined && v !== ''));
}

/**
 * Updates the current page's search params (open/close a pane or modal, change a filter) without
 * leaving the page: `update((s) => ({ ...s, thread: undefined }))`.
 */
export function useSearchUpdate() {
  const router = useRouter();
  return useCallback(
    (update: (prev: SearchRecord) => SearchRecord, options: { replace?: boolean; hash?: string } = {}) => {
      const { pathname, search } = router.state.location;
      const next = withoutUndefined(update({ ...(search as SearchRecord) }));
      return router.navigate({
        to: pathname,
        search: next,
        replace: options.replace,
        hash: options.hash,
      } as never);
    },
    [router],
  );
}

/** Navigate to an app path given as a string (`appPath()` output, remembered locations). */
export function useNavigateHref() {
  const router = useRouter();
  return useCallback(
    (href: string, options: { replace?: boolean } = {}) =>
      router.history[options.replace ? 'replace' : 'push'](href),
    [router],
  );
}

/**
 * Hrefs to this page with some search params changed: `here({ plan: 'pln_x', thread: undefined })` →
 * `/c/billing-v2?plan=pln_x`. For links that open a pane or modal over the current page (real `<a>`s, so
 * they can open in a new tab too).
 */
export function useHereHref() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search }) as SearchRecord;
  return useCallback(
    (patch: SearchRecord) => {
      const next = withoutUndefined({ ...search, ...patch });
      const query = new URLSearchParams(
        Object.entries(next).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
      ).toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, search],
  );
}
