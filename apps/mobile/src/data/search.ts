/**
 * Search on the phone (docs/decisions/phone-shell-final.md): one page that finds a chat, a thing, a setting or a place by
 * its words, grouped as Chats, Things, Settings and Places. It looks through what the app already read — Chat's and
 * Feedback's threads and Overview's servers and connections — and the app's own list of settings and places; nothing is
 * asked of an AI. Pure: the screen is `screens/SearchScreen.tsx`.
 */

import type { MarkLike } from '@whombat/brand';
import { agentKeysText, SETTINGS_GROUP_TEXT, THING_STATUS_LABELS, type ThreadRow } from '@whombat/client';
import type { ThingSummary } from '@whombat/core';
import type { AdvancedRowView } from '../settings/groups';
import { SETTINGS_TEXT } from '../settings/list';
import { PLACE_WORDS, PLACES, type PlaceId, placeLine, placesThings, type ServerFacts } from './places';
import type { PhoneGlyph } from './thingLook';

export type SearchGroup = 'chats' | 'things' | 'settings' | 'places';

export const SEARCH_GROUPS: readonly SearchGroup[] = ['chats', 'things', 'settings', 'places'];

export const SEARCH_COPY = {
  title: 'Search',
  intro: 'Chats, things, settings and places.',
  field: 'Search everything',
  clear: 'Clear search',
  groups: { chats: 'Chats', things: 'Things', settings: 'Settings', places: 'Places' } satisfies Record<
    SearchGroup,
    string
  >,
  count: (n: number) => (n === 0 ? 'No results' : `${n} ${n === 1 ? 'result' : 'results'}`),
  searching: 'Searching…',
  looking: (q: string) => `Looking for “${q}”…`,
  emptyTitle: 'What are you looking for?',
  emptyBody: 'Find a chat, a server, a connection or a setting by its name.',
  suggestions: 'Try a search',
  noneTitle: (q: string) => `No results for “${q}”`,
  noneBody: 'Try a shorter name or a different word.',
  failedStatus: 'Search didn’t finish.',
  failedTitle: 'Couldn’t search',
  failedBody: 'Try again to look through your chats, things, settings and places.',
  retry: 'Try again',
  waiting: 'Waiting for you',
  working: (assistant: string) => `${assistant} is working`,
  noReplies: 'No replies yet',
  inFeedback: 'In Feedback',
  notifications: 'Notifications',
  notificationsLine: 'When this device alerts you',
  theme: 'Theme',
  themeLine: 'Light and dark on this device',
} as const;

/** Where a setting goes. `tab`: the Settings tab itself (the theme is a switch on it). */
export type SettingTarget =
  | { kind: 'tab' }
  | { kind: 'page'; name: string; params?: Record<string, string> | undefined };

/** A setting Search can find: its words, the icon's name and where it opens. */
export interface SearchSetting {
  key: string;
  title: string;
  line: string;
  /** More words it is found by that it doesn't show (“appearance” for Theme). */
  terms?: string;
  icon:
    | 'you'
    | 'bell'
    | 'theme'
    | 'assistant'
    | 'connections'
    | 'box'
    | 'news'
    | 'screen'
    | 'advanced'
    | 'part';
  target: SettingTarget;
}

/** What a result opens. */
export type SearchOpen =
  | { kind: 'thread'; rootId: string }
  /** `href`: the address to follow instead of its page (an account a box gives no page), as the sidebar does. */
  | { kind: 'thing'; thingId: string; title: string; href?: string | null }
  | { kind: 'setting'; target: SettingTarget }
  | { kind: 'place'; place: Exclude<PlaceId, 'search'> };

export interface SearchEntry {
  key: string;
  group: SearchGroup;
  title: string;
  line: string;
  /** What it is found by besides its title and line. */
  terms: string;
  /** Things: the glyph, and the real logo drawn instead of it when there is one. */
  glyph?: PhoneGlyph;
  mark?: MarkLike | null;
  /** Settings: their icon. */
  icon?: SearchSetting['icon'];
  open: SearchOpen;
}

/** A thread's line: waiting for the person first, then the assistant at work, then its replies. */
export function chatLine(
  row: Pick<ThreadRow, 'waiting' | 'working' | 'replies' | 'room'>,
  assistant: string,
): string {
  const line = row.waiting
    ? SEARCH_COPY.waiting
    : row.working
      ? SEARCH_COPY.working(assistant)
      : (row.replies ?? SEARCH_COPY.noReplies);
  return row.room === 'feedback' ? `${SEARCH_COPY.inFeedback} · ${line}` : line;
}

/** Everything Search looks through, in the groups' order; a thread once even when two rooms' lists both hold it. */
export function searchEntries(input: {
  threads: readonly ThreadRow[];
  things: readonly ThingSummary[] | undefined;
  settings: readonly SearchSetting[];
  assistant: string;
  /** What the hosts service says of the servers: their logos, systems and how they are. */
  servers?: readonly ServerFacts[];
}): SearchEntry[] {
  const out: SearchEntry[] = [];
  const seen = new Set<string>();
  for (const t of input.threads) {
    if (seen.has(t.rootId)) continue;
    seen.add(t.rootId);
    out.push({
      key: `chat:${t.rootId}`,
      group: 'chats',
      title: t.text || '…',
      line: chatLine(t, input.assistant),
      terms: t.subject?.name ?? '',
      open: { kind: 'thread', rootId: t.rootId },
    });
  }
  const byId = new Map((input.things ?? []).map((t) => [t.id, t]));
  const facts = new Map((input.servers ?? []).map((s) => [s.thingId, s]));
  const { servers, connections } = placesThings(input.things, input.servers);
  for (const row of [...servers, ...connections]) {
    const thing = byId.get(row.id);
    const server = facts.get(row.id);
    // A server as Overview says it (“Proxmox VE 9.0 · Running warm”), a connection by how it is and its own line.
    const line = server
      ? [server.osLine.split(' · ')[0], server.status]
      : [row.reason ?? THING_STATUS_LABELS[row.status], thing?.line];
    out.push({
      key: `thing:${row.id}`,
      group: 'things',
      title: row.name,
      line: line.filter(Boolean).join(' · '),
      terms: [thing?.catalogId, thing?.icon, thing?.kind].filter(Boolean).join(' '),
      glyph: row.glyph,
      mark: row.mark,
      open: { kind: 'thing', thingId: row.id, title: row.name, href: row.opens },
    });
  }
  for (const s of input.settings)
    out.push({
      key: `setting:${s.key}`,
      group: 'settings',
      title: s.title,
      line: s.line,
      terms: s.terms ?? '',
      icon: s.icon,
      open: { kind: 'setting', target: s.target },
    });
  for (const place of PLACES) {
    if (place === 'search') continue;
    // Servers and Connections once they hold something, as the Places sheet shows them.
    if (place === 'servers' && !servers.length) continue;
    if (place === 'connections' && !connections.length) continue;
    out.push({
      key: `place:${place}`,
      group: 'places',
      title: PLACE_WORDS[place],
      line: placeLine(place, input.assistant),
      terms: '',
      open: { kind: 'place', place },
    });
  }
  return out;
}

/** The words a query is split into, folded so “PVE” finds “pve-02”. */
export function queryWords(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

export interface SearchResultGroup {
  group: SearchGroup;
  title: string;
  rows: SearchEntry[];
}

/** The entries every word of the query is in, in their groups, each group in the entries' order. */
export function searchMatches(entries: readonly SearchEntry[], query: string): SearchResultGroup[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const hits = entries.filter((e) => {
    const text = `${e.title} ${e.line} ${e.terms}`.toLocaleLowerCase();
    return words.every((w) => text.includes(w));
  });
  return SEARCH_GROUPS.flatMap((group) => {
    const rows = hits.filter((e) => e.group === group);
    return rows.length ? [{ group, title: SEARCH_COPY.groups[group], rows }] : [];
  });
}

/**
 * What the page shows: nothing typed yet; the reads still coming; one that failed (Try again); no results; or the
 * groups. Settings and places need no read, but results stay back until the reads are in, so a list doesn't grow under
 * the finger.
 */
export type SearchView =
  | { kind: 'empty' }
  | { kind: 'loading'; query: string }
  | { kind: 'failed' }
  | { kind: 'none'; query: string }
  | { kind: 'results'; count: number; groups: SearchResultGroup[] };

export function searchView(input: {
  query: string;
  entries: readonly SearchEntry[];
  loading: boolean;
  failed: boolean;
}): SearchView {
  const query = input.query.trim();
  if (!queryWords(query).length) return { kind: 'empty' };
  if (input.failed) return { kind: 'failed' };
  if (input.loading) return { kind: 'loading', query };
  const groups = searchMatches(input.entries, query);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  return count ? { kind: 'results', count, groups } : { kind: 'none', query };
}

/** The suggestions under the empty page: real names that find something, a thing first, then a setting and a place. */
export function searchSuggestions(entries: readonly SearchEntry[]): string[] {
  const thing = entries.find((e) => e.group === 'things')?.title;
  return [thing, SEARCH_COPY.notifications, SEARCH_COPY.theme, PLACE_WORDS.files]
    .filter((s): s is string => !!s && searchMatches(entries, s).length > 0)
    .slice(0, 3);
}

/**
 * The settings Search finds, as the Settings tab lists them: You (and its notifications), the theme, the assistant by
 * its name, Connections, This Whombat, the box's screen where it has one, Advanced and each of Advanced's pages. Usage is
 * a place of its own, so its Advanced row isn't listed twice.
 */
export function searchSettings(input: {
  assistant: string;
  managed: boolean;
  you: string;
  /** The box's screen row's name, where it has one (“Screen”, “Screens”). */
  screen: string | null;
  /** The Whombat answers the place and the news: News and weather is a page. */
  news?: boolean;
  advanced: readonly AdvancedRowView[];
}): SearchSetting[] {
  const groups = SETTINGS_GROUP_TEXT.groups(input.assistant);
  const rows: SearchSetting[] = [
    {
      key: 'you',
      title: groups.you,
      line: input.you,
      terms: 'profile photo name',
      icon: 'you',
      target: { kind: 'page', name: 'SettingsProfile' },
    },
    ...(input.managed
      ? [
          {
            key: 'notifications',
            title: SEARCH_COPY.notifications,
            line: SEARCH_COPY.notificationsLine,
            terms: 'alerts push quiet hours',
            icon: 'bell',
            target: { kind: 'page', name: 'SettingsNotifications' },
          } satisfies SearchSetting,
        ]
      : []),
    {
      key: 'theme',
      title: SEARCH_COPY.theme,
      line: SEARCH_COPY.themeLine,
      terms: 'appearance light dark',
      icon: 'theme',
      target: { kind: 'tab' },
    },
    {
      key: 'assistant',
      title: groups.agent,
      line: 'Name and face, AI sign-in, memory and what it may do',
      terms: 'assistant',
      icon: 'assistant',
      target: { kind: 'page', name: 'SettingsAgent' },
    },
    {
      // The keys and the commands always allowed: a page under What it may do.
      key: 'keys',
      title: agentKeysText(input.assistant).title,
      line: agentKeysText(input.assistant).line,
      terms: groups.agent,
      icon: 'part',
      target: { kind: 'page', name: 'SettingsAdvancedPart', params: { part: 'keys' } },
    },
    {
      key: 'connections',
      title: SETTINGS_TEXT.rows.connections,
      line: 'What is connected and how',
      icon: 'connections',
      target: { kind: 'page', name: 'Connections' },
    },
    {
      key: 'appliance',
      title: SETTINGS_TEXT.rows.appliance,
      line: 'Backups, updates and this box',
      terms: 'whombat backup update',
      icon: 'box',
      target: { kind: 'page', name: input.managed ? 'Whombat' : 'SettingsWhombat' },
    },
    ...(input.news
      ? [
          {
            key: 'news',
            title: SETTINGS_TEXT.rows.news,
            line: SETTINGS_TEXT.newsLine,
            terms: 'weather place headlines feeds sources',
            icon: 'news',
            target: { kind: 'page', name: 'SettingsNews' },
          } satisfies SearchSetting,
        ]
      : []),
    ...(input.screen
      ? [
          {
            key: 'screen',
            title: input.screen,
            line: 'What the box’s screen shows',
            terms: 'display desk',
            icon: 'screen',
            target: { kind: 'page', name: 'SettingsDesk' },
          } satisfies SearchSetting,
        ]
      : []),
    {
      key: 'advanced',
      title: SETTINGS_TEXT.rows.advanced,
      line: SETTINGS_TEXT.advancedLine,
      icon: 'advanced',
      target: { kind: 'page', name: 'SettingsAdvanced' },
    },
  ];
  for (const row of input.advanced) {
    if (row.key === 'spend') continue;
    rows.push({
      key: `advanced:${row.key}`,
      title: row.title,
      line: row.line,
      terms: SETTINGS_TEXT.rows.advanced,
      icon: 'part',
      target: {
        kind: 'page',
        name: row.route.name,
        params: row.route.params as Record<string, string> | undefined,
      },
    });
  }
  return rows;
}
