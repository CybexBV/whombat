/**
 * Places (docs/decisions/phone-shell-final.md): the one list of where the app goes, in the web sidebar's order —
 * Search, Chat, Inbox, Overview, Automations, Files, Vault, Usage, Settings — and below it a shortcut to each server and
 * connection with its real logo. Chat, the Inbox, Overview, Automations and Settings are the bar's tabs; Files, Vault
 * and Usage are pages pushed over them, Search its own page. Pure: the sheet is `ui/places.tsx`, the row above a tab's
 * screen `ui/topRow.tsx`.
 */
import type { MarkLike } from '@whombat/brand';
import { type ThingRow, thingRows } from '@whombat/client';
import type { ThingSummary } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import { serviceRowOpens } from './home';
import type { Tab } from './shell';
import { type PhoneGlyph, phoneThingGlyph } from './thingLook';

export type PlaceId =
  | 'search'
  | 'chat'
  | 'inbox'
  | 'overview'
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
  | { kind: 'page'; name: 'Search' | 'Files' | 'Vault' | 'Spend'; params: { back: string } };

const PLACE_PAGES = {
  search: 'Search',
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

/** The shortcuts under the places: the servers, then the connections and devices, in the server's order. */
export interface PlacesThings {
  servers: PlaceThingRow[];
  connections: PlaceThingRow[];
}

/** What the hosts service says of a server that the thing list doesn't: its system's logo and name, how it is. */
export interface ServerFacts {
  thingId: string;
  mark: MarkLike | null;
  /** “Proxmox VE 9.0 · up 19 d”. */
  osLine: string;
  /** “Running”, “Running warm”, “Disk array failed”. */
  status: string;
}

/**
 * The servers' and connections' rows; a server wears the logo of what it runs where the hosts service knows it (as on
 * Overview), never a plain server where there is a real logo.
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
