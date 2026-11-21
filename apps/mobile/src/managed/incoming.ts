/**
 * Links that open the phone app, sorted into what they ask for (`appUrl`): a magic link, the computer's phone sign-in
 * QR code (`<ui>/auth/phone#…` or `whombat://auth/phone#…`, AP-531), a tapped notification, or one of these: a link
 * that sets up this phone for a Whombat (add a device, naming the Whombat's identity, AP-64), `…/claim` (with the card
 * when its QR code opened it, AP-47), or a
 * link that names an appliance (MR-45), a burrow page of the hosted UI in either form (AP-366: burrow-less
 * `/c/general`, which opens in the Whombat last used, or the old `/<burrow>/c/general`), or a provider's answer to a
 * sign-in the phone started (`/connect/…`, phone-connect.md PC-05). Pure, so it is unit-tested.
 */
import { splitBurrowPath } from '@whombat/client';
import type { GoogleReturn } from '@whombat/client/managed';
import {
  type ClaimCard,
  type PhoneSignInLink,
  parseApplianceLinkPath,
  parseClaimFragment,
  parseMagicLinkUrl,
  parsePhoneSignInLink,
  parseSetupLink,
  type SetupLink,
} from '@whombat/client/managed';
import { isShareUrl } from '../data/shareInbox';
import { type PushTap, parsePushTapUrl } from '../navigation/routes';
import { connectReturnOf } from './connectReturn';

export type IncomingLink =
  | { kind: 'setup'; link: SetupLink }
  /** `path` keeps the link's query (`?thread=`, `?burrow=`). */
  | { kind: 'appliance'; device: string; path: string }
  /** A burrow page without an appliance: opened in the Whombat last used; `path` keeps the query. */
  | { kind: 'path'; path: string }
  | { kind: 'claim'; card: ClaimCard | null }
  /**
   * A provider's answer to a sign-in the phone started (`<ui>/connect/<id>?code=…&state=…`; phone-connect.md PC-05,
   * AP-2905): finished over the session of the Whombat that started it.
   */
  | { kind: 'connect'; back: GoogleReturn; entry: string };

/** First segments the hosted UI keeps for itself: never a burrow page, even in the old form's shape. */
const UI_PAGES = new Set(['appliances', 'auth', 'claim', 'legal', 'login', 'connect', 'billing']);

/** The path of a hosted-UI link (`https://<ui>/…`), or of the app's own `whombat://appliances/…`. */
export function uiPathOf(url: string, uiOrigins: readonly string[]): string | null {
  const before = url.split('#')[0] ?? '';
  const custom = /^whombat:\/\/(appliances\/[^?]*)/.exec(before);
  if (custom?.[1]) return `/${custom[1]}`;
  const m = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?/.exec(before);
  if (!m?.[1] || !uiOrigins.some((o) => o.replace(/\/+$/, '').toLowerCase() === m[1]?.toLowerCase()))
    return null;
  return m[2] ?? '/';
}

/** The query of a link (`?…`, without the fragment), or `''`. */
function searchOf(url: string): string {
  const before = url.split('#')[0] ?? '';
  const at = before.indexOf('?');
  return at < 0 ? '' : before.slice(at);
}

export function incomingLink(url: string, uiOrigins: readonly string[]): IncomingLink | null {
  const setup = parseSetupLink(url, uiOrigins);
  if (setup) return { kind: 'setup', link: setup };
  const path = uiPathOf(url, uiOrigins);
  if (path === '/claim') return { kind: 'claim', card: parseClaimFragment(url) };
  if (!path) return null;
  const back = connectReturnOf(path, searchOf(url));
  if (back) return { kind: 'connect', back, entry: path.split('/')[2] ?? '' };
  const named = parseApplianceLinkPath(path);
  if (named) return { kind: 'appliance', device: named.device, path: `${named.path}${searchOf(url)}` };
  const split = splitBurrowPath(path);
  if (!split || path === '/' || UI_PAGES.has(path.split('/')[1] ?? '')) return null;
  return { kind: 'path', path: `${path}${searchOf(url)}` };
}

/** Anything that opens the app, sorted: handled by `ManagedApp.onUrl` whether or not the phone is signed in. */
export type AppUrl =
  | { kind: 'magic'; token: string }
  /** The computer's QR code (CT-190): signs this phone in and lets it in to the Whombat it names. */
  | { kind: 'phone'; link: PhoneSignInLink }
  | { kind: 'link'; link: IncomingLink }
  | { kind: 'tap'; tap: PushTap };

export function appUrl(url: string, uiOrigins: readonly string[]): AppUrl | null {
  // The iPhone's share extension opening the app: the share screen opens on its own (ShareIntentBridge).
  if (isShareUrl(url)) return null;
  const magic = parseMagicLinkUrl(url, uiOrigins);
  if (magic) return { kind: 'magic', token: magic.token };
  const phone = parsePhoneSignInLink(url, uiOrigins);
  if (phone) return { kind: 'phone', link: phone };
  const link = incomingLink(url, uiOrigins);
  if (link) return { kind: 'link', link };
  const tap = parsePushTapUrl(url);
  return tap ? { kind: 'tap', tap } : null;
}
