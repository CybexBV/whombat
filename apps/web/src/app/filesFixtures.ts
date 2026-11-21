/**
 * Files in the fixture worlds (contracts 0.49.0 CT-274…, docs/decisions/files-space.md AP-779): `files.summary`,
 * `files.list`, `files.update` and `files.remove` answered as the runtime does — folders normalized and compared
 * case-insensitively, rename only for saved files, “not found” for anything else — and `files.save` for uploads the fake
 * managed world holds (`world.ts`). Mara owns the burrow, so she may rename, move and remove everything (FS-05).
 *
 * Messages' files (contracts 0.59 CT-312, AP-834): every message read through this layer says of each file whether it is
 * in its conversation's Files (`inFiles`), and `files.save` takes a file of a message read before (an agent's comes into
 * Files, a removed one comes back, one already there is answered as it is).
 *
 * Seeded only when asked (`files: true`, or `VITE_FIXTURE_FILES=1`): PR #482's branch room with a SketchUp model in
 * Drawings, a PDF in Drawings/2024, a CSV and Mara's brief on her 11:20 message; Mara's Chat with the agent's moodboard,
 * a screenshot in a thread and Mara's notes. Those messages carry their files, and Mara's 11:30 in the branch room a
 * screenshot and a zip nobody saved yet. Unseeded, every space starts empty, so the sidebar has no Files row and the mock's screens stay
 * as drawn. Bytes are `blob:` URLs made in the page (fixture mode loads attachments by URL).
 */
import {
  type Attachment,
  type FileEntry,
  type FilesSummaryEntry,
  normalizeFilesFolder,
  safeDisplayName,
} from '@whombat/core';
import { burrow, mara } from '@whombat/fixtures';
import { WHOMBAT_ID } from './oneFixtures';
import { brandSheetPdf, fixtureAttachment, swatchSvg } from './richFixtures';

const API = '/api/v1';

/** Before the seed clock (11:22 in Amsterdam on Wednesday 23 September 2026). */
const at = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 8, day, (h ?? 0) - 2, m ?? 0)).toISOString();
};

interface Stored {
  attachment: Attachment;
  conversationId: string;
  folder: string;
  uploadedById: string;
  addedAt: string;
  messageId: string | null;
  threadRootId: string | null;
}

function seedFiles(): Stored[] {
  const skp = fixtureAttachment(
    'att_files-skp',
    '1904Technischmodel.skp',
    'application/octet-stream',
    'file',
    'SKP',
  );
  return [
    {
      attachment: { ...skp, size: 142_606_336 },
      conversationId: 'cnv_pr482',
      folder: 'Drawings',
      uploadedById: mara.id,
      addedAt: at(23, '10:58'),
      messageId: null,
      threadRootId: null,
    },
    {
      attachment: fixtureAttachment(
        'att_files-pool',
        'pool-section.pdf',
        'application/pdf',
        'document',
        brandSheetPdf(),
      ),
      conversationId: 'cnv_pr482',
      folder: 'Drawings/2024',
      uploadedById: mara.id,
      addedAt: at(22, '16:40'),
      messageId: null,
      threadRootId: null,
    },
    {
      attachment: fixtureAttachment(
        'att_files-brief',
        'invoice-pdf-brief.pdf',
        'application/pdf',
        'document',
        brandSheetPdf(),
      ),
      conversationId: 'cnv_pr482',
      folder: '',
      uploadedById: mara.id,
      addedAt: at(23, '11:20'),
      messageId: 'msg_pr482-mara-1120',
      threadRootId: null,
    },
    {
      attachment: fixtureAttachment(
        'att_files-checkout',
        'checkout-before.svg',
        'image/svg+xml',
        'file',
        swatchSvg('#7d6353', 'Checkout, before'),
        { width: 480, height: 360 },
      ),
      conversationId: 'cnv_dm-dusty',
      folder: '',
      uploadedById: WHOMBAT_ID,
      addedAt: at(23, '09:44'),
      messageId: 'msg_dm-dusty-dusty-0944',
      threadRootId: 'msg_dm-dusty-dusty-0941',
    },
    {
      attachment: fixtureAttachment(
        'att_files-csv',
        'invoices-q3.csv',
        'text/csv',
        'text',
        'number,customer,total\n1041,Bakkerij Smit,€ 1.240,00\n1042,Fietsenmaker,€ 380,50\n',
      ),
      conversationId: 'cnv_pr482',
      folder: '',
      uploadedById: mara.id,
      addedAt: at(21, '14:05'),
      messageId: null,
      threadRootId: null,
    },
    {
      attachment: fixtureAttachment(
        'att_files-moodboard',
        'moodboard.svg',
        'image/svg+xml',
        'file',
        swatchSvg('#e0b75e', 'Moodboard'),
        { width: 480, height: 360 },
      ),
      conversationId: 'cnv_dm-dusty',
      folder: '',
      uploadedById: WHOMBAT_ID,
      addedAt: at(23, '11:04'),
      messageId: 'msg_dm-dusty-dusty-1404',
      threadRootId: null,
    },
    {
      attachment: fixtureAttachment(
        'att_files-notes',
        'notes.md',
        'text/markdown',
        'text',
        '# Notes\n\n- Coin gold\n',
      ),
      conversationId: 'cnv_dm-dusty',
      folder: 'Research',
      uploadedById: mara.id,
      addedAt: at(22, '09:30'),
      messageId: null,
      threadRootId: null,
    },
  ];
}

/**
 * Files on messages that aren't in Files (AP-834): Mara's 11:30 in PR #482's room posts a screenshot and the fonts as
 * a zip; nobody has saved them yet.
 */
function seedUnsaved(): { messageId: string; attachment: Attachment }[] {
  return [
    {
      messageId: 'msg_pr482-mara-1130',
      attachment: fixtureAttachment(
        'att_files-checkout-after',
        'checkout-after.svg',
        'image/svg+xml',
        'file',
        swatchSvg('#3e7b58', 'Checkout, after'),
        { width: 480, height: 360 },
      ),
    },
    {
      messageId: 'msg_pr482-mara-1130',
      attachment: {
        ...fixtureAttachment('att_files-fonts', 'invoice-fonts.zip', 'application/zip', 'file', 'PK'),
        size: 1_843_200,
      },
    },
  ];
}

/** A file on a message, as a read of that message showed it (Save to Files takes it from here). */
interface OnMessage {
  attachment: Attachment;
  conversationId: string;
  messageId: string;
  threadRootId: string | null;
  /** The message as last read, its files' `inFiles` as they were then. */
  message: MessageLike;
}

/** What this layer reads and marks of a message. */
export interface MessageLike {
  id: string;
  conversationId: string;
  threadRootId: string | null;
  attachments: Attachment[];
}

/** A stored file as Files lists it (FS-05): rename is for files saved straight into Files (CT-1585). */
function entryOf(s: Stored): FileEntry {
  return { ...s };
}

const byNewest = (a: { addedAt: string }, b: { addedAt: string }) =>
  Date.parse(b.addedAt) - Date.parse(a.addedAt);

export interface FilesWorld {
  summary(): FilesSummaryEntry[];
  list(conversationId: string): FileEntry[];
  /** An upload into Files (`files.save`): its conversation is where it was reserved. */
  save(attachment: Attachment, conversationId: string, folder: string, by: string): FileEntry;
  find(attachmentId: string): Stored | undefined;
  /**
   * A message as read (AP-834): its seeded files added, each file known for Save to Files and marked `inFiles`. Changes
   * `message` in place and returns it.
   */
  mark<M extends MessageLike>(message: M): M;
  /** A person's upload sent on a message: in Files with its message, as the runtime keeps people's files. */
  sent(attachment: Attachment, message: MessageLike, by: string): void;
  /**
   * Save to Files on a message's file (`files.save`, CT-312): into Files (`added`), or as it is when it is there
   * already; null for a file no message read here carried.
   */
  saveFromMessage(attachmentId: string, by: string): { file: FileEntry; added: boolean } | null;
  /** The message a file was read on, marked as things are now (for `message.updated`). */
  messageOf(attachmentId: string): MessageLike | null;
  update(
    attachmentId: string,
    change: { name?: string; folder?: string },
  ): FileEntry | { refused: string; status: number };
  remove(attachmentId: string): boolean;
}

export function createFilesWorld({ seed = false }: { seed?: boolean } = {}): FilesWorld {
  const files: Stored[] = seed ? seedFiles() : [];
  const find = (id: string) => files.find((f) => f.attachment.id === id);
  /** The seed's messages carry their files: those in Files and the ones nobody saved (message id → files). */
  const seeded = new Map<string, Attachment[]>();
  if (seed)
    for (const f of [...files, ...seedUnsaved()])
      if (f.messageId) seeded.set(f.messageId, [...(seeded.get(f.messageId) ?? []), f.attachment]);
  /** Every file a message read here carried. */
  const onMessages = new Map<string, OnMessage>();
  const mark = <M extends MessageLike>(m: M): M => {
    const extra = (seeded.get(m.id) ?? []).filter((a) => !m.attachments.some((b) => b.id === a.id));
    m.attachments = [...m.attachments, ...extra].map((a) => {
      const { inFiles: _, ...attachment } = a;
      onMessages.set(a.id, {
        attachment,
        conversationId: m.conversationId,
        messageId: m.id,
        threadRootId: m.threadRootId,
        message: m,
      });
      return { ...attachment, inFiles: !!find(a.id) };
    });
    return m;
  };
  const putMessageFile = (on: OnMessage, by: string): Stored => {
    const stored: Stored = {
      attachment: on.attachment,
      conversationId: on.conversationId,
      folder: '',
      uploadedById: by,
      addedAt: new Date().toISOString(),
      messageId: on.messageId,
      threadRootId: on.threadRootId,
    };
    files.push(stored);
    return stored;
  };
  return {
    mark,
    sent(attachment, message, by) {
      const on = {
        attachment,
        conversationId: message.conversationId,
        messageId: message.id,
        threadRootId: message.threadRootId,
        message,
      };
      onMessages.set(attachment.id, on);
      if (!find(attachment.id)) putMessageFile(on, by);
    },
    saveFromMessage(attachmentId, by) {
      const there = find(attachmentId);
      if (there) return { file: entryOf(there), added: false };
      const on = onMessages.get(attachmentId);
      if (!on) return null;
      return { file: entryOf(putMessageFile(on, by)), added: true };
    },
    messageOf(attachmentId) {
      const on = onMessages.get(attachmentId);
      return on ? mark({ ...on.message, attachments: [...on.message.attachments] }) : null;
    },
    summary() {
      const by = new Map<string, FilesSummaryEntry>();
      for (const f of files) {
        const s = by.get(f.conversationId) ?? {
          conversationId: f.conversationId,
          count: 0,
          bytes: 0,
          lastAddedAt: f.addedAt,
        };
        s.count += 1;
        s.bytes += f.attachment.size;
        if (Date.parse(f.addedAt) > Date.parse(s.lastAddedAt)) s.lastAddedAt = f.addedAt;
        by.set(f.conversationId, s);
      }
      return [...by.values()].sort((a, b) => Date.parse(b.lastAddedAt) - Date.parse(a.lastAddedAt));
    },
    list(conversationId) {
      return files
        .filter((f) => f.conversationId === conversationId)
        .sort(byNewest)
        .map(entryOf);
    },
    save(attachment, conversationId, folder, by) {
      const stored: Stored = {
        attachment,
        conversationId,
        folder,
        uploadedById: by,
        addedAt: new Date().toISOString(),
        messageId: null,
        threadRootId: null,
      };
      files.push(stored);
      return entryOf(stored);
    },
    find,
    update(attachmentId, change) {
      const f = find(attachmentId);
      if (!f) return { refused: 'That file isn’t here.', status: 404 };
      if (change.name !== undefined) {
        if (f.messageId) return { refused: 'A message’s file keeps the name it was sent with.', status: 403 };
        f.attachment = { ...f.attachment, name: safeDisplayName(change.name) };
      }
      if (change.folder !== undefined) {
        const folder = normalizeFilesFolder(change.folder);
        if (folder === null || folder !== change.folder)
          return {
            refused: 'Folder names are up to 4 levels of 1–64 characters, without . or ..',
            status: 400,
          };
        // Folders compare case-insensitively: the spelling the space already has wins.
        const known = files.map((x) => x.folder).find((x) => x.toLowerCase() === folder.toLowerCase());
        f.folder = known ?? folder;
      }
      return entryOf(f);
    },
    remove(attachmentId) {
      const i = files.findIndex((f) => f.attachment.id === attachmentId);
      if (i < 0) return false;
      files.splice(i, 1);
      return true;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A message in an answer (`messages.list`, `messages.thread`, `messages.get`, pins, a send). */
function isMessage(m: unknown): m is MessageLike {
  return (
    !!m &&
    typeof m === 'object' &&
    typeof (m as MessageLike).id === 'string' &&
    typeof (m as MessageLike).conversationId === 'string' &&
    Array.isArray((m as MessageLike).attachments)
  );
}

/** Every message an answer holds, marked by `world` (AP-834); other answers as they are. */
export async function markMessageFiles(
  req: Request,
  response: Response,
  world: FilesWorld,
): Promise<Response> {
  const path = new URL(req.url, 'http://fixtures.local').pathname;
  if (!response.ok || !/\/(messages|pins)(\/|$)/.test(path)) return response;
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  const body = (await response.clone().json()) as Record<string, unknown>;
  const all = [
    body.message,
    body.root,
    ...[body.messages, body.replies].flatMap((l) => (Array.isArray(l) ? l : [])),
  ];
  const messages = all.filter(isMessage);
  if (!messages.length) return response;
  for (const m of messages) world.mark(m);
  return json(body, response.status);
}

const refusal = (status: number, message: string) =>
  json(
    {
      error: {
        code: status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'validation_failed',
        message,
      },
    },
    status,
  );

/** The REST side over `world`: null for anything that isn't a Files route. */
export async function handleFilesRequest(req: Request, world: FilesWorld): Promise<Response | null> {
  const url = new URL(req.url, 'http://fixtures.local');
  const path = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : url.pathname;
  const prefix = `/burrows/${burrow.slug}`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (req.method === 'GET' && rest === '/files') return json({ conversations: world.summary() });
  const list = /^\/conversations\/([^/]+)\/files$/.exec(rest);
  if (req.method === 'GET' && list) {
    const all = world.list(decodeURIComponent(list[1] ?? ''));
    const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 100) || 100);
    const start = Number(url.searchParams.get('cursor') ?? 0) || 0;
    const page = all.slice(start, start + limit);
    return json({ files: page, nextCursor: start + limit < all.length ? String(start + limit) : null });
  }
  if (req.method === 'POST' && rest === '/files') {
    // A message's file (CT-312): the fixture world holds no unsent uploads (the fake managed world answers those).
    const body = (await req.json().catch(() => ({}))) as { attachmentId?: string };
    const saved = body.attachmentId ? world.saveFromMessage(body.attachmentId, mara.id) : null;
    return saved ? json({ file: saved.file }) : refusal(404, 'That upload isn’t here.');
  }
  const one = /^\/files\/([^/]+)$/.exec(rest);
  if (one) {
    const id = decodeURIComponent(one[1] ?? '');
    if (req.method === 'PATCH') {
      const body = (await req.json()) as { name?: string; folder?: string };
      const r = world.update(id, body);
      return 'refused' in r ? refusal(r.status, r.refused) : json({ file: r });
    }
    if (req.method === 'DELETE')
      return world.remove(id) ? json({ ok: true }) : refusal(404, 'That file isn’t here.');
  }
  return null;
}
