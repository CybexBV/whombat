/** The hook behind `statusOrder`: worst first when it mounts or `sortKey` changes (a pull to refresh), else kept. */
import type { StatusLevel } from '@whombat/client';
import { useMemo, useRef } from 'react';
import { inOrder, statusOrder } from './statusOrder';

export function useStatusOrder<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  levelOf: (item: T) => StatusLevel,
  sortKey: number,
): T[] {
  const kept = useRef<{ key: number; order: string[] } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `idOf` and `levelOf` are read once per list, not followed
  return useMemo(() => {
    const prev = kept.current;
    // Nothing kept yet (or an empty list before it loaded): this is the list loading, so it sorts.
    const fresh = !prev || prev.key !== sortKey || prev.order.length === 0;
    const order = statusOrder(items, idOf, levelOf, fresh ? null : prev.order);
    kept.current = { key: sortKey, order };
    return inOrder(items, idOf, order);
  }, [items, sortKey]);
}
