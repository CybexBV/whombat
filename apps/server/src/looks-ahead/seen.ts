/**
 * What one Looks ahead check has seen so far (docs/decisions/looks-ahead.md), by its dispatch, in this server's memory:
 * the links it may read (search results and links on pages it read, never one it made up, so nothing private leaves in
 * an address), the pages it may name as sources (pages it read), the mails it read (by their
 * sender), and whether it read mail (also kept on the check's row, `mail_read_at`, which outlasts a restart): after
 * that nothing more goes to the web, so a stranger's mail can't steer what leaves the Whombat.
 */
import { AHEAD_PAGES_MAX, AHEAD_SEARCHES_MAX } from '@whombat/core';
import type { Services } from '../services';
import { httpUrl } from './web';

export interface CheckSeen {
  /** Links it may read: a search result, or a link on a page it read. */
  urls: Set<string>;
  /** Pages it may name as a source: pages it read (a search result is only a lead). */
  sources: Set<string>;
  /** The mails it read, by id, with the sender's name a finding names them by. */
  mails: Map<string, string>;
  /** It searched or read mail: the web is closed for the rest of the check. */
  mailRead: boolean;
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
      sources: new Set(),
      mails: new Map(),
      mailRead: false,
      searches: 0,
      pages: 0,
      at: now,
    };
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

/** Whether the check may name this page as a source. */
export function sawSourceOf(seen: CheckSeen, url: string): boolean {
  return holds(seen.sources, url);
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
