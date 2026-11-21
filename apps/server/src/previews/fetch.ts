/**
 * Fetching one page for a link preview (docs/decisions/essentials-conversations.md EC-18, EC-19), only through the
 * outbound helper (`lib/outbound.ts`, ARCHITECTURE “Outbound requests”): its address checks happen on every address
 * the name resolves to, at connect time, with the socket pinned to a checked one. On top of that:
 *
 * - `http:` and `https:` on their standard ports only (80 and 443: a URL with any explicit port other than its
 *   scheme's default is refused), no credentials in the URL;
 * - public addresses only (`isPublicAddress`: never loopback, private, link-local, shared, metadata or reserved,
 *   IPv4 or IPv6);
 * - 5 seconds for the whole request, the first 512 KB of the answer read (the head is at the start), `text/html` or
 *   XHTML only;
 * - at most three redirects, each target checked again as if it were the link itself.
 *
 * `allowPrivate` (tests and local mocks, `WHOMBAT_OUTBOUND_ALLOW_PRIVATE`, refused in production) lifts the address
 * and port rules, as it does for every other outbound caller.
 */
import type { LinkPreview } from '@whombat/core';
import { isPublicAddress, OutboundError, type OutboundPolicy, outboundRequest } from '../lib/outbound';
import { decodePage, isHtml, previewOf } from './extract';

export const PREVIEW_DEADLINE_MS = 5_000;
export const PREVIEW_MAX_BYTES = 512 * 1024;
export const PREVIEW_MAX_REDIRECTS = 3;
export const PREVIEW_USER_AGENT = 'WhombatLinkPreview/1.0 (+https://whombat.com)';

export type PreviewFetchResult =
  | { status: 'ok'; preview: LinkPreview }
  | { status: 'none'; reason: string }
  | { status: 'failed'; reason: string };

export interface PreviewFetchOptions {
  allowPrivate?: boolean;
  /** DNS resolution (tests). */
  resolve?: OutboundPolicy['resolve'];
  deadlineMs?: number;
}

/** Why a URL may not be fetched for a preview (checked before anything connects), or null. */
export function previewUrlProblem(raw: string, allowPrivate = false): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol} is not fetched`;
  if (url.username || url.password) return 'credentials in the URL';
  // `URL.port` is empty for the scheme's default port (80 for http, 443 for https).
  if (!allowPrivate && url.port !== '') return `port ${url.port} is not a standard web port`;
  return null;
}

/** The outbound policy of a preview fetch: public addresses only, on every resolved address. */
function policyFor(options: PreviewFetchOptions): OutboundPolicy {
  const deadlineMs = options.deadlineMs ?? PREVIEW_DEADLINE_MS;
  const common: OutboundPolicy = {
    timeoutMs: deadlineMs,
    deadlineMs,
    truncateAt: PREVIEW_MAX_BYTES,
    maxBytes: PREVIEW_MAX_BYTES,
    ...(options.resolve ? { resolve: options.resolve } : {}),
  };
  if (options.allowPrivate) return { ...common, allowPrivate: true };
  return {
    ...common,
    destination: {
      schemes: ['http:', 'https:'],
      check(hostname, addresses) {
        const inside = addresses.find((a) => !isPublicAddress(a));
        if (inside !== undefined)
          throw new OutboundError(
            'private_address',
            hostname === inside
              ? `${inside} is not a public address.`
              : `${hostname} resolves to ${inside}, not a public address.`,
          );
      },
    },
  };
}

/** Fetches one page and reads its preview. Never throws: a refusal or failure is a result. */
export async function fetchPreview(
  url: string,
  options: PreviewFetchOptions = {},
): Promise<PreviewFetchResult> {
  const policy = policyFor(options);
  let current = url;
  for (let hop = 0; hop <= PREVIEW_MAX_REDIRECTS; hop++) {
    const problem = previewUrlProblem(current, options.allowPrivate);
    if (problem) return { status: 'failed', reason: `refused: ${problem}` };
    let res: Awaited<ReturnType<typeof outboundRequest>>;
    try {
      res = await outboundRequest(
        current,
        {
          method: 'GET',
          headers: {
            accept: 'text/html,application/xhtml+xml;q=0.9',
            'accept-language': 'en',
            'user-agent': PREVIEW_USER_AGENT,
          },
        },
        policy,
      );
    } catch (err) {
      const reason =
        err instanceof OutboundError
          ? `${err.refused ? 'refused' : err.reason}: ${err.message}`
          : String(err);
      return { status: 'failed', reason: reason.slice(0, 300) };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (!location) return { status: 'failed', reason: `redirect ${res.status} without a location` };
      try {
        current = new URL(location, current).toString();
      } catch {
        return { status: 'failed', reason: 'redirect to something that is not a URL' };
      }
      continue;
    }
    if (res.status < 200 || res.status >= 300) return { status: 'failed', reason: `answered ${res.status}` };
    const type = res.headers['content-type'];
    if (!isHtml(type))
      return { status: 'none', reason: `not a page (${String(type ?? 'no type').slice(0, 80)})` };
    // The link as written is what the preview belongs to, wherever it redirected.
    const preview = previewOf(url, decodePage(type, res.body));
    return preview ? { status: 'ok', preview } : { status: 'none', reason: 'the page has no title' };
  }
  return { status: 'failed', reason: `more than ${PREVIEW_MAX_REDIRECTS} redirects` };
}
