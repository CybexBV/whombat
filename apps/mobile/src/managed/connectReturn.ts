/**
 * A sign-in elsewhere started on the phone (phone-connect.md PC-05, AP-2905…AP-2907): on a managed Whombat the phone
 * starts it over its own session, the provider's page opens in the browser, and the provider sends the browser back to
 * the hosted UI's `/connect/<id>?code=…&state=…` (Google's `/connect/google`, Microsoft's `/connect/microsoft`, a catalog
 * entry's `/connect/<catalogId>`; Whombat CX-D04, AG-14). The managed app claims `/connect/` as an App Link (the hosted UI
 * serves nothing else there: no account sign-in comes back to it), so Android hands the return to the app, which
 * finishes it over its own session (`connections.finishOAuth`, `finishGoogle`, `finishMicrosoft`; the state is the
 * account's, so the Whombat checks it as for the web) and opens what the Whombat answers.
 *
 * Which Whombat started it is held here, in memory, for 30 minutes (the web holds it in its tab): nothing secret, and a
 * phone whose app was killed meanwhile finishes at the Whombat last used, as the web does without its tab's record. The
 * code itself is never stored: it goes from the link to the session once. Returns wait here until the open Whombat's
 * navigator takes them (`ConnectReturnBridge`).
 */
import { type GoogleReturn, readGoogleReturn } from '@whombat/client/managed';

/** A held sign-in is forgotten after this (Google's state lives 10 minutes on the Whombat). */
export const HELD_CONNECT_MS = 30 * 60_000;

/** The sign-in this phone started: which Whombat, and whether it was a catalog entry's (`flow: 'connection'`). */
export interface HeldPhoneConnect {
  device: string;
  flow?: 'connection';
  at: number;
}

let held: HeldPhoneConnect | null = null;

/** Holds which Whombat started a sign-in, before the browser opens. */
export function holdPhoneConnect(connect: Omit<HeldPhoneConnect, 'at'>, now: number = Date.now()): void {
  held = { ...connect, at: now };
}

/** The held sign-in, unless it is older than 30 minutes (or from the future); taken once. */
export function takeHeldConnect(now: number = Date.now()): HeldPhoneConnect | null {
  const h = held;
  held = null;
  if (!h || now < h.at || now - h.at > HELD_CONNECT_MS) return null;
  return h;
}

/**
 * The provider's answer on a `/connect/…` path of the hosted UI (`?code=…&state=…`, or `?error=…`), or null for any
 * other path. A catalog entry's sign-in that came back to Google's route counts as the entry's when it was held so.
 */
export function connectReturnOf(path: string, search: string): GoogleReturn | null {
  return readGoogleReturn({ pathname: path, search });
}

/** The return as the held sign-in says it was started (AP-766): a held catalog sign-in on Google's route is one. */
export function asStarted(back: GoogleReturn, started: HeldPhoneConnect | null): GoogleReturn {
  return started?.flow === 'connection' && !back.provider ? { ...back, provider: 'connection' } : back;
}

/** The Whombat to finish at: the one that started it, else the one last used; null when there is none. */
export function finishingDevice(started: HeldPhoneConnect | null, lastUsed: string | null): string | null {
  return started?.device ?? lastUsed;
}

/* Returns waiting for the open Whombat ---------------------------------------------------------------------------- */

/** A return for one Whombat: only its navigator takes it (another one may still be open while it switches). */
export interface PendingConnectReturn {
  device: string;
  back: GoogleReturn;
  /** The route's id (`google`, `microsoft`, a catalog entry's): where to say a failure. */
  entry: string;
}

/** A navigator's listener: true when it took the return (it is that Whombat's). */
type Listener = (item: PendingConnectReturn) => boolean;
let pending: PendingConnectReturn | null = null;
const listeners = new Set<Listener>();

/** Hands a return to its Whombat's navigator, or keeps it until that one listens. */
export function pushConnectReturn(item: PendingConnectReturn): void {
  for (const l of [...listeners]) if (l(item)) return;
  pending = item;
}

/** The return waiting for this Whombat since before its navigator was up (once). */
export function takeConnectReturn(device: string): PendingConnectReturn | null {
  if (!pending || pending.device !== device) return null;
  const p = pending;
  pending = null;
  return p;
}

export function onConnectReturn(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* What the Whombat answered ------------------------------------------------------------------------------------- */

/** What a finished sign-in's return path says: connected (which entry or provider), or the error's code. */
export interface ConnectOutcome {
  connected: string | null;
  error: string | null;
}

/** Reads `connected=` and `connect_error=` off the return path the Whombat answered. */
export function connectOutcome(returnPath: string): ConnectOutcome {
  const search = returnPath.split('#')[0]?.split('?')[1] ?? '';
  const get = (key: string) => {
    for (const pair of search.split('&')) {
      const [k = '', v = ''] = pair.split('=');
      if (k === key) {
        try {
          return decodeURIComponent(v) || null;
        } catch {
          return null;
        }
      }
    }
    return null;
  };
  return { connected: get('connected'), error: get('connect_error') };
}

/**
 * Where a return that couldn't be finished says so (`connect_error=exchange_failed`, as the web): the entry's Connect
 * {Name}, Google's or Microsoft 365's screen; Settings → Connections for a route the phone doesn't know.
 */
export function failedReturnUrl(entry: string, code = 'exchange_failed'): string {
  if (entry === 'google' || entry === 'microsoft')
    return `whombat://settings/connections/account/${entry}?error=${code}`;
  return /^[a-z][a-z0-9_]{1,30}$/.test(entry)
    ? `whombat://settings/connections/connect/${entry}?error=${code}`
    : 'whombat://settings/connections';
}

const THING_URL = 'whombat://things/';

/**
 * The connection a `whombat://things/{id}` link names; null for any other link, and for one whose id isn't a valid
 * escape (a stray `%`), which then opens the way any link does instead of throwing.
 */
export function thingOfUrl(url: string): string | null {
  if (!url.startsWith(THING_URL)) return null;
  try {
    return decodeURIComponent(url.slice(THING_URL.length).split('?')[0] ?? '') || null;
  } catch {
    return null;
  }
}
