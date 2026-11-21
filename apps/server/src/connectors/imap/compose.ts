/**
 * Mail on Email (IMAP) as bytes (docs/decisions/connections-more.md CM-26, connections-more-mail.md CM-M05): drafts are
 * whole RFC 5322 messages Whombat writes (Gmail's draft format, `mime.ts` `buildRawMessage`, with `From`, `Date` and a
 * `Message-ID` added: an IMAP server fills in nothing), and messages are read with mailparser into the tools' shapes.
 *
 * A draft keeps its `Bcc` header, as mail programs do, so the approval can show every recipient; the copy that goes out
 * over SMTP has it removed (the blind copies are only in the envelope), the copy kept in Sent has it.
 */
import { randomUUID } from 'node:crypto';
import { type ConnectorBinary, MAIL_BODY_CAP, type MailAttachment, type MailDraftInput } from '@whombat/core';
import { type AddressObject, type ParsedMail, simpleParser } from 'mailparser';
import { buildRawMessage, capText, encodeHeaderText, headerValue, htmlToText } from '../mime';

/** HTML longer than this is cut before it becomes text (a body is cut at `MAIL_BODY_CAP` anyway). */
const HTML_MAX = 2 * 1024 * 1024;

export interface ComposeInput extends Pick<MailDraftInput, 'to' | 'cc' | 'bcc' | 'subject' | 'body'> {
  attachments?: readonly ConnectorBinary[];
  /** The account's address, and the name to show with it. */
  from: { email: string; name: string };
  inReplyTo?: string | null;
  references?: string | null;
  /** Kept when a draft is sent (the reply's thread stays one); a new one otherwise. */
  messageId?: string;
  date: Date;
}

/** `<uuid@domain>` on the account's domain, as mail programs make them. */
export function newMessageId(email: string): string {
  const domain = email.split('@')[1]?.replace(/[^A-Za-z0-9.-]/g, '') || 'whombat.invalid';
  return `<${randomUUID()}@${domain}>`;
}

/** `Mara Okafor <mara@example.com>`, the name quoted when it needs it and encoded when it isn't ASCII. */
export function fromHeader(email: string, name: string): string {
  const address = headerValue(email);
  const display = headerValue(name).replace(/["\\]/g, '');
  if (!display || display.toLowerCase() === address.toLowerCase()) return address;
  if (!/^[\x20-\x7e]*$/.test(display)) return `${encodeHeaderText(display)} <${address}>`;
  return /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(display)
    ? `${display} <${address}>`
    : `"${display}" <${address}>`;
}

/** RFC 5322 date (`Mon, 19 Oct 2026 09:30:00 +0000`). */
export function mailDate(d: Date): string {
  return d.toUTCString().replace('GMT', '+0000');
}

/** A whole message: `From`, `Date`, `Message-ID`, then what Gmail's drafts hold (recipients, subject, body, files). */
export function composeMessage(input: ComposeInput): { raw: Buffer; messageId: string } {
  const messageId = input.messageId ?? newMessageId(input.from.email);
  const head = [
    `From: ${fromHeader(input.from.email, input.from.name)}`,
    `Date: ${mailDate(input.date)}`,
    `Message-ID: ${headerValue(messageId)}`,
  ].join('\r\n');
  const rest = buildRawMessage({
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: input.body,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null,
  });
  return { raw: Buffer.from(`${head}\r\n${rest}`, 'utf8'), messageId };
}

/** The message without its `Bcc` header (what goes out over SMTP). Only the header block is touched. */
export function withoutBcc(raw: Buffer): Buffer {
  const text = raw.toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const head = end < 0 ? text : text.slice(0, end);
  const body = end < 0 ? '' : text.slice(end);
  const lines = head.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^bcc:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return Buffer.from(kept.join('\r\n') + body, 'latin1');
}

/* Reading ------------------------------------------------------------------------------------------ */

export async function parseMail(raw: Buffer): Promise<ParsedMail> {
  return simpleParser(raw, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    skipTextLinks: true,
  });
}

function addressList(v: AddressObject | AddressObject[] | undefined): { name: string; address: string }[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  const out: { name: string; address: string }[] = [];
  const walk = (entries: AddressObject['value']) => {
    for (const e of entries) {
      if (e.group) walk(e.group);
      else if (e.address) out.push({ name: e.name ?? '', address: e.address });
    }
  };
  for (const a of list) walk(a.value);
  return out;
}

/** An address as the tools show it: `Mara Okafor <mara@example.com>`, or the address alone. */
export function shownAddress(a: { name: string; address: string }): string {
  const name = a.name.replace(/[\r\n]+/g, ' ').trim();
  return (name && name !== a.address ? `${name} <${a.address}>` : a.address).slice(0, 500);
}

/** The addresses of a header, lowercased (a draft's recipients as the approval compares them). */
export function plainAddresses(v: AddressObject | AddressObject[] | undefined): string[] {
  return addressList(v).map((a) => a.address.trim().toLowerCase());
}

export function shownAddresses(v: AddressObject | AddressObject[] | undefined): string[] {
  return addressList(v).map(shownAddress);
}

/** The text of a message: its plain text part, else its HTML as text. */
export function bodyText(m: ParsedMail): string {
  const text = (m.text ?? '').replace(/\r\n?/g, '\n').trim();
  if (text) return text;
  return m.html ? htmlToText(m.html.slice(0, HTML_MAX)) : '';
}

export function cappedBody(m: ParsedMail): { body: string; bodyTruncated: boolean } {
  const { text, truncated } = capText(bodyText(m), MAIL_BODY_CAP);
  return { body: text, bodyTruncated: truncated };
}

/** A search result's snippet: the start of the text, on one line. */
export function snippetOf(m: ParsedMail): string {
  return bodyText(m).replace(/\s+/g, ' ').trim().slice(0, 200);
}

const MIME = /^[\w.+-]+\/[\w.+-]+$/;

/**
 * The files of a message, in mailparser's order: `id` is the 1-based position (`mail_attachment` reads the same message
 * again and takes that one; an IMAP message never changes, so the position is stable).
 */
export function attachmentsOf(m: ParsedMail): MailAttachment[] {
  return m.attachments.map((a, i) => ({
    id: String(i + 1),
    name: attachmentName(a.filename, i),
    mimeType: MIME.test(a.contentType ?? '')
      ? (a.contentType as string).slice(0, 200)
      : 'application/octet-stream',
    size: a.size ?? a.content.length,
  }));
}

/** A file name on one line, never empty. */
export function attachmentName(filename: string | undefined, index: number): string {
  const clean = (filename ?? '')
    .replace(/[\r\n\0]+/g, ' ')
    .trim()
    .slice(0, 500);
  return clean || `attachment-${index + 1}`;
}

/** One file of a message as the tools carry it, or null when there is no such position. */
export function attachmentBinary(m: ParsedMail, id: string): ConnectorBinary | null {
  if (!/^\d{1,4}$/.test(id)) return null;
  const index = Number(id) - 1;
  const a = m.attachments[index];
  if (!a) return null;
  return {
    name: attachmentName(a.filename, index),
    mimeType: MIME.test(a.contentType ?? '')
      ? (a.contentType as string).slice(0, 200)
      : 'application/octet-stream',
    contentBase64: a.content.toString('base64'),
  };
}
