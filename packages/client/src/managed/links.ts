/**
 * Links that name the appliance (MR-45): `<hosted UI>/appliances/<device>/<path>`. The runtime writes its links this
 * way in managed mode (run notices, burrow addresses and canvas links), and the apps build theirs the same
 * way, so a link opens the right Whombat when a person has several. Never an origin of the appliance itself.
 */

/** The segments under `/appliances/<device>/` that are journeys of the apps, not burrow paths. */
const JOURNEYS = new Set([
  'pair',
  'recover',
  'recovery-kit',
  'add',
  'setup',
  'identity-changed',
  'bring-back',
]);

export function applianceLink(uiOrigin: string, device: string, path: string): string {
  return `${uiOrigin.replace(/\/+$/, '')}/appliances/${encodeURIComponent(device)}${path.startsWith('/') ? path : `/${path}`}`;
}

/** `/appliances/<device>/<path>` → the appliance and the app path to open in it; null for journeys and other paths. */
export function parseApplianceLinkPath(pathname: string): { device: string; path: string } | null {
  const m = /^\/appliances\/([^/]+)(\/.*)$/.exec(pathname);
  if (!m?.[1] || !m[2] || m[2] === '/') return null;
  const first = m[2].split('/')[1] ?? '';
  if (JOURNEYS.has(first)) return null;
  try {
    return { device: decodeURIComponent(m[1]), path: m[2] };
  } catch {
    return null;
  }
}

/**
 * The path and fragment of a link the apps made: the hosted UI's (one of `uiOrigins`) or the app's own
 * `whombat://…`. Null without a fragment, or for another host.
 */
export function uiLinkParts(
  text: string,
  uiOrigins: readonly string[],
): { path: string; fragment: URLSearchParams } | null {
  const value = text.trim();
  const hashAt = value.indexOf('#');
  if (hashAt < 0) return null;
  const fragment = new URLSearchParams(value.slice(hashAt + 1));
  const before = value.slice(0, hashAt);
  const custom = /^whombat:\/\/(\/?[^?#]*)$/.exec(before);
  if (custom?.[1] !== undefined) return { path: `/${custom[1].replace(/^\/+/, '')}`, fragment };
  const m = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?$/.exec(before);
  if (!m?.[1] || !uiOrigins.some((o) => o.replace(/\/+$/, '').toLowerCase() === m[1]?.toLowerCase()))
    return null;
  return { path: m[2] ?? '/', fragment };
}

/** The device a journey path names (`/appliances/<device>/<journey>`), decoded; null when it doesn't match. */
export function journeyDevice(path: string, pattern: RegExp): string | null {
  const raw = pattern.exec(path)?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
