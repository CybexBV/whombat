/**
 * Tailscale for This Whombat (Whombat hermes-engine.md HE-51; CT-1253, CT-1254): Tailscale runs on the box, off until
 * an owner turns it on and signs in with Tailscale's own login link (Settings → This Whombat). The manager drives it
 * (`@whombat/control-contracts/local` `MANAGER_PATHS.tailscale*`, Go `local.Tailscale*`); the runtime hands the same
 * `TailscaleStatus` to owners through `host.tailscale`, `.on`, `.off` and `.signIn`. While it is on, the box's Tailscale
 * name is one of its direct ways in (`DirectAddresses.tailscale`). Kinds and states cross the wire, never words (HD-11):
 * the app makes the words.
 */
import { AccountId } from '@whombat/core/ids';
import { z } from 'zod';
import { IpAddress, TailscaleName } from './direct.js';
import { hostTextSchema } from './hardware.js';

/* Tailscale for This Whombat (CT-1253) --------------------------------------------------------------------------- */

/**
 * - `off`: not running (an owner hasn't turned it on, or turned it off);
 * - `starting`: turned on, Tailscale is starting or making a login link;
 * - `needs_sign_in`: an owner signs in with `loginUrl` (Tailscale's own page); also after the box's key expired;
 * - `needs_approval`: signed in, the tailnet's admin must approve this device in Tailscale;
 * - `on`: in the tailnet as `name`, reachable at `addresses`;
 * - `error`: it can't run (`problem`).
 */
export const TAILSCALE_STATES = [
  'off',
  'starting',
  'needs_sign_in',
  'needs_approval',
  'on',
  'error',
] as const;
export const TailscaleState = z.enum(TAILSCALE_STATES);
export type TailscaleState = z.infer<typeof TailscaleState>;

/**
 * Why Tailscale can't run: `not_running` (its service on the box stopped), `unreachable` (the box can't reach
 * Tailscale), `failed` (anything else; the box's log says what).
 */
export const TAILSCALE_PROBLEMS = ['not_running', 'unreachable', 'failed'] as const;
export const TailscaleProblem = z.enum(TAILSCALE_PROBLEMS);
export type TailscaleProblem = z.infer<typeof TailscaleProblem>;

/**
 * Tailscale's login link for this box (`https://login.tailscale.com/a/…`), opened by the owner in a browser; with a login
 * server of the owner's own (1.1), a link on that server (`http://` when the server is), which an app opens only when
 * `tailscaleLoginUrlTrusted`.
 */
export const TailscaleLoginUrl = z
  .string()
  .min(12)
  .max(500)
  .regex(/^https?:[/][/][\x21-\x7e]+$/);

export const TAILSCALE_ADDRESSES_MAX = 4;

/* Tailscale's own login server (1.1, CT-1306; Whombat hermes-engine.md HE-64) ---------------------------------------- */

/** The longest login server URL. */
export const TAILSCALE_LOGIN_SERVER_MAX = 300;

/**
 * Another coordination server than Tailscale's own — Headscale, or a company's — as `tailscale up --login-server` takes
 * it: `http://` or `https://`, a host name, an IPv4 address or an IPv6 address in brackets, an optional port and path; no
 * user name or password, query or fragment, and no character a command line could misread. Normalized
 * (`normalizeTailscaleLoginServer`): scheme and host lower-case, no trailing slash. Absent (`null` in an op's input)
 * means Tailscale's own. Plain `http://` is allowed for a server on the owner's network (Tailscale's control protocol is
 * encrypted inside it); the app says so.
 */
export const TailscaleLoginServer = z
  .string()
  .max(TAILSCALE_LOGIN_SERVER_MAX)
  .regex(
    /^https?:[/][/]([a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(:[0-9]{1,5})?([/][A-Za-z0-9._~-]+)*$/,
  );
export type TailscaleLoginServer = z.infer<typeof TailscaleLoginServer>;

/**
 * Why a typed login server can't be used: `invalid` (not a web address), `scheme` (not `http://` or `https://`),
 * `credentials` (a user name or password in it), `query` (`?…` or `#…`), `host`, `port` (outside 1–65535), `path` (a
 * character Whombat doesn't pass on). Kinds; the app makes the words.
 */
export const TAILSCALE_LOGIN_SERVER_PROBLEMS = [
  'invalid',
  'scheme',
  'credentials',
  'query',
  'host',
  'port',
  'path',
] as const;
export type TailscaleLoginServerProblem = (typeof TAILSCALE_LOGIN_SERVER_PROBLEMS)[number];

/**
 * A typed login server in its normal form (`TailscaleLoginServer`), or why not: trimmed, scheme and host lower-case,
 * trailing slashes dropped (`HTTPS://HS.Example.org:8080/` → `https://hs.example.org:8080`). Hand-parsed (no `URL`, so it
 * runs the same on Hermes).
 */
export function normalizeTailscaleLoginServer(
  raw: string,
): { ok: true; value: TailscaleLoginServer } | { ok: false; problem: TailscaleLoginServerProblem } {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):[/][/]([^/?#]*)([^?#]*)([?#].*)?$/.exec(raw.trim());
  if (!m) return { ok: false, problem: 'invalid' };
  const scheme = (m[1] as string).toLowerCase();
  const authority = m[2] as string;
  const path = (m[3] as string).replace(/[/]+$/, '');
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, problem: 'scheme' };
  if (authority.includes('@')) return { ok: false, problem: 'credentials' };
  if (m[4] !== undefined) return { ok: false, problem: 'query' };
  const hp = /^([^:[\]]+|\[[^\]]+\])(?::([^:]*))?$/.exec(authority);
  if (!hp) return { ok: false, problem: 'host' };
  const port = hp[2];
  if (port !== undefined && (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535))
    return { ok: false, problem: 'port' };
  const origin = `${scheme}://${(hp[1] as string).toLowerCase()}${port !== undefined ? `:${port}` : ''}`;
  if (!TailscaleLoginServer.safeParse(origin).success) return { ok: false, problem: 'host' };
  const parsed = TailscaleLoginServer.safeParse(`${origin}${path}`);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: 'path' };
}

/** Scheme and authority of an absolute `http(s)` URL, hand-parsed. */
const URL_ORIGIN = /^(https?):[/][/]([^/?#]+)/i;

/** An authority without the scheme's default port, lower-case. */
function plainAuthority(scheme: string, authority: string): string {
  const a = authority.toLowerCase();
  const port = scheme === 'https' ? ':443' : ':80';
  return a.endsWith(port) ? a.slice(0, -port.length) : a;
}

/**
 * Whether an app may open a login link: on the login server's own origin, or on Tailscale's (`https://*.tailscale.com`)
 * when the box uses Tailscale's own server. Anything else is not shown.
 */
export function tailscaleLoginUrlTrusted(loginUrl: string, loginServer: string | null | undefined): boolean {
  const url = URL_ORIGIN.exec(loginUrl);
  if (!url || (url[2] as string).includes('@')) return false;
  const scheme = (url[1] as string).toLowerCase();
  const authority = plainAuthority(scheme, url[2] as string);
  if (!loginServer) return scheme === 'https' && /^([a-z0-9-]+[.])*tailscale[.]com$/.test(authority);
  const server = URL_ORIGIN.exec(loginServer);
  if (!server) return false;
  const serverScheme = (server[1] as string).toLowerCase();
  return scheme === serverScheme && authority === plainAuthority(serverScheme, server[2] as string);
}

/**
 * Tailscale on the box (`tailscaleStatusValid` says what the schema can't): `loginUrl` only while `needs_sign_in` (null
 * while Tailscale makes one); `name`, `addresses`, `tailnet` and `https` only while `on` (`name` set; `addresses` the
 * box's `100.x.y.z` and `fd7a:115c:a1e0::…`; `tailnet` the tailnet's name as Tailscale shows it; `https` whether the box
 * has a certificate for `name`, which needs HTTPS turned on in the tailnet's DNS settings — without it browsers can't
 * open the Tailscale page, the Android app still connects); `problem` exactly while `error`. `loginServer` (1.1,
 * CT-1306) in every state: the coordination server the box signs in to; absent for Tailscale's own.
 */
export const TailscaleStatus = z.object({
  state: TailscaleState,
  loginUrl: TailscaleLoginUrl.nullable(),
  name: TailscaleName.nullable(),
  addresses: z.array(IpAddress).max(TAILSCALE_ADDRESSES_MAX),
  tailnet: hostTextSchema(120).nullable(),
  https: z.boolean(),
  problem: TailscaleProblem.nullable(),
  loginServer: TailscaleLoginServer.optional(),
});
export type TailscaleStatus = z.infer<typeof TailscaleStatus>;

/**
 * What the schema can't say about a `TailscaleStatus` (CT-1253): the fields each state has, and (1.1) a login link on the
 * login server's origin, or on Tailscale's without one (`tailscaleLoginUrlTrusted`).
 */
export function tailscaleStatusValid(s: TailscaleStatus): boolean {
  if (s.state !== 'needs_sign_in' && s.loginUrl !== null) return false;
  if (s.loginUrl !== null && !tailscaleLoginUrlTrusted(s.loginUrl, s.loginServer)) return false;
  if ((s.state === 'on') !== (s.name !== null)) return false;
  if (s.state !== 'on' && (s.addresses.length > 0 || s.tailnet !== null || s.https)) return false;
  return (s.state === 'error') === (s.problem !== null);
}

/** Tailscale while it is off: what a box that never turned it on reports. */
export const TAILSCALE_OFF: TailscaleStatus = Object.freeze({
  state: 'off',
  loginUrl: null,
  name: null,
  addresses: [],
  tailnet: null,
  https: false,
  problem: null,
}) as TailscaleStatus;

/** How often an app asks `host.tailscale` again while it is `starting`, `needs_sign_in` or `needs_approval`. */
export const TAILSCALE_POLL_MS = 2_000;

/* The session ops (CT-1254) ------------------------------------------------------------------------------ */

export const HostTailscaleInput = z.strictObject({});
/**
 * Tailscale on the box. `tailscale` null with a `reason`: `not_managed` (no manager to ask: a development runtime) or
 * `unavailable` (it didn't answer).
 */
export const HostTailscaleOutput = z.object({
  tailscale: TailscaleStatus.nullable(),
  reason: z.enum(['not_managed', 'unavailable']).optional(),
});
export type HostTailscaleOutput = z.infer<typeof HostTailscaleOutput>;

/**
 * Turn Tailscale on: it comes back as it was signed in, or answers `starting` / `needs_sign_in` with the login link
 * (poll `host.tailscale` every `TAILSCALE_POLL_MS` until it is `on`). `loginServer` (1.1, CT-1306; HE-64): absent keeps
 * the one the box uses; a server (`TailscaleLoginServer`, normalized) or `null` (Tailscale's own) that differs from it
 * signs the box out of its tailnet first and starts a fresh sign-in there — clients connected over Tailscale lose that
 * way, so the app asks before it changes one. Owners only, like every Tailscale op.
 */
export const HostTailscaleOnInput = z.strictObject({
  loginServer: TailscaleLoginServer.nullable().optional(),
});
export type HostTailscaleOnInput = z.infer<typeof HostTailscaleOnInput>;
/**
 * Turn Tailscale off. `signOut`: also sign the box out of the tailnet (it needs a new sign-in to come back). Clients
 * connected over Tailscale lose that connection and continue over the relay or the local network.
 */
export const HostTailscaleOffInput = z.strictObject({ signOut: z.boolean().optional() });
/** A fresh login link: sign in again (an expired key, an expired link) or as someone else. */
export const HostTailscaleSignInInput = z.strictObject({});
/** The status after the change (the same shape as `host.tailscale`'s). */
export const HostTailscaleChangeOutput = z.object({ tailscale: TailscaleStatus });
export type HostTailscaleChangeOutput = z.infer<typeof HostTailscaleChangeOutput>;

/**
 * Why a Tailscale op refused, in `error.details.code` (the session `ErrorCode` in brackets) and as `LocalError.code`
 * from the manager: `tailscale.unavailable` (no manager, or it didn't answer: `unavailable`), `tailscale.busy` (a change
 * is running: `conflict`).
 */
export const TAILSCALE_ERROR_CODES = ['tailscale.unavailable', 'tailscale.busy'] as const;
export const TailscaleErrorCode = z.enum(TAILSCALE_ERROR_CODES);
export type TailscaleErrorCode = z.infer<typeof TailscaleErrorCode>;

/* The signed appliance log (1.1, CT-1306) ---------------------------------------------------------------------------- */

/**
 * Payload of the signed `tailscale.on`, `tailscale.off` and `tailscale.sign_in` appliance events: the owner who acted
 * and where the box signs in — never a login link, key or certificate. `loginServer`: the server after the change (null:
 * Tailscale's own); `loginServerChanged`: an `on` that moved the box to another server (and so out of its tailnet);
 * `signOut`: an `off` that also left the tailnet.
 */
export const TailscaleAuditPayload = z.object({
  byAccountId: AccountId,
  loginServer: TailscaleLoginServer.nullable(),
  loginServerChanged: z.boolean(),
  signOut: z.boolean(),
});
export type TailscaleAuditPayload = z.infer<typeof TailscaleAuditPayload>;
