/**
 * Conversations as the web and the phone show them (Whombat essentials, contracts 0.26; docs/decisions/
 * essentials-conversations.md AP-460…): the sidebar's summaries in one list, the order by activity and muted
 * conversations. Pure, so both apps read them the same way. A Whombat has the person's rooms with the agent and
 * branch rooms only (Whombat one-agent.md OA-04).
 */
import { type Bootstrap, type ConversationSummary, type NotifyLevel, notifyLevelOf } from '@whombat/core';

type SidebarLists = Pick<Bootstrap['sidebar'], 'branchRooms' | 'dms'>;

/** Every conversation the sidebar lists: branch rooms and the person's rooms with the agent. */
export function sidebarSummaries(sidebar: SidebarLists | undefined): ConversationSummary[] {
  if (!sidebar) return [];
  return [...sidebar.branchRooms, ...sidebar.dms];
}

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY);

/**
 * Newest activity first (AP-461); conversations without a message yet last, in the order given (the sort is stable).
 */
export function byRecentActivity(
  a: { lastMessageAt: string | null },
  b: { lastMessageAt: string | null },
): number {
  const ta = at(a.lastMessageAt);
  const tb = at(b.lastMessageAt);
  if (ta === tb) return 0;
  return tb > ta ? 1 : -1;
}

/** A conversation the viewer set to Nothing (`notify: none`): the sidebar shows it muted (AP-470). */
export function isMuted(c: Pick<ConversationSummary, 'kind' | 'notify'>): boolean {
  return notifyLevelOf(c) === 'none';
}

/**
 * The sidebar badge of a conversation (AP-470): its unread count, or — muted — only its mentions. `bold` says whether
 * the row reads as unread (a muted row never does, unless it mentions you).
 */
export function unreadBadge(c: Pick<ConversationSummary, 'kind' | 'notify' | 'unread' | 'mentions'>): {
  count: number;
  bold: boolean;
} {
  if (isMuted(c)) return { count: c.mentions, bold: c.mentions > 0 };
  return { count: c.unread, bold: c.unread > 0 };
}

/** The level a Set-notify answer or event leaves on a summary: nothing stored when it is the kind's default. */
export function withNotify<S extends Pick<ConversationSummary, 'kind' | 'notify'>>(
  s: S,
  notify: NotifyLevel,
): S {
  if (notifyLevelOf(s) === notify) return s;
  return { ...s, notify };
}
