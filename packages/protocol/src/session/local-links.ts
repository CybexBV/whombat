/**
 * Links and QR codes the box makes (Whombat hermes-engine.md HE-60, CT-1304): a way to add a device of your own —
 * without control, the relay or the hosted app (since 3.0 the only kind: invites and re-enrolment went, CT-1505). A link is the box's own page on its best direct way, with what the new device needs in the fragment (never sent
 * to a server):
 *
 *     http://192.168.1.20:4480/add-device#s=<secret>&p=<PeerId>&l=http://192.168.1.20:4480/&t=https://whombat-r7m4.tail1a2b3.ts.net:4480/
 *
 * - the path says what it is (`LOCAL_LINK_PATHS`): `/add-device` (`enroll.link.accept`);
 * - `s`: the one-time secret (≥ 128 bits, base64url); the box keeps its hash only;
 * - `p`: the box's PeerId, which the new device pins for the Noise handshake. The link came from someone already let in
 *   over a session to this box, so it vouches for the box better than the page itself can;
 * - `l` and `t`, in order, best first: the page on each way (`DirectRoute.web`; `l` the local network, `t` Tailscale).
 *   The socket is the same address with `ws`/`wss` and `DIRECT_PATH`. The link opens on the first one.
 *
 * - `o` (4.3; Whombat own-address.md): the box's own address, `https://<label>.box.whombat.app/`, when it has one. It
 *   comes before the ways and the link opens on it; the ways still follow, so an app before 4.3 (which ignores `o`) uses
 *   them. A link with an own address may carry no way at all; such a link only opens in 4.3 and later.
 *
 * A browser opens the link and reads its own `location.href`; the Android app scans the QR code (the same link) and tries
 * the ways in order. Both read it with `parseLocalLink`; the box writes it with `localLinkFor` from its current direct
 * ways (`DirectAddresses.routes`). Unknown fragment keys are ignored, so a later minor can add one.
 */
import { z } from 'zod';
import { DIRECT_PATH } from '../direct.js';
import { OwnAddressHost } from '../own-address.js';
import { PeerIdString } from './common.js';
import { DIRECT_ROUTES_MAX, DirectRoute, type DirectWay, DirectWebUrl } from './direct.js';

export const LOCAL_LINK_KINDS = ['device'] as const;
export const LocalLinkKind = z.enum(LOCAL_LINK_KINDS);
export type LocalLinkKind = z.infer<typeof LocalLinkKind>;

/** The page's path for each kind. */
export const LOCAL_LINK_PATHS: Readonly<Record<LocalLinkKind, string>> = Object.freeze({
  device: '/add-device',
});

/** The longest link (twelve routes fit with room to spare; a QR code of it is still readable on a screen). */
export const LOCAL_LINK_MAX = 2_000;

/** A link's one-time secret: ≥ 128 bits as base64url (`DeviceLinkSecret`'s shape). */
export const LocalLinkSecret = z
  .string()
  .min(22)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/** What a link carries. */
export interface LocalLinkParts {
  kind: LocalLinkKind;
  /** The box's PeerId: pin it. */
  appliance: string;
  secret: string;
  /** The ways to the box, best first (at least one unless `own` is there). */
  routes: DirectRoute[];
  /** The box's own address, `https://<host>/` (4.3); `parseLocalLink` gives null when the link has none. */
  own?: string | null;
}

/** The own-address URL a link carries: `https://<host>/`, an own-address host, nothing else. */
function isOwnUrl(url: string): boolean {
  const m = /^https:[/][/]([a-z0-9.-]+)[/]$/.exec(url);
  return m !== null && OwnAddressHost.safeParse(m[1]).success;
}

const ROUTE_KEY: Readonly<Record<DirectWay, string>> = { lan: 'l', tailscale: 't' };
const WAY_OF_KEY: Readonly<Record<string, DirectWay>> = { l: 'lan', t: 'tailscale' };

/** The route on a page: the socket is the page's address with `ws`/`wss` and `DIRECT_PATH`. */
function routeOfWeb(way: DirectWay, web: string): DirectRoute | null {
  if (!DirectWebUrl.safeParse(web).success) return null;
  const route = { way, socket: `${web.replace(/^http/, 'ws')}${DIRECT_PATH.slice(1)}`, web };
  return DirectRoute.safeParse(route).success ? route : null;
}

/**
 * The link for `parts` (the box's side). Throws when there is no route, more than `DIRECT_ROUTES_MAX`, a route whose
 * socket isn't its page's address, or a PeerId or secret outside the contract: a box without a direct way makes no link.
 */
export function localLinkFor(parts: LocalLinkParts): string {
  const { kind, appliance, secret, routes } = parts;
  const own = parts.own ?? null;
  if (!PeerIdString.safeParse(appliance).success) throw new Error('not a PeerId');
  if (!LocalLinkSecret.safeParse(secret).success) throw new Error('not a link secret');
  if (own !== null && !isOwnUrl(own)) throw new Error('not an own address');
  if ((routes.length === 0 && own === null) || routes.length > DIRECT_ROUTES_MAX)
    throw new Error('no route for a link');
  for (const r of routes) {
    const derived = routeOfWeb(r.way, r.web);
    if (!derived || derived.socket !== r.socket) throw new Error('a route a link cannot carry');
  }
  const base = own ?? (routes[0] as DirectRoute).web;
  const ways = [
    ...(own === null ? [] : [`o=${own}`]),
    ...routes.map((r) => `${ROUTE_KEY[r.way]}=${r.web}`),
  ].join('&');
  const link = `${base.slice(0, -1)}${LOCAL_LINK_PATHS[kind]}#s=${secret}&p=${appliance}&${ways}`;
  if (link.length > LOCAL_LINK_MAX) throw new Error('link too long');
  return link;
}

const BASE = /^(https?:[/][/][^/?#]+)([/][a-z-]+)[/]?$/;

/**
 * A link as a browser's `location.href` has it, as pasted, or as scanned (the client's side), or null: the path must be a
 * kind's, the fragment must carry one `s`, one `p`, at most one `o` (an own address) and up to `DIRECT_ROUTES_MAX` ways
 * that are pages on a way, at least one unless there is an `o`. Percent-encoded fragments read the same.
 */
export function parseLocalLink(text: string): (LocalLinkParts & { own: string | null }) | null {
  const trimmed = text.trim();
  if (trimmed.length > LOCAL_LINK_MAX) return null;
  const hash = trimmed.indexOf('#');
  if (hash < 0) return null;
  const base = BASE.exec(trimmed.slice(0, hash));
  if (!base || !DirectWebUrl.safeParse(`${base[1]}/`).success) return null;
  const kind = LOCAL_LINK_KINDS.find((k) => LOCAL_LINK_PATHS[k] === base[2]);
  if (!kind) return null;
  const fragment = fragmentPairs(trimmed.slice(hash + 1));
  if (!fragment) return null;
  const secrets = fragment.filter(([k]) => k === 's').map(([, v]) => v);
  const peers = fragment.filter(([k]) => k === 'p').map(([, v]) => v);
  if (secrets.length !== 1 || peers.length !== 1) return null;
  const secret = secrets[0] as string;
  const appliance = peers[0] as string;
  if (!LocalLinkSecret.safeParse(secret).success || !PeerIdString.safeParse(appliance).success) return null;
  const routes: DirectRoute[] = [];
  for (const [key, value] of fragment) {
    const way = WAY_OF_KEY[key];
    if (!way) continue;
    const route = routeOfWeb(way, value);
    if (!route) return null;
    routes.push(route);
  }
  const owns = fragment.filter(([k]) => k === 'o').map(([, v]) => v);
  if (owns.length > 1 || (owns.length === 1 && !isOwnUrl(owns[0] as string))) return null;
  const own = owns[0] ?? null;
  if ((routes.length === 0 && own === null) || routes.length > DIRECT_ROUTES_MAX) return null;
  return { kind, appliance, secret, routes, own };
}

/**
 * `k=v&k=v` in order, percent-decoded, hand-parsed (no `URLSearchParams`, so it runs the same on Hermes); null when a
 * value doesn't decode.
 */
function fragmentPairs(text: string): [string, string][] | null {
  const pairs: [string, string][] = [];
  for (const part of text.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    try {
      const key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
      const value = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1));
      pairs.push([key, value]);
    } catch {
      return null;
    }
  }
  return pairs;
}

/** A link the box made (`parseLocalLink` accepts it). */
export const LocalLink = z
  .string()
  .max(LOCAL_LINK_MAX)
  .refine((s) => parseLocalLink(s) !== null, 'not a link the box makes');
export type LocalLink = z.infer<typeof LocalLink>;
