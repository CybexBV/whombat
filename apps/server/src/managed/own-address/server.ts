/**
 * What the box's own address answers besides the page (docs/decisions/own-address.md): the listener itself is the
 * direct listener made for the door (`DirectListener` with `door`); this is its part that only the own address has.
 *
 * - `/.well-known/assetlinks.json`: the contracts' statements (`BOX_ASSET_LINKS`), cached a day, before any claim check
 *   and never a redirect, so Android's verifier can read them from the box's own host.
 * - `/.well-known/apple-app-site-association`: 404. The iPhone app never names a box's host (a wildcard there would let
 *   whoever runs the parent host name the app); the build's copy isn't served here.
 * - `/robots.txt`: nothing but the well-known files.
 * - Every answer carries the page's Content-Security-Policy as a header (`contentSecurityPolicy({box: true})`): the page
 *   talks only to its own origin. No HSTS header: `.app` is preloaded.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SecureContext } from 'node:tls';
import { contentSecurityPolicy } from '@whombat/core/text';
import { BOX_ASSET_LINKS, BOX_ASSET_LINKS_MAX_AGE_S } from '@whombat/protocol/own-address';
import type { DirectDoor } from '../direct/listener';
import { CACHE_NONE, DIRECT_HEADERS, sendText } from '../direct/web';

/** The page's policy on the own address: the box build talks only to its own origin's socket. */
export const OWN_ADDRESS_POLICY = contentSecurityPolicy(
  { controlUrl: 'https://control.invalid', relayOrigins: [], box: true },
  true,
);

export const ROBOTS_TXT = 'User-agent: *\nAllow: /.well-known/\nDisallow: /\n';

const ASSET_LINKS_BODY = JSON.stringify(BOX_ASSET_LINKS);

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  cache: string,
): void {
  res.writeHead(status, {
    ...DIRECT_HEADERS,
    'content-security-policy': OWN_ADDRESS_POLICY,
    'content-type': type,
    'cache-control': cache,
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** The own address's own answers; false for everything the listener answers as on the local network. */
export function ownAddressRoutes(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (path === '/.well-known/assetlinks.json') {
    send(req, res, 200, 'application/json', ASSET_LINKS_BODY, `public, max-age=${BOX_ASSET_LINKS_MAX_AGE_S}`);
    return true;
  }
  if (path === '/.well-known/apple-app-site-association') {
    sendText(res, 404, 'Not found.');
    return true;
  }
  if (path === '/robots.txt') {
    send(req, res, 200, 'text/plain; charset=utf-8', ROBOTS_TXT, CACHE_NONE);
    return true;
  }
  return false;
}

/**
 * The own address's side of the listener: its host and certificate as the own-address state has them now. `first`
 * answers ahead of the address's own routes (the DEV device test, `device-test.ts`).
 */
export function ownAddressDoor(
  state: {
    host(): string | null;
    context(): SecureContext | null;
  },
  first?: (req: IncomingMessage, res: ServerResponse, path: string) => boolean,
): DirectDoor {
  return {
    host: () => state.host(),
    context: () => state.context(),
    routes: first
      ? (req, res, path) => first(req, res, path) || ownAddressRoutes(req, res, path)
      : ownAddressRoutes,
    policy: OWN_ADDRESS_POLICY,
  };
}
