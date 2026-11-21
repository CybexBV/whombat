/**
 * Finding a Custom connection's logo (docs/decisions/connection-looks.md): an SVG from an address the assistant gives,
 * or one Whombat finds itself from the service's own sources — the MCP server's own icons, then the SVG icon the
 * service's website names. Every fetch goes through `lib/outbound.ts` (public https only, no redirects, a size cap)
 * without the connection's credentials, and every SVG is turned into shapes (`svg.ts`) before anything keeps it.
 */
import { catalogEntry, resolveMcpUrl, type SignInKind, type ThingLogo } from '@whombat/core';
import { connectionsFor } from '../../connections/pool';
import type { CatalogConnectionRow } from '../../connections/types';
import { OutboundError, outboundRequest } from '../../lib/outbound';
import type { Services } from '../../services';
import { svgToLogo } from './svg';

/** The largest SVG Whombat reads. */
export const SVG_MAX_BYTES = 512 * 1024;
/** The largest web page read for its icon link. */
const PAGE_MAX_BYTES = 512 * 1024;
const DEADLINE_MS = 8_000;

export type LogoFound = { ok: true; logo: ThingLogo; from: string } | { ok: false; message: string };

const policy = (services: Services, maxBytes: number) => ({
  allowPrivate: services.config.WHOMBAT_OUTBOUND_ALLOW_PRIVATE,
  maxBytes,
  deadlineMs: DEADLINE_MS,
});

/** An SVG's text from a `data:` address. */
function dataSvg(address: string): string | null {
  const m = /^data:image\/svg\+xml(;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(address);
  if (!m) return null;
  const body = m[3] ?? '';
  try {
    return m[2] ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
  } catch {
    return null;
  }
}

/** The logo at an https address (or a `data:` SVG): fetched, checked to be an SVG and turned into shapes. */
export async function logoFromAddress(services: Services, address: string): Promise<LogoFound> {
  const inline = address.startsWith('data:') ? dataSvg(address) : null;
  if (address.startsWith('data:') && inline === null)
    return { ok: false, message: 'That address isn’t an SVG.' };
  let text = inline;
  if (text === null) {
    let res: Awaited<ReturnType<typeof outboundRequest>>;
    try {
      res = await outboundRequest(
        address,
        { method: 'GET', headers: { accept: 'image/svg+xml,*/*;q=0.5', 'user-agent': 'Whombat' } },
        policy(services, SVG_MAX_BYTES),
      );
    } catch (err) {
      if (err instanceof OutboundError && err.refused)
        return { ok: false, message: 'Whombat may only fetch a logo from a public https address.' };
      if (err instanceof OutboundError && err.reason === 'too_large')
        return { ok: false, message: 'That logo is larger than Whombat reads (512 KB).' };
      return { ok: false, message: 'Whombat couldn’t fetch that logo.' };
    }
    if (res.status >= 300 && res.status < 400)
      return { ok: false, message: 'That address sends Whombat elsewhere: give the address it ends at.' };
    if (res.status !== 200) return { ok: false, message: `That address answered ${res.status}.` };
    const type = String(res.headers['content-type'] ?? '').toLowerCase();
    if (/^image\/(png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon|avif)/.test(type))
      return { ok: false, message: 'That logo is a picture, not an SVG: Whombat only uses SVG logos.' };
    text = res.body.toString('utf8');
  }
  const out = svgToLogo(text);
  return out.ok ? { ok: true, logo: out.logo, from: address.startsWith('data:') ? 'data' : address } : out;
}

/** The SVG icons an MCP server names for itself (`serverInfo.icons`), on its own site or inline. */
export function mcpIconAddresses(info: Record<string, unknown> | null, serverUrl: string): string[] {
  const icons = Array.isArray(info?.icons) ? (info.icons as unknown[]) : [];
  let origin: string | null = null;
  try {
    origin = new URL(serverUrl).hostname;
  } catch {
    origin = null;
  }
  const site = origin ? siteOf(origin) : null;
  const scored: { src: string; score: number }[] = [];
  for (const icon of icons) {
    if (!icon || typeof icon !== 'object') continue;
    const { src, mimeType, sizes, theme } = icon as Record<string, unknown>;
    if (typeof src !== 'string') continue;
    const svg =
      mimeType === 'image/svg+xml' ||
      /^data:image\/svg\+xml/i.test(src) ||
      /\.svg(\?|$)/i.test(src) ||
      (Array.isArray(sizes) && sizes.includes('any'));
    if (!svg) continue;
    if (!src.startsWith('data:')) {
      // The server's own site only: an icon elsewhere could track who looks at it.
      let host: string;
      try {
        const u = new URL(src);
        if (u.protocol !== 'https:') continue;
        host = u.hostname;
      } catch {
        continue;
      }
      if (!site || siteOf(host) !== site) continue;
    }
    // A light-background icon first: it is drawn on the app's surface.
    scored.push({ src, score: theme === 'dark' ? 1 : 0 });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.src);
}

/** The site a host belongs to: `mcp.linear.app` → `linear.app` (the last two labels, three for `co.uk`-like names). */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const second = labels[labels.length - 2] as string;
  const keep = second.length <= 3 && (labels[labels.length - 1] as string).length === 2 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** The SVG icon a web page names (`<link rel="icon" type="image/svg+xml" href>`, or any icon link ending in `.svg`). */
export function svgIconLinks(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (!/\bicon\b|mask-icon/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (type !== 'image/svg+xml' && !/\.svg(\?|#|$)/i.test(href)) continue;
    try {
      out.push(new URL(href, base).toString());
    } catch {
      // Not an address.
    }
  }
  return out;
}

/** The SVG icons of the service's own website: the address's host, then the site above it. */
async function siteIcons(services: Services, address: string): Promise<string[]> {
  let host: string;
  try {
    host = new URL(address).hostname;
  } catch {
    return [];
  }
  const hosts = [...new Set([host, siteOf(host)])];
  const out: string[] = [];
  for (const h of hosts) {
    const base = `https://${h}/`;
    try {
      const res = await outboundRequest(
        base,
        { method: 'GET', headers: { accept: 'text/html', 'user-agent': 'Whombat' } },
        { ...policy(services, PAGE_MAX_BYTES), truncateAt: PAGE_MAX_BYTES },
      );
      if (res.status === 200) out.push(...svgIconLinks(res.body.toString('utf8'), base));
    } catch {
      // No website there.
    }
    out.push(`https://${h}/favicon.svg`);
  }
  return [...new Set(out)];
}

/** The MCP server's own icons, when the connection is one. */
async function mcpIcons(services: Services, row: CatalogConnectionRow): Promise<string[]> {
  if (row.catalogId !== 'custom_mcp') return [];
  const entry = catalogEntry(row.catalogId);
  const url = entry ? resolveMcpUrl(entry, row.fields, row.signIn as SignInKind) : null;
  if (!url) return [];
  const service = connectionsFor(services);
  const info = await service.pool.serverInfo(service.target(row, url)).catch(() => null);
  return mcpIconAddresses(info, url);
}

/**
 * The logo Whombat finds itself for a Custom connection, from the service's own sources; null when none of them has an
 * SVG it can draw.
 */
export async function findOwnLogo(services: Services, row: CatalogConnectionRow): Promise<LogoFound | null> {
  const address = row.catalogId === 'custom_mcp' ? (resolveMcpAddress(row) ?? row.baseUrl) : row.baseUrl;
  const candidates = [...(await mcpIcons(services, row)), ...(await siteIcons(services, address))];
  for (const c of candidates.slice(0, 8)) {
    const found = await logoFromAddress(services, c).catch(() => null);
    if (found?.ok) return { ...found, from: found.from === 'data' ? 'mcp' : found.from };
  }
  return null;
}

function resolveMcpAddress(row: CatalogConnectionRow): string | null {
  const entry = catalogEntry(row.catalogId);
  return entry ? resolveMcpUrl(entry, row.fields, row.signIn as SignInKind) : null;
}
