/**
 * Messages (`messages.jsonl`, BF-05): the conversations the maker may read — a `conversation` record each, then its
 * messages oldest first (thread roots before their replies) with their files' details, reactions, pin and link previews
 * — and the canvases in them as Yjs state (`canvases/<id>.yjs`). A file's bytes come with the Files category. Since 0.117
 * (BF-19, BF-20) a task chat's and the Feedback room's key, title and subject, a thread's subject and its choice of what
 * answers, and canvases' side comments; messages whose files stay out without Files are counted for the preview.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BackupMessagesLine } from '@whombat/core';
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import {
  attachments,
  canvasComments,
  canvases,
  chatThreadRuntimes,
  conversations,
  messages,
  principals,
  reactions,
} from '../../db/schema/index';
import { iso } from '../../lib/time';
import { Spool } from '../spool';
import type { CategoryOut, CollectOut, CollectScope } from './scope';

const rec = (v: BackupMessagesLine) => v as BackupMessagesLine & { type: string } & Record<string, unknown>;

/** Messages read per query. */
const PAGE = 500;

export async function collectMessages(scope: CollectScope, out: CategoryOut, all: CollectOut): Promise<void> {
  const { db, burrow, services, source } = scope;
  const ids = [...scope.readable];
  const convs = ids.length
    ? await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.burrowId, burrow.id), inArray(conversations.id, ids)))
        .orderBy(asc(conversations.kind), asc(conversations.position), asc(conversations.createdAt))
    : [];
  const withFiles = scope.categories.has('files');
  const names = new Map<string, string>();
  const nameOf = async (id: string) => {
    if (!names.has(id)) {
      const [row] = await db.select({ name: principals.name }).from(principals).where(eq(principals.id, id));
      names.set(id, (row?.name ?? 'Someone').slice(0, 200) || 'Someone');
    }
    return names.get(id) as string;
  };

  // Messages whose files stay out because Files isn't in the file (BF-19, BF-S12: said in the restore preview).
  let withoutFiles = 0;
  for (const c of convs) {
    const chatSubject = subjectOf(c.chatSubjectKind, c.chatSubjectId, c.chatSubjectName);
    out.ref(c.id, c.repoId, c.dmPersonId, subjectRef(chatSubject));
    await out.record(
      rec({
        type: 'conversation',
        id: c.id,
        kind: c.kind,
        slug: (c.slug || c.id).slice(0, 200),
        title: (c.title || c.slug || c.id).slice(0, 200),
        topic: (c.topic ?? '').slice(0, 500),
        // A person's room with the agent: whose (one-agent.md OA-04).
        dm: c.kind === 'dm' && c.dmPersonId ? { person: c.dmPersonId } : null,
        linkPreviews: c.linkPreviews ?? null,
        repo: c.repoId ?? null,
        prNumber: c.prNumber ?? null,
        archived: false,
        // A task chat or the Feedback room as it was (BF-19, BF-S13).
        taskKey: c.taskKey ?? null,
        chatTitle: c.chatTitle ? c.chatTitle.slice(0, 200) : null,
        chatSubject,
        chatArchivedAt: c.chatArchivedAt ? iso(c.chatArchivedAt) : null,
        createdAt: iso(c.createdAt),
      }),
    );

    let after = -1;
    for (;;) {
      const page = await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, c.id), gt(messages.ord, after)))
        .orderBy(asc(messages.ord))
        .limit(PAGE);
      if (page.length === 0) break;
      after = page[page.length - 1]?.ord ?? after;
      const msgIds = page.map((m) => m.id);
      const reacts = await db.select().from(reactions).where(inArray(reactions.messageId, msgIds));
      const files = await db
        .select()
        .from(attachments)
        .where(and(inArray(attachments.messageId, msgIds), eq(attachments.state, 'ready')));
      for (const m of page) {
        // A deleted message without replies is gone; a deleted thread root stays as a tombstone for its replies.
        if (m.deletedAt && m.replyCount === 0) continue;
        const byValue = new Map<string, string[]>();
        for (const r of reacts)
          if (r.messageId === m.id) byValue.set(r.value, [...(byValue.get(r.value) ?? []), r.principalId]);
        const own = m.deletedAt
          ? []
          : files.filter((f) => f.messageId === m.id && f.sha256 && f.blobKey).slice(0, 10);
        if (!withFiles && own.length) withoutFiles++;
        if (withFiles)
          for (const f of own) {
            const key = f.blobKey as string;
            out.blob({
              sha256: f.sha256 as string,
              size: f.size,
              open: async () => {
                const s = await source.openBlob(key);
                if (!s) throw new Error('a file’s bytes are missing from the file store');
                return s;
              },
            });
          }
        const reactionList = [...byValue.entries()]
          .slice(0, 100)
          .map(([value, by]) => ({ value, by: by.slice(0, 500) }));
        const subject = subjectOf(m.subjectKind, m.subjectId, m.subjectName);
        out.ref(
          m.authorId,
          ...m.mentions,
          m.pinnedById,
          ...reactionList.flatMap((r) => r.by),
          subjectRef(subject),
        );
        await out.record(
          rec({
            type: 'message',
            id: m.id,
            conversation: c.id,
            author: m.authorId,
            authorName: await nameOf(m.authorId),
            createdAt: iso(m.createdAt),
            editedAt: m.editedAt ? iso(m.editedAt) : null,
            text: m.deletedAt ? '' : m.text,
            mentions: m.mentions.slice(0, 200),
            card: m.deletedAt ? null : ((m.card as unknown as Record<string, never> | null) ?? null),
            suggestions: (m.suggestions ?? []).slice(0, 10),
            threadRoot: m.threadRootId ?? null,
            attachments: own.map((f) => ({
              id: f.id,
              name: f.name.slice(0, 255),
              contentType: f.contentType,
              kind: f.kind,
              size: f.size,
              sha256: f.sha256 as string,
              width: f.width ?? null,
              height: f.height ?? null,
              folder: f.filedAt && !f.filesRemovedAt ? f.folder : null,
            })),
            reactions: reactionList,
            pinned: m.pinnedAt && m.pinnedById ? { at: iso(m.pinnedAt), by: m.pinnedById } : null,
            deleted: !!m.deletedAt,
            provenance: m.provenance ?? null,
            outsidersRun: m.outsidersRun,
            previews: m.previews ? (m.previews.slice(0, 3) as unknown as Record<string, never>[]) : null,
            subject,
          }),
        );
      }
      if (page.length < PAGE) break;
    }

    // Its Chat threads' choices of what answers (BF-20, BF-S14), after their first messages.
    const choices = await db
      .select()
      .from(chatThreadRuntimes)
      .where(eq(chatThreadRuntimes.conversationId, c.id))
      .orderBy(asc(chatThreadRuntimes.setAt));
    for (const t of choices) {
      out.ref(t.setById);
      await out.record(
        rec({
          type: 'chat_thread_runtime',
          root: t.rootId,
          conversation: c.id,
          runtime: t.runtime,
          setBy: t.setById,
          setAt: iso(t.setAt),
        }),
      );
    }
  }
  out.note('files_left_out', withoutFiles);

  // Canvases in conversations the maker may read (and those in none), with their whole Yjs state.
  const canvasRows = await db
    .select()
    .from(canvases)
    .where(
      and(
        eq(canvases.burrowId, burrow.id),
        ids.length
          ? or(isNull(canvases.conversationId), inArray(canvases.conversationId, ids))
          : isNull(canvases.conversationId),
      ),
    )
    .orderBy(asc(canvases.createdAt));
  for (const cv of canvasRows) {
    let ydoc: { sha256: string; size: number } | null = null;
    try {
      const state = await source.canvasState(cv);
      const spool = await Spool.create(join(scope.scratch, `canvas-${cv.id}`));
      await spool.write(state);
      await spool.close();
      all.canvases.set(cv.id, spool);
      ydoc = { sha256: createHash('sha256').update(state).digest('hex'), size: state.length };
      out.bytes += state.length;
    } catch (err) {
      services.log.warn(
        { err: String(err), canvasId: cv.id },
        'backup file: a canvas’s state could not be read',
      );
    }
    out.ref(
      cv.id,
      cv.conversationId,
      cv.provenance.createdById,
      cv.provenance.requestedById ?? null,
      ...(cv.provenance.editorIds ?? []),
    );
    const comments = await db
      .select()
      .from(canvasComments)
      .where(eq(canvasComments.canvasId, cv.id))
      .orderBy(asc(canvasComments.createdAt), asc(canvasComments.id));
    await out.record(
      rec({
        type: 'canvas',
        id: cv.id,
        slug: cv.slug.slice(0, 200),
        title: (cv.title || cv.slug).slice(0, 200),
        conversation: cv.conversationId ?? null,
        markdown: (cv.markdown ?? '').slice(0, 1_000_000),
        ydoc,
        provenance: cv.provenance,
        createdAt: iso(cv.createdAt),
        updatedAt: iso(cv.updatedAt),
      }),
    );
    // Its side comments (BF-20, BF-S15), a reply after the comment it answers.
    const authors = new Map<string, string>();
    for (const cm of comments) {
      if (!authors.has(cm.authorId)) authors.set(cm.authorId, await nameOf(cm.authorId));
      out.ref(cm.authorId);
      await out.record(
        rec({
          type: 'canvas_comment',
          id: cm.id,
          canvas: cv.id,
          anchor: cm.anchor ?? null,
          parent: cm.parentId ?? null,
          author: cm.authorId,
          authorName: authors.get(cm.authorId) as string,
          text: cm.text.slice(0, 4000) || '…',
          resolved: cm.resolved,
          createdAt: iso(cm.createdAt),
        }),
      );
    }
  }
}

/** A chat's or a thread's subject in the file (`BackupChatSubject`), or null. */
function subjectOf(
  kind: 'server' | 'connection' | 'device' | null,
  id: string | null,
  name: string | null,
): { kind: 'server' | 'connection' | 'device'; id: string; name: string } | null {
  if (!kind || !id) return null;
  return { kind, id: id.slice(0, 200), name: (name ?? '').slice(0, 120) };
}

/** A connection or device subject is a connection (its directory entry finds it on another box); a server isn't. */
function subjectRef(subject: { kind: string; id: string } | null): string | null {
  return subject && subject.kind !== 'server' && subject.id.startsWith('con_') ? subject.id : null;
}
