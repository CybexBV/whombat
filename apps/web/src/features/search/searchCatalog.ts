/**
 * What Search finds without asking the Whombat (final-shell-web.md): the things (servers, connections, devices), the
 * settings' pages and the places, matched as the person types. Chats come from the Whombat's own search. Pure, so the
 * matching is unit-tested.
 */
import type { MarkLike } from '@whombat/brand';
import {
  APP_PLACES,
  type AppPlace,
  advancedRowsHere,
  agentGroupParts,
  agentKeysText,
  placeWords,
  type SettingsHere,
  settingsGroupText,
  settingsHomeText,
  type ThingGlyph,
  type ThingPlace,
  thingRows,
  thingStatusLabels,
  USAGE_HREF,
  youParts,
} from '@whombat/client';
import {
  NEWS_KIND_WORDS,
  NEWS_WORDS,
  PLACE_SETTING_WORDS,
  parseThingId,
  type ThingSummary,
} from '@whombat/core';
import { PLACE_HREFS as THING_PLACE_HREFS } from '../../app/shell/assistantSidebarModel';
import { INBOX_PATH } from '../../app/shell/location';
import { DESK_SCREENS_TEXT, THIS_WHOMBAT_TEXT } from '../../i18n/clientWords';
import { currentLocale, webTranslator } from '../../i18n/provider';
import { appPlaceWords, SEARCH_WORDS } from '../../i18n/shared';

export type CatalogGroup = 'things' | 'settings' | 'places';

/** The app's places and the sidebar's Servers and Connections, which Search lists right after Overview. */
export type SearchPlace = AppPlace | ThingPlace;

export type CatalogIcon =
  | { kind: 'mark'; mark: MarkLike }
  | { kind: 'glyph'; glyph: ThingGlyph }
  | { kind: 'place'; place: SearchPlace }
  | { kind: 'setting'; group: 'you' | 'agent' | 'connections' | 'appliance' | 'news' | 'advanced' };

export interface CatalogEntry {
  /** Unique within the catalogue: where Back puts the focus again. */
  key: string;
  group: CatalogGroup;
  title: string;
  line: string;
  href: string;
  icon: CatalogIcon;
  /** More words it is found by (its group's name). */
  terms: string;
}

export interface CatalogInput {
  /** Home's things (`home.overview`); undefined until it answers. */
  things: readonly ThingSummary[] | undefined;
  /** The assistant's name. */
  agent: string;
  here: SettingsHere;
  /** The Whombat answers where it is and the news it reads (`placeNewsShown`): News and weather is found too. */
  news?: boolean;
}

/** What News and weather is found by besides its name: its parts and the kinds of source it takes. */
const NEWS_SEARCH_TERMS = [
  PLACE_SETTING_WORDS.title,
  'location town city weather forecast headlines feeds RSS OPML',
  NEWS_WORDS.chosen,
  ...Object.values(NEWS_KIND_WORDS),
].join(' ');

const PLACE_HREFS: Record<AppPlace, string> = {
  search: '/search',
  chat: '/chat',
  inbox: INBOX_PATH,
  automations: '/automations',
  files: '/files',
  vault: '/vault',
  usage: USAGE_HREF,
  settings: '/settings',
};

/** Every place's address, in the sidebar's order. */
export function placeHref(place: AppPlace): string {
  return PLACE_HREFS[place];
}

export function searchCatalog({ things, agent, here, news = false }: CatalogInput): CatalogEntry[] {
  const THING_STATUS_LABELS = thingStatusLabels(currentLocale());
  const SETTINGS_GROUP_TEXT = settingsGroupText(currentLocale());
  const SETTINGS_HOME_TEXT = settingsHomeText(currentLocale());
  const entries: CatalogEntry[] = [];
  const kinds = SEARCH_WORDS.kinds;
  for (const row of thingRows(things ?? [], undefined, currentLocale())) {
    const kind = parseThingId(row.id)?.kind ?? 'connection';
    const how = row.reason ?? THING_STATUS_LABELS[row.status];
    entries.push({
      key: `thing:${row.id}`,
      group: 'things',
      title: row.name,
      line: `${kinds[kind] ?? kinds.connection} · ${how}`,
      href: row.href,
      icon: row.mark ? { kind: 'mark', mark: row.mark } : { kind: 'glyph', glyph: row.glyph },
      terms: SEARCH_WORDS.groups.things,
    });
  }
  const groups = SETTINGS_GROUP_TEXT.groups(agent);
  const setting = (
    key: string,
    group: Extract<CatalogIcon, { kind: 'setting' }>['group'],
    title: string,
    href: string,
    line = `${SETTINGS_GROUP_TEXT.title} · ${groups[group]}`,
  ) =>
    entries.push({
      key: `setting:${key}`,
      group: 'settings',
      title,
      line,
      href,
      icon: { kind: 'setting', group },
      terms: `${SETTINGS_GROUP_TEXT.title} ${groups[group]}`,
    });
  for (const part of youParts(here))
    setting(
      `you:${part}`,
      'you',
      SETTINGS_GROUP_TEXT.you[part],
      part === 'profile' ? '/settings' : `/settings?part=${part}`,
    );
  // Settings → Phone app, by the name Often used gives it, found by phone, app, QR…
  entries.push({
    key: 'setting:phone-app',
    group: 'settings',
    title: SETTINGS_HOME_TEXT.phoneApp.title,
    line: `${SETTINGS_GROUP_TEXT.title} · ${SETTINGS_HOME_TEXT.phoneApp.line(here.managed)}`,
    href: '/settings?tab=phone',
    icon: { kind: 'setting', group: 'you' },
    terms: `${SETTINGS_GROUP_TEXT.title} ${SETTINGS_HOME_TEXT.phoneApp.terms}`,
  });
  const parts = SETTINGS_GROUP_TEXT.agent(agent);
  for (const part of agentGroupParts(here))
    setting(
      `agent:${part}`,
      'agent',
      parts[part],
      part === 'profile' ? '/settings?tab=agent' : `/settings?tab=agent&part=${part}`,
    );
  // The keys and the commands always allowed, by the name they had: on What it may do.
  const keysPage = agentKeysText(agent, currentLocale());
  setting('agent:keys', 'agent', keysPage.title, '/settings?tab=agent&part=may', keysPage.line);
  setting('connections', 'connections', groups.connections, '/settings?tab=connections');
  setting('appliance:overview', 'appliance', groups.appliance, '/settings?tab=appliance');
  setting(
    'appliance:backups',
    'appliance',
    THIS_WHOMBAT_TEXT.parts.backups,
    '/settings?tab=appliance&section=backups',
  );
  setting('appliance:screen', 'appliance', DESK_SCREENS_TEXT.tab, '/settings?tab=appliance&section=screen');
  setting(
    'appliance:about',
    'appliance',
    THIS_WHOMBAT_TEXT.parts.about,
    '/settings?tab=appliance&section=about',
  );
  // News and weather, found by what is on it too (the place, the weather, the sources and their kinds).
  if (news)
    entries.push({
      key: 'setting:news',
      group: 'settings',
      title: groups.news,
      line: `${SETTINGS_GROUP_TEXT.title} · ${NEWS_WORDS.homeLine}`,
      href: '/settings?tab=news',
      icon: { kind: 'setting', group: 'news' },
      terms: `${SETTINGS_GROUP_TEXT.title} ${NEWS_SEARCH_TERMS}`,
    });
  // Advanced's pages with their own line; Usage isn't offered (its row is hidden too).
  for (const row of advancedRowsHere(agent, here, currentLocale()))
    if (row.key !== 'spend')
      setting(
        `advanced:${row.key}`,
        'advanced',
        row.title,
        `/settings?tab=advanced&part=${row.key}`,
        row.line,
      );
  const words = appPlaceWords(agent);
  // Search is where you are; Usage isn't offered anywhere on the web.
  for (const place of APP_PLACES)
    if (place !== 'search' && place !== 'usage')
      entries.push({
        key: `place:${place}`,
        group: 'places',
        title: words[place].label,
        line: words[place].line,
        href: PLACE_HREFS[place],
        icon: { kind: 'place', place },
        terms: SEARCH_WORDS.groups.places,
      });
  // Servers and Connections after the Inbox, as in the sidebar: Servers once it holds something, Connections always
  // (its list is where the first one is added).
  const inbox = entries.findIndex((e) => e.key === 'place:inbox');
  const listed = thingRows(things ?? []);
  const serverIds = new Set((things ?? []).filter((t) => t.kind === 'server').map((t) => t.id));
  const held: Record<ThingPlace, boolean> = {
    servers: listed.some((r) => serverIds.has(r.id)),
    connections: true,
  };
  entries.splice(
    inbox + 1,
    0,
    ...(['servers', 'connections'] as const)
      .filter((place) => held[place])
      .map(
        (place): CatalogEntry => ({
          key: `place:${place}`,
          group: 'places',
          title: placeWords(currentLocale())[place].title,
          line: webTranslator(currentLocale()).t(`place.${place}.line`),
          href: THING_PLACE_HREFS[place],
          icon: { kind: 'place', place },
          terms: SEARCH_WORDS.groups.places,
        }),
      ),
  );
  return entries;
}

/** The query's words, lower case; none for a blank query. */
export function queryWords(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/** The entries that have every word of the query in their title, line or terms, in the catalogue's order. */
export function matchCatalog(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  const words = queryWords(query);
  if (!words.length) return [];
  return entries.filter((e) => {
    const text = `${e.title} ${e.line} ${e.terms}`.toLocaleLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Suggestions under an empty query, from what is here: the first thing's name, a setting, a place. */
export function searchSuggestions(entries: readonly CatalogEntry[], agent: string): string[] {
  const SETTINGS_GROUP_TEXT = settingsGroupText(currentLocale());
  const thing = entries.find((e) => e.group === 'things')?.title;
  return [...(thing ? [thing] : []), SETTINGS_GROUP_TEXT.you.notifications, appPlaceWords(agent).files.label];
}
