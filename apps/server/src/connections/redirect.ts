/**
 * Where a catalog OAuth sign-in comes back to, and who this Whombat says it is (CX-12…CX-15, CX-D04): the hosted
 * UI's `{WHOMBAT_APP_URL}/connect/<catalogId>` (it hands `code`, `state` and `iss` over the session with
 * `connections.finishOAuth`, as `/connect/google` does, AG-14).
 *
 * Home Assistant takes this Whombat's own address as its `client_id` (IndieAuth: the redirect must be on the same host).
 *
 * Whombat Link (whombat-link.md LNK-16): a box control registered keeps the hosted UI's page; a box claimed on its own
 * pages returns to its own page, its own address while Link runs, else its Tailscale name. A sign-in can't come back
 * to a box without a secure address, and a client set in the image (its redirect registered on the hosted UI) can't
 * come back to any other page: those say so plainly (`returnAddressProblem`) instead of failing at the provider.
 */
import { CATALOG } from '@whombat/core';
import { type Config, managedAppOrigin } from '../config';

type RedirectConfig = Pick<Config, 'WHOMBAT_APP_URL'>;

/** The words, one place each (CLAUDE.md: short and plain). */
export const RETURN_ADDRESS_WORDS = {
  noSecure:
    'This sign-in needs a secure address for your Whombat to come back to. Turn on Whombat Link, or Tailscale with HTTPS, and try again.',
  hostedOnly:
    'This sign-in comes back to Whombat on the web, which this Whombat doesn’t use. Set up your own app for it in Settings → Connections.',
} as const;

/**
 * Why an OAuth sign-in can't come back to this Whombat now, or null when it can (LNK-16). `fixed`: the client's redirect
 * was registered on the hosted UI (a client set in the image's config), so only that page works.
 */
export function returnAddressProblem(
  config: RedirectConfig & Pick<Config, 'NODE_ENV'>,
  fixed = false,
): string | null {
  let origin: URL;
  try {
    origin = new URL(managedAppOrigin(config));
  } catch {
    return RETURN_ADDRESS_WORDS.noSecure;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(loopback && config.NODE_ENV !== 'production'))
    return RETURN_ADDRESS_WORDS.noSecure;
  if (fixed && (!config.WHOMBAT_APP_URL || new URL(config.WHOMBAT_APP_URL).origin !== origin.origin))
    return RETURN_ADDRESS_WORDS.hostedOnly;
  return null;
}

/** The hosted UI's route for an entry. */
export function managedCallbackPath(catalogId: string): string {
  return `/connect/${catalogId}`;
}

/** The origin the browser comes back to: the hosted UI. */
export function redirectOrigin(config: RedirectConfig): string {
  return managedAppOrigin(config);
}

/** The redirect URI of a catalog entry's OAuth sign-in on this Whombat. */
export function appRedirectUri(config: RedirectConfig, catalogId: string): string {
  return `${managedAppOrigin(config)}${managedCallbackPath(catalogId)}`;
}

/** Home Assistant's `client_id` (CX-12): this Whombat's own address, on the redirect's host. */
export function haClientId(config: RedirectConfig): string {
  return `${redirectOrigin(config)}/`;
}

/** Every redirect URI an MCP sign-in may use (one per `mcp_oauth` entry): a registration covers them all. */
export function mcpRedirectUris(config: RedirectConfig): string[] {
  return CATALOG.filter((e) => e.signIn.some((m) => m.kind === 'mcp_oauth')).map((e) =>
    appRedirectUri(config, e.id),
  );
}
