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
  it('baselines with $deltaToken=latest, reads metadata only, and fetches attachment metadata only when needed', async () => {
    const delta1 = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=tok1';
    const delta2 = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=tok2';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ value: [], '@odata.deltaLink': delta1 }))
      .mockResolvedValueOnce(
        response({
          value: [
            {
              id: 'm_old_modified',
              conversationId: 'c_old',
              from: { emailAddress: { name: 'Old', address: 'old@example.com' } },
              subject: 'Old read-state change',
              receivedDateTime: '2026-10-20T08:00:00Z',
              hasAttachments: false,
              isDraft: false,
            },
            {
              id: 'm_new',
              conversationId: 'c_new',
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
    const baseline = await ws.mailBaseline('tok');
    expect(baseline).toEqual({ kind: 'microsoft', deltaLink: delta1 });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('$deltaToken')).toBe('latest');

    const changes = await ws.mailChanges('tok', baseline, {
      needAttachmentTypes: true,
      since: new Date('2026-10-28T10:00:00Z'),
    });
    expect(changes.cursor).toEqual({ kind: 'microsoft', deltaLink: delta2 });
    expect(changes.headers).toHaveLength(1);
    expect(changes.headers[0]).toMatchObject({
      id: 'm_new',
      from: 'Billing <billing@example.com>',
      subject: 'Invoice 99',
      hasAttachments: true,
      attachments: [{ id: 'a1', name: 'invoice-99.pdf', mimeType: 'application/pdf', size: 4200 }],
    });
    // Attachment metadata endpoint queried with $select (never contentBytes).
    const attUrl = new URL(String(fetcher.mock.calls[2]?.[0]));
    expect(attUrl.pathname).toBe('/v1.0/me/messages/m_new/attachments');
    expect(attUrl.searchParams.get('$select')).not.toContain('contentBytes');
  });

  it('skips attachment calls when attachment types are not needed and re-baselines on 410', async () => {
    const delta1 = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=tok1';
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
      .mockResolvedValueOnce(response({ value: [], '@odata.deltaLink': deltaFresh }));

    const ws = new MicrosoftWorkspace(fetcher);
    const changes = await ws.mailChanges(
      'tok',
      { kind: 'microsoft', deltaLink: delta1 },
      { needAttachmentTypes: false, since: new Date('2026-10-28T10:00:00Z') },
    );
    expect(changes.headers).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const reset = await ws.mailChanges('tok', { kind: 'microsoft', deltaLink: delta1 });
    expect(reset).toEqual({ cursor: { kind: 'microsoft', deltaLink: deltaFresh }, headers: [], reset: true });
  });
});
