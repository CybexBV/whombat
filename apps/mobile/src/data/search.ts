/**
 * Search on the phone (docs/decisions/phone-shell-final.md): one page that finds a chat, a thing, a setting or a place by
 * its words, grouped as Chats, Things, Settings and Places. It looks through what the app already read — Chat's and
 * Feedback's threads and Overview's servers and connections — and the app's own list of settings and places; nothing is
 * asked of an AI. Pure: the screen is `screens/SearchScreen.tsx`.
 */

import type { MarkLike } from '@whombat/brand';
import { agentKeysText, settingsGroupText, type ThreadRow, thingStatusLabels } from '@whombat/client';
import { clientTranslator } from '@whombat/client/i18n';
import type { ThingSummary } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import type { AdvancedRowView } from '../settings/groups';
import { settingsText } from '../settings/list';
import { PLACES, type PlaceId, placeLine, placesThings, placeWords, type ServerFacts } from './places';
import type { PhoneGlyph } from './thingLook';

export type SearchGroup = 'chats' | 'things' | 'settings' | 'places';

export const SEARCH_GROUPS: readonly SearchGroup[] = ['chats', 'things', 'settings', 'places'];

export function searchCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    title: t('search.searchCopy.title'),
    intro: t('search.searchCopy.intro'),
    field: t('search.searchCopy.field'),
    clear: t('search.searchCopy.clear'),
    groups: {
      chats: t('search.searchCopy.groups.chats'),
      things: t('search.searchCopy.groups.things'),
      settings: t('search.searchCopy.groups.settings'),
      places: t('search.searchCopy.groups.places'),
    } satisfies Record<SearchGroup, string>,
    count: (count: number) => (count === 0 ? t('search.noResults') : t('search.results', { count })),
    searching: t('search.searchCopy.searching'),
    looking: (q: string) => t('search.searchCopy.looking', { q }),
    emptyTitle: t('search.searchCopy.emptyTitle'),
    emptyBody: t('search.searchCopy.emptyBody'),
    suggestions: t('search.searchCopy.suggestions'),
    noneTitle: (q: string) => t('search.searchCopy.noneTitle', { q }),
    noneBody: t('search.searchCopy.noneBody'),
    failedStatus: t('search.searchCopy.failedStatus'),
    failedTitle: t('search.searchCopy.failedTitle'),
    failedBody: t('search.searchCopy.failedBody'),
    retry: t('search.searchCopy.retry'),
    waiting: t('search.searchCopy.waiting'),
    working: (assistant: string) => t('search.searchCopy.working', { assistant }),
    noReplies: t('search.searchCopy.noReplies'),
    inFeedback: t('search.searchCopy.inFeedback'),
    notifications: t('search.searchCopy.notifications'),
    notificationsLine: t('search.searchCopy.notificationsLine'),
    theme: t('search.searchCopy.theme'),
    themeLine: t('search.searchCopy.themeLine'),
  } as const;
}
export const SEARCH_COPY = searchCopy();

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
  locale?: string,
): string {
  const copy = searchCopy(locale);
  const line = row.waiting
    ? copy.waiting
    : row.working
      ? copy.working(assistant)
      : (row.replies ?? copy.noReplies);
  return row.room === 'feedback' ? `${copy.inFeedback} · ${line}` : line;
}

/** Everything Search looks through, in the groups' order; a thread once even when two rooms' lists both hold it. */
export function searchEntries(input: {
  threads: readonly ThreadRow[];
  things: readonly ThingSummary[] | undefined;
  settings: readonly SearchSetting[];
  assistant: string;
  /** What the hosts service says of the servers: their logos, systems and how they are. */
  servers?: readonly ServerFacts[];
  locale?: string;
}): SearchEntry[] {
  const labels = placeWords(input.locale);
  const statusLabels = thingStatusLabels(input.locale);
  const out: SearchEntry[] = [];
  const seen = new Set<string>();
  for (const t of input.threads) {
    if (seen.has(t.rootId)) continue;
    seen.add(t.rootId);
    out.push({
      key: `chat:${t.rootId}`,
      group: 'chats',
      title: t.text || '…',
      line: chatLine(t, input.assistant, input.locale),
      terms: t.subject?.name ?? '',
      open: { kind: 'thread', rootId: t.rootId },
    });
  }
  const byId = new Map((input.things ?? []).map((t) => [t.id, t]));
  const facts = new Map((input.servers ?? []).map((s) => [s.thingId, s]));
  const { servers, connections } = placesThings(input.things, input.servers, input.locale);
  for (const row of [...servers, ...connections]) {
    const thing = byId.get(row.id);
    const server = facts.get(row.id);
    // A server as Overview says it (“Proxmox VE 9.0 · Running warm”), a connection by how it is and its own line.
    const line = server
      ? [server.osLine.split(' · ')[0], server.status]
      : [row.reason ?? statusLabels[row.status], thing?.line];
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
    out.push({
      key: `place:${place}`,
      group: 'places',
      title: labels[place],
      line: placeLine(place, input.assistant, input.locale),
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
export function searchMatches(
  entries: readonly SearchEntry[],
  query: string,
  locale?: string,
): SearchResultGroup[] {
  const copy = searchCopy(locale);
  const words = queryWords(query);
  if (words.length === 0) return [];
  const hits = entries.filter((e) => {
    const text = `${e.title} ${e.line} ${e.terms}`.toLocaleLowerCase();
    return words.every((w) => text.includes(w));
  });
  return SEARCH_GROUPS.flatMap((group) => {
    const rows = hits.filter((e) => e.group === group);
    return rows.length ? [{ group, title: copy.groups[group], rows }] : [];
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
  locale?: string;
}): SearchView {
  const query = input.query.trim();
  if (!queryWords(query).length) return { kind: 'empty' };
  if (input.failed) return { kind: 'failed' };
  if (input.loading) return { kind: 'loading', query };
  const groups = searchMatches(input.entries, query, input.locale);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  return count ? { kind: 'results', count, groups } : { kind: 'none', query };
}

/** The suggestions under the empty page: real names that find something, a thing first, then a setting and a place. */
export function searchSuggestions(entries: readonly SearchEntry[], locale?: string): string[] {
  const copy = searchCopy(locale);
  const thing = entries.find((e) => e.group === 'things')?.title;
  return [thing, copy.notifications, copy.theme, placeWords(locale).files]
    .filter((s): s is string => !!s && searchMatches(entries, s, locale).length > 0)
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
  locale?: string;
}): SearchSetting[] {
  const groups = settingsGroupText(input.locale).groups(input.assistant);
  const { t } = clientTranslator(input.locale);
  const copy = searchCopy(input.locale);
  const settings = settingsText(input.locale);
  const own = mobileTranslator(input.locale);
  const rows: SearchSetting[] = [
    {
      key: 'you',
      title: groups.you,
      line: input.you,
      terms: own.t('data.search.terms.you'),
      icon: 'you',
      target: { kind: 'page', name: 'SettingsProfile' },
    },
    ...(input.managed
      ? [
          {
            key: 'notifications',
            title: copy.notifications,
            line: copy.notificationsLine,
            terms: own.t('data.search.terms.notifications'),
            icon: 'bell',
            target: { kind: 'page', name: 'SettingsNotifications' },
          } satisfies SearchSetting,
        ]
      : []),
    {
      key: 'theme',
      title: copy.theme,
      line: copy.themeLine,
      terms: own.t('data.search.terms.theme'),
      icon: 'theme',
      target: { kind: 'tab' },
    },
    ...(input.managed
      ? [
          {
            key: 'language',
            title: t('settings.language.title'),
            line: t('settings.language.line'),
            terms: 'English Nederlands',
            icon: 'you',
            target: { kind: 'page', name: 'SettingsProfile' },
          } satisfies SearchSetting,
        ]
      : []),
    {
      key: 'assistant',
      title: groups.agent,
      line: own.t('data.search.assistantLine'),
      terms: own.t('data.search.terms.assistant'),
      icon: 'assistant',
      target: { kind: 'page', name: 'SettingsAgent' },
    },
    {
      // The keys and the commands always allowed: a page under What it may do.
      key: 'keys',
      title: agentKeysText(input.assistant, input.locale).title,
      line: agentKeysText(input.assistant, input.locale).line,
      terms: groups.agent,
      icon: 'part',
      target: { kind: 'page', name: 'SettingsAdvancedPart', params: { part: 'keys' } },
    },
    {
      key: 'connections',
      title: settings.rows.connections,
      line: own.t('data.search.connectionsLine'),
      icon: 'connections',
      target: { kind: 'page', name: 'Connections' },
    },
    {
      key: 'appliance',
      title: settings.rows.appliance,
      line: own.t('data.search.applianceLine'),
      terms: own.t('data.search.terms.appliance'),
      icon: 'box',
      target: { kind: 'page', name: input.managed ? 'Whombat' : 'SettingsWhombat' },
    },
    ...(input.news
      ? [
          {
            key: 'news',
            title: settings.rows.news,
            line: settings.newsLine,
            terms: own.t('data.search.terms.news'),
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
            line: own.t('data.search.screenLine'),
            terms: own.t('data.search.terms.screen'),
            icon: 'screen',
            target: { kind: 'page', name: 'SettingsDesk' },
          } satisfies SearchSetting,
        ]
      : []),
    {
      key: 'advanced',
      title: settings.rows.advanced,
      line: settings.advancedLine,
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
      terms: settings.rows.advanced,
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
