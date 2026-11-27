/**
 * Lines both connect forms share (AP-756, AP-843; phone-connect.md PC-04, AP-2901): what a Custom MCP server's probe
 * found (CX-61), the wait for Nextcloud's login elsewhere (CX-11) and for a sign-in on the service's own page (Plex's;
 * Whombat connection-signin.md SG-01, SG-05; AP-3908) — its deadline, minutes left, the code to type where the service
 * asks for one, and what a poll's answer means. Pure: the web's `ConnectParts` and the phone's Connect {Name} draw them.
 */
import type {
  PollNextcloudLoginResponse,
  PollServiceLoginResponse,
  ProbeConnectionResponse,
  StartNextcloudLoginResponse,
  StartServiceLoginResponse,
} from '@whombat/core/contracts';
import { NEXTCLOUD_LOGIN_MAX_MS, SERVICE_LOGIN_MAX_MS, type SignInKind } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { CONN_PARTS_WORDS } from '../i18n/messages/connectionsHosts/connections';

/* A Custom MCP server's probe (CX-61) ------------------------------------------------------------------------------- */

/** What the Custom MCP probe found, in a line: the sign-in it picked, or why it couldn't tell. */
export function probeNote(
  probed: ProbeConnectionResponse,
  locale?: string | null,
): { tone: 'ok' | 'bad'; text: string } {
  const w = clientTree(locale, CONN_PARTS_WORDS).probe;
  const name = probed.serverName ? `${probed.serverName} ` : w.theServer;
  const text =
    probed.needs === 'open'
      ? interpolate(w.open, { name })
      : probed.needs === 'oauth'
        ? probed.issuer
          ? interpolate(w.oauthAt, { name, issuer: probed.issuer })
          : interpolate(w.oauth, { name })
        : probed.needs === 'token'
          ? interpolate(w.token, { name })
          : probed.message
            ? interpolate(w.unreachableWhy, { message: probed.message })
            : w.unreachable;
  return { tone: probed.needs === 'unreachable' ? 'bad' : 'ok', text };
}

/** The sign-in a probe's answer picks: none for an open server, the MCP sign-in, a token; null when unreachable. */
export function probedSignIn(probed: Pick<ProbeConnectionResponse, 'needs'>): SignInKind | null {
  switch (probed.needs) {
    case 'open':
      return 'none';
    case 'oauth':
      return 'mcp_oauth';
    case 'token':
      return 'token';
    default:
      return null;
  }
}

/* Waiting for Nextcloud (CX-11) ------------------------------------------------------------------------------------- */

/** The wait's words: the web's, with the phone's browser where the web says “the tab” (AP-2914). */
export function nextcloudWaitText(locale?: string | null) {
  return { ...clientTree(locale, CONN_PARTS_WORDS).nextcloud };
}

export const NEXTCLOUD_WAIT_TEXT = nextcloudWaitText('en');

/** When the wait gives up: the flow's own expiry, at most 10 minutes from now. */
export function nextcloudEnds(login: Pick<StartNextcloudLoginResponse, 'expiresAt'>, now: number): number {
  return Math.min(Date.parse(login.expiresAt), now + NEXTCLOUD_LOGIN_MAX_MS);
}

/** “1 minute left”, “7 minutes left” (never less than one). */
export function minutesLeftText(ends: number, now: number, locale?: string | null): string {
  const minutes = Math.max(1, Math.ceil((ends - now) / 60_000));
  return clientTree(locale, CONN_PARTS_WORDS).minutesLeft(minutes);
}

/** What a poll's answer means: connected (with the connection), failed (with why), or ask again. */
export type NextcloudPollStep =
  | {
      kind: 'connected';
      connection: Extract<PollNextcloudLoginResponse, { state: 'connected' }>['connection'];
    }
  | { kind: 'failed'; message: string }
  | { kind: 'wait' };

export function nextcloudPollStep(r: PollNextcloudLoginResponse, locale?: string | null): NextcloudPollStep {
  const w = nextcloudWaitText(locale);
  if (r.state === 'connected') return { kind: 'connected', connection: r.connection };
  if (r.state === 'expired') return { kind: 'failed', message: w.tooLong };
  if (r.state === 'failed') return { kind: 'failed', message: r.message || w.failed };
  return { kind: 'wait' };
}

/* Waiting for the service's own page (SG-01, SG-05) ----------------------------------------------------------------- */

/** The wait's words: Nextcloud's, in the service's name (SG-05: “While waiting: as Nextcloud's”). */
export function serviceLoginWaitText(locale?: string | null) {
  const w = clientTree(locale, CONN_PARTS_WORDS).service;
  return {
    title: (name: string) => interpolate(w.title, { name }),
    web: w.web,
    phone: w.phone,
    open: (name: string) => interpolate(w.open, { name }),
    /** A device-code service's code to type there (`userCode`), its label and its copy toast. */
    userCode: (name: string) => interpolate(w.userCode, { name }),
    codeLabel: w.codeLabel,
    codeCopied: w.codeCopied,
    cancel: w.cancel,
    tooLong: nextcloudWaitText(locale).tooLong,
    failed: (name: string) => interpolate(w.failed, { name }),
  };
}

export const SERVICE_LOGIN_WAIT_TEXT = serviceLoginWaitText('en');

/** When the wait gives up: the flow's own expiry, at most `SERVICE_LOGIN_MAX_MS` (10 minutes) from now. */
export function serviceLoginEnds(login: Pick<StartServiceLoginResponse, 'expiresAt'>, now: number): number {
  return Math.min(Date.parse(login.expiresAt), now + SERVICE_LOGIN_MAX_MS);
}

/** The code to show while waiting (a device-code service's), or null (Plex: none). */
export function serviceLoginCode(login: Pick<StartServiceLoginResponse, 'userCode'>): string | null {
  return login.userCode?.trim() || null;
}

/** What a service-login poll's answer means (the very schema Nextcloud's is, CT-738), in the service's name. */
export function serviceLoginPollStep(
  r: PollServiceLoginResponse,
  name: string,
  locale?: string | null,
): NextcloudPollStep {
  if (r.state === 'failed')
    return { kind: 'failed', message: r.message || serviceLoginWaitText(locale).failed(name) };
  return nextcloudPollStep(r, locale);
}
