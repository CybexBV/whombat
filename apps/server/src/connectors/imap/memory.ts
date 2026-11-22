/**
 * An IMAP account in memory (tests and the fake mode only; docs/decisions/connections-more-mail.md CM-M04): folders with
 * UIDVALIDITY and UIDs, raw messages, flags, and a `SEARCH` evaluator for the criteria `search.ts` makes, behind the
 * same `ImapSession` as imapflow. What it can't know it doesn't pretend: no THREAD, no SORT, and it answers a wrong
 * password as a server does (`MailError` `refused`).
 */
import type { SearchObject } from 'imapflow';
import type { ParsedMail } from 'mailparser';
import { attachmentsOf, parseMail } from './compose';
import { MailError } from './errors';
import type {
  ImapConnectOptions,
  ImapSession,
  MailboxInfo,
  MessageMeta,
  MetaOptions,
  OpenedFolder,
} from './session';

interface StoredMessage {
  uid: number;
  raw: Buffer;
  flags: Set<string>;
  internalDate: Date;
  parsed?: ParsedMail;
}

interface Folder {
  path: string;
  specialUse: string | null;
  uidValidity: string;
  nextUid: number;
  messages: StoredMessage[];
}

export interface MemoryMailOptions {
  user: string;
  pass: string;
  /** Default `IMAP4rev1 MOVE UIDPLUS SPECIAL-USE`. */
  capabilities?: string[];
  /** Folders besides INBOX: `{ path, specialUse }` (default Sent, Drafts, Trash, Archive, Junk with their flags). */
  folders?: { path: string; specialUse: string | null }[];
}

const DEFAULT_FOLDERS = [
  { path: 'Sent', specialUse: '\\Sent' },
  { path: 'Drafts', specialUse: '\\Drafts' },
  { path: 'Trash', specialUse: '\\Trash' },
  { path: 'Archive', specialUse: '\\Archive' },
  { path: 'Junk', specialUse: '\\Junk' },
];

const lower = (s: string | undefined | null) => (s ?? '').toLowerCase();
const day = (d: Date) => d.toISOString().slice(0, 10);

export class MemoryMailServer {
  readonly folders = new Map<string, Folder>();
  capabilities: Set<string>;
  /** Every session opened, for tests that count them. */
  connections = 0;
  /** Number of `source()` calls (full message body downloads), for tests checking headers-only matching. */
  sourceReads = 0;
  private validity = 1000;
  private readonly idleListeners = new Map<string, Set<() => void>>();

  constructor(readonly options: MemoryMailOptions) {
    this.capabilities = new Set(
      options.capabilities ?? ['IMAP4REV1', 'IDLE', 'MOVE', 'UIDPLUS', 'SPECIAL-USE'],
    );
    this.addFolder('INBOX', '\\Inbox');
    for (const f of options.folders ?? DEFAULT_FOLDERS) this.addFolder(f.path, f.specialUse);
  }

  addFolder(path: string, specialUse: string | null = null): Folder {
    const folder: Folder = {
      path,
      specialUse,
      uidValidity: String(++this.validity),
      nextUid: 1,
      messages: [],
    };
    this.folders.set(path, folder);
    return folder;
  }

  folder(path: string): Folder {
    const f = this.folders.get(path) ?? [...this.folders.values()].find((x) => lower(x.path) === lower(path));
    if (!f) throw new MailError('imap', 'protocol', 'memory', 993, `No folder ${path}.`);
    return f;
  }

  /** Puts a message in a folder; its UID. Notifies any active IMAP IDLE sessions on that folder. */
  add(path: string, raw: string | Buffer, options: { flags?: string[]; date?: Date } = {}): number {
    const f = this.folder(path);
    const uid = f.nextUid++;
    f.messages.push({
      uid,
      raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.replace(/\r?\n/g, '\r\n')),
      flags: new Set(options.flags ?? []),
      internalDate: options.date ?? new Date(),
    });
    const listeners = this.idleListeners.get(f.path);
    if (listeners) for (const fn of [...listeners]) fn();
    return uid;
  }

  /** Internal: registers a callback for new mail arriving in `path` while idling. */
  onFolderExists(path: string, fn: () => void): () => void {
    let set = this.idleListeners.get(path);
    if (!set) {
      set = new Set();
      this.idleListeners.set(path, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
      if (set?.size === 0) this.idleListeners.delete(path);
    };
  }

  /** A new UIDVALIDITY for a folder (the server renumbered it). */
  renumber(path: string): void {
    this.folder(path).uidValidity = String(++this.validity);
  }

  /** The session imapflow would give: the password checked first. */
  connect = async (
    o: Pick<ImapConnectOptions, 'user' | 'pass'> & Partial<Pick<ImapConnectOptions, 'host' | 'port'>>,
  ): Promise<ImapSession> => {
    if (o.user !== this.options.user || o.pass !== this.options.pass)
      throw new MailError('imap', 'refused', o.host ?? 'memory', o.port ?? 993);
    this.connections++;
    return new MemorySession(this);
  };
}

async function parsed(m: StoredMessage): Promise<ParsedMail> {
  if (!m.parsed) m.parsed = await parseMail(m.raw);
  return m.parsed;
}

function headerText(p: ParsedMail, name: string): string {
  return p.headerLines
    .filter((l) => lower(l.key) === lower(name))
    .map((l) => l.line.slice(l.line.indexOf(':') + 1))
    .join(' ');
}

async function matches(m: StoredMessage, c: SearchObject): Promise<boolean> {
  const p = await parsed(m);
  const has = (flag: string) => [...m.flags].some((f) => lower(f) === lower(flag));
  const checks: Promise<boolean>[] = [];
  const check = (ok: boolean) => checks.push(Promise.resolve(ok));
  for (const [key, value] of Object.entries(c)) {
    switch (key) {
      case 'all':
        break;
      case 'seen':
      case 'flagged':
      case 'draft':
      case 'deleted':
      case 'answered':
        check(has(`\\${key[0]?.toUpperCase()}${key.slice(1)}`) === value);
        break;
      case 'from':
      case 'to':
      case 'cc':
      case 'bcc':
      case 'subject':
        check(lower(headerText(p, key)).includes(lower(String(value))));
        break;
      case 'body':
        check(lower(p.text ?? '').includes(lower(String(value))));
        break;
      case 'text':
        check(
          lower(m.raw.toString('utf8')).includes(lower(String(value))) ||
            lower(p.text).includes(lower(String(value))),
        );
        break;
      case 'since':
        check(day(m.internalDate) >= day(new Date(value as string)));
        break;
      case 'before':
        check(day(m.internalDate) < day(new Date(value as string)));
        break;
      case 'uid': {
        const parts = String(value).split(',');
        const matched = parts.some((part) => {
          if (part.includes(':')) {
            const [a, b] = part.split(':');
            const lo = Number(a);
            const hi = b === '*' ? Number.POSITIVE_INFINITY : Number(b);
            return Number.isFinite(lo) && m.uid >= lo && m.uid <= hi;
          }
          return Number(part) === m.uid;
        });
        check(matched);
        break;
      }
      case 'header':
        for (const [name, v] of Object.entries(value as Record<string, string | boolean>))
          check(
            v === true ? headerText(p, name) !== '' : lower(headerText(p, name)).includes(lower(String(v))),
          );
        break;
      case 'not':
        checks.push(matches(m, value as SearchObject).then((x) => !x));
        break;
      case 'or': {
        const list = value as SearchObject[];
        checks.push(Promise.all(list.map((o) => matches(m, o))).then((r) => r.some(Boolean)));
        break;
      }
      default:
        throw new Error(`The memory server doesn't search by ${key}.`);
    }
  }
  return (await Promise.all(checks)).every(Boolean);
}

class MemorySession implements ImapSession {
  readonly capabilities: ReadonlySet<string>;
  private current: Folder | null = null;
  private closed = false;

  constructor(private readonly server: MemoryMailServer) {
    this.capabilities = new Set(server.capabilities);
  }

  private here(): Folder {
    if (this.closed) throw new MailError('imap', 'unreachable', 'memory', 993);
    if (!this.current) throw new MailError('imap', 'protocol', 'memory', 993, 'No folder open.');
    return this.current;
  }

  async list(): Promise<MailboxInfo[]> {
    return [...this.server.folders.values()].map((f) => ({
      path: f.path,
      specialUse: f.specialUse,
      delimiter: '/',
      noSelect: false,
    }));
  }

  async open(path: string): Promise<OpenedFolder> {
    const f = this.server.folder(path);
    this.current = f;
    return { path: f.path, uidValidity: f.uidValidity, exists: f.messages.length, uidNext: f.nextUid };
  }

  async unseen(path: string): Promise<number> {
    return this.server.folder(path).messages.filter((m) => ![...m.flags].some((f) => lower(f) === '\\seen'))
      .length;
  }

  async search(criteria: SearchObject): Promise<number[]> {
    const f = this.here();
    const out: number[] = [];
    for (const m of f.messages) if (await matches(m, criteria)) out.push(m.uid);
    return out;
  }

  async meta(uids: readonly number[], options: MetaOptions = {}): Promise<MessageMeta[]> {
    const f = this.here();
    const out: MessageMeta[] = [];
    for (const m of f.messages) {
      if (!uids.includes(m.uid)) continue;
      const p = await parsed(m);
      const list = (v: ParsedMail['to']) =>
        (Array.isArray(v) ? v : v ? [v] : []).flatMap((a) =>
          a.value.filter((x) => x.address).map((x) => ({ name: x.name ?? '', address: x.address ?? '' })),
        );
      out.push({
        uid: m.uid,
        flags: [...m.flags],
        internalDate: m.internalDate.toISOString(),
        size: m.raw.length,
        date: p.date ? p.date.toISOString() : null,
        subject: p.subject ?? '',
        messageId: p.messageId ?? null,
        inReplyTo: p.inReplyTo ?? null,
        references: headerText(p, 'references').trim() || null,
        from: list(p.from),
        to: list(p.to),
        cc: list(p.cc),
        bcc: list(p.bcc),
        prefix: options.prefixBytes ? m.raw.subarray(0, options.prefixBytes) : null,
        ...(options.bodyStructure ? { attachments: attachmentsOf(p) } : {}),
      });
    }
    return out;
  }

  async source(uid: number, maxBytes: number): Promise<Buffer | null> {
    this.server.sourceReads++;
    const m = this.here().messages.find((x) => x.uid === uid);
    return m && m.raw.length <= maxBytes ? m.raw : null;
  }

  async append(path: string, raw: Buffer, flags: readonly string[], date?: Date) {
    const f = this.server.folder(path);
    const uid = this.server.add(f.path, raw, { flags: [...flags], ...(date ? { date } : {}) });
    const uidplus = this.capabilities.has('UIDPLUS');
    return { uid: uidplus ? uid : null, uidValidity: uidplus ? f.uidValidity : null };
  }

  async flags(uids: readonly number[], add: readonly string[], remove: readonly string[]): Promise<void> {
    for (const m of this.here().messages) {
      if (!uids.includes(m.uid)) continue;
      for (const f of add) m.flags.add(f);
      for (const f of remove) for (const x of [...m.flags]) if (lower(x) === lower(f)) m.flags.delete(x);
    }
  }

  async move(uids: readonly number[], destination: string): Promise<void> {
    const from = this.here();
    const to = this.server.folder(destination);
    for (const m of [...from.messages]) {
      if (!uids.includes(m.uid)) continue;
      to.messages.push({ ...m, uid: to.nextUid++ });
      if (this.capabilities.has('MOVE') || this.capabilities.has('UIDPLUS'))
        from.messages = from.messages.filter((x) => x !== m);
      else m.flags.add('\\Deleted');
    }
  }

  async remove(uids: readonly number[]): Promise<void> {
    const f = this.here();
    if (this.capabilities.has('UIDPLUS')) f.messages = f.messages.filter((m) => !uids.includes(m.uid));
    else for (const m of f.messages) if (uids.includes(m.uid)) m.flags.add('\\Deleted');
  }

  async create(path: string): Promise<void> {
    if (!this.server.folders.has(path)) this.server.addFolder(path);
  }

  async idle(onExists: () => void, signal: AbortSignal): Promise<void> {
    const folder = this.here();
    if (signal.aborted || this.closed) return;
    await new Promise<void>((resolve) => {
      const off = this.server.onFolderExists(folder.path, onExists);
      const done = () => {
        off();
        resolve();
      };
      if (signal.aborted || this.closed) {
        done();
        return;
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
