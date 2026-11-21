import { describe, expect, it } from 'vitest';
import {
  buildRawMessage,
  capText,
  encodeHeaderText,
  extractBody,
  htmlToText,
  parseAddressList,
  splitAddressHeader,
} from './mime';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('RFC 2822 messages', () => {
  it('builds a plain-text UTF-8 message with threading headers', () => {
    const raw = buildRawMessage({
      to: ['a@b.com', 'c@d.com'],
      cc: ['e@f.com'],
      bcc: ['g@h.com'],
      subject: 'Re: Invoice',
      body: 'Hi Priya,\nPaid — thanks!',
      inReplyTo: '<m1@mail.example.com>',
      references: '<m0@mail.example.com> <m1@mail.example.com>',
    });
    const [head = '', body = ''] = raw.split('\r\n\r\n');
    expect(head.split('\r\n')).toEqual([
      'To: a@b.com, c@d.com',
      'Cc: e@f.com',
      'Bcc: g@h.com',
      'Subject: Re: Invoice',
      'In-Reply-To: <m1@mail.example.com>',
      'References: <m0@mail.example.com> <m1@mail.example.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    ]);
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString()).toBe('Hi Priya,\r\nPaid — thanks!');
  });

  it('keeps header values on one line (no header injection) and encodes non-ASCII subjects', () => {
    const raw = buildRawMessage({
      to: ['a@b.com'],
      cc: [],
      bcc: [],
      subject: 'Hello\r\nBcc: evil@x.com',
      body: '',
    });
    expect(raw).toContain('Subject: Hello Bcc: evil@x.com\r\n');
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(encodeHeaderText('Factuur €24')).toBe(
      `=?UTF-8?B?${Buffer.from('Factuur €24').toString('base64')}?=`,
    );
    const long = encodeHeaderText('é'.repeat(60));
    for (const word of long.split(' ')) expect(word.length).toBeLessThanOrEqual(75);
  });
});

describe('address lists', () => {
  it('reads addresses out of display forms, quotes and odd separators', () => {
    expect(parseAddressList('"Okafor, Mara" <Mara@X.com>, bo@y.com; <c@z.org>, not an address')).toEqual([
      'mara@x.com',
      'bo@y.com',
      'c@z.org',
    ]);
    expect(parseAddressList(null)).toEqual([]);
    expect(splitAddressHeader('"Okafor, Mara" <mara@x.com>, bo@y.com')).toEqual([
      '"Okafor, Mara" <mara@x.com>',
      'bo@y.com',
    ]);
  });
});

describe('HTML to text', () => {
  it('drops scripts and styles, keeps structure, links and entities', () => {
    const text = htmlToText(
      '<html><head><style>p{color:red}</style></head><body><script>alert(1)</script><h1>Receipt</h1><p>Paid&nbsp;&euro;38,68 &amp; thanks&#33;</p><ul><li>One</li><li>Two</li></ul><p><a href="https://x.example/i">View invoices</a> or <a href="https://y.example">https://y.example</a></p><!-- hidden --></body></html>',
    );
    expect(text).toBe(
      'Receipt\n\nPaid €38,68 & thanks!\n\n- One\n- Two\n\nView invoices (https://x.example/i) or https://y.example',
    );
  });
});

describe('Gmail payloads', () => {
  it('prefers text/plain, falls back to HTML, and lists attachments', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Plain body') } },
            { mimeType: 'text/html', body: { data: b64('<p>HTML body</p>') } },
          ],
        },
        { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { size: 1234, attachmentId: 'att1' } },
      ],
    };
    expect(extractBody(payload)).toEqual({
      text: 'Plain body',
      attachments: [{ name: 'invoice.pdf', mimeType: 'application/pdf', size: 1234 }],
    });
    expect(
      extractBody({ mimeType: 'text/html', body: { data: b64('<div>Only <b>HTML</b></div>') } }).text,
    ).toBe('Only HTML');
    expect(
      extractBody({
        mimeType: 'text/plain',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset="iso-8859-1"' }],
        body: { data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url') },
      }).text,
    ).toBe('café');
  });

  it('caps text', () => {
    expect(capText('abcdef', 4)).toEqual({ text: 'abcd', truncated: true });
    expect(capText('abc', 4)).toEqual({ text: 'abc', truncated: false });
  });
});
