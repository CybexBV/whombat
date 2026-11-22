import { microsoftScopesFor, microsoftServicesGranted } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { MicrosoftOAuth } from './microsoft-oauth';
import { graphRecurrence } from './microsoft-recurrence';
import { MicrosoftWorkspace } from './microsoft-workspace';

const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const meta = {
  id: 'file1',
  name: 'invoice.pdf',
  size: 4,
  file: { mimeType: 'application/pdf' },
  webUrl: 'https://example.sharepoint.com/invoice.pdf',
};

describe('Microsoft delegated access', () => {
  it('requests PKCE and only the selected service scopes', () => {
    const oauth = new MicrosoftOAuth();
    const url = new URL(
      oauth.authorizeUrl({
        app: { clientId: 'client', clientSecret: 'secret', userType: null, source: 'settings' },
        redirectUri: 'https://dev.whombat.com/connect/microsoft',
        scopes: microsoftScopesFor(['mail']),
        state: 'single-use',
        codeChallenge: 'challenge',
      }),
    );
    expect(url.hostname).toBe('login.microsoftonline.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('scope')).not.toContain('Files.ReadWrite');
    expect(microsoftServicesGranted(['User.Read', 'Mail.ReadWrite'])).toEqual([]);
    expect(microsoftServicesGranted(['Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send'])).toEqual([
      'mail',
    ]);
  });
  it('does not forward a mailbox token to a signed file download', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(meta))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://tenant.sharepoint.com/download?signature=test' },
        }),
      )
      .mockResolvedValueOnce(new Response('data'));
    const binary = await new MicrosoftWorkspace(fetcher).filesDownload('private-token', 'file1');
    expect(Buffer.from(binary.contentBase64, 'base64').toString()).toBe('data');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer private-token' });
    expect(fetcher.mock.calls[2]?.[1]?.headers).toBeUndefined();
    expect(fetcher.mock.calls[2]?.[1]?.redirect).toBe('error');
  });
  it('refuses download redirects outside Microsoft before making the request', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(meta))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } }),
      );
    await expect(new MicrosoftWorkspace(fetcher).filesDownload('private-token', 'file1')).rejects.toThrow(
      'unexpected download host',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('refuses large inline attachments before creating a draft', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new MicrosoftWorkspace(fetcher).mailDraft('token', {
        to: ['a@example.com'],
        cc: [],
        bcc: [],
        subject: 'Invoice',
        body: '',
        attachments: [
          {
            name: 'large.pdf',
            mimeType: 'application/pdf',
            contentBase64: Buffer.alloc(3 * 1024 ** 2).toString('base64'),
          },
        ],
      }),
    ).rejects.toThrow('3 MiB');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the selected local time zone across a daylight-saving transition', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        id: 'e1',
        subject: 'Weekly',
        start: { dateTime: '2026-10-20T08:00:00' },
        end: { dateTime: '2026-10-20T09:00:00' },
      }),
    );
    await new MicrosoftWorkspace(fetcher).calendarCreateEvent('token', {
      calendarId: 'primary',
      sendUpdates: false,
      event: {
        summary: 'Weekly',
        start: '2026-10-20T10:00:00+02:00',
        end: '2026-10-20T11:00:00+02:00',
        timeZone: 'Europe/Amsterdam',
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=TU'],
        guests: [],
      },
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.start).toEqual({ dateTime: '2026-10-20T10:00:00', timeZone: 'Europe/Amsterdam' });
    expect(body.recurrence).toMatchObject({
      pattern: { type: 'weekly', daysOfWeek: ['tuesday'] },
      range: { recurrenceTimeZone: 'Europe/Amsterdam', numberOfOccurrences: 3 },
    });
  });
  it('refuses unsupported recurrence details instead of silently changing a schedule', () => {
    expect(() =>
      graphRecurrence({ start: '2026-10-20', recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=2TU'] }),
    ).toThrow('BYMONTHDAY');
    expect(() =>
      graphRecurrence({ start: '2026-10-20', recurrence: ['RRULE:FREQ=WEEKLY;BYSETPOS=2'] }),
    ).toThrow('unsupported');
  });
});

describe('Microsoft unread mail', () => {
  it('counts the inbox’s unread from its folder and lists the newest unread, sorted the way Graph allows', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ unreadItemCount: 12 }))
      .mockResolvedValueOnce(
        response({
          value: [
            {
              id: 'm1',
              conversationId: 'c1',
              from: { emailAddress: { name: 'Anna Jansen', address: 'anna@example.com' } },
              subject: 'Invoice',
              receivedDateTime: '2026-10-28T08:00:00Z',
              isRead: false,
            },
          ],
        }),
      );
    const got = await new MicrosoftWorkspace(fetcher).inboxUnread('tok', { newest: 3 });
    expect(got.count).toBe(12);
    expect(got.newest.map((m) => [m.subject, m.from, m.unread])).toEqual([
      ['Invoice', 'Anna Jansen <anna@example.com>', true],
    ]);
    const urls = fetcher.mock.calls.map(([u]) => new URL(String(u)));
    expect(urls[0]?.pathname).toBe('/v1.0/me/mailFolders/inbox');
    expect(urls[1]?.pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
    // The sort's property comes first in the filter (Graph refuses it otherwise).
    expect(urls[1]?.searchParams.get('$filter')).toMatch(/^receivedDateTime .* and isRead eq false$/);
    expect(urls[1]?.searchParams.get('$orderby')).toBe('receivedDateTime desc');
    expect(urls[1]?.searchParams.get('$top')).toBe('3');
  });

  it('reads only the count when nothing is unread', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ unreadItemCount: 0 }));
    expect(await new MicrosoftWorkspace(fetcher).inboxUnread('tok', { newest: 3 })).toEqual({
      count: 0,
      newest: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('Microsoft complete observations', () => {
  it('reads every attachment page before computing the approved digests', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ isDraft: true, id: 'draft', subject: 'Invoice' }))
      .mockResolvedValueOnce(
        response({
          value: [{ id: 'a' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages/draft/attachments?$skiptoken=next',
        }),
      )
      .mockResolvedValueOnce(response({ value: [{ id: 'b' }] }))
      .mockResolvedValueOnce(
        response({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.txt', contentBytes: 'YQ==' }),
      )
      .mockResolvedValueOnce(
        response({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'b.txt', contentBytes: 'Yg==' }),
      );
    const draft = await new MicrosoftWorkspace(fetcher).mailGetDraft('token', 'draft');
    expect(draft.attachments.map((a) => a.name)).toEqual(['a.txt', 'b.txt']);
    expect(draft.attachments[0]?.sha256).not.toBe(draft.attachments[1]?.sha256);
  });
  it('polls a signed OneDrive copy monitor without forwarding the Graph token', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 202,
          headers: { location: 'https://api.onedrive.com/monitor/123?signature=opaque' },
        }),
      )
      .mockResolvedValueOnce(response({ status: 'completed', resourceId: 'file1' }))
      .mockResolvedValueOnce(response(meta));
    expect(
      await new MicrosoftWorkspace(fetcher).filesOrganize('private-token', {
        action: 'copy',
        fileId: 'source',
        folderId: 'folder',
      }),
    ).toMatchObject({ id: 'file1' });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({});
  });
  it('requires an explicit time zone for timed recurrence', () => {
    expect(() =>
      graphRecurrence({ start: '2026-10-20T08:00:00Z', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] }),
    ).toThrow('timeZone');
  });
});

describe('Microsoft mail change feed', () => {
  it('pages through the documented inbox delta without $deltaToken=latest, keeps only post-activation mail, and fetches attachment metadata only when needed', async () => {
    const next1 = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=page2';
    const delta1 = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=tok1';
    const delta2 = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=tok2';
    const fetcher = vi
      .fn<typeof fetch>()
      // Initial delta page 1: pre-existing old mail only, continues via @odata.nextLink.
      .mockResolvedValueOnce(
        response({
          value: [
            {
              id: 'm_preexisting',
              conversationId: 'c_pre',
              internetMessageId: '<pre@example.com>',
              from: { emailAddress: { name: 'Old', address: 'old@example.com' } },
              subject: 'Before activation',
              receivedDateTime: '2026-10-20T08:00:00Z',
              hasAttachments: true,
              isDraft: false,
            },
          ],
          '@odata.nextLink': next1,
        }),
      )
      // Initial delta page 2: one mail arrived right after activation (within skew), returns @odata.deltaLink.
      .mockResolvedValueOnce(
        response({
          value: [
            {
              id: 'm_backfill',
              conversationId: 'c_back',
              internetMessageId: ' <Backfill@Example.com> ',
              from: { emailAddress: { name: 'Billing', address: 'billing@example.com' } },
              subject: 'Invoice 98',
              bodyPreview: 'Sent right after activation',
              receivedDateTime: '2026-10-28T09:59:57Z',
              hasAttachments: false,
              isDraft: false,
            },
          ],
          '@odata.deltaLink': delta1,
        }),
      )
      // Incremental delta call.
      .mockResolvedValueOnce(
        response({
          value: [
            {
              id: 'm_old_modified',
              conversationId: 'c_old',
              internetMessageId: '<old-mod@example.com>',
              from: { emailAddress: { name: 'Old', address: 'old@example.com' } },
              subject: 'Old read-state change',
              receivedDateTime: '2026-10-20T08:00:00Z',
              hasAttachments: false,
              isDraft: false,
            },
            {
              id: 'm_new',
              conversationId: 'c_new',
              internetMessageId: '<inv99@example.com>',
              from: { emailAddress: { name: 'Billing', address: 'billing@example.com' } },
              subject: 'Invoice 99',
              bodyPreview: 'Attached',
              receivedDateTime: '2026-10-28T10:05:00Z',
              hasAttachments: true,
              isDraft: false,
            },
          ],
          '@odata.deltaLink': delta2,
        }),
      )
      .mockResolvedValueOnce(
        response({
          value: [{ id: 'a1', name: 'invoice-99.pdf', contentType: 'application/pdf', size: 4200 }],
        }),
      );

    const ws = new MicrosoftWorkspace(fetcher);
    const activation = new Date('2026-10-28T10:00:00Z');
    const baseline = await ws.mailBaseline('tok', { needAttachmentTypes: true, since: activation });
    expect(baseline.cursor).toEqual({ kind: 'microsoft', deltaLink: delta1 });
    // Documented message-delta URL: no $deltaToken=latest, limits to activation - 5 s skew, selects internetMessageId.
    const firstUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(firstUrl.pathname).toBe('/v1.0/me/mailFolders/inbox/messages/delta');
    expect(firstUrl.searchParams.has('$deltaToken')).toBe(false);
    expect(firstUrl.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-10-28T09:59:55Z');
    expect(firstUrl.searchParams.get('$select')).toContain('internetMessageId');
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(next1);
    // Pre-existing message dropped (no attachment lookup for it), post-activation message kept with normalized Message-ID.
    expect(baseline.headers).toHaveLength(1);
    expect(baseline.headers[0]).toMatchObject({
      id: 'm_backfill',
      messageId: '<backfill@example.com>',
      subject: 'Invoice 98',
    });

    const changes = await ws.mailChanges('tok', baseline.cursor, {
      needAttachmentTypes: true,
      since: activation,
    });
    expect(changes.cursor).toEqual({ kind: 'microsoft', deltaLink: delta2 });
    expect(changes.headers).toHaveLength(1);
    expect(changes.headers[0]).toMatchObject({
      id: 'm_new',
      messageId: '<inv99@example.com>',
      from: 'Billing <billing@example.com>',
      subject: 'Invoice 99',
      hasAttachments: true,
      attachments: [{ id: 'a1', name: 'invoice-99.pdf', mimeType: 'application/pdf', size: 4200 }],
    });
    // Attachment metadata endpoint queried with $select (never contentBytes).
    const attUrl = new URL(String(fetcher.mock.calls[3]?.[0]));
    expect(attUrl.pathname).toBe('/v1.0/me/messages/m_new/attachments');
    expect(attUrl.searchParams.get('$select')).not.toContain('contentBytes');
  });

  it('skips attachment calls when attachment types are not needed and resyncs on 410 from resyncSince', async () => {
    const delta1 = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=tok1';
    const nextResync = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=r2';
    const deltaFresh =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fresh';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          value: [
            {
              id: 'm_new',
              conversationId: 'c_new',
              internetMessageId: '<inv@example.com>',
              from: { emailAddress: { address: 'billing@example.com' } },
              subject: 'Invoice',
              receivedDateTime: '2026-10-28T10:05:00Z',
              hasAttachments: true,
              isDraft: false,
            },
          ],
          '@odata.deltaLink': deltaFresh,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'syncStateNotFound' } }), { status: 410 }),
      )
      .mockResolvedValueOnce(
        response({
          value: [
            {
              id: 'm_before_poll',
              conversationId: 'c_old',
              from: { emailAddress: { address: 'old@example.com' } },
              subject: 'Already polled',
              receivedDateTime: '2026-10-28T09:00:00Z',
              hasAttachments: false,
              isDraft: false,
            },
          ],
          '@odata.nextLink': nextResync,
        }),
      )
      .mockResolvedValueOnce(
        response({
          value: [
            {
              id: 'm_missed_during_expiry',
              conversationId: 'c_missed',
              internetMessageId: '<missed@example.com>',
              from: { emailAddress: { address: 'billing@example.com' } },
              subject: 'Arrived while expired',
              receivedDateTime: '2026-10-28T10:15:00Z',
              hasAttachments: false,
              isDraft: false,
            },
          ],
          '@odata.deltaLink': deltaFresh,
        }),
      );

    const ws = new MicrosoftWorkspace(fetcher);
    const changes = await ws.mailChanges(
      'tok',
      { kind: 'microsoft', deltaLink: delta1 },
      { needAttachmentTypes: false, since: new Date('2026-10-28T10:00:00Z') },
    );
    expect(changes.headers).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const reset = await ws.mailChanges(
      'tok',
      { kind: 'microsoft', deltaLink: delta1 },
      {
        since: new Date('2026-10-28T08:00:00Z'),
        resyncSince: new Date('2026-10-28T10:10:00Z'),
      },
    );
    expect(reset.reset).toBe(true);
    expect(reset.cursor).toEqual({ kind: 'microsoft', deltaLink: deltaFresh });
    expect(reset.headers).toHaveLength(1);
    expect(reset.headers[0]).toMatchObject({
      id: 'm_missed_during_expiry',
      messageId: '<missed@example.com>',
      subject: 'Arrived while expired',
    });
  });

  it('keeps paging position across polls when a large inbox delta spans more than one poll cap', async () => {
    const activation = new Date('2026-10-28T10:00:00Z');
    const totalPages = 25;
    const finalDelta =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=done';
    const nextUrl = (n: number) =>
      `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=page_${n}`;

    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      calls++;
      const pageNum = calls;
      const body: Record<string, unknown> = {
        value: [
          {
            id: `m_page_${pageNum}`,
            conversationId: `c_${pageNum}`,
            internetMessageId: `<page-${pageNum}@example.com>`,
            from: { emailAddress: { name: 'Billing', address: 'billing@example.com' } },
            subject: `Invoice page ${pageNum}`,
            receivedDateTime: new Date(activation.getTime() + pageNum * 1_000).toISOString(),
            hasAttachments: false,
            isDraft: false,
          },
        ],
      };
      if (pageNum < totalPages) {
        body['@odata.nextLink'] = nextUrl(pageNum + 1);
      } else {
        body['@odata.deltaLink'] = finalDelta;
      }
      // First call must limit by receivedDateTime ge activation - 5s.
      if (pageNum === 1) {
        const u = new URL(String(url));
        expect(u.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-10-28T09:59:55Z');
      }
      return response(body);
    });

    const ws = new MicrosoftWorkspace(fetcher);
    // Poll 1: caps at 20 pages, persists nextLink + paging without throwing, and emits the first 20 headers.
    const first = await ws.mailBaseline('tok', { since: activation });
    expect(calls).toBe(20);
    expect(first.more).toBe(true);
    expect(first.cursor).toEqual({
      kind: 'microsoft',
      deltaLink: nextUrl(21),
      paging: { sinceMs: activation.getTime() },
    });
    expect(first.headers).toHaveLength(20);
    expect(first.headers[0]?.id).toBe('m_page_1');

    // Poll 2: resumes from page 21 through page 25, reaches @odata.deltaLink, clears paging and emits the rest.
    const second = await ws.mailChanges('tok', first.cursor, { since: activation });
    expect(calls).toBe(totalPages);
    expect(second.more).toBeUndefined();
    expect(second.cursor).toEqual({ kind: 'microsoft', deltaLink: finalDelta });
    expect(second.headers).toHaveLength(5);
    expect(second.headers[4]?.id).toBe('m_page_25');

    // Unfiltered baseline (no `since`) also keeps paging across polls without emitting pre-existing headers.
    let dropCalls = 0;
    const dropFetcher = vi.fn<typeof fetch>(async () => {
      dropCalls++;
      return response({
        value: [
          {
            id: `m_pre_${dropCalls}`,
            conversationId: `c_pre_${dropCalls}`,
            from: { emailAddress: { address: 'old@example.com' } },
            subject: `Old ${dropCalls}`,
            receivedDateTime: '2026-10-01T00:00:00Z',
            hasAttachments: false,
            isDraft: false,
          },
        ],
        ...(dropCalls < 22
          ? { '@odata.nextLink': nextUrl(dropCalls + 1) }
          : { '@odata.deltaLink': finalDelta }),
      });
    });
    const wsDrop = new MicrosoftWorkspace(dropFetcher);
    const d1 = await wsDrop.mailBaseline('tok');
    expect(d1.more).toBe(true);
    expect(d1.headers).toEqual([]);
    expect(d1.cursor).toEqual({
      kind: 'microsoft',
      deltaLink: nextUrl(21),
      paging: { dropHeaders: true },
    });
    const d2 = await wsDrop.mailChanges('tok', d1.cursor);
    expect(d2.more).toBeUndefined();
    expect(d2.headers).toEqual([]);
    expect(d2.cursor).toEqual({ kind: 'microsoft', deltaLink: finalDelta });
  });

  it('retries mailBaseline without $filter on HTTP 400 and still drops pre-activation mail client-side', async () => {
    const activation = new Date('2026-10-28T10:00:00Z');
    const finalDelta =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=unfiltered';
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const u = new URL(String(input));
      if (u.searchParams.has('$filter')) {
        return new Response(
          JSON.stringify({ error: { code: 'ErrorInvalidRequest', message: 'Filter not supported' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return response({
        value: [
          {
            id: 'm_old',
            conversationId: 'c_old',
            from: { emailAddress: { address: 'old@example.com' } },
            subject: 'Before activation',
            receivedDateTime: '2026-10-28T09:00:00Z',
            hasAttachments: false,
            isDraft: false,
          },
          {
            id: 'm_after',
            conversationId: 'c_after',
            internetMessageId: '<after@example.com>',
            from: { emailAddress: { name: 'Billing', address: 'billing@example.com' } },
            subject: 'Invoice after activation',
            receivedDateTime: '2026-10-28T10:02:00Z',
            hasAttachments: false,
            isDraft: false,
          },
        ],
        '@odata.deltaLink': finalDelta,
      });
    });

    const ws = new MicrosoftWorkspace(fetcher);
    const baseline = await ws.mailBaseline('tok', { since: activation });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('$filter')).toBe(
      'receivedDateTime ge 2026-10-28T09:59:55Z',
    );
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.has('$filter')).toBe(false);
    expect(baseline.cursor).toEqual({ kind: 'microsoft', deltaLink: finalDelta });
    expect(baseline.headers.map((h) => h.id)).toEqual(['m_after']);

    // If the unfiltered retry also returns 400, propagate without looping.
    const always400 = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: { code: 'BadRequest' } }), { status: 400 }),
    );
    await expect(
      new MicrosoftWorkspace(always400).mailBaseline('tok', { since: activation }),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(always400).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a previous page’s nextLink when a later delta page omits both links', async () => {
    const activation = new Date('2026-10-28T10:00:00Z');
    const page2 = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=p2';
    const fetcher = vi
      .fn<typeof fetch>()
      // Page 1 provides @odata.nextLink -> page 2.
      .mockResolvedValueOnce(
        response({
          value: [],
          '@odata.nextLink': page2,
        }),
      )
      // Page 2 returns neither @odata.deltaLink nor @odata.nextLink.
      .mockResolvedValueOnce(response({ value: [] }));

    const ws = new MicrosoftWorkspace(fetcher);
    await expect(ws.mailBaseline('tok', { since: activation })).rejects.toThrow('delta link');
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Same guard for mailChanges: missing links on page 2 must fail rather than reusing page 2's link.
    const changesFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ value: [], '@odata.nextLink': page2 }))
      .mockResolvedValueOnce(response({ value: [] }));
    await expect(
      new MicrosoftWorkspace(changesFetcher).mailChanges('tok', {
        kind: 'microsoft',
        deltaLink: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=p1',
        paging: { sinceMs: activation.getTime() },
      }),
    ).rejects.toThrow('delta link');
    expect(changesFetcher).toHaveBeenCalledTimes(2);

    // HTTP 400 on a stale deltaLink in mailChanges resets via mailBaseline.
    const freshDelta = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=ok';
    const resetFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'InvalidDeltaToken' } }), { status: 400 }),
      )
      .mockResolvedValueOnce(response({ value: [], '@odata.deltaLink': freshDelta }));
    const reset = await new MicrosoftWorkspace(resetFetcher).mailChanges(
      'tok',
      {
        kind: 'microsoft',
        deltaLink: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=stale',
      },
      { since: activation, resyncSince: activation },
    );
    expect(reset.reset).toBe(true);
    expect(reset.cursor).toEqual({ kind: 'microsoft', deltaLink: freshDelta });
  });
});
