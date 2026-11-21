import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/errors';
import { type FakeSmtp, startFakeSmtp } from '../../test/mail';
import { MAIL_CERT } from '../../test/self-signed';
import { ConnectionUnavailableError } from '../types';
import { parseMessageId } from './ids';
import { MemoryMailServer } from './memory';
import { nodemailerSmtp, type SmtpConnectOptions } from './smtp';
import {
  IMAP_ONLY_MAIL_TEXT,
  type ImapAccount,
  ImapWorkspace,
  type MailConnector,
  MESSAGE_GONE_TEXT,
  NEEDS_PASSWORD_TEXT,
  ONE_FOLDER_TEXT,
} from './workspace';

const user = 'jo@home.test';
const pass = 'app-password-1';
const now = new Date('2026-10-19T09:00:00Z');
const TOKEN = 'conn_imap1';

function mail(o: {
  from: string;
  to?: string;
  subject: string;
  body: string;
  id: string;
  refs?: string;
  html?: boolean;
  date?: string;
}): string {
  return [
    `From: ${o.from}`,
    `To: ${o.to ?? 'Jo <jo@home.test>'}`,
    `Subject: ${o.subject}`,
    `Date: ${o.date ?? 'Mon, 19 Oct 2026 08:00:00 +0000'}`,
    `Message-ID: ${o.id}`,
    ...(o.refs ? [`References: ${o.refs}`, `In-Reply-To: ${o.refs.split(' ').at(-1)}`] : []),
    `Content-Type: ${o.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
    '',
    o.body,
  ].join('\r\n');
}

const withFile = [
  'From: Shop <shop@example.com>',
  'To: jo@home.test',
  'Subject: Your receipt',
  'Date: Mon, 19 Oct 2026 07:00:00 +0000',
  'Message-ID: <receipt@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Thanks for your order.',
  '--b1',
  'Content-Type: application/pdf',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="receipt.pdf"',
  '',
  Buffer.from('%PDF-1.4 receipt').toString('base64'),
  '--b1--',
  '',
].join('\r\n');

async function rejection(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('Email (IMAP) behind the mail tools', () => {
  let smtp: FakeSmtp;
  let server: MemoryMailServer;
  let account: ImapAccount;
  let refused: string[];
  let connector: MailConnector;
  let ws: ImapWorkspace;

  const smtpOptions = (a: ImapAccount): SmtpConnectOptions => ({
    address: '127.0.0.1',
    host: 'mail.home.test',
    port: smtp.port,
    security: 'tls',
    user: a.user,
    pass: a.password,
    ca: MAIL_CERT,
  });

  beforeAll(async () => {
    smtp = await startFakeSmtp({ user, pass, security: 'tls' });
  });
  afterAll(() => smtp.close());

  beforeEach(() => {
    server = new MemoryMailServer({ user, pass });
    account = {
      email: user,
      name: 'Jo Smith',
      user,
      password: pass,
      imap: { host: 'mail.home.test', port: 993, security: 'tls' },
      smtp: { host: 'mail.home.test', port: 465, security: 'tls' },
      savesSent: false,
    };
    refused = [];
    connector = {
      imap: (a) => server.connect({ user: a.user, pass: a.password }),
      smtpVerify: (a) => nodemailerSmtp.verify(smtpOptions(a)),
      smtpSend: (a, envelope, raw) => nodemailerSmtp.send(smtpOptions(a), envelope, raw),
    };
    ws = new ImapWorkspace({
      account: async () => account,
      refused: async (t) => {
        refused.push(t);
      },
      connector,
      now: () => now,
    });
    server.add(
      'INBOX',
      mail({
        from: 'Mara <mara@example.com>',
        subject: 'Budget',
        body: 'The budget is attached.',
        id: '<a@example.com>',
      }),
      {
        flags: ['\\Seen'],
        date: new Date('2026-10-18T08:00:00Z'),
      },
    );
    server.add(
      'INBOX',
      mail({
        from: 'Bo <bo@example.com>',
        subject: 'Lunch?',
        body: '<p>Lunch <b>today</b>?</p>',
        id: '<b@example.com>',
        html: true,
      }),
      {
        flags: ['\\Flagged'],
        date: new Date('2026-10-19T08:00:00Z'),
      },
    );
    server.add('INBOX', withFile, { flags: ['\\Seen'], date: new Date('2026-10-17T08:00:00Z') });
  });

  it('counts the inbox’s unread with STATUS and lists the newest unread without marking them read', async () => {
    expect(await ws.inboxUnread(TOKEN)).toEqual({ count: 1, newest: [] });
    const got = await ws.inboxUnread(TOKEN, { newest: 3 });
    expect(got.count).toBe(1);
    expect(got.newest.map((m) => [m.subject, m.unread])).toEqual([['Lunch?', true]]);
    expect(got.newest[0]?.from).toContain('bo@example.com');
    expect((await ws.inboxUnread(TOKEN)).count).toBe(1);
  });

  it('searches with Gmail’s words, newest first, with snippets and labels', async () => {
    const all = await ws.mailSearch(TOKEN, { query: '', limit: 10 });
    expect(all.map((m) => m.subject)).toEqual(['Lunch?', 'Budget', 'Your receipt']);
    const lunch = all[0];
    expect(lunch?.from).toBe('Bo <bo@example.com>');
    expect(lunch?.snippet).toBe('Lunch today?');
    expect(lunch?.unread).toBe(true);
    expect(lunch?.labels).toEqual(['INBOX', 'STARRED', 'UNREAD']);
    expect(parseMessageId(lunch?.id ?? '')).toMatchObject({ mailbox: 'INBOX', uid: 2 });

    expect(
      (await ws.mailSearch(TOKEN, { query: 'from:mara is:read', limit: 10 })).map((m) => m.subject),
    ).toEqual(['Budget']);
    expect((await ws.mailSearch(TOKEN, { query: '-is:starred', limit: 1 })).map((m) => m.subject)).toEqual([
      'Your receipt',
    ]);
    expect(await ws.mailSearch(TOKEN, { query: 'in:sent', limit: 10 })).toEqual([]);
    const err = await rejection(ws.mailSearch(TOKEN, { query: 'in:Receipts', limit: 10 }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain('Receipts');
    expect(err.message).toContain('Archive');
  });

  it('reads a message as text, lists its files and downloads one', async () => {
    const [found] = await ws.mailSearch(TOKEN, { query: 'subject:receipt', limit: 1 });
    const [message] = await ws.mailRead(TOKEN, { messageId: found?.id ?? '' });
    expect(message?.body).toBe('Thanks for your order.');
    expect(message?.attachments).toEqual([
      { id: '1', name: 'receipt.pdf', mimeType: 'application/pdf', size: 16 },
    ]);
    const file = await ws.mailAttachment(TOKEN, { messageId: found?.id ?? '', attachmentId: '1' });
    expect(Buffer.from(file.contentBase64, 'base64').toString()).toBe('%PDF-1.4 receipt');
    await expect(ws.mailAttachment(TOKEN, { messageId: found?.id ?? '', attachmentId: '2' })).rejects.toThrow(
      'isn’t on this message',
    );
    const [html] = await ws.mailRead(TOKEN, {
      messageId: (await ws.mailSearch(TOKEN, { query: 'lunch', limit: 1 }))[0]?.id ?? '',
    });
    expect(html?.body).toBe('Lunch today?');
    // Reading never marks a message read.
    expect([...(server.folder('INBOX').messages[1]?.flags ?? [])]).toEqual(['\\Flagged']);
  });

  it('answers a message whose folder was renumbered as gone', async () => {
    const [found] = await ws.mailSearch(TOKEN, { query: 'budget', limit: 1 });
    server.renumber('INBOX');
    const err = await rejection(ws.mailRead(TOKEN, { messageId: found?.id ?? '' }));
    expect(err.message).toBe(MESSAGE_GONE_TEXT);
  });

  it('reads a thread from its folder and Sent, oldest first', async () => {
    server.add(
      'Sent',
      mail({
        from: user,
        to: 'mara@example.com',
        subject: 'Re: Budget',
        body: 'Looks good.',
        id: '<r1@home.test>',
        refs: '<a@example.com>',
      }),
      { flags: ['\\Seen'], date: new Date('2026-10-18T09:00:00Z') },
    );
    server.add(
      'INBOX',
      mail({
        from: 'Mara <mara@example.com>',
        subject: 'Re: Budget',
        body: 'Great, thanks.',
        id: '<r2@example.com>',
        refs: '<a@example.com> <r1@home.test>',
      }),
      { date: new Date('2026-10-18T10:00:00Z') },
    );
    const results = await ws.mailSearch(TOKEN, { query: 'budget', limit: 10 });
    expect(new Set(results.map((m) => m.threadId)).size).toBe(1);
    const thread = await ws.mailRead(TOKEN, { threadId: results[0]?.threadId ?? '' });
    expect(thread.map((m) => m.body)).toEqual(['The budget is attached.', 'Looks good.', 'Great, thanks.']);
    expect(thread[1]?.labels[0]).toBe('SENT');
  });

  it('drafts a reply in Drafts, threads it, and shows every recipient', async () => {
    const [original] = await ws.mailSearch(TOKEN, { query: 'budget', limit: 1 });
    const { draftId } = await ws.mailDraft(TOKEN, {
      to: ['mara@example.com'],
      cc: [],
      bcc: ['boss@home.test'],
      subject: '',
      body: 'Thanks, Mara.\nSee you.',
      replyToMessageId: original?.id ?? '',
      attachments: [
        { name: 'notes.txt', mimeType: 'text/plain', contentBase64: Buffer.from('notes').toString('base64') },
      ],
    });
    expect(parseMessageId(draftId)?.mailbox).toBe('Drafts');
    const stored = server.folder('Drafts').messages[0];
    expect([...(stored?.flags ?? [])]).toContain('\\Draft');
    const raw = stored?.raw.toString() ?? '';
    expect(raw).toMatch(/^From: Jo Smith <jo@home\.test>\r\n/);
    expect(raw).toContain('In-Reply-To: <a@example.com>');
    expect(raw).toContain('Bcc: boss@home.test');

    const draft = await ws.mailGetDraft(TOKEN, draftId);
    expect(draft).toMatchObject({
      draftId,
      to: ['mara@example.com'],
      cc: [],
      bcc: ['boss@home.test'],
      subject: 'Re: Budget',
      body: 'Thanks, Mara.\nSee you.',
    });
    expect(draft.attachments).toEqual([expect.objectContaining({ name: 'notes.txt', size: 5 })]);
    expect(draft.threadId).toBe(original?.threadId);
  });

  it('sends a draft over SMTP without its Bcc header, keeps a copy in Sent and removes the draft', async () => {
    const before = smtp.messages.length;
    const { draftId } = await ws.mailDraft(TOKEN, {
      to: ['mara@example.com'],
      cc: ['bo@example.com'],
      bcc: ['boss@home.test'],
      subject: 'Plan',
      body: 'Here is the plan.',
    });
    const sent = await ws.mailSendDraft(TOKEN, draftId);
    const taken = smtp.messages[before];
    expect(taken?.from).toBe(user);
    expect(taken?.to).toEqual(['mara@example.com', 'bo@example.com', 'boss@home.test']);
    expect(taken?.raw).not.toMatch(/^Bcc:/im);
    expect(taken?.raw).toContain('Subject: Plan');
    const copy = server.folder('Sent').messages.at(-1);
    expect(copy?.raw.toString()).toContain('Bcc: boss@home.test');
    expect([...(copy?.flags ?? [])]).toEqual(['\\Seen']);
    expect(parseMessageId(sent.messageId)?.mailbox).toBe('Sent');
    expect(server.folder('Drafts').messages).toEqual([]);

    // A provider that keeps its own copy gets none from Whombat.
    account = { ...account, savesSent: true };
    const second = await ws.mailDraft(TOKEN, {
      to: ['mara@example.com'],
      cc: [],
      bcc: [],
      subject: 'Two',
      body: 'x',
    });
    const copies = server.folder('Sent').messages.length;
    await ws.mailSendDraft(TOKEN, second.draftId);
    expect(server.folder('Sent').messages.length).toBe(copies);
  });

  it('adds no Sent copy when the provider kept one itself, whatever the hints say', async () => {
    const send = connector.smtpSend;
    // This provider files what it sends in Sent on its own.
    connector.smtpSend = async (a, envelope, raw) => {
      server.add('Sent', raw, { flags: ['\\Seen'] });
      return send(a, envelope, raw);
    };
    const { draftId } = await ws.mailDraft(TOKEN, {
      to: ['mara@example.com'],
      cc: [],
      bcc: [],
      subject: 'Once',
      body: 'x',
    });
    const sent = await ws.mailSendDraft(TOKEN, draftId);
    expect(server.folder('Sent').messages).toHaveLength(1);
    expect(parseMessageId(sent.messageId)).toMatchObject({ mailbox: 'Sent', uid: 1 });
  });

  it('finds a new draft by its Message-ID on a server without UIDPLUS', async () => {
    server.capabilities = new Set(['IMAP4REV1']);
    const { draftId } = await ws.mailDraft(TOKEN, {
      to: ['a@example.com'],
      cc: [],
      bcc: [],
      subject: 'S',
      body: 'B',
    });
    expect(parseMessageId(draftId)).toMatchObject({ mailbox: 'Drafts', uid: 1 });
  });

  it('organises: read and unread, stars, folders as labels, archive', async () => {
    const ids = (await ws.mailSearch(TOKEN, { query: '', limit: 10 })).map((m) => m.id);
    const [lunch, budget, receipt] = ids as [string, string, string];
    await ws.mailOrganize(TOKEN, {
      messageIds: [lunch],
      addLabels: [],
      removeLabels: ['STARRED'],
      read: true,
    });
    expect([...(server.folder('INBOX').messages[1]?.flags ?? [])]).toEqual(['\\Seen']);
    await ws.mailOrganize(TOKEN, {
      messageIds: [budget],
      addLabels: ['STARRED', 'UNREAD'],
      removeLabels: [],
    });
    expect([...(server.folder('INBOX').messages[0]?.flags ?? [])]).toEqual(['\\Flagged']);

    expect(
      await ws.mailOrganize(TOKEN, { messageIds: [receipt], addLabels: ['Receipts'], removeLabels: [] }),
    ).toEqual({ updated: 1 });
    expect(server.folder('Receipts').messages).toHaveLength(1);
    expect(
      await ws.mailOrganize(TOKEN, { messageIds: [budget], addLabels: [], removeLabels: ['INBOX'] }),
    ).toEqual({ updated: 1 });
    expect(
      await ws.mailOrganize(TOKEN, { messageIds: [lunch], addLabels: [], removeLabels: [], archive: true }),
    ).toEqual({ updated: 1 });
    expect(server.folder('Archive').messages).toHaveLength(2);
    expect(server.folder('INBOX').messages).toHaveLength(0);

    const two = await rejection(
      ws.mailOrganize(TOKEN, { messageIds: [lunch], addLabels: ['A', 'B'], removeLabels: [] }),
    );
    expect(two.message).toBe(ONE_FOLDER_TEXT);
    const important = await rejection(
      ws.mailOrganize(TOKEN, { messageIds: [lunch], addLabels: ['IMPORTANT'], removeLabels: [] }),
    );
    expect(important.message).toContain('labels are folders');
    // The moved message's old id is gone.
    const gone = await rejection(
      ws.mailOrganize(TOKEN, { messageIds: [lunch], addLabels: [], removeLabels: [], read: false }),
    );
    expect(gone.message).toBe(MESSAGE_GONE_TEXT);
  });

  it('marks the connection when the server refuses the password', async () => {
    server.options.pass = 'changed';
    const err = await rejection(ws.mailSearch(TOKEN, { query: '', limit: 5 }));
    expect(err).toBeInstanceOf(ConnectionUnavailableError);
    expect(err.message).toBe(NEEDS_PASSWORD_TEXT);
    expect(refused).toEqual([TOKEN]);
  });

  it('checks both sides and says which one failed', async () => {
    expect(await ws.checkService(TOKEN, 'mail')).toEqual({ service: 'mail', state: 'ok' });
    expect(await ws.checkService(TOKEN, 'calendar')).toEqual({
      service: 'calendar',
      state: 'error',
      message: IMAP_ONLY_MAIL_TEXT,
    });
    account = { ...account, password: 'only-imap-knows-this' };
    server.options.pass = 'only-imap-knows-this';
    const check = await ws.checkService(TOKEN, 'mail');
    expect(check.state).toBe('error');
    expect(check.message).toContain('sending server');
    expect(check.side).toBe('smtp');
    expect(refused).toEqual([]);
    await expect(ws.calendarEvents()).rejects.toThrow(IMAP_ONLY_MAIL_TEXT);
  });
});
