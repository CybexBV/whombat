/**
 * Where this Whombat is and the news it reads (Whombat weather-news.md), in Settings → News and weather. Session ops
 * `place.find`, `place.set`, `news.sources`, `news.setSources` and `news.addSite`, which an app asks only of a box at
 * `WEATHER_NEWS_MINOR` or later, and `news.browse` and `news.importSites`, only at `NEWS_MORE_MINOR` or later; the
 * person's own, and the assistant's through its settings tools.
 */
import { z } from 'zod';
import { Burrow } from '../domain/burrow.js';
import {
  NewsAddSiteBody,
  NewsAddSiteResult,
  NewsBrowseQuery,
  NewsBrowseView,
  NewsImportBody,
  NewsImportResult,
  NewsSetSourcesBody,
  NewsSourcesView,
} from '../domain/news.js';
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
      'Choose which news sources are on, in order, by id (up to 30): suggested ones, and added ones that are on now. A source left out is turned off; an added one is forgotten. Nothing is read from a source until it is on.',
    params: B,
    body: NewsSetSourcesBody,
    response: NewsSourcesView,
  }),
  addSite: endpoint({
    id: 'news.addSite',
    method: 'POST',
    path: '/burrows/:burrow/news/sites',
    summary:
      'Add a news source of the person’s own by its https address: a feed (RSS or Atom) as it is, a page by the feed it names, and a YouTube channel, subreddit, Mastodon or Bluesky account, Apple podcast or GitHub project by the feed it has. Read once to check it; anything else is `validation_failed` on `url`, and so is a 31st source.',
    params: B,
    body: NewsAddSiteBody,
    response: NewsAddSiteResult,
  }),
  browse: endpoint({
    id: 'news.browse',
    method: 'GET',
    path: '/burrows/:burrow/news/browse',
    summary:
      'Every news site Whombat suggests in one country (`country`, ISO 3166-1; the place’s without it), with its topic, whom it is for, how near it is to this Whombat’s place and whether it is on, and every country with suggestions. Reads only the table on the box.',
    params: B,
    query: NewsBrowseQuery,
    response: NewsBrowseView,
  }),
  importSites: endpoint({
    id: 'news.importSites',
    method: 'POST',
    path: '/burrows/:burrow/news/import',
    summary:
      'Add news sources from another reader’s list (the feed addresses of an OPML file the device read), each checked as `news.addSite` checks one, up to the 30 a Whombat reads. Those that can’t be added are skipped, each with why; already on is not an error.',
    params: B,
    body: NewsImportBody,
    response: NewsImportResult,
  }),
};
