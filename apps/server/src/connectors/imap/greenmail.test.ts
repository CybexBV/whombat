/**
 * Email (IMAP) against a real mail server: GreenMail (IMAPS and SMTPS), run once by hand through `agent-resource`
 * (docs/decisions/connections-more-mail.md CM-M10 has the command). Skipped unless `WHOMBAT_GREENMAIL` is
 * `<imaps port>:<smtps port>` of a GreenMail on 127.0.0.1 with the user `jo@home.test` / `secret`.
 *
 * GreenMail serves the tests' `mail.home.test` certificate (made into its keystore by the command), and the test trusts
 * it as its CA, so TLS checks the chain and the name as with a real provider.
 */
import { describe, expect, it } from 'vitest';
import { MAIL_CERT } from '../../test/self-signed';
import { messageIdOf, parseMessageId } from './ids';
import { openImapflow } from './session';
import { nodemailerSmtp } from './smtp';
import { checkMailAccount, type ImapAccount, ImapWorkspace, type MailConnector } from './workspace';

const target = process.env.WHOMBAT_GREENMAIL;
const [imapsPort, smtpsPort] = (target ?? '0:0').split(':').map(Number) as [number, number];
const user = 'jo@home.test';
const pass = 'secret';

/** Polls a condition every 100 ms for up to 10 s (GreenMail delivers a sent message asynchronously). */
async function until<T>(fn: () => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('GreenMail never got there');
}

describe.skipIf(!target)('Email (IMAP) against GreenMail', () => {
  it('connects, searches, reads, drafts, sends and organises over real IMAP and SMTP', {
    timeout: 60_000,
  }, async () => {
    const name = 'mail.home.test';
    const account: ImapAccount = {
      email: user,
      name: 'Jo Smith',
      user,
      password: pass,
      imap: { host: name, port: imapsPort, security: 'tls' },
      smtp: { host: name, port: smtpsPort, security: 'tls' },
      savesSent: false,
    };
    const endpoint = (a: ImapAccount, side: 'imap' | 'smtp') => ({
      address: '127.0.0.1',
      host: a[side].host,
      port: a[side].port,
      security: a[side].security,
      user: a.user,
      pass: a.password,
      ca: MAIL_CERT,
    });
    const connector: MailConnector = {
      imap: (a) => openImapflow(endpoint(a, 'imap')),
      smtpVerify: (a) => nodemailerSmtp.verify(endpoint(a, 'smtp')),
      smtpSend: (a, envelope, raw) => nodemailerSmtp.send(endpoint(a, 'smtp'), envelope, raw),
    };
    const refused: string[] = [];
    const ws = new ImapWorkspace({
      account: async () => account,
      refused: async (t) => {
        refused.push(t);
      },
      connector,
      now: () => new Date(),
    });

    // CM-22: both sides sign in; a wrong password is refused on the IMAP side first.
    expect(await checkMailAccount(connector, account)).toBeNull();
    const wrong = await checkMailAccount(connector, { ...account, password: 'wrong' });
    expect(wrong).toMatchObject({ side: 'imap', reason: 'refused' });

    // Two messages arrive: an invoice with a file, and a reply to it.
    const send = (raw: string) =>
      nodemailerSmtp.send(
        endpoint(account, 'smtp'),
        { from: 'mara@example.com', to: [user] },
        Buffer.from(raw),
      );
    await send(
      [
        'From: Mara <mara@example.com>',
        `To: ${user}`,
        'Subject: Invoice 42',
        'Message-ID: <inv42@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Please find the invoice attached.',
        '--b',
        'Content-Type: application/pdf',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="invoice-42.pdf"',
        '',
        Buffer.from('%PDF-1.4 invoice').toString('base64'),
        '--b--',
        '',
      ].join('\r\n'),
    );
    await send(
      [
        'From: Mara <mara@example.com>',
        `To: ${user}`,
        'Subject: Re: Invoice 42',
        'Message-ID: <inv42-2@example.com>',
        'In-Reply-To: <inv42@example.com>',
        'References: <inv42@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Did it arrive?',
        '',
      ].join('\r\n'),
    );
    const inbox = await until(async () => {
      // GreenMail matches FROM and TO against whole addresses (real servers match any part).
      const found = await ws.mailSearch('t', { query: 'from:mara@example.com', limit: 10 });
      return found.length >= 2 ? found : null;
    });
    expect(inbox.every((m) => m.unread && m.labels.includes('INBOX'))).toBe(true);
    expect(new Set(inbox.map((m) => m.threadId)).size).toBe(1);
    expect((await ws.mailSearch('t', { query: 'subject:"Invoice 42" -subject:Re', limit: 10 })).length).toBe(
      1,
    );

    const invoice = inbox.find((m) => m.subject === 'Invoice 42');
    const [read] = await ws.mailRead('t', { messageId: invoice?.id ?? '' });
    expect(read?.body).toBe('Please find the invoice attached.');
    expect(read?.attachments.map((a) => a.name)).toEqual(['invoice-42.pdf']);
    const file = await ws.mailAttachment('t', { messageId: invoice?.id ?? '', attachmentId: '1' });
    expect(Buffer.from(file.contentBase64, 'base64').toString()).toBe('%PDF-1.4 invoice');
    // Reading left it unread (BODY.PEEK).
    expect((await ws.mailSearch('t', { query: 'is:unread', limit: 10 })).length).toBe(2);
    expect((await ws.mailRead('t', { threadId: invoice?.threadId ?? '' })).map((m) => m.subject)).toEqual([
      'Invoice 42',
      'Re: Invoice 42',
    ]);

    // A reply drafted in Drafts (made, as GreenMail has none), sent to ourselves, copied to Sent.
    const { draftId } = await ws.mailDraft('t', {
      to: [user],
      cc: [],
      bcc: ['boss@home.test'],
      subject: '',
      body: 'Yes, it arrived.',
      replyToMessageId: invoice?.id ?? '',
    });
    const draft = await ws.mailGetDraft('t', draftId);
    expect(draft).toMatchObject({
      subject: 'Re: Invoice 42',
      bcc: ['boss@home.test'],
      body: 'Yes, it arrived.',
    });
    const sent = await ws.mailSendDraft('t', draftId);
    expect(parseMessageId(sent.messageId)?.mailbox).toBe('Sent');
    expect(await ws.mailSearch('t', { query: 'in:drafts', limit: 10 })).toEqual([]);
    const arrived = await until(async () => {
      const found = await ws.mailSearch('t', { query: `subject:"Re: Invoice 42" from:${user}`, limit: 10 });
      return found.length ? found : null;
    });
    expect(arrived[0]?.threadId).toBe(invoice?.threadId);

    // Organising: read, star, a folder as a label, archive.
    await ws.mailOrganize('t', {
      messageIds: [invoice?.id ?? ''],
      addLabels: ['STARRED'],
      removeLabels: [],
      read: true,
    });
    const starred = await ws.mailSearch('t', { query: 'is:starred is:read', limit: 10 });
    expect(starred.map((m) => m.subject)).toEqual(['Invoice 42']);
    await ws.mailOrganize('t', {
      messageIds: [starred[0]?.id ?? ''],
      addLabels: ['Invoices'],
      removeLabels: [],
    });
    expect((await ws.mailSearch('t', { query: 'in:Invoices', limit: 10 })).map((m) => m.subject)).toEqual([
      'Invoice 42',
    ]);
    const reply = inbox.find((m) => m.subject === 'Re: Invoice 42');
    await ws.mailOrganize('t', {
      messageIds: [reply?.id ?? ''],
      addLabels: [],
      removeLabels: [],
      archive: true,
    });
    expect((await ws.mailSearch('t', { query: 'in:archive', limit: 10 })).map((m) => m.subject)).toEqual([
      'Re: Invoice 42',
    ]);
    // An id from before a move names nothing now.
    await expect(ws.mailRead('t', { messageId: reply?.id ?? '' })).rejects.toThrow('isn’t there any more');
    expect(refused).toEqual([]);
    expect(messageIdOf(parseMessageId(sent.messageId) ?? { mailbox: 'x', uidValidity: '1', uid: 1 })).toBe(
      sent.messageId,
    );
  });
});
