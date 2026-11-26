/**
 * Where this Whombat is and the news it reads, as Settings → This Whombat shows them on the web and the phone (Whombat
 * weather-news.md; app weather-news-apps.md): the Place row's words, a search result's second line, the news part's
 * “Suggested for …”, the ids a *Turn on* or *Turn off* sends, and the field's own problem from a refused write. Pure.
 */
import {
  NEWS_SOURCES_MAX,
  NEWS_WORDS,
  type NewsSourcesView,
  PLACE_SETTING_WORDS,
  type Place,
  placeLabel,
} from '@whombat/core';
import { ApiError, InvalidRequestError } from './http/errors';

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/** The Place row's line: “Amsterdam · guessed from the time zone”, “Eindhoven, Noord-Brabant”, or “Not set”. */
export function placeRowText(place: Place | null | undefined): string {
  if (!place) return PLACE_SETTING_WORDS.none;
  return place.guessed ? fill(PLACE_SETTING_WORDS.guessed, { place: placeLabel(place) }) : placeLabel(place);
}

/** What saving a place says: “Saved. The weather and news are for Eindhoven now.” */
export function placeSavedText(place: Place | null | undefined): string {
  return fill(PLACE_SETTING_WORDS.saved, { place: place ? place.name : PLACE_SETTING_WORDS.none });
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

let regionNames: { of(code: string): string | undefined } | null | undefined;

/** A country's English name (“Netherlands”), its code where the device can't name it. */
export function countryName(code: string, opts: { the?: boolean } = {}): string {
  if (regionNames === undefined) {
    try {
      const Names = (Intl as unknown as { DisplayNames?: new (l: string[], o: object) => typeof regionNames })
        .DisplayNames;
      regionNames = Names ? new Names(['en'], { type: 'region' }) : null;
    } catch {
      regionNames = null;
    }
  }
  let name = code;
  try {
    name = regionNames?.of(code) ?? code;
  } catch {
    // An unknown code stays a code.
  }
  return opts.the && WITH_THE.has(code) && name !== code ? `the ${name}` : name;
}

/** A found place's second line: its country (“Netherlands”). */
export function placeResultMeta(place: Pick<Place, 'country'>): string {
  return countryName(place.country);
}

/** “Suggested for Noord-Brabant” where the region is known, else “Suggested for the Netherlands”; null without a place. */
export function newsSuggestedTitle(place: Place | null | undefined): string | null {
  if (!place) return null;
  return fill(NEWS_WORDS.suggested, { where: place.regionName ?? countryName(place.country, { the: true }) });
}

/** Whether another site can be turned on. */
export function newsHasRoom(view: Pick<NewsSourcesView, 'chosen'>): boolean {
  return view.chosen.length < NEWS_SOURCES_MAX;
}

/** “Up to 12 news sites. Turn one off first.” */
export function newsFullText(): string {
  return fill(NEWS_WORDS.full, { n: NEWS_SOURCES_MAX });
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
export function newsAddedText(name: string): string {
  return fill(NEWS_WORDS.added, { name });
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
