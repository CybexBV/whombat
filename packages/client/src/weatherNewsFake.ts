/**
 * The place and the news of a fake box (Whombat weather-news.md), for the web's fixture mode and the phone's demo world:
 * `place.find` from a small list of towns (nothing leaves the app), `place.set` (null goes back to the time zone's guess),
 * `news.sources`, `news.setSources` and `news.addSite` as the runtime answers them, refusals included. It starts with
 * the guess for Amsterdam and one site of the person's own on (AT5), so Settings shows a site that is on and one
 * suggested. Pure TypeScript; the host turns its answers into responses and puts `place()` in the burrow it serves.
 */
import {
  isOwnNewsSource,
  NEWS_SOURCES_MAX,
  NEWS_WORDS,
  NewsAddSiteBody,
  type NewsChosenSource,
  NewsSetSourcesBody,
  type NewsSourcesView,
  newsSiteAddress,
  newsSuggestion,
  newsSuggestionsFor,
  ownNewsSourceId,
  type Place,
  PlaceFindQuery,
  PlaceSetBody,
  roundPlace,
} from '@whombat/core';

/** The towns the fake finds: a name, its region and its country (made-up look-ups, real places). */
const TOWNS: readonly Omit<Place, 'guessed'>[] = [
  { name: 'Eindhoven', lat: 51.44, lon: 5.48, country: 'NL', region: 'NL-NB', regionName: 'Noord-Brabant' },
  { name: 'Breda', lat: 51.59, lon: 4.78, country: 'NL', region: 'NL-NB', regionName: 'Noord-Brabant' },
  { name: 'Utrecht', lat: 52.09, lon: 5.12, country: 'NL', region: 'NL-UT', regionName: 'Utrecht' },
  { name: 'Amsterdam', lat: 52.37, lon: 4.9, country: 'NL', region: 'NL-NH', regionName: 'Noord-Holland' },
  { name: 'Rotterdam', lat: 51.92, lon: 4.48, country: 'NL', region: 'NL-ZH', regionName: 'Zuid-Holland' },
  {
    name: 'Eindhout',
    lat: 51.1,
    lon: 5.04,
    country: 'BE',
    region: 'BE-VLG',
    area: 'BE-VAN',
    regionName: 'Antwerpen',
  },
  {
    name: 'Antwerp',
    lat: 51.22,
    lon: 4.4,
    country: 'BE',
    region: 'BE-VLG',
    area: 'BE-VAN',
    regionName: 'Antwerpen',
  },
  { name: 'Berlin', lat: 52.52, lon: 13.4, country: 'DE', region: 'DE-BE', regionName: 'Berlin' },
  { name: 'Munich', lat: 48.14, lon: 11.58, country: 'DE', region: 'DE-BY', regionName: 'Bavaria' },
  { name: 'London', lat: 51.51, lon: -0.13, country: 'GB', region: 'GB-ENG', regionName: 'England' },
];

/** Pages whose feed the fake knows; any other page names none. */
const PAGES: Readonly<Record<string, { name: string; feed: string }>> = {
  'dutchnews.nl': { name: 'DutchNews.nl', feed: 'https://www.dutchnews.nl/feed/' },
  'at5.nl': { name: 'AT5', feed: 'https://www.at5.nl/feeds/nieuws.xml' },
  'parool.nl': { name: 'Het Parool', feed: 'https://www.parool.nl/voorpagina/rss.xml' },
};

const AT5: NewsChosenSource = {
  id: ownNewsSourceId(PAGES['at5.nl']?.feed ?? ''),
  name: 'AT5',
  url: PAGES['at5.nl']?.feed ?? '',
  own: true,
};

export interface FakePlaceNewsOptions {
  /** The time zone's guess the burrow starts with (and goes back to). */
  guess: Place | null;
  /** The person's own place to start with instead of the guess. */
  place?: Place | null;
  /** The sites on at the start (default AT5, one of the person's own). */
  chosen?: NewsChosenSource[];
  /** After every change of the place (the host publishes the burrow). */
  onPlace?: (place: Place | null) => void;
}

export interface FakeAnswer {
  status: number;
  body: unknown;
}

export interface FakePlaceNews {
  /** The burrow's place as it is now. */
  place(): Place | null;
  news(): NewsSourcesView;
  /**
   * An op's answer (`query` for reads, `body` for writes), or null for an op this fake doesn't answer. `place.set`
   * answers `{ place }`: the host puts it in its burrow and answers `{ burrow }`.
   */
  call(op: string, input: { query?: Record<string, unknown>; body?: unknown }): FakeAnswer | null;
}

const ok = (body: unknown): FakeAnswer => ({ status: 200, body });
const refuse = (field: string, message: string): FakeAnswer => ({
  status: 422,
  body: { error: { code: 'validation_failed', message, fields: { [field]: [message] } } },
});

export const PLACE_NEWS_OPS = [
  'place.find',
  'place.set',
  'news.sources',
  'news.setSources',
  'news.addSite',
] as const;

export function createFakePlaceNews(options: FakePlaceNewsOptions): FakePlaceNews {
  let place: Place | null = options.place ?? options.guess;
  let chosen: NewsChosenSource[] = options.chosen ?? [AT5];

  const news = (): NewsSourcesView => {
    const on = new Set(chosen.map((s) => s.id));
    return {
      place,
      chosen,
      suggestions: newsSuggestionsFor(place).filter((s) => !on.has(s.id)),
    };
  };

  const find = (raw: Record<string, unknown> | undefined): FakeAnswer => {
    const parsed = PlaceFindQuery.safeParse(raw ?? {});
    if (!parsed.success) return refuse('query', 'Give a name to look up, or a latitude and longitude.');
    const { query, lat, lon } = parsed.data;
    if (query !== undefined) {
      const q = query.toLowerCase();
      const found = TOWNS.filter(
        (t) => t.name.toLowerCase().startsWith(q) || t.regionName?.toLowerCase() === q,
      );
      return ok({ places: found.slice(0, 5).map((t) => ({ ...t, guessed: false })) });
    }
    // The nearest town to the device, as a reverse look-up answers one.
    const near = [...TOWNS].sort(
      (a, b) =>
        Math.hypot(a.lat - (lat ?? 0), a.lon - (lon ?? 0)) -
        Math.hypot(b.lat - (lat ?? 0), b.lon - (lon ?? 0)),
    )[0];
    return ok({ places: near ? [{ ...near, guessed: false }] : [] });
  };

  return {
    place: () => place,
    news,
    call(op, input) {
      switch (op) {
        case 'place.find':
          return find(input.query);
        case 'place.set': {
          const parsed = PlaceSetBody.safeParse(input.body ?? {});
          if (!parsed.success) return refuse('place', 'Choose a place from the list.');
          place = parsed.data.place ? { ...roundPlace(parsed.data.place), guessed: false } : options.guess;
          options.onPlace?.(place);
          // The host answers with its burrow, this place in it.
          return ok({ place });
        }
        case 'news.sources':
          return ok(news());
        case 'news.setSources': {
          const parsed = NewsSetSourcesBody.safeParse(input.body ?? {});
          if (!parsed.success) return refuse('ids', newsFullTextOf());
          const next: NewsChosenSource[] = [];
          for (const id of parsed.data.ids) {
            const was = chosen.find((s) => s.id === id);
            if (was) next.push(was);
            else if (!isOwnNewsSource(id)) {
              const row = newsSuggestion(id);
              if (!row) return refuse('ids', 'That news site isn’t known.');
              next.push({ id: row.id, name: row.name, url: row.url, own: false });
            } else return refuse('ids', 'That news site isn’t on any more.');
          }
          chosen = next;
          return ok(news());
        }
        case 'news.addSite': {
          const parsed = NewsAddSiteBody.safeParse(input.body ?? {});
          if (!parsed.success) return refuse('url', NEWS_WORDS.notHttps);
          if (chosen.length >= NEWS_SOURCES_MAX) return refuse('url', newsFullTextOf());
          // Read by hand: the phone's URL can't name a host.
          const [, host = '', path = ''] =
            /^https:\/\/(?:www\.)?([^/?#:]+)[^/?#]*(\/[^?#]*)?/.exec(
              newsSiteAddress(parsed.data.url) ?? '',
            ) ?? [];
          const address = newsSiteAddress(parsed.data.url) ?? '';
          const page = PAGES[host];
          const isFeed = /(rss|feed|atom|\.xml)/i.test(path);
          if (!page && !isFeed) return refuse('url', NEWS_WORDS.notFeed);
          const url = page && !isFeed ? page.feed : address;
          const added: NewsChosenSource = {
            id: ownNewsSourceId(url),
            name: page?.name ?? host,
            url,
            own: true,
          };
          if (!chosen.some((s) => s.id === added.id)) chosen = [...chosen, added];
          return ok({ added, news: news() });
        }
        default:
          return null;
      }
    },
  };
}

function newsFullTextOf(): string {
  return NEWS_WORDS.full.replace('{n}', String(NEWS_SOURCES_MAX));
}
