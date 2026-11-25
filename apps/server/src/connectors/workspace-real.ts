/**
 * The real `GoogleWorkspace` (docs/decisions/connectors.md CN-08): plain `fetch` against Gmail v1, Calendar
 * v3, Drive v3, Docs v1, Sheets v4 and People v1, no googleapis SDK. Every URL is checked against
 * `GOOGLE_HOSTS` before the request goes out, redirects are refused (a token never follows one), and each
 * call has a timeout. Google's errors become `GoogleApiError` with a reason (`api_disabled` carries the
 * activation link of a 403 `SERVICE_DISABLED`).
 */
import { randomUUID } from 'node:crypto';
import {
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarEventPatch,
  type CalendarInfo,
  CONNECTOR_BINARY_MAX_BYTES,
  type ConnectionCheck,
  type ConnectorBinary,
  type ConnectorService,
  type ContactCard,
  type DocEdit,
  type DriveFile,
  EVENT_TIMES_MISMATCH_TEXT,
  eventsWindowStart,
  FILE_CONTENT_CAP,
  type FileContent,
  type FileKind,
  type GuestResponse,
  isReservedMailLabel,
  MAIL_BODY_CAP,
  type MailDraftInput,
  type MailMessage,
  type MailSummary,
  type McpToolInput,
  RESERVED_MAIL_LABEL_TEXT,
  type ShareRole,
  type SheetCell,
} from '@whombat/core';
import { badRequest } from '../lib/errors';
import { attachmentDigest, boundedBytes, checkAttachmentTotal } from './binary';
import { checkGoogleService } from './checks';
import { googleApiError, googleFetch, readJson } from './google-http';
import {
  base64UrlEncode,
  buildRawMessage,
  capText,
  decodeEntities,
  extractBody,
  type GmailPart,
  headerOf,
  parseAddressList,
  replyReferences,
  replySubject,
  splitAddressHeader,
} from './mime';
import {
  type CalendarEventsInput,
  type FilesCreateInput,
  type FilesQuota,
  GoogleApiError,
  type GoogleWorkspace,
  type InboxUnread,
  isGoogleUrl,
  MAIL_SINCE_SKEW_MS,
  type MailChangesOptions,
  type MailChangesResult,
  type MailDraftView,
  type MailHeader,
  type MailOrganizeInput,
  type MailProviderCursor,
  type MailSearchInput,
  normalizeRfcMessageId,
  quotaOf,
  type RecentFile,
  receivedAtOrAfter,
} from './types';

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const DOCS_API = 'https://docs.googleapis.com/v1';
export const SHEETS_API = 'https://sheets.googleapis.com/v4';
export const PEOPLE_API = 'https://people.googleapis.com/v1';

/** Most cells `sheets_read` returns (rows × columns). */
export const SHEET_READ_CELL_CAP = 20_000;

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,owners(emailAddress),size,webViewLink';
const DEFAULT_TIMEOUT_MS = 20_000;
/** Parallel metadata fetches for one search. */
const FETCH_CONCURRENCY = 5;

type Query = Record<string, string | number | boolean | undefined | readonly string[]>;

const enc = encodeURIComponent;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** A Google URL with a query; throws before any request for a host outside `GOOGLE_HOSTS`. */
export function googleUrl(base: string, query: Query = {}): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
    else u.searchParams.set(k, String(v));
  }
  const url = u.toString();
  if (!isGoogleUrl(url)) throw new Error(`Refusing to call ${u.host}: not a Google API host.`);
  return url;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* Mapping --------------------------------------------------------------------------------------- */

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

function isoFromMs(ms: string | undefined): string {
  const n = Number(ms);
  return new Date(Number.isFinite(n) && n > 0 ? n : 0).toISOString();
}

function mailSummary(m: GmailMessage, labels: Map<string, string>): MailSummary {
  const ids = m.labelIds ?? [];
  const msgId = clip(m.id, 200);
  return {
    id: msgId,
    threadId: clip(m.threadId || m.id, 200),
    from: clip(headerOf(m.payload, 'From') ?? '', 500),
    to: splitAddressHeader(headerOf(m.payload, 'To')).map((a) => clip(a, 500)),
    subject: clip(headerOf(m.payload, 'Subject') ?? '', 1000),
    snippet: clip(decodeEntities(m.snippet ?? ''), 500),
    date: isoFromMs(m.internalDate),
    unread: ids.includes('UNREAD'),
    labels: ids.map((id) => clip(labels.get(id) ?? id, 200)),
  };
}

function mailMessage(m: GmailMessage, labels: Map<string, string>): MailMessage {
  const body = extractBody(m.payload);
  const capped = capText(body.text, MAIL_BODY_CAP);
  return {
    ...mailSummary(m, labels),
    cc: splitAddressHeader(headerOf(m.payload, 'Cc')).map((a) => clip(a, 500)),
    body: capped.text,
    bodyTruncated: capped.truncated,
    attachments: body.attachments.map((a) => ({
      ...(a.id !== undefined ? { id: clip(a.id, 2048) } : {}),
      name: clip(a.name, 500),
      mimeType: clip(a.mimeType, 200),
      size: Math.max(0, Math.trunc(a.size)),
    })),
  };
}

interface GoogleEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  resource?: boolean;
  organizer?: boolean;
}

interface GoogleEvent {
  recurrence?: string[];
  /** Set on one occurrence of a repeating event (lists with `singleEvents`). */
  recurringEventId?: string;
  status?: string;
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  attendees?: GoogleAttendee[];
  organizer?: { email?: string; self?: boolean };
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

const RESPONSES: Record<string, GuestResponse> = {
  needsAction: 'needs_action',
  accepted: 'accepted',
  tentative: 'tentative',
  declined: 'declined',
};

function httpsUrl(url: string | undefined): string | null {
  if (!url || url.length > 2048) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The guests of an event: attendees other than the calendar's owner and rooms. */
function guestsOf(e: GoogleEvent): GoogleAttendee[] {
  return (e.attendees ?? []).filter((a) => a.email && !a.self && !a.resource);
}

function calendarEvent(e: GoogleEvent, calendarId: string): CalendarEvent {
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  return {
    ...(e.recurrence ? { recurrence: e.recurrence } : {}),
    id: e.id,
    calendarId,
    summary: clip(e.summary ?? '', 1000),
    description: clip(e.description ?? '', 20_000),
    location: clip(e.location ?? '', 1000),
    start: e.start?.dateTime ?? e.start?.date ?? '1970-01-01',
    end: e.end?.dateTime ?? e.end?.date ?? e.start?.dateTime ?? e.start?.date ?? '1970-01-01',
    allDay: Boolean(e.start?.date && !e.start.dateTime),
    guests: guestsOf(e).map((a) => ({
      email: clip((a.email ?? '').toLowerCase(), 320),
      name: a.displayName ? clip(a.displayName, 200) : null,
      response: RESPONSES[a.responseStatus ?? ''] ?? 'needs_action',
    })),
    organizer: e.organizer?.email ?? null,
    webUrl: httpsUrl(e.htmlLink),
    meetUrl: httpsUrl(e.hangoutLink ?? video),
    ...(e.recurringEventId ? { recurring: true } : {}),
    ...ownResponse(e),
    ...(e.status === 'cancelled' ? { cancelled: true } : {}),
  };
}

/** The person's own answer (looks-ahead.md): they organise it, or their place on its guest list; none when neither. */
function ownResponse(e: GoogleEvent): { response?: GuestResponse } {
  if (e.organizer?.self) return { response: 'accepted' };
  const self = e.attendees?.find((a) => a.self);
  return self ? { response: RESPONSES[self.responseStatus ?? ''] ?? 'needs_action' } : {};
}

interface GoogleCalendarListEntry {
  id?: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  accessRole?: string;
  hidden?: boolean;
  selected?: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A start or end for Google. A patch merges nested objects, so it clears the other kind explicitly (IN-24):
 * an all-day date nulls `dateTime` and `timeZone`, a date-time nulls `date`, or a timed event could not become
 * all-day (and back).
 */
function eventTime(t: string, timeZone: string | undefined, patch: boolean): Record<string, string | null> {
  if (DATE_ONLY.test(t)) return patch ? { date: t, dateTime: null, timeZone: null } : { date: t };
  return { dateTime: t, ...(timeZone ? { timeZone } : {}), ...(patch ? { date: null } : {}) };
}

/** An event body for insert / patch: only the fields given; `attendees` built by the caller. */
function eventBody(input: CalendarEventPatch, patch = false): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.recurrence !== undefined) body.recurrence = input.recurrence;
  if (input.summary !== undefined) body.summary = input.summary;
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.start !== undefined) body.start = eventTime(input.start, input.timeZone, patch);
  if (input.end !== undefined) body.end = eventTime(input.end, input.timeZone, patch);
  if (input.addMeet)
    body.conferenceData = {
      createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  return body;
}

/** Drive's `User` as `lastModifyingUser` gives it. */
interface GoogleUser {
  displayName?: string;
  me?: boolean;
}

interface GoogleFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  owners?: { emailAddress?: string }[];
  size?: string;
  webViewLink?: string;
}

const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/x-sh',
  'application/sql',
]);

export function fileKind(mimeType: string): FileKind {
  switch (mimeType) {
    case 'application/vnd.google-apps.document':
      return 'doc';
    case 'application/vnd.google-apps.spreadsheet':
      return 'sheet';
    case 'application/vnd.google-apps.presentation':
      return 'slides';
    case 'application/vnd.google-apps.folder':
      return 'folder';
    case 'application/pdf':
      return 'pdf';
  }
  if (mimeType.startsWith('text/') || TEXT_TYPES.has(mimeType)) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  return 'other';
}

function driveFile(f: GoogleFile): DriveFile {
  const mimeType = f.mimeType ?? 'application/octet-stream';
  const size = f.size !== undefined ? Number(f.size) : Number.NaN;
  return {
    id: f.id,
    name: clip(f.name ?? '', 1000),
    kind: fileKind(mimeType),
    mimeType: clip(mimeType, 200),
    modifiedAt: f.modifiedTime ?? null,
    owners: (f.owners ?? []).map((o) => o.emailAddress ?? '').filter(Boolean),
    size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : null,
    webUrl: httpsUrl(f.webViewLink),
  };
}

/** Drive's query for plain words: every word in the name or the content, not in the trash. */
export function driveQuery(words: string): string {
  const terms = words
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((w) => w.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))
    .map((w) => `(name contains '${w}' or fullText contains '${w}')`);
  return [...terms, 'trashed = false'].join(' and ');
}

interface GooglePerson {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  organizations?: { name?: string }[];
}

function contactCard(p: GooglePerson): ContactCard {
  const emails = (p.emailAddresses ?? []).map((e) => clip(e.value ?? '', 320)).filter(Boolean);
  return {
    name: clip(p.names?.[0]?.displayName ?? emails[0] ?? '', 500),
    emails,
    phones: (p.phoneNumbers ?? []).map((e) => clip(e.value ?? '', 100)).filter(Boolean),
    organization: p.organizations?.[0]?.name ? clip(p.organizations[0].name, 500) : null,
  };
}

/* The adapter ----------------------------------------------------------------------------------- */

export interface RealWorkspaceOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface RequestOptions {
  query?: Query;
  json?: unknown;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export class RealGoogleWorkspace implements GoogleWorkspace {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RealWorkspaceOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async send(token: string, method: string, base: string, o: RequestOptions = {}): Promise<Response> {
    const url = googleUrl(base, o.query);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...o.headers };
    let body: string | undefined;
    if (o.json !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(o.json);
    } else if (o.body !== undefined) {
      headers['content-type'] = o.contentType ?? 'text/plain; charset=utf-8';
      body = o.body;
    }
    const res = await googleFetch(this.fetchImpl, url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw googleApiError(res.status, await readJson(res));
    return res;
  }

  private async json<T>(token: string, method: string, base: string, o: RequestOptions = {}): Promise<T> {
    const res = await this.send(token, method, base, o);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /* Checks ------------------------------------------------------------------------------------- */

  async checkService(
    accessToken: string,
    service: ConnectorService,
    grantedScopes: readonly string[],
  ): Promise<ConnectionCheck> {
    // One implementation of the service checks (CN-06), shared with Settings → Connections.
    return checkGoogleService(accessToken, service, grantedScopes, this.fetchImpl);
  }

  /* Mail --------------------------------------------------------------------------------------- */

  private async labels(token: string): Promise<GmailLabel[]> {
    const res = await this.json<{ labels?: GmailLabel[] }>(token, 'GET', `${GMAIL_API}/labels`);
    return res.labels ?? [];
  }

  private async labelNames(token: string): Promise<Map<string, string>> {
    return new Map((await this.labels(token)).map((l) => [l.id, l.name]));
  }

  async mailSearch(accessToken: string, input: MailSearchInput): Promise<MailSummary[]> {
    const list = await this.json<{ messages?: { id: string; threadId: string }[] }>(
      accessToken,
      'GET',
      `${GMAIL_API}/messages`,
      { query: { q: input.query.trim() || undefined, maxResults: input.limit } },
    );
    const ids = (list.messages ?? []).slice(0, input.limit);
    if (ids.length === 0) return [];
    const labels = await this.labelNames(accessToken);
    const messages = await mapLimit(ids, FETCH_CONCURRENCY, (m) =>
      this.json<GmailMessage>(accessToken, 'GET', `${GMAIL_API}/messages/${enc(m.id)}`, {
        query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] },
      }),
    );
    return messages.map((m) => mailSummary(m, labels));
  }

  async inboxUnread(accessToken: string, input: { newest?: number } = {}): Promise<InboxUnread> {
    // users.labels.get: the system INBOX label carries its own unread count, so nothing is listed to count it.
    const inbox = await this.json<{ messagesUnread?: number }>(
      accessToken,
      'GET',
      `${GMAIL_API}/labels/INBOX`,
    );
    const count = Math.max(0, Number(inbox.messagesUnread) || 0);
    const newest =
      count > 0 && (input.newest ?? 0) > 0
        ? await this.mailSearch(accessToken, { query: 'is:unread in:inbox', limit: input.newest ?? 0 })
        : [];
    return { count, newest };
  }

  private async fetchGmailHeaders(
    accessToken: string,
    ids: readonly string[],
    since?: Date | null,
  ): Promise<MailHeader[]> {
    if (ids.length === 0) return [];
    // Partial response omits body.data so Gmail sends only headers, snippet and attachment metadata.
    const partFields = 'partId,mimeType,filename,body/size,body/attachmentId';
    const fields = `id,threadId,internalDate,labelIds,snippet,payload(headers,${partFields},parts(${partFields},parts(${partFields},parts(${partFields}))))`;
    const fetched = await mapLimit(ids, FETCH_CONCURRENCY, async (id) => {
      try {
        return await this.json<GmailMessage>(accessToken, 'GET', `${GMAIL_API}/messages/${enc(id)}`, {
          query: { format: 'full', fields },
        });
      } catch (err) {
        if (err instanceof GoogleApiError && err.status === 404) return null;
        throw err;
      }
    });
    const headers: MailHeader[] = [];
    for (const m of fetched) {
      if (!m) continue;
      const ids = m.labelIds ?? [];
      if (!ids.includes('INBOX') || ids.includes('DRAFT') || ids.includes('TRASH') || ids.includes('SPAM'))
        continue;
      const dateIso = isoFromMs(m.internalDate);
      if (!receivedAtOrAfter(dateIso, since)) continue;
      const attachments = extractBody(m.payload).attachments.map((a) => ({
        ...(a.id !== undefined ? { id: a.id } : {}),
        name: clip(a.name, 500),
        mimeType: clip(a.mimeType, 200),
        size: a.size,
      }));
      headers.push({
        id: m.id,
        threadId: m.threadId,
        messageId: normalizeRfcMessageId(headerOf(m.payload, 'Message-ID')),
        from: clip(headerOf(m.payload, 'From') ?? '', 500),
        to: splitAddressHeader(headerOf(m.payload, 'To')).map((a) => clip(a, 500)),
        subject: clip(headerOf(m.payload, 'Subject') ?? '', 1000),
        snippet: clip(decodeEntities(m.snippet ?? ''), 500),
        date: dateIso,
        hasAttachments: attachments.length > 0,
        attachments,
      });
    }
    headers.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    return headers;
  }

  private async gmailBackfillPage(
    accessToken: string,
    historyId: string,
    afterSeconds: number,
    sinceMs: number,
    pageToken?: string,
  ): Promise<MailChangesResult> {
    const list = await this.json<{ messages?: { id: string }[]; nextPageToken?: string }>(
      accessToken,
      'GET',
      `${GMAIL_API}/messages`,
      {
        query: {
          labelIds: 'INBOX',
          q: `after:${afterSeconds}`,
          maxResults: 50,
          ...(pageToken ? { pageToken } : {}),
        },
      },
    );
    const ids = (list.messages ?? []).map((m) => m.id);
    const headers = await this.fetchGmailHeaders(accessToken, ids, new Date(sinceMs));
    const nextToken = list.nextPageToken?.trim() || undefined;
    if (nextToken && nextToken !== pageToken) {
      return {
        cursor: {
          kind: 'gmail',
          historyId,
          backfill: { pageToken: nextToken, afterSeconds, sinceMs },
        },
        headers,
        more: true,
      };
    }
    return { cursor: { kind: 'gmail', historyId }, headers };
  }

  async mailBaseline(accessToken: string, options: MailChangesOptions = {}): Promise<MailChangesResult> {
    // Capture the current historyId first so mail arriving during backfill is still caught by the next history poll.
    const profile = await this.json<{ historyId?: string | number }>(
      accessToken,
      'GET',
      `${GMAIL_API}/profile`,
      { query: { fields: 'historyId' } },
    );
    const historyId = String(profile.historyId ?? '0');
    if (!options.since) return { cursor: { kind: 'gmail', historyId }, headers: [] };
    // Pad Gmail's whole-second `after:` search slightly and enforce the exact 5 s skew margin on `internalDate`.
    const afterSeconds = Math.max(0, Math.floor((options.since.getTime() - MAIL_SINCE_SKEW_MS) / 1000) - 60);
    return this.gmailBackfillPage(accessToken, historyId, afterSeconds, options.since.getTime());
  }

  async mailChanges(
    accessToken: string,
    cursor: MailProviderCursor,
    options: MailChangesOptions = {},
  ): Promise<MailChangesResult> {
    const resyncSince = options.resyncSince ?? options.since ?? null;
    if (cursor.kind !== 'gmail') {
      return { ...(await this.mailBaseline(accessToken, { ...options, since: resyncSince })), reset: true };
    }
    if (cursor.backfill) {
      const { pageToken, afterSeconds, sinceMs } = cursor.backfill;
      try {
        return await this.gmailBackfillPage(accessToken, cursor.historyId, afterSeconds, sinceMs, pageToken);
      } catch (err) {
        // Stale or invalid backfill pageTokens return HTTP 400 (and 404/410 on expired state): restart backfill
        // from `sinceMs`; message deduplication makes re-scanning safe. Other statuses propagate without looping.
        if (
          err instanceof GoogleApiError &&
          (err.status === 400 || err.status === 404 || err.status === 410)
        ) {
          return {
            ...(await this.mailBaseline(accessToken, { ...options, since: new Date(sinceMs) })),
            reset: true,
          };
        }
        throw err;
      }
    }
    const startHistoryId = cursor.paging?.startHistoryId ?? cursor.historyId;
    const addedIds: string[] = [];
    const seen = new Set<string>();
    let nextHistoryId = cursor.historyId;
    let lastIncludedHistoryId: string | null = null;
    let truncated = false;
    let pageToken: string | undefined = cursor.paging?.pageToken;
    let nextPageTokenForResume: string | undefined;
    const seenTokens = new Set<string>(pageToken ? [pageToken] : []);
    try {
      for (let page = 0; page < 5; page++) {
        const res = await this.json<{
          historyId?: string | number;
          nextPageToken?: string;
          history?: {
            id?: string | number;
            messagesAdded?: { message?: { id?: string; labelIds?: string[] } }[];
          }[];
        }>(accessToken, 'GET', `${GMAIL_API}/history`, {
          query: {
            startHistoryId,
            historyTypes: 'messageAdded',
            labelId: 'INBOX',
            maxResults: 100,
            ...(pageToken ? { pageToken } : {}),
          },
        });
        if (res.historyId !== undefined) nextHistoryId = String(res.historyId);
        let brokeMidPage = false;
        for (const h of res.history ?? []) {
          if (
            addedIds.length >= 50 &&
            lastIncludedHistoryId !== null &&
            lastIncludedHistoryId !== startHistoryId &&
            lastIncludedHistoryId !== cursor.historyId
          ) {
            truncated = true;
            brokeMidPage = true;
            break;
          }
          for (const added of h.messagesAdded ?? []) {
            const msg = added.message;
            if (!msg?.id || seen.has(msg.id)) continue;
            const labels = msg.labelIds ?? [];
            if (labels.includes('DRAFT') || labels.includes('TRASH') || labels.includes('SPAM')) continue;
            seen.add(msg.id);
            addedIds.push(msg.id);
          }
          if (h.id !== undefined) lastIncludedHistoryId = String(h.id);
        }
        if (brokeMidPage) break;
        const candidateNext = res.nextPageToken?.trim() || undefined;
        if (!candidateNext || seenTokens.has(candidateNext)) break;
        seenTokens.add(candidateNext);
        if (page === 4 || addedIds.length >= 50) {
          truncated = true;
          nextPageTokenForResume = candidateNext;
          break;
        }
        pageToken = candidateNext;
      }
    } catch (err) {
      // History IDs or pageTokens expire/become invalid (HTTP 404/400/410): resync from last successful poll time.
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 400 || err.status === 410)) {
        return { ...(await this.mailBaseline(accessToken, { ...options, since: resyncSince })), reset: true };
      }
      throw err;
    }
    const headers = await this.fetchGmailHeaders(accessToken, addedIds, options.since);
    if (nextPageTokenForResume) {
      return {
        cursor: {
          kind: 'gmail',
          historyId: lastIncludedHistoryId ?? cursor.historyId,
          paging: { startHistoryId, pageToken: nextPageTokenForResume },
        },
        headers,
        more: true,
      };
    }
    const finalHistoryId = truncated ? (lastIncludedHistoryId ?? cursor.historyId) : nextHistoryId;
    return {
      cursor: { kind: 'gmail', historyId: finalHistoryId },
      headers,
      ...(truncated && finalHistoryId !== cursor.historyId ? { more: true } : {}),
    };
  }

  async mailRead(
    accessToken: string,
    input: { messageId?: string; threadId?: string },
  ): Promise<MailMessage[]> {
    const labels = await this.labelNames(accessToken);
    if (input.threadId) {
      const thread = await this.json<{ messages?: GmailMessage[] }>(
        accessToken,
        'GET',
        `${GMAIL_API}/threads/${enc(input.threadId)}`,
        { query: { format: 'full' } },
      );
      return (thread.messages ?? []).map((m) => mailMessage(m, labels));
    }
    const m = await this.json<GmailMessage>(
      accessToken,
      'GET',
      `${GMAIL_API}/messages/${enc(input.messageId ?? '')}`,
      { query: { format: 'full' } },
    );
    return [mailMessage(m, labels)];
  }

  async mailDraft(accessToken: string, input: MailDraftInput): Promise<{ draftId: string }> {
    checkAttachmentTotal(input.attachments ?? []);
    let threadId: string | undefined;
    let subject = input.subject;
    let inReplyTo: string | null = null;
    let references: string | null = null;
    if (input.replyToMessageId) {
      const original = await this.json<GmailMessage>(
        accessToken,
        'GET',
        `${GMAIL_API}/messages/${enc(input.replyToMessageId)}`,
        { query: { format: 'metadata', metadataHeaders: ['Message-ID', 'References', 'Subject'] } },
      );
      threadId = original.threadId;
      inReplyTo = headerOf(original.payload, 'Message-ID');
      references = replyReferences(headerOf(original.payload, 'References'), inReplyTo);
      if (!subject.trim()) subject = replySubject(headerOf(original.payload, 'Subject') ?? '');
    }
    const raw = buildRawMessage({
      ...(input.attachments ? { attachments: input.attachments } : {}),
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject,
      body: input.body,
      inReplyTo,
      references,
    });
    const draft = await this.json<{ id: string }>(accessToken, 'POST', `${GMAIL_API}/drafts`, {
      json: { message: { raw: base64UrlEncode(raw), ...(threadId ? { threadId } : {}) } },
    });
    return { draftId: draft.id };
  }

  async mailGetDraft(accessToken: string, draftId: string): Promise<MailDraftView> {
    const draft = await this.json<{ id: string; message?: GmailMessage }>(
      accessToken,
      'GET',
      `${GMAIL_API}/drafts/${enc(draftId)}`,
      { query: { format: 'full' } },
    );
    const payload = draft.message?.payload;
    const binaries: ConnectorBinary[] = [];
    for (const part of this.attachmentParts(payload)) {
      if (!draft.message?.id) throw badRequest('The draft has no message id.');
      binaries.push(await this.readMailPart(accessToken, draft.message.id, part));
      checkAttachmentTotal(binaries);
    }
    return {
      ...(binaries.length ? { attachments: binaries.map(attachmentDigest) } : {}),
      draftId: draft.id,
      threadId: draft.message?.threadId ?? null,
      to: parseAddressList(headerOf(payload, 'To')),
      cc: parseAddressList(headerOf(payload, 'Cc')),
      bcc: parseAddressList(headerOf(payload, 'Bcc')),
      subject: headerOf(payload, 'Subject') ?? '',
      body: extractBody(payload).text,
    };
  }

  async mailSendDraft(
    accessToken: string,
    draftId: string,
  ): Promise<{ messageId: string; threadId: string }> {
    const sent = await this.json<{ id: string; threadId: string }>(
      accessToken,
      'POST',
      `${GMAIL_API}/drafts/send`,
      {
        json: { id: draftId },
      },
    );
    return { messageId: sent.id, threadId: sent.threadId };
  }

  async mailOrganize(accessToken: string, input: MailOrganizeInput): Promise<{ updated: number }> {
    const labels = await this.labels(accessToken);
    const find = (name: string) => {
      const label = labels.find((l) => l.id === name || l.name.toLowerCase() === name.trim().toLowerCase());
      // The tool's schema refuses these already; Trash and Spam delete mail, which always asks (IN-15).
      if (
        isReservedMailLabel(name) ||
        (label && (isReservedMailLabel(label.id) || isReservedMailLabel(label.name)))
      )
        throw badRequest(RESERVED_MAIL_LABEL_TEXT);
      return label;
    };
    const add = new Set<string>();
    const remove = new Set<string>();
    for (const name of input.addLabels) {
      let label = find(name);
      if (!label) {
        label = await this.json<GmailLabel>(accessToken, 'POST', `${GMAIL_API}/labels`, {
          json: { name: name.trim(), labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        });
        labels.push(label);
      }
      add.add(label.id);
    }
    for (const name of input.removeLabels) {
      const label = find(name);
      if (label) remove.add(label.id);
    }
    if (input.read === true) remove.add('UNREAD');
    if (input.read === false) add.add('UNREAD');
    if (input.archive === true) remove.add('INBOX');
    if (input.archive === false) add.add('INBOX');
    if (add.size === 0 && remove.size === 0) return { updated: 0 };
    await this.send(accessToken, 'POST', `${GMAIL_API}/messages/batchModify`, {
      json: { ids: input.messageIds, addLabelIds: [...add], removeLabelIds: [...remove] },
    });
    return { updated: input.messageIds.length };
  }

  async mailTrash(accessToken: string, input: { messageIds: string[] }): Promise<{ trashed: number }> {
    // One call each: Gmail's own trash (kept 30 days), which `gmail.modify` allows; deleting for good would need more.
    for (const id of input.messageIds)
      await this.send(accessToken, 'POST', `${GMAIL_API}/messages/${enc(id)}/trash`);
    return { trashed: input.messageIds.length };
  }

  /* Calendar ----------------------------------------------------------------------------------- */

  private eventsUrl(calendarId: string, eventId?: string): string {
    const base = `${CALENDAR_API}/calendars/${enc(calendarId)}/events`;
    return eventId ? `${base}/${enc(eventId)}` : base;
  }

  async calendarEvents(accessToken: string, input: CalendarEventsInput): Promise<CalendarEvent[]> {
    const res = await this.json<{ items?: GoogleEvent[] }>(
      accessToken,
      'GET',
      this.eventsUrl(input.calendarId),
      {
        query: {
          // Without a start, upcoming events (Calendar lists from the beginning of time otherwise), or the
          // month before a past end.
          timeMin: eventsWindowStart(input, new Date()),
          timeMax: input.to,
          q: input.query?.trim() || undefined,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: input.limit,
        },
      },
    );
    return (res.items ?? []).slice(0, input.limit).map((e) => calendarEvent(e, input.calendarId));
  }

  async calendarList(accessToken: string): Promise<CalendarInfo[]> {
    const res = await this.json<{ items?: GoogleCalendarListEntry[] }>(
      accessToken,
      'GET',
      `${CALENDAR_API}/users/me/calendarList`,
      { query: { maxResults: 100 } },
    );
    return (res.items ?? []).flatMap((c) =>
      c.id
        ? [
            {
              id: c.primary ? 'primary' : clip(c.id, 1024),
              name: clip(c.summaryOverride || c.summary || c.id, 200),
              primary: !!c.primary,
              writable: c.accessRole === 'owner' || c.accessRole === 'writer',
              // Hidden from the list, or not shown in Calendar's own view.
              hidden: !!c.hidden || c.selected === false,
            },
          ]
        : [],
    );
  }

  private async googleEvent(token: string, calendarId: string, eventId: string): Promise<GoogleEvent> {
    return this.json<GoogleEvent>(token, 'GET', this.eventsUrl(calendarId, eventId));
  }

  async calendarGetEvent(
    accessToken: string,
    input: { calendarId: string; eventId: string },
  ): Promise<CalendarEvent> {
    return calendarEvent(
      await this.googleEvent(accessToken, input.calendarId, input.eventId),
      input.calendarId,
    );
  }

  async calendarCreateEvent(
    accessToken: string,
    input: { calendarId: string; event: CalendarEventInput; sendUpdates: boolean },
  ): Promise<CalendarEvent> {
    const body = eventBody(input.event);
    if (input.event.guests.length) body.attendees = input.event.guests.map((email) => ({ email }));
    const created = await this.json<GoogleEvent>(accessToken, 'POST', this.eventsUrl(input.calendarId), {
      query: {
        sendUpdates: input.sendUpdates ? 'all' : 'none',
        conferenceDataVersion: input.event.addMeet ? 1 : undefined,
      },
      json: body,
    });
    return calendarEvent(created, input.calendarId);
  }

  async calendarUpdateEvent(
    accessToken: string,
    input: { calendarId: string; eventId: string; patch: CalendarEventPatch; sendUpdates: boolean },
  ): Promise<CalendarEvent> {
    const body = eventBody(input.patch, true);
    const { start, end } = input.patch;
    // Only one end changes kind (all-day ↔ timed): the stored other end would not match it (IN-24).
    const lone =
      start !== undefined && end === undefined
        ? start
        : end !== undefined && start === undefined
          ? end
          : null;
    const existing =
      input.patch.guests || lone !== null
        ? await this.googleEvent(accessToken, input.calendarId, input.eventId)
        : null;
    if (existing && lone !== null) {
      const other = start !== undefined ? existing.end : existing.start;
      if (other && Boolean(other.date) !== DATE_ONLY.test(lone)) throw badRequest(EVENT_TIMES_MISMATCH_TEXT);
    }
    if (existing && input.patch.guests) {
      // Keep the owner's own entry and the answers of guests who stay; add the new ones.
      const wanted = new Set(input.patch.guests);
      const kept = (existing.attendees ?? []).filter(
        (a) => a.self || a.resource || (a.email && wanted.has(a.email.toLowerCase())),
      );
      const have = new Set(kept.map((a) => a.email?.toLowerCase()));
      body.attendees = [
        ...kept,
        ...input.patch.guests.filter((g) => !have.has(g)).map((email) => ({ email })),
      ];
    }
    const updated = await this.json<GoogleEvent>(
      accessToken,
      'PATCH',
      this.eventsUrl(input.calendarId, input.eventId),
      {
        query: {
          sendUpdates: input.sendUpdates ? 'all' : 'none',
          conferenceDataVersion: input.patch.addMeet ? 1 : undefined,
        },
        json: body,
      },
    );
    return calendarEvent(updated, input.calendarId);
  }

  async calendarDeleteEvent(
    accessToken: string,
    input: { calendarId: string; eventId: string; sendUpdates: boolean },
  ): Promise<void> {
    await this.send(accessToken, 'DELETE', this.eventsUrl(input.calendarId, input.eventId), {
      query: { sendUpdates: input.sendUpdates ? 'all' : 'none' },
    });
  }

  /* Drive -------------------------------------------------------------------------------------- */

  private attachmentParts(payload: GmailPart | undefined): GmailPart[] {
    if (!payload) return [];
    return [
      ...(payload.filename ? [payload] : []),
      ...(payload.parts ?? []).flatMap((p) => this.attachmentParts(p)),
    ];
  }

  private async readMailPart(token: string, messageId: string, part: GmailPart): Promise<ConnectorBinary> {
    if ((part.body?.size ?? 0) > CONNECTOR_BINARY_MAX_BYTES)
      throw badRequest('The attachment exceeds 10 MB.');
    let data = part.body?.data;
    if (part.body?.attachmentId) {
      const response = await this.send(
        token,
        'GET',
        `${GMAIL_API}/messages/${enc(messageId)}/attachments/${enc(part.body.attachmentId)}`,
      );
      const body = JSON.parse(
        (await boundedBytes(response, Math.ceil(CONNECTOR_BINARY_MAX_BYTES / 3) * 4 + 1024)).toString('utf8'),
      ) as { data?: string };
      data = body.data;
    }
    if (data === undefined) throw badRequest('The attachment has no downloadable content.');
    const bytes = Buffer.from(data, 'base64url');
    if (bytes.length > CONNECTOR_BINARY_MAX_BYTES) throw badRequest('The attachment exceeds 10 MB.');
    return {
      name: part.filename ?? 'attachment',
      mimeType: part.mimeType ?? 'application/octet-stream',
      contentBase64: bytes.toString('base64'),
    };
  }

  async mailAttachment(
    token: string,
    input: { messageId: string; attachmentId: string },
  ): Promise<ConnectorBinary> {
    const message = await this.json<GmailMessage>(
      token,
      'GET',
      `${GMAIL_API}/messages/${enc(input.messageId)}`,
      { query: { format: 'full' } },
    );
    const part = this.attachmentParts(message.payload).find((p) => p.partId === input.attachmentId);
    if (!part) throw new GoogleApiError(404, 'Attachment not found on this message.', 'not_found');
    return this.readMailPart(token, input.messageId, part);
  }

  async filesDownload(token: string, fileId: string): Promise<ConnectorBinary> {
    const file = await this.filesGet(token, fileId);
    if (file.mimeType.startsWith('application/vnd.google-apps.'))
      throw badRequest('Use files_read for a native Google document.');
    if ((file.size ?? 0) > CONNECTOR_BINARY_MAX_BYTES) throw badRequest('The file exceeds 10 MB.');
    const response = await this.send(token, 'GET', `${DRIVE_API}/files/${enc(fileId)}`, {
      query: { alt: 'media', supportsAllDrives: true },
    });
    return {
      name: file.name,
      mimeType: file.mimeType,
      contentBase64: (await boundedBytes(response)).toString('base64'),
    };
  }

  async filesOrganize(token: string, input: McpToolInput<'files_organize'>): Promise<DriveFile> {
    const query: Query = { fields: FILE_FIELDS, supportsAllDrives: true };
    const json: Record<string, unknown> = {};
    if (input.name) json.name = input.name;
    let method = 'POST';
    let url = `${DRIVE_API}/files`;
    if (input.action === 'folder') {
      json.mimeType = 'application/vnd.google-apps.folder';
      if (input.folderId) json.parents = [input.folderId];
    } else if (input.action === 'copy') {
      url += `/${enc(input.fileId ?? '')}/copy`;
      if (input.folderId) json.parents = [input.folderId];
    } else {
      method = 'PATCH';
      url += `/${enc(input.fileId ?? '')}`;
      if (input.action === 'move') {
        const before = await this.json<{ parents?: string[] }>(token, 'GET', url, {
          query: { fields: 'parents', supportsAllDrives: true },
        });
        query.addParents = input.folderId;
        if (before.parents?.length) query.removeParents = before.parents.join(',');
      }
    }
    return driveFile(await this.json<GoogleFile>(token, method, url, { query, json }));
  }

  async filesSearch(accessToken: string, input: { query: string; limit: number }): Promise<DriveFile[]> {
    const res = await this.json<{ files?: GoogleFile[] }>(accessToken, 'GET', `${DRIVE_API}/files`, {
      query: {
        q: driveQuery(input.query),
        pageSize: input.limit,
        fields: `files(${FILE_FIELDS})`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });
    return (res.files ?? []).slice(0, input.limit).map(driveFile);
  }

  async filesGet(accessToken: string, fileId: string): Promise<DriveFile> {
    return driveFile(
      await this.json<GoogleFile>(accessToken, 'GET', `${DRIVE_API}/files/${enc(fileId)}`, {
        query: { fields: FILE_FIELDS, supportsAllDrives: true },
      }),
    );
  }

  private async exportText(token: string, fileId: string, mimeType: string): Promise<string> {
    const res = await this.send(token, 'GET', `${DRIVE_API}/files/${enc(fileId)}/export`, {
      query: { mimeType },
    });
    return res.text();
  }

  async filesRead(accessToken: string, fileId: string): Promise<FileContent> {
    const file = await this.filesGet(accessToken, fileId);
    let format: FileContent['format'] = 'none';
    let text: string | null = null;
    let cut = false;
    if (file.kind === 'doc') {
      format = 'markdown';
      try {
        text = await this.exportText(accessToken, fileId, 'text/markdown');
      } catch (err) {
        // Older exports lack Markdown: plain text still reads well.
        if (!(err instanceof GoogleApiError) || err.status !== 400) throw err;
        format = 'text';
        text = await this.exportText(accessToken, fileId, 'text/plain');
      }
    } else if (file.kind === 'sheet') {
      format = 'csv';
      text = await this.exportText(accessToken, fileId, 'text/csv');
    } else if (file.kind === 'text') {
      format = 'text';
      // Up to four bytes per character: enough bytes for the cap, not the whole file.
      const bytes = FILE_CONTENT_CAP * 4;
      const res = await this.send(accessToken, 'GET', `${DRIVE_API}/files/${enc(fileId)}`, {
        query: { alt: 'media', supportsAllDrives: true },
        headers: { range: `bytes=0-${bytes - 1}` },
      });
      text = await res.text();
      cut = file.size !== null && file.size > bytes;
    }
    if (text === null) return { file, format: 'none', content: null, truncated: false };
    const capped = capText(text.replace(/^﻿/, ''), FILE_CONTENT_CAP);
    return { file, format, content: capped.text, truncated: capped.truncated || cut };
  }

  async filesCreate(accessToken: string, input: FilesCreateInput): Promise<DriveFile> {
    const target = {
      doc: { mimeType: 'application/vnd.google-apps.document', media: 'text/markdown' },
      sheet: { mimeType: 'application/vnd.google-apps.spreadsheet', media: 'text/csv' },
      text: { mimeType: 'text/plain', media: 'text/plain' },
    }[input.kind];
    const metadata = {
      name: input.name,
      mimeType: target.mimeType,
      ...(input.folderId ? { parents: [input.folderId] } : {}),
    };
    const boundary = `whombat-${randomUUID()}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${target.media}; charset=UTF-8`,
      '',
      input.content,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const created = await this.json<GoogleFile>(accessToken, 'POST', `${DRIVE_UPLOAD_API}/files`, {
      query: { uploadType: 'multipart', fields: FILE_FIELDS, supportsAllDrives: true },
      body,
      contentType: `multipart/related; boundary=${boundary}`,
    });
    return driveFile(created);
  }

  async filesShare(
    accessToken: string,
    input: { fileId: string; email: string; role: ShareRole },
  ): Promise<void> {
    await this.json(accessToken, 'POST', `${DRIVE_API}/files/${enc(input.fileId)}/permissions`, {
      query: { sendNotificationEmail: true, supportsAllDrives: true },
      json: { type: 'user', role: input.role, emailAddress: input.email },
    });
  }

  async filesTrash(accessToken: string, fileId: string): Promise<void> {
    await this.json(accessToken, 'PATCH', `${DRIVE_API}/files/${enc(fileId)}`, {
      query: { supportsAllDrives: true, fields: 'id,trashed' },
      json: { trashed: true },
    });
  }

  async filesQuota(accessToken: string): Promise<FilesQuota> {
    const res = await this.json<{ storageQuota?: { limit?: string; usage?: string } }>(
      accessToken,
      'GET',
      `${DRIVE_API}/about`,
      { query: { fields: 'storageQuota(limit,usage)' } },
    );
    return quotaOf(res.storageQuota?.usage, res.storageQuota?.limit);
  }

  async filesRecent(accessToken: string, input: { limit: number }): Promise<RecentFile[]> {
    const limit = Math.min(Math.max(1, input.limit), 20);
    const res = await this.json<{ files?: (GoogleFile & { lastModifyingUser?: GoogleUser })[] }>(
      accessToken,
      'GET',
      `${DRIVE_API}/files`,
      {
        query: {
          q: 'trashed = false',
          orderBy: 'modifiedTime desc',
          pageSize: limit,
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink,lastModifyingUser(displayName,me))',
        },
      },
    );
    return (res.files ?? []).slice(0, limit).map((f) => ({
      id: f.id,
      name: clip(f.name ?? '', 200),
      kind: fileKind(f.mimeType ?? 'application/octet-stream'),
      modifiedAt: f.modifiedTime ?? null,
      by: f.lastModifyingUser?.displayName ? clip(f.lastModifyingUser.displayName, 120) : null,
      byMe: f.lastModifyingUser?.me === true,
      webUrl: httpsUrl(f.webViewLink),
    }));
  }

  /* Docs and Sheets ---------------------------------------------------------------------------- */

  async docsEdit(
    accessToken: string,
    input: { documentId: string; edits: DocEdit[] },
  ): Promise<{ applied: number }> {
    const requests = input.edits.map((e) =>
      e.op === 'append'
        ? { insertText: { endOfSegmentLocation: {}, text: e.text } }
        : { replaceAllText: { containsText: { text: e.find, matchCase: true }, replaceText: e.text } },
    );
    const res = await this.json<{ replies?: { replaceAllText?: { occurrencesChanged?: number } }[] }>(
      accessToken,
      'POST',
      `${DOCS_API}/documents/${enc(input.documentId)}:batchUpdate`,
      { json: { requests } },
    );
    const replies = res.replies ?? [];
    const applied = input.edits.filter((e, i) =>
      e.op === 'append' ? true : (replies[i]?.replaceAllText?.occurrencesChanged ?? 0) > 0,
    ).length;
    return { applied };
  }

  private valuesUrl(spreadsheetId: string, range: string): string {
    return `${SHEETS_API}/spreadsheets/${enc(spreadsheetId)}/values/${enc(range)}`;
  }

  async sheetsRead(
    accessToken: string,
    input: { spreadsheetId: string; range: string },
  ): Promise<{ range: string; values: SheetCell[][] }> {
    const res = await this.json<{ range?: string; values?: unknown[][] }>(
      accessToken,
      'GET',
      this.valuesUrl(input.spreadsheetId, input.range),
      { query: { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' } },
    );
    const values: SheetCell[][] = [];
    let cells = 0;
    for (const row of res.values ?? []) {
      if (cells >= SHEET_READ_CELL_CAP) break;
      const cut = row.slice(0, SHEET_READ_CELL_CAP - cells);
      cells += cut.length;
      values.push(
        cut.map((v) =>
          typeof v === 'number' || typeof v === 'boolean' || v === null ? v : clip(String(v ?? ''), 50_000),
        ),
      );
    }
    return { range: res.range ?? input.range, values };
  }

  async sheetsWrite(
    accessToken: string,
    input: { spreadsheetId: string; range: string; values: SheetCell[][] },
  ): Promise<{ range: string; updatedCells: number }> {
    const res = await this.json<{ updatedRange?: string; updatedCells?: number }>(
      accessToken,
      'PUT',
      this.valuesUrl(input.spreadsheetId, input.range),
      {
        query: { valueInputOption: 'USER_ENTERED' },
        json: { range: input.range, majorDimension: 'ROWS', values: input.values },
      },
    );
    return { range: res.updatedRange ?? input.range, updatedCells: res.updatedCells ?? 0 };
  }

  /* Contacts ----------------------------------------------------------------------------------- */

  private async searchContacts(token: string, query: string, pageSize: number) {
    return this.json<{ results?: { person?: GooglePerson }[] }>(
      token,
      'GET',
      `${PEOPLE_API}/people:searchContacts`,
      {
        query: { query, pageSize, readMask: 'names,emailAddresses,phoneNumbers,organizations' },
      },
    );
  }

  async contactsSearch(accessToken: string, input: { query: string; limit: number }): Promise<ContactCard[]> {
    const pageSize = Math.min(input.limit, 30);
    let res = await this.searchContacts(accessToken, input.query, pageSize);
    if (!res.results?.length) {
      // People's search cache is filled lazily: Google asks for a warm-up request with an empty query.
      await this.searchContacts(accessToken, '', 1);
      res = await this.searchContacts(accessToken, input.query, pageSize);
    }
    return (res.results ?? [])
      .map((r) => r.person)
      .filter((p): p is GooglePerson => !!p)
      .slice(0, input.limit)
      .map(contactCard);
  }
}
