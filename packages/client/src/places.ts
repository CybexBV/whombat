/**
 * The app's places, in one order everywhere (docs/decisions/final-shell-web.md): Search, Chat, Inbox,
 * Automations, Files, Vault, Usage, Settings, with Servers and Connections after the Inbox (their own words,
 * servers-connections-places.md). The web's sidebar and its phone-width Places drawer list Chat to
 * Vault (Search is ⌘K, Settings is in the account menu, Usage opens at its address); Search lists them all as Places.
 * Each name has one home: Usage is the spend page under Advanced's address, shown as Usage. Pure words and addresses.
 */
import { agentWords } from './agentName';

export type AppPlace = 'search' | 'chat' | 'inbox' | 'automations' | 'files' | 'vault' | 'usage' | 'settings';

export const APP_PLACES: readonly AppPlace[] = [
  'search',
  'chat',
  'inbox',
  'automations',
  'files',
  'vault',
  'usage',
  'settings',
];

/** Usage's one home: the spend page that was Advanced → Spend (its address stays). */
export const USAGE_HREF = '/settings?tab=advanced&part=spend';

export interface AppPlaceWords {
  label: string;
  /** One line about it, in Search's Places. */
  line: string;
}

/** Each place's name and line, with the assistant by its name. */
export function appPlaceWords(agent: string): Record<AppPlace, AppPlaceWords> {
  const N = agentWords(agent).Name;
  return {
    search: { label: 'Search', line: 'Chats, things, settings and places' },
    chat: { label: 'Chat', line: `You and ${N}` },
    inbox: { label: 'Inbox', line: 'What needs you' },
    automations: { label: 'Automations', line: 'Plans and schedules' },
    files: { label: 'Files', line: 'Files shared in your conversations' },
    vault: { label: 'Vault', line: 'Sign-ins and secrets' },
    usage: { label: 'Usage', line: `What it cost and how much ${N} worked` },
    settings: { label: 'Settings', line: `You, ${N} and this Whombat` },
  };
}

/** The phone-width top bar and its drawer. */
export const PLACES_WORDS = {
  /** The bar's menu button, and the drawer's heading. */
  places: 'Places',
  close: 'Close Places',
  /** The short cue to the Inbox at the bar's end. */
  needYou: 'need you',
  /** The cue's full name for a screen reader. */
  needYouLabel: (n: number) => `${n} ${n === 1 ? 'thing needs' : 'things need'} you, open Inbox`,
  /** Chat's badge: its unread replies, Feedback's too. */
  chatUnread: (n: number, feedback: boolean) =>
    `Chat, ${n} unread ${n === 1 ? 'reply' : 'replies'}${feedback ? ' in Chat and Feedback' : ''}`,
  /** The Inbox's badge, and whether one of them isn't working. */
  inboxWaiting: (n: number, broken: boolean) =>
    `Inbox, ${n} ${n === 1 ? 'thing needs' : 'things need'} you${broken ? ', one is not working' : ''}`,
} as const;

/** Search's screen (the grouped one: chats, things, settings and places). */
export const SEARCH_WORDS = {
  title: 'Search',
  intro: 'Chats, things, settings and places.',
  field: 'Search everything',
  clear: 'Clear search',
  groups: { chats: 'Chats', things: 'Things', settings: 'Settings', places: 'Places' },
  results: (n: number) => `${n} ${n === 1 ? 'result' : 'results'}`,
  searching: 'Searching…',
  noResults: 'No results',
  emptyTitle: 'What are you looking for?',
  emptyBody: 'Find a chat, a server, a connection or a setting by its name.',
  suggestions: 'Try a search',
  loadingTitle: (q: string) => `Looking for “${q}”…`,
  noResultsTitle: (q: string) => `No results for “${q}”`,
  noResultsBody: 'Try a shorter name or a different word.',
  failedStatus: 'Search didn’t finish.',
  failedTitle: 'Couldn’t search',
  failedBody: 'Try again to look through your chats, things, settings and places.',
  /** Under Chats when a type or a filter leaves none. */
  noChats: (q: string) => (q ? `No chats match “${q}” with these filters.` : 'No chats match these filters.'),
  /** Under Chats when only the chats couldn't be searched. */
  chatsFailed: 'Your chats couldn’t be searched. Try again in a moment.',
  tryAgain: 'Try again',
  /** A thing's line: what it is, and how it is. */
  kinds: { server: 'Server', connection: 'Connection', device: 'Device' } as Record<string, string>,
} as const;
