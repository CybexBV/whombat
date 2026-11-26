/**
 * Where this Whombat is and the news it reads (Whombat weather-news.md), in Settings → This Whombat. Session ops
 * `place.find`, `place.set`, `news.sources`, `news.setSources` and `news.addSite`, which an app asks only of a box at
 * `WEATHER_NEWS_MINOR` or later; the person's own, and the assistant's through its settings tools.
 */
import { z } from 'zod';
import { Burrow } from '../domain/burrow.js';
import { NewsAddSiteBody, NewsAddSiteResult, NewsSetSourcesBody, NewsSourcesView } from '../domain/news.js';
import { PlaceFindQuery, PlaceFindResult, PlaceSetBody } from '../domain/place.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const placeEndpoints = {
  find: endpoint({
    id: 'place.find',
    method: 'GET',
    path: '/burrows/:burrow/place/find',
    summary:
      'Look up a place for this Whombat on OpenStreetMap (Nominatim): a town, city or address (`query`), or a latitude and longitude (`lat`, `lon`: the device’s own location). Up to 5 places, best first, with their country and region. Only what is looked up leaves the box; at most one look-up a second, the answers kept for a day.',
    params: B,
    query: PlaceFindQuery,
    response: PlaceFindResult,
  }),
  set: endpoint({
    id: 'place.set',
    method: 'PUT',
    path: '/burrows/:burrow/place',
    summary:
      'Set where this Whombat is, for the weather and the suggested news: a place from `place.find` (its latitude and longitude kept to 2 decimals), or null to go back to the time zone’s guess. Publishes the burrow.',
    params: B,
    body: PlaceSetBody,
    response: z.object({ burrow: Burrow }),
  }),
};

export const newsEndpoints = {
  sources: endpoint({
    id: 'news.sources',
    method: 'GET',
    path: '/burrows/:burrow/news',
    summary:
      'The news sites this Whombat reads (each one’s last problem, if any), and the sites suggested for its place that aren’t on, the nearest first.',
    params: B,
    response: NewsSourcesView,
  }),
  setSources: endpoint({
    id: 'news.setSources',
    method: 'PUT',
    path: '/burrows/:burrow/news',
    summary:
      'Choose which news sites are on, in order, by id (up to 12): suggested ones, and added ones that are on now. A site left out is turned off; an added one is forgotten. Nothing is read from a site until it is on.',
    params: B,
    body: NewsSetSourcesBody,
    response: NewsSourcesView,
  }),
  addSite: endpoint({
    id: 'news.addSite',
    method: 'POST',
    path: '/burrows/:burrow/news/sites',
    summary:
      'Add a news site of the person’s own by its https address: a feed (RSS or Atom) is added as it is, a page by the feed it names. Read once to check it; anything else is `validation_failed` on `url`, and so is a 13th site.',
    params: B,
    body: NewsAddSiteBody,
    response: NewsAddSiteResult,
  }),
};
