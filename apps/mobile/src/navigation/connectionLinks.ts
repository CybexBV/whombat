/**
 * Settings → Connections' addresses on the phone (phone-connect.md PC-02, AP-2902): the web's
 * `/settings?tab=connections&connection=…` opens the phone's own screens, never a web page the managed app would catch
 * itself (its App Link brought every such page straight back to Settings → Connections). Read as the web reads them
 * (`validateSettingsSearch`, AP-758, AP-846): `connection=add` Add a connection, and so does `found=1` (the
 * assistant's link after the first scan, Whombat desk-found.md DF-05; AP-3804: Found on your network is at its top); a
 * connectable entry's id its Connect {Name} (`&url=` filled in, `&connect_error=` said once); with `&id=con_…` (or a
 * sign-in's return, `connected=<entry>&connection=con_…`) that connection's page; Google, Microsoft 365, Email (IMAP),
 * GitHub and Website feedback their own screens; anything else the list. Pure.
 */
import { CONNECTION_CONNECT_ERROR_TEXT, connectableEntry } from '@whombat/client/connections';
import { connectAccessOf, thingId } from '@whombat/core';

const BASE = 'whombat://';

/** The builtin pages with a screen of their own on the phone (`ConnectAccount`). */
export const ACCOUNT_PAGES = ['google', 'microsoft', 'imap', 'github', 'feedback'] as const;
export type AccountPage = (typeof ACCOUNT_PAGES)[number];

export function isAccountPage(value: unknown): value is AccountPage {
  return (ACCOUNT_PAGES as readonly unknown[]).includes(value);
}

/** Every value of `key` in a query (`?a=1&a=2`), decoded, in order. */
function values(search: string, key: string): string[] {
  const out: string[] = [];
  for (const pair of search.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const [k = '', v = ''] = pair.split('=');
    try {
      if (decodeURIComponent(k) === key) out.push(decodeURIComponent(v.replace(/\+/g, ' ')));
    } catch {
      // A broken escape names nothing.
    }
  }
  return out;
}

/** An address a link may fill in (the web's `address`): http(s), one line, at most 300 characters. */
export function linkedAddress(value: string | undefined): string | null {
  const s = value?.trim();
  return s && s.length <= 300 && /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
}

/** A connection's id from a link: `con_…`, short, URL-safe. */
function connectionIdOf(value: string | undefined): string | null {
  return value?.startsWith('con_') && value.length <= 80 && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/** A sign-in's `connect_error=` code the words know (Google's and the catalog's share most). */
export function connectErrorOf(value: string | undefined): string | null {
  if (!value) return null;
  if (value in CONNECTION_CONNECT_ERROR_TEXT) return value;
  return /^[a-z_]{1,40}$/.test(value) ? value : null;
}

/** The query of an app link, its empty parts left out. */
function query(params: Record<string, string | null>): string {
  const parts = Object.entries(params).flatMap(([k, v]) => (v ? [`${k}=${encodeURIComponent(v)}`] : []));
  return parts.length ? `?${parts.join('&')}` : '';
}

/** The screen for `?tab=connections…`, from the link's raw query (`connection` may be there twice). */
export function connectionsScreenUrl(search: string): string {
  const pages = values(search, 'connection');
  const page = pages.find((v) => v === 'add' || isAccountPage(v) || connectableEntry(v) !== null);
  const returned = pages.map(connectionIdOf).find(Boolean) ?? null;
  const connectionId = connectionIdOf(values(search, 'id')[0]) ?? returned;
  const connected = values(search, 'connected')[0];
  const error = connectErrorOf(values(search, 'connect_error')[0]);
  // A sign-in's return names the entry as `connected=` beside the connection's id (CX-D04).
  const open = page ?? (connectionId && connectableEntry(connected) ? connected : undefined);
  const found = ['1', 'true'].includes(values(search, 'found')[0] ?? '');
  if (open === 'add' || (!open && found)) return `${BASE}settings/connections/add`;
  if (isAccountPage(open)) return `${BASE}settings/connections/account/${open}${query({ error })}`;
  // Google's own return names no page: its error belongs on Google's screen (CN-04).
  if (!open && error && (connected === undefined || connected === 'google'))
    return `${BASE}settings/connections/account/google${query({ error })}`;
  if (open && connectableEntry(open)) {
    if (connectionId) return `${BASE}things/${encodeURIComponent(thingId('connection', connectionId))}`;
    const url = linkedAddress(values(search, 'url')[0]);
    // The level the assistant's card chose (connect-in-chat.md) rides along.
    const access = connectAccessOf(values(search, 'access')[0]);
    return `${BASE}settings/connections/connect/${open}${query({ url, error, access })}`;
  }
  return `${BASE}settings/connections`;
}

/**
 * The assistant's connect card on the phone (connect-in-chat.md): `/settings?tab=connections&connection=<entry>&url=…`
 * opens Connect {Name} filled in, here rather than on the web; so do the welcome's other email (IMAP, its own screen)
 * and See all (Add a connection, Found on your network at its top; Whombat first-day.md). Null for any other link.
 */
export function connectCardAppUrl(href: string): string | null {
  const m = /^\/settings\/?\?([^#]*)$/.exec(href.trim());
  if (!m || values(m[1] ?? '', 'tab')[0] !== 'connections') return null;
  const url = connectionsScreenUrl(m[1] ?? '');
  const inApp = [
    `${BASE}settings/connections/connect/`,
    `${BASE}settings/connections/account/imap`,
    `${BASE}settings/connections/add`,
    // A connection's own page: the card asking to allow more on the service (step-up) leads there.
    `${BASE}things/`,
  ];
  return inApp.some((start) => url.startsWith(start)) ? url : null;
}

/** The legacy tabs that were these pages (SS-02): Repositories and Developer were GitHub's, Feedback Website feedback's. */
export function legacyConnectionsTabUrl(tab: string): string | null {
  if (tab === 'repos' || tab === 'dev') return `${BASE}settings/connections/account/github`;
  if (tab === 'feedback') return `${BASE}settings/connections/account/feedback`;
  return null;
}
