/**
 * Connector adapters (docs/decisions/connectors.md CN-05, CN-08). Google is the first provider: `GoogleOAuth`
 * signs a person in and keeps their tokens fresh, `GoogleWorkspace` makes the service calls behind the
 * connector tools. Each has a real version (plain `fetch` against Google's REST APIs, no googleapis SDK) and
 * a fake one (in-memory, seeded with a few believable items), picked by `WHOMBAT_GOOGLE=real|fake|off`.
 *
 * Tokens stay on the server: agents, the runner and the web never see one. Every outbound call goes to a
 * fixed Google host (`GOOGLE_HOSTS`).
 */
import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPatch,
  ConnectionCheck,
  ConnectorProvider,
  ConnectorService,
  ContactCard,
  DocEdit,
  DriveFile,
  FileContent,
  GoogleMode,
  GoogleUserType,
  MailDraftInput,
  MailMessage,
  MailSummary,
  ShareRole,
  SheetCell,
} from '@whombat/core';

/* ---------------------------------------------------------------------------------------------- */
/* Hosts and endpoints                                                                            */
/* ---------------------------------------------------------------------------------------------- */

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** The only hosts Whombat calls for Google (CN-05). */
export const GOOGLE_HOSTS: readonly string[] = [
  'accounts.google.com',
  'oauth2.googleapis.com',
  'openidconnect.googleapis.com',
  'gmail.googleapis.com',
  'www.googleapis.com',
  'docs.googleapis.com',
  'sheets.googleapis.com',
  'people.googleapis.com',
];

/** True for an https URL on one of `GOOGLE_HOSTS`. */
export function isGoogleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && GOOGLE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* OAuth                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** The OAuth client in use: from config (`WHOMBAT_GOOGLE_CLIENT_ID`/`_SECRET`) or saved by the person. */
export interface GoogleAppCredentials {
  clientId: string;
  clientSecret: string;
  /** Consent screen audience; null when set in config (not known). */
  userType: GoogleUserType | null;
  source: 'config' | 'settings';
}

export interface AuthorizeUrlInput {
  app: GoogleAppCredentials;
  /** `googleRedirectUri(PUBLIC_URL)`. */
  redirectUri: string;
  /** `googleScopesFor(services)`: `openid email profile` plus each ticked service's. */
  scopes: readonly string[];
  /** The `oauth_states` row id. */
  state: string;
  /** PKCE S256 challenge of the stored verifier. */
  codeChallenge: string;
  /** Pre-fills the account chooser when reconnecting. */
  loginHint?: string;
}

export interface GoogleTokens {
  accessToken: string;
  expiresAt: Date;
  /** Google sends one on the first consent (and with `prompt=consent`); a refresh returns none. */
  refreshToken: string | null;
  /** Scopes granted (space-separated `scope` of the token response). */
  scopes: string[];
}

export interface GoogleUserInfo {
  /** Stable account id (`connections.external_id`). */
  sub: string;
  email: string;
  name: string;
}

/**
 * Why a Google OAuth call failed: `invalid_grant` (refresh token revoked or expired: the connection needs
 * reauth), `access_denied`, `invalid_client` (the app's id or secret is wrong), `network`, `other`.
 */
export type GoogleOAuthErrorCode = 'invalid_grant' | 'access_denied' | 'invalid_client' | 'network' | 'other';

export class GoogleOAuthError extends Error {
  constructor(
    readonly code: GoogleOAuthErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

/** Google sign-in and tokens (`accounts.google.com`, `oauth2.googleapis.com`). */
export interface GoogleOAuth {
  /**
   * The consent URL: the scopes, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`,
   * PKCE S256 and the state. In fake mode, the callback URL with a fake code.
   */
  authorizeUrl(input: AuthorizeUrlInput): string;
  /** Exchanges the callback's code (with the PKCE verifier) for tokens. */
  exchangeCode(input: {
    app: GoogleAppCredentials;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<GoogleTokens>;
  /** A fresh access token. Throws `GoogleOAuthError('invalid_grant')` when the grant is gone. */
  refresh(input: { app: GoogleAppCredentials; refreshToken: string }): Promise<GoogleTokens>;
  /** Revokes a refresh or access token (best effort: callers ignore failures). */
  revoke(token: string): Promise<void>;
  /** Who the token belongs to (`sub`, `email`, `name`). */
  userinfo(accessToken: string): Promise<GoogleUserInfo>;
}

/* ---------------------------------------------------------------------------------------------- */
/* Workspace: the calls behind the connector tools                                                 */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A Google API answered with an error. `enableUrl`: the activation link of a 403 `SERVICE_DISABLED` /
 * `accessNotConfigured` (CN-06); `status` 401 means the access token is no longer good.
 */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason: 'api_disabled' | 'no_scope' | 'not_found' | 'unauthorized' | 'rate_limited' | 'other',
    readonly enableUrl: string | null = null,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** A draft as the `mail_send` approval shows it: every recipient (blind copies too), subject and body. */
export interface MailDraftView {
  attachments?: import('@whombat/core').MailAttachmentDigest[];
  draftId: string;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export interface MailSearchInput {
  query: string;
  limit: number;
}

/** Unread mail in the inbox: how many (the provider's own count), and the newest few, newest first. */
export interface InboxUnread {
  count: number;
  newest: MailSummary[];
}

/** Lightweight attachment metadata read from headers or IMAP BODYSTRUCTURE without downloading attachment bytes. */
export interface MailHeaderAttachment {
  id?: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Clock-skew margin subtracted from an automation's activation or resync time across all mail providers (5 s). */
export const MAIL_SINCE_SKEW_MS = 5_000;

/** Normalizes an RFC 5322 Message-ID header for deduplication across moves and UID renumbering. */
export function normalizeRfcMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const match = /<([^<>\s]+)>/.exec(trimmed);
  const inner = (match ? match[1] : trimmed) ?? '';
  const clean = inner.replace(/[\r\n\s]+/g, '').slice(0, 498);
  return clean ? `<${clean}>` : null;
}

/** Whether a message received at `receivedAt` is at or after `since` (allowing `MAIL_SINCE_SKEW_MS` of clock skew). */
export function receivedAtOrAfter(
  receivedAt: string | number | Date,
  since: Date | null | undefined,
): boolean {
  if (!since) return true;
  const ms =
    typeof receivedAt === 'number'
      ? receivedAt
      : receivedAt instanceof Date
        ? receivedAt.getTime()
        : Date.parse(receivedAt);
  if (!Number.isFinite(ms)) return true;
  return ms >= since.getTime() - MAIL_SINCE_SKEW_MS;
}

/**
 * Headers and attachment metadata of a newly arrived inbox message (never the body or attachment bytes).
 * Checked against mail triggers before fetching a message in full.
 */
export interface MailHeader {
  id: string;
  threadId: string;
  /** Normalized RFC 5322 Message-ID when the provider reports it (deduplicates moves across folders/UIDs). */
  messageId?: string | null;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  date: string;
  hasAttachments: boolean;
  /** Attachment metadata when fetched; empty when there are none; null when deferred until needed. */
  attachments: MailHeaderAttachment[] | null;
}

/** Provider-specific high-water mark stored in `mail_cursors.cursor`. */
export type MailProviderCursor =
  | {
      kind: 'gmail';
      historyId: string;
      /** Resumable `messages.list` backfill position until every eligible page since activation/resync is processed. */
      backfill?: { pageToken: string; afterSeconds: number; sinceMs: number };
      /** Resumable `history.list` page position for `startHistoryId` when a poll hits the page or batch cap. */
      paging?: { startHistoryId: string; pageToken: string };
    }
  | {
      kind: 'microsoft';
      deltaLink: string;
      /** Resumable `@odata.nextLink` paging state when an initial or resync delta spans more than one poll's page cap. */
      paging?: { sinceMs?: number; dropHeaders?: boolean };
    }
  | {
      kind: 'imap';
      mailbox: string;
      uidValidity: string;
      lastUid: number;
      /** Resumable backfill window (`lastUid` advances per batch until every eligible UID up to `untilUid` is processed). */
      backfill?: { sinceMs: number; untilUid: number };
    }
  | { kind: 'fake'; seq: number };

export interface MailChangesOptions {
  /** True when at least one trigger on this mailbox checks `attachmentTypes` (fetches attachment metadata only when needed). */
  needAttachmentTypes?: boolean;
  /** Earliest activation time: every provider drops messages received before `since - 5 s`. */
  since?: Date | null;
  /** Last successful poll time to backfill from when a provider cursor expires (falls back to `since`). */
  resyncSince?: Date | null;
}

export interface MailChangesResult {
  cursor: MailProviderCursor;
  /** New inbox messages arrived since the previous cursor, oldest first (headers and attachment metadata only). */
  headers: MailHeader[];
  /** True when an expired or renumbered provider cursor was re-synced from `resyncSince`/`since`. */
  reset?: boolean;
  /** True when more backfill or catch-up batches remain before this mailbox is caught up. */
  more?: boolean;
}

export interface MailOrganizeInput {
  messageIds: string[];
  addLabels: string[];
  removeLabels: string[];
  read?: boolean;
  archive?: boolean;
}

export interface CalendarEventsInput {
  calendarId: string;
  from?: string;
  to?: string;
  query?: string;
  limit: number;
}

export interface FilesCreateInput {
  kind: 'doc' | 'sheet' | 'text';
  name: string;
  content: string;
  folderId?: string;
}

/**
 * Google's services for one account. Every method takes the access token first (from `ConnectionTokens`);
 * inputs are the connector tools' parsed inputs (`MCP_TOOLS` in core), outputs the tools' item shapes.
 */
export interface GoogleWorkspace {
  mailAttachment(
    accessToken: string,
    input: { messageId: string; attachmentId: string },
  ): Promise<import('@whombat/core').ConnectorBinary>;
  filesDownload(accessToken: string, fileId: string): Promise<import('@whombat/core').ConnectorBinary>;
  filesOrganize(
    accessToken: string,
    input: import('@whombat/core').McpToolInput<'files_organize'>,
  ): Promise<DriveFile>;
  /** One cheap call per service (CN-06): Gmail `users.getProfile`, Calendar `calendarList.list?maxResults=1`,
   * Drive `about.get?fields=user` (also for Docs and Sheets, plus their scopes), People
   * `people.connections.list?pageSize=1`. Never throws: the result says what went wrong. */
  checkService(
    accessToken: string,
    service: ConnectorService,
    grantedScopes: readonly string[],
  ): Promise<ConnectionCheck>;

  mailSearch(accessToken: string, input: MailSearchInput): Promise<MailSummary[]>;
  /**
   * Unread mail in the inbox, for Home and the screens: the count in one cheap call (Gmail `labels/INBOX`
   * `messagesUnread`, Graph `mailFolders/inbox` `unreadItemCount`, IMAP `STATUS UNSEEN`) and, with `newest`, that many
   * of the newest unread (only read when there are any). Opens nothing, marks nothing read.
   */
  inboxUnread(accessToken: string, input?: { newest?: number }): Promise<InboxUnread>;
  /**
   * Initial inbox sync (or backfill from `options.since`): returns a provider high-water mark plus any inbox
   * messages received at or after `options.since` (with a 5-second skew margin). Without `since`, emits no headers.
   */
  mailBaseline(accessToken: string, options?: MailChangesOptions): Promise<MailChangesResult>;
  /** New inbox messages since `cursor` (headers and attachment metadata only; bodies are fetched only after a match). */
  mailChanges(
    accessToken: string,
    cursor: MailProviderCursor,
    options?: MailChangesOptions,
  ): Promise<MailChangesResult>;
  /** One message, or every message of a thread (bodies as text, capped at `MAIL_BODY_CAP`). */
  mailRead(accessToken: string, input: { messageId?: string; threadId?: string }): Promise<MailMessage[]>;
  mailDraft(accessToken: string, input: MailDraftInput): Promise<{ draftId: string }>;
  /** What a draft holds (the approval shows recipients, subject and the start of the body). */
  mailGetDraft(accessToken: string, draftId: string): Promise<MailDraftView>;
  mailSendDraft(accessToken: string, draftId: string): Promise<{ messageId: string; threadId: string }>;
  mailOrganize(accessToken: string, input: MailOrganizeInput): Promise<{ updated: number }>;
  /** Moves messages to the trash (the provider's own, where they can be taken back out); how many moved. */
  mailTrash(accessToken: string, input: { messageIds: string[] }): Promise<{ trashed: number }>;

  calendarEvents(accessToken: string, input: CalendarEventsInput): Promise<CalendarEvent[]>;
  /** The event as it is now (its guests decide whether a change asks first). */
  calendarGetEvent(
    accessToken: string,
    input: { calendarId: string; eventId: string },
  ): Promise<CalendarEvent>;
  /** `sendUpdates`: email the guests (invites; only after the person approved). */
  calendarCreateEvent(
    accessToken: string,
    input: { calendarId: string; event: CalendarEventInput; sendUpdates: boolean },
  ): Promise<CalendarEvent>;
  calendarUpdateEvent(
    accessToken: string,
    input: { calendarId: string; eventId: string; patch: CalendarEventPatch; sendUpdates: boolean },
  ): Promise<CalendarEvent>;
  calendarDeleteEvent(
    accessToken: string,
    input: { calendarId: string; eventId: string; sendUpdates: boolean },
  ): Promise<void>;

  filesSearch(accessToken: string, input: { query: string; limit: number }): Promise<DriveFile[]>;
  /** Metadata only (the approval names the file). */
  filesGet(accessToken: string, fileId: string): Promise<DriveFile>;
  /** Docs as Markdown/text, Sheets as CSV of the first sheet, text as text, other types metadata only. */
  filesRead(accessToken: string, fileId: string): Promise<FileContent>;
  filesCreate(accessToken: string, input: FilesCreateInput): Promise<DriveFile>;
  filesShare(accessToken: string, input: { fileId: string; email: string; role: ShareRole }): Promise<void>;
  filesTrash(accessToken: string, fileId: string): Promise<void>;

  docsEdit(
    accessToken: string,
    input: { documentId: string; edits: DocEdit[] },
  ): Promise<{ applied: number }>;
  sheetsRead(
    accessToken: string,
    input: { spreadsheetId: string; range: string },
  ): Promise<{ range: string; values: SheetCell[][] }>;
  sheetsWrite(
    accessToken: string,
    input: { spreadsheetId: string; range: string; values: SheetCell[][] },
  ): Promise<{ range: string; updatedCells: number }>;

  contactsSearch(accessToken: string, input: { query: string; limit: number }): Promise<ContactCard[]>;
}

/* ---------------------------------------------------------------------------------------------- */
/* Tokens                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** Why no access token can be had: no connection, or it needs the person to connect again. */
export class ConnectionUnavailableError extends Error {
  constructor(
    readonly reason: 'not_connected' | 'needs_reauth' | 'no_app',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionUnavailableError';
  }
}

/**
 * Fresh access tokens for an account's connection (CN-05): refreshes when fewer than 60 s are left, one
 * refresh at a time per connection; Google's `invalid_grant` marks the connection `needs_reauth` (reason
 * `testing_expired` when the grant was 6–8 days old and the app is `external`, else `revoked`). Throws
 * `ConnectionUnavailableError`.
 */
export interface ConnectionTokens {
  /**
   * `forceRefresh`: the provider refused the last token (HTTP 401) although it had not expired, so refresh
   * now instead of handing it out again (the connector tools retry a 401 once this way).
   */
  accessFor(
    accountId: string,
    provider: ConnectorProvider,
    options?: { forceRefresh?: boolean },
  ): Promise<string>;
}

/* ---------------------------------------------------------------------------------------------- */
/* The service container entry                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/** `services.google` (services.ts). */
export interface GoogleServices {
  mode: GoogleMode;
  oauth: GoogleOAuth;
  workspace: GoogleWorkspace;
  tokens: ConnectionTokens;
}

/** Thrown by the foundation's stubs until a stream implements the adapter. */
export class ConnectorNotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented yet: ${what}`);
    this.name = 'ConnectorNotImplementedError';
  }
}
