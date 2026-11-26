/**
 * What one Looks ahead check has seen so far (docs/decisions/looks-ahead.md), by its dispatch, in this server's memory:
 * the links it may read (search results and links on pages it read, never one it made up, so nothing private leaves in
 * an address), the pages it may name as sources (pages it read, plus search results whose fetch was attempted and
 * blocked by the site), the mails, Drive/OneDrive files and Paperless/Notion docs it read, and whether it touched any
 * private source (also kept on the check's row, `mail_read_at`, which outlasts a restart): after that nothing more goes
 * to the web, so private text can't steer what leaves the Whombat.
 */
import { AHEAD_PAGES_MAX, AHEAD_SEARCHES_MAX } from '@whombat/core';
import type { Services } from '../services';
import { httpUrl } from './web';

export interface CheckSeen {
  /** Links it may read: a search result, or a link on a page it read. */
  urls: Set<string>;
  /** Links returned by Brave search, so a blocked-fetch fallback is allowed only for search results actually tried. */
  searchUrls: Set<string>;
  /** Pages it may name as a full-page source: pages it successfully read. */
  sources: Set<string>;
  /** Search result links that the check actually tried with `read_web_page` and the site blocked (403/429/503/timeout). */
  blockedFallbacks: Set<string>;
  /** The mails it read, by id, with the sender's site name a finding names them by. */
  mails: Map<string, string>;
  /** The Drive / OneDrive files it read, by id, with the provider label (“Google Drive” / “OneDrive”). */
  files: Map<string, string>;
  /** The Paperless / Notion documents it read, by docId, with the source label (“Paperless” / “Notion”). */
  docs: Map<string, string>;
  /** It searched or read mail, files or docs: the web is closed for the rest of the check. */
  mailRead: boolean;
  /** It was given a forecast or read one (weather-news.md): `{ weather: true }` may be a finding's source. */
  weather: boolean;
  searches: number;
  pages: number;
  at: number;
}

/** A check's memory goes after this long: no check takes that long. */
const KEEP_MS = 3 * 3600_000;
/** Links remembered per check, at most. */
const URLS_MAX = 400;
const seenBy = new WeakMap<Services, Map<string, CheckSeen>>();

/** The check's memory, empty the first time it is asked for. */
export function seenOf(services: Services, dispatchId: string): CheckSeen {
  let all = seenBy.get(services);
  if (!all) {
    all = new Map();
    seenBy.set(services, all);
  }
  const now = services.clock().getTime();
  for (const [id, s] of all) if (now - s.at > KEEP_MS) all.delete(id);
  let seen = all.get(dispatchId);
  if (!seen) {
    seen = {
      urls: new Set(),
      searchUrls: new Set(),
      sources: new Set(),
      blockedFallbacks: new Set(),
      mails: new Map(),
      files: new Map(),
      docs: new Map(),
      mailRead: false,
      weather: false,
      searches: 0,
      pages: 0,
      at: now,
    };
    all.set(dispatchId, seen);
  }
  return seen;
}

/** Remembers links the check may now read (optionally marking them as Brave search hits). */
export function sawLinks(seen: CheckSeen, links: readonly string[], fromSearch = false): void {
  for (const raw of links) {
    if (seen.urls.size >= URLS_MAX) return;
    const link = httpUrl(raw);
    if (link) {
      seen.urls.add(link);
      if (fromSearch) seen.searchUrls.add(link);
    }
  }
}

/** Whether a set holds this link (as given, or without a trailing slash's difference). */
function holds(set: ReadonlySet<string>, url: string): boolean {
  const link = httpUrl(url);
  if (!link) return false;
  return set.has(link) || set.has(link.endsWith('/') ? link.slice(0, -1) : `${link}/`);
}

/** Whether the check saw this link. */
export function sawLink(seen: CheckSeen, url: string): boolean {
  return holds(seen.urls, url);
}

/** Remembers a page the check may name as a source. */
export function sawSource(seen: CheckSeen, url: string): void {
  const link = httpUrl(url);
  if (link) seen.sources.add(link);
}

/** Remembers a search-result link whose page fetch was attempted and blocked by the site. */
export function sawBlockedFallback(seen: CheckSeen, url: string): void {
  const link = httpUrl(url);
  if (link && holds(seen.searchUrls, link)) seen.blockedFallbacks.add(link);
}

/** Whether the check may name this link as a full-page source (`page`), a blocked search fallback (`search`), or not (`null`). */
export function sawSourceKind(seen: CheckSeen, url: string): 'page' | 'search' | null {
  if (holds(seen.sources, url)) return 'page';
  if (holds(seen.blockedFallbacks, url)) return 'search';
  return null;
}

/** Whether the check may name this page as a source (full page or blocked-fetch search fallback). */
export function sawSourceOf(seen: CheckSeen, url: string): boolean {
  return sawSourceKind(seen, url) !== null;
}

/** One more search, or false when the check used its searches. */
export function takeSearch(seen: CheckSeen): boolean {
  if (seen.searches >= AHEAD_SEARCHES_MAX) return false;
  seen.searches++;
  return true;
}

/** One more page, or false when the check read its pages. */
export function takePage(seen: CheckSeen): boolean {
  if (seen.pages >= AHEAD_PAGES_MAX) return false;
  seen.pages++;
  return true;
}

/** Forgets a check (it reported, or ended). */
export function forgetSeen(services: Services, dispatchId: string): void {
  seenBy.get(services)?.delete(dispatchId);
}
