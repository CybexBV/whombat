/**
 * Whether the row something is drawn in is in view (AP-909): a chat list provides its rows' `InViewStore`, each row its
 * id. Outside such a list (a screen of its own, full screen) everything counts as in view.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { InViewStore } from '../lib/inView';

export const InViewStoreContext = createContext<InViewStore | null>(null);
export const RowIdContext = createContext<string | null>(null);

const always = () => () => {};

/** True while this row is on screen or next to it; true outside a list that says. */
export function useRowInView(): boolean {
  const store = useContext(InViewStoreContext);
  const id = useContext(RowIdContext);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store]);
  const read = () => (store && id !== null ? store.has(id) : true);
  return useSyncExternalStore(store ? subscribe : always, read, read);
}
