import { useCallback, useInsertionEffect, useRef } from 'react';

/**
 * A function whose identity never changes and that always calls the latest `fn` (docs/decisions/web-messages.md WX-01):
 * handlers passed to memoized message rows, so a parent's render doesn't re-render every row. Call it from events and
 * effects, not while rendering.
 */
export function useStableCallback<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
  const ref = useRef(fn);
  useInsertionEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
}
