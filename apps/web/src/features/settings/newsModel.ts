/**
 * Settings → News and weather's own logic, pure so it is unit-tested (app weather-news-apps.md): how many sources this
 * Whombat takes, a source's mark and the line under its name, Find more's topic chips, moving a source up or down, and
 * what an OPML file sends and what the import says.
 */
import { countryName } from '@whombat/client';
import {
  NEWS_SOURCES_MAX,
  NEWS_SOURCES_MAX_BEFORE_MORE,
  NEWS_WORDS,
  type NewsBrowseSite,
  type NewsBrowseView,
  type NewsChosenSource,
  type NewsSuggestion,
  type NewsTopic,
  newsKindWords,
  newsOpmlUrls,
  newsSourceKind,
  newsSuggestion,
  newsTopicWords,
  type Place,
} from '@whombat/core';
import { currentLocale } from '../../i18n/provider';

const N = NEWS_WORDS;

export const fillNews = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/** The most sources this Whombat reads: 30, or 12 on a Whombat from before browsing and importing. */
export function newsMax(more: boolean): number {
  return more ? NEWS_SOURCES_MAX : NEWS_SOURCES_MAX_BEFORE_MORE;
}

/** Beside YOUR SOURCES: “5 of 30”. */
export function newsCountText(n: number, max: number): string {
  return fillNews(N.count, { n, max });
}

/** When there's no room: “Up to 30 sources. Turn one off first.” */
export function newsFullFor(max: number): string {
  return fillNews(N.full, { n: max });
}

/**
 * A source's mark: its short name where it starts with one (“NOS Nieuws” → NOS, “NU.nl” → NU), else the first letters
 * of its first two names (“Omroep Brabant” → OB) or of its one (“Tweakers” → T, “r/selfhosted” → S), drawn on one of the
 * five avatar tones chosen by its id, so it keeps its colour. No site's own icon: fetching one would tell the site who
 * looks.
 */
export function sourceInitials(name: string): string {
  const words = name
    .replace(/^(r\/|@)/i, '')
    .split(/[\s.]+/)
    .map((w) => [...w].filter((c) => /[\p{L}\p{N}]/u.test(c)).join(''))
    .filter((w) => w.length > 0);
  const [first, second] = words;
  if (!first) return '?';
  if (first.length >= 2 && first.length <= 3 && first === first.toLocaleUpperCase() && /\p{L}/u.test(first))
    return first;
  const capital = second && second[0] === second[0]?.toLocaleUpperCase() && /\p{L}/u.test(second[0] ?? '');
  return `${[...first][0]}${capital ? [...second][0] : ''}`.toLocaleUpperCase();
}

export function sourceTone(id: string): 1 | 2 | 3 | 4 | 5 {
  let sum = 0;
  for (const ch of id) sum = (sum * 31 + (ch.codePointAt(0) ?? 0)) % 9973;
  return ((sum % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

/** A site's address without its scheme: “feeds.nos.nl”. */
export function newsHost(url: string): string {
  return /^https:\/\/([^/?#]+)/.exec(url)?.[1]?.replace(/^www\./, '') ?? url;
}

/**
 * What *Find it again* puts in Add your own: a site's front page (its feed host without `feeds.` or `rss.`), where
 * Whombat finds the feed it names now; any other source's own address, which is how it is added.
 */
export function findAgainAddress(source: Pick<NewsChosenSource, 'url' | 'kind'>): string {
  if (newsSourceKind(source) !== 'site') return source.url;
  const host = /^https:\/\/([^/?#]+)/.exec(source.url)?.[1];
  return host ? `https://${host.replace(/^(feeds?|rss)\./, '')}` : source.url;
}

let languageNames: { of(code: string): string | undefined } | null | undefined;

/** A language's English name (“Dutch”), its code where the device can't name it. */
export function languageName(code: string): string {
  if (languageNames === undefined) {
    try {
      const Names = (
        Intl as unknown as { DisplayNames?: new (l: string[], o: object) => typeof languageNames }
      ).DisplayNames;
      languageNames = Names ? new Names(['en'], { type: 'language' }) : null;
    } catch {
      languageNames = null;
    }
  }
  try {
    return languageNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

type Scope = NewsBrowseSite['scope'];

/** Where a suggestion is for: the whole country (“Netherlands · national”) or a part of it (“Noord-Brabant · regional”). */
function scopeLine(input: {
  country: string;
  scope: Scope;
  where?: string | undefined;
  /** Whether it is for the place's own region or area: then the region's name stands for where it is. */
  ours: boolean;
  place: Place | null;
}): string {
  if (input.scope === 'country')
    return `${countryName(input.country, undefined, currentLocale())} · ${N.national.toLowerCase()}`;
  const where =
    input.where ??
    (input.ours && input.place?.regionName
      ? input.place.regionName
      : countryName(input.country, undefined, currentLocale()));
  return `${where} · ${N.regional.toLowerCase()}`;
}

/**
 * The line under a source in YOUR SOURCES: one the person added says what it is (“YouTube · added by you”); a suggestion
 * says whom it is for, from the box's browse list where it has it, else from the app's own table, else its address.
 */
export function chosenLine(
  source: NewsChosenSource,
  ctx: { place: Place | null; browse?: NewsBrowseView | undefined },
): string {
  const NEWS_KIND_WORDS = newsKindWords(currentLocale());
  if (source.own) return `${NEWS_KIND_WORDS[newsSourceKind(source)]} · ${N.addedByYou}`;
  const site = ctx.browse?.country ? ctx.browse.sites.find((s) => s.id === source.id) : undefined;
  if (site && ctx.browse?.country)
    return scopeLine({
      country: ctx.browse.country,
      scope: site.scope,
      where: site.where,
      ours: site.near === 'region' || site.near === 'area',
      place: ctx.place,
    });
  const row = newsSuggestion(source.id);
  if (row) {
    const ours =
      !!ctx.place &&
      row.country === ctx.place.country &&
      (row.regions?.includes(ctx.place.region ?? '') || row.areas?.includes(ctx.place.area ?? '') || false);
    return scopeLine({
      country: row.country,
      scope: row.areas ? 'area' : row.regions ? 'region' : 'country',
      where: row.where,
      ours,
      place: ctx.place,
    });
  }
  return newsHost(source.url);
}

/** A topic other than all the news, by its name (“Tech”); nothing for the news itself. */
const topicWord = (topic: NewsTopic | undefined) =>
  topic && topic !== 'news' ? newsTopicWords(currentLocale())[topic] : null;

/** A site in Find more: whom it is for, its topic and its language (“National · Dutch”, “Noord-Brabant · Dutch”). */
export function browseLine(site: NewsBrowseSite, place: Place | null): string {
  const near = site.near === 'region' || site.near === 'area';
  const scope =
    site.scope === 'country'
      ? N.national
      : (site.where ?? (near && place?.regionName ? place.regionName : N.regional));
  return [scope, topicWord(site.topic), languageName(site.lang)].filter(Boolean).join(' · ');
}

/** A suggestion as a Whombat from before browsing gives it: national, or the place's region. */
export function suggestionLine(s: NewsSuggestion, place: Place | null): string {
  const scope = s.near === 'country' ? N.national : (place?.regionName ?? N.regional);
  return [scope, topicWord(s.topic), languageName(s.lang)].filter(Boolean).join(' · ');
}

/** Find more's chips: every site, the place's own region's, the whole country's news, and each topic. */
export const NEWS_CHIPS = [
  'all',
  'near',
  'national',
  'tech',
  'sport',
  'business',
  'science',
  'culture',
] as const;
export type NewsChip = (typeof NEWS_CHIPS)[number];

export function chipWords(chip: NewsChip): string {
  const NEWS_TOPIC_WORDS = newsTopicWords(currentLocale());
  if (chip === 'all') return N.allTopics;
  if (chip === 'near') return N.nearYou;
  if (chip === 'national') return N.national;
  return NEWS_TOPIC_WORDS[chip];
}

/** Whether a site shows under a chip. */
export function chipHas(site: NewsBrowseSite, chip: NewsChip): boolean {
  switch (chip) {
    case 'all':
      return true;
    case 'near':
      return site.near === 'region' || site.near === 'area';
    case 'national':
      return site.scope === 'country' && site.topic === 'news';
    default:
      return site.topic === chip;
  }
}

/** The chips that have sites, in their order; none when the country has no sites. */
export function newsChips(sites: readonly NewsBrowseSite[]): NewsChip[] {
  if (sites.length === 0) return [];
  return NEWS_CHIPS.filter((chip) => sites.some((s) => chipHas(s, chip)));
}

/** The ids with one moved up (-1) or down (+1); the same at either end. */
export function moveSource(ids: readonly string[], id: string, by: -1 | 1): string[] {
  const at = ids.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  next.splice(at, 1);
  next.splice(to, 0, id);
  return next;
}

/** The ids with one put at a place among the others (0: first), as a drag lets it go. */
export function placeSource(ids: readonly string[], id: string, to: number): string[] {
  const rest = ids.filter((x) => x !== id);
  if (rest.length === ids.length) return [...ids];
  const at = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * What an OPML file sends: its feeds, at most as many as there is room for (`left` is how many didn't fit), or `none`
 * when it names no feed Whombat could read.
 */
export function opmlPlan(text: string, room: number): { urls: string[]; left: number; none: boolean } {
  const all = newsOpmlUrls(text);
  const urls = all.slice(0, Math.max(0, room));
  return { urls, left: all.length - urls.length, none: all.length === 0 };
}

/** What an import says: “3 sources added.” and “2 couldn’t be added.” (those that didn't fit count there too). */
export function importWords(added: number, skipped: number): string[] {
  const words: string[] = [];
  if (added === 1) words.push(N.importedOne);
  else if (added > 1 || skipped === 0) words.push(fillNews(N.importedMany, { n: added }));
  if (skipped > 0) words.push(fillNews(N.importSkipped, { n: skipped }));
  return words;
}

/** The file “Save as OPML” gives: the sources' names and feeds, for another reader. */
export const NEWS_OPML_FILE = 'whombat-news.opml';
