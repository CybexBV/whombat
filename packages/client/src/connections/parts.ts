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

/* A Custom MCP server's probe (CX-61) ------------------------------------------------------------------------------- */

/** What the Custom MCP probe found, in a line: the sign-in it picked, or why it couldn't tell. */
export function probeNote(probed: ProbeConnectionResponse): { tone: 'ok' | 'bad'; text: string } {
  const name = probed.serverName ? `${probed.serverName} ` : 'The server ';
  const text =
    probed.needs === 'open'
      ? `${name}answers without a sign-in.`
      : probed.needs === 'oauth'
        ? `${name}asks you to sign in${probed.issuer ? ` at ${probed.issuer}` : ''}. Continue to sign in there.`
        : probed.needs === 'token'
          ? `${name}wants a token. Paste the one its documentation tells you to send.`
          : `Whombat couldn’t reach the server${probed.message ? `: ${probed.message}` : '.'}`;
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
export const NEXTCLOUD_WAIT_TEXT = {
  title: 'Waiting for Nextcloud…',
  web: 'Log in and choose Grant access in the tab that opened. This page carries on by itself',
  phone: 'Log in and choose Grant access in the browser that opened. This screen carries on by itself',
  open: 'Open the Nextcloud login',
  cancel: 'Cancel',
  tooLong: 'The sign-in took too long. Start again.',
  failed: 'Nextcloud didn’t finish the sign-in.',
} as const;

/** When the wait gives up: the flow's own expiry, at most 10 minutes from now. */
export function nextcloudEnds(login: Pick<StartNextcloudLoginResponse, 'expiresAt'>, now: number): number {
  return Math.min(Date.parse(login.expiresAt), now + NEXTCLOUD_LOGIN_MAX_MS);
}

/** “1 minute left”, “7 minutes left” (never less than one). */
export function minutesLeftText(ends: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((ends - now) / 60_000));
  return minutes === 1 ? '1 minute left' : `${minutes} minutes left`;
}

/** What a poll's answer means: connected (with the connection), failed (with why), or ask again. */
export type NextcloudPollStep =
  | {
      kind: 'connected';
      connection: Extract<PollNextcloudLoginResponse, { state: 'connected' }>['connection'];
    }
  | { kind: 'failed'; message: string }
  | { kind: 'wait' };

export function nextcloudPollStep(r: PollNextcloudLoginResponse): NextcloudPollStep {
  if (r.state === 'connected') return { kind: 'connected', connection: r.connection };
  if (r.state === 'expired') return { kind: 'failed', message: NEXTCLOUD_WAIT_TEXT.tooLong };
  if (r.state === 'failed') return { kind: 'failed', message: r.message || NEXTCLOUD_WAIT_TEXT.failed };
  return { kind: 'wait' };
}

/* Waiting for the service's own page (SG-01, SG-05) ----------------------------------------------------------------- */

/** The wait's words: Nextcloud's, in the service's name (SG-05: “While waiting: as Nextcloud's”). */
export const SERVICE_LOGIN_WAIT_TEXT = {
  title: (name: string) => `Waiting for ${name}…`,
  web: 'Sign in and allow Whombat in the tab that opened. This page carries on by itself',
  phone: 'Sign in and allow Whombat in the browser that opened. This screen carries on by itself',
  open: (name: string) => `Open the ${name} sign-in`,
  /** A device-code service's code to type there (`userCode`, CT-738), its label and its copy toast. */
  userCode: (name: string) => `Enter this code when ${name} asks for it.`,
  codeLabel: 'Code',
  codeCopied: 'Code copied.',
  cancel: 'Cancel',
  tooLong: NEXTCLOUD_WAIT_TEXT.tooLong,
  failed: (name: string) => `${name} didn’t finish the sign-in.`,
} as const;

/** When the wait gives up: the flow's own expiry, at most `SERVICE_LOGIN_MAX_MS` (10 minutes) from now. */
export function serviceLoginEnds(login: Pick<StartServiceLoginResponse, 'expiresAt'>, now: number): number {
  return Math.min(Date.parse(login.expiresAt), now + SERVICE_LOGIN_MAX_MS);
}

/** The code to show while waiting (a device-code service's), or null (Plex: none). */
export function serviceLoginCode(login: Pick<StartServiceLoginResponse, 'userCode'>): string | null {
  return login.userCode?.trim() || null;
}

/** What a service-login poll's answer means (the very schema Nextcloud's is, CT-738), in the service's name. */
export function serviceLoginPollStep(r: PollServiceLoginResponse, name: string): NextcloudPollStep {
  if (r.state === 'failed')
    return { kind: 'failed', message: r.message || SERVICE_LOGIN_WAIT_TEXT.failed(name) };
  return nextcloudPollStep(r);
}
