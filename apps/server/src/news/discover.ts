/**
 * `news.addSite`'s look at a site (docs/decisions/weather-news.md): the address the person typed (https put in front of
 * a bare name), followed through at most three redirects, each one checked again; a feed is taken as it is, a page by
 * the first feed it names (`<link rel="alternate">`). Anything else is refused in plain words. What is kept is the
 * feed's final address, so the reader never follows a redirect.
 */
import { NEWS_WORDS, newsSiteAddress } from '@whombat/core';
import { ApiError } from '../lib/errors';
import { type OpenDataAnswer, openDataGet } from '../lib/open-data';
import type { Services } from '../services';
import { feedLinksOf, pageTitleOf, parseFeed, plainText } from './feeds';
import { FEED_ACCEPT } from './reader';

/** Redirects followed while looking at a site. */
const REDIRECTS_MAX = 3;

/** A refusal shown under the address field. */
const refused = (message: string) =>
  new ApiError('validation_failed', message, { fields: { url: [message] } });

/** A GET that follows a few redirects, each to an https address of its own. */
async function getFollowing(
  services: Services,
  start: string,
): Promise<{ url: string; res: OpenDataAnswer }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    let res: OpenDataAnswer;
    try {
      res = await openDataGet(services, url, { accept: `${FEED_ACCEPT}, text/html;q=0.5` });
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

/** The feed a typed address leads to, with its name; throws `validation_failed` on `url` in the person's words. */
export async function findFeed(services: Services, typed: string): Promise<{ url: string; name: string }> {
  const start = newsSiteAddress(typed);
  if (!start) throw refused(NEWS_WORDS.notHttps);
  const now = services.clock().getTime();
  const first = await getFollowing(services, start);
  if (first.res.status !== 200) throw refused(NEWS_WORDS.unreachable);
  const body = first.res.body.toString('utf8');
  const feed = parseFeed(body, first.url, now);
  if (feed) return { url: first.url, name: feed.title ?? hostOf(first.url) };
  const [link] = feedLinksOf(body, first.url);
  if (!link) throw refused(NEWS_WORDS.notFeed);
  const second = await getFollowing(services, link);
  const named =
    second.res.status === 200 ? parseFeed(second.res.body.toString('utf8'), second.url, now) : null;
  if (!named) throw refused(NEWS_WORDS.notFeed);
  const name = named.title ?? pageTitleOf(body) ?? hostOf(second.url);
  return { url: second.url, name: plainText(name, 80) };
}
