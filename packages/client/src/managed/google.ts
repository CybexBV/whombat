/**
 * Connecting Google on a managed Whombat (docs/decisions/assistant-guides.md AG-14, contracts CT-81). Google sends
 * the browser back to the hosted UI's `/connect/google` with `code` and `state` (or `error`); the app takes them off
 * the address bar at once, reopens the Whombat that started the connect, and finishes over the encrypted session
 * with `connections.finishGoogle`, which answers where to go next (`connected=google` or `connect_error=…`).
 *
 * Which Whombat started it is kept in `sessionStorage` (this tab only) before leaving for Google: the appliance id
 * and the return path, nothing secret. The code itself never touches storage. Held as an expiring record (AP-590):
 * a stale, future-dated or unreadable one is dropped, and storage that throws never breaks the connect.
 *
 * A catalog connection's OAuth sign-in (Home Assistant, MCP authorization, Dropbox; connections-catalog.md CX-15,
 * AP-766) comes back the same way: to `/connect/<catalogId>` (Whombat CX-D04), or to `/connect/google` with the held connect marked
 * `flow: 'connection'`, and finishes with `connections.finishOAuth` (with RFC 9207's `iss` when the service sent one).
 */
import { api, FinishConnectionOAuthResponse, FinishGoogleResponse } from '@whombat/core/contracts';
import { CONNECT_ERROR_PARAM, managedGoogleRedirectPath, ReturnPath } from '@whombat/core/domain';
import { z } from 'zod';
import type { ApplianceSession, ConnectionState } from '../session/types';
import { expiringRecord, type KeyValueStorage } from '../storage/expiring';

export const GOOGLE_CONNECT_KEY = 'whombat:google-connect';
/** Google's state lives 10 minutes on the appliance; a held connect is forgotten after 30. */
const HOLD_MS = 30 * 60_000;

/** The connect this tab started: which Whombat, and where it comes back to. */
export interface HeldGoogleConnect {
  device: string;
  returnTo: string;
  /** When it was held. */
  at: number;
  /** A catalog connection's sign-in (AP-766), finished with `connections.finishOAuth`; absent: Google's or Microsoft's. */
  flow?: 'connection';
}

const GoogleConnect = z.object({
  device: z.string().min(1),
  returnTo: z.string().refine((p) => ReturnPath.safeParse(p).success),
  flow: z.literal('connection').optional(),
});

/** The tab's storage, or how to reach it (reaching `sessionStorage` may throw). */
type TabStorage = KeyValueStorage | (() => KeyValueStorage);

const connectRecord = (storage: TabStorage, now: number) =>
  expiringRecord({
    storage: typeof storage === 'function' ? storage : () => storage,
    key: GOOGLE_CONNECT_KEY,
    schema: GoogleConnect,
    ttlMs: HOLD_MS,
    // Before AP-590: `{device, returnTo, at}`, held as long.
    legacy: { ttlMs: HOLD_MS },
    now: () => now,
  });

/** Holds the connect (or forgets it); false when it couldn't be held (`/connect/google` then opens the last used). */
export function holdGoogleConnect(
  storage: TabStorage,
  connect: { device: string; returnTo: string; flow?: 'connection' } | null,
  now: number = Date.now(),
): boolean {
  const record = connectRecord(storage, now);
  if (connect) return record.hold(connect);
  record.clear();
  return true;
}

export function heldGoogleConnect(storage: TabStorage, now: number = Date.now()): HeldGoogleConnect | null {
  const held = connectRecord(storage, now).entry();
  return held ? { ...held.value, at: held.heldAt } : null;
}

/** What Google put on the redirect. */
export interface GoogleReturn {
  /** Microsoft 365's return, or a catalog connection's (`/connect/connection`, or a held `flow: 'connection'`). */
  provider?: 'microsoft' | 'connection';
  code: string | null;
  state: string | null;
  error: string | null;
  /** RFC 9207's `iss` (a catalog connection's authorization server, CT-268). */
  iss?: string | null;
}

/**
 * The hosted UI's return route of a catalog connection's OAuth sign-in on a managed Whombat (AP-766, Whombat CX-D04):
 * `/connect/<catalogId>` (`/connect/homeassistant`), any entry but Google's and Microsoft's own routes.
 */
export function isManagedConnectionReturn(pathname: string): boolean {
  const m = /^\/connect\/([a-z][a-z0-9_]{1,30})$/.exec(pathname);
  return !!m && m[1] !== 'google' && m[1] !== 'microsoft';
}

/** `/connect/google?code=…&state=…` (or `?error=…&state=…`), Microsoft's and a connection's; null on any other path. */
export function readGoogleReturn(location: Pick<Location, 'pathname' | 'search'>): GoogleReturn | null {
  if (
    location.pathname !== managedGoogleRedirectPath &&
    location.pathname !== '/connect/microsoft' &&
    !isManagedConnectionReturn(location.pathname)
  )
    return null;
  const q = new URLSearchParams(location.search);
  const pick = (name: string) => {
    const v = q.get(name);
    return v ? v : null;
  };
  return {
    code: pick('code'),
    state: pick('state'),
    error: pick('error'),
    ...(location.pathname === '/connect/microsoft' ? { provider: 'microsoft' as const } : {}),
    ...(isManagedConnectionReturn(location.pathname) ? { provider: 'connection' as const } : {}),
    ...(pick('iss') ? { iss: pick('iss') } : {}),
  };
}

/** The return path with `connect_error=<code>`, for a return that can't be finished (no state, no answer). */
export function withConnectError(returnTo: string, code: string): string {
  const [path, query = ''] = returnTo.split('?', 2) as [string, string?];
  const q = new URLSearchParams(query);
  q.set(CONNECT_ERROR_PARAM, code);
  return `${path}?${q.toString()}`;
}

/** Finishes the connect on the appliance (`connections.finishGoogle`) and answers the path to go to. */
export async function finishGoogleConnection(session: ApplianceSession, back: GoogleReturn): Promise<string> {
  if (!back.state) throw new Error('Google sent no state');
  if (back.provider === 'connection') {
    const r = await session.call(api.connections.finishOAuth, {
      params: {},
      query: {},
      body: {
        state: back.state,
        ...(back.code ? { code: back.code } : {}),
        ...(back.error ? { error: back.error } : {}),
        ...(back.iss ? { iss: back.iss } : {}),
      },
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`connections.finishOAuth answered ${r.status}`);
    return FinishConnectionOAuthResponse.parse(r.body).returnPath;
  }
  const r = await session.call(
    back.provider === 'microsoft' ? api.connections.finishMicrosoft : api.connections.finishGoogle,
    {
      params: {},
      query: {},
      body: {
        state: back.state,
        ...(back.code ? { code: back.code } : {}),
        ...(back.error ? { error: back.error } : {}),
      },
    },
  );
  if (r.status < 200 || r.status >= 300) throw new Error(`connections.finishGoogle answered ${r.status}`);
  return FinishGoogleResponse.parse(r.body).returnPath;
}

/**
 * What `/connect/google` does as its session to the Whombat changes: send Google's answer once the session is open
 * (only once), give up when it closed for good or can't get through (so the screen never waits for ever), else
 * wait. A close of its own (`closed`: the screen went away) is not a failure.
 */
export function googleFinishStep(state: ConnectionState, sent: boolean): 'send' | 'give_up' | 'wait' {
  if (sent) return 'wait';
  if (state.status === 'open') return 'send';
  if (state.status === 'closed') return state.reason === 'closed' ? 'wait' : 'give_up';
  if (state.status === 'reconnecting' && state.attempt >= 2) return 'give_up';
  return 'wait';
}
