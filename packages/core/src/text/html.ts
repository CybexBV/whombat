/**
 * HTML pages in messages (CT-149): a fenced `html` block, a raw `<!DOCTYPE html>` / `<html>` paragraph and an
 * `.html` / `text/html` attachment are shown as a preview card, the live page in a sandboxed frame with inline scripts
 * and styles, bundled runtimes and embedded assets (the client's frame, never the app's DOM).
 * These helpers only recognise and describe the markup; they never sanitise it (the sandbox is the boundary). Pure (no
 * DOM), so web and mobile share them.
 */

import { isSvgDocument } from './images.js';

/** The largest HTML page shown as a preview, in characters (a longer one is a plain code block or a download). */
export const HTML_PREVIEW_MAX = 512 * 1024;

/** A BOM, whitespace and comments before the first tag. */
const LEAD = /^﻿?\s*(?:<!--[\s\S]*?-->\s*)*/;
const DOC_START = /^(?:<!doctype\s+html\b|<html(?:[\s>]|$))/i;

/**
 * Whether `text` is an HTML document: after a BOM, whitespace and comments it starts with `<!DOCTYPE html` or an
 * `<html` tag, and it is at most {@link HTML_PREVIEW_MAX} characters. Not a validation: a malformed page just renders
 * the way a browser renders it.
 */
export function isHtmlDocument(text: string): boolean {
  if (text.length > HTML_PREVIEW_MAX) return false;
  return DOC_START.test(text.replace(LEAD, ''));
}

/** Any element tag, doctype or comment. */
const ANY_TAG = /<(?:[a-z][a-z0-9-]*(?:[\s/>]|$)|!doctype\b|!--)/i;

/**
 * Whether `text` is HTML worth a preview: a document ({@link isHtmlDocument}) or a fragment with at least one tag,
 * that is not just an SVG document (that is an image, `svg`), at most {@link HTML_PREVIEW_MAX} characters.
 */
export function isHtmlPreviewable(text: string): boolean {
  if (text.length > HTML_PREVIEW_MAX || text.trim() === '' || isSvgDocument(text)) return false;
  return isHtmlDocument(text) || ANY_TAG.test(text);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const cp =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
        ? String.fromCodePoint(cp)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Longest title {@link htmlTitle} returns, in characters. */
export const HTML_TITLE_MAX = 200;

/**
 * The page's `<title>` as plain text (entities decoded, whitespace collapsed, at most {@link HTML_TITLE_MAX}
 * characters), or null when it has none or it is empty. Only the part before `<body` (or the first `<svg`) is read,
 * so an inline SVG's own `<title>` never names the page.
 */
export function htmlTitle(html: string): string | null {
  const head = html.slice(0, HTML_PREVIEW_MAX);
  const end = head.search(/<body[\s>]|<svg[\s>]/i);
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(end < 0 ? head : head.slice(0, end));
  if (!m) return null;
  const title = decodeEntities((m[1] as string).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return null;
  const chars = [...title];
  return chars.length > HTML_TITLE_MAX ? `${chars.slice(0, HTML_TITLE_MAX - 1).join('')}…` : title;
}
