/**
 * Plex signs in on its own PIN page (docs/decisions/connection-signin.md SG-04, SG-05), as python-plexapi, Overseerr,
 * Home Assistant and Kometa do: it handles two-step codes, Google, Apple and Facebook accounts and passkeys, so Whombat
 * never sees a password.
 *
 * - Start: `POST https://plex.tv/api/v2/pins?strong=true` (`Accept: application/json`, `X-Plex-Product` and
 *   `X-Plex-Device-Name` = `Whombat`, `X-Plex-Client-Identifier` = the burrow's stable client id, so the account's
 *   Authorized Devices list one Whombat) → `{id, code, expiresIn}`. The person opens
 *   `https://app.plex.tv/auth#?clientID=<id>&code=<code>&context%5Bdevice%5D%5Bproduct%5D=Whombat` (no `forwardUrl`:
 *   Plex checks it against the PIN's origin; the form closes the tab itself).
 * - Poll every 2 s: `GET https://plex.tv/api/v2/pins/<id>?code=<code>` → `authToken` null: pending; 404: expired; a
 *   token: `GET https://plex.tv/api/v2/user` with it for the account's name (optional), then the entry's check against
 *   the server with it. The PIN's code is a secret until it is used: kept sealed with the flow, never logged.
 * - Plex can't limit the account's token: Whombat keeps it to the level chosen (CS-10).
 */
import { SERVICE_LOGIN_POLL_MS } from '@whombat/core';
import type { OutboundResponse } from '../../lib/outbound';
import type { CheckOutcome } from '../checks';
import { jsonOf } from '../http';
import { type ServiceLoginAdapter, type ServiceLoginContext, ServiceLoginError } from './types';

/** Where Plex accounts sign in. */
export const PLEX_TV = 'https://plex.tv';
/** Plex's own sign-in page. */
export const PLEX_APP = 'https://app.plex.tv';

const NOT_ACCEPTED =
  'Plex let Whombat in, but this server didn’t accept your account. Is it the server’s owner?';
const BUSY = 'Plex is busy right now. Wait a minute, then try again.';
const ODD = 'Plex didn’t answer as expected. Try again in a moment, or make a token instead.';

/** What the poll keeps of the PIN (sealed with the flow). */
interface PlexPin {
  id: string;
  code: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The PIN of a start's answer: an id of digits and a code of letters and digits, or null. */
export function pinOf(answer: unknown): (PlexPin & { expiresIn: number | null }) | null {
  const o = record(answer);
  const id = typeof o?.id === 'number' && Number.isSafeInteger(o.id) ? String(o.id) : text(o?.id);
  const code = text(o?.code);
  if (!id || !/^\d{1,20}$/.test(id) || !code || !/^[A-Za-z0-9]{1,64}$/.test(code)) return null;
  const expiresIn = typeof o?.expiresIn === 'number' && o.expiresIn > 0 ? o.expiresIn : null;
  return { id, code, expiresIn };
}

/** Plex's sign-in page for this PIN, naming Whombat as the app asking. */
export function plexLoginUrl(app: string, input: { clientId: string; code: string; name: string }): string {
  const params = [
    `clientID=${encodeURIComponent(input.clientId)}`,
    `code=${encodeURIComponent(input.code)}`,
    `context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(input.name)}`,
  ];
  return `${app}/auth#?${params.join('&')}`;
}

/** The token a PIN answers once the person allowed Whombat, or null while it waits. */
export function pinToken(answer: unknown): string | null {
  const token = text(record(answer)?.authToken);
  return token && !/\s/.test(token) ? token : null;
}

/** Who the account is, from `/api/v2/user`: its email, else its username or title. */
export function plexAccountName(answer: unknown): string | null {
  const o = record(answer);
  return (text(o?.email) ?? text(o?.username) ?? text(o?.title))?.slice(0, 200) ?? null;
}

function headersOf(ctx: Pick<ServiceLoginContext, 'name' | 'clientId'>): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Plex-Product': ctx.name,
    'X-Plex-Device-Name': ctx.name,
    'X-Plex-Client-Identifier': ctx.clientId,
  };
}

function ok(res: Pick<OutboundResponse, 'status'>): boolean {
  return res.status >= 200 && res.status < 300;
}

/**
 * The Plex adapter. `plexTv` and `app` are Plex's own addresses; tests point them at a stub behind a home-network
 * address.
 */
export function plexServiceLogin(origins: { plexTv?: string; app?: string } = {}): ServiceLoginAdapter {
  const plexTv = origins.plexTv ?? PLEX_TV;
  const app = origins.app ?? PLEX_APP;
  return {
    origins: [plexTv],

    async start(ctx) {
      const res = await ctx.fetch(`${plexTv}/api/v2/pins?strong=true`, {
        method: 'POST',
        headers: headersOf(ctx),
      });
      if (res.status === 429) throw new ServiceLoginError(BUSY);
      const pin = ok(res) ? pinOf(jsonOf(res)) : null;
      if (!pin) throw new ServiceLoginError(ODD);
      return {
        loginUrl: plexLoginUrl(app, { clientId: ctx.clientId, code: pin.code, name: ctx.name }),
        userCode: null,
        ttlMs: (pin.expiresIn ?? 600) * 1000,
        pollEveryMs: SERVICE_LOGIN_POLL_MS,
        state: { id: pin.id, code: pin.code } satisfies PlexPin,
      };
    },

    async poll(ctx, state) {
      const id = text(state.id);
      const code = text(state.code);
      if (!id || !code) return { state: 'expired' };
      const res = await ctx.fetch(
        `${plexTv}/api/v2/pins/${encodeURIComponent(id)}?code=${encodeURIComponent(code)}`,
        { method: 'GET', headers: headersOf(ctx) },
      );
      if (res.status === 404) return { state: 'expired' };
      // Busy or down for a moment: the next poll asks again (the flow's expiry ends it).
      if (res.status === 429 || res.status >= 500) return { state: 'pending' };
      if (!ok(res)) return { state: 'failed', message: ODD };
      const token = pinToken(jsonOf(res));
      if (!token) return { state: 'pending' };
      // Who the account is, for the connection's row: optional, a failure changes nothing.
      let externalName: string | null = null;
      try {
        const user = await ctx.fetch(`${plexTv}/api/v2/user`, {
          method: 'GET',
          headers: { ...headersOf(ctx), 'X-Plex-Token': token },
        });
        if (ok(user)) externalName = plexAccountName(jsonOf(user));
      } catch {
        // The name is a nicety.
      }
      return { state: 'token', secret: token, externalName };
    },

    checkFailedText(_entry, outcome: CheckOutcome) {
      return outcome.refused ? NOT_ACCEPTED : null;
    },
  };
}
