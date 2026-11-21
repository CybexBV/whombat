/**
 * The assistant shell's sidebar (mock 1; one-whombat.md ONE-04; app one-whombat-shell.md AP-1256): pure, so its rules
 * are unit-tested.
 *
 * - The burrow's name (its switcher), then the seven places in one order: Chat, Inbox, Overview, Automations, Files,
 *   Vault, Settings. Search is ⌘K / Ctrl K and Usage is in Settings → Advanced, not rows of their own. Chat's badge
 *   counts its unread replies and Feedback's (Feedback opens from Chat's head); the Inbox's is the one count of what
 *   needs the person (`summary.needsYou`) in the colour of the worst of them. A count shows once the Whombat has
 *   answered and never at zero.
 * - SERVERS and CONNECTIONS, one at a time as tabs (sidebar-tabs.md, `sidebarLists`). Servers (sidebar-servers.md
 *   AP-1748): its `+` Add a server on Overview (connections-page.md AP-2523), the servers in the server's order with a
 *   status mark each; shown once there is a server or the Whombat runs the hosts service. Connections: connections and
 *   devices in the server's order (`thingRows`; servers only under Servers), their real logos and a status mark each.
 *   A problem in the tab that isn't open still shows.
 * - The person at the bottom, with the account menu.
 *
 * Before the Chat shell (no rooms; tests and an older Whombat): Overview is the home page (`/`), and CONVERSATIONS and
 * **Ask Neo** stay (the assistant's name, Whombat assistant-name.md AN-01).
 */
import {
  agentWords,
  appPlaceWords,
  type ChatRooms,
  type ChatRow,
  chatRows,
  PLACES_WORDS,
  SETTLE_WORDS,
  type ThingRow,
  theAgentOf,
  thingRows,
} from '@whombat/client';
import { addServerHref } from '@whombat/client/hosts';
import {
  type Bootstrap,
  type ChatSummary,
  CONNECTIONS_HREF,
  type HomeSeverity,
  type Person,
  type ThingSummary,
} from '@whombat/core';
import { VAULT_COPY } from '@whombat/core/vault';
import { clearChatWords } from '../../features/chats/clearWords';
import { INBOX_PATH, type ShellLocation } from './location';

export type AssistantNavId =
  | 'chat'
  | 'needsYou'
  | 'dashboard'
  | 'home'
  | 'automations'
  | 'files'
  | 'vault'
  | 'settings';

export interface AssistantNavRow {
  id: AssistantNavId;
  label: string;
  href: string;
  selected: boolean;
  /** The Inbox's badge: what needs the person (`summary.needsYou`); null at none. */
  badge: number | null;
  /**
   * The badge's colour: the worst item's that needs the person (`needsYouWorst`) — red for a problem, amber for something
   * to look at, grey for a question; red when it can't be told. Null without a badge.
   */
  badgeTone: HomeSeverity | null;
  /** Chat's threads with something new, Feedback's with them; null at none. */
  unread: number | null;
  /** “Inbox, 3 things need you”, “Chat, 2 unread replies”: the badge is said once, in the name. */
  ariaLabel: string;
}

export interface AssistantSidebarModel {
  burrowName: string;
  burrowSlug: string;
  /** The new-chat button: “Ask Neo” (AN-01); null in the Chat shell, where Chat's box asks (AP-2401). */
  ask: string | null;
  nav: AssistantNavRow[];
  /** The rooms' addresses in order (Chat, then Feedback once it exists): Alt+↑/↓ steps through them. */
  roomPaths: string[];
  /** There is a Feedback room: Chat's right-click menu has its entries too. */
  feedback: boolean;
  /** SERVERS: null while there is nothing to show (no server, no hosts service). */
  servers: AssistantServersSection | null;
  /** CONNECTIONS: everything but the servers. */
  things: ThingRow[];
  /** Null until the Whombat has answered (no section flashes empty). */
  thingsKnown: boolean;
  chats: ChatRow[];
  me: Pick<Person, 'id' | 'name' | 'initials' | 'tone' | 'title' | 'avatarUrl'>;
}

export interface AssistantServersSection {
  /** Add a server (the `+`, on Overview); null without the hosts service. */
  addHref: string | null;
  rows: ThingRow[];
}

export interface AssistantSidebarInput {
  location: ShellLocation;
  things: readonly ThingSummary[] | undefined;
  chats: readonly ChatSummary[] | undefined;
  /** What needs the person (Home's `summary.needsYou`, the one count), null until known. */
  needsYou: number | null;
  /** The worst of those items' severity (`needsYouWorst`); absent when it can't be told. */
  needsYouWorst?: HomeSeverity | null | undefined;
  /** One of them isn't working: the Inbox's name says so. */
  needsYouBroken?: boolean | undefined;
  /** The hosts service (`hosts.status`): whether it runs here. */
  hosts?: { present: boolean } | undefined;
  /**
   * The Chat shell's rooms (`useChatRooms`, AP-2401): Chat and, once it exists, Feedback lead the places, and the
   * conversations list and the Ask button go. Absent: the task chats of before.
   */
  rooms?: ChatRooms | undefined;
}

export function buildAssistantSidebarModel(
  bootstrap: Pick<Bootstrap, 'burrow' | 'me'> & Partial<Pick<Bootstrap, 'principals'>>,
  input: AssistantSidebarInput,
): AssistantSidebarModel {
  const { location, rooms } = input;
  const agent = theAgentOf(bootstrap.principals)?.name;
  const words = appPlaceWords(agent ?? '');
  const row = (id: AssistantNavId, label: string, href: string, selected: boolean): AssistantNavRow => ({
    id,
    label,
    href,
    selected,
    badge: null,
    badgeTone: null,
    unread: null,
    ariaLabel: label,
  });
  // The view of every guest is reached from Overview's Servers (“All guests”, CN-09): Overview stays selected.
  const allGuests = location.kind === 'thing' && location.id === 'servers';
  const inRoom = location.kind === 'room' ? location.room : null;
  // Chat's badge: what is unread in the rooms you aren't reading now (Feedback opens from Chat's head).
  const chatUnread =
    (inRoom === 'chat' ? 0 : (rooms?.chat?.unread ?? 0)) +
    (inRoom === 'feedback' ? 0 : (rooms?.feedback?.unread ?? 0));
  const chat = row('chat', words.chat.label, '/chat', inRoom !== null);
  if (chatUnread > 0) {
    chat.unread = chatUnread;
    chat.ariaLabel = PLACES_WORDS.chatUnread(chatUnread, !!rooms?.feedback);
  }
  const inbox = row('needsYou', words.inbox.label, INBOX_PATH, location.kind === 'needsYou');
  if (input.needsYou && input.needsYou > 0) {
    inbox.badge = input.needsYou;
    inbox.badgeTone = input.needsYouWorst ?? 'bad';
    inbox.ariaLabel = PLACES_WORDS.inboxWaiting(input.needsYou, !!input.needsYouBroken);
  }
  const nav: AssistantNavRow[] = [
    chat,
    inbox,
    // Before the Chat shell Overview is the home page (`/`).
    rooms
      ? row('dashboard', words.overview.label, CONNECTIONS_HREF, location.kind === 'dashboard' || allGuests)
      : row('home', words.overview.label, '/', location.kind === 'home' || allGuests),
    // Automations without a count: a total says nothing, a failed run is in the Inbox (SB-07, AP-2606).
    row('automations', words.automations.label, '/automations', location.kind === 'automations'),
    row('files', words.files.label, '/files', location.kind === 'files'),
    row('vault', words.vault.label, '/vault', location.kind === 'vault'),
    row('settings', words.settings.label, '/settings', location.kind === 'settings'),
  ];
  const { me } = bootstrap;
  const rows = thingRows(input.things ?? [], location.kind === 'thing' ? location.id : null);
  const serverIds = new Set((input.things ?? []).filter((t) => t.kind === 'server').map((t) => t.id));
  return {
    burrowName: bootstrap.burrow.name,
    burrowSlug: bootstrap.burrow.slug,
    ask: rooms ? null : agentWords(agent).ask,
    nav,
    roomPaths: rooms ? ['/chat', ...(rooms.feedback ? ['/feedback'] : [])] : [],
    feedback: !!rooms?.feedback,
    servers: serversSection(
      input,
      rows.filter((r) => serverIds.has(r.id)),
    ),
    things: rows.filter((r) => !serverIds.has(r.id)),
    thingsKnown: input.things !== undefined,
    chats: rooms ? [] : chatRows(input.chats ?? [], location.kind === 'chat' ? location.id : null),
    me: {
      id: me.id,
      name: me.name,
      initials: me.initials,
      tone: me.tone,
      title: me.title,
      ...(me.avatarUrl && { avatarUrl: me.avatarUrl }),
    },
  };
}

/**
 * SERVERS (AP-1748): shown with a server or the hosts service; the `+` with the hosts service, Add a server on
 * Overview's Servers tab (`/connections?tab=servers&add=1`, AP-2523, AP-2608; before the Chat shell `/?…`, the same
 * page), as the Connections tab's `+` opens the Add a connection the page's own button opens.
 */
function serversSection(input: AssistantSidebarInput, rows: ThingRow[]): AssistantServersSection | null {
  if (!rows.length && !input.hosts?.present) return null;
  const add = addServerHref().replace('?', '?tab=servers&');
  return {
    addHref: input.hosts?.present ? (input.rooms ? add : add.replace(CONNECTIONS_HREF, '/')) : null,
    rows,
  };
}

/** The sidebar's two lists, one at a time as tabs (sidebar-tabs.md): Servers, then Connections. */
export type SidebarList = 'servers' | 'connections';

export const SIDEBAR_LIST_WORDS: Record<SidebarList, string> = {
  servers: 'Servers',
  connections: 'Connections',
};

/** Add a connection, the page Overview's own button opens. */
export const ADD_CONNECTION_HREF = `${CONNECTIONS_HREF}?connection=add`;

export interface SidebarListTab {
  key: SidebarList;
  label: string;
  /** The worst of what it holds when that isn't fine, for the dot beside a tab that isn't open; null when all is. */
  tone: 'warn' | 'bad' | null;
  /** “Connections, something needs a look”, “Servers, something isn’t working”. */
  spoken: string;
}

export interface SidebarListsView {
  /** Both lists: two tabs. One list alone: its heading, no tabs. */
  tabs: SidebarListTab[];
  open: SidebarList;
  /** The open list's rows. */
  rows: ThingRow[];
  /**
   * The other list's rows that aren't fine, and the one open now, under the open list: a problem never hides behind a
   * tab.
   */
  carried: ThingRow[];
  /** The `+`: what it adds where, for the open list; null when it can't (no hosts service). */
  add: { href: string; label: string } | null;
}

function rowTone(row: ThingRow): SidebarListTab['tone'] {
  if (row.status === 'bad' || row.status === 'offline') return 'bad';
  return row.status === 'warn' ? 'warn' : null;
}

function worstTone(rows: readonly ThingRow[]): SidebarListTab['tone'] {
  const tones = rows.map(rowTone);
  return tones.includes('bad') ? 'bad' : tones.includes('warn') ? 'warn' : null;
}

/**
 * SERVERS and CONNECTIONS as tabs (sidebar-tabs.md): the asked one when both show (the browser remembers it), else the
 * first, Servers. The tab that isn't open carries a dot in its worst tone, and its rows that aren't fine (and the one open
 * now) show under the open list. Null with neither list.
 */
export function sidebarLists(
  model: Pick<AssistantSidebarModel, 'servers' | 'things'>,
  asked: SidebarList | null,
): SidebarListsView | null {
  const lists: { key: SidebarList; rows: ThingRow[]; add: SidebarListsView['add'] }[] = [];
  if (model.servers)
    lists.push({
      key: 'servers',
      rows: model.servers.rows,
      add: model.servers.addHref ? { href: model.servers.addHref, label: 'Add a server' } : null,
    });
  // Nothing connected yet: no empty list (first-day.md); Overview leads to adding one.
  if (model.things.length)
    lists.push({
      key: 'connections',
      rows: model.things,
      add: { href: ADD_CONNECTION_HREF, label: 'Add a connection' },
    });
  const open = lists.find((l) => l.key === asked) ?? lists[0];
  if (!open) return null;
  return {
    tabs: lists.map((l) => {
      const tone = worstTone(l.rows);
      const label = SIDEBAR_LIST_WORDS[l.key];
      const said = tone === 'bad' ? 'something isn’t working' : 'something needs a look';
      return { key: l.key, label, tone, spoken: tone ? `${label}, ${said}` : label };
    }),
    open: open.key,
    rows: open.rows,
    carried: lists
      .filter((l) => l !== open)
      .flatMap((l) => l.rows.filter((r) => rowTone(r) !== null || r.selected)),
    add: open.add,
  };
}

/**
 * The chats' paths in sidebar order (Alt+↑/↓ steps through them, as through the crew shell's conversations); in the Chat
 * shell Chat and Feedback.
 */
export function assistantConversationPaths(model: AssistantSidebarModel): string[] {
  return model.roomPaths.length ? model.roomPaths : model.chats.map((c) => c.href);
}

/** One entry of a place's right-click menu (chat-clear.md AP-4500, AP-4501). */
export interface NavMenuEntry {
  id:
    | 'settled'
    | 'clear'
    | 'settle-finished'
    | 'feedback'
    | 'feedback-settled'
    | 'clear-feedback'
    | 'settle-finished-feedback'
    | 'add-server'
    | 'add-connection'
    | 'new-automation'
    | 'add-to-vault';
  label: string;
  /** Where it goes; null for Clear, which asks first, and Settle finished threads, which doesn't. */
  href: string | null;
  /** In the bad tone, below a line (Clear, like Clear all messages). */
  danger?: boolean;
  /** Below a line (Feedback's entries under Chat's). */
  separated?: boolean;
}

/**
 * A place's right-click menu (John, 2026-10-21; chat-clear.md AP-4500, AP-4501): Chat opens its Settled, clears and
 * settles its finished threads (chat-settle.md AP-6155), and, with a Feedback room, does the same for Feedback below a
 * line (Feedback has no row of its own); Overview adds a server (the SERVERS `+`'s) or a connection, Automations starts
 * a new one, the Vault adds to it. The other places have nothing a menu would add, so they have none and keep the
 * browser's own.
 */
export function navMenu(
  row: Pick<AssistantNavRow, 'id' | 'href'>,
  model: Pick<AssistantSidebarModel, 'servers'> & Partial<Pick<AssistantSidebarModel, 'feedback'>>,
): NavMenuEntry[] {
  switch (row.id) {
    case 'chat':
      return [
        { id: 'settled', label: SETTLE_WORDS.settled, href: '/chat?settled=1' },
        { id: 'clear', label: clearChatWords('chat').menu, href: null, danger: true },
        // After Clear chats (chat-settle.md AP-6155): tidies the room's finished threads at once.
        { id: 'settle-finished', label: SETTLE_WORDS.settleFinished, href: null },
        ...(model.feedback
          ? [
              {
                id: 'feedback' as const,
                label: SETTLE_WORDS.openFeedback,
                href: '/feedback',
                separated: true,
              },
              {
                id: 'feedback-settled' as const,
                label: SETTLE_WORDS.feedbackSettled,
                href: '/feedback?settled=1',
              },
              {
                id: 'clear-feedback' as const,
                label: clearChatWords('feedback').menu,
                href: null,
                danger: true,
              },
              {
                id: 'settle-finished-feedback' as const,
                label: SETTLE_WORDS.settleFinishedFeedback,
                href: null,
              },
            ]
          : []),
      ];
    case 'dashboard':
    case 'home':
      return [
        ...(model.servers?.addHref
          ? [{ id: 'add-server' as const, label: 'Add a server', href: model.servers.addHref }]
          : []),
        {
          id: 'add-connection',
          label: 'Add a connection',
          href: ADD_CONNECTION_HREF,
        },
      ];
    case 'automations':
      return [{ id: 'new-automation', label: 'New automation', href: '/automations?new=1' }];
    case 'vault':
      return [{ id: 'add-to-vault', label: VAULT_COPY.add, href: '/vault?add=1' }];
    default:
      return [];
  }
}
