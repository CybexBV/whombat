/**
 * What one Looks ahead check has seen so far (docs/decisions/looks-ahead.md): the links it may read and the mails it
 * read, by its dispatch, in this server's memory. `read_web_page` reads only a link the check saw — in the event, in
 * a search result or on a page it read — never one it made up, so nothing private leaves in an address; a finding names
 * only pages and mails the check really saw. After a restart a check starts with what its event says.
 */
import { AHEAD_PAGES_MAX, AHEAD_SEARCHES_MAX } from '@whombat/core';
import type { Services } from '../services';
import { httpUrl } from './web';

interface CheckSeen {
  urls: Set<string>;
  mails: Set<string>;
  searches: number;
  pages: number;
  at: number;
}

/** A check's memory goes after this long: no check takes that long. */
const KEEP_MS = 3 * 3600_000;
/** Links remembered per check, at most. */
const URLS_MAX = 400;

const seenBy = new WeakMap<Services, Map<string, CheckSeen>>();

/** Every http(s) link in a text, at most `max`. */
export function linksIn(text: string, max = 40): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'()]+/gi)) {
    const link = httpUrl(match[0].replace(/[.,;:!?]+$/, ''));
    if (link) out.add(link);
    if (out.size >= max) break;
  }
  return [...out];
}

/** The check's memory, made with the event's own links the first time it is asked for. */
export function seenOf(services: Services, dispatchId: string, eventText: () => string): CheckSeen {
  let all = seenBy.get(services);
  if (!all) {
    all = new Map();
    seenBy.set(services, all);
  }
  const now = services.clock().getTime();
  for (const [id, s] of all) if (now - s.at > KEEP_MS) all.delete(id);
  let seen = all.get(dispatchId);
  if (!seen) {
    seen = { urls: new Set(linksIn(eventText())), mails: new Set(), searches: 0, pages: 0, at: now };
    all.set(dispatchId, seen);
  }
  return seen;
}

/** Remembers links the check may now read. */
export function sawLinks(seen: CheckSeen, links: readonly string[]): void {
  for (const raw of links) {
    if (seen.urls.size >= URLS_MAX) return;
    const link = httpUrl(raw);
    if (link) seen.urls.add(link);
  }
}

/** Whether the check saw this link (as given, or without a trailing slash's difference). */
export function sawLink(seen: CheckSeen, url: string): boolean {
  const link = httpUrl(url);
  if (!link) return false;
  if (seen.urls.has(link)) return true;
  const other = link.endsWith('/') ? link.slice(0, -1) : `${link}/`;
  return seen.urls.has(other);
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
