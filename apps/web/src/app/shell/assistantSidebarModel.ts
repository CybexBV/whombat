/**
 * The assistant shell's sidebar (mock 1; one-whombat.md ONE-04; app one-whombat-shell.md AP-1256): pure, so its rules
 * are unit-tested.
 *
 * - The burrow's name (its switcher), then the places in one order: Chat, Inbox, Overview, Servers, Connections,
 *   Automations, Files, Vault (servers-connections-places.md). Settings is in the account menu (and ⌘, / Ctrl ,),
 *   Search is ⌘K / Ctrl K, Usage opens only at its address: none is a row of its own. Chat's badge counts its unread
 *   replies and Feedback's (Feedback opens from Chat's head); the Inbox's is the one count of what needs the person
 *   (`summary.needsYou`) in the colour of the worst of them. A count shows once the Whombat has answered and never at
 *   zero.
 * - Servers shows once there is a server or the Whombat runs the hosts service, Connections once something is
 *   connected; each carries the worst mark of what it holds and is the selected place on the page of one of its
 *   own. Their lists are drawn beside the page (`features/things/places`), not in the sidebar.
 * - The person at the bottom, with the account menu.
 *
 * Before the Chat shell (no rooms; tests and an older Whombat): Overview is the home page (`/`), and CONVERSATIONS and
 * **Ask Neo** stay (the assistant's name, Whombat assistant-name.md AN-01).
 */
import {
  agentWords,
  type ChatRooms,
  type ChatRow,
  chatRows,
  placeSpoken,
  placeTone,
  placeWords,
  type ThingPlace,
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
import { vaultCopy } from '@whombat/core/vault';
import { clearChatWords } from '../../features/chats/clearWords';
import { currentLocale, webTranslator } from '../../i18n/provider';
import { appPlaceWords, PLACES_WORDS, SETTLE_WORDS } from '../../i18n/shared';
import { INBOX_PATH, type ShellLocation } from './location';

export type AssistantNavId =
  | 'chat'
  | 'needsYou'
  | 'dashboard'
  | 'home'
  | 'servers'
  | 'connections'
  | 'automations'
  | 'files'
  | 'vault';

/** The addresses of the two places: `/connections` stays Overview's, so Connections is `/connected`. */
export const PLACE_HREFS: Record<ThingPlace, string> = { servers: '/servers', connections: '/connected' };

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
  /** Servers' and Connections' mark: the worst of what they hold when it isn't fine; null otherwise. */
  mark: 'bad' | 'warn' | null;
  /**
   * Servers' or Connections' item while one of its pages is open: on a wide window the list is beside it already, so
   * the item leaves the page as it is rather than open the place again.
   */
  pageOpen?: boolean;
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
  /** Servers: null while there is nothing to show (no server, no hosts service). */
  servers: AssistantServersSection | null;
  /** Connections: everything listed but the servers. */
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
    mark: null,
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
  const { me } = bootstrap;
  const rows = thingRows(input.things ?? [], location.kind === 'thing' ? location.id : null, currentLocale());
  const serverIds = new Set((input.things ?? []).filter((t) => t.kind === 'server').map((t) => t.id));
  const servers = serversSection(
    input,
    rows.filter((r) => serverIds.has(r.id)),
  );
  const connections = rows.filter((r) => !serverIds.has(r.id));
  // Servers and Connections: the place is selected on its address and on the page of one of its own.
  const placeRow = (place: ThingPlace, held: readonly ThingRow[]) => {
    const here =
      (location.kind === 'place' && location.place === place) ||
      (location.kind === 'thing' && held.some((r) => r.id === location.id));
    const r = row(place, placeWords(currentLocale())[place].title, PLACE_HREFS[place], here);
    r.mark = placeTone(held);
    r.pageOpen = location.kind === 'thing' && here;
    r.ariaLabel = placeSpoken(place, r.mark, currentLocale());
    return r;
  };
  const nav: AssistantNavRow[] = [
    chat,
    inbox,
    // Before the Chat shell Overview is the home page (`/`).
    rooms
      ? row('dashboard', words.overview.label, CONNECTIONS_HREF, location.kind === 'dashboard' || allGuests)
      : row('home', words.overview.label, '/', location.kind === 'home' || allGuests),
    ...(servers ? [placeRow('servers', servers.rows)] : []),
    // Nothing connected yet: no empty place (first-day.md); Overview leads to adding one.
    ...(connections.length ? [placeRow('connections', connections)] : []),
    // Automations without a count: a total says nothing, a failed run is in the Inbox (SB-07, AP-2606).
    row('automations', words.automations.label, '/automations', location.kind === 'automations'),
    row('files', words.files.label, '/files', location.kind === 'files'),
    row('vault', words.vault.label, '/vault', location.kind === 'vault'),
  ];
  return {
    burrowName: bootstrap.burrow.name,
    burrowSlug: bootstrap.burrow.slug,
    ask: rooms ? null : agentWords(agent, currentLocale()).ask,
    nav,
    roomPaths: rooms ? ['/chat', ...(rooms.feedback ? ['/feedback'] : [])] : [],
    feedback: !!rooms?.feedback,
    servers,
    things: connections,
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
 * Servers: shown with a server or the hosts service; Add a server with the hosts service, on Overview's Servers
 * section (`/connections?tab=servers&add=1`; before the Chat shell `/?…`, the same page).
 */
function serversSection(input: AssistantSidebarInput, rows: ThingRow[]): AssistantServersSection | null {
  if (!rows.length && !input.hosts?.present) return null;
  const add = addServerHref().replace('?', '?tab=servers&');
  return {
    addHref: input.hosts?.present ? (input.rooms ? add : add.replace(CONNECTIONS_HREF, '/')) : null,
    rows,
  };
}

/** Add a connection, the page Overview's own button opens. */
export const ADD_CONNECTION_HREF = `${CONNECTIONS_HREF}?connection=add`;

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
 * line (Feedback has no row of its own); Overview adds a server or a connection, Servers a server, Connections a
 * connection (servers-connections-places.md), Automations starts
 * a new one, the Vault adds to it. The other places have nothing a menu would add, so they have none and keep the
 * browser's own.
 */
export function navMenu(
  row: Pick<AssistantNavRow, 'id' | 'href'>,
  model: Pick<AssistantSidebarModel, 'servers'> & Partial<Pick<AssistantSidebarModel, 'feedback'>>,
  locale?: string | null,
): NavMenuEntry[] {
  const { t } = webTranslator(locale);
  const VAULT_COPY = vaultCopy(locale);
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
          ? [{ id: 'add-server' as const, label: t('sidebar.addServer'), href: model.servers.addHref }]
          : []),
        {
          id: 'add-connection',
          label: t('sidebar.addConnection'),
          href: ADD_CONNECTION_HREF,
        },
      ];
    // Servers adds a server, Connections a connection.
    case 'servers':
      return model.servers?.addHref
        ? [{ id: 'add-server', label: t('sidebar.addServer'), href: model.servers.addHref }]
        : [];
    case 'connections':
      return [{ id: 'add-connection', label: t('sidebar.addConnection'), href: ADD_CONNECTION_HREF }];
    case 'automations':
      return [{ id: 'new-automation', label: t('sidebar.newAutomation'), href: '/automations?new=1' }];
    case 'vault':
      return [{ id: 'add-to-vault', label: VAULT_COPY.add, href: '/vault?add=1' }];
    default:
      return [];
  }
}
