/**
 * Link previews, the pure parts (docs/decisions/essentials-conversations.md EC-17…EC-22): which links of a message get
 * a preview, and what a page says about itself.
 *
 * - Links come from core's Markdown parser, so a URL inside a code block or a code span is never one (the parser
 *   doesn't make links there), nor an image's source. Only `http:` / `https:` links, at most `LINK_PREVIEWS_MAX`,
 *   first appearance first, each once; links to this Whombat itself are left out (a room, a canvas: the app shows
 *   those better than a page title would).
 * - A page's preview is its `og:title` (else `twitter:title`, else `<title>`), `og:description` (else the
 *   `description` meta) and `og:site_name`, entities decoded; `normalizeLinkPreview` cuts each to its limit and drops
 *   a page without a title. No images, ever.
 */
import {
  type Block,
  type Inline,
  LINK_PREVIEWS_MAX,
  type LinkPreview,
  normalizeLinkPreview,
  parseMessage,
} from '@whombat/core';

/** Links worth a preview in a message's text, in order of first appearance. */
export function previewUrls(text: string, options: { ownOrigins?: readonly string[] } = {}): string[] {
  const own = new Set((options.ownOrigins ?? []).map((o) => o.toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  const visitInline = (nodes: readonly Inline[]) => {
    for (const n of nodes) {
      if (out.length >= LINK_PREVIEWS_MAX) return;
      if (n.type === 'link') {
        const url = acceptable(n.href, own);
        if (url && !seen.has(url)) {
          seen.add(url);
          out.push(url);
        }
        visitInline(n.children);
      } else if (n.type === 'strong' || n.type === 'em' || n.type === 'strike') visitInline(n.children);
    }
  };
  const visitBlocks = (blocks: readonly Block[]) => {
    for (const b of blocks) {
      if (out.length >= LINK_PREVIEWS_MAX) return;
      switch (b.type) {
        case 'paragraph':
        case 'heading':
          visitInline(b.children);
          break;
        case 'quote':
          visitBlocks(b.children);
          break;
        case 'list':
          for (const item of b.items) visitBlocks(item);
          break;
        case 'table':
          for (const row of [b.header, ...b.rows]) for (const cell of row) visitInline(cell);
          break;
        default:
          break;
      }
    }
  };
  try {
    visitBlocks(parseMessage(text));
  } catch {
    return [];
  }
  return out;
}

function acceptable(href: string, own: ReadonlySet<string>): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (own.has(url.origin.toLowerCase())) return null;
  if (href.length > 2048) return null;
  return href;
}

/** The origins of links that are this Whombat's own (`PUBLIC_URL`, the hosted UI of a managed box). */
export function ownOrigins(urls: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    try {
      out.push(new URL(u).origin);
    } catch {
      // not a URL: nothing to leave out
    }
  }
  return out;
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '’',
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
};

/** Decodes the HTML entities a title or description may hold (named ones we know, and every numeric one). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return '';
      return String.fromCodePoint(code);
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
  )) {
    const name = (m[1] as string).toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** What a page says about itself (the part of the document before `</head>`, or all of it when there is none). */
export function parsePreviewHtml(html: string): {
  title: string | null;
  description: string | null;
  siteName: string | null;
} {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = (headEnd >= 0 ? html.slice(0, headEnd) : html)
    // Scripts and comments hold no metadata but may hold text that looks like tags.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(m[0]);
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase().trim();
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1] ?? null;
  const clean = (v: string | null | undefined) => {
    if (v === null || v === undefined) return null;
    const text = decodeEntities(v.replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    return text || null;
  };
  return {
    title: clean(meta.get('og:title')) ?? clean(meta.get('twitter:title')) ?? clean(titleTag),
    description:
      clean(meta.get('og:description')) ??
      clean(meta.get('description')) ??
      clean(meta.get('twitter:description')),
    siteName: clean(meta.get('og:site_name')),
  };
}

/** The charset a page's bytes are in: the Content-Type header's, else the document's own `<meta>`, else UTF-8. */
export function pageCharset(contentType: string | undefined, bytes: Uint8Array): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const start = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const fromMeta =
    /<meta\s+charset\s*=\s*["']?([\w.:-]+)/i.exec(start)?.[1] ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w.:-]+)/i.exec(start)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

/** Decodes a page's bytes in its charset (an unknown one reads as UTF-8). */
export function decodePage(contentType: string | undefined, bytes: Uint8Array): string {
  const charset = pageCharset(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Whether a Content-Type is an HTML page. */
export function isHtml(contentType: string | undefined): boolean {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

/** A page's preview as the contract takes it, or null (no title). */
export function previewOf(url: string, html: string): LinkPreview | null {
  const page = parsePreviewHtml(html);
  return normalizeLinkPreview({ url, ...page });
}
