/**
 * The real Google adapter against a mocked `fetch`: request shapes (URLs, queries, bodies), limits, mapping
 * of Google's resources, error mapping (403 SERVICE_DISABLED → the enable link, 401, 404, 429), the host
 * allowlist, and the 401 → forced refresh → retry once of `withAccessToken`.
 */
import { GOOGLE_SCOPES } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../services';
import { withAccessToken } from './access';
import { googleApiError } from './google-http';
import { type ConnectionTokens, GoogleApiError } from './types';
import { driveQuery, googleUrl, RealGoogleWorkspace } from './workspace-real';

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

type Route = (call: Call) => { status?: number; json?: unknown; text?: string } | undefined;

function mockGoogle(route: Route) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    expect(init?.redirect).toBe('error');
    const res = route(call) ?? { status: 404, json: { error: { code: 404, message: 'Not Found' } } };
    const body = res.text ?? (res.json === undefined ? '' : JSON.stringify(res.json));
    return new Response(body || null, { status: res.status ?? 200 });
  }) as unknown as typeof fetch;
  return { workspace: new RealGoogleWorkspace({ fetch: fetchImpl }), calls };
}

const path = (c: Call) => `${c.method} ${c.url.host}${c.url.pathname}`;
const _b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('mail', () => {
  it('counts unread from the INBOX label in one call, and reads the newest only when asked and there are any', async () => {
    let unread = 7;
    const { workspace, calls } = mockGoogle((c) => {
      if (c.url.pathname.endsWith('/labels/INBOX')) return { json: { id: 'INBOX', messagesUnread: unread } };
      if (c.url.pathname.endsWith('/messages')) return { json: { messages: [{ id: 'm1', threadId: 't1' }] } };
      if (c.url.pathname.endsWith('/labels')) return { json: { labels: [{ id: 'INBOX', name: 'INBOX' }] } };
      if (c.url.pathname.endsWith('/messages/m1'))
        return {
          json: {
            id: 'm1',
            threadId: 't1',
            labelIds: ['INBOX', 'UNREAD'],
            internalDate: '1761638400000',
            payload: {
              headers: [
                { name: 'Subject', value: 'Lunch?' },
                { name: 'From', value: 'Bo <bo@x.test>' },
              ],
            },
          },
        };
      return undefined;
    });
    expect(await workspace.inboxUnread('tok')).toEqual({ count: 7, newest: [] });
    expect(calls.map(path)).toEqual(['GET gmail.googleapis.com/gmail/v1/users/me/labels/INBOX']);
    const got = await workspace.inboxUnread('tok', { newest: 3 });
    expect(got.count).toBe(7);
    expect(got.newest.map((m) => m.subject)).toEqual(['Lunch?']);
    const search = calls.find((c) => c.url.pathname.endsWith('/messages'));
    expect(search?.url.searchParams.get('q')).toBe('is:unread in:inbox');
    expect(search?.url.searchParams.get('maxResults')).toBe('3');
    unread = 0;
    calls.length = 0;
    expect(await workspace.inboxUnread('tok', { newest: 3 })).toEqual({ count: 0, newest: [] });
    expect(calls).toHaveLength(1);
  });

  it('searches with the query and limit, then reads metadata of each result', async () => {
    const { workspace, calls } = mockGoogle((c) => {
      if (c.url.pathname.endsWith('/messages'))
        return {
          json: {
            messages: [
              { id: 'm1', threadId: 't1' },
              { id: 'm2', threadId: 't2' },
            ],
          },
        };
      if (c.url.pathname.endsWith('/labels'))
        return {
          json: {
            labels: [
              { id: 'INBOX', name: 'INBOX' },
              { id: 'Label_7', name: 'Receipts' },
            ],
          },
        };
      const id = c.url.pathname.split('/').pop();
      return {
        json: {
          id,
          threadId: `t${id?.slice(1)}`,
          labelIds: id === 'm1' ? ['INBOX', 'UNREAD', 'Label_7'] : ['INBOX'],
          snippet: 'It&#39;s paid',
          internalDate: '1790000000000',
          payload: {
            headers: [
              { name: 'From', value: 'Priya Shah <priya@x.com>' },
              { name: 'To', value: '"Okafor, Mara" <mara@y.com>, bo@z.com' },
              { name: 'Subject', value: 'Invoice' },
            ],
          },
        },
      };
    });
    const found = await workspace.mailSearch('tok', { query: 'from:priya', limit: 2 });
    expect(calls[0]?.headers.authorization).toBe('Bearer tok');
    expect(path(calls[0] as Call)).toBe('GET gmail.googleapis.com/gmail/v1/users/me/messages');
    expect(calls[0]?.url.searchParams.get('q')).toBe('from:priya');
    expect(calls[0]?.url.searchParams.get('maxResults')).toBe('2');
    const meta = calls.find((c) => c.url.pathname.endsWith('/m1'));
    expect(meta?.url.searchParams.get('format')).toBe('metadata');
    expect(meta?.url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'To', 'Subject', 'Date']);
    expect(found[0]).toEqual({
      id: 'm1',
      threadId: 't1',
      from: 'Priya Shah <priya@x.com>',
      to: ['"Okafor, Mara" <mara@y.com>', 'bo@z.com'],
      subject: 'Invoice',
      snippet: "It's paid",
      date: new Date(1_790_000_000_000).toISOString(),
      unread: true,
      labels: ['INBOX', 'UNREAD', 'Receipts'],
    });
    expect(found).toHaveLength(2);
  });

  it('drafts a reply in the original thread with In-Reply-To and References', async () => {
    const { workspace, calls } = mockGoogle((c) => {
      if (c.method === 'GET')
        return {
          json: {
            id: 'm1',
            threadId: 't1',
            payload: {
              headers: [
                { name: 'Message-ID', value: '<m1@mail.x.com>' },
                { name: 'References', value: '<m0@mail.x.com>' },
                { name: 'Subject', value: 'Lunch?' },
              ],
            },
          },
        };
      return { json: { id: 'd1', message: { id: 'x', threadId: 't1' } } };
    });
    const out = await workspace.mailDraft('tok', {
      to: ['joris@example.org'],
      cc: [],
      bcc: [],
      subject: '',
      body: 'Thursday works.',
      replyToMessageId: 'm1',
    });
    expect(out).toEqual({ draftId: 'd1' });
    const post = calls.find((c) => c.method === 'POST');
    expect(path(post as Call)).toBe('POST gmail.googleapis.com/gmail/v1/users/me/drafts');
    const body = JSON.parse(post?.body ?? '{}') as { message: { raw: string; threadId: string } };
    expect(body.message.threadId).toBe('t1');
    const raw = Buffer.from(body.message.raw, 'base64url').toString();
    expect(raw).toContain('To: joris@example.org\r\n');
    expect(raw).toContain('Subject: Re: Lunch?\r\n');
    expect(raw).toContain('In-Reply-To: <m1@mail.x.com>\r\n');
    expect(raw).toContain('References: <m0@mail.x.com> <m1@mail.x.com>\r\n');
  });

  it('organizes: creates a missing label, marks read and archives in one batchModify', async () => {
    const { workspace, calls } = mockGoogle((c) => {
      if (c.method === 'GET') return { json: { labels: [{ id: 'INBOX', name: 'INBOX' }] } };
      if (c.url.pathname.endsWith('/labels')) return { json: { id: 'Label_9', name: 'Receipts' } };
      return { status: 204 };
    });
    const out = await workspace.mailOrganize('tok', {
      messageIds: ['m1', 'm2'],
      addLabels: ['Receipts'],
      removeLabels: ['Nope'],
      read: true,
      archive: true,
    });
    expect(out).toEqual({ updated: 2 });
    const modify = calls.find((c) => c.url.pathname.endsWith('/batchModify'));
    expect(JSON.parse(modify?.body ?? '{}')).toEqual({
      ids: ['m1', 'm2'],
      addLabelIds: ['Label_9'],
      removeLabelIds: ['UNREAD', 'INBOX'],
    });
  });

  it('never adds or removes Trash, Spam, Sent, Drafts or Chat (IN-15)', async () => {
    for (const label of ['TRASH', 'spam', 'Sent', 'DRAFT']) {
      const { workspace, calls } = mockGoogle((c) => {
        if (c.method === 'GET')
          return {
            json: {
              labels: [
                { id: 'TRASH', name: 'TRASH', type: 'system' },
                { id: 'SPAM', name: 'SPAM', type: 'system' },
              ],
            },
          };
        return { status: 204 };
      });
      await expect(
        workspace.mailOrganize('tok', { messageIds: ['m1'], addLabels: [label], removeLabels: [] }),
      ).rejects.toMatchObject({ code: 'bad_request' });
      await expect(
        workspace.mailOrganize('tok', { messageIds: ['m1'], addLabels: [], removeLabels: [label] }),
      ).rejects.toMatchObject({ code: 'bad_request' });
      expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    }
  });

  it('baselines Gmail historyId and reads only header and attachment metadata via History API', async () => {
    const { workspace, calls } = mockGoogle((c) => {
      if (c.url.pathname.endsWith('/profile'))
        return { json: { emailAddress: 'you@example.com', historyId: '500' } };
      if (c.url.pathname.endsWith('/history')) {
        if (c.url.searchParams.get('startHistoryId') === '100') {
          return { status: 404, json: { error: { code: 404, message: 'History expired' } } };
        }
        return {
          json: {
            historyId: '505',
            history: [
              {
                messagesAdded: [
                  { message: { id: 'm_new', threadId: 't_new', labelIds: ['INBOX', 'UNREAD'] } },
                  { message: { id: 'm_draft', threadId: 't_draft', labelIds: ['INBOX', 'DRAFT'] } },
                ],
              },
            ],
          },
        };
      }
      if (c.url.pathname.endsWith('/messages/m_new')) {
        return {
          json: {
            id: 'm_new',
            threadId: 't_new',
            labelIds: ['INBOX', 'UNREAD'],
            snippet: 'Invoice attached',
            internalDate: '1761638400000',
            payload: {
              mimeType: 'multipart/mixed',
              headers: [
                { name: 'From', value: 'Billing <billing@example.com>' },
                { name: 'To', value: 'you@example.com' },
                { name: 'Subject', value: 'Invoice 42' },
                { name: 'Message-ID', value: '<Inv-42@Example.com>' },
              ],
              parts: [
                { partId: '0', mimeType: 'text/plain', filename: '' },
                {
                  partId: '1',
                  mimeType: 'application/pdf',
                  filename: 'invoice-42.pdf',
                  body: { attachmentId: 'att_42', size: 12345 },
                },
              ],
            },
          },
        };
      }
      return undefined;
    });

    const baseline = await workspace.mailBaseline('tok');
    expect(baseline).toEqual({ cursor: { kind: 'gmail', historyId: '500' }, headers: [] });
    expect(calls[0]?.url.pathname).toBe('/gmail/v1/users/me/profile');

    const delta = await workspace.mailChanges('tok', baseline.cursor);
    expect(delta.cursor).toEqual({ kind: 'gmail', historyId: '505' });
    expect(delta.headers).toHaveLength(1);
    expect(delta.headers[0]).toMatchObject({
      id: 'm_new',
      messageId: '<inv-42@example.com>',
      from: 'Billing <billing@example.com>',
      subject: 'Invoice 42',
      hasAttachments: true,
      attachments: [{ id: '1', name: 'invoice-42.pdf', mimeType: 'application/pdf', size: 12345 }],
    });
    const msgCall = calls.find((c) => c.url.pathname.endsWith('/messages/m_new'));
    expect(msgCall?.url.searchParams.get('fields')).toContain('attachmentId');
    expect(msgCall?.url.searchParams.get('fields')).not.toContain('data');

    // Expired historyId (404) without since re-baselines cleanly.
    const expired = await workspace.mailChanges('tok', { kind: 'gmail', historyId: '100' });
    expect(expired).toEqual({
      cursor: { kind: 'gmail', historyId: '500' },
      headers: [],
      reset: true,
    });
  });

  it('enforces activation time with 5 s skew, backfills on initial poll, and resyncs on expired historyId', async () => {
    const activation = new Date('2026-10-28T10:00:00.000Z');
    const messages: Record<string, object> = {
      m_old_moved: {
        id: 'm_old_moved',
        threadId: 't_old',
        labelIds: ['INBOX'],
        snippet: 'Moved back from Archive',
        internalDate: String(activation.getTime() - 60_000),
        payload: {
          headers: [
            { name: 'From', value: 'billing@example.com' },
            { name: 'Subject', value: 'Old invoice moved back' },
            { name: 'Message-ID', value: '<old-moved@example.com>' },
          ],
        },
      },
      m_within_skew: {
        id: 'm_within_skew',
        threadId: 't_skew',
        labelIds: ['INBOX'],
        snippet: 'Arrived 3s before activation',
        internalDate: String(activation.getTime() - 3_000),
        payload: {
          headers: [
            { name: 'From', value: 'billing@example.com' },
            { name: 'Subject', value: 'Fresh invoice' },
            { name: 'Message-ID', value: '<fresh@example.com>' },
          ],
        },
      },
      m_during_expiry: {
        id: 'm_during_expiry',
        threadId: 't_exp',
        labelIds: ['INBOX'],
        snippet: 'Arrived while expired',
        internalDate: String(activation.getTime() + 120_000),
        payload: {
          headers: [
            { name: 'From', value: 'billing@example.com' },
            { name: 'Subject', value: 'Missed during expiry' },
            { name: 'Message-ID', value: '<missed@example.com>' },
          ],
        },
      },
    };
    const { workspace, calls } = mockGoogle((c) => {
      if (c.url.pathname.endsWith('/profile')) return { json: { historyId: '700' } };
      if (c.url.pathname.endsWith('/messages')) {
        return {
          json: {
            messages: [{ id: 'm_old_moved' }, { id: 'm_within_skew' }, { id: 'm_during_expiry' }],
          },
        };
      }
      if (c.url.pathname.endsWith('/history')) {
        if (c.url.searchParams.get('startHistoryId') === '600') {
          return { status: 404, json: { error: { message: 'Start history id too old' } } };
        }
        return {
          json: {
            historyId: '705',
            history: [{ id: '705', messagesAdded: [{ message: { id: 'm_old_moved', labelIds: ['INBOX'] } }] }],
          },
        };
      }
      const id = c.url.pathname.split('/').at(-1) ?? '';
      return { json: messages[id] };
    });

    // Initial baseline backfills messages at/after activation - 5s and drops older ones.
    const initial = await workspace.mailBaseline('tok', { since: activation });
    expect(initial.cursor).toEqual({ kind: 'gmail', historyId: '700' });
    expect(initial.headers.map((h) => h.id)).toEqual(['m_within_skew', 'm_during_expiry']);
    expect(initial.headers[0]?.messageId).toBe('<fresh@example.com>');
    const listCall = calls.find((c) => c.url.pathname.endsWith('/messages'));
    expect(listCall?.url.searchParams.get('labelIds')).toBe('INBOX');
    expect(listCall?.url.searchParams.get('q')).toMatch(/^after:\d+$/);

    // An old message moved back into INBOX in history.list is dropped by `since`.
    const movedBack = await workspace.mailChanges('tok', initial.cursor, { since: activation });
    expect(movedBack.headers).toEqual([]);

    // Expired historyId resyncs from resyncSince (last successful poll time).
    const resynced = await workspace.mailChanges(
      'tok',
      { kind: 'gmail', historyId: '600' },
      { since: activation, resyncSince: new Date(activation.getTime() + 60_000) },
    );
    expect(resynced.reset).toBe(true);
    expect(resynced.headers.map((h) => h.id)).toEqual(['m_during_expiry']);
  });
});

describe('calendar', () => {
  const googleEvent = {
    id: 'e1',
    summary: 'Standup',
    start: { dateTime: '2026-09-25T09:30:00+02:00' },
    end: { dateTime: '2026-09-25T09:45:00+02:00' },
    attendees: [
      { email: 'me@x.com', self: true, responseStatus: 'accepted' },
      { email: 'Joris@example.org', displayName: 'Joris', responseStatus: 'tentative' },
      { email: 'room@resource.calendar.google.com', resource: true },
    ],
    organizer: { email: 'me@x.com' },
    htmlLink: 'https://www.google.com/calendar/event?eid=e1',
    conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc' }] },
  };

  it('lists single events in order between from and to, and maps guests without the owner or rooms', async () => {
    const { workspace, calls } = mockGoogle(() => ({ json: { items: [googleEvent] } }));
    const [e] = await workspace.calendarEvents('tok', {
      calendarId: 'primary',
      from: '2026-09-25T00:00:00Z',
      to: '2026-09-26T00:00:00Z',
      limit: 5,
    });
    const q = calls[0]?.url.searchParams;
    expect(path(calls[0] as Call)).toBe('GET www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(q?.get('timeMin')).toBe('2026-09-25T00:00:00Z');
    expect(q?.get('timeMax')).toBe('2026-09-26T00:00:00Z');
    expect(q?.get('singleEvents')).toBe('true');
    expect(q?.get('orderBy')).toBe('startTime');
    expect(q?.get('maxResults')).toBe('5');
    expect(e).toMatchObject({
      id: 'e1',
      summary: 'Standup',
      allDay: false,
      guests: [{ email: 'joris@example.org', name: 'Joris', response: 'tentative' }],
      meetUrl: 'https://meet.google.com/abc',
    });
  });

  it('creates with guests only when invites may go out, and a Meet link on request', async () => {
    const { workspace, calls } = mockGoogle(() => ({ json: { ...googleEvent, id: 'e2' } }));
    await workspace.calendarCreateEvent('tok', {
      calendarId: 'team@group.calendar.google.com',
      sendUpdates: true,
      event: {
        summary: 'Review',
        start: '2026-09-25T10:00:00+02:00',
        end: '2026-09-25',
        guests: ['a@b.com'],
        timeZone: 'Europe/Amsterdam',
        addMeet: true,
      },
    });
    const c = calls[0] as Call;
    expect(c.url.pathname).toBe('/calendar/v3/calendars/team%40group.calendar.google.com/events');
    expect(c.url.searchParams.get('sendUpdates')).toBe('all');
    expect(c.url.searchParams.get('conferenceDataVersion')).toBe('1');
    const body = JSON.parse(c.body ?? '{}');
    expect(body).toMatchObject({
      summary: 'Review',
      start: { dateTime: '2026-09-25T10:00:00+02:00', timeZone: 'Europe/Amsterdam' },
      end: { date: '2026-09-25' },
      attendees: [{ email: 'a@b.com' }],
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
  });

  it('refuses to switch only one end of an event between timed and all-day', async () => {
    const { workspace, calls } = mockGoogle(() => ({ json: googleEvent }));
    await expect(
      workspace.calendarUpdateEvent('tok', {
        calendarId: 'primary',
        eventId: 'e1',
        patch: { start: '2026-09-25' },
        sendUpdates: false,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    // The same kind as the stored end is fine.
    await workspace.calendarUpdateEvent('tok', {
      calendarId: 'primary',
      eventId: 'e1',
      patch: { start: '2026-09-25T09:00:00+02:00' },
      sendUpdates: false,
    });
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('with only a past end, lists the month before it (IN-25)', async () => {
    const { workspace, calls } = mockGoogle(() => ({ json: { items: [] } }));
    await workspace.calendarEvents('tok', { calendarId: 'primary', to: '2020-09-20T00:00:00Z', limit: 5 });
    const q = calls[0]?.url.searchParams;
    expect(q?.get('timeMin')).toBe('2020-08-21T00:00:00.000Z');
    expect(q?.get('timeMax')).toBe('2020-09-20T00:00:00Z');
    const upcoming = mockGoogle(() => ({ json: { items: [] } }));
    await upcoming.workspace.calendarEvents('tok', {
      calendarId: 'primary',
      to: '2999-01-01T00:00:00Z',
      limit: 5,
    });
    expect(Date.parse(upcoming.calls[0]?.url.searchParams.get('timeMin') ?? '')).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });
});

describe('drive, docs and sheets', () => {
  it('turns plain words into a Drive query (escaped) and keeps the trash out', () => {
    expect(driveQuery("Q3 o'brien")).toBe(
      "(name contains 'Q3' or fullText contains 'Q3') and (name contains 'o\\'brien' or fullText contains 'o\\'brien') and trashed = false",
    );
  });

  it('reads docs as Markdown, sheets as CSV, text files by range, others as metadata', async () => {
    const files: Record<string, object> = {
      d: { id: 'd', name: 'Plan', mimeType: 'application/vnd.google-apps.document' },
      s: { id: 's', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' },
      t: { id: 't', name: 'notes.txt', mimeType: 'text/plain', size: '12' },
      p: { id: 'p', name: 'Invoice.pdf', mimeType: 'application/pdf', size: '4000' },
    };
    const { workspace, calls } = mockGoogle((c) => {
      const [, , , , id, extra] = c.url.pathname.split('/');
      if (extra === 'export')
        return { text: c.url.searchParams.get('mimeType') === 'text/csv' ? 'a,b\n1,2' : '# Plan' };
      if (c.url.searchParams.get('alt') === 'media') return { text: 'hello notes!' };
      return { json: files[id ?? ''] };
    });
    expect(await workspace.filesRead('tok', 'd')).toMatchObject({ format: 'markdown', content: '# Plan' });
    expect(calls.find((c) => c.url.pathname.endsWith('/export'))?.url.searchParams.get('mimeType')).toBe(
      'text/markdown',
    );
    expect(await workspace.filesRead('tok', 's')).toMatchObject({ format: 'csv', content: 'a,b\n1,2' });
    expect(await workspace.filesRead('tok', 't')).toMatchObject({ format: 'text', content: 'hello notes!' });
    expect(calls.find((c) => c.url.searchParams.get('alt') === 'media')?.headers.range).toBe(
      'bytes=0-799999',
    );
    expect(await workspace.filesRead('tok', 'p')).toMatchObject({
      format: 'none',
      content: null,
      file: { kind: 'pdf', size: 4000 },
    });
  });
});

describe('errors and checks', () => {
  it('maps a turned-off API to api_disabled with Google’s activation link', () => {
    const err = googleApiError(403, {
      error: {
        code: 403,
        message: 'Gmail API has not been used in project 123 before or it is disabled.',
        status: 'PERMISSION_DENIED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'SERVICE_DISABLED',
            metadata: {
              activationUrl:
                'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123',
            },
          },
        ],
      },
    });
    expect(err).toMatchObject({
      reason: 'api_disabled',
      enableUrl: 'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123',
    });
    const legacy = googleApiError(403, {
      error: {
        errors: [{ reason: 'accessNotConfigured' }],
        message:
          'Access Not Configured. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=9 then retry.',
      },
    });
    expect(legacy.reason).toBe('api_disabled');
    expect(legacy.enableUrl).toBe(
      'https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=9',
    );
    // Links elsewhere are never passed on.
    expect(
      googleApiError(403, {
        error: {
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://evil.example/x' } }],
        },
      }).enableUrl,
    ).toBeNull();
  });

  it('maps 401, missing scopes, 404 and rate limits', () => {
    expect(googleApiError(401, { error: { message: 'Invalid Credentials' } }).reason).toBe('unauthorized');
    expect(
      googleApiError(403, { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }).reason,
    ).toBe('no_scope');
    expect(googleApiError(404, null).reason).toBe('not_found');
    expect(googleApiError(429, null).reason).toBe('rate_limited');
    expect(googleApiError(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }).reason).toBe(
      'rate_limited',
    );
    expect(googleApiError(500, { error: { message: 'Backend Error' } })).toMatchObject({
      reason: 'other',
      message: 'Backend Error',
    });
  });

  it('checks a service with one cheap call, and reports a turned-off API', async () => {
    const { workspace, calls } = mockGoogle((c) =>
      c.url.host === 'gmail.googleapis.com'
        ? { json: { emailAddress: 'me@x.com' } }
        : {
            status: 403,
            json: {
              error: {
                message: 'disabled',
                details: [
                  {
                    reason: 'SERVICE_DISABLED',
                    metadata: {
                      activationUrl: 'https://console.developers.google.com/apis/api/drive.googleapis.com',
                    },
                  },
                ],
              },
            },
          },
    );
    const scopes = Object.values(GOOGLE_SCOPES);
    expect(await workspace.checkService('tok', 'mail', scopes)).toEqual({ service: 'mail', state: 'ok' });
    expect(path(calls[0] as Call)).toBe('GET gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(await workspace.checkService('tok', 'sheets', scopes)).toEqual({
      service: 'sheets',
      state: 'api_disabled',
      enableUrl: 'https://console.developers.google.com/apis/api/drive.googleapis.com',
    });
    expect(calls[1]?.url.pathname).toBe('/drive/v3/about');
    expect(await workspace.checkService('tok', 'contacts', [GOOGLE_SCOPES.mail])).toMatchObject({
      state: 'no_scope',
    });
    expect(calls).toHaveLength(2);
  });

  it('never calls a host outside Google’s', () => {
    expect(() => googleUrl('https://evil.example/gmail/v1')).toThrow(/not a Google API host/);
    expect(() => googleUrl('http://gmail.googleapis.com/x')).toThrow();
    expect(googleUrl('https://gmail.googleapis.com/gmail/v1/users/me/messages', { q: 'a b' })).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=a+b',
    );
  });
});

describe('withAccessToken', () => {
  function tokens(sequence: string[]) {
    const calls: { forceRefresh: boolean }[] = [];
    const store: ConnectionTokens = {
      async accessFor(_account, _provider, options) {
        calls.push({ forceRefresh: options?.forceRefresh === true });
        return sequence[calls.length - 1] ?? 'none';
      },
    };
    return { services: { google: { tokens: store } } as unknown as Services, calls };
  }

  it('retries a 401 once with a forced refresh', async () => {
    const { services, calls } = tokens(['old', 'new']);
    const { workspace } = mockGoogle((c) =>
      c.headers.authorization === 'Bearer new'
        ? { json: { emailAddress: 'me@x.com' } }
        : { status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } },
    );
    const used: string[] = [];
    const out = await withAccessToken(services, 'acc_1', async (token) => {
      used.push(token);
      return workspace.mailSearch(token, { query: '', limit: 1 });
    });
    expect(out).toEqual([]);
    expect(used).toEqual(['old', 'new']);
    expect(calls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
  });

  it('gives up after the second 401', async () => {
    const { services, calls } = tokens(['old', 'still-bad']);
    const { workspace } = mockGoogle(() => ({
      status: 401,
      json: { error: { message: 'Invalid Credentials' } },
    }));
    await expect(
      withAccessToken(services, 'acc_1', (token) => workspace.mailSendDraft(token, 'd1')),
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(calls).toHaveLength(2);
  });

  it('does not retry other errors', async () => {
    const { services, calls } = tokens(['t']);
    const { workspace } = mockGoogle(() => ({ status: 404, json: { error: { message: 'Not Found' } } }));
    await expect(
      withAccessToken(services, 'acc_1', (token) => workspace.filesGet(token, 'x')),
    ).rejects.toMatchObject({ reason: 'not_found' });
    expect(calls).toHaveLength(1);
  });
});
