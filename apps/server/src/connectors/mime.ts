/**
 * Mail formats for the Google adapter (docs/decisions/connectors-google-tools.md GT-04): RFC 2822 messages
 * for drafts (plain text, UTF-8, threading headers for replies), base64url as Gmail wants it, address lists,
 * Gmail's MIME payload tree → text body and attachments, and HTML → text.
 */

import { randomUUID } from 'node:crypto';
import type { ConnectorBinary } from '@whombat/core';

/* base64url ------------------------------------------------------------------------------------- */

export function base64UrlEncode(text: string | Uint8Array): string {
  return Buffer.from(text).toString('base64url');
}

export function base64UrlDecode(data: string): Buffer {
  // Gmail sends base64url without padding; Node accepts both alphabets and missing padding.
  return Buffer.from(data, 'base64url');
}

/* Headers --------------------------------------------------------------------------------------- */

/** A header value on one line: CR / LF would start a header of the agent's choosing (header injection). */
export function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** RFC 2047 encoded word for non-ASCII header text (`=?UTF-8?B?…?=`), plain text otherwise. */
export function encodeHeaderText(value: string): string {
  const clean = headerValue(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  // Encoded words are at most 75 characters: split the UTF-8 bytes on character boundaries.
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(' ');
}

export interface RawMessageInput {
  attachments?: readonly ConnectorBinary[];
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  /** Plain text. */
  body: string;
  /** Reply threading: the original's `Message-ID`, and its `References` plus that id. */
  inReplyTo?: string | null;
  references?: string | null;
}

function wrap76(base64: string): string {
  return base64.replace(/.{1,76}/g, (line) => `${line}\r\n`).replace(/\r\n$/, '');
}

/**
 * An RFC 2822 message as text: headers (CRLF), a blank line and the body as UTF-8 base64. `From` is left
 * out: Gmail fills in the account's address. `Bcc` is kept: Gmail reads it and strips it when sending.
 */
export function buildRawMessage(m: RawMessageInput): string {
  const lines: string[] = [];
  const list = (name: string, addresses: readonly string[]) => {
    const clean = addresses.map(headerValue).filter(Boolean);
    if (clean.length) lines.push(`${name}: ${clean.join(', ')}`);
  };
  list('To', m.to);
  list('Cc', m.cc);
  list('Bcc', m.bcc);
  lines.push(`Subject: ${encodeHeaderText(m.subject)}`);
  if (m.inReplyTo) lines.push(`In-Reply-To: ${headerValue(m.inReplyTo)}`);
  if (m.references) lines.push(`References: ${headerValue(m.references)}`);
  lines.push('MIME-Version: 1.0');
  if (m.attachments?.length) {
    const boundary = `whombat-${randomUUID()}`;
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(Buffer.from(m.body.replace(/\r?\n/g, '\r\n')).toString('base64')),
    ];
    for (const file of m.attachments) {
      const name = encodeURIComponent(headerValue(file.name)).replace(/'/g, '%27');
      parts.push(
        `--${boundary}`,
        `Content-Type: ${headerValue(file.mimeType)}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename*=UTF-8''${name}`,
        '',
        wrap76(file.contentBase64),
      );
    }
    parts.push(`--${boundary}--`, '');
    return `${lines.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
  }
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  const body = m.body.replace(/\r?\n/g, '\r\n');
  return `${lines.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(body).toString('base64'))}\r\n`;
}

/** “Re: Invoice” for a reply to “Invoice” (not “Re: Re: …”). */
export function replySubject(original: string): string {
  const s = original.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** The References of a reply: the original's References followed by its Message-ID. */
export function replyReferences(references: string | null, messageId: string | null): string | null {
  const parts = [references?.trim(), messageId?.trim()].filter((p): p is string => !!p);
  return parts.length ? parts.join(' ') : null;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Email addresses of an address-list header (`"Okafor, Mara" <mara@x.com>, bo@y.com`), lowercased. */
export function parseAddressList(header: string | null | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  const flush = () => {
    const part = current.trim();
    current = '';
    if (!part) return;
    const bracketed = /<([^>]+)>/.exec(part)?.[1];
    const candidate = (bracketed ?? part).trim().toLowerCase();
    if (EMAIL.test(candidate)) out.push(candidate);
  };
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle += 1;
    else if (ch === '>' && !quoted) angle = Math.max(0, angle - 1);
    if ((ch === ',' || ch === ';') && !quoted && angle === 0) flush();
    else current += ch;
  }
  flush();
  return out;
}

/** The entries of an address-list header as shown (`Mara Okafor <mara@x.com>`), split outside quotes. */
export function splitAddressHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle += 1;
    else if (ch === '>' && !quoted) angle = Math.max(0, angle - 1);
    if (ch === ',' && !quoted && angle === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/* HTML → text ----------------------------------------------------------------------------------- */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '’',
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Readable text from an email's HTML: no scripts, styles or comments; block elements and `<br>` as line
 * breaks, list items as “- ”, links as “text (url)” when the text is not the url itself.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|template|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(
      /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, a, b, c, inner) => {
        const href = decodeEntities(String(a ?? b ?? c ?? '')).trim();
        const text = String(inner);
        const plain = decodeEntities(text.replace(/<[^>]+>/g, '')).trim();
        if (!href || href.startsWith('#') || /^(javascript|data):/i.test(href) || plain === href) return text;
        if (href.startsWith('mailto:') && plain === href.slice(7)) return text;
        return `${text} (${href})`;
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|section|article|header|footer|pre)\s*>/gi, '\n')
    .replace(/<(p|div|h[1-6]|tr|table|ul|ol|blockquote|section|article|header|footer|pre)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/* Gmail payloads -------------------------------------------------------------------------------- */

/** Gmail's `MessagePart` (the fields we read). */
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export function headerOf(part: GmailPart | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

function charsetOf(part: GmailPart): string {
  const type = headerOf(part, 'Content-Type') ?? '';
  return /charset\s*=\s*"?([^";\s]+)"?/i.exec(type)?.[1]?.toLowerCase() ?? 'utf-8';
}

function decodePartText(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return '';
  const bytes = base64UrlDecode(data);
  try {
    return new TextDecoder(charsetOf(part)).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export interface ExtractedBody {
  text: string;
  attachments: { id?: string; name: string; mimeType: string; size: number }[];
}

/**
 * The readable body of a message: its text/plain parts, or its text/html parts as text when there is no
 * plain version (multipart/alternative picks one of the two); parts with a file name are attachments.
 */
export function extractBody(payload: GmailPart | undefined): ExtractedBody {
  const attachments: ExtractedBody['attachments'] = [];
  const walk = (part: GmailPart): string => {
    const type = (part.mimeType ?? '').toLowerCase();
    if (part.filename) {
      attachments.push({
        ...(part.partId !== undefined ? { id: part.partId } : {}),
        name: part.filename,
        mimeType: part.mimeType ?? '',
        size: part.body?.size ?? 0,
      });
      return '';
    }
    if (type === 'multipart/alternative' && part.parts?.length) {
      const plain = part.parts.find((p) => (p.mimeType ?? '').toLowerCase() === 'text/plain');
      const rest = part.parts.filter(
        (p) => p !== plain && !(p.mimeType ?? '').toLowerCase().startsWith('text/'),
      );
      const html = part.parts.find((p) => (p.mimeType ?? '').toLowerCase() === 'text/html');
      const chosen = plain ? walk(plain) : html ? walk(html) : '';
      for (const p of rest) walk(p);
      return chosen;
    }
    if (type.startsWith('multipart/') && part.parts?.length)
      return part.parts
        .map(walk)
        .filter((t) => t.trim())
        .join('\n\n');
    if (type === 'text/plain') return decodePartText(part);
    if (type === 'text/html') return htmlToText(decodePartText(part));
    return '';
  };
  const text = payload ? walk(payload) : '';
  return { text: text.replace(/\r\n?/g, '\n').trim(), attachments };
}

/** Cuts text to `max` characters. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}
