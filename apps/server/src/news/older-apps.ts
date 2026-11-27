/**
 * The news as an app before more news reads it (docs/decisions/weather-news.md): an app below session protocol minor
 * `NEWS_MORE_MINOR` was built for twelve sources, and refuses a whole answer with more. So it is shown the first twelve
 * sources that are on; when it saves its list, the sources it couldn't see stay on after it (unless its list names
 * them), and it can add a source only while fewer than twelve are on, as before. A newer app, the assistant and
 * anything outside a session get everything.
 */
import {
  NEWS_SOURCES_MAX,
  NEWS_SOURCES_MAX_BEFORE_MORE,
  type NewsAddSiteResult,
  type NewsSourcesView,
} from '@whombat/core';
import { NEWS_MORE_MINOR } from '@whombat/protocol/session';

/** Whether a session at `minor` reads up to `NEWS_SOURCES_MAX` sources; outside a session (`undefined`), it does. */
export const readsMoreNews = (minor: number | undefined) => minor === undefined || minor >= NEWS_MORE_MINOR;

/** The most sources an app at `minor` shows and lets the person have on. */
export const newsSourcesMaxFor = (minor: number | undefined) =>
  readsMoreNews(minor) ? NEWS_SOURCES_MAX : NEWS_SOURCES_MAX_BEFORE_MORE;

/** How many of the sources an app at `minor` is shown, for keeping the rest when it saves; undefined: all of them. */
export const newsSourcesShownTo = (minor: number | undefined) =>
  readsMoreNews(minor) ? undefined : NEWS_SOURCES_MAX_BEFORE_MORE;

/** `news.sources` as an app at `minor` reads it: the first twelve sources for an older app. */
export function newsViewFor(view: NewsSourcesView, minor: number | undefined): NewsSourcesView {
  if (readsMoreNews(minor) || view.chosen.length <= NEWS_SOURCES_MAX_BEFORE_MORE) return view;
  return { ...view, chosen: view.chosen.slice(0, NEWS_SOURCES_MAX_BEFORE_MORE) };
}

/** `news.addSite`'s answer as an app at `minor` reads it. */
export function addSiteResultFor(result: NewsAddSiteResult, minor: number | undefined): NewsAddSiteResult {
  const news = newsViewFor(result.news, minor);
  return news === result.news ? result : { ...result, news };
}

/**
 * The ids an app saved, with the sources it wasn't shown (those after the first `shown` that are on now) kept after
 * them, unless its list names them. Its own list decides everything it could see: one it left out is turned off.
 */
export function withUnseenSources(
  ids: readonly string[],
  on: readonly { id: string }[],
  shown: number | undefined,
): string[] {
  if (shown === undefined) return [...ids];
  const named = new Set(ids);
  return [
    ...ids,
    ...on
      .slice(shown)
      .map((s) => s.id)
      .filter((id) => !named.has(id)),
  ];
}
