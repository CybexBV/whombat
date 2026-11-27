/**
 * Places (docs/decisions/phone-shell-final.md, servers-connections-places.md): the one list of where the app goes, in
 * the web sidebar's order — Search, Chat, Inbox, Overview, Servers, Connections, Automations, Files, Vault, Usage,
 * Settings. Chat, the Inbox, Overview, Automations and Settings are the bar's tabs; Servers and Connections are list
 * screens (each a list beside the picked page from the two-page width); Files, Vault and Usage are pages pushed over
 * the tabs, Search its own page. Servers shows once there is a server or the hosts service runs, Connections once
 * something is connected; each carries the worst mark of what it holds. The two lists' rows are the shared
 * `serverPlaceRows` and `connectionPlaceRows` (`@whombat/client`) with the phone's glyph and the address a thing without
 * a page follows. Pure: the sheet is `ui/places.tsx`, the row above a tab's screen `ui/topRow.tsx`, the lists
 * `screens/PlaceScreen.tsx`.
 */
import type { MarkLike } from '@whombat/brand';
import {
  connectionPlaceRows,
  type OverviewTile,
  type PlaceRow,
  placeRowsTone,
  serverPlaceRows,
  serverQuietWords,
  type ThingPlace,
  type ThingRow,
  thingRows,
} from '@whombat/client';
import type { HostServer, ThingSummary } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import { serviceRowOpens } from './home';
import type { Tab } from './shell';
import { type PhoneGlyph, phoneThingGlyph } from './thingLook';

export type PlaceId =
  | 'search'
  | 'chat'
  | 'inbox'
  | 'overview'
  | 'servers'
  | 'connections'
  | 'automations'
  | 'files'
  | 'vault'
  | 'usage'
  | 'settings';

/** Every place, in the order the web's sidebar and Places show them. */
export const PLACES: readonly PlaceId[] = [
  'search',
  'chat',
  'inbox',
  'overview',
  'servers',
  'connections',
  'automations',
  'files',
  'vault',
  'usage',
  'settings',
];

/** What each place is called: the tabs' own words, Overview's title, and Usage for what was Spend. */
export function placeWords(locale?: string): Record<PlaceId, string> {
  const { t } = mobileTranslator(locale);
  return {
    search: t('places.search'),
    chat: t('places.chat'),
    inbox: t('places.inbox'),
    overview: t('places.overview'),
    servers: t('places.servers'),
    connections: t('places.connections'),
    automations: t('places.automations'),
    files: t('places.files'),
    vault: t('places.vault'),
    usage: t('places.usage'),
    settings: t('places.settings'),
  };
}
export const PLACE_WORDS = placeWords();

export function placesCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    title: t('places.title'),
    open: t('places.title'),
    close: t('places.close'),
    servers: t('places.servers'),
    connections: t('places.connections'),
  };
}
export const PLACES_COPY = placesCopy();

/** One line on what is in each place, under its name in Search's results. */
export function placeLine(place: Exclude<PlaceId, 'search'>, assistant: string, locale?: string): string {
  return mobileTranslator(locale).t(`places.line.${place}`, { assistant });
}

/** The tab a place is, for the places that are tabs. */
export const PLACE_TABS: Partial<Record<PlaceId, Tab>> = {
  chat: 'ChatRoom',
  inbox: 'NeedsYou',
  overview: 'Dashboard',
  automations: 'Automations',
  settings: 'Settings',
};

/**
 * Where a place goes: a tab (the pages above the tabs close), or a page pushed on top whose “‹ …” names the page it was
 * opened from (`back`). Usage is the Spend screen under its new name.
 */
export type PlaceRoute =
  | { kind: 'tab'; tab: Tab }
  | {
      kind: 'page';
      name: 'Search' | 'ServersPlace' | 'ConnectionsPlace' | 'Files' | 'Vault' | 'Spend';
      params: { back: string };
    };

/** The list screen of each of the two list places. */
export const PLACE_SCREENS = {
  servers: 'ServersPlace',
  connections: 'ConnectionsPlace',
} as const satisfies Record<ThingPlace, string>;

/** The list place a screen is, for the list screens. */
export function listPlaceOfScreen(name: string | undefined): ThingPlace | null {
  return name === PLACE_SCREENS.servers
    ? 'servers'
    : name === PLACE_SCREENS.connections
      ? 'connections'
      : null;
}

const PLACE_PAGES = {
  search: 'Search',
  servers: PLACE_SCREENS.servers,
  connections: PLACE_SCREENS.connections,
  files: 'Files',
  vault: 'Vault',
  usage: 'Spend',
} as const satisfies Partial<Record<PlaceId, string>>;

export function placeRoute(place: PlaceId, back: string): PlaceRoute {
  const tab = PLACE_TABS[place];
  if (tab) return { kind: 'tab', tab };
  const name = PLACE_PAGES[place as keyof typeof PLACE_PAGES] ?? 'Search';
  return { kind: 'page', name, params: { back } };
}

/** Which place a screen is, to mark it in the sheet: a tab, or one of the pages Places opens. */
export function placeOfScreen(name: string | undefined): PlaceId | null {
  switch (name) {
    case 'ChatRoom':
      return 'chat';
    case 'NeedsYou':
      return 'inbox';
    case 'Dashboard':
      return 'overview';
    case 'Automations':
      return 'automations';
    case 'Settings':
      return 'settings';
    case 'Search':
      return 'search';
    case 'ServersPlace':
      return 'servers';
    case 'ConnectionsPlace':
      return 'connections';
    case 'Files':
      return 'files';
    case 'Vault':
      return 'vault';
    case 'Spend':
      return 'usage';
    default:
      return null;
  }
}

/**
 * A thing's row in the sidebar: the shared row, its glyph as the phone draws it (Website feedback's bubble), and the
 * address it follows instead of its page — an account a box gives no page (its Settings link), as Home's rows do.
 */
export interface PlaceThingRow extends Omit<ThingRow, 'glyph'> {
  glyph: PhoneGlyph;
  /** The address to follow instead of the thing's page (`serviceRowOpens`); null opens the page. */
  opens: string | null;
}

/** Every server and connection with its logo, for Search's Things: the servers, then the connections and devices. */
export interface PlacesThings {
  servers: PlaceThingRow[];
  connections: PlaceThingRow[];
}

/** What the hosts service says of a server that the thing list doesn't (for Search): its logo, its system, how it is. */
export interface ServerFacts {
  thingId: string;
  mark: MarkLike | null;
  /** “Proxmox VE 9.0 · up 19 d”. */
  osLine: string;
  /** “Running”, “Running warm”, “Disk array failed”. */
  status: string;
}

/**
 * The servers' and connections' rows Search finds; a server wears the logo of what it runs where the hosts service
 * knows it (as on Overview), never a plain server where there is a real logo.
 */
export function placesThings(
  things: readonly ThingSummary[] | undefined,
  servers: readonly ServerFacts[] = [],
  locale?: string,
): PlacesThings {
  const list = things ?? [];
  const serverIds = new Set(list.filter((t) => t.kind === 'server').map((t) => t.id));
  const facts = new Map(servers.map((s) => [s.thingId, s]));
  const byId = new Map(list.map((t) => [t.id, t]));
  const rows = thingRows(list, undefined, locale).map((r): PlaceThingRow => {
    const mark = facts.get(r.id)?.mark;
    const thing = byId.get(r.id);
    return {
      ...r,
      ...(mark ? { mark } : {}),
      glyph: thing ? phoneThingGlyph(thing) : r.glyph,
      opens: thing ? serviceRowOpens(thing) : null,
    };
  });
  return {
    servers: rows.filter((r) => serverIds.has(r.id)),
    connections: rows.filter((r) => !serverIds.has(r.id)),
  };
}

/**
 * What a place's row says to VoiceOver and TalkBack, its count included once (the number on screen is decorative):
 * “Chat, 1 unread reply”, “Inbox, 3 things need you, something isn’t working”.
 */
export function placeLabel(place: PlaceId, count: number, broken = false, locale?: string): string {
  const name = placeWords(locale)[place];
  const { t } = mobileTranslator(locale);
  if (count <= 0) return name;
  if (place === 'chat') return `${name}, ${t('places.unread', { count })}`;
  if (place === 'inbox') {
    const need = t('places.needs', { count });
    return broken ? `${name}, ${need}, ${t('places.broken')}` : `${name}, ${need}`;
  }
  return name;
}

/* Servers and Connections ------------------------------------------------------------------------------------------ */

/** A row of the Servers or Connections list: the shared row, its glyph as the phone draws it, where it opens. */
export interface PhonePlaceRow extends PlaceRow {
  /** The glyph the phone draws where there is no logo (Website feedback's bubble rather than the plug). */
  phoneGlyph: PhoneGlyph;
  /** The address to follow instead of the thing's page (an account an older box gives no page); null opens the page. */
  opens: string | null;
}

export interface PlaceLists {
  servers: PhonePlaceRow[];
  connections: PhonePlaceRow[];
  /** The worst mark each place's row in the sheet carries; null when all is fine. */
  tone: Record<ThingPlace, 'bad' | 'warn' | null>;
  /** The hosts service runs here: Servers' `+` (Add a server) needs it. */
  hosts: boolean;
  /** Whether the place is in the sheet: Servers with a server or the hosts service, Connections with one connected. */
  shown: Record<ThingPlace, boolean>;
}

/**
 * The two lists from what Overview reads: Home's things, the hosts fleet (Servers in Overview's order and words) and
 * Overview's connection tiles (Connections worst first with each tile's line).
 */
export function placeLists(input: {
  things: readonly ThingSummary[] | undefined;
  fleet: readonly HostServer[] | null | undefined;
  /** The hosts service runs on this Whombat. */
  hosts: boolean;
  tiles: readonly OverviewTile[] | null | undefined;
  now: number;
  timeZone: string;
  locale?: string | null;
}): PlaceLists {
  const list = input.things ?? [];
  const byId = new Map(list.map((t) => [t.id, t]));
  const rows = thingRows(list, undefined, input.locale);
  const serverIds = new Set(list.filter((t) => t.kind === 'server').map((t) => t.id));
  const serverThings = rows.filter((r) => serverIds.has(r.id));
  const connectionThings = rows.filter((r) => !serverIds.has(r.id));
  const phone = (row: PlaceRow): PhonePlaceRow => {
    const thing = byId.get(row.id);
    return {
      ...row,
      phoneGlyph: thing ? phoneThingGlyph(thing) : row.glyph,
      opens: thing ? serviceRowOpens(thing) : null,
    };
  };
  const quiet = serverQuietWords(list, input.now, input.timeZone, input.locale);
  const servers = serverPlaceRows(
    input.fleet,
    serverThings,
    input.now,
    input.timeZone,
    quiet,
    input.locale,
  ).map(phone);
  const connections = connectionPlaceRows(connectionThings, input.tiles, input.locale).map(phone);
  return {
    servers,
    connections,
    // The marks from the rows the lists show, so the sheet and the list never disagree.
    tone: { servers: placeRowsTone(servers), connections: placeRowsTone(connections) },
    hosts: input.hosts,
    shown: { servers: servers.length > 0 || input.hosts, connections: connections.length > 0 },
  };
}

/** The places the sheet lists: every place, Servers and Connections only when they hold something. */
export function sheetPlaces(shown: Record<ThingPlace, boolean>): PlaceId[] {
  return PLACES.filter((p) => (p === 'servers' || p === 'connections' ? shown[p] : true));
}

/** With two pages, the right page while nothing from the list is open there. */
export const PLACE_PICK: Record<ThingPlace, string> = {
  servers: 'Pick a server to see it here.',
  connections: 'Pick a connection to see it here.',
};
