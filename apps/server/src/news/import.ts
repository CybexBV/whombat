/**
 * `news.importSites`' look at another reader's list (docs/decisions/weather-news.md): each address checked as
 * `news.addSite` checks one (`findFeed`), a few at a time, before one commit adds them all. An address already on, or
 * twice in the list, is passed over without a word; one that can't be added is skipped with why, in the words
 * `news.addSite` would say. Once as many new sources were found as there is room for, the addresses after them aren't
 * read at all, and are skipped as full. The whole look ends within `NEWS_IMPORT_BUDGET_MS`, so the answer comes while the app still waits for it; an
 * address not read by then is skipped as unreachable.
 */
import {
  NEWS_SOURCES_MAX,
  NEWS_SUGGESTIONS,
  NEWS_WORDS,
  type NewsSource,
  newsSiteAddress,
  ownNewsSourceId,
} from '@whombat/core';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { findFeed } from './discover';
import { eachLimited } from './reader';

/** Addresses read at once while importing. */
export const NEWS_IMPORT_AT_ONCE = 4;
/** The longest an import reads, inside the half minute an app waits for an answer. */
export const NEWS_IMPORT_BUDGET_MS = 20_000;

/** What became of one address of the list, in its order. */
export type ImportCheck =
  | { url: string; source: NewsSource }
  | { url: string; problem: string }
  | { url: string; already: true };

/** The source a found feed becomes: a suggestion keeps its own id and name, another is the person's own. */
export function newsSourceOfFeed(feed: {
  url: string;
  name: string;
  kind: NewsSource['kind'];
}): NewsSource & {
  own: boolean;
} {
  const known = NEWS_SUGGESTIONS.find((s) => s.url === feed.url);
  if (known) return { id: known.id, name: known.name, url: known.url, own: false };
  return {
    id: ownNewsSourceId(feed.url),
    name: feed.name || 'News',
    url: feed.url,
    ...(feed.kind && { kind: feed.kind }),
    own: true,
  };
}

/** Why an address couldn't be added, in the person's words. */
function problemOf(err: unknown): string {
  if (err instanceof ApiError && err.code === 'validation_failed') return err.message;
  return NEWS_WORDS.unreachable;
}

/** Each address of the list checked, in its order; `on`: the sources on now. */
export async function checkImports(
  services: Services,
  urls: readonly string[],
  on: readonly NewsSource[],
  options: { atOnce?: number; budgetMs?: number } = {},
): Promise<ImportCheck[]> {
  const onUrls = new Set(on.map((s) => s.url));
  const onIds = new Set(on.map((s) => s.id));
  const seen = new Set<string>();
  const room = NEWS_SOURCES_MAX - on.length;
  const full = NEWS_WORDS.full.replace('{n}', String(NEWS_SOURCES_MAX));
  // Decided before anything is read: what isn't an https address, and what is plainly on already or twice in the list.
  const plan = urls.map((url): ImportCheck | { url: string; address: string } => {
    const address = newsSiteAddress(url);
    if (!address) return { url, problem: NEWS_WORDS.notHttps };
    const known = NEWS_SUGGESTIONS.find((s) => s.url === address);
    if (seen.has(address) || onUrls.has(address) || (known && onIds.has(known.id)))
      return { url, already: true };
    seen.add(address);
    return { url, address };
  });
  const found = new Set<string>();
  let late = false;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      resolve(null);
    }, options.budgetMs ?? NEWS_IMPORT_BUDGET_MS);
  });
  try {
    return await eachLimited(
      plan,
      options.atOnce ?? NEWS_IMPORT_AT_ONCE,
      async (step): Promise<ImportCheck> => {
        if (!('address' in step)) return step;
        const { url, address } = step;
        if (found.size >= room) return { url, problem: full };
        if (late) return { url, problem: NEWS_WORDS.unreachable };
        const read = await Promise.race([
          findFeed(services, address).then(
            (feed) => ({ feed }),
            (err: unknown) => ({ problem: problemOf(err) }),
          ),
          expired,
        ]);
        if (!read) return { url, problem: NEWS_WORDS.unreachable };
        if ('problem' in read) return { url, problem: read.problem };
        const { own: _own, ...source } = newsSourceOfFeed(read.feed);
        if (onIds.has(source.id) || onUrls.has(source.url) || found.has(source.id))
          return { url, already: true };
        found.add(source.id);
        return { url, source };
      },
    );
  } finally {
    clearTimeout(timer);
  }
}
