/**
 * What the browser tab, the favicon and the installed app's badge say about unread messages (AP-98). Pure, so
 * the rules are unit-tested:
 *
 * - `count`: what is waiting for *you* — every unread message in your Chat and Feedback room plus the mentions in branch
 *   rooms. A branch room's plain traffic doesn't count, so a busy pull request doesn't keep a number in the tab.
 * - `any`: anything unread at all (branch room traffic included) — the favicon's dot and a dot-only app badge.
 * - A muted conversation (your level is Nothing) counts only its mentions, for both (AP-470).
 */
export interface UnreadTotals {
  count: number;
  any: boolean;
}

interface Counts {
  unread: number;
  mentions: number;
  /** The viewer's level (absent: the kind's default, never Nothing). */
  notify?: 'all' | 'mentions' | 'none';
}

/** The bootstrap sidebar's conversation summaries (only their counts matter). */
interface Sidebar {
  branchRooms: readonly Counts[];
  dms: readonly Counts[];
}

export function unreadTotals(sidebar: Sidebar): UnreadTotals {
  let count = 0;
  let any = false;
  for (const d of sidebar.dms) {
    const n = d.notify === 'none' ? d.mentions : d.unread;
    count += Math.max(0, n);
    if (n > 0 || d.mentions > 0) any = true;
  }
  for (const c of sidebar.branchRooms) {
    count += Math.max(0, c.mentions);
    if ((c.notify !== 'none' && c.unread > 0) || c.mentions > 0) any = true;
  }
  return { count, any };
}

export const BASE_TITLE = 'Whombat';

/** `(3) Whombat`, `(99+) Whombat`, or plain `Whombat` when nothing waits for you. */
export function unreadTitle(count: number, base: string = BASE_TITLE): string {
  if (count <= 0) return base;
  return `(${count > 99 ? '99+' : count}) ${base}`;
}
