/**
 * Where this Whombat is and the news it reads (Whombat weather-news.md; `place.find`, `place.set`, `news.sources`,
 * `news.setSources`, `news.addSite`, `news.browse`, `news.importSites`), for Settings → News and weather on the web and
 * the phone. A box from before answers none of them: the apps ask only one at `WEATHER_NEWS_MINOR` or later
 * (`placeNewsShown`), and browsing and importing only at `NEWS_MORE_MINOR` or later (`newsMoreShown`).
 */
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type Burrow,
  type NewsAddSiteResult,
  type NewsImportResult,
  type NewsSourcesView,
  type PlaceFindResult,
  type PlaceInput,
} from '@whombat/core';
import {
  NEWS_MORE_MINOR,
  type ProtocolVersion,
  protocolAtLeast,
  WEATHER_NEWS_MINOR,
} from '@whombat/protocol/session';
import type { CommitResult } from '../http/types';
import { clientTree } from '../i18n/catalog';
import { HOME_AREA_WORDS } from '../i18n/messages/chatWork/home';
import { patchEndpoint } from '../query/cache';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

/** Whether the Whombat answers the place and the news: one at `WEATHER_NEWS_MINOR` or later. */
export function placeNewsShown(protocol: ProtocolVersion | null | undefined): boolean {
  return protocolAtLeast(protocol, WEATHER_NEWS_MINOR);
}

/** Whether the Whombat browses every country's suggestions and imports a list: one at `NEWS_MORE_MINOR` or later. */
export function newsMoreShown(protocol: ProtocolVersion | null | undefined): boolean {
  return protocolAtLeast(protocol, NEWS_MORE_MINOR);
}

/** The news sites that are on and the ones suggested for the place. */
export const useNewsSources = queryHook(api.news.sources);

/** Every suggested site of one country (`query.country`, the place's without it), with whether each is on. */
export const useNewsBrowse = queryHook(api.news.browse);

/** After a change to which sources are on: the sources' view is the answer's, and browsing reads again. */
function newsChanged(qc: QueryClient, burrow: string, view: NewsSourcesView): void {
  qc.setQueryData(queryKeys.endpoint(api.news.sources, { params: { burrow } }), view);
  void qc.invalidateQueries({ queryKey: queryKeys.scope(api.news.browse, { burrow }) });
}

/** What a write's answer carries, or the refusal as an error (a read's answer is always `ok`). */
function dataOf<T>(result: CommitResult<T>, locale?: string | null): T {
  if (result.status === 'ok') return result.data;
  throw new Error(
    result.status === 'blocked' ? result.message : clientTree(locale, HOME_AREA_WORDS).notThrough,
  );
}

/** Look up a place by its name (`query`) or the device's own latitude and longitude. */
export function useFindPlace(burrow: string, locale?: string | null) {
  const { client } = useWhombat();
  return useMutation<PlaceFindResult, Error, { query: string } | { lat: number; lon: number }>({
    mutationFn: async (query) =>
      dataOf(await client.request(api.place.find, { params: { burrow }, query }), locale),
  });
}

function setBurrow(qc: QueryClient, slug: string, next: Burrow): void {
  const patch = (d: { burrow: Burrow }) =>
    d.burrow && d.burrow.id === next.id ? { ...d, burrow: { ...d.burrow, ...next } } : d;
  patchEndpoint<{ burrow: Burrow }>(qc, 'conversations.bootstrap', patch, { burrow: slug });
  patchEndpoint<{ burrow: Burrow }>(qc, 'burrows.get', patch, { burrow: slug });
}

/** Keep a place, or go back to the time zone's guess (null); the suggested news follows it. */
export function useSetPlace(burrow: string, locale?: string | null) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<Burrow, Error, PlaceInput | null>({
    mutationFn: async (place) =>
      dataOf(await client.request(api.place.set, { params: { burrow }, body: { place } }), locale).burrow,
    onSuccess: (next) => {
      setBurrow(qc, burrow, next);
      void qc.invalidateQueries({ queryKey: queryKeys.endpoint(api.news.sources, { params: { burrow } }) });
      void qc.invalidateQueries({ queryKey: queryKeys.scope(api.news.browse, { burrow }) });
    },
  });
}

/** Which news sites are on, in order (`news.setSources`); the answer is the part's new view. */
export function useSetNewsSources(burrow: string, locale?: string | null) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<NewsSourcesView, Error, string[]>({
    mutationFn: async (ids) =>
      dataOf(await client.request(api.news.setSources, { params: { burrow }, body: { ids } }), locale),
    onSuccess: (view) => newsChanged(qc, burrow, view),
  });
}

/** Add a news site of the person's own by its address; a refusal names the `url` field. */
export function useAddNewsSite(burrow: string, locale?: string | null) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<NewsAddSiteResult, Error, string>({
    mutationFn: async (url) =>
      dataOf(await client.request(api.news.addSite, { params: { burrow }, body: { url } }), locale),
    onSuccess: (result) => newsChanged(qc, burrow, result.news),
  });
}

/** Add the feeds of another reader's list (`newsOpmlUrls` of its OPML file); the answer says what was skipped. */
export function useImportNewsSites(burrow: string, locale?: string | null) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<NewsImportResult, Error, string[]>({
    mutationFn: async (urls) =>
      dataOf(await client.request(api.news.importSites, { params: { burrow }, body: { urls } }), locale),
    onSuccess: (result) => newsChanged(qc, burrow, result.news),
  });
}
