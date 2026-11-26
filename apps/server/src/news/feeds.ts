/**
 * A news site's feed as Whombat reads it (docs/decisions/weather-news.md): RSS 2.0, RSS 1.0 (RDF) and Atom, parsed with
 * htmlparser2 in XML mode. Only each item's headline, link and time are kept: no pictures, no article text. Headlines
 * lose any markup they carry; an item without a date or a link is left out (some feeds list their sections among their
 * articles); a time ahead of now is taken as now (some feeds write local time as UTC). Pure.
 */
import { NEWS_FEED_ITEMS_MAX } from '@whombat/core';
import { DomUtils, parseDocument } from 'htmlparser2';

type AnyNode = ReturnType<typeof parseDocument>['children'][number];
type Element = Extract<AnyNode, { attribs: Record<string, string> }>;

/** One headline of a feed. */
export interface FeedItem {
  title: string;
  link: string;
  /** When it was published (ms). */
  at: number;
}

export interface ParsedFeed {
  kind: 'rss' | 'rdf' | 'atom';
  /** The feed's own name (its channel's title), one line. */
  title: string | null;
  /** Its headlines, newest first, at most `NEWS_FEED_ITEMS_MAX`. */
  items: FeedItem[];
}

/** The longest headline kept. */
export const HEADLINE_MAX = 300;

const isElement = (n: AnyNode): n is Element => 'attribs' in n;
/** An element's local name, without its namespace prefix, lower case. */
const local = (el: Element) => el.name.toLowerCase().replace(/^.*:/, '');
const kids = (el: Element) => el.children.filter(isElement);
const child = (el: Element, name: string) => kids(el).find((c) => local(c) === name);
const text = (el: Element | undefined) => (el ? DomUtils.textContent(el) : '');

/** Words without markup or entities, on one line, at most `max` characters. */
export function plainText(value: string, max = HEADLINE_MAX): string {
  let out = value;
  // A headline may carry HTML, escaped once more (Atom's `type="html"`, RSS in CDATA): read it as HTML.
  if (/[<&]/.test(out)) out = DomUtils.textContent(parseDocument(out, { decodeEntities: true }));
  out = out.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** A link as a headline keeps it: absolute (relative ones against the feed), http or https only. */
function linkOf(raw: string, base: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** An Atom entry's link: its `alternate` one (or one without `rel`), an HTML page before anything else. */
function atomLink(entry: Element): string {
  const links = kids(entry).filter((c) => local(c) === 'link');
  const alternate = links.filter((l) => !l.attribs.rel || l.attribs.rel === 'alternate');
  const page = alternate.find((l) => !l.attribs.type || /html/i.test(l.attribs.type)) ?? alternate[0];
  return page?.attribs.href ?? '';
}

/** The feed's root and kind, or null when the document isn't a feed. */
function feedRoot(doc: ReturnType<typeof parseDocument>): { root: Element; kind: ParsedFeed['kind'] } | null {
  const root = doc.children.filter(isElement)[0];
  if (!root) return null;
  const name = local(root);
  if (name === 'rss') return { root, kind: 'rss' };
  if (name === 'rdf') return { root, kind: 'rdf' };
  if (name === 'feed') return { root, kind: 'atom' };
  return null;
}

/**
 * A feed's name and headlines (`base`: its address, for relative links; `now`: ms, for times ahead), or null when the
 * text isn't RSS, RDF or Atom.
 */
export function parseFeed(xml: string, base: string, now: number): ParsedFeed | null {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const found = feedRoot(doc);
  if (!found) return null;
  const { root, kind } = found;
  const channel = kind === 'atom' ? root : child(root, 'channel');
  const entries =
    kind === 'rss'
      ? channel
        ? kids(channel).filter((c) => local(c) === 'item')
        : []
      : kind === 'rdf'
        ? kids(root).filter((c) => local(c) === 'item')
        : kids(root).filter((c) => local(c) === 'entry');
  const items: FeedItem[] = [];
  for (const entry of entries) {
    const title = plainText(text(child(entry, 'title')));
    const rawLink =
      kind === 'atom'
        ? atomLink(entry)
        : text(child(entry, 'link')) ||
          (child(entry, 'guid')?.attribs.isPermaLink !== 'false' ? text(child(entry, 'guid')) : '') ||
          (entry.attribs['rdf:about'] ?? '');
    const link = linkOf(rawLink, base);
    const when =
      kind === 'atom'
        ? text(child(entry, 'published')) || text(child(entry, 'updated'))
        : text(child(entry, 'pubdate')) || text(child(entry, 'date'));
    const at = Date.parse(when.trim());
    if (!title || !link || !Number.isFinite(at)) continue;
    items.push({ title, link, at: Math.min(at, now) });
  }
  items.sort((a, b) => b.at - a.at);
  const name = plainText(text(channel ? child(channel, 'title') : undefined), 80);
  return { kind, title: name || null, items: items.slice(0, NEWS_FEED_ITEMS_MAX) };
}

/**
 * The feeds a web page names (`<link rel="alternate" type="application/rss+xml">` or Atom's), as absolute https
 * addresses, in the page's order. Pure.
 */
export function feedLinksOf(html: string, base: string): string[] {
  const doc = parseDocument(html, { decodeEntities: true });
  const out: string[] = [];
  for (const el of DomUtils.getElementsByTagName('link', doc)) {
    const rel = (el.attribs.rel ?? '').toLowerCase().split(/\s+/);
    const type = (el.attribs.type ?? '').toLowerCase();
    if (!rel.includes('alternate') || !/^application\/(rss|atom)\+xml/.test(type)) continue;
    const link = linkOf(el.attribs.href ?? '', base);
    if (link?.startsWith('https://') && !out.includes(link)) out.push(link);
  }
  return out;
}

/** A web page's own title, one line, or null. */
export function pageTitleOf(html: string): string | null {
  const doc = parseDocument(html, { decodeEntities: true });
  const title = DomUtils.getElementsByTagName('title', doc)[0];
  const value = title ? plainText(DomUtils.textContent(title), 80) : '';
  return value || null;
}
