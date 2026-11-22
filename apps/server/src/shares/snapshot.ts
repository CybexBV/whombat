/**
 * The copy a link shows (docs/decisions/share-links.md): a thread of the person's Chat, from its first message or one of
 * its messages on, as readers see it — the person's and the assistant's words, their pictures when the person keeps
 * them, the charts and pages the assistant drew. Never cards (approvals, plans, runs), “More detail”, link previews,
 * other files, messages of outsiders or of automations, nor anything a turn did (commands and their output aren't in
 * messages at all).
 */
import type { SharePreview } from '@whombat/core';
import {
  SHARE_MAX_ENVELOPE_BYTES,
  SHARE_MAX_MESSAGES,
  SHARE_MAX_PAGE_CHARS,
  SHARE_MAX_PICTURES,
  SHARE_MAX_TEXT_CHARS,
  type SharedMessage,
  type SharedPicture,
  type SharedSnapshot,
  shareToBase64url,
} from '@whombat/core/share';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { threadTitleOf } from '../backups/look/titles';
import { chatRoomOf } from '../chats/rooms';
import type { Db, Tx } from '../db/client';
import { attachments, conversations, messages, principals } from '../db/schema/index';
import type { FileStore } from '../files/store';
import { notFound } from '../lib/errors';
import { shareWarnings } from './warnings';

const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** A picture larger than this stays out (it wouldn't leave room for anything else). */
const PICTURE_MAX_BYTES = 4 * 1024 * 1024;
/** Sealing adds the magic, the nonce and the tag. */
const SEAL_OVERHEAD = 4 + 24 + 16;

type MessageRow = typeof messages.$inferSelect;
type AttachmentRow = typeof attachments.$inferSelect;

export interface ShareThread {
  conversationId: string;
  rootId: string;
  title: string;
  person: { name: string };
  assistant: { name: string; face?: string };
  /** The messages a link shows, oldest first, with their pictures and pages. */
  shown: {
    row: MessageRow;
    from: 'person' | 'assistant';
    pictures: AttachmentRow[];
    pages: AttachmentRow[];
  }[];
  /** Things in those messages a link never shows (cards, details, other files), and messages left out entirely. */
  leftOut: number;
}

const firstName = (p: { shortName: string | null; name: string }) =>
  (p.shortName ?? p.name).trim().split(/\s+/)[0] || p.name;

/**
 * The thread `rootId` of `personId`'s Chat, from `fromMessageId` on. Only the person's own Chat: the Feedback room holds
 * outsiders' reports, which are not the person's to pass on.
 */
export async function loadShareThread(
  db: Db | Tx,
  burrowId: string,
  personId: string,
  scope: { rootId: string; fromMessageId?: string | undefined },
): Promise<ShareThread> {
  const [root] = await db.select().from(messages).where(eq(messages.id, scope.rootId));
  if (!root || root.burrowId !== burrowId || root.threadRootId !== null || root.deletedAt)
    throw notFound('Thread');
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, root.conversationId));
  if (!conv || chatRoomOf(conv) !== 'chat' || conv.dmPersonId !== personId) throw notFound('Thread');
  const rows = await db
    .select()
    .from(messages)
    .where(or(eq(messages.id, root.id), eq(messages.threadRootId, root.id)))
    .orderBy(asc(messages.createdAt), asc(messages.ord));
  let from = 0;
  if (scope.fromMessageId) {
    from = rows.findIndex((r) => r.id === scope.fromMessageId);
    if (from < 0) throw notFound('Message');
  }
  const inScope = rows.slice(from);
  const authorIds = [...new Set(inScope.map((r) => r.authorId))];
  const authors = authorIds.length
    ? await db.select().from(principals).where(inArray(principals.id, authorIds))
    : [];
  const byId = new Map(authors.map((a) => [a.id, a]));
  const [person] = await db.select().from(principals).where(eq(principals.id, personId));
  const [agent] = conv.dmAgentId
    ? await db.select().from(principals).where(eq(principals.id, conv.dmAgentId))
    : [];
  const ids = inScope.map((r) => r.id);
  const files = ids.length
    ? await db
        .select()
        .from(attachments)
        .where(and(inArray(attachments.messageId, ids), eq(attachments.state, 'ready')))
    : [];
  let leftOut = 0;
  const shown: ShareThread['shown'] = [];
  for (const row of inScope) {
    const author = byId.get(row.authorId);
    const from =
      author?.id === personId
        ? 'person'
        : author?.id === conv.dmAgentId && author.kind === 'agent'
          ? 'assistant'
          : null;
    // Outsiders' words (a Feedback assessment's, an outsiders' run's), automations and Whombat's own lines aren't the
    // person's to pass on.
    if (!from || row.deletedAt || row.provenance || row.outsidersRun) {
      if (!row.deletedAt) leftOut++;
      continue;
    }
    const mine = files.filter((f) => f.messageId === row.id || row.attachmentIds?.includes(f.id));
    const pictures = mine.filter((f) => PICTURE_TYPES.has(f.contentType) && f.size <= PICTURE_MAX_BYTES);
    const pages = from === 'assistant' ? mine.filter((f) => f.contentType.startsWith('text/html')) : [];
    leftOut += mine.length - pictures.length - pages.length;
    if (row.card) leftOut++;
    if (row.more) leftOut++;
    if (!row.text.trim() && pictures.length === 0 && pages.length === 0) continue;
    shown.push({ row, from, pictures, pages });
  }
  if (shown.length > SHARE_MAX_MESSAGES) {
    leftOut += shown.length - SHARE_MAX_MESSAGES;
    shown.splice(SHARE_MAX_MESSAGES);
  }
  return {
    conversationId: conv.id,
    rootId: root.id,
    title:
      root.outsidersRun || root.provenance
        ? threadTitleOf(shown[0]?.row.text ?? '', null).slice(0, 200)
        : threadTitleOf(root.text, root.subjectName ?? null).slice(0, 200),
    person: { name: person ? firstName(person) : 'Someone' },
    assistant: {
      name: agent ? (agent.shortName ?? agent.name) : 'Whombat',
      ...(agent?.agentFace ? { face: agent.agentFace } : {}),
    },
    shown,
    leftOut,
  };
}

async function readAll(store: FileStore, key: string | null): Promise<Buffer | null> {
  if (!key) return null;
  const stream = await store.open(key);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** The copy itself, and its size once sealed. Pictures only with `pictures`; a page too big to draw stays out. */
export async function buildSnapshot(
  thread: ShareThread,
  store: FileStore,
  options: { pictures: boolean; now: Date },
): Promise<{ snapshot: SharedSnapshot; sealedBytes: number; pictures: number }> {
  const pictures: SharedPicture[] = [];
  const shown: SharedMessage[] = [];
  for (const m of thread.shown) {
    const ids: string[] = [];
    if (options.pictures) {
      for (const p of m.pictures) {
        if (pictures.length >= SHARE_MAX_PICTURES) break;
        const bytes = await readAll(store, p.blobKey);
        if (!bytes) continue;
        const id = `p${pictures.length + 1}`;
        pictures.push({
          id,
          mime: p.contentType as SharedPicture['mime'],
          data: shareToBase64url(bytes),
          name: p.name.slice(0, 200),
        });
        ids.push(id);
      }
    }
    const pages: NonNullable<SharedMessage['pages']> = [];
    for (const page of m.pages.slice(0, 8)) {
      const bytes = await readAll(store, page.blobKey);
      const html = bytes?.toString('utf8');
      if (html && html.length <= SHARE_MAX_PAGE_CHARS) pages.push({ title: page.name.slice(0, 200), html });
    }
    const text = m.row.text.slice(0, SHARE_MAX_TEXT_CHARS);
    if (!text.trim() && ids.length === 0 && pages.length === 0) continue;
    shown.push({
      from: m.from,
      at: m.row.createdAt.getTime(),
      text,
      ...(ids.length ? { pictures: ids } : {}),
      ...(pages.length ? { pages } : {}),
    });
  }
  const snapshot: SharedSnapshot = {
    v: 1,
    title: thread.title || 'A conversation',
    sharedAt: options.now.getTime(),
    person: thread.person,
    assistant: thread.assistant,
    messages: shown,
    pictures,
  };
  const sealedBytes = Buffer.byteLength(JSON.stringify(snapshot)) + SEAL_OVERHEAD;
  return { snapshot, sealedBytes, pictures: pictures.length };
}

/** Whether a copy of this size fits at control. */
export const fitsAtControl = (sealedBytes: number) => sealedBytes <= SHARE_MAX_ENVELOPE_BYTES;

/** The Share sheet's summary: counts, what is left out, warnings and whether it fits, with and without pictures. */
export async function previewOf(thread: ShareThread, store: FileStore, now: Date): Promise<SharePreview> {
  const withPictures = await buildSnapshot(thread, store, { pictures: true, now });
  const withoutPictures = await buildSnapshot(thread, store, { pictures: false, now });
  return {
    title: thread.title || 'A conversation',
    messages: withoutPictures.snapshot.messages.length,
    pictures: thread.shown.reduce((n, m) => n + m.pictures.length, 0),
    pages: withoutPictures.snapshot.messages.reduce((n, m) => n + (m.pages?.length ?? 0), 0),
    leftOut: thread.leftOut,
    warnings: shareWarnings(thread.shown.map((m) => m.row.text)),
    fits: {
      withPictures: fitsAtControl(withPictures.sealedBytes),
      withoutPictures: fitsAtControl(withoutPictures.sealedBytes),
    },
  };
}
