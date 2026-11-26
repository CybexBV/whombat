/**
 * Reading the news sites the person turned on (docs/decisions/weather-news.md), as a feed reader does: each site's feed
 * fetched over https from its own address (no redirects: the address kept is the feed's own), kept 15 minutes, and read
 * only while something needs it (a shown widget, the assistant, Looks ahead). A site that can't be read keeps the
 * headlines it had and says so (`problemOf`), and is tried again after 5 minutes. The headlines of all sites together come
 * newest first, each once (by link, and by the same words).
 */
import { NEWS_FEED_KEEP_S, type NewsHeadline, type NewsSource } from '@whombat/core';
import { openDataGet } from '../lib/open-data';
import type { Services } from '../services';
import { type FeedItem, parseFeed } from './feeds';

/** After a failed read, the next try. */
export const NEWS_RETRY_MS = 5 * 60_000;
/** Feeds kept at most. */
const KEPT_MAX = 100;

/** What `news.sources` and the tool say of a site that couldn't be read. */
export const NEWS_READ_WORDS = {
  moved: 'The site moved its feed: add it again by its new address',
  notFeed: 'The site’s address doesn’t give a news feed any more',
  failed: 'Couldn’t read it just now',
} as const;

/** The Accept a feed is asked with. */
export const FEED_ACCEPT =
  'application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.1';

interface Entry {
  items: FeedItem[];
  /** Why the last read failed, in a few words; null when it worked. */
  problem: string | null;
  has: boolean;
  nextAt: number;
  pending: Promise<void> | null;
}

/** All sites' headlines together, newest first, each once (by link, and by the same words), at most `max`. */
export function mergeHeadlines(
  bySource: readonly { source: Pick<NewsSource, 'id' | 'name'>; items: readonly FeedItem[] }[],
  max: number,
): NewsHeadline[] {
  const all = bySource.flatMap(({ source, items }) =>
    items.map((i) => ({ sourceId: source.id, source: source.name, title: i.title, at: i.at, link: i.link })),
  );
  all.sort((a, b) => b.at - a.at);
  const links = new Set<string>();
  const titles = new Set<string>();
  const out: NewsHeadline[] = [];
  for (const h of all) {
    const words = h.title.toLowerCase();
    if (links.has(h.link) || titles.has(words)) continue;
    links.add(h.link);
    titles.add(words);
    out.push({ ...h, at: new Date(h.at).toISOString() });
    if (out.length >= max) break;
  }
  return out;
}

/** The news sites of one Whombat. */
export class NewsReader {
  readonly #kept = new Map<string, Entry>();

  constructor(private readonly services: Services) {}

  /** Each site's headlines and whether it could be read now, reading those whose 15 minutes are up. */
  async read(
    sources: readonly NewsSource[],
  ): Promise<{ source: NewsSource; items: FeedItem[]; ok: boolean }[]> {
    return Promise.all(
      sources.map(async (source) => {
        const e = await this.#feed(source.url);
        return { source, items: e.items, ok: e.problem === null && e.has };
      }),
    );
  }

  /** Why a site's last read failed, or null (also when it was never read). */
  problemOf(url: string): string | null {
    return this.#kept.get(url)?.problem ?? null;
  }

  async #feed(url: string): Promise<Entry> {
    let e = this.#kept.get(url);
    if (!e) {
      if (this.#kept.size >= KEPT_MAX) this.#kept.delete(this.#kept.keys().next().value as string);
      e = { items: [], problem: null, has: false, nextAt: 0, pending: null };
      this.#kept.set(url, e);
    }
    const entry = e;
    if (this.services.clock().getTime() >= entry.nextAt) {
      entry.pending ??= this.#fetch(entry, url).finally(() => {
        entry.pending = null;
      });
      await entry.pending;
    }
    return entry;
  }

  async #fetch(e: Entry, url: string): Promise<void> {
    const now = () => this.services.clock().getTime();
    try {
      const res = await openDataGet(this.services, url, { accept: FEED_ACCEPT });
      if (res.status >= 300 && res.status < 400) throw new FeedProblem(NEWS_READ_WORDS.moved);
      if (res.status !== 200) throw new FeedProblem(NEWS_READ_WORDS.failed, `HTTP ${res.status}`);
      const feed = parseFeed(res.body.toString('utf8'), url, now());
      if (!feed) throw new FeedProblem(NEWS_READ_WORDS.notFeed);
      e.items = feed.items;
      e.problem = null;
      e.has = true;
      e.nextAt = now() + NEWS_FEED_KEEP_S * 1000;
    } catch (err) {
      e.problem = err instanceof FeedProblem ? err.message : NEWS_READ_WORDS.failed;
      this.services.log.warn(
        { err: err instanceof FeedProblem ? (err.detail ?? err.message) : String(err), site: siteOf(url) },
        'news: a news site couldn’t be read',
      );
      e.nextAt = now() + NEWS_RETRY_MS;
    }
  }
}

/** A failure the person reads, and what the log keeps of it. */
class FeedProblem extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** A site's host for the log: never the feed's whole address. */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'site';
  }
}

const readers = new WeakMap<Services, NewsReader>();

/** The Whombat's one news reader. */
export function newsFor(services: Services): NewsReader {
  let r = readers.get(services);
  if (!r) {
    r = new NewsReader(services);
    readers.set(services, r);
  }
  return r;
}
