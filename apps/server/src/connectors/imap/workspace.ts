/**
 * Email (IMAP) behind the mail tools (docs/decisions/connections-more.md CM-19…CM-27, connections-more-mail.md): the
 * mail methods of `GoogleWorkspace` over IMAP and SMTP; everything else answers “Email (IMAP) only does mail.”.
 *
 * The “token” a method gets is the connection's id (`ConnectionTokens.accessFor` for `imap`): the adapter loads the
 * account (address, server settings, the opened password) itself, so the password never travels through the tools.
 * Every call is one IMAP connection (connect, sign in, work, log out), as a socket call is one socket. A password the
 * server refuses marks the connection “needs a new password” and the tool says so; other failures say which server and
 * what went wrong, in words.
 *
 * - Search (CM-25): `search.ts` turns Gmail's words into one SEARCH in one folder; the newest `limit` UIDs, newest first.
 * - Ids (CM-24): `ids.ts`. A thread is read in its folder and in Sent.
 * - Drafts (CM-26): appended to Drafts with `\Draft`; sending recomposes the draft as read (what the person approved),
 *   sends it over SMTP, keeps a copy in Sent unless the provider does (`savesSent`), and removes the draft. Once the
 *   server took the message nothing after it fails the send: the copy and the clean-up are best effort.
 * - Organising (CM-27, CM-M06): read and unread, `STARRED`, folders as labels, archive. Trash is `mailTrash`: a move to
 *   the Trash folder, never an expunge.
 */
import {
  CONNECTOR_BINARY_MAX_BYTES,
  type ConnectionCheck,
  type ConnectorBinary,
  type ConnectorService,
  type MailDraftInput,
  MailMessage,
  type MailServer,
  MailSummary,
} from '@whombat/core';
import type { ParsedMail } from 'mailparser';
import { ApiError, badRequest } from '../../lib/errors';
import { attachmentDigest, checkAttachmentTotal } from '../binary';
import { replyReferences, replySubject } from '../mime';
import {
  ConnectionUnavailableError,
  type GoogleWorkspace,
  type InboxUnread,
  type MailChangesOptions,
  type MailChangesResult,
  type MailDraftView,
  type MailHeader,
  type MailOrganizeInput,
  type MailProviderCursor,
} from '../types';
import {
  attachmentBinary,
  attachmentsOf,
  bodyText,
  cappedBody,
  composeMessage,
  parseMail,
  plainAddresses,
  shownAddress,
  shownAddresses,
  snippetOf,
  withoutBcc,
} from './compose';
import { MailError } from './errors';
import {
  FOLDER_NAMES,
  type FolderRole,
  folderByName,
  folderByRole,
  folderLabel,
  labelsOf,
  pickFolder,
  roleOf,
} from './folders';
import {
  type ImapMessageRef,
  messageIdOf,
  parseMessageId,
  parseThreadId,
  resolveMailbox,
  threadIdOf,
  threadRoot,
} from './ids';
import { type FolderPick, parseMailQuery } from './search';
import type { ImapSession, MailboxInfo, MessageMeta } from './session';

export const IMAP_ONLY_MAIL_TEXT = 'Email (IMAP) only does mail.';
export const MESSAGE_GONE_TEXT = 'That message isn’t there any more: search again.';
export const NEEDS_PASSWORD_TEXT = 'This mail account needs a new password.';
export const ONE_FOLDER_TEXT = 'On Email (IMAP) a message is in one folder: give one folder to move it to.';

/** Whole messages up to this size are parsed; a larger one is read from its first `LARGE_PREFIX` bytes. */
const FULL_SOURCE_MAX = 30 * 1024 * 1024;
const LARGE_PREFIX = 1024 * 1024;
/** What a search reads of each result for its snippet. */
const SNIPPET_PREFIX = 12 * 1024;
/** At most this many messages of a thread (the newest). */
const THREAD_MAX = 50;
/** A read's whole call, connect to log out. */
export const MAIL_CALL_DEADLINE_MS = 30_000;

/** What the adapter needs of a connection. */
export interface ImapAccount {
  email: string;
  /** Shown with the address on mail sent (`Mara Okafor <mara@…>`). */
  name: string;
  /** Who signs in (the address unless the settings name another). */
  user: string;
  password: string;
  imap: MailServer;
  smtp: MailServer;
  /** The provider keeps its own copy of sent mail in Sent (Gmail, Outlook, iCloud: CM-26). */
  savesSent: boolean;
}

/** Opens the two sides of an account, under the destination policy (`net.ts`). */
export interface MailConnector {
  imap(account: ImapAccount): Promise<ImapSession>;
  smtpVerify(account: ImapAccount): Promise<void>;
  /** How many recipients the server refused while taking the message for the others. */
  smtpSend(
    account: ImapAccount,
    envelope: { from: string; to: string[] },
    raw: Buffer,
  ): Promise<{ rejected: number }>;
}

export interface ImapWorkspaceDeps {
  /** The account a token (the connection id) stands for. Throws `ConnectionUnavailableError`. */
  account(token: string): Promise<ImapAccount>;
  /** The server refused the password: the connection needs a new one. */
  refused(token: string): Promise<void>;
  connector: MailConnector;
  now(): Date;
  /** What went wrong after a message went out (its Sent copy, removing the draft), for the log. */
  warn?(message: string, err: unknown): void;
  /** Tests: a shorter whole-call deadline. */
  deadlineMs?: number;
}

const gone = () =>
  new ApiError('not_found', MESSAGE_GONE_TEXT, { details: { connector: 'mail', reason: 'not_found' } });

/**
 * The folder a thread id names: the message's own, except Drafts and Sent, whose threads are the inbox's (a thread is
 * read in its folder, the inbox and Sent), so a reply and its draft carry the original's thread id.
 */
function threadHome(folders: readonly MailboxInfo[], path: string): string {
  const role = roleOf(folders, path);
  return role === 'drafts' || role === 'sent' ? (folderByRole(folders, 'inbox')?.path ?? path) : path;
}

const has = (flags: readonly string[], flag: string) =>
  flags.some((f) => f.toLowerCase() === flag.toLowerCase());

/** A failure as the tool says it (the words are already ours: no server text). */
function toolError(err: MailError): ApiError {
  const code =
    err.reason === 'busy'
      ? 'rate_limited'
      : err.reason === 'not_allowed'
        ? 'not_allowed'
        : err.reason === 'protocol' || err.reason === 'web_sign_in' || err.reason === 'contact_provider'
          ? 'conflict'
          : 'internal';
  return new ApiError(code, err.message, {
    details: { connector: 'mail', reason: `${err.side}_${err.reason}` },
    logMessage: err.message,
  });
}

function noFolder(pick: FolderPick, folders: readonly MailboxInfo[]): ApiError {
  const names = folders
    .filter((f) => !f.noSelect)
    .map((f) => f.path)
    .slice(0, 30)
    .join(', ');
  const asked = 'role' in pick ? pick.role : pick.name;
  return new ApiError('not_found', `There’s no folder called “${asked.slice(0, 100)}”. Folders: ${names}.`, {
    details: { connector: 'mail', reason: 'no_folder' },
  });
}

/** Rejects when `ms` pass first (and closes the session, which ends what it was doing). */
function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  session: ImapSession,
  account: ImapAccount,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void session.close();
      reject(new MailError('imap', 'timeout', account.imap.host, account.imap.port));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export class ImapWorkspace implements GoogleWorkspace {
  constructor(private readonly deps: ImapWorkspaceDeps) {}

  /* One connection per call ----------------------------------------------------------------------- */

  private async failure(token: string, err: unknown): Promise<Error> {
    if (err instanceof MailError) {
      if (err.side === 'imap' && err.reason === 'refused') {
        await this.deps.refused(token);
        return new ConnectionUnavailableError('needs_reauth', NEEDS_PASSWORD_TEXT);
      }
      return toolError(err);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /** Runs `fn` on a fresh connection, closed after; `deadline: false` for a send (it must not be cut short). */
  private async withImap<T>(
    token: string,
    fn: (s: ImapSession, account: ImapAccount) => Promise<T>,
    options: { deadline?: boolean } = {},
  ): Promise<T> {
    const account = await this.deps.account(token);
    let session: ImapSession;
    try {
      session = await this.deps.connector.imap(account);
    } catch (err) {
      throw await this.failure(token, err);
    }
    try {
      const work = fn(session, account);
      return await (options.deadline === false
        ? work
        : withDeadline(work, this.deps.deadlineMs ?? MAIL_CALL_DEADLINE_MS, session, account));
    } catch (err) {
      throw await this.failure(token, err);
    } finally {
      await session.close();
    }
  }

  /* Folders and messages --------------------------------------------------------------------------- */

  /** Opens the folder of a message id and checks it still numbers its messages the same way. */
  private async openRef(
    s: ImapSession,
    folders: readonly MailboxInfo[],
    ref: ImapMessageRef,
    write: boolean,
  ): Promise<string> {
    const path = resolveMailbox(
      ref.mailbox,
      folders.map((f) => f.path),
    );
    if (!path || !folders.some((f) => f.path === path && !f.noSelect)) throw gone();
    const opened = await s.open(path, { write });
    if (opened.uidValidity !== ref.uidValidity) throw gone();
    return path;
  }

  private async ensureFolder(
    s: ImapSession,
    folders: MailboxInfo[],
    role: Extract<FolderRole, 'drafts' | 'sent' | 'archive' | 'trash'>,
  ): Promise<MailboxInfo> {
    const found = folderByRole(folders, role);
    if (found) return found;
    const path = role === 'sent' ? 'Sent' : FOLDER_NAMES[role];
    await s.create(path);
    const made: MailboxInfo = {
      path,
      specialUse: null,
      delimiter: folders[0]?.delimiter ?? '/',
      noSelect: false,
    };
    folders.push(made);
    return made;
  }

  private summary(
    path: string,
    uidValidity: string,
    folders: readonly MailboxInfo[],
    m: MessageMeta,
    snippet: string,
  ): MailSummary {
    const ref = { mailbox: path, uidValidity, uid: m.uid };
    return MailSummary.parse({
      id: messageIdOf(ref),
      threadId: threadIdOf(ref, threadRoot(m), threadHome(folders, path)),
      from: m.from[0] ? shownAddress(m.from[0]) : '',
      to: m.to.map(shownAddress),
      subject: m.subject,
      snippet,
      date: m.internalDate ?? m.date ?? this.deps.now().toISOString(),
      unread: !has(m.flags, '\\Seen'),
      labels: labelsOf(folderLabel(folders, path), m.flags),
    });
  }

  /** One message, whole (or from its start when it is very large). Null when it is gone. */
  private async readOne(
    s: ImapSession,
    folders: readonly MailboxInfo[],
    path: string,
    uidValidity: string,
    uid: number,
  ): Promise<{ message: MailMessage; parsed: ParsedMail } | null> {
    const [meta] = await s.meta([uid]);
    if (!meta) return null;
    let raw = await s.source(uid, FULL_SOURCE_MAX);
    const whole = raw !== null;
    // Too large to read whole: its first megabyte (the text comes first), without its files.
    if (!raw) raw = (await s.meta([uid], { prefixBytes: LARGE_PREFIX }))[0]?.prefix ?? null;
    if (!raw) return null;
    const parsed = await parseMail(raw);
    const { body, bodyTruncated } = cappedBody(parsed);
    const summary = this.summary(path, uidValidity, folders, meta, snippetOf(parsed));
    const message = MailMessage.parse({
      ...summary,
      cc: shownAddresses(parsed.cc),
      body,
      bodyTruncated: bodyTruncated || !whole,
      attachments: whole ? attachmentsOf(parsed) : [],
    });
    return { message, parsed };
  }

  /** The whole raw message of an id (a draft, an attachment's message). */
  private async parsedOf(s: ImapSession, uid: number): Promise<ParsedMail> {
    const raw = await s.source(uid, FULL_SOURCE_MAX);
    if (!raw) throw gone();
    return parseMail(raw);
  }

  private ref(id: string): ImapMessageRef {
    const ref = parseMessageId(id);
    if (!ref) throw gone();
    return ref;
  }

  /* Mail ---------------------------------------------------------------------------------------- */

  async mailSearch(token: string, input: { query: string; limit: number }): Promise<MailSummary[]> {
    return this.withImap(token, async (s) => {
      const folders = await s.list();
      const q = parseMailQuery(input.query, this.deps.now());
      const folder = pickFolder(folders, q.folder);
      if (!folder) throw noFolder(q.folder, folders);
      const opened = await s.open(folder.path, { write: false });
      const uids = (await s.search(q.criteria)).slice(-Math.max(1, input.limit));
      const metas = await s.meta(uids, { prefixBytes: SNIPPET_PREFIX });
      const found = await Promise.all(
        metas.map(async (m) => {
          const snippet = m.prefix ? await parseMail(m.prefix).then(snippetOf, () => '') : '';
          return this.summary(folder.path, opened.uidValidity, folders, m, snippet);
        }),
      );
      return found.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    });
  }

  async mailRead(token: string, input: { messageId?: string; threadId?: string }): Promise<MailMessage[]> {
    return this.withImap(token, async (s) => {
      const folders = await s.list();
      if (input.messageId) {
        const ref = this.ref(input.messageId);
        const path = await this.openRef(s, folders, ref, false);
        const one = await this.readOne(s, folders, path, ref.uidValidity, ref.uid);
        if (!one) throw gone();
        return [one.message];
      }
      const thread = parseThreadId(input.threadId ?? '');
      if (!thread) throw gone();
      if (thread.kind === 'message') {
        const path = await this.openRef(s, folders, thread.message, false);
        const one = await this.readOne(s, folders, path, thread.message.uidValidity, thread.message.uid);
        if (!one) throw gone();
        return [one.message];
      }
      // The thread's folder, the inbox and Sent (the person's replies), each once.
      const home = resolveMailbox(
        thread.mailbox,
        folders.map((f) => f.path),
      );
      const places = [
        ...new Set(
          [home, folderByRole(folders, 'inbox')?.path, folderByRole(folders, 'sent')?.path].filter(
            (p): p is string => !!p,
          ),
        ),
      ];
      const found: MailMessage[] = [];
      const seen = new Set<string>();
      for (const path of places) {
        if (!folders.some((f) => f.path === path && !f.noSelect)) continue;
        const opened = await s.open(path, { write: false });
        const uids = await s.search({
          or: [
            { header: { 'message-id': thread.root } },
            { header: { references: thread.root } },
            { header: { 'in-reply-to': thread.root } },
          ],
        });
        for (const uid of uids.slice(-THREAD_MAX)) {
          const one = await this.readOne(s, folders, path, opened.uidValidity, uid);
          if (!one) continue;
          // The same message in two folders (a copy of a sent reply) shows once.
          const key = one.parsed.messageId ?? one.message.id;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push(one.message);
        }
      }
      if (found.length === 0) throw gone();
      return found.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-THREAD_MAX);
    });
  }

  async mailAttachment(
    token: string,
    input: { messageId: string; attachmentId: string },
  ): Promise<ConnectorBinary> {
    return this.withImap(token, async (s) => {
      const folders = await s.list();
      const ref = this.ref(input.messageId);
      await this.openRef(s, folders, ref, false);
      const parsed = await this.parsedOf(s, ref.uid);
      const file = attachmentBinary(parsed, input.attachmentId);
      if (!file)
        throw new ApiError('not_found', 'That attachment isn’t on this message.', {
          details: { connector: 'mail', reason: 'not_found' },
        });
      if (Buffer.from(file.contentBase64, 'base64').length > CONNECTOR_BINARY_MAX_BYTES)
        throw badRequest('The file exceeds the 10 MB transfer limit.');
      return file;
    });
  }

  async mailDraft(token: string, input: MailDraftInput): Promise<{ draftId: string }> {
    checkAttachmentTotal(input.attachments ?? []);
    return this.withImap(token, async (s, account) => {
      const folders = await s.list();
      let subject = input.subject;
      let inReplyTo: string | null = null;
      let references: string | null = null;
      if (input.replyToMessageId) {
        const ref = this.ref(input.replyToMessageId);
        await this.openRef(s, folders, ref, false);
        const [original] = await s.meta([ref.uid]);
        if (!original) throw gone();
        inReplyTo = original.messageId;
        references = replyReferences(original.references, original.messageId);
        if (!subject.trim()) subject = replySubject(original.subject);
      }
      const drafts = await this.ensureFolder(s, folders, 'drafts');
      const { raw, messageId } = composeMessage({
        from: { email: account.email, name: account.name },
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject,
        body: input.body,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        inReplyTo,
        references,
        date: this.deps.now(),
      });
      const saved = await s.append(drafts.path, raw, ['\\Draft', '\\Seen'], this.deps.now());
      if (saved.uid && saved.uidValidity)
        return {
          draftId: messageIdOf({ mailbox: drafts.path, uidValidity: saved.uidValidity, uid: saved.uid }),
        };
      // Without UIDPLUS the server doesn't say the new UID: find the draft by the Message-ID it was given.
      const opened = await s.open(drafts.path, { write: false });
      const [uid] = (await s.search({ header: { 'message-id': messageId } })).slice(-1);
      if (!uid) throw new MailError('imap', 'protocol', account.imap.host, account.imap.port);
      return { draftId: messageIdOf({ mailbox: drafts.path, uidValidity: opened.uidValidity, uid }) };
    });
  }

  /** A draft's message, checked to still be a draft (in Drafts, or flagged `\Draft`). */
  private async draft(s: ImapSession, folders: readonly MailboxInfo[], draftId: string, write: boolean) {
    const ref = this.ref(draftId);
    const path = await this.openRef(s, folders, ref, write);
    const [meta] = await s.meta([ref.uid]);
    if (!meta) throw gone();
    if (!has(meta.flags, '\\Draft') && roleOf(folders, path) !== 'drafts')
      throw badRequest('This message is no longer a draft. Check Sent before retrying.');
    const parsed = await this.parsedOf(s, ref.uid);
    return { ref, path, meta, parsed };
  }

  private draftView(
    folders: readonly MailboxInfo[],
    draftId: string,
    d: { ref: ImapMessageRef; path: string; meta: MessageMeta; parsed: ParsedMail },
  ): MailDraftView {
    const files = d.parsed.attachments.map(
      (_, i) => attachmentBinary(d.parsed, String(i + 1)) as ConnectorBinary,
    );
    checkAttachmentTotal(files);
    return {
      ...(files.length ? { attachments: files.map(attachmentDigest) } : {}),
      draftId,
      threadId:
        d.meta.inReplyTo || d.meta.references
          ? threadIdOf(d.ref, threadRoot(d.meta), threadHome(folders, d.path))
          : null,
      to: plainAddresses(d.parsed.to),
      cc: plainAddresses(d.parsed.cc),
      bcc: plainAddresses(d.parsed.bcc),
      subject: d.parsed.subject ?? '',
      body: bodyText(d.parsed),
    };
  }

  async mailGetDraft(token: string, draftId: string): Promise<MailDraftView> {
    return this.withImap(token, async (s) => {
      const folders = await s.list();
      return this.draftView(folders, draftId, await this.draft(s, folders, draftId, false));
    });
  }

  async mailSendDraft(token: string, draftId: string): Promise<{ messageId: string; threadId: string }> {
    return this.withImap(
      token,
      async (s, account) => {
        const folders = await s.list();
        const d = await this.draft(s, folders, draftId, true);
        const view = this.draftView(folders, draftId, d);
        const recipients = [...view.to, ...view.cc, ...view.bcc];
        if (recipients.length === 0)
          throw badRequest('That draft has no recipients yet. Draft it again with to.');
        // What goes out is the draft as the person approved it, recomposed: recipients, subject, text and files.
        const files = d.parsed.attachments.map(
          (_, i) => attachmentBinary(d.parsed, String(i + 1)) as ConnectorBinary,
        );
        const refs = Array.isArray(d.parsed.references)
          ? d.parsed.references.join(' ')
          : (d.parsed.references ?? null);
        const { raw, messageId } = composeMessage({
          from: { email: account.email, name: account.name },
          to: view.to,
          cc: view.cc,
          bcc: view.bcc,
          subject: view.subject,
          body: view.body,
          ...(files.length ? { attachments: files } : {}),
          inReplyTo: d.parsed.inReplyTo ?? null,
          references: refs,
          ...(d.parsed.messageId ? { messageId: d.parsed.messageId } : {}),
          date: this.deps.now(),
        });
        const { rejected } = await this.deps.connector.smtpSend(
          account,
          { from: account.email, to: recipients },
          withoutBcc(raw),
        );
        // It went out: from here nothing fails the send (an executor retry would send it twice).
        let sentId: string | null = null;
        try {
          if (!account.savesSent) {
            const sent = await this.ensureFolder(s, folders, 'sent');
            // A provider the hints don't know may keep its own copy: only a missing one is added.
            const opened = await s.open(sent.path, { write: false });
            const [kept] = messageId
              ? (await s.search({ header: { 'message-id': messageId } })).slice(-1)
              : [];
            if (kept)
              sentId = messageIdOf({ mailbox: sent.path, uidValidity: opened.uidValidity, uid: kept });
            else {
              const saved = await s.append(sent.path, raw, ['\\Seen'], this.deps.now());
              if (saved.uid && saved.uidValidity)
                sentId = messageIdOf({ mailbox: sent.path, uidValidity: saved.uidValidity, uid: saved.uid });
            }
          }
        } catch (err) {
          this.deps.warn?.('the sent copy wasn’t saved', err);
        }
        try {
          await s.open(d.path, { write: true });
          await s.remove([d.ref.uid]);
        } catch (err) {
          this.deps.warn?.('the sent draft wasn’t removed', err);
        }
        // Some recipients refused: it went to the others, which can't be undone; said without naming them (PA-09).
        if (rejected > 0)
          throw toolError(
            new MailError(
              'smtp',
              'protocol',
              account.smtp.host,
              account.smtp.port,
              `The sending server refused ${rejected === 1 ? 'one recipient' : `${rejected} recipients`}; it went to the others.`,
            ),
          );
        const root = threadRoot(d.meta) ?? d.parsed.messageId ?? null;
        const threadId = threadIdOf(d.ref, root, threadHome(folders, d.path));
        return { messageId: sentId ?? draftId, threadId };
      },
      { deadline: false },
    );
  }

  async mailOrganize(token: string, input: MailOrganizeInput): Promise<{ updated: number }> {
    const named = (labels: readonly string[], name: string) =>
      labels.some((l) => l.trim().toUpperCase() === name);
    for (const label of [...input.addLabels, ...input.removeLabels]) {
      const upper = label.trim().toUpperCase();
      if (upper === 'IMPORTANT' || upper.startsWith('CATEGORY_'))
        throw badRequest(`Email (IMAP) has no ${upper} label: on IMAP, labels are folders.`);
    }
    const special = new Set(['STARRED', 'UNREAD', 'INBOX']);
    const folderLabels = input.addLabels.filter((l) => !special.has(l.trim().toUpperCase()));
    const toInbox = named(input.addLabels, 'INBOX') || input.archive === false;
    const moves = (folderLabels.length ? 1 : 0) + (toInbox ? 1 : 0) + (input.archive === true ? 1 : 0);
    if (folderLabels.length > 1 || moves > 1) throw badRequest(ONE_FOLDER_TEXT);
    const markRead = input.read === true || named(input.removeLabels, 'UNREAD');
    const markUnread = input.read === false || named(input.addLabels, 'UNREAD');
    if (markRead && markUnread) throw badRequest('Mark it read or unread, not both.');
    const add: string[] = [];
    const remove: string[] = [];
    if (markRead) add.push('\\Seen');
    if (markUnread) remove.push('\\Seen');
    if (named(input.addLabels, 'STARRED')) add.push('\\Flagged');
    if (named(input.removeLabels, 'STARRED')) remove.push('\\Flagged');
    const refs = input.messageIds.map((id) => this.ref(id));

    return this.withImap(token, async (s) => {
      const folders = await s.list();
      const byFolder = new Map<string, ImapMessageRef[]>();
      for (const ref of refs) {
        const path = resolveMailbox(
          ref.mailbox,
          folders.map((f) => f.path),
        );
        if (!path) throw gone();
        byFolder.set(path, [...(byFolder.get(path) ?? []), ref]);
      }
      let destination: MailboxInfo | null = null;
      if (folderLabels[0]) {
        const name = folderLabels[0].trim();
        destination = folderByName(folders, name);
        if (!destination) {
          // Gmail makes a label that isn't there yet; on IMAP that is a folder.
          await s.create(name);
          destination = {
            path: name,
            specialUse: null,
            delimiter: folders[0]?.delimiter ?? '/',
            noSelect: false,
          };
          folders.push(destination);
        }
      } else if (toInbox) destination = folderByRole(folders, 'inbox');
      else if (input.archive === true) destination = await this.ensureFolder(s, folders, 'archive');
      let updated = 0;
      for (const [path, list] of byFolder) {
        await this.openRef(s, folders, list[0] as ImapMessageRef, true);
        for (const ref of list) if (ref.uidValidity !== (list[0] as ImapMessageRef).uidValidity) throw gone();
        const uids = list.map((r) => r.uid);
        // Every message must still be there before anything changes.
        const present = new Set((await s.meta(uids)).map((m) => m.uid));
        if (uids.some((u) => !present.has(u))) throw gone();
        await s.flags(uids, add, remove);
        // Taking away the label of the folder a message is in (INBOX included) archives it, as on Gmail.
        let target = destination;
        if (
          !target &&
          input.removeLabels.some((l) => l.trim().toLowerCase() === folderLabel(folders, path).toLowerCase())
        )
          target = await this.ensureFolder(s, folders, 'archive');
        if (target && target.path !== path) await s.move(uids, target.path);
        updated += uids.length;
      }
      return { updated };
    });
  }

  async mailTrash(token: string, input: { messageIds: string[] }): Promise<{ trashed: number }> {
    const refs = input.messageIds.map((id) => this.ref(id));
    return this.withImap(token, async (s) => {
      const folders = await s.list();
      const byFolder = new Map<string, ImapMessageRef[]>();
      for (const ref of refs) {
        const path = resolveMailbox(
          ref.mailbox,
          folders.map((f) => f.path),
        );
        if (!path) throw gone();
        byFolder.set(path, [...(byFolder.get(path) ?? []), ref]);
      }
      const trash = await this.ensureFolder(s, folders, 'trash');
      let trashed = 0;
      for (const [path, list] of byFolder) {
        // Already in the trash: nothing to move (an expunge would delete it for good).
        if (path === trash.path) {
          trashed += list.length;
          continue;
        }
        await this.openRef(s, folders, list[0] as ImapMessageRef, true);
        for (const ref of list) if (ref.uidValidity !== (list[0] as ImapMessageRef).uidValidity) throw gone();
        const uids = list.map((r) => r.uid);
        const present = new Set((await s.meta(uids)).map((m) => m.uid));
        if (uids.some((u) => !present.has(u))) throw gone();
        await s.move(uids, trash.path);
        trashed += uids.length;
      }
      return { trashed };
    });
  }

  /**
   * Unread mail in the inbox (STATUS UNSEEN: nothing is opened or marked), for Home and the screens; with `newest`,
   * that many of the newest unread from the inbox opened read-only, their headers only.
   */
  async inboxUnread(token: string, input: { newest?: number } = {}): Promise<InboxUnread> {
    return this.withImap(token, async (s) => {
      const folders = await s.list();
      const inbox = folderByRole(folders, 'inbox');
      if (!inbox) return { count: 0, newest: [] };
      const count = await s.unseen(inbox.path);
      const take = Math.min(25, Math.max(0, input.newest ?? 0));
      if (count === 0 || take === 0) return { count, newest: [] };
      const opened = await s.open(inbox.path, { write: false });
      const uids = (await s.search({ seen: false })).slice(-take);
      const metas = await s.meta(uids);
      const newest = metas
        .map((m) => this.summary(inbox.path, opened.uidValidity, folders, m, ''))
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      return { count, newest };
    });
  }

  async mailBaseline(token: string): Promise<MailProviderCursor> {
    return this.withImap(token, async (s) => {
      const folders = await s.list();
      const inbox = folderByRole(folders, 'inbox');
      const path = inbox?.path ?? 'INBOX';
      const opened = await s.open(path, { write: false });
      const lastUid =
        opened.uidNext !== null
          ? Math.max(0, opened.uidNext - 1)
          : (await s.search({ all: true })).reduce((max, u) => Math.max(max, u), 0);
      return { kind: 'imap', mailbox: opened.path, uidValidity: opened.uidValidity, lastUid };
    });
  }

  async mailChanges(
    token: string,
    cursor: MailProviderCursor,
    _options: MailChangesOptions = {},
  ): Promise<MailChangesResult> {
    if (cursor.kind !== 'imap') {
      return { cursor: await this.mailBaseline(token), headers: [], reset: true };
    }
    return this.withImap(token, async (s) => {
      const folders = await s.list();
      const path =
        resolveMailbox(
          cursor.mailbox,
          folders.map((f) => f.path),
        ) ??
        folderByRole(folders, 'inbox')?.path ??
        'INBOX';
      const opened = await s.open(path, { write: false });
      if (opened.uidValidity !== cursor.uidValidity) {
        const lastUid =
          opened.uidNext !== null
            ? Math.max(0, opened.uidNext - 1)
            : (await s.search({ all: true })).reduce((max, u) => Math.max(max, u), 0);
        return {
          cursor: { kind: 'imap', mailbox: opened.path, uidValidity: opened.uidValidity, lastUid },
          headers: [],
          reset: true,
        };
      }
      const found = (await s.search({ uid: `${cursor.lastUid + 1}:*` }))
        .filter((u) => u > cursor.lastUid)
        .sort((a, b) => a - b);
      if (found.length === 0) return { cursor, headers: [] };
      const batch = found.slice(0, 50);
      // Fetch envelope, flags and BODYSTRUCTURE only — never raw message bodies until a trigger matches.
      const metas = await s.meta(batch, { bodyStructure: true });
      const byUid = new Map(metas.map((m) => [m.uid, m]));
      const headers: MailHeader[] = [];
      for (const uid of batch) {
        const m = byUid.get(uid);
        if (!m) continue;
        if (has(m.flags, '\\Draft') || has(m.flags, '\\Deleted')) continue;
        const ref = { mailbox: opened.path, uidValidity: opened.uidValidity, uid: m.uid };
        const attachments = m.attachments ?? [];
        headers.push({
          id: messageIdOf(ref),
          threadId: threadIdOf(ref, threadRoot(m), threadHome(folders, opened.path)),
          from: m.from[0] ? shownAddress(m.from[0]) : '',
          to: m.to.map(shownAddress),
          subject: m.subject,
          snippet: '',
          date: m.internalDate ?? m.date ?? this.deps.now().toISOString(),
          hasAttachments: attachments.length > 0,
          attachments,
        });
      }
      const nextUid = batch[batch.length - 1] ?? cursor.lastUid;
      return {
        cursor: { kind: 'imap', mailbox: opened.path, uidValidity: opened.uidValidity, lastUid: nextUid },
        headers,
      };
    });
  }

  /**
   * Opens a long-lived IMAP IDLE session on INBOX when the server advertises IDLE, calling `onExists` whenever new
   * mail arrives. Returns `'unsupported'` when the server does not support IDLE so the watcher falls back to polling.
   */
  async watchInbox(
    token: string,
    onExists: () => void,
    signal: AbortSignal,
  ): Promise<'idle' | 'unsupported'> {
    const account = await this.deps.account(token);
    let session: ImapSession;
    try {
      session = await this.deps.connector.imap(account);
    } catch (err) {
      throw await this.failure(token, err);
    }
    try {
      if (!session.capabilities.has('IDLE') || !session.idle) return 'unsupported';
      const folders = await session.list();
      const inbox = folderByRole(folders, 'inbox');
      await session.open(inbox?.path ?? 'INBOX', { write: false });
      await session.idle(onExists, signal);
      return 'idle';
    } catch (err) {
      throw await this.failure(token, err);
    } finally {
      await session.close();
    }
  }

  /* Checks ----------------------------------------------------------------------------------------- */

  /** Both sides (CM-22): IMAP sign-in and LIST, then SMTP EHLO and AUTH. Never throws. */
  async checkService(token: string, service: ConnectorService): Promise<ConnectionCheck> {
    if (service !== 'mail') return { service, state: 'error', message: IMAP_ONLY_MAIL_TEXT };
    try {
      const account = await this.deps.account(token);
      const failure = await checkMailAccount(this.deps.connector, account);
      if (failure?.side === 'imap' && failure.reason === 'refused') await this.deps.refused(token);
      return failure
        ? { service, state: 'error', message: failure.message.slice(0, 500), side: failure.side }
        : { service, state: 'ok' };
    } catch (err) {
      if (err instanceof ConnectionUnavailableError)
        return { service, state: 'error', message: NEEDS_PASSWORD_TEXT };
      return {
        service,
        state: 'error',
        message: 'Whombat couldn’t check this mail account. Try again in a moment.',
      };
    }
  }

  /* Not mail ----------------------------------------------------------------------------------------- */

  private notMail(): never {
    throw badRequest(IMAP_ONLY_MAIL_TEXT);
  }
  async filesDownload(): Promise<never> {
    return this.notMail();
  }
  async filesOrganize(): Promise<never> {
    return this.notMail();
  }
  async calendarEvents(): Promise<never> {
    return this.notMail();
  }
  async calendarGetEvent(): Promise<never> {
    return this.notMail();
  }
  async calendarCreateEvent(): Promise<never> {
    return this.notMail();
  }
  async calendarUpdateEvent(): Promise<never> {
    return this.notMail();
  }
  async calendarDeleteEvent(): Promise<never> {
    return this.notMail();
  }
  async filesSearch(): Promise<never> {
    return this.notMail();
  }
  async filesGet(): Promise<never> {
    return this.notMail();
  }
  async filesRead(): Promise<never> {
    return this.notMail();
  }
  async filesCreate(): Promise<never> {
    return this.notMail();
  }
  async filesShare(): Promise<never> {
    return this.notMail();
  }
  async filesTrash(): Promise<never> {
    return this.notMail();
  }
  async docsEdit(): Promise<never> {
    return this.notMail();
  }
  async sheetsRead(): Promise<never> {
    return this.notMail();
  }
  async sheetsWrite(): Promise<never> {
    return this.notMail();
  }
  async contactsSearch(): Promise<never> {
    return this.notMail();
  }
}

/**
 * Signs in to both sides of an account (CM-22): IMAP (LOGIN or AUTHENTICATE, then LIST), then SMTP (EHLO, AUTH). The
 * first side that fails, as a `MailError`; null when both work.
 */
export async function checkMailAccount(
  connector: MailConnector,
  account: ImapAccount,
): Promise<MailError | null> {
  const asMailError = (err: unknown, side: 'imap' | 'smtp', host: string, port: number) =>
    err instanceof MailError ? err : new MailError(side, 'protocol', host, port);
  try {
    const session = await connector.imap(account);
    try {
      await session.list();
    } finally {
      await session.close();
    }
  } catch (err) {
    return asMailError(err, 'imap', account.imap.host, account.imap.port);
  }
  try {
    await connector.smtpVerify(account);
  } catch (err) {
    return asMailError(err, 'smtp', account.smtp.host, account.smtp.port);
  }
  return null;
}
