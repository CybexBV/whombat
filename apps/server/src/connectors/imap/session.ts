/**
 * One IMAP connection, as the mail adapter uses it (docs/decisions/connections-more-mail.md CM-M04): the narrow set of
 * commands `workspace.ts` needs, over imapflow, so the adapter's logic runs the same against a real server and against
 * the in-memory one of the tests (`memory.ts`).
 *
 * Every connection goes to an address the destination policy checked, with the host name kept for TLS (SNI and the
 * certificate check, CM-23), TLS 1.2 or later, and nothing in plain text: `tls` is implicit TLS, `starttls` must upgrade
 * before the password is sent (imapflow's `doSTARTTLS: true`). Nothing here marks a message read: fetches use
 * `BODY.PEEK`. Moving without the MOVE extension, and removing a draft, expunge only by UID (UIDPLUS); without it the
 * message is only marked `\Deleted`, so another client's deleted-but-kept messages are never expunged with it.
 */
import { isIP } from 'node:net';
import type { MailSecurity } from '@whombat/core';
import { type FetchMessageObject, ImapFlow, type MessageStructureObject, type SearchObject } from 'imapflow';
import type { MailHeaderAttachment } from '../types';
import { MailError, mailErrorOf } from './errors';

/**
 * Where to connect: the checked address, and the host it stands for (a name is the TLS server name, SNI and the
 * certificate's check; an IP literal is checked as itself).
 */
export interface MailEndpoint {
  address: string;
  host: string;
  port: number;
  security: MailSecurity;
}

/** The TLS server name of a host: the name itself; none for an IP literal (RFC 6066 has no SNI for those). */
export function serverNameOf(host: string): string | undefined {
  return isIP(host.replace(/^\[|\]$/g, '')) ? undefined : host;
}

export interface MailTimeouts {
  /** TCP + TLS (default 10 s). */
  connectMs: number;
  /** The greeting after connecting (default 10 s). */
  greetingMs: number;
  /** No byte for this long fails the connection (default 30 s). */
  socketMs: number;
}

export const MAIL_TIMEOUTS: MailTimeouts = { connectMs: 10_000, greetingMs: 10_000, socketMs: 30_000 };
/** Socket timeout for long-lived IMAP IDLE sessions (10 minutes, instead of the 30-second command timeout). */
export const MAIL_IDLE_SOCKET_TIMEOUT_MS = 10 * 60_000;
/** How often an IDLE session refreshes with DONE + IDLE so servers and NATs keep the connection alive (5 minutes). */
export const MAIL_IDLE_REFRESH_MS = 5 * 60_000;

export interface ImapConnectOptions extends MailEndpoint {
  user: string;
  pass: string;
  timeouts?: Partial<MailTimeouts>;
  /** How long imapflow stays in one IDLE command before sending DONE and re-entering IDLE. */
  maxIdleTimeMs?: number;
  /** Tests only: a certificate authority to trust besides the system's (a fake server's own). */
  ca?: string;
}

export interface MailboxInfo {
  path: string;
  /** `\Sent`, `\Drafts`, `\Trash`, `\Archive`, `\Junk`, `\All`, `\Flagged`, `\Inbox`; null for others. */
  specialUse: string | null;
  delimiter: string;
  /** Can't be opened (a parent folder that holds no mail). */
  noSelect: boolean;
}

export interface OpenedFolder {
  path: string;
  /** Decimal. */
  uidValidity: string;
  exists: number;
  /** Next UID the server will assign in this folder, when advertised. */
  uidNext: number | null;
}

export interface MailAddressShown {
  name: string;
  address: string;
}

/** What a search result needs of a message, and more when asked. */
export interface MessageMeta {
  uid: number;
  flags: string[];
  /** When the server received it (ISO), null when it didn't say. */
  internalDate: string | null;
  size: number;
  date: string | null;
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  from: MailAddressShown[];
  to: MailAddressShown[];
  cc: MailAddressShown[];
  bcc: MailAddressShown[];
  /** The first bytes of the raw message, when asked (`prefixBytes`), for a snippet. */
  prefix: Buffer | null;
  /** Attachment metadata parsed from IMAP BODYSTRUCTURE when `bodyStructure: true` was requested. */
  attachments?: MailHeaderAttachment[];
}

export interface MetaOptions {
  prefixBytes?: number;
  /** Fetch IMAP BODYSTRUCTURE so attachment filenames and MIME types are known without downloading body bytes. */
  bodyStructure?: boolean;
}

/** One IMAP connection. Methods that work in a folder work in the one `open` selected last. */
export interface ImapSession {
  readonly capabilities: ReadonlySet<string>;
  list(): Promise<MailboxInfo[]>;
  open(path: string, options: { write: boolean }): Promise<OpenedFolder>;
  /** How many messages of a folder are unread (STATUS UNSEEN: the folder isn't opened). */
  unseen(path: string): Promise<number>;
  /** UIDs in the open folder, ascending. */
  search(criteria: SearchObject): Promise<number[]>;
  meta(uids: readonly number[], options?: MetaOptions): Promise<MessageMeta[]>;
  /** The whole raw message, or null when it is larger than `maxBytes` (or gone). */
  source(uid: number, maxBytes: number): Promise<Buffer | null>;
  /** Appends a message; the new UID and UIDVALIDITY when the server says (UIDPLUS). */
  append(
    path: string,
    raw: Buffer,
    flags: readonly string[],
    date?: Date,
  ): Promise<{ uid: number | null; uidValidity: string | null }>;
  flags(uids: readonly number[], add: readonly string[], remove: readonly string[]): Promise<void>;
  move(uids: readonly number[], destination: string): Promise<void>;
  /** Removes messages from the open folder (expunged by UID with UIDPLUS, else only marked `\Deleted`). */
  remove(uids: readonly number[]): Promise<void>;
  create(path: string): Promise<void>;
  /** Waits in IMAP IDLE on the open folder and calls `onExists` whenever new mail arrives, until aborted or closed. */
  idle?(onExists: () => void, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export type OpenImap = (options: ImapConnectOptions) => Promise<ImapSession>;

/** Largest literal accepted from a server: a whole message `mail_read` parses, with room. */
const MAX_LITERAL = 40 * 1024 * 1024;

const range = (uids: readonly number[]) => uids.join(',');

function addresses(list: { name?: string; address?: string }[] | undefined): MailAddressShown[] {
  return (list ?? [])
    .filter((a) => a.address)
    .map((a) => ({ name: (a.name ?? '').slice(0, 300), address: (a.address ?? '').slice(0, 320) }));
}

const isoOf = (d: Date | string | undefined): string | null => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/** One header's value from fetched header lines (`References: <a>\r\n <b>`), unfolded. */
export function headerFrom(raw: Buffer | undefined, name: string): string | null {
  if (!raw) return null;
  const text = raw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im');
  const value = re.exec(text)?.[1]?.trim();
  return value ? value.slice(0, 8000) : null;
}

/** Extracts attachment descriptors from an IMAP BODYSTRUCTURE tree without downloading any body or file bytes. */
export function attachmentsFromBodyStructure(
  structure: MessageStructureObject | undefined,
): MailHeaderAttachment[] {
  if (!structure) return [];
  const out: MailHeaderAttachment[] = [];
  const walk = (node: MessageStructureObject): void => {
    if (node.childNodes?.length) {
      for (const child of node.childNodes) walk(child);
      return;
    }
    const disp = (node.disposition ?? '').toLowerCase();
    const dispFile = node.dispositionParameters?.filename;
    const paramName = node.parameters?.name;
    const filename =
      (typeof dispFile === 'string' && dispFile) || (typeof paramName === 'string' && paramName) || '';
    const mimeType = (node.type || 'application/octet-stream').toLowerCase();
    const isAttachment =
      disp === 'attachment' || Boolean(filename) || (disp === 'inline' && !mimeType.startsWith('text/'));
    if (!isAttachment) return;
    out.push({
      ...(node.part ? { id: node.part } : {}),
      name: (filename || 'attachment').slice(0, 500),
      mimeType: mimeType.slice(0, 200),
      size: Math.max(0, Number(node.size) || 0),
    });
  };
  walk(structure);
  return out;
}

function metaOf(
  m: FetchMessageObject,
  prefixBytes: number | undefined,
  includeStructure: boolean | undefined,
): MessageMeta {
  const e = m.envelope ?? {};
  return {
    uid: m.uid,
    flags: [...(m.flags ?? [])],
    internalDate: isoOf(m.internalDate),
    size: m.size ?? 0,
    date: isoOf(e.date),
    subject: (e.subject ?? '').slice(0, 1000),
    messageId: e.messageId ?? null,
    inReplyTo: e.inReplyTo ?? null,
    references: headerFrom(m.headers, 'references'),
    from: addresses(e.from),
    to: addresses(e.to),
    cc: addresses(e.cc),
    bcc: addresses(e.bcc),
    prefix: prefixBytes ? (m.source ?? null) : null,
    ...(includeStructure ? { attachments: attachmentsFromBodyStructure(m.bodyStructure) } : {}),
  };
}

class ImapflowSession implements ImapSession {
  readonly capabilities: ReadonlySet<string>;

  constructor(
    private readonly client: ImapFlow,
    private readonly host: string,
    private readonly port: number,
  ) {
    this.capabilities = new Set([...client.capabilities.keys()].map((c) => c.toUpperCase()));
  }

  private failed(what: string): MailError {
    return new MailError('imap', 'protocol', this.host, this.port, `The mail server refused to ${what}.`);
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mailErrorOf(err, 'imap', this.host, this.port);
    }
  }

  list(): Promise<MailboxInfo[]> {
    return this.run(async () =>
      (await this.client.list()).map((m) => ({
        path: m.path,
        specialUse: m.specialUse ?? null,
        delimiter: m.delimiter,
        noSelect: m.flags.has('\\Noselect') || m.flags.has('\\NonExistent'),
      })),
    );
  }

  open(path: string, options: { write: boolean }): Promise<OpenedFolder> {
    return this.run(async () => {
      const mb = await this.client.mailboxOpen(path, { readOnly: !options.write });
      return {
        path: mb.path,
        uidValidity: String(mb.uidValidity),
        exists: mb.exists,
        uidNext: typeof mb.uidNext === 'number' && mb.uidNext > 0 ? mb.uidNext : null,
      };
    });
  }

  unseen(path: string): Promise<number> {
    return this.run(async () => {
      const status = await this.client.status(path, { unseen: true });
      return status ? (status.unseen ?? 0) : 0;
    });
  }

  search(criteria: SearchObject): Promise<number[]> {
    return this.run(async () => {
      const found = await this.client.search(criteria, { uid: true });
      return Array.isArray(found) ? [...found].sort((a, b) => a - b) : [];
    });
  }

  meta(uids: readonly number[], options: MetaOptions = {}): Promise<MessageMeta[]> {
    if (uids.length === 0) return Promise.resolve([]);
    return this.run(async () => {
      const found = await this.client.fetchAll(
        range(uids),
        {
          uid: true,
          flags: true,
          envelope: true,
          internalDate: true,
          size: true,
          headers: ['references'],
          ...(options.bodyStructure ? { bodyStructure: true } : {}),
          ...(options.prefixBytes ? { source: { start: 0, maxLength: options.prefixBytes } } : {}),
        },
        { uid: true },
      );
      return found.map((m) => metaOf(m, options.prefixBytes, options.bodyStructure));
    });
  }

  source(uid: number, maxBytes: number): Promise<Buffer | null> {
    return this.run(async () => {
      const [head] = await this.client.fetchAll(String(uid), { uid: true, size: true }, { uid: true });
      if (!head || (head.size ?? 0) > maxBytes) return null;
      const m = await this.client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      return m ? (m.source ?? null) : null;
    });
  }

  append(path: string, raw: Buffer, flags: readonly string[], date?: Date) {
    return this.run(async () => {
      const res = await this.client.append(path, raw, [...flags], date);
      if (!res) throw this.failed('save the message');
      return {
        uid: res.uid ?? null,
        uidValidity: res.uidValidity !== undefined ? String(res.uidValidity) : null,
      };
    });
  }

  flags(uids: readonly number[], add: readonly string[], remove: readonly string[]): Promise<void> {
    if (uids.length === 0) return Promise.resolve();
    return this.run(async () => {
      if (add.length && !(await this.client.messageFlagsAdd(range(uids), [...add], { uid: true })))
        throw this.failed('change the message');
      if (remove.length && !(await this.client.messageFlagsRemove(range(uids), [...remove], { uid: true })))
        throw this.failed('change the message');
    });
  }

  move(uids: readonly number[], destination: string): Promise<void> {
    if (uids.length === 0) return Promise.resolve();
    return this.run(async () => {
      if (this.capabilities.has('MOVE')) {
        if (!(await this.client.messageMove(range(uids), destination, { uid: true })))
          throw this.failed('move the message');
        return;
      }
      if (!(await this.client.messageCopy(range(uids), destination, { uid: true })))
        throw this.failed('move the message');
      await this.removeHere(uids);
    });
  }

  remove(uids: readonly number[]): Promise<void> {
    if (uids.length === 0) return Promise.resolve();
    return this.run(() => this.removeHere(uids));
  }

  private async removeHere(uids: readonly number[]): Promise<void> {
    const ok = this.capabilities.has('UIDPLUS')
      ? await this.client.messageDelete(range(uids), { uid: true })
      : await this.client.messageFlagsAdd(range(uids), ['\\Deleted'], { uid: true });
    if (!ok) throw this.failed('remove the message');
  }

  create(path: string): Promise<void> {
    return this.run(async () => {
      await this.client.mailboxCreate(path);
    });
  }

  async idle(onExists: () => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const onNew = (data: { count: number; prevCount: number }) => {
      if (data.count > data.prevCount) onExists();
    };
    const onAbort = () => {
      void this.close();
    };
    this.client.on('exists', onNew);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal.aborted && this.client.usable) {
        await this.client.idle();
      }
    } catch (err) {
      // Aborting ends IDLE cleanly; propagate unexpected socket errors so the watcher backs off before reconnecting.
      if (!signal.aborted) throw err;
    } finally {
      this.client.off('exists', onNew);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}

/** Connects and signs in over imapflow. Throws `MailError` (side `imap`). */
export const openImapflow: OpenImap = async (o) => {
  const t = { ...MAIL_TIMEOUTS, ...o.timeouts };
  const servername = serverNameOf(o.host);
  const client = new ImapFlow({
    host: o.address,
    port: o.port,
    secure: o.security === 'tls',
    ...(o.security === 'starttls' ? { doSTARTTLS: true } : {}),
    ...(servername ? { servername } : {}),
    auth: { user: o.user, pass: o.pass },
    clientInfo: { name: 'Whombat' },
    logger: false,
    disableAutoIdle: true,
    tls: {
      ...(servername ? { servername } : {}),
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...(o.ca ? { ca: o.ca } : {}),
    },
    connectionTimeout: t.connectMs,
    greetingTimeout: t.greetingMs,
    socketTimeout: t.socketMs,
    ...(o.maxIdleTimeMs ? { maxIdleTime: o.maxIdleTimeMs } : {}),
    maxLiteralSize: MAX_LITERAL,
    maxResponseSize: MAX_LITERAL * 2,
    maxLineLength: 4 * 1024 * 1024,
  });
  // A late socket error after a call ended must not reach the process as an unhandled 'error' event.
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (err) {
    client.close();
    throw mailErrorOf(err, 'imap', o.host, o.port);
  }
  return new ImapflowSession(client, o.host, o.port);
};
