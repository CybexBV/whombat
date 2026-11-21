import { useCallback, useState } from 'react';
import type { SidebarList } from './assistantSidebarModel';

/** Where the browser keeps which of the sidebar's lists is open (sidebar-tabs.md): Servers until another is picked. */
export const SIDEBAR_LIST_KEY = 'whombat.sidebar.list';

function readList(): SidebarList | null {
  try {
    const value = localStorage.getItem(SIDEBAR_LIST_KEY);
    return value === 'servers' || value === 'connections' ? value : null;
  } catch {
    return null;
  }
}

/** The sidebar's open list, kept in this browser. */
export function useSidebarList(): { list: SidebarList | null; pick: (list: SidebarList) => void } {
  const [list, setList] = useState<SidebarList | null>(readList);
  const pick = useCallback((next: SidebarList) => {
    setList(next);
    try {
      localStorage.setItem(SIDEBAR_LIST_KEY, next);
    } catch {
      // Private mode or full storage: the choice lasts until the page reloads, nothing worse.
    }
  }, []);
  return { list, pick };
}
