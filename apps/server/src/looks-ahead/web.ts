/**
 * The web for a Looks ahead check (docs/decisions/looks-ahead.md): a Brave search on the person's own key, and reading
 * one public page as text. Both through `lib/outbound.ts` (a public address only, DNS pinned, a cap on what is read),
 * GET only, nothing of the person's sent but the search words the check chose. Which pages a check may read is the
 * turn's (`seen.ts`): only a link it already saw, so private words can't leave in a made-up address.
 *
 * Tests answer for the web through `useAheadWebForTests` (refused outside `NODE_ENV=test`), without the network.
 */

import { htmlToText } from '../connectors/mime';
import { outboundErrorOf, outboundRequest } from '../lib/outbound';
import type { Services } from '../services';

/** The Brave search a check makes (at most this many results). */
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_RESULTS = 8;
/** The most a page or an answer may be: larger pages are cut there. */
const PAGE_MAX_BYTES = 1536 * 1024;
/** The page's text the turn gets, at most. */
export const PAGE_TEXT_MAX = 20_000;
/** Links a page gives, at most. */
const PAGE_LINKS_MAX = 40;
/** A whole search or page read, connect to last byte. */
const WEB_DEADLINE_MS = 15_000;
/** Redirects followed for a page (each a new checked request). */
const REDIRECTS_MAX = 3;

export interface WebAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** One GET (tests only replace it). */
export type WebRequest = (url: string, headers: Record<string, string>) => Promise<WebAnswer>;

const systemRequest: WebRequest = async (url, headers) => {
  const res = await outboundRequest(
    url,
    { method: 'GET', headers },
    { deadlineMs: WEB_DEADLINE_MS, timeoutMs: WEB_DEADLINE_MS, truncateAt: PAGE_MAX_BYTES },
  );
  return { status: res.status, headers: res.headers, body: res.body };
};

const overrides = new WeakMap<Services, WebRequest>();

/** Tests only: answers for Brave and the pages without the network. Refused outside `NODE_ENV=test`. */
export function useAheadWebForTests(services: Services, request: WebRequest): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The Looks ahead web seam is for tests only.');
  overrides.set(services, request);
}

function requestOf(services: Services): WebRequest {
  return overrides.get(services) ?? systemRequest;
}

/** Why a search or a page didn't work, in plain words for the turn. */
export class WebRefusal extends Error {}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const plain = (s: unknown) => (typeof s === 'string' ? htmlToText(s).replace(/\s+/g, ' ').trim() : '');

/** A Brave search with the person's key. */
export async function braveSearch(services: Services, key: string, query: string): Promise<SearchResult[]> {
  const url = `${BRAVE_SEARCH_URL}?${new URLSearchParams({ q: query, count: String(SEARCH_RESULTS) })}`;
  let answer: WebAnswer;
  try {
    answer = await requestOf(services)(url, { 'X-Subscription-Token': key, Accept: 'application/json' });
  } catch (err) {
    throw new WebRefusal(`The search didn’t answer: ${outboundErrorOf(err).message}`);
  }
  if (answer.status === 402 || answer.status === 429)
    throw new WebRefusal('The Brave Search key has no searches left right now.');
  if (answer.status !== 200) throw new WebRefusal(`The search answered HTTP ${answer.status}.`);
  let json: { web?: { results?: { title?: unknown; url?: unknown; description?: unknown }[] } };
  try {
    json = JSON.parse(answer.body.toString('utf8'));
  } catch {
    throw new WebRefusal('The search answered something that isn’t a list of results.');
  }
  return (json.web?.results ?? []).flatMap((r) => {
    const link = typeof r.url === 'string' ? httpUrl(r.url) : null;
    return link
      ? [{ title: clip(plain(r.title), 300), url: link, snippet: clip(plain(r.description), 600) }]
      : [];
  });
}

export interface Page {
  /** Where it ended up after redirects. */
  url: string;
  title: string;
  text: string;
  links: string[];
}

/** An http(s) address as one string, or null. */
export function httpUrl(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw.trim(), base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    const out = url.toString();
    return out.length <= 2048 ? out : null;
  } catch {
    return null;
  }
}

function header(headers: WebAnswer['headers'], name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** The links of an HTML page, absolute, at most `PAGE_LINKS_MAX`. */
export function pageLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? '').replace(/&amp;/g, '&');
    const link = href.startsWith('#') ? null : httpUrl(href, base);
    if (link) out.add(link);
    if (out.size >= PAGE_LINKS_MAX) break;
  }
  return [...out];
}

/**
 * Reads one page (`url` already allowed by the turn) as text, following a few redirects, each checked again. `allow`
 * says whether a redirect's target may be read: a page that sends the check to another site goes only where the turn
 * could have gone itself.
 */
export async function readPage(
  services: Services,
  url: string,
  allow: (next: string) => boolean,
): Promise<Page> {
  // Pages are read over https only (the outbound rule): an http link is tried at its https address.
  const secure = (u: string) => (u.startsWith('http:') ? `https:${u.slice(5)}` : u);
  let at = secure(url);
  for (let hop = 0; hop <= REDIRECTS_MAX; hop++) {
    let answer: WebAnswer;
    try {
      answer = await requestOf(services)(at, {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        'User-Agent': 'Mozilla/5.0 (compatible; Whombat)',
      });
    } catch (err) {
      throw new WebRefusal(`The page didn’t answer: ${outboundErrorOf(err).message}`);
    }
    if (answer.status >= 300 && answer.status < 400) {
      const next = httpUrl(header(answer.headers, 'location'), at);
      if (!next) throw new WebRefusal(`The page answered HTTP ${answer.status} without a place to go.`);
      // The same site (http → https, a trailing slash) or a link the turn saw: else it stops here.
      const site = (u: string) => new URL(u).hostname.replace(/^www\./, '');
      if (site(next) !== site(at) && !allow(next))
        throw new WebRefusal('The page sends you to another site this check hasn’t seen.');
      at = secure(next);
      continue;
    }
    if (answer.status !== 200) throw new WebRefusal(`The page answered HTTP ${answer.status}.`);
    const type = header(answer.headers, 'content-type').toLowerCase();
    const body = answer.body.toString('utf8');
    if (type.includes('html') || (!type && /<html|<body|<p\b/i.test(body))) {
      const title = plain(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '');
      return {
        url: at,
        title: clip(title, 300),
        text: clip(htmlToText(body), PAGE_TEXT_MAX),
        links: pageLinks(body, at),
      };
    }
    if (type.startsWith('text/') || type.includes('json'))
      return { url: at, title: '', text: clip(body, PAGE_TEXT_MAX), links: [] };
    throw new WebRefusal('That isn’t a page with text (a picture or a file).');
  }
  throw new WebRefusal('The page kept sending you elsewhere.');
}
