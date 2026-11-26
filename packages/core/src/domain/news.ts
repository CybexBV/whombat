/**
 * Local news, headlines only (Whombat docs/decisions/weather-news.md): this Whombat reads the news sites the person turned
 * on, the way a feed reader does, and shows their headlines (the headline, the site, the time and a link; no pictures,
 * no article text). Whombat suggests sites for the place's country and region (`NEWS_SUGGESTIONS`), but nothing is read
 * until the person turns one on or adds a site of their own. Up to `NEWS_SOURCES_MAX` per burrow (`news.sources`,
 * `news.setSources`, `news.addSite`).
 */
import { z } from 'zod';
import { Timestamp } from './common.js';
import { NEWS_SUGGESTIONS, type NewsSuggestionRow } from './news-suggestions.js';
import { Place } from './place.js';

/** The WHATWG URL parser (browsers, Node); core's lib has neither DOM nor Node types. */
declare const URL: new (
  input: string,
) => { protocol: string; username: string; password: string; hostname: string; hash: string; href: string };

/** The most news sites a Whombat reads. */
export const NEWS_SOURCES_MAX = 12;
/** The most headlines kept of one site's feed. */
export const NEWS_FEED_ITEMS_MAX = 30;
/** The most headlines a widget or the assistant gets at once. */
export const NEWS_HEADLINES_MAX = 30;
/** How long a site's headlines are kept before it is read again. */
export const NEWS_FEED_KEEP_S = 15 * 60;
/** The longest site address taken. */
export const NEWS_URL_MAX = 2000;

/**
 * A news site's id: a suggestion's own (`nl-omroep-brabant`), or `own-…` for a site the person added
 * (`ownNewsSourceId`).
 */
export const NewsSourceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type NewsSourceId = z.infer<typeof NewsSourceId>;
/** The start of the id of a site the person added. */
export const NEWS_OWN_PREFIX = 'own-';

/** A feed's address: https, with a host name, no user name or password. */
export const NewsFeedUrl = z
  .string()
  .max(NEWS_URL_MAX)
  .refine((u) => newsSiteAddress(u) === u, 'Use the feed’s full https address.');

/** A news site Whombat reads: its id, its name (“Omroep Brabant”) and its feed's address. */
export const NewsSource = z.object({
  id: NewsSourceId,
  name: z.string().trim().min(1).max(80),
  url: NewsFeedUrl,
});
export type NewsSource = z.infer<typeof NewsSource>;

/** What a burrow keeps (`burrows.news`): the sites turned on, in the person's order. */
export const NewsSettings = z.object({ sources: z.array(NewsSource).max(NEWS_SOURCES_MAX) });
export type NewsSettings = z.infer<typeof NewsSettings>;

/** How near a suggestion is: the place's area (a Belgian province), its region (a province or state), its country. */
export const NEWS_NEAR = ['area', 'region', 'country'] as const;
export const NewsNear = z.enum(NEWS_NEAR);
export type NewsNear = z.infer<typeof NewsNear>;

/** A site Whombat suggests for the place: its language (ISO 639-1, `nl`) and how near it is. */
export const NewsSuggestion = NewsSource.extend({
  lang: z.string().regex(/^[a-z]{2,3}$/),
  near: NewsNear,
});
export type NewsSuggestion = z.infer<typeof NewsSuggestion>;

/**
 * A site that is on: whether the person added it themselves (`own`: *Remove*; otherwise a suggestion: *Turn off*), and
 * why its headlines couldn't be read the last time, in a few words.
 */
export const NewsChosenSource = NewsSource.extend({
  own: z.boolean(),
  problem: z.string().min(1).max(120).optional(),
});
export type NewsChosenSource = z.infer<typeof NewsChosenSource>;

/**
 * `news.sources`: the place the suggestions are for (null: none, so no suggestions), the sites that are on, and the
 * suggestions for the place that aren't on, the nearest first (`newsSuggestionsFor`).
 */
export const NewsSourcesView = z.object({
  place: Place.nullable(),
  chosen: z.array(NewsChosenSource).max(NEWS_SOURCES_MAX),
  suggestions: z.array(NewsSuggestion).max(NEWS_SUGGESTIONS.length),
});
export type NewsSourcesView = z.infer<typeof NewsSourcesView>;

/**
 * `news.setSources`: the sites to have on, in order, by id: a suggestion's (any country's) or one the person added that
 * is on now. A site left out is turned off (an added one is forgotten).
 */
export const NewsSetSourcesBody = z.strictObject({
  ids: z
    .array(NewsSourceId)
    .max(NEWS_SOURCES_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'Each site once.'),
});
export type NewsSetSourcesBody = z.input<typeof NewsSetSourcesBody>;

/**
 * `news.addSite`: a news site's address as the person typed it (`omroepbrabant.nl`, a page or its feed). Whombat reads
 * it once: a feed is added as it is, a page by the feed it names (`<link rel="alternate">`); anything else is refused.
 */
export const NewsAddSiteBody = z.strictObject({
  url: z
    .string()
    .trim()
    .min(4)
    .max(NEWS_URL_MAX)
    .refine((u) => newsSiteAddress(u) !== null, 'Use the site’s https address.'),
});
export type NewsAddSiteBody = z.input<typeof NewsAddSiteBody>;

/** `news.addSite`'s answer: the site added and the sources as they are now. */
export const NewsAddSiteResult = z.object({ added: NewsChosenSource, news: NewsSourcesView });
export type NewsAddSiteResult = z.infer<typeof NewsAddSiteResult>;

/** A headline as Whombat read it: its site, its words, when it was published and its link. */
export const NewsHeadline = z.object({
  sourceId: NewsSourceId,
  source: z.string().min(1).max(80),
  title: z.string().min(1).max(300),
  at: Timestamp,
  link: z.string().url().max(NEWS_URL_MAX),
});
export type NewsHeadline = z.infer<typeof NewsHeadline>;

/**
 * A site's address as Whombat reads it, or null when it can't be one: spaces trimmed, `https://` put in front of a bare
 * name (`omroepbrabant.nl`), the part after `#` left off. Only https (the box reaches the internet on 443 only), a host
 * name with a dot, no user name or password.
 */
export function newsSiteAddress(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > NEWS_URL_MAX || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) return null;
  url.hash = '';
  return url.href.length <= NEWS_URL_MAX ? url.href : null;
}

/** The id of a site the person added: `own-` and a short hash of its feed's address, the same for the same feed. */
export function ownNewsSourceId(url: string): NewsSourceId {
  // FNV-1a, twice with different starts: 64 bits keep twelve feeds apart.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0;
  }
  return `${NEWS_OWN_PREFIX}${a.toString(36)}${b.toString(36)}`;
}

/** Whether a site's id is one the person added. */
export function isOwnNewsSource(id: string): boolean {
  return id.startsWith(NEWS_OWN_PREFIX);
}

/** A suggestion by its id, any country's. */
export function newsSuggestion(id: string): NewsSuggestionRow | undefined {
  return NEWS_SUGGESTIONS.find((s) => s.id === id);
}

/** How near a suggestion is to a place, or null when it isn't for that place. */
export function newsNear(
  row: NewsSuggestionRow,
  place: { country: string; region?: string | undefined; area?: string | undefined },
): NewsNear | null {
  if (row.country !== place.country) return null;
  if (row.areas) return place.area && row.areas.includes(place.area) ? 'area' : null;
  if (row.regions) return place.region && row.regions.includes(place.region) ? 'region' : null;
  return 'country';
}

const NEAR_ORDER: Readonly<Record<NewsNear, number>> = { area: 0, region: 1, country: 2 };

/**
 * The suggestions for a place, the nearest first (its area's, its region's, its country's), each in the table's order.
 * None without a place.
 */
export function newsSuggestionsFor(
  place: { country: string; region?: string | undefined; area?: string | undefined } | null,
  rows: readonly NewsSuggestionRow[] = NEWS_SUGGESTIONS,
): NewsSuggestion[] {
  if (!place) return [];
  const found: NewsSuggestion[] = [];
  for (const row of rows) {
    const near = newsNear(row, place);
    if (near) found.push({ id: row.id, name: row.name, url: row.url, lang: row.lang, near });
  }
  return found.sort((x, y) => NEAR_ORDER[x.near] - NEAR_ORDER[y.near]);
}

/** The words Settings → This Whombat shows about the news (web and phone alike). */
export const NEWS_WORDS = {
  title: 'News',
  about:
    'Headlines come straight from these sites to this Whombat. Nothing is read until you turn a site on.',
  chosen: 'Your news',
  none: 'No news sites on yet.',
  suggested: 'Suggested for {where}',
  turnOn: 'Turn on',
  turnOff: 'Turn off',
  remove: 'Remove',
  add: 'Add a news site',
  addField: 'The site’s address, or its feed',
  addButton: 'Add',
  added: '{name} is on.',
  full: 'Up to {n} news sites. Turn one off first.',
  notHttps: 'Use the site’s https address.',
  notFeed: 'That page doesn’t name a news feed Whombat can read.',
  unreachable: 'Couldn’t reach that site just now. Try again in a moment.',
  problem: 'Couldn’t read it just now',
  /** The `news` widget with no site on, and with none read. */
  widgetEmpty: 'Choose your news in Settings',
  widgetProblem: 'Can’t read the news just now',
} as const;
