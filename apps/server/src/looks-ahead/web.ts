/**
 * The web for a Looks ahead check (docs/decisions/looks-ahead.md): a Brave search on the person's own key, and reading
 * one public page as text. Both through `lib/outbound.ts` (a public address only, DNS pinned, a cap on what is read),
 * GET only, nothing of the person's sent but the search words the check chose.
 *
 * Modern venue, ticketing and transit pages often ship Schema.org JSON-LD inside `<script type="application/ld+json">`
 * or render via client-side JavaScript. `readPage` always extracts JSON-LD event facts before stripping scripts, and
 * when plain HTTP returns a JS-only shell or a bot-block (403/503) and headless Chromium is available on the host, it
 * falls back to an incognito, ephemeral `--dump-dom` pass routed through a local SSRF-checked proxy (`isPublicAddress`
 * + DNS pinning on every connection, zero cookies/Vault).
 *
 * Tests replace both seams via `useAheadWebForTests` and `useAheadBrowserForTests` (refused outside `NODE_ENV=test`).
 */

import { execFile } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { htmlToText } from '../connectors/mime';
import { isPublicAddress, outboundErrorOf, outboundRequest } from '../lib/outbound';
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
/** Headless Chromium fallback timeout. */
const BROWSER_DEADLINE_MS = 12_000;
/** Redirects followed for a page (each a new checked request). */
const REDIRECTS_MAX = 3;
/** Visible text shorter than this on an HTML page with `<script>` tags looks like an unrendered JS shell. */
const JS_SHELL_TEXT_MIN = 180;

export interface WebAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** One GET (tests only replace it). */
export type WebRequest = (url: string, headers: Record<string, string>) => Promise<WebAnswer>;
/** Optional JS-rendered HTML fallback (tests may replace it). */
export type BrowserRender = (url: string) => Promise<string | null>;

const systemRequest: WebRequest = async (url, headers) => {
  const res = await outboundRequest(
    url,
    { method: 'GET', headers },
    { deadlineMs: WEB_DEADLINE_MS, timeoutMs: WEB_DEADLINE_MS, truncateAt: PAGE_MAX_BYTES },
  );
  return { status: res.status, headers: res.headers, body: res.body };
};

const overrides = new WeakMap<Services, WebRequest>();
const browserOverrides = new WeakMap<Services, BrowserRender | null>();

/** Tests only: answers for Brave and the pages without the network. Refused outside `NODE_ENV=test`. */
export function useAheadWebForTests(services: Services, request: WebRequest): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The Looks ahead web seam is for tests only.');
  overrides.set(services, request);
}

/** Tests only: replaces the headless Chromium fallback. Refused outside `NODE_ENV=test`. */
export function useAheadBrowserForTests(services: Services, render: BrowserRender | null): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The Looks ahead browser seam is for tests only.');
  browserOverrides.set(services, render);
}

function requestOf(services: Services): WebRequest {
  return overrides.get(services) ?? systemRequest;
}

/** Why a search or a page didn't work, in plain words for the turn. */
export class WebRefusal extends Error {
  /** True when the site refused/blocked automated fetching, allowing a search-result fallback citation. */
  readonly blocked: boolean;
  constructor(message: string, blocked = false) {
    super(message);
    this.blocked = blocked;
  }
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const plain = (s: unknown) => (typeof s === 'string' ? htmlToText(s).replace(/\s+/g, ' ').trim() : '');

/** A Brave search with the person's key (including extra_snippets when Brave provides them). */
export async function braveSearch(services: Services, key: string, query: string): Promise<SearchResult[]> {
  const url = `${BRAVE_SEARCH_URL}?${new URLSearchParams({
    q: query,
    count: String(SEARCH_RESULTS),
    extra_snippets: 'true',
  })}`;
  let answer: WebAnswer;
  try {
    answer = await requestOf(services)(url, { 'X-Subscription-Token': key, Accept: 'application/json' });
  } catch (err) {
    throw new WebRefusal(`The search didn’t answer: ${outboundErrorOf(err).message}`);
  }
  if (answer.status === 402 || answer.status === 429)
    throw new WebRefusal('The Brave Search key has no searches left right now.');
  if (answer.status !== 200) throw new WebRefusal(`The search answered HTTP ${answer.status}.`);
  let json: {
    web?: {
      results?: { title?: unknown; url?: unknown; description?: unknown; extra_snippets?: unknown[] }[];
    };
  };
  try {
    json = JSON.parse(answer.body.toString('utf8'));
  } catch {
    throw new WebRefusal('The search answered something that isn’t a list of results.');
  }
  return (json.web?.results ?? []).flatMap((r) => {
    const link = typeof r.url === 'string' ? httpUrl(r.url) : null;
    if (!link) return [];
    const extras = Array.isArray(r.extra_snippets)
      ? r.extra_snippets.map(plain).filter(Boolean).slice(0, 2)
      : [];
    const snippet = [plain(r.description), ...extras].filter(Boolean).join(' · ');
    return [{ title: clip(plain(r.title), 300), url: link, snippet: clip(snippet, 1200) }];
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
 * Pulls structured Event / Place / MusicEvent / SportsEvent facts from `<script type="application/ld+json">` blocks
 * before `htmlToText` strips scripts. Venue, ticketing and transit pages put exact ISO startDate, doorTime,
 * eventStatus and location here even when the visible body is rendered by client-side JS.
 */
export function extractJsonLdSummary(html: string): string {
  const lines: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || lines.length >= 12) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) visit(obj['@graph']);
    const rawType = obj['@type'];
    const types = Array.isArray(rawType) ? rawType : typeof rawType === 'string' ? [rawType] : [];
    const isEvent = types.some((t) => typeof t === 'string' && /event/i.test(t));
    if (!isEvent) return;
    const parts: string[] = [];
    if (typeof obj.name === 'string' && obj.name.trim()) parts.push(`Event: ${obj.name.trim()}`);
    if (typeof obj.startDate === 'string' && obj.startDate.trim())
      parts.push(`Starts: ${obj.startDate.trim()}`);
    if (typeof obj.doorTime === 'string' && obj.doorTime.trim()) parts.push(`Doors: ${obj.doorTime.trim()}`);
    if (typeof obj.endDate === 'string' && obj.endDate.trim()) parts.push(`Ends: ${obj.endDate.trim()}`);
    if (typeof obj.eventStatus === 'string' && obj.eventStatus.trim())
      parts.push(`Status: ${obj.eventStatus.replace(/^https?:\/\/schema\.org\//i, '').trim()}`);
    const loc = obj.location;
    if (loc && typeof loc === 'object' && !Array.isArray(loc)) {
      const l = loc as Record<string, unknown>;
      const locName = typeof l.name === 'string' ? l.name.trim() : '';
      const addr = l.address;
      const addrStr =
        typeof addr === 'string'
          ? addr.trim()
          : addr && typeof addr === 'object' && !Array.isArray(addr)
            ? [
                (addr as Record<string, unknown>).streetAddress,
                (addr as Record<string, unknown>).addressLocality,
              ]
                .filter((x): x is string => typeof x === 'string' && !!x.trim())
                .join(', ')
            : '';
      const where = [locName, addrStr].filter(Boolean).join(' · ');
      if (where) parts.push(`Location: ${where}`);
    }
    const offers = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
    if (offers && typeof offers === 'object' && !Array.isArray(offers)) {
      const avail = (offers as Record<string, unknown>).availability;
      if (typeof avail === 'string' && avail.trim())
        parts.push(`Availability: ${avail.replace(/^https?:\/\/schema\.org\//i, '').trim()}`);
    }
    if (parts.length >= 2) lines.push(parts.join(' | '));
  };
  for (const m of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = m[1]?.trim();
    if (!raw || raw.length > 200_000) continue;
    try {
      visit(JSON.parse(raw));
    } catch {
      // Malformed JSON-LD on public pages is common; ignore quietly.
    }
  }
  return lines.length ? `Structured event data:\n${lines.join('\n')}` : '';
}

function htmlToPage(url: string, body: string): Page {
  const title = plain(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '');
  const structured = extractJsonLdSummary(body);
  const textBody = htmlToText(body);
  const combined = structured ? `${structured}\n\n${textBody}`.trim() : textBody;
  return {
    url,
    title: clip(title, 300),
    text: clip(combined, PAGE_TEXT_MAX),
    links: pageLinks(body, url),
  };
}

/** Finds a local Chromium binary on the box, or null if none is installed. */
function findChromium(): string | null {
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Starts a short-lived local proxy on 127.0.0.1:0 that enforces `isPublicAddress` + DNS pinning on every CONNECT and
 * HTTP request, so headless Chromium can never reach loopback, LAN or cloud metadata addresses (SSRF-safe).
 */
async function startPublicProxy(): Promise<{ port: number; close: () => Promise<void> }> {
  const resolvePublic = async (hostname: string): Promise<string | null> => {
    const host = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return isPublicAddress(host) ? host : null;
    try {
      const addrs = await dnsLookup(host, { all: true, verbatim: true });
      if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) return null;
      return addrs[0]?.address ?? null;
    } catch {
      return null;
    }
  };
  const server = http.createServer((_req, res) => {
    // Only HTTPS via CONNECT is allowed; refuse plain HTTP subrequests.
    res.writeHead(403);
    res.end('HTTPS only');
  });
  server.on('connect', (req, clientSocket, head) => {
    const target = req.url ?? '';
    const sep = target.lastIndexOf(':');
    const host = sep > 0 ? target.slice(0, sep) : target;
    const port = sep > 0 ? Number(target.slice(sep + 1)) : 443;
    if (!host || port !== 443) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    void resolvePublic(host).then((ip) => {
      if (!ip) {
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      const upstream = net.connect({ host: ip, port: 443 }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.setTimeout(BROWSER_DEADLINE_MS, () => upstream.destroy());
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Renders one public https page with an ephemeral, incognito headless Chromium routed through `startPublicProxy`
 * (zero cookies, zero Vault, public IPs only). Returns rendered HTML or null when Chromium is unavailable or fails.
 */
async function renderWithChromium(url: string): Promise<string | null> {
  const bin = findChromium();
  if (!bin) return null;
  let profileDir: string | null = null;
  let proxy: { port: number; close: () => Promise<void> } | null = null;
  try {
    // Verify the target host resolves solely to public IPs before launching a browser.
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    const addrs = await dnsLookup(parsed.hostname, { all: true, verbatim: true });
    if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) return null;
    profileDir = await mkdtemp(join(tmpdir(), 'whombat-ahead-chrome-'));
    proxy = await startPublicProxy();
    const args = [
      '--headless=new',
      '--incognito',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      `--user-data-dir=${profileDir}`,
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      '--proxy-bypass-list=<-loopback>',
      '--virtual-time-budget=4000',
      '--dump-dom',
      url,
    ];
    const html = await new Promise<string | null>((resolve) => {
      execFile(bin, args, { timeout: BROWSER_DEADLINE_MS, maxBuffer: PAGE_MAX_BYTES }, (err, stdout) => {
        if (err || !stdout || stdout.length < 40) resolve(null);
        else resolve(stdout);
      });
    });
    return html;
  } catch {
    return null;
  } finally {
    if (proxy) await proxy.close().catch(() => undefined);
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function browserOf(services: Services): BrowserRender | null {
  if (browserOverrides.has(services)) return browserOverrides.get(services) ?? null;
  // Never spawn real Chromium during unit/int tests unless explicitly wired.
  if (services.config.NODE_ENV === 'test') return null;
  return renderWithChromium;
}

/**
 * Reads one page (`url` already allowed by the turn) as text, following a few redirects, each checked again. `allow`
 * says whether a redirect's target may be read: a page that sends the check to another site goes only where the turn
 * could have gone itself. Falls back to headless Chromium when plain HTTP returns a JS-only shell or bot-block.
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
      throw new WebRefusal(`The page didn’t answer: ${outboundErrorOf(err).message}`, true);
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
    const blockedStatus = answer.status === 403 || answer.status === 429 || answer.status === 503;
    if (blockedStatus) {
      const render = browserOf(services);
      const rendered = render ? await render(at) : null;
      if (rendered) {
        const page = htmlToPage(at, rendered);
        if (page.text.length >= 60) return page;
      }
      throw new WebRefusal(
        `The site blocked automated reading (HTTP ${answer.status}); you may rely on its search snippet only if it clearly states the fact.`,
        true,
      );
    }
    if (answer.status !== 200) throw new WebRefusal(`The page answered HTTP ${answer.status}.`);
    const type = header(answer.headers, 'content-type').toLowerCase();
    const body = answer.body.toString('utf8');
    if (type.includes('html') || (!type && /<html|<body|<p\b/i.test(body))) {
      const page = htmlToPage(at, body);
      // Plain HTML returned a tiny JS-only shell (e.g. React/Vue SPA without SSR or JSON-LD): try headless render.
      if (page.text.length < JS_SHELL_TEXT_MIN && /<script\b/i.test(body)) {
        const render = browserOf(services);
        const rendered = render ? await render(at) : null;
        if (rendered) {
          const better = htmlToPage(at, rendered);
          if (better.text.length > page.text.length) return better;
        }
      }
      return page;
    }
    if (type.startsWith('text/') || type.includes('json'))
      return { url: at, title: '', text: clip(body, PAGE_TEXT_MAX), links: [] };
    throw new WebRefusal('That isn’t a page with text (a picture or a file).');
  }
  throw new WebRefusal('The page kept sending you elsewhere.');
}
