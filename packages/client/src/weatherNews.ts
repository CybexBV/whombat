/**
 * Where this Whombat is and the news it reads, as Settings → This Whombat shows them on the web and the phone (Whombat
 * weather-news.md; app weather-news-apps.md): the Place row's words, a search result's second line, the news part's
 * “Suggested for …”, the ids a *Turn on* or *Turn off* sends, and the field's own problem from a refused write. Pure.
 */
import { NEWS_SOURCES_MAX, type NewsSourcesView, type Place, placeLabel } from '@whombat/core';
import { formatLocaleOf, resolveLanguage } from '@whombat/core/i18n';
import { ApiError, InvalidRequestError } from './http/errors';
import { clientTranslator } from './i18n/catalog';

/** The Place row's line: “Amsterdam · guessed from the time zone”, “Eindhoven, Noord-Brabant”, or “Not set”. */
export function placeRowText(place: Place | null | undefined, locale?: string | null): string {
  const tr = clientTranslator(locale);
  if (!place) return tr.t('place.none');
  return place.guessed ? tr.t('place.guessed', { place: placeLabel(place) }) : placeLabel(place);
}

/** What saving a place says: “Saved. The weather and news are for Eindhoven now.” */
export function placeSavedText(place: Place | null | undefined, locale?: string | null): string {
  const tr = clientTranslator(locale);
  return tr.t('place.saved', { place: place ? place.name : tr.t('place.none') });
}

/** Countries English names with “the”: “the Netherlands”. */
const WITH_THE = new Set([
  'NL',
  'US',
  'GB',
  'PH',
  'AE',
  'DO',
  'BS',
  'GM',
  'CD',
  'CF',
  'KM',
  'MV',
  'MH',
  'SB',
]);

/** Countries Dutch names with an article ("de Verenigde Staten", "het Verenigd Koninkrijk"). Note: Nederland has none. */
const DUTCH_ARTICLE: Readonly<Record<string, 'de' | 'het'>> = {
  US: 'de',
  GB: 'het',
  PH: 'de',
  AE: 'de',
  DO: 'de',
  BS: 'de',
  CF: 'de',
  KM: 'de',
  MV: 'de',
  MH: 'de',
  SB: 'de',
};

const regionNamesCache = new Map<string, { of(code: string): string | undefined } | null>();

function getRegionDisplayNames(locale: string): { of(code: string): string | undefined } | null {
  if (regionNamesCache.has(locale)) return regionNamesCache.get(locale) ?? null;
  try {
    const Names = (
      Intl as unknown as {
        DisplayNames?: new (l: string[], o: object) => { of(code: string): string | undefined };
      }
    ).DisplayNames;
    const inst = Names ? new Names([locale], { type: 'region' }) : null;
    regionNamesCache.set(locale, inst);
    return inst;
  } catch {
    regionNamesCache.set(locale, null);
    return null;
  }
}

/** A country's localized name (“Netherlands” / “Nederland”), its code where the device can't name it. */
export function countryName(code: string, opts: { the?: boolean } = {}, locale?: string | null): string {
  const lang = resolveLanguage(locale);
  const fmtLocale = locale ? formatLocaleOf(locale) : 'en';
  const regionNames = getRegionDisplayNames(fmtLocale);
  let name = code;
  try {
    name = regionNames?.of(code) ?? code;
  } catch {
    // An unknown code stays a code.
  }
  if (!opts.the || name === code) return name;
  if (lang === 'nl') {
    const art = DUTCH_ARTICLE[code];
    return art ? `${art} ${name}` : name;
  }
  return WITH_THE.has(code) ? `the ${name}` : name;
}

/** A found place's second line: its country (“Netherlands” / “Nederland”). */
export function placeResultMeta(place: Pick<Place, 'country'>, locale?: string | null): string {
  return countryName(place.country, {}, locale);
}

/** “Suggested for Noord-Brabant” where the region is known, else “Suggested for the Netherlands”; null without a place. */
export function newsSuggestedTitle(place: Place | null | undefined, locale?: string | null): string | null {
  if (!place) return null;
  return clientTranslator(locale).t('news.suggested', {
    where: place.regionName ?? countryName(place.country, { the: true }, locale),
  });
}

/** Whether another site can be turned on. */
export function newsHasRoom(view: Pick<NewsSourcesView, 'chosen'>): boolean {
  return view.chosen.length < NEWS_SOURCES_MAX;
}

/** “Up to 12 news sites. Turn one off first.” */
export function newsFullText(locale?: string | null): string {
  return clientTranslator(locale).t('news.full', { n: NEWS_SOURCES_MAX });
}

/** The ids `news.setSources` takes to turn one more on, at the end. */
export function newsIdsWith(view: Pick<NewsSourcesView, 'chosen'>, id: string): string[] {
  return [...view.chosen.map((s) => s.id).filter((x) => x !== id), id];
}

/** The ids `news.setSources` takes to turn one off (an added one is forgotten). */
export function newsIdsWithout(view: Pick<NewsSourcesView, 'chosen'>, id: string): string[] {
  return view.chosen.map((s) => s.id).filter((x) => x !== id);
}

/** “Omroep Brabant is on.” */
export function newsAddedText(name: string, locale?: string | null): string {
  return clientTranslator(locale).t('news.added', { name });
}

/**
 * A refused write's words for one field (`url` for *Add a news site*): the server's own (“That page doesn’t name a news
 * feed Whombat can read.”), or what the contract says before sending; null when the refusal is about something else.
 */
export function fieldProblem(error: unknown, field: string): string | null {
  if (error instanceof InvalidRequestError || error instanceof ApiError)
    return error.fields[field]?.[0] ?? null;
  return null;
}
