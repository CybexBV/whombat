/**
 * Local news, headlines only (Whombat docs/decisions/weather-news.md): this Whombat reads the news sites the person turned
 * on, the way a feed reader does, and shows their headlines (the headline, the site, the time and a link; no pictures,
 * no article text). Whombat suggests sites for the place's country and region (`NEWS_SUGGESTIONS`), lets the person
 * browse every country's by topic (`news.browse`), and reads nothing until the person turns one on, adds a source of
 * their own (a site, a feed, a YouTube channel, a subreddit, a podcast…) or imports a list from another reader
 * (`news.importSites`, an OPML file read on the device). Up to `NEWS_SOURCES_MAX` per burrow (`news.sources`,
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

/** The most news sources a Whombat reads. */
export const NEWS_SOURCES_MAX = 30;
/**
 * The most an app before `NEWS_MORE_MINOR` takes in `news.sources` (its contract's limit): a box shows such an app the
 * first twelve, and keeps the rest after them when that app saves the list.
 */
export const NEWS_SOURCES_MAX_BEFORE_MORE = 12;
/** The most sites `news.browse` lists for one country. */
export const NEWS_BROWSE_MAX = 400;
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

/**
 * What a source is, for the words beside it (“YouTube · added by you”): a news site or blog (`site`), a YouTube
 * channel, a subreddit, a Mastodon or Bluesky account, a podcast, or a GitHub project's releases. Each is read as the
 * feed it has; the kind changes nothing else.
 */
export const NEWS_SOURCE_KINDS = [
  'site',
  'youtube',
  'reddit',
  'mastodon',
  'bluesky',
  'podcast',
  'github',
] as const;
export const NewsSourceKind = z.enum(NEWS_SOURCE_KINDS);
export type NewsSourceKind = z.infer<typeof NewsSourceKind>;

/** What a suggested site is about: all the news, or one subject. */
export const NEWS_TOPICS = ['news', 'tech', 'business', 'sport', 'science', 'culture'] as const;
export const NewsTopic = z.enum(NEWS_TOPICS);
export type NewsTopic = z.infer<typeof NewsTopic>;

/**
 * A news source Whombat reads: its id, its name (“Omroep Brabant”), its feed's address, and what it is where that is
 * known (`kind`; without it, `newsSourceKind` reads it from the address).
 */
export const NewsSource = z.object({
  id: NewsSourceId,
  name: z.string().trim().min(1).max(80),
  url: NewsFeedUrl,
  kind: NewsSourceKind.optional(),
});
export type NewsSource = z.infer<typeof NewsSource>;

/** What a burrow keeps (`burrows.news`): the sites turned on, in the person's order. */
export const NewsSettings = z.object({ sources: z.array(NewsSource).max(NEWS_SOURCES_MAX) });
export type NewsSettings = z.infer<typeof NewsSettings>;

/** How near a suggestion is: the place's area (a Belgian province), its region (a province or state), its country. */
export const NEWS_NEAR = ['area', 'region', 'country'] as const;
export const NewsNear = z.enum(NEWS_NEAR);
export type NewsNear = z.infer<typeof NewsNear>;

/** A site Whombat suggests for the place: its language (ISO 639-1, `nl`), how near it is and its topic. */
export const NewsSuggestion = NewsSource.extend({
  lang: z.string().regex(/^[a-z]{2,3}$/),
  near: NewsNear,
  topic: NewsTopic.optional(),
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

/** A country by its ISO 3166-1 code (`NL`). */
export const NewsCountryCode = z.string().regex(/^[A-Z]{2}$/);

/** `news.browse`'s query: the country to list; without it, the place's. */
export const NewsBrowseQuery = z.object({ country: NewsCountryCode.optional() });
export type NewsBrowseQuery = z.infer<typeof NewsBrowseQuery>;

/** A country Whombat suggests sites for, and how many. */
export const NewsCountry = z.object({ code: NewsCountryCode, sites: z.number().int().min(1) });
export type NewsCountry = z.infer<typeof NewsCountry>;

/**
 * A suggested site as browsing shows it: its language and topic, whom it is for (`scope`: the whole country, or a region
 * or area of it, `where` naming it when the table does), how near it is to this Whombat's place (null when it isn't
 * for it), and whether it is on.
 */
export const NewsBrowseSite = NewsSource.extend({
  lang: z.string().regex(/^[a-z]{2,3}$/),
  topic: NewsTopic,
  scope: NewsNear,
  where: z.string().min(1).max(120).optional(),
  near: NewsNear.nullable(),
  on: z.boolean(),
});
export type NewsBrowseSite = z.infer<typeof NewsBrowseSite>;

/**
 * `news.browse`: the country shown (the one asked, else the place's; null with neither), every country with
 * suggestions, the most sites first, and that country's sites: the nearest to the place first, then the whole
 * country's, then the regions', each in the table's order.
 */
export const NewsBrowseView = z.object({
  country: NewsCountryCode.nullable(),
  countries: z.array(NewsCountry).max(300),
  sites: z.array(NewsBrowseSite).max(NEWS_BROWSE_MAX),
});
export type NewsBrowseView = z.infer<typeof NewsBrowseView>;

/**
 * `news.importSites`: feed addresses from another reader's list (an OPML file the device read, `newsOpmlUrls`), up to
 * `NEWS_SOURCES_MAX`. Each is checked as `news.addSite` checks one; those that can't be added are skipped, with why.
 */
export const NewsImportBody = z.strictObject({
  urls: z.array(z.string().trim().min(4).max(NEWS_URL_MAX)).min(1).max(NEWS_SOURCES_MAX),
});
export type NewsImportBody = z.input<typeof NewsImportBody>;

/** An address `news.importSites` couldn't add, and why in a few words (`NEWS_WORDS`' refusals). */
export const NewsImportSkipped = z.object({
  url: z.string().max(NEWS_URL_MAX),
  problem: z.string().min(1).max(120),
});
export type NewsImportSkipped = z.infer<typeof NewsImportSkipped>;

/** `news.importSites`' answer: what was added, what was skipped, and the sources as they are now. */
export const NewsImportResult = z.object({
  added: z.array(NewsChosenSource).max(NEWS_SOURCES_MAX),
  skipped: z.array(NewsImportSkipped).max(NEWS_SOURCES_MAX),
  news: NewsSourcesView,
});
export type NewsImportResult = z.infer<typeof NewsImportResult>;

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
    if (near)
      found.push({
        id: row.id,
        name: row.name,
        url: row.url,
        lang: row.lang,
        near,
        ...(row.topic && { topic: row.topic }),
      });
  }
  return found.sort((x, y) => NEAR_ORDER[x.near] - NEAR_ORDER[y.near]);
}

/** Whom a suggestion is for: an area, a region, or the whole country. */
function newsScope(row: NewsSuggestionRow): NewsNear {
  return row.areas ? 'area' : row.regions ? 'region' : 'country';
}

/**
 * `news.browse` from the table: the country asked (else the place's), every country with how many sites, and that
 * country's sites, the nearest to the place first, then the whole country's, then the regions' and areas'.
 */
export function newsBrowse(
  input: {
    country?: string | undefined;
    place: { country: string; region?: string | undefined; area?: string | undefined } | null;
    on: ReadonlySet<string>;
  },
  rows: readonly NewsSuggestionRow[] = NEWS_SUGGESTIONS,
): NewsBrowseView {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.country, (counts.get(row.country) ?? 0) + 1);
  const countries = [...counts]
    .map(([code, sites]) => ({ code, sites }))
    .sort((a, b) => b.sites - a.sites || a.code.localeCompare(b.code));
  const country = input.country ?? input.place?.country ?? null;
  const rank = (s: NewsBrowseSite) => (s.near ? NEAR_ORDER[s.near] : 3 + NEAR_ORDER[s.scope]);
  const sites: NewsBrowseSite[] = rows
    .filter((row) => row.country === country)
    .map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      lang: row.lang,
      topic: row.topic ?? 'news',
      scope: newsScope(row),
      ...(row.where && { where: row.where }),
      near: input.place ? newsNear(row, input.place) : null,
      on: input.on.has(row.id),
    }))
    .map((site, i) => ({ site, i }))
    .sort((a, b) => rank(a.site) - rank(b.site) || a.i - b.i)
    .map(({ site }) => site)
    .slice(0, NEWS_BROWSE_MAX);
  return { country, countries, sites };
}

/** What a source is when it doesn't say (`NewsSource.kind`), read from its feed's address. */
export function newsSourceKind(source: Pick<NewsSource, 'url' | 'kind'>): NewsSourceKind {
  if (source.kind) return source.kind;
  const m = /^https:\/\/([^/?#]+)(\/[^?#]*)?/.exec(source.url);
  const host = (m?.[1] ?? '').toLowerCase().replace(/^www\./, '');
  const path = m?.[2] ?? '';
  if (host === 'youtube.com' && path.startsWith('/feeds/')) return 'youtube';
  if (host.endsWith('reddit.com') && /^\/r\//.test(path)) return 'reddit';
  if (host === 'github.com') return 'github';
  if (host === 'bsky.app') return 'bluesky';
  if (/^\/@[^/]+\.rss$/.test(path)) return 'mastodon';
  return 'site';
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return XML_ENTITIES[name.toLowerCase()] ?? all;
  });
}

/**
 * The feed addresses in another reader's list (OPML: each `<outline xmlUrl="…">`), in its order, each once. An `http`
 * address is asked as `https` (the box reads only https); one that can't be a feed's address is left out.
 */
export function newsOpmlUrls(opml: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const m of opml.matchAll(/<outline\b[^>]*?\bxmlUrl\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = xmlText((m[1] ?? m[2] ?? '').trim()).replace(/^http:\/\//i, 'https://');
    const url = newsSiteAddress(raw);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

const xmlAttr = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The sources as an OPML file another reader takes (“Save as OPML”). */
export function newsOpml(
  sources: readonly Pick<NewsSource, 'name' | 'url'>[],
  title = 'Whombat news',
): string {
  const lines = sources.map(
    (s) =>
      `    <outline type="rss" text="${xmlAttr(s.name)}" title="${xmlAttr(s.name)}" xmlUrl="${xmlAttr(s.url)}"/>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    `  <head><title>${xmlAttr(title)}</title></head>`,
    '  <body>',
    ...lines,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

/** The words Settings → News and weather shows about the news (web and phone alike). */
export const NEWS_WORDS = {
  title: 'News',
  /** Settings' own page for the place and the news, and its line. */
  page: 'News and weather',
  pageLine: 'Where this Whombat is, for the weather, and the sources your headlines come from.',
  /** The home's row for it. */
  homeLine: 'Your place, the weather and your headlines',
  about: 'Headlines come straight from these sources to this Whombat. Nothing is read until you turn one on.',
  chosen: 'Your sources',
  /** How many are on, beside YOUR SOURCES: “5 of 30”. */
  count: '{n} of {max}',
  none: 'No sources on yet.',
  suggested: 'Suggested for {where}',
  findMore: 'Find more',
  tabSuggested: 'Suggested',
  tabOwn: 'Add your own',
  tabImport: 'Import',
  country: 'Country',
  allTopics: 'All',
  nearYou: 'Near you',
  national: 'National',
  regional: 'Regional',
  addedByYou: 'added by you',
  turnOn: 'Turn on',
  turnOff: 'Turn off',
  remove: 'Remove',
  add: 'Add your own',
  addField: 'A website, feed, YouTube channel, subreddit or podcast',
  addButton: 'Add',
  added: '{name} is on.',
  importLine: 'Moving from another news reader? Choose the OPML file it saved.',
  importButton: 'Choose a file',
  importNone: 'That file has no feeds in it.',
  importedOne: 'One source added.',
  importedMany: '{n} sources added.',
  importSkipped: '{n} couldn’t be added.',
  /** Saving the list for another reader. */
  export: 'Save as OPML',
  /** The news tile's gear on a screen, and its tooltip. */
  gear: 'Choose sources',
  full: 'Up to {n} sources. Turn one off first.',
  notHttps: 'Use the site’s https address.',
  notFeed: 'That page doesn’t name a feed Whombat can read.',
  unreachable: 'Couldn’t reach that site just now. Try again in a moment.',
  problem: 'Couldn’t read it just now',
  /** The `news` widget with no site on, and with none read. */
  widgetEmpty: 'Choose your news in Settings',
  widgetProblem: 'Can’t read the news just now',
} as const;

/** A topic's name (“Tech”). */
export const NEWS_TOPIC_WORDS: Readonly<Record<NewsTopic, string>> = {
  news: 'News',
  tech: 'Tech',
  business: 'Business',
  sport: 'Sport',
  science: 'Science',
  culture: 'Culture',
};

/** What a source is, in the line under its name (“YouTube · added by you”). */
export const NEWS_KIND_WORDS: Readonly<Record<NewsSourceKind, string>> = {
  site: 'Website',
  youtube: 'YouTube',
  reddit: 'Reddit',
  mastodon: 'Mastodon',
  bluesky: 'Bluesky',
  podcast: 'Podcast',
  github: 'GitHub',
};
