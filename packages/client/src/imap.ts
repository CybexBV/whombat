/**
 * Email (IMAP) (Whombat connections-more.md CM-19…CM-22, CM-29; app connections-more-web.md AP-2764…): a person's own
 * mail account from any provider, connected with its address and password. Whombat finds the servers (`imapDiscover`):
 * what it found shows as one line with Change, which opens the server fields; a known provider gets its hint (an app
 * password, or the Google or Microsoft 365 connection instead). What the web's page and the phone share: the draft of
 * the server fields, what a refusal means for the form, and every word. Pure.
 */
import {
  type Connection,
  type ConnectionCheck,
  type ConnectorsStatus,
  ImapConnectErrorDetails,
  type ImapConnectFailure,
  type ImapProviderHint,
  type ImapServerSettings,
  imapConnectFailureText,
  imapServersLine,
  type MailSecurity,
  mailDefaultPort,
} from '@whombat/core/domain';
import { ApiError, InvalidRequestError } from './http/errors';

/** Whether this Whombat connects other email (`ConnectorsStatus.imap`, 0.97): an older one leaves it out. */
export function imapAvailable(status: Pick<ConnectorsStatus, 'imap'> | undefined): boolean {
  return status?.imap?.available === true;
}

/** The caller's Email (IMAP) connection in the connectors' status (one per person, CM-19). */
export function imapConnection(status: Pick<ConnectorsStatus, 'connections'> | undefined): Connection | null {
  return status?.connections.find((c) => c.provider === 'imap') ?? null;
}

/* The form --------------------------------------------------------------------------------------------- */

/** What the security choices are called where people copy them from (their provider's help pages). */
export const MAIL_SECURITY_LABELS: Record<MailSecurity, string> = { tls: 'SSL/TLS', starttls: 'STARTTLS' };

/** An address that can be looked up: something, an @, a domain with a dot. */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(email.trim());
}

/** The found line's servers from discovered settings (`imapServersLine`). */
export function settingsServers(settings: ImapServerSettings): { imapHost: string; smtpHost: string } {
  return { imapHost: settings.imap.host, smtpHost: settings.smtp.host };
}

/** The server fields while someone edits them: what they typed, ports as text. */
export interface MailServersDraft {
  imapHost: string;
  imapPort: string;
  imapSecurity: MailSecurity;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: MailSecurity;
  /** Empty: the address signs in. */
  username: string;
}

export type MailDraftField = 'imapHost' | 'imapPort' | 'smtpHost' | 'smtpPort' | 'username';

/** The fields filled from what was found (or guessed). */
export function draftFromSettings(settings: ImapServerSettings): MailServersDraft {
  return {
    imapHost: settings.imap.host,
    imapPort: String(settings.imap.port),
    imapSecurity: settings.imap.security,
    smtpHost: settings.smtp.host,
    smtpPort: String(settings.smtp.port),
    smtpSecurity: settings.smtp.security,
    username: settings.username ?? '',
  };
}

/** Another security for one side: its port follows when it was the other one's usual port, else it stays. */
export function withSecurity(
  draft: MailServersDraft,
  side: 'imap' | 'smtp',
  security: MailSecurity,
): MailServersDraft {
  const portKey = side === 'imap' ? 'imapPort' : 'smtpPort';
  const was = side === 'imap' ? draft.imapSecurity : draft.smtpSecurity;
  const usual = draft[portKey].trim() === String(mailDefaultPort(side, was));
  return {
    ...draft,
    [side === 'imap' ? 'imapSecurity' : 'smtpSecurity']: security,
    ...(usual ? { [portKey]: String(mailDefaultPort(side, security)) } : {}),
  };
}

const HOST =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$|^\[?[0-9A-Fa-f:.]+\]?$/;

/** The fields as settings, or what is wrong under each field. */
export function settingsFromDraft(
  draft: MailServersDraft,
):
  | { settings: ImapServerSettings; errors: null }
  | { settings: null; errors: Partial<Record<MailDraftField, string>> } {
  const errors: Partial<Record<MailDraftField, string>> = {};
  const host = (key: 'imapHost' | 'smtpHost') => {
    const value = draft[key].trim();
    if (!value) errors[key] = IMAP_COPY.hostMissing;
    else if (!HOST.test(value) || value.length > 253) errors[key] = IMAP_COPY.hostWrong;
    return value;
  };
  const port = (key: 'imapPort' | 'smtpPort') => {
    const value = Number(draft[key].trim());
    if (!/^\d+$/.test(draft[key].trim()) || value < 1 || value > 65535) errors[key] = IMAP_COPY.portWrong;
    return value;
  };
  const settings: ImapServerSettings = {
    imap: { host: host('imapHost'), port: port('imapPort'), security: draft.imapSecurity },
    smtp: { host: host('smtpHost'), port: port('smtpPort'), security: draft.smtpSecurity },
    username: draft.username.trim() || null,
  };
  return Object.keys(errors).length ? { settings: null, errors } : { settings, errors: null };
}

/** What a refusal means for the form: the sentence, where it goes, and whether the server fields open. */
export interface ImapConnectProblem {
  /** Above the button; null when everything is under its field. */
  message: string | null;
  /** Under the address, the password or a server field. */
  fields: Partial<Record<'email' | 'password' | MailDraftField, string>>;
  /** The servers are what's wrong (unreachable, not allowed, their certificate, SMTP's sign-in): show their fields. */
  openServers: boolean;
}

const FAILURE_FIELDS: Record<string, 'email' | 'password' | MailDraftField> = {
  email: 'email',
  password: 'password',
  'settings.imap.host': 'imapHost',
  'settings.imap.port': 'imapPort',
  'settings.smtp.host': 'smtpHost',
  'settings.smtp.port': 'smtpPort',
  'settings.username': 'username',
};

/** `error.details` of a refused connect (`ImapConnectErrorDetails`), when the form knows its reason. */
function imapFailure(error: unknown): ImapConnectErrorDetails | null {
  if (!(error instanceof ApiError)) return null;
  const details = ImapConnectErrorDetails.safeParse(error.details);
  return details.success ? details.data : null;
}

/** Why a connect was refused (`error.details.reason`, CM-22); null for anything else. */
export function imapFailureReason(error: unknown): ImapConnectFailure | null {
  return imapFailure(error)?.reason ?? null;
}

/**
 * A refused connect for the form (CM-22): the IMAP side refusing the password goes under the password; SMTP refusing
 * it, a server that can't be reached, a home-network address that isn't allowed and a certificate that can't be checked
 * open the server fields with the sentence above the button. The server's own sentence says which side, in words.
 */
export function imapConnectProblem(error: unknown): ImapConnectProblem {
  if (
    error instanceof InvalidRequestError ||
    (error instanceof ApiError && error.code === 'validation_failed')
  ) {
    const fields: ImapConnectProblem['fields'] = {};
    for (const [path, messages] of Object.entries((error as ApiError | InvalidRequestError).fields)) {
      const key = FAILURE_FIELDS[path];
      if (key && messages[0] && !fields[key]) fields[key] = messages[0];
    }
    if (Object.keys(fields).length)
      return {
        message: null,
        fields,
        openServers: Object.keys(fields).some((k) => k !== 'email' && k !== 'password'),
      };
  }
  if (!(error instanceof ApiError)) return { message: IMAP_COPY.failed, fields: {}, openServers: false };
  const failure = imapFailure(error);
  const reason = failure?.reason ?? null;
  // The server's sentence; the contracts' words for its reason only when it sends none.
  const message =
    error.message || (failure ? imapConnectFailureText(failure.reason, failure) : IMAP_COPY.failed);
  if (reason === 'imap_refused') return { message: null, fields: { password: message }, openServers: false };
  return { message, fields: {}, openServers: reason !== null };
}

/* Words ------------------------------------------------------------------------------------------------- */

export const IMAP_COPY = {
  name: 'Email (IMAP)',
  /** The provider's line (the catalog entry's words, CM-19). */
  description: 'Mail from any other provider, like Fastmail, iCloud or your own server, for your agent.',
  notConnected: 'Your agent works with your mail, as you, when you ask.',
  email: 'EMAIL ADDRESS',
  password: 'PASSWORD',
  passwordHint: 'An app password if your provider has them.',
  looking: 'Looking for your mail servers…',
  found: 'Mail servers',
  change: 'Change',
  guessed: 'Whombat couldn’t find your mail servers. Check these with your provider.',
  incoming: 'INCOMING MAIL (IMAP)',
  outgoing: 'OUTGOING MAIL (SMTP)',
  server: 'Server',
  port: 'Port',
  security: 'Security',
  username: 'USERNAME',
  usernameHint: 'Only when it isn’t your email address.',
  emailMissing: 'Enter your email address.',
  passwordMissing: 'Enter the password.',
  hostMissing: 'Enter the server’s name.',
  hostWrong: 'That isn’t a server name.',
  portWrong: 'Enter a port from 1 to 65535.',
  connect: 'Connect email',
  connecting: 'Signing in to your mail servers…',
  failed: 'That didn’t work. Try again in a moment.',
  connected: 'Connected',
  needsPassword: 'Needs a new password',
  reauth: 'The mail server no longer accepts the password. Enter it again to keep using it.',
  changePassword: 'Change password',
  newPassword: 'Enter the new password',
  connectAgain: 'Sign in again',
  cancel: 'Cancel',
  disconnect: 'Disconnect',
  disconnectAsk: 'Disconnect your email? Your agent can’t use your mail until you connect again.',
  disconnectConfirm: 'Disconnect email',
  checking: 'Checking your mail servers…',
  notChecked: 'Not checked yet',
  checkAgain: 'Check again',
  update: 'Update this Whombat to connect other email.',
} as const;

/** The toast after connecting: “Email connected: mara@fastmail.com.” */
export function imapConnectedText(email: string): string {
  return `Email connected: ${email}.`;
}

export const IMAP_DISCONNECTED_TEXT = 'Email disconnected.';

/** The connected account's line: “Connected · imap.fastmail.com and smtp.fastmail.com”, or why it needs you. */
export function mailAccountLine(connection: Pick<Connection, 'status' | 'mail'>): string {
  if (connection.status !== 'active') return IMAP_COPY.reauth;
  return connection.mail
    ? `${IMAP_COPY.connected} · ${imapServersLine(connection.mail)}`
    : IMAP_COPY.connected;
}

/** A check's name on an IMAP account: the server it is about (`ConnectionCheck.side`, 0.97), else “Mail”. */
export function mailCheckName(check: Pick<ConnectionCheck, 'side'>): string {
  return check.side === 'imap' ? 'Receiving' : check.side === 'smtp' ? 'Sending' : 'Mail';
}

/** The link under a provider's hint: Google's or Microsoft 365's page instead, else the provider's own page. */
export function hintLinkText(hint: ImapProviderHint): string | null {
  if (hint.useInstead === 'google') return 'Connect Google instead';
  if (hint.useInstead === 'microsoft') return 'Connect Microsoft 365 instead';
  return hint.url ? `Open ${hint.name}` : null;
}

/** The links under a provider's hint (AP-3915): the connection to use instead, and the provider's page. */
export interface HintLinks {
  /** “Connect Google instead”: that connection's page. */
  instead: { text: string; connection: NonNullable<ImapProviderHint['useInstead']> } | null;
  /** The provider's page; beside a connection to use instead it is where the mail-only app password is made. */
  page: { text: string; url: string } | null;
}

/**
 * Both links a hint may carry (Whombat connection-signin.md SG-18d, contracts 0.111 CT-747): Gmail offers the Google
 * connection and, for mail only, its app password page (“Make an app password”); the others one or none.
 */
export function hintLinks(hint: ImapProviderHint): HintLinks {
  const instead = hint.useInstead ? { text: hintLinkText(hint) ?? '', connection: hint.useInstead } : null;
  const page = hint.url
    ? { text: hint.useInstead ? 'Make an app password' : `Open ${hint.name}`, url: hint.url }
    : null;
  return { instead, page };
}
