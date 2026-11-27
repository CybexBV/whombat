/**
 * Settings → News and weather on the phone, what its rows say (Whombat weather-news.md; app weather-news-apps.md): how
 * many sources are on of how many (“5 of 30”; 12 on a Whombat before browsing), each source's mark and line (“Netherlands ·
 * national”, “YouTube · added by you”), the ids that move one up or down, Find more's topic chips (only those with
 * sites) and what each keeps, a suggested site's line, and what an import says. Pure.
 */
import { countryName } from '@whombat/client';
import {
  NEWS_SOURCES_MAX,
  NEWS_SOURCES_MAX_BEFORE_MORE,
  type NewsBrowseSite,
  type NewsChosenSource,
  type NewsImportResult,
  type NewsTopic,
  newsKindWords,
  newsSourceKind,
  newsSuggestion,
  newsTopicWords,
  newsWords,
  type Place,
} from '@whombat/core';

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/** The most sources this Whombat reads: 30, or 12 on one before browsing and importing. */
export function newsMax(more: boolean): number {
  return more ? NEWS_SOURCES_MAX : NEWS_SOURCES_MAX_BEFORE_MORE;
}

/** “5 of 30”, beside YOUR SOURCES. */
export function newsCountText(on: number, max: number, locale?: string | null): string {
  return fill(newsWords(locale).count, { n: on, max });
}

/** “Up to 30 sources. Turn one off first.” */
export function newsFullTextFor(max: number, locale?: string | null): string {
  return fill(newsWords(locale).full, { n: max });
}

/**
 * A source's mark: an abbreviation its name starts with (“NOS”, “RTL”, “NU” of NU.nl), else the first letters of its
 * first two words (“OB” of Omroep Brabant, “T” of Tweakers). At most three letters, never empty.
 */
export function sourceInitials(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter(Boolean);
  const first = words[0] ?? '';
  if (first.length >= 2 && first.length <= 4 && first === first.toUpperCase() && /\p{L}/u.test(first))
    return Array.from(first).slice(0, 3).join('');
  const letters = words
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? '')
    .join('')
    .toUpperCase();
  return letters || '•';
}

const lower = (word: string) => word.charAt(0).toLowerCase() + word.slice(1);

/**
 * The line under a source that is on: what it is and that the person added it (“YouTube · added by you”), else whom a
 * suggestion is for — the country and “national”, its region and “regional” (the place's region's name where it is
 * the place's), or the country and its topic (“Netherlands · Tech”). The feed's host where the suggestion isn't known.
 */
export function chosenSourceLine(
  source: Pick<NewsChosenSource, 'id' | 'url' | 'kind' | 'own'>,
  place: Pick<Place, 'country' | 'region' | 'regionName'> | null,
  locale?: string | null,
): string {
  const NEWS_WORDS = newsWords(locale);
  const NEWS_TOPIC_WORDS = newsTopicWords(locale);
  if (source.own) return `${newsKindWords(locale)[newsSourceKind(source)]} · ${NEWS_WORDS.addedByYou}`;
  const row = newsSuggestion(source.id);
  if (!row) return hostOf(source.url);
  const country = countryName(row.country, {}, locale);
  if (row.topic && row.topic !== 'news') return `${country} · ${NEWS_TOPIC_WORDS[row.topic]}`;
  if (!row.regions && !row.areas) return `${country} · ${lower(NEWS_WORDS.national)}`;
  const ours = place?.country === row.country && !!place.region && !!row.regions?.includes(place.region);
  const where = row.where ?? (ours ? place?.regionName : undefined) ?? country;
  return `${where} · ${lower(NEWS_WORDS.regional)}`;
}

/** A feed's host without `www.`: “feeds.nos.nl”. */
export function hostOf(url: string): string {
  return /^https:\/\/([^/?#]+)/.exec(url)?.[1]?.replace(/^www\./, '') ?? url;
}

/** The ids `news.setSources` takes to move one source `by` places (−1 up, 1 down); the same order at either end. */
export function newsIdsMoved(
  chosen: readonly Pick<NewsChosenSource, 'id'>[],
  id: string,
  by: number,
): string[] {
  const ids = chosen.map((s) => s.id);
  const from = ids.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  return ids;
}

/** Find more's chips: every site, the place's region's, the whole country's, and each subject. */
export type NewsChip = 'all' | 'near' | 'national' | Exclude<NewsTopic, 'news'>;

const CHIP_ORDER: readonly NewsChip[] = [
  'all',
  'near',
  'national',
  'tech',
  'sport',
  'business',
  'science',
  'culture',
];

/** Whether a site belongs under a chip. */
export function newsChipHas(chip: NewsChip, site: Pick<NewsBrowseSite, 'near' | 'scope' | 'topic'>): boolean {
  switch (chip) {
    case 'all':
      return true;
    case 'near':
      // The place's own region or area: the country's sites are “National”.
      return site.near === 'region' || site.near === 'area';
    case 'national':
      return site.scope === 'country' && site.topic === 'news';
    default:
      return site.topic === chip;
  }
}

/** The chips that have sites, in the web's order: All · Near you · National · Tech · Sport · Business · Science · Culture. */
export function newsChips(sites: readonly Pick<NewsBrowseSite, 'near' | 'scope' | 'topic'>[]): NewsChip[] {
  if (sites.length === 0) return [];
  return CHIP_ORDER.filter((chip) => sites.some((s) => newsChipHas(chip, s)));
}

/** A chip's word. */
export function newsChipLabel(chip: NewsChip, locale?: string | null): string {
  const NEWS_WORDS = newsWords(locale);
  if (chip === 'all') return NEWS_WORDS.allTopics;
  if (chip === 'near') return NEWS_WORDS.nearYou;
  if (chip === 'national') return NEWS_WORDS.national;
  return newsTopicWords(locale)[chip];
}

/** A suggested site's line in Find more: “National”, “Tech”, “Noord-Brabant · regional”, “Regional”. */
export function browseSiteLine(
  site: Pick<NewsBrowseSite, 'scope' | 'topic' | 'where'>,
  locale?: string | null,
): string {
  const NEWS_WORDS = newsWords(locale);
  const what =
    site.topic !== 'news'
      ? newsTopicWords(locale)[site.topic]
      : site.scope === 'country'
        ? NEWS_WORDS.national
        : NEWS_WORDS.regional;
  if (site.scope === 'country' || !site.where) return what;
  return `${site.where} · ${site.topic === 'news' ? lower(what) : what}`;
}

/** What an import says: “2 sources added. 1 couldn’t be added.”, “1 couldn’t be added.”, “0 sources added.” */
export function newsImportText(
  result: Pick<NewsImportResult, 'added' | 'skipped'>,
  locale?: string | null,
): string {
  const NEWS_WORDS = newsWords(locale);
  const added =
    result.added.length === 1
      ? NEWS_WORDS.importedOne
      : result.added.length > 1
        ? fill(NEWS_WORDS.importedMany, { n: result.added.length })
        : null;
  const skipped = result.skipped.length ? fill(NEWS_WORDS.importSkipped, { n: result.skipped.length }) : null;
  const said = [added, skipped].filter(Boolean).join(' ');
  return said || fill(NEWS_WORDS.importedMany, { n: 0 });
}
