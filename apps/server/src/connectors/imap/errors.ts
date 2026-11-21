/**
 * How talking to a mail server failed, in words a person reads (docs/decisions/connections-more.md CM-22,
 * connections-more-mail.md CM-M07): which side (receiving over IMAP, sending over SMTP), what went wrong, never what the
 * server itself said (it can quote anything). The server's answer (imapflow's `response` and `serverResponseCode`,
 * nodemailer's `response` and `responseCode`) is read to pick the words, never quoted (connection-signin.md SG-18c).
 */
import { isIP } from 'node:net';

export type MailSide = 'imap' | 'smtp';

/**
 * `refused`: the password (or user name) was not accepted; `unreachable`: no connection; `certificate`: TLS did not
 * verify, so nothing was sent; `no_tls`: STARTTLS asked for but not offered; `not_allowed`: the destination policy;
 * `timeout`: no answer in time; `busy`: the server asked to wait (too many connections); `web_sign_in`: the provider
 * wants a sign-in in a web browser first (the password may be right); `contact_provider`: the provider says to contact
 * it about the account (RFC 5530 `CONTACTADMIN`, not temporary); `protocol`: anything else.
 */
export type MailFailure =
  | 'refused'
  | 'unreachable'
  | 'certificate'
  | 'no_tls'
  | 'not_allowed'
  | 'timeout'
  | 'busy'
  | 'web_sign_in'
  | 'contact_provider'
  | 'protocol';

export class MailError extends Error {
  constructor(
    readonly side: MailSide,
    readonly reason: MailFailure,
    readonly host: string,
    readonly port: number,
    message?: string,
  ) {
    super(message ?? mailFailureText(side, reason, host, port));
    this.name = 'MailError';
  }
}

const shown = (host: string) => (isIP(host) === 6 ? `[${host}]` : host);

/** Microsoft's own mail servers (Outlook.com, Hotmail, Microsoft 365), which take no password at all (SG-18b). */
export function isMicrosoftMailHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (
    h === 'outlook.office.com' ||
    h === 'office365.com' ||
    h.endsWith('.office365.com') ||
    h.endsWith('.outlook.com')
  );
}

/** Google's mail servers (Gmail, Google Workspace). */
const isGoogleMailHost = (host: string) => /(^|\.)(gmail|googlemail|google)\.com\.?$/i.test(host);

/** Microsoft refuses every password over IMAP, app passwords too (SG-18b). */
export const MICROSOFT_NO_PASSWORDS =
  'Outlook and Microsoft 365 no longer let mail apps sign in with a password, not even an app password. Connect Microsoft 365 instead.';

/** Gmail's “Application-specific password required” (SG-18c). */
export const GMAIL_APP_PASSWORD =
  'Gmail wants an app password: turn on 2-Step Verification, then make one at myaccount.google.com/apppasswords.';

/** What a person reads when a side failed. */
export function mailFailureText(side: MailSide, reason: MailFailure, host: string, port: number): string {
  const h = shown(host);
  switch (reason) {
    case 'refused':
      if (isMicrosoftMailHost(host)) return MICROSOFT_NO_PASSWORDS;
      return side === 'imap'
        ? 'The mail server refused the password. If your provider uses app passwords, make one and use that.'
        : `The sending server (${h}) refused the password. If your provider uses app passwords, make one and use that.`;
    case 'unreachable':
      return `Whombat couldn’t reach ${h} on port ${port}.`;
    case 'certificate':
      return `${h} didn’t show a valid certificate, so Whombat didn’t send the password.`;
    case 'no_tls':
      return `${h} doesn’t offer an encrypted connection on port ${port}. Try port ${side === 'imap' ? 993 : 465} with TLS.`;
    case 'timeout':
      return `${h} didn’t answer in time. Try again in a moment.`;
    case 'busy':
      return `${h} is busy right now. Try again in a minute.`;
    case 'web_sign_in':
      return `Sign in to ${isGoogleMailHost(host) ? 'Gmail' : 'your mail'} in a web browser once, then try again.`;
    case 'contact_provider':
      return side === 'imap'
        ? 'The mail server says to contact your mail provider about this account.'
        : `The sending server (${h}) says to contact your mail provider about this account.`;
    case 'not_allowed':
      return `Whombat isn’t allowed to reach ${h}.`;
    default:
      return `${h} answered in a way Whombat doesn’t understand.`;
  }
}

const UNTRUSTED = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectText',
  'ClosedAfterConnectTLS',
  'ECONNECTION',
  'EDNS',
]);

const TIMEOUT = new Set([
  'ETIMEDOUT',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETIMEOUT',
  'ESOCKET_TIMEOUT',
]);

/** Server answers that mean “not now”, not “wrong password” (RFC 5530 response codes, SMTP 4xx). */
const BUSY_CODES = new Set(['UNAVAILABLE', 'LIMIT', 'INUSE', 'OVERQUOTA']);

type ErrorLike = Error & {
  code?: string;
  authenticationFailed?: boolean;
  tlsFailed?: boolean;
  serverResponseCode?: string;
  responseCode?: number;
  command?: string;
  /** The server's line (imapflow: the tagged answer as text; nodemailer: the SMTP reply). Read, never shown. */
  response?: unknown;
};

/** The server's own answer, for reading only. */
const answerOf = (e: ErrorLike) => (typeof e.response === 'string' ? e.response : '');

/** Any error of imapflow, nodemailer or the socket as a `MailError` of that side. */
export function mailErrorOf(err: unknown, side: MailSide, host: string, port: number): MailError {
  if (err instanceof MailError) return err;
  const e = (err ?? {}) as ErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  const fail = (reason: MailFailure) => new MailError(side, reason, host, port);
  const cause = (e as { cause?: ErrorLike }).cause;
  const causeCode = typeof cause?.code === 'string' ? cause.code : '';
  // TLS spoken to a port that answers in plain text.
  if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || causeCode === 'ERR_SSL_WRONG_VERSION_NUMBER')
    return fail('no_tls');
  if (UNTRUSTED.has(code) || UNTRUSTED.has(causeCode) || e.tlsFailed) return fail('certificate');
  // nodemailer wraps socket errors as ESOCKET, the TLS one with the certificate attached.
  const message = e.message ?? '';
  if (code === 'ESOCKET') {
    if (
      (e as { cert?: unknown }).cert ||
      /certificate|altnames|self[- ]signed|unable to (verify|get)/i.test(message)
    )
      return fail('certificate');
    if (/wrong version number/i.test(message)) return fail('no_tls');
    if (/ETIMEDOUT|timed? ?out/i.test(message)) return fail('timeout');
    return fail('unreachable');
  }
  const responseCode = e.serverResponseCode?.toUpperCase();
  if (responseCode === 'CONTACTADMIN') return fail('contact_provider');
  if (responseCode && BUSY_CODES.has(responseCode)) return fail('busy');
  if (e.authenticationFailed || code === 'EAUTH') {
    // SMTP 454 / 421 at AUTH: a temporary failure, not the password.
    if (side === 'smtp' && (e.responseCode === 454 || e.responseCode === 421)) return fail('busy');
    const answer = answerOf(e);
    // Gmail's “Please log in via your web browser”: a sign-in check, not the password (SG-18c).
    if (/log ?in via your web browser/i.test(answer)) return fail('web_sign_in');
    // Gmail's IMAP alert and SMTP 534 5.7.9: the account has 2-Step Verification, so only an app password works.
    if (
      /application-specific password required/i.test(answer) ||
      (side === 'smtp' && e.responseCode === 534 && /\b5\.7\.9\b/.test(answer))
    )
      return new MailError(side, 'refused', host, port, GMAIL_APP_PASSWORD);
    return fail('refused');
  }
  if (code === 'ETHROTTLE') return fail('busy');
  if (TIMEOUT.has(code) || TIMEOUT.has(causeCode)) return fail('timeout');
  if (UNREACHABLE.has(code) || UNREACHABLE.has(causeCode)) return fail('unreachable');
  // nodemailer: STARTTLS required (`requireTLS`) and the server doesn't offer it; imapflow: doSTARTTLS refused.
  if (/STARTTLS/i.test(e.message ?? '') && /not|fail|support|offer/i.test(e.message ?? ''))
    return fail('no_tls');
  if (code === 'ETLS') return fail('certificate');
  return fail('protocol');
}
