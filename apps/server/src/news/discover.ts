/**
 * `news.addSite`'s look at a source (docs/decisions/weather-news.md): the address the person typed (https put in front
 * of a bare name), followed through at most three redirects, each one checked again. Some addresses name their feed
 * themselves: a YouTube channel (its page read once for the channel's id), a subreddit, a Mastodon or Bluesky account,
 * an Apple podcast (its feed asked of Apple's look-up) and a GitHub project's releases. Otherwise a feed is taken as it
 * is, and a page by the first feed it names (`<link rel="alternate">`). Anything else is refused in plain words. What is
 * kept is the feed's final address, so the reader never follows a redirect, and what it is (`NewsSourceKind`).
 */
import { NEWS_WORDS, type NewsSourceKind, newsSiteAddress, newsSourceKind } from '@whombat/core';
import { ApiError } from '../lib/errors';
import { OPEN_DATA_MAX_BYTES, type OpenDataAnswer, openDataGet } from '../lib/open-data';
import type { Services } from '../services';
import { feedLinksOf, type ParsedFeed, pageTitleOf, parseFeed, plainText } from './feeds';
import { FEED_ACCEPT } from './reader';

/** Redirects followed while looking at a source. */
const REDIRECTS_MAX = 3;
/**
 * How much of a YouTube channel's page is read: the page runs to a megabyte or two, and its own feed and channel id come
 * in its head, about the first megabyte.
 */
export const YOUTUBE_PAGE_MAX = 2 * 1024 * 1024;
/** Turns down YouTube's cookie question, which it would otherwise answer an EU address with instead of the page. */
const YOUTUBE_COOKIE = 'SOCS=CAI';
const PAGE_ACCEPT = `${FEED_ACCEPT}, text/html;q=0.5`;

/** A refusal shown under the address field. */
const refused = (message: string) =>
  new ApiError('validation_failed', message, { fields: { url: [message] } });

/** An answer that says there is nothing at that address, rather than “not just now”. */
const gone = (status: number) => status === 404 || status === 410;

/** A source found from what the person typed: its feed's final address, its name and what it is. */
export interface FoundFeed {
  url: string;
  name: string;
  kind: NewsSourceKind;
}

/** A GET that follows a few redirects, each to an https address of its own. */
async function getFollowing(
  services: Services,
  start: string,
  headers: Record<string, string> = {},
  keepFirst = OPEN_DATA_MAX_BYTES,
): Promise<{ url: string; res: OpenDataAnswer }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    let res: OpenDataAnswer;
    try {
      res = await openDataGet(services, url, { accept: PAGE_ACCEPT, ...headers }, { keepFirst });
    } catch {
      throw refused(NEWS_WORDS.unreachable);
    }
    if (res.status < 300 || res.status >= 400) return { url, res };
    const location = res.headers.location;
    const target = Array.isArray(location) ? location[0] : location;
    let next: string | null = null;
    try {
      next = target ? newsSiteAddress(new URL(target, url).href) : null;
    } catch {
      next = null;
    }
    if (!next || hop >= REDIRECTS_MAX) throw refused(NEWS_WORDS.unreachable);
    // A cookie question (YouTube's, Google's) instead of the page: nothing Whombat can answer.
    if (/^consent\./.test(new URL(next).hostname)) throw refused(NEWS_WORDS.unreachable);
    url = next;
  }
}

/** A site's host, as its name when the feed has none: “example.com”. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * What an address stands for before anything is read: a feed made from it (`feed`; `orPage`: when that isn't one, look
 * at the address as a page after all), a YouTube channel page to read for its id, or an Apple podcast to look up. Null:
 * an address to look at as it is. Pure.
 */
export type NewsAddress =
  | { kind: NewsSourceKind; feed: string; orPage?: boolean }
  | { kind: 'youtube'; channelPage: string }
  | { kind: 'podcast'; appleId: string };

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
]);
/** GitHub's own pages, which look like an owner and a project but aren't one. */
const GITHUB_PAGES = new Set([
  'about',
  'apps',
  'collections',
  'enterprise',
  'events',
  'explore',
  'features',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'organizations',
  'pricing',
  'pulls',
  'issues',
  'search',
  'settings',
  'site',
  'sponsors',
  'topics',
  'trending',
]);

export function newsAddressOf(address: string): NewsAddress | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (YOUTUBE_HOSTS.has(host)) {
    const channel = /^\/channel\/(UC[\w-]{22})(?:\/|$)/.exec(path)?.[1];
    if (channel)
      return { kind: 'youtube', feed: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}` };
    const list = path === '/playlist' ? url.searchParams.get('list') : null;
    if (list && /^[\w-]{10,64}$/.test(list))
      return { kind: 'youtube', feed: `https://www.youtube.com/feeds/videos.xml?playlist_id=${list}` };
    const named = /^\/(@[\w.-]{1,100}|c\/[^/]{1,100}|user\/[^/]{1,100})(?:\/|$)/.exec(path)?.[1];
    if (named) return { kind: 'youtube', channelPage: `https://www.youtube.com/${named}` };
    return null;
  }
  if (REDDIT_HOSTS.has(host)) {
    const sub = /^\/r\/([A-Za-z0-9_]{2,21})(?:\/|$)/.exec(path)?.[1];
    if (sub && !path.endsWith('.rss'))
      return { kind: 'reddit', feed: `https://www.reddit.com/r/${sub}/.rss` };
    return null;
  }
  if (host === 'bsky.app') {
    const who = /^\/profile\/([^/]{3,253})\/?$/.exec(path)?.[1];
    return who ? { kind: 'bluesky', feed: `https://bsky.app/profile/${who}/rss` } : null;
  }
  if (host === 'podcasts.apple.com' || host === 'itunes.apple.com') {
    const id = /\/id(\d{3,15})(?:\/|$)/.exec(path)?.[1];
    return id ? { kind: 'podcast', appleId: id } : null;
  }
  if (host === 'github.com' || host === 'www.github.com') {
    const m = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\/(?:releases|tags)?)?\/?$/.exec(path);
    const owner = m?.[1];
    const project = m?.[2]?.replace(/\.git$/, '');
    if (!owner || !project || GITHUB_PAGES.has(owner.toLowerCase()) || project.endsWith('.atom')) return null;
    return { kind: 'github', feed: `https://github.com/${owner}/${project}/releases.atom` };
  }
  // A Mastodon account (`https://host/@user`) has its posts at `@user.rss`; another site's `/@name` is a page.
  const account = /^\/@([A-Za-z0-9_]{1,30})\/?$/.exec(path)?.[1];
  if (account) return { kind: 'mastodon', feed: `https://${url.host}/@${account}.rss`, orPage: true };
  return null;
}

/** A YouTube channel's id in its page: its feed, its own address, or its id in the page's data. Pure. */
export function youtubeChannelId(html: string): string | null {
  const patterns = [
    /feeds\/videos\.xml\?channel_id=(UC[\w-]{22})/,
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
    /itemprop="identifier" content="(UC[\w-]{22})"/,
    /"externalId":"(UC[\w-]{22})"/,
    /"channelId":"(UC[\w-]{22})"/,
  ];
  for (const pattern of patterns) {
    const id = pattern.exec(html)?.[1];
    if (id) return id;
  }
  return null;
}

/** A feed read once at an address (redirects followed): where it ended, how it answered and the feed, if it is one. */
async function readFeed(
  services: Services,
  address: string,
): Promise<{ url: string; status: number; feed: ParsedFeed | null }> {
  const got = await getFollowing(services, address);
  const feed =
    got.res.status === 200
      ? parseFeed(got.res.body.toString('utf8'), got.url, services.clock().getTime(), {
          truncated: got.res.truncated,
        })
      : null;
  return { url: got.url, status: got.res.status, feed };
}

/** The feed a YouTube channel's page names. */
async function youtubeFeed(services: Services, page: string): Promise<string> {
  const got = await getFollowing(services, page, { cookie: YOUTUBE_COOKIE }, YOUTUBE_PAGE_MAX);
  if (got.res.status !== 200)
    throw refused(gone(got.res.status) ? NEWS_WORDS.notFeed : NEWS_WORDS.unreachable);
  const id = youtubeChannelId(got.res.body.toString('utf8'));
  if (!id) throw refused(NEWS_WORDS.notFeed);
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
}

/** An Apple podcast's feed, as Apple's look-up gives it (an `http` one asked as `https`: the box reads only https). */
async function applePodcastFeed(services: Services, id: string): Promise<string> {
  let res: OpenDataAnswer;
  try {
    res = await openDataGet(services, `https://itunes.apple.com/lookup?id=${id}`, {
      accept: 'application/json',
    });
  } catch {
    throw refused(NEWS_WORDS.unreachable);
  }
  if (res.status !== 200) throw refused(NEWS_WORDS.unreachable);
  let feedUrl: unknown;
  try {
    const answer = JSON.parse(res.body.toString('utf8')) as { results?: { feedUrl?: unknown }[] };
    feedUrl = answer.results?.find((r) => typeof r.feedUrl === 'string')?.feedUrl;
  } catch {
    feedUrl = undefined;
  }
  const url =
    typeof feedUrl === 'string' ? newsSiteAddress(feedUrl.replace(/^http:\/\//i, 'https://')) : null;
  if (!url) throw refused(NEWS_WORDS.notFeed);
  return url;
}

/** What a feed is when its address didn't say: a podcast's when it carries audio, else by its address. */
function kindOf(url: string, feed: ParsedFeed, known?: NewsSourceKind): NewsSourceKind {
  if (known) return known;
  return feed.audio ? 'podcast' : newsSourceKind({ url });
}

/** The feed a page or feed address leads to: a feed as it is, a page by the first feed it names. */
async function feedOfPage(services: Services, start: string): Promise<FoundFeed> {
  const first = await getFollowing(services, start);
  if (first.res.status !== 200) throw refused(NEWS_WORDS.unreachable);
  const now = services.clock().getTime();
  const body = first.res.body.toString('utf8');
  const feed = parseFeed(body, first.url, now, { truncated: first.res.truncated });
  if (feed)
    return {
      url: first.url,
      name: plainText(feed.title ?? hostOf(first.url), 80),
      kind: kindOf(first.url, feed),
    };
  const [link] = feedLinksOf(body, first.url);
  if (!link) throw refused(NEWS_WORDS.notFeed);
  const named = await readFeed(services, link);
  if (!named.feed) throw refused(NEWS_WORDS.notFeed);
  const name = named.feed.title ?? pageTitleOf(body) ?? hostOf(named.url);
  return { url: named.url, name: plainText(name, 80), kind: kindOf(named.url, named.feed) };
}

/** The feed a typed address leads to, with its name and kind; throws `validation_failed` on `url` in the person's words. */
export async function findFeed(services: Services, typed: string): Promise<FoundFeed> {
  const start = newsSiteAddress(typed);
  if (!start) throw refused(NEWS_WORDS.notHttps);
  const address = newsAddressOf(start);
  if (!address) return feedOfPage(services, start);
  let feedUrl: string;
  if ('channelPage' in address) feedUrl = await youtubeFeed(services, address.channelPage);
  else if ('appleId' in address) feedUrl = await applePodcastFeed(services, address.appleId);
  else feedUrl = address.feed;
  const orPage = 'orPage' in address && address.orPage === true;
  const read = await readFeed(services, feedUrl).catch((err: unknown) => {
    if (orPage) return null;
    throw err;
  });
  if (!read?.feed) {
    if (orPage) return feedOfPage(services, start);
    throw refused(
      read && read.status !== 200 && !gone(read.status) ? NEWS_WORDS.unreachable : NEWS_WORDS.notFeed,
    );
  }
  return {
    url: read.url,
    name: plainText(read.feed.title ?? hostOf(read.url), 80),
    kind: kindOf(read.url, read.feed, address.kind),
  };
}
