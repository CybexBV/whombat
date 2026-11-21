/**
 * Message and thread ids on Email (IMAP) (docs/decisions/connections-more.md CM-24, connections-more-mail.md CM-M02):
 *
 * - a message is `base64url(<mailbox>\0<UIDVALIDITY>\0<UID>)`: the folder, the folder's UIDVALIDITY and the message's UID.
 *   A folder whose UIDVALIDITY changed has renumbered its messages, so an old id answers “That message isn't there any
 *   more: search again.” instead of reading another message;
 * - a thread is its References root: `base64url(R\0<mailbox>\0<root Message-ID>)`, read by finding the messages whose
 *   Message-ID or References name that root (in its folder and in Sent). A message without a Message-ID, or whose root
 *   is too long for an id, is a thread of its own: `base64url(M\0<mailbox>\0<UIDVALIDITY>\0<UID>)`.
 *
 * Ids are at most `MAIL_ID_MAX` characters (the tools' `MailSummary.id`). A folder name too long for that is written as
 * `\x01` and the first 16 bytes of its SHA-256 in hex (no folder name holds a control character); reading it lists the
 * folders to find the one with that hash.
 */
import { createHash } from 'node:crypto';

/** The longest id the mail tools carry (`MailSummary.id`, `threadId`, `replyToMessageId`). */
export const MAIL_ID_MAX = 200;

/** A message in a folder. `uidValidity` is a decimal string (it is a 32-bit unsigned number on the wire). */
export interface ImapMessageRef {
  mailbox: string;
  uidValidity: string;
  uid: number;
}

export type ImapThreadRef =
  | { kind: 'root'; mailbox: string; root: string }
  | { kind: 'message'; message: ImapMessageRef };

const HASHED = '\x01';
const SEP = '\0';

function encode(parts: string[]): string {
  return Buffer.from(parts.join(SEP), 'utf8').toString('base64url');
}

function decode(id: string): string[] | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(id)) return null;
  const text = Buffer.from(id, 'base64url').toString('utf8');
  // A round trip that changes the text was not ours (or was cut).
  if (Buffer.from(text, 'utf8').toString('base64url') !== id) return null;
  return text.split(SEP);
}

/** The folder as an id part: its name, or its hash marker when the name would not fit. */
function mailboxPart(mailbox: string, room: number): string {
  if (Buffer.byteLength(mailbox, 'utf8') <= room && !mailbox.startsWith(HASHED)) return mailbox;
  return `${HASHED}${mailboxHash(mailbox)}`;
}

/** The hash a too-long folder name is written as in an id. */
export function mailboxHash(mailbox: string): string {
  return createHash('sha256').update(mailbox, 'utf8').digest('hex').slice(0, 32);
}

/** True when the id's folder part is a hash (the folders must be listed to find it). */
export function isHashedMailbox(part: string): boolean {
  return part.startsWith(HASHED) && /^[0-9a-f]{32}$/.test(part.slice(1));
}

/** The folder a hashed part names, among `paths`. */
export function resolveMailbox(part: string, paths: readonly string[]): string | null {
  if (!isHashedMailbox(part)) return part;
  const hash = part.slice(1);
  return paths.find((p) => mailboxHash(p) === hash) ?? null;
}

/** Bytes of a base64url id of `chars` characters (no padding). */
const bytesFor = (chars: number) => Math.floor((chars * 3) / 4);

const validUid = (uid: number) => Number.isInteger(uid) && uid > 0 && uid <= 0xffffffff;
const validUidValidity = (v: string) => /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 0xffffffff;

export function messageIdOf(ref: ImapMessageRef): string {
  const tail = `${SEP}${ref.uidValidity}${SEP}${ref.uid}`;
  return encode([
    mailboxPart(ref.mailbox, bytesFor(MAIL_ID_MAX) - tail.length),
    ref.uidValidity,
    String(ref.uid),
  ]);
}

/** The message an id names (its folder maybe still hashed), or null when it is not an IMAP message id. */
export function parseMessageId(id: string): ImapMessageRef | null {
  const parts = decode(id);
  if (parts?.length !== 3) return null;
  const [mailbox, uidValidity, uidText] = parts as [string, string, string];
  const uid = Number(uidText);
  if (!mailbox || !validUidValidity(uidValidity) || !/^\d+$/.test(uidText) || !validUid(uid)) return null;
  return { mailbox, uidValidity, uid };
}

/**
 * The thread of a message: its References root when there is one that fits, else the message alone. `root` is the
 * first Message-ID of References, else In-Reply-To, else the message's own Message-ID (`threadRoot`). `home`: the folder
 * the root form names (default the message's; Drafts and Sent name the inbox, `workspace.ts`).
 */
export function threadIdOf(message: ImapMessageRef, root: string | null, home = message.mailbox): string {
  if (root) {
    const mailbox = mailboxPart(home, 100);
    const id = encode(['R', mailbox, root]);
    if (id.length <= MAIL_ID_MAX) return id;
  }
  const tail = `${SEP}${message.uidValidity}${SEP}${message.uid}`;
  return encode([
    'M',
    mailboxPart(message.mailbox, bytesFor(MAIL_ID_MAX) - tail.length - 2),
    message.uidValidity,
    String(message.uid),
  ]);
}

export function parseThreadId(id: string): ImapThreadRef | null {
  const parts = decode(id);
  if (!parts) return null;
  if (parts[0] === 'R' && parts.length === 3 && parts[1] && parts[2] && isMessageIdText(parts[2]))
    return { kind: 'root', mailbox: parts[1], root: parts[2] };
  if (parts[0] === 'M' && parts.length === 4) {
    const message = parseMessageId(encode(parts.slice(1)));
    return message ? { kind: 'message', message } : null;
  }
  return null;
}

/** A Message-ID as headers carry it (`<a@b>`), one token, no spaces or controls. */
function isMessageIdText(v: string): boolean {
  return /^<[^\s<>]{1,995}>$/.test(v);
}

/** The Message-IDs of a References or In-Reply-To header, in order (`<a@b> <c@d>`). */
export function messageIdsIn(header: string | null | undefined): string[] {
  if (!header) return [];
  return [...header.matchAll(/<[^\s<>]{1,995}>/g)].map((m) => m[0]);
}

/** A thread's root: References' first id, else In-Reply-To's, else the message's own Message-ID; null without any. */
export function threadRoot(headers: {
  references?: string | null;
  inReplyTo?: string | null;
  messageId?: string | null;
}): string | null {
  return (
    messageIdsIn(headers.references)[0] ??
    messageIdsIn(headers.inReplyTo)[0] ??
    messageIdsIn(headers.messageId)[0] ??
    null
  );
}
