import {
  CalendarEvent,
  type CalendarEventPatch,
  type ConnectorBinary,
  type ConnectorService,
  ContactCard,
  DriveFile,
  FILE_CONTENT_CAP,
  MAIL_BODY_CAP,
  type MailDraftInput,
  MailMessage,
  MailSummary,
  microsoftServicesGranted,
} from '@whombat/core';
import { badRequest } from '../lib/errors';
import { attachmentDigest, boundedBytes, checkAttachmentTotal } from './binary';
import { graphRecurrence } from './microsoft-recurrence';
import { htmlToText } from './mime';
import {
  GoogleApiError,
  type GoogleWorkspace,
  type InboxUnread,
  MAIL_SINCE_SKEW_MS,
  type MailChangesOptions,
  type MailChangesResult,
  type MailHeader,
  type MailHeaderAttachment,
  type MailProviderCursor,
  normalizeRfcMessageId,
  quotaOf,
  type RecentFile,
  receivedAtOrAfter,
} from './types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const id = encodeURIComponent;
const address = (v: unknown) => str(obj(obj(v).emailAddress).address);
const addresses = (v: unknown) => arr(v).map(address);
const recipients = (v: readonly string[]) => v.map((address) => ({ emailAddress: { address } }));
const textBody = (v: unknown) => {
  const body = obj(v);
  return str(body.contentType).toLowerCase() === 'html' ? htmlToText(str(body.content)) : str(body.content);
};
const query = (values: Record<string, string>) => new URLSearchParams(values).toString();
const GRAPH = 'https://graph.microsoft.com/v1.0';
/** Maximum delta pages fetched per poll before persisting `@odata.nextLink` for the next poll. */
const MICROSOFT_DELTA_MAX_PAGES = 20;
const unsupported = (): never => {
  throw badRequest(
    'Microsoft native Word and Excel editing is not connected. Download the file and use your document tools.',
  );
};

function safeWebUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function safeTimestamp(raw: unknown): string {
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date(0).toISOString();
}

function mail(m: Obj) {
  const msgId = str(m.id).slice(0, 200);
  const webUrl = safeWebUrl(m.webLink);
  return MailSummary.parse({
    id: msgId,
    threadId: (str(m.conversationId) || msgId).slice(0, 200),
    from: address(m.from).slice(0, 500),
    to: addresses(m.toRecipients).map((a) => a.slice(0, 500)),
    subject: str(m.subject).slice(0, 1000),
    snippet: str(m.bodyPreview).slice(0, 500),
    date: safeTimestamp(m.receivedDateTime ?? m.createdDateTime),
    unread: m.isRead === false,
    labels: strings(m.categories).map((c) => c.slice(0, 200)),
    ...(webUrl ? { webUrl } : {}),
  });
}
function file(f: Obj) {
  const mime =
    str(obj(f.file).mimeType) || (f.folder ? 'application/vnd.microsoft.folder' : 'application/octet-stream');
  return DriveFile.parse({
    id: f.id,
    name: f.name,
    mimeType: mime,
    kind: f.folder
      ? 'folder'
      : mime === 'application/pdf'
        ? 'pdf'
        : mime.startsWith('image/')
          ? 'image'
          : mime.startsWith('text/')
            ? 'text'
            : 'other',
    modifiedAt: f.lastModifiedDateTime ?? null,
    owners: [],
    size: f.size ?? null,
    webUrl: f.webUrl ?? null,
  });
}
function event(e: Obj, calendarId: string) {
  const instant = (v: unknown) =>
    e.isAllDay ? str(obj(v).dateTime).slice(0, 10) : `${str(obj(v).dateTime).replace(/Z$/, '')}Z`;
  return CalendarEvent.parse({
    id: e.id,
    calendarId,
    summary: str(e.subject).slice(0, 1000),
    description: textBody(e.body).slice(0, 20_000),
    location: str(obj(e.location).displayName),
    start: instant(e.start),
    end: instant(e.end),
    allDay: !!e.isAllDay,
    guests: arr(e.attendees).map((a) => ({
      email: address(a),
      name: str(obj(a.emailAddress).name) || null,
      response:
        (
          { accepted: 'accepted', tentativelyAccepted: 'tentative', declined: 'declined' } as Record<
            string,
            string
          >
        )[str(obj(a.status).response)] ?? 'needs_action',
    })),
    organizer: address(e.organizer) || null,
    webUrl: e.webLink ?? null,
    meetUrl: obj(e.onlineMeeting).joinUrl ?? null,
  });
}
function eventBody(input: CalendarEventPatch): Obj {
  const body: Obj = {};
  if (input.summary !== undefined) body.subject = input.summary;
  if (input.description !== undefined) body.body = { contentType: 'text', content: input.description };
  if (input.location !== undefined) body.location = { displayName: input.location };
  if (input.guests !== undefined)
    body.attendees = recipients(input.guests).map((r) => ({ ...r, type: 'required' }));
  for (const key of ['start', 'end'] as const)
    if (input[key]) {
      const value = input[key];
      const zone = input.timeZone ?? 'UTC';
      let dateTime =
        value.length === 10 ? `${value}T00:00:00` : new Date(value).toISOString().replace('Z', '');
      if (value.length !== 10 && zone !== 'UTC') {
        try {
          const parts = Object.fromEntries(
            new Intl.DateTimeFormat('en-GB', {
              timeZone: zone,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hourCycle: 'h23',
            })
              .formatToParts(new Date(value))
              .map((p) => [p.type, p.value]),
          );
          dateTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
        } catch {
          throw badRequest('Use a valid IANA calendar time zone.');
        }
      }
      body[key] = { dateTime, timeZone: zone };
    }
  if (input.start) body.isAllDay = input.start.length === 10;
  if (input.addMeet) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = 'teamsForBusiness';
  }
  if (input.recurrence) body.recurrence = graphRecurrence(input);
  return body;
}

/** Delegated Graph adapter. Tokens go only to graph.microsoft.com; downloaded file redirects receive no token. */
export class MicrosoftWorkspace implements GoogleWorkspace {
  constructor(private readonly fetchImpl: typeof fetch = (url, init) => fetch(url, init)) {}
  private async request(
    token: string,
    path: string,
    method = 'GET',
    body?: unknown,
    extraPrefer?: string,
  ): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')) throw badRequest('Invalid Microsoft resource path.');
    const prefer = [
      'outlook.body-content-type="text"',
      'outlook.timezone="UTC"',
      'IdType="ImmutableId"',
      ...(extraPrefer ? [extraPrefer] : []),
    ].join(', ');
    const response = await this.fetchImpl(`${GRAPH}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
        prefer,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok && response.status !== 302) {
      await response.body?.cancel();
      throw new GoogleApiError(
        response.status,
        `Microsoft request failed (HTTP ${response.status}).`,
        response.status === 401
          ? 'unauthorized'
          : response.status === 403
            ? 'no_scope'
            : response.status === 404
              ? 'not_found'
              : response.status === 429
                ? 'rate_limited'
                : 'other',
      );
    }
    return response;
  }
  private async call(
    token: string,
    path: string,
    method = 'GET',
    body?: unknown,
    extraPrefer?: string,
  ): Promise<Obj> {
    const response = await this.request(token, path, method, body, extraPrefer);
    if (response.status === 204 || response.status === 202) {
      await response.body?.cancel();
      return {};
    }
    return obj(JSON.parse((await boundedBytes(response, 15 * 1024 ** 2)).toString('utf8')));
  }
  /** Fully enumerate security-sensitive collections; never approve a truncated attachment list. */
  private async collection(token: string, path: string, cap: number): Promise<Obj[]> {
    const values: Obj[] = [];
    for (let page = 0; page < 10; page++) {
      const result = await this.call(token, path);
      values.push(...arr(result.value));
      if (values.length > cap)
        throw badRequest('Microsoft collection is too large to read completely. Narrow the request.');
      const next = result['@odata.nextLink'];
      if (!next) return values;
      if (typeof next !== 'string' || !next.startsWith(`${GRAPH}/`))
        throw badRequest('Microsoft returned an unexpected page link.');
      path = next.slice(GRAPH.length);
    }
    throw badRequest('Microsoft collection has too many pages to read completely. Narrow the request.');
  }
  /** Reads up to `cap` items across up to 10 pages without throwing when an incoming message exceeds `cap`. */
  private async collectionBounded(token: string, path: string, cap: number): Promise<Obj[]> {
    const values: Obj[] = [];
    for (let page = 0; page < 10; page++) {
      const result = await this.call(token, path);
      values.push(...arr(result.value));
      if (values.length >= cap) return values.slice(0, cap);
      const next = result['@odata.nextLink'];
      if (!next) return values;
      if (typeof next !== 'string' || !next.startsWith(`${GRAPH}/`)) return values;
      path = next.slice(GRAPH.length);
    }
    return values.slice(0, cap);
  }
  async checkService(token: string, service: ConnectorService, scopes: readonly string[]) {
    if (!microsoftServicesGranted(scopes).includes(service))
      return { service, state: 'error' as const, message: 'Reconnect Microsoft with this service selected.' };
    try {
      await this.call(
        token,
        (
          {
            mail: '/me/messages?$top=1&$select=id',
            calendar: '/me/calendars?$top=1&$select=id',
            files: '/me/drive/root?$select=id',
            contacts: '/me/contacts?$top=1&$select=id',
          } as Partial<Record<ConnectorService, string>>
        )[service] ?? '/me',
      );
      return { service, state: 'ok' as const };
    } catch {
      return {
        service,
        state: 'error' as const,
        message: 'Microsoft could not provide this service. Check consent and the account licence.',
      };
    }
  }
  async mailSearch(token: string, input: Parameters<GoogleWorkspace['mailSearch']>[1]) {
    const q: Record<string, string> = { $top: String(input.limit) };
    if (input.query) q.$search = `"${input.query.replace(/["\\]/g, '')}"`;
    else q.$orderby = 'receivedDateTime desc';
    return arr((await this.call(token, `/me/messages?${query(q)}`)).value).map(mail);
  }
  async inboxUnread(token: string, input: { newest?: number } = {}): Promise<InboxUnread> {
    // The well-known `inbox` folder carries its own unread count (mailFolder `unreadItemCount`).
    const inbox = await this.call(token, '/me/mailFolders/inbox?$select=unreadItemCount');
    const count = Math.max(0, Number(inbox.unreadItemCount) || 0);
    const top = Math.min(25, Math.max(0, input.newest ?? 0));
    if (count === 0 || top === 0) return { count, newest: [] };
    // Graph sorts a filtered list only by a property the filter names first (InefficientFilter otherwise).
    const q = query({
      $filter: 'receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false',
      $orderby: 'receivedDateTime desc',
      $top: String(top),
      $select:
        'id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,categories,webLink',
    });
    const found = arr((await this.call(token, `/me/mailFolders/inbox/messages?${q}`)).value);
    return {
      count,
      newest: found.map((m) => {
        const name = str(obj(obj(m.from).emailAddress).name);
        const summary = mail(m);
        return name && name !== summary.from ? { ...summary, from: `${name} <${summary.from}>` } : summary;
      }),
    };
  }
  private async toMailHeaders(
    token: string,
    rawItems: readonly Obj[],
    options: MailChangesOptions,
  ): Promise<MailHeader[]> {
    const seenIds = new Set<string>();
    const headers: MailHeader[] = [];
    for (const m of rawItems) {
      if ('@removed' in m || m.isDraft === true) continue;
      const msgId = str(m.id);
      if (!msgId || seenIds.has(msgId)) continue;
      seenIds.add(msgId);
      const dateStr = str(m.receivedDateTime) || str(m.createdDateTime);
      const receivedMs = Date.parse(dateStr);
      if (Number.isFinite(receivedMs) && !receivedAtOrAfter(receivedMs, options.since)) continue;
      const fromAddr = address(m.from);
      const fromName = str(obj(obj(m.from).emailAddress).name);
      const from = fromName && fromName !== fromAddr ? `${fromName} <${fromAddr}>` : fromAddr;
      const hasAttachments = Boolean(m.hasAttachments);
      let attachments: MailHeaderAttachment[] | null = hasAttachments ? null : [];
      if (hasAttachments && options.needAttachmentTypes) {
        let list: Obj[];
        try {
          list = await this.collectionBounded(
            token,
            `/me/messages/${id(msgId)}/attachments?$select=id,name,contentType,size&$top=100`,
            500,
          );
        } catch (err) {
          if (err instanceof GoogleApiError && err.status === 404) continue;
          throw err;
        }
        attachments = list.map((a) => ({
          ...(str(a.id) ? { id: str(a.id).slice(0, 2048) } : {}),
          name: str(a.name).slice(0, 500),
          mimeType: (str(a.contentType) || 'application/octet-stream').slice(0, 200),
          size: Math.max(0, Math.trunc(Number(a.size) || 0)),
        }));
      }
      headers.push({
        id: msgId,
        threadId: str(m.conversationId) || msgId,
        messageId: normalizeRfcMessageId(str(m.internetMessageId)),
        from: from.slice(0, 500),
        to: addresses(m.toRecipients).map((a) => a.slice(0, 500)),
        subject: str(m.subject).slice(0, 1000),
        snippet: str(m.bodyPreview).slice(0, 500),
        date: Number.isFinite(receivedMs) ? new Date(receivedMs).toISOString() : new Date().toISOString(),
        hasAttachments,
        attachments,
      });
    }
    headers.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    return headers;
  }
  private async fetchMailBaselinePages(
    token: string,
    options: MailChangesOptions,
    useFilter: boolean,
  ): Promise<{ cursor: MailProviderCursor; kept: Obj[]; more?: boolean }> {
    // Documented Graph message-delta flow: limit the initial delta to messages received since `options.since`
    // (minus the 5-second skew margin) via `$filter=receivedDateTime ge ...` when supported, and keep the
    // `@odata.nextLink` paging position across polls if a very large delta exceeds one poll's page cap.
    const select =
      'id,conversationId,internetMessageId,from,toRecipients,subject,bodyPreview,receivedDateTime,hasAttachments,isDraft';
    const params: Record<string, string> = { $select: select };
    if (options.since && useFilter) {
      const cutoffMs = Math.max(0, Math.floor((options.since.getTime() - MAIL_SINCE_SKEW_MS) / 1000) * 1000);
      const cutoffIso = new Date(cutoffMs).toISOString().replace(/\.000Z$/, 'Z');
      params.$filter = `receivedDateTime ge ${cutoffIso}`;
    }
    let path = `/me/mailFolders/inbox/messages/delta?${query(params)}`;
    let lastNext: string | null = null;
    const kept: Obj[] = [];
    const seenUrls = new Set<string>();
    for (let page = 0; page < MICROSOFT_DELTA_MAX_PAGES; page++) {
      const currentUrl = `${GRAPH}${path}`;
      seenUrls.add(currentUrl);
      lastNext = null;
      const res = await this.call(token, path, 'GET', undefined, 'odata.maxpagesize=200');
      if (options.since) {
        for (const item of arr(res.value)) {
          if ('@removed' in item || item.isDraft === true) continue;
          const dateStr = str(item.receivedDateTime) || str(item.createdDateTime);
          const receivedMs = Date.parse(dateStr);
          if (!Number.isFinite(receivedMs) || receivedAtOrAfter(receivedMs, options.since)) kept.push(item);
        }
      }
      const delta = res['@odata.deltaLink'];
      if (typeof delta === 'string' && delta.startsWith(`${GRAPH}/`)) {
        return { cursor: { kind: 'microsoft', deltaLink: delta }, kept };
      }
      const next = res['@odata.nextLink'];
      if (typeof next === 'string' && next.startsWith(`${GRAPH}/`) && !seenUrls.has(next)) {
        lastNext = next;
        path = next.slice(GRAPH.length);
        continue;
      }
      break;
    }
    if (lastNext) {
      return {
        cursor: {
          kind: 'microsoft',
          deltaLink: lastNext,
          paging: options.since ? { sinceMs: options.since.getTime() } : { dropHeaders: true },
        },
        kept,
        more: true,
      };
    }
    throw badRequest('Microsoft did not return a delta link for the inbox.');
  }
  async mailBaseline(token: string, options: MailChangesOptions = {}): Promise<MailChangesResult> {
    let result: { cursor: MailProviderCursor; kept: Obj[]; more?: boolean };
    if (!options.since) {
      result = await this.fetchMailBaselinePages(token, options, false);
    } else {
      try {
        result = await this.fetchMailBaselinePages(token, options, true);
      } catch (err) {
        // Some Graph mailboxes reject `$filter=receivedDateTime ge ...` on message delta with HTTP 400: retry once
        // without the filter and rely on the client-side `receivedAtOrAfter` check to drop older mail.
        if (err instanceof GoogleApiError && err.status === 400) {
          result = await this.fetchMailBaselinePages(token, options, false);
        } else {
          throw err;
        }
      }
    }
    const headers = result.kept.length ? await this.toMailHeaders(token, result.kept, options) : [];
    return {
      cursor: result.cursor,
      headers,
      ...(result.more ? { more: true } : {}),
    };
  }
  async mailChanges(
    token: string,
    cursor: MailProviderCursor,
    options: MailChangesOptions = {},
  ): Promise<MailChangesResult> {
    const resyncSince = options.resyncSince ?? options.since ?? null;
    if (cursor.kind !== 'microsoft' || !cursor.deltaLink.startsWith(`${GRAPH}/`)) {
      const resynced = await this.mailBaseline(token, { ...options, since: resyncSince });
      return { ...resynced, reset: true };
    }
    const dropHeaders = cursor.paging?.dropHeaders === true;
    const effectiveSince =
      cursor.paging?.sinceMs !== undefined ? new Date(cursor.paging.sinceMs) : options.since;
    let path = cursor.deltaLink.slice(GRAPH.length);
    let nextDelta: string | null = null;
    let reachedDelta = false;
    let hasMore = false;
    const rawItems: Obj[] = [];
    const seenUrls = new Set<string>();
    try {
      for (let page = 0; page < MICROSOFT_DELTA_MAX_PAGES; page++) {
        const currentUrl = `${GRAPH}${path}`;
        seenUrls.add(currentUrl);
        nextDelta = null;
        const res = await this.call(token, path, 'GET', undefined, 'odata.maxpagesize=200');
        if (!dropHeaders) rawItems.push(...arr(res.value));
        const delta = res['@odata.deltaLink'];
        if (typeof delta === 'string' && delta.startsWith(`${GRAPH}/`)) {
          nextDelta = delta;
          reachedDelta = true;
          break;
        }
        const next = res['@odata.nextLink'];
        if (typeof next === 'string' && next.startsWith(`${GRAPH}/`) && !seenUrls.has(next)) {
          nextDelta = next;
          path = next.slice(GRAPH.length);
          if (page === MICROSOFT_DELTA_MAX_PAGES - 1) hasMore = true;
          continue;
        }
        break;
      }
    } catch (err) {
      // Sync state expired (410 Gone) or invalid (400/404): resync via documented inbox delta from last successful poll.
      if (err instanceof GoogleApiError && (err.status === 410 || err.status === 404 || err.status === 400)) {
        const resynced = await this.mailBaseline(token, {
          ...options,
          since: cursor.paging?.sinceMs !== undefined ? new Date(cursor.paging.sinceMs) : resyncSince,
        });
        return { ...resynced, reset: true };
      }
      throw err;
    }
    if (!nextDelta) {
      throw badRequest('Microsoft did not return a delta link for the inbox.');
    }
    const headers = dropHeaders
      ? []
      : await this.toMailHeaders(token, rawItems, { ...options, since: effectiveSince });
    const nextCursor: MailProviderCursor = {
      kind: 'microsoft',
      deltaLink: nextDelta,
      ...(!reachedDelta && cursor.paging ? { paging: cursor.paging } : {}),
    };
    return { cursor: nextCursor, headers, ...(hasMore ? { more: true } : {}) };
  }
  async mailRead(token: string, input: { messageId?: string; threadId?: string }) {
    const messages = input.messageId
      ? [await this.call(token, `/me/messages/${id(input.messageId)}`)]
      : await this.collection(
          token,
          `/me/messages?${query({ $filter: `conversationId eq '${(input.threadId ?? '').replaceAll("'", "''")}'`, $top: '100' })}`,
          100,
        );
    return Promise.all(
      messages.map(async (m) => {
        const attachments = m.hasAttachments
          ? await this.collectionBounded(
              token,
              `/me/messages/${id(str(m.id))}/attachments?$select=id,name,contentType,size&$top=100`,
              500,
            )
          : [];
        const body = textBody(m.body);
        return MailMessage.parse({
          ...mail(m),
          cc: addresses(m.ccRecipients).map((a) => a.slice(0, 500)),
          body: body.slice(0, MAIL_BODY_CAP),
          bodyTruncated: body.length > MAIL_BODY_CAP,
          attachments: attachments.map((a) => ({
            ...(str(a.id) ? { id: str(a.id).slice(0, 2048) } : {}),
            name: str(a.name).slice(0, 500),
            mimeType: (str(a.contentType) || 'application/octet-stream').slice(0, 200),
            size: Math.max(0, Math.trunc(Number(a.size) || 0)),
          })),
        });
      }),
    );
  }
  async mailAttachment(
    token: string,
    input: { messageId: string; attachmentId: string },
  ): Promise<ConnectorBinary> {
    const a = await this.call(
      token,
      `/me/messages/${id(input.messageId)}/attachments/${id(input.attachmentId)}`,
    );
    if (a['@odata.type'] !== '#microsoft.graph.fileAttachment' || typeof a.contentBytes !== 'string')
      throw badRequest('This is not a downloadable file attachment.');
    const binary = {
      name: str(a.name),
      mimeType: str(a.contentType) || 'application/octet-stream',
      contentBase64: a.contentBytes,
    };
    checkAttachmentTotal([binary]);
    return binary;
  }
  async mailDraft(token: string, input: MailDraftInput) {
    checkAttachmentTotal(input.attachments ?? []);
    // Graph accepts file attachments below 3 MiB inline; fail before creating a partial draft.
    if (input.attachments?.some((a) => Buffer.from(a.contentBase64, 'base64').length >= 3 * 1024 ** 2))
      throw badRequest(
        'Microsoft draft attachments must each be smaller than 3 MiB. Share a OneDrive link for a larger file.',
      );
    const body = {
      subject: input.subject,
      body: { contentType: 'text', content: input.body },
      toRecipients: recipients(input.to),
      ccRecipients: recipients(input.cc),
      bccRecipients: recipients(input.bcc),
      attachments: (input.attachments ?? []).map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.name,
        contentType: a.mimeType,
        contentBytes: a.contentBase64,
      })),
    };
    const draft = input.replyToMessageId
      ? await this.call(token, `/me/messages/${id(input.replyToMessageId)}/createReply`, 'POST', {
          message: body,
        })
      : await this.call(token, '/me/messages', 'POST', body);
    return { draftId: str(draft.id) };
  }
  async mailGetDraft(token: string, draftId: string) {
    const draft = await this.call(token, `/me/messages/${id(draftId)}`);
    if (!draft.isDraft) throw badRequest('This message is no longer a draft. Check Sent before retrying.');
    const attachments = await this.collection(
      token,
      `/me/messages/${id(draftId)}/attachments?$select=id,name,contentType,size`,
      10,
    );
    const binaries = await Promise.all(
      attachments.map((a) => this.mailAttachment(token, { messageId: draftId, attachmentId: str(a.id) })),
    );
    checkAttachmentTotal(binaries);
    return {
      draftId,
      threadId: str(draft.conversationId) || null,
      to: addresses(draft.toRecipients),
      cc: addresses(draft.ccRecipients),
      bcc: addresses(draft.bccRecipients),
      subject: str(draft.subject),
      body: textBody(draft.body),
      attachments: binaries.map(attachmentDigest),
    };
  }
  async mailSendDraft(token: string, draftId: string) {
    const draft = await this.mailGetDraft(token, draftId);
    await this.call(token, `/me/messages/${id(draftId)}/send`, 'POST');
    return { messageId: draftId, threadId: draft.threadId ?? draftId };
  }
  async mailOrganize(token: string, input: Parameters<GoogleWorkspace['mailOrganize']>[1]) {
    for (const messageId of input.messageIds) {
      const path = `/me/messages/${id(messageId)}`;
      const old = await this.call(token, `${path}?$select=categories`);
      await this.call(token, path, 'PATCH', {
        categories: [
          ...new Set([
            ...strings(old.categories).filter((c) => !input.removeLabels.includes(c)),
            ...input.addLabels,
          ]),
        ],
        ...(input.read !== undefined ? { isRead: input.read } : {}),
      });
      if (input.archive) await this.call(token, `${path}/move`, 'POST', { destinationId: 'archive' });
    }
    return { updated: input.messageIds.length };
  }
  async mailTrash(token: string, input: { messageIds: string[] }) {
    // Deleted Items, as Outlook's own Delete does: it can be moved back.
    for (const messageId of input.messageIds)
      await this.call(token, `/me/messages/${id(messageId)}/move`, 'POST', { destinationId: 'deleteditems' });
    return { trashed: input.messageIds.length };
  }
  private calendar(calendarId: string) {
    return calendarId === 'primary' ? '/me/calendar' : `/me/calendars/${id(calendarId)}`;
  }
  async calendarEvents(token: string, input: Parameters<GoogleWorkspace['calendarEvents']>[1]) {
    const start = input.from ?? new Date().toISOString();
    const end = input.to ?? new Date(Date.parse(start) + 31 * 86_400_000).toISOString();
    const values = arr(
      (
        await this.call(
          token,
          `${this.calendar(input.calendarId)}/calendarView?${query({ startDateTime: start, endDateTime: end, $top: String(input.limit), $orderby: 'start/dateTime' })}`,
        )
      ).value,
    );
    return values
      .filter((e) => !input.query || str(e.subject).toLowerCase().includes(input.query.toLowerCase()))
      .map((e) => event(e, input.calendarId));
  }
  async calendarGetEvent(token: string, input: { calendarId: string; eventId: string }) {
    return event(
      await this.call(token, `${this.calendar(input.calendarId)}/events/${id(input.eventId)}`),
      input.calendarId,
    );
  }
  async calendarCreateEvent(token: string, input: Parameters<GoogleWorkspace['calendarCreateEvent']>[1]) {
    if (input.event.guests.length && !input.sendUpdates)
      throw badRequest('Guest invitations require approval.');
    return event(
      await this.call(token, `${this.calendar(input.calendarId)}/events`, 'POST', eventBody(input.event)),
      input.calendarId,
    );
  }
  async calendarUpdateEvent(token: string, input: Parameters<GoogleWorkspace['calendarUpdateEvent']>[1]) {
    const old = await this.calendarGetEvent(token, input);
    if ((old.guests.length || input.patch.guests?.length) && !input.sendUpdates)
      throw badRequest('Guest changes require approval.');
    const patch = input.patch.recurrence
      ? { ...input.patch, start: input.patch.start ?? old.start }
      : input.patch;
    return event(
      await this.call(
        token,
        `${this.calendar(input.calendarId)}/events/${id(input.eventId)}`,
        'PATCH',
        eventBody(patch),
      ),
      input.calendarId,
    );
  }
  async calendarDeleteEvent(token: string, input: Parameters<GoogleWorkspace['calendarDeleteEvent']>[1]) {
    const old = await this.calendarGetEvent(token, input);
    if (old.guests.length && !input.sendUpdates)
      throw badRequest('Cancelling an invitation requires approval.');
    await this.call(token, `${this.calendar(input.calendarId)}/events/${id(input.eventId)}`, 'DELETE');
  }
  async filesSearch(token: string, input: { query: string; limit: number }) {
    return arr(
      (
        await this.call(
          token,
          `/me/drive/root/search(q='${id(input.query.replaceAll("'", "''"))}')?$top=${input.limit}`,
        )
      ).value,
    ).map(file);
  }
  async filesGet(token: string, fileId: string) {
    return file(await this.call(token, `/me/drive/items/${id(fileId)}`));
  }
  async filesDownload(token: string, fileId: string) {
    const metadata = await this.filesGet(token, fileId);
    if (metadata.kind === 'folder') throw badRequest('Choose a file, not a folder.');
    let response = await this.request(token, `/me/drive/items/${id(fileId)}/content`);
    if (response.status === 302) {
      const target = new URL(response.headers.get('location') ?? '');
      await response.body?.cancel();
      if (
        target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        !['sharepoint.com', '1drv.com', 'storage.live.com'].some(
          (host) => target.hostname === host || target.hostname.endsWith(`.${host}`),
        )
      )
        throw badRequest('Microsoft returned an unexpected download host.');
      response = await this.fetchImpl(target, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw badRequest(`Microsoft file download failed (HTTP ${response.status}).`);
      }
    }
    return {
      name: metadata.name,
      mimeType: metadata.mimeType,
      contentBase64: (await boundedBytes(response)).toString('base64'),
    };
  }
  async filesRead(token: string, fileId: string) {
    const metadata = await this.filesGet(token, fileId);
    if (!metadata.mimeType.startsWith('text/'))
      return { file: metadata, format: 'none' as const, content: null, truncated: false };
    const binary = await this.filesDownload(token, fileId);
    const text = Buffer.from(binary.contentBase64, 'base64').toString('utf8');
    return {
      file: metadata,
      format: 'text' as const,
      content: text.slice(0, FILE_CONTENT_CAP),
      truncated: text.length > FILE_CONTENT_CAP,
    };
  }
  async filesCreate(token: string, input: Parameters<GoogleWorkspace['filesCreate']>[1]) {
    if (input.kind !== 'text')
      throw badRequest(
        'Microsoft files_create creates text files. Use kind text with Markdown or CSV, or create an Office file with your document tools.',
      );
    const parent = input.folderId ? `items/${id(input.folderId)}` : 'root';
    return file(
      await this.call(
        token,
        `/me/drive/${parent}:/${id(input.name)}:/content?@microsoft.graph.conflictBehavior=fail`,
        'PUT',
        input.content,
      ),
    );
  }
  async filesOrganize(token: string, input: Parameters<GoogleWorkspace['filesOrganize']>[1]) {
    if (input.action === 'folder')
      return file(
        await this.call(
          token,
          `/me/drive/${input.folderId ? `items/${id(input.folderId)}` : 'root'}/children`,
          'POST',
          { name: input.name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
        ),
      );
    const path = `/me/drive/items/${id(input.fileId ?? '')}`;
    if (input.action === 'copy') {
      // Graph copy is asynchronous. Return only once Graph provides the resulting resource ID.
      const response = await this.request(token, `${path}/copy`, 'POST', {
        ...(input.name ? { name: input.name } : {}),
        ...(input.folderId ? { parentReference: { id: input.folderId } } : {}),
      });
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location)
        throw badRequest(
          'Microsoft accepted the copy without a status link. Check OneDrive before retrying.',
        );
      const monitor = new URL(location);
      const graph = location.startsWith(`${GRAPH}/`);
      if (
        monitor.protocol !== 'https:' ||
        monitor.username ||
        monitor.password ||
        (!graph &&
          !['api.onedrive.com', 'sharepoint.com'].some(
            (host) => monitor.hostname === host || monitor.hostname.endsWith(`.${host}`),
          ))
      )
        throw badRequest(
          'Microsoft accepted the copy with an unexpected status host. Check OneDrive before retrying.',
        );
      for (let attempt = 0; attempt < 10; attempt++) {
        // External monitor URLs are signed capabilities, never destinations for the Graph bearer token.
        const poll = await this.fetchImpl(monitor, {
          headers: graph ? { authorization: `Bearer ${token}` } : {},
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
        if (poll.status === 303) {
          const resource = poll.headers.get('location');
          await poll.body?.cancel();
          if (resource?.startsWith(`${GRAPH}/me/drive/items/`))
            return file(await this.call(token, resource.slice(GRAPH.length)));
          throw badRequest('Microsoft completed the copy. Check its destination for the resulting file.');
        }
        if (!poll.ok) {
          await poll.body?.cancel();
          throw badRequest('Microsoft copy status is unavailable. Check its destination before retrying.');
        }
        const bytes = await boundedBytes(poll, 64 * 1024);
        const result = bytes.length ? obj(JSON.parse(bytes.toString('utf8'))) : {};
        if (result.status === 'completed' && result.resourceId)
          return this.filesGet(token, str(result.resourceId));
        if (result.status === 'failed') throw badRequest('Microsoft could not copy this file.');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw badRequest('Microsoft is still copying the file. Check its destination before retrying.');
    }
    return file(
      await this.call(token, path, 'PATCH', {
        ...(input.name ? { name: input.name } : {}),
        ...(input.action === 'move' ? { parentReference: { id: input.folderId } } : {}),
      }),
    );
  }
  async filesShare(token: string, input: Parameters<GoogleWorkspace['filesShare']>[1]) {
    if (input.role === 'commenter')
      throw badRequest('Microsoft supports reader or writer sharing; choose one explicitly.');
    await this.call(token, `/me/drive/items/${id(input.fileId)}/invite`, 'POST', {
      recipients: [{ email: input.email }],
      requireSignIn: true,
      sendInvitation: true,
      roles: [input.role === 'writer' ? 'write' : 'read'],
    });
  }
  async filesTrash(token: string, fileId: string) {
    await this.call(token, `/me/drive/items/${id(fileId)}`, 'DELETE');
  }
  async filesQuota(token: string) {
    const quota = obj((await this.call(token, `/me/drive?${query({ $select: 'quota' })}`)).quota);
    return quotaOf(quota.used, quota.total);
  }
  /** Graph's `/me/drive/recent` stops returning data in November 2026: OneDrive has no list of recent changes here. */
  async filesRecent(): Promise<RecentFile[]> {
    throw badRequest('OneDrive’s recent files can’t be read.');
  }
  async docsEdit(): Promise<{ applied: number }> {
    return unsupported();
  }
  async sheetsRead(): Promise<{ range: string; values: [] }> {
    return unsupported();
  }
  async sheetsWrite(): Promise<{ range: string; updatedCells: number }> {
    return unsupported();
  }
  async contactsSearch(token: string, input: { query: string; limit: number }) {
    const filter = input.query
      ? `&${query({ $filter: `startswith(displayName,'${input.query.replaceAll("'", "''")}')` })}`
      : '';
    return arr((await this.call(token, `/me/contacts?$top=${input.limit}${filter}`)).value).map((c) =>
      ContactCard.parse({
        name: c.displayName,
        emails: arr(c.emailAddresses).map((e) => str(e.address)),
        phones: [
          ...strings(c.businessPhones),
          ...strings(c.homePhones),
          ...(c.mobilePhone ? [str(c.mobilePhone)] : []),
        ],
        organization: c.companyName ?? null,
      }),
    );
  }
}
