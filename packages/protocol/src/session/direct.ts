/**
 * The box's direct ways in (Whombat hermes-engine.md HE-50, HE-51; CT-1252): where a client reaches the box without
 * the relay — its addresses on the local network and, once an owner signed it in, its Tailscale name.
 *
 * A client learns the ways in every `welcome` on the `app` channel (`Welcome.direct`), keeps them with the box, and the
 * next time tries them first, in order, before the relay (`directRoutesFor`). The outer step on a route is
 * `@whombat/protocol/direct` (`DirectHello`); the session inside is the same as through the relay.
 */
import { z } from 'zod';
import { DIRECT_PATH } from '../direct.js';

/* The ways in (CT-1252) ------------------------------------------------------------------------------------------ */

/** An IPv4 or IPv6 address, without a prefix length. */
export const IpAddress = z.string().regex(/^[0-9A-Fa-f:.]{2,45}$/);

/** `lan`: the box's address on the local network (plain `ws://` and `http://`); `tailscale`: its Tailscale name (TLS). */
export const DIRECT_WAYS = ['lan', 'tailscale'] as const;
export const DirectWay = z.enum(DIRECT_WAYS);
export type DirectWay = z.infer<typeof DirectWay>;

/** A TCP port. */
export const DirectPortNumber = z.number().int().min(1).max(65_535);

/**
 * The box's name in the tailnet (MagicDNS, `whombat-r7m4.tail1234.ts.net`): lower-case labels, without the trailing
 * dot.
 */
export const TailscaleName = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
export type TailscaleName = z.infer<typeof TailscaleName>;

/** A host in a URL: a name, an IPv4 address, or an IPv6 address in brackets. */
const URL_HOST = '([a-z0-9.-]+|\\[[0-9A-Fa-f:.]+\\])';

/** Where a client opens the WebSocket: `ws://<address>:<port>/v1/direct` (local network), `wss://<name>:<port>/v1/direct`. */
export const DirectSocketUrl = z
  .string()
  .max(300)
  .regex(new RegExp(`^wss?:[/][/]${URL_HOST}(:[0-9]{1,5})?${DIRECT_PATH.replaceAll('/', '[/]')}$`));
export type DirectSocketUrl = z.infer<typeof DirectSocketUrl>;

/** The page the box serves on a way, for a browser: `http://<address>:<port>/` or `https://<name>:<port>/`. */
export const DirectWebUrl = z
  .string()
  .max(300)
  .regex(new RegExp(`^https?:[/][/]${URL_HOST}(:[0-9]{1,5})?[/]$`));
export type DirectWebUrl = z.infer<typeof DirectWebUrl>;

/**
 * One way to the box: the socket a client opens and the page a browser opens there. A local-network route is plain
 * (`ws://`, `http://`; the session inside is still end-to-end encrypted, but a browser on that page has no secure
 * context, so what needs one — passkeys, notifications, the clipboard — says it isn't available there); a Tailscale
 * route is TLS with the name's certificate (`wss://`, `https://`).
 */
export const DirectRoute = z.object({
  way: DirectWay,
  socket: DirectSocketUrl,
  web: DirectWebUrl,
});
export type DirectRoute = z.infer<typeof DirectRoute>;

export const DIRECT_LAN_ADDRESSES_MAX = 8;
export const DIRECT_ROUTES_MAX = 12;

/**
 * The box's direct ways in, as of this session (`Welcome.direct`). `port`: the direct listener's port. `lan`: its
 * addresses on the local network (IPv4 first). `tailscale`: its Tailscale name while Tailscale is on (null otherwise).
 * `routes`: every way, best first — local-network addresses, then the Tailscale name; empty when the box takes no direct
 * connections right now.
 */
export const DirectAddresses = z.object({
  port: DirectPortNumber,
  lan: z.array(IpAddress).max(DIRECT_LAN_ADDRESSES_MAX),
  tailscale: TailscaleName.nullable(),
  routes: z.array(DirectRoute).max(DIRECT_ROUTES_MAX),
});
export type DirectAddresses = z.infer<typeof DirectAddresses>;

/**
 * The routes a client tries, in order. `secureOnly`: a page with a secure context (an `https://` page, such as the
 * hosted web app or the box's own Tailscale page) may only open `wss://` sockets, so it keeps the Tailscale routes;
 * Android and a page served over plain `http://` try them all.
 */
export function directRoutesFor(
  addresses: DirectAddresses | null | undefined,
  options: { secureOnly: boolean },
): DirectRoute[] {
  if (!addresses) return [];
  return addresses.routes.filter((r) => !options.secureOnly || r.socket.startsWith('wss://'));
}
