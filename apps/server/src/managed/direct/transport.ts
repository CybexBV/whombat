/**
 * How a session reached the box (direct-connection.md DC-10), and what its page can do. A session through the relay
 * comes from the hosted app or a native app; a direct one from a native app (no `Origin`) or from a page this box served
 * — over plain HTTP on the local network (not a secure context), over HTTPS on the Tailscale name, or on loopback in
 * development. The server answers what a page can't do there honestly instead of starting a ceremony that can only fail.
 */
import type { DirectNetwork } from './network';

export type SessionTransport =
  | { via: 'relay' }
  | {
      via: 'direct';
      network: DirectNetwork;
      tls: boolean;
      /** The browser page that opened the session; null for a native app. */
      page: { origin: string; secureContext: boolean } | null;
      /** At the box's own address: the host the session arrived at (its current one, or the one it is leaving). */
      host?: string;
    };

/**
 * The own-address host a session arrived at: a door session's TLS name, else its page's host (the listener let only a
 * page of that host in). Null for every other way in.
 */
export function arrivalHost(transport: SessionTransport | undefined): string | null {
  if (transport?.via !== 'direct' || transport.network !== 'door') return null;
  if (transport.host) return transport.host;
  if (!transport.page) return null;
  try {
    const url = new URL(transport.page.origin);
    return url.protocol === 'https:' && !url.port ? url.hostname : null;
  } catch {
    return null;
  }
}

/**
 * What a browser page needs a secure context for (https, or localhost), so a page the box serves over plain HTTP on the
 * local network goes without (DC-11). The app says so where each would be; everything else — the session, its end-to-end
 * encryption, uploads, downloads — works the same.
 *
 * - `passkeys`: WebAuthn. Also off on the Tailscale page: a passkey belongs to the hosted app's name, which a page on the
 *   box's own name can't use.
 * - `notifications`: service worker, Push API and the Notifications API.
 * - `offline`: the service worker's cache and installing the app.
 * - `clipboard`: the async Clipboard API (copy falls back to the old way; reading is gone).
 * - `camera`, `microphone`: `getUserMedia` (photos, voice).
 * - `share`: the system share sheet (Web Share).
 * - `keyProtection`: Web Crypto (`crypto.subtle`); the device key can't be stored non-extractable, so a script that ever
 *   runs on that page could copy it.
 */
export const SECURE_CONTEXT_FEATURES = [
  'passkeys',
  'notifications',
  'offline',
  'clipboard',
  'camera',
  'microphone',
  'share',
  'keyProtection',
] as const;
export type SecureContextFeature = (typeof SECURE_CONTEXT_FEATURES)[number];

/** What a page of the box at `origin` can't do: everything above without a secure context, else only passkeys. */
export function unavailableOnPage(
  page: { origin: string; secureContext: boolean },
  passkeyOrigins: readonly string[],
): SecureContextFeature[] {
  if (!page.secureContext) return [...SECURE_CONTEXT_FEATURES];
  return passkeyOrigins.includes(page.origin) ? [] : ['passkeys'];
}

/** Whether passkeys can't work on the session's page (a direct browser page whose origin isn't the passkeys' own). */
export function passkeysUnavailable(
  transport: SessionTransport | undefined,
  passkeyOrigins: readonly string[],
): boolean {
  if (transport?.via !== 'direct' || !transport.page) return false;
  return unavailableOnPage(transport.page, passkeyOrigins).includes('passkeys');
}

/**
 * Whether a passkey ceremony can run in this session: the box has a relying party, and the session isn't a page whose
 * origin isn't the passkeys' own.
 */
export function passkeysWorkHere(
  transport: SessionTransport | undefined,
  relyingParty: { origins: readonly string[] } | null,
): boolean {
  return relyingParty !== null && !passkeysUnavailable(transport, relyingParty.origins);
}

/**
 * Which of the person's passkeys a session can use to confirm something: the hosted app's where those work (the apps,
 * the hosted app, a community box's Tailscale page), the box's own on a page at one of its own hosts (`ownHosts`: the
 * current one and the one it is leaving), none anywhere else.
 */
export function stepUpPasskeysHere(
  transport: SessionTransport | undefined,
  relyingParty: { origins: readonly string[] } | null,
  ownHosts: readonly string[],
): 'hosted' | 'box' | null {
  if (passkeysWorkHere(transport, relyingParty)) return 'hosted';
  const page = transport?.via === 'direct' ? transport.page : null;
  if (page?.secureContext && ownHosts.some((h) => page.origin === `https://${h}`)) return 'box';
  return null;
}

/**
 * Session ops that always need a WebAuthn ceremony in the page. `remoteHelp.confirmBegin` isn't one: it asks for the
 * passkeys that work where the person is, and for none where none does.
 */
export const PAGE_PASSKEY_OPS: ReadonlySet<string> = new Set([
  'passkey.register.begin',
  'passkey.link',
  'passkey.register',
]);

/** `details.code` of the refusal of a passkey op from a page that can't run one (`forbidden`). */
export const PASSKEYS_UNAVAILABLE_HERE = 'passkeys_unavailable_here';
