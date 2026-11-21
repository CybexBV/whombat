/**
 * Share to Whombat (AP-715): the conversations a share can go to — the person's Chat and Feedback room with the agent
 * and the branch rooms they are in, from the bootstrap's sidebar (no channels or conversations between people: Whombat
 * one-agent.md OA-04; app one-agent.md AP-4984) — newest activity first, found by what is typed, and the screen each
 * one opens once the share is sent. Pure.
 */
import { byRecentActivity } from '@whombat/client';
import type { Bootstrap, ConversationLink } from '@whombat/core';
import { type Route, routeForLink } from '../navigation/routes';

export interface ShareTarget {
  id: string;
  kind: 'dm' | 'branch';
  /** “Chat”, “Feedback”, “feat/invoice-pdf”. */
  title: string;
  /** The row's mono line: “Your chat with Dusty”, “PR #482”. */
  meta: string;
  /** Where the conversation opens. */
  link: ConversationLink;
  lastMessageAt: string | null;
  /** Lowercase words a search matches the start of: the title and its parts. */
  keys: string[];
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[\s/._-]+/)
    .filter(Boolean);

export function shareTargets(
  sidebar: Pick<Bootstrap['sidebar'], 'dms' | 'branchRooms'>,
  agentName: string,
): ShareTarget[] {
  const rooms: ShareTarget[] = [...sidebar.dms, ...sidebar.branchRooms].map((c) => ({
    id: c.id,
    kind: c.kind === 'branch' ? 'branch' : 'dm',
    title: c.title,
    meta: c.kind === 'branch' ? (c.prNumber ? `PR #${c.prNumber}` : 'Branch') : `With ${agentName}`,
    link: c.link as ConversationLink,
    lastMessageAt: c.lastMessageAt,
    keys: [c.slug.toLowerCase(), ...words(c.title), ...words(c.slug)],
  }));
  // Stable: equally recent conversations keep the sidebar's order, the person's rooms first.
  return rooms.sort(byRecentActivity);
}

/** Does a conversation match what was typed (a leading `#` or `@` ignored): the start of a word, or part of its name. */
export function matchesShareTarget(target: Pick<ShareTarget, 'title' | 'keys'>, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^[#@]/, '');
  if (!q) return true;
  return target.keys.some((k) => k.startsWith(q)) || target.title.toLowerCase().includes(q);
}

/** The conversation's own screen, opened once the share is sent: Chat, Feedback, a task chat or the branch room. */
export function shareTargetRoute(target: Pick<ShareTarget, 'id' | 'kind' | 'link'>): Route {
  const byId: Route = { name: 'Conversation', params: { conversationId: target.id } };
  return target.kind === 'branch' ? byId : (routeForLink(target.link, null) ?? byId);
}
