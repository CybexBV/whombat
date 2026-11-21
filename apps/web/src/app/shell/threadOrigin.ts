/**
 * Where a Chat or Feedback thread was opened from (docs/decisions/ui-refresh-chat.md): its back link names that page
 * (“← Inbox”, “← Overview”, “← Home Assistant”) and goes back there, as Escape does. A thread opened in its own room, by
 * an address or after a reload goes back to its room.
 */
import { CHAT_WORDS, permissionsText } from '@whombat/client';
import { useEffect, useRef } from 'react';
import { parseShellLocation, type ShellLocation } from './location';

export interface ThreadOrigin {
  /** The page's address, as it was (its search too). */
  href: string;
  /** What the back link says after its arrow. */
  label: string;
}

/** A page's name for a back link; null for a page with no name of its own (the link then goes to the thread's room). */
export function originLabel(
  location: ShellLocation,
  names: { thing: (id: string) => string | null; assistant: string },
): string | null {
  switch (location.kind) {
    case 'room':
      return CHAT_WORDS[location.room];
    case 'needsYou':
      return 'Inbox';
    case 'dashboard':
      return CHAT_WORDS.dashboard;
    case 'automations':
      return 'Automations';
    case 'vault':
      return 'Vault';
    case 'files':
      return CHAT_WORDS.files;
    case 'settings':
      return location.usage ? 'Usage' : 'Settings';
    case 'done':
      return permissionsText(names.assistant).didTitle;
    case 'thing':
      return names.thing(location.id);
    case 'search':
      return 'Search';
    default:
      return null;
  }
}

/**
 * The page a room's thread was opened from, kept while that thread (or another thread opened from it) stays open.
 * `threadId` is the open room thread's root, else null. Only another page counts: a thread opened from its room, or
 * from another thread, keeps what it had.
 */
export function useThreadOrigin(
  href: string,
  pathname: string,
  threadId: string | null,
  names: { thing: (id: string) => string | null; assistant: string },
): ThreadOrigin | null {
  const last = useRef<{ href: string; pathname: string } | null>(null);
  const open = useRef<string | null>(null);
  const from = useRef<{ href: string; pathname: string } | null>(null);
  // Read during the render that opens the thread: `last` still holds the page before it.
  if (threadId !== open.current) {
    if (!threadId) from.current = null;
    else if (last.current && last.current.pathname !== pathname) from.current = last.current;
    else if (!open.current) from.current = null;
    open.current = threadId;
  }
  useEffect(() => {
    last.current = { href, pathname };
  }, [href, pathname]);
  const before = from.current;
  if (!before) return null;
  const label = originLabel(parseShellLocation(before.pathname), names);
  return label ? { href: before.href, label } : null;
}
