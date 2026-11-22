/**
 * Restoring messages (BF-04, BF-07): conversations are found by their key (a branch room by slug, a DM by its agent
 * and person) or made, with nobody to add to them (every conversation is the person's with the agent); messages are matched only by the restore map (or, restoring
 * into the burrow they came from, by their own id), so restoring a file again adds nothing. A restored message keeps its
 * author — mapped by handle or email; someone who isn't here keeps their name, as a person who left does — and its time,
 * thread, reactions, pin and link previews; its files come back when the file holds their bytes. A card about something
 * that didn't come back (a run, a plan) is left out. Canvases come back with their Yjs state.
 */
import { createReadStream, readFileSync } from 'node:fs';
import {
  attachmentUrl,
  type BackupCanvasCommentRecord,
  type BackupCanvasRecord,
  type BackupChatSubject,
  type BackupChatThreadRuntimeRecord,
  type BackupConversationRecord,
  type BackupMessageRecord,
  type BackupMessagesLine,
  type CanvasProvenance,
  type ChatRuntime,
  HUMAN_TONES,
  type JsonObject,
  newId,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { FEEDBACK_ROOM_KEY, FEEDBACK_ROOM_TITLE } from '../../chats/rooms';
import { offeredModelRuntime } from '../../commands/agents';
import {
  accounts,
  attachments,
  canvasComments,
  canvases,
  chatThreadRuntimes,
  conversations,
  messages,
  principals,
  reactions,
} from '../../db/schema/index';
import { insertPerson, insertSystemPrincipal, uniqueHandle } from '../../domain/members';
import { indexCanvas, indexMessage } from '../../domain/search-index';
import { lockBlob } from '../../files/service';
import { blobKey } from '../../files/store';
import { loadAgentRow } from '../../read/principals';
import type { RecordOutcome, RestoreRun } from './run';

export async function restoreMessages(run: RestoreRun, record: BackupMessagesLine): Promise<RecordOutcome> {
  switch (record.type) {
    case 'conversation':
      return conversation(run, record);
    case 'message':
      return message(run, record);
    case 'canvas':
      return canvas(run, record);
    case 'chat_thread_runtime':
      return threadRuntime(run, record);
    case 'canvas_comment':
      return canvasComment(run, record);
  }
}

async function conversation(run: RestoreRun, r: BackupConversationRecord): Promise<RecordOutcome> {
  const here = await run.resolve(r.id);
  if (here) return 'detail';
  if (run.dry) {
    run.remember(r.id, run.standIn(r.id), 'conversation');
    return 'detail';
  }
  if (r.kind === 'dm') {
    // A person's room with this Whombat's agent (one-agent.md OA-04).
    const agent = (await loadAgentRow(run.tx, run.burrow.id))?.id ?? null;
    const person = r.dm ? await run.resolve(r.dm.person) : null;
    // A DM needs both of them here; without them its messages have nowhere to go.
    if (!agent || !person || run.isStandIn(agent) || run.isStandIn(person)) return 'detail';
    const id = newId('conversation');
    const [a] = await run.tx
      .select({ handle: principals.handle, name: principals.name })
      .from(principals)
      .where(eq(principals.id, agent));
    const [p] = await run.tx
      .select({ handle: principals.handle })
      .from(principals)
      .where(eq(principals.id, person));
    // A task chat or the Feedback room comes back as it was (BF-19, BF-S13): its key, title, subject and archive; a
    // DM is titled with its agent's name here, as every DM is.
    const subject = r.chatSubject ? await subjectHere(run, r.chatSubject) : null;
    const feedback = r.taskKey === FEEDBACK_ROOM_KEY;
    await run.tx.insert(conversations).values({
      id,
      burrowId: run.burrow.id,
      kind: 'dm',
      slug: r.taskKey
        ? `${a?.handle ?? 'agent'}--${p?.handle ?? 'person'}--${r.taskKey}`.slice(0, 200)
        : `dm-${a?.handle ?? 'agent'}-${id.slice(4, 10).toLowerCase()}`,
      title: a?.name ?? r.title,
      dmAgentId: agent,
      dmPersonId: person,
      taskKey: r.taskKey,
      chatTitle: feedback ? FEEDBACK_ROOM_TITLE : r.chatTitle,
      chatRetitledAt: feedback ? run.ctx.now : null,
      chatSubjectKind: subject?.kind ?? null,
      chatSubjectId: subject?.id ?? null,
      chatSubjectName: subject?.name ?? null,
      chatArchivedAt: r.chatArchivedAt ? new Date(r.chatArchivedAt) : null,
      createdAt: new Date(r.createdAt),
    });
    run.remember(r.id, id, 'conversation');
    return 'detail';
  }
  // A branch room: its repository's, when that is here.
  const repo = r.repo ? await run.resolve(r.repo) : null;
  if (!repo || run.isStandIn(repo)) return 'detail';
  const id = newId('conversation');
  await run.tx.insert(conversations).values({
    id,
    burrowId: run.burrow.id,
    kind: 'branch',
    slug: r.slug,
    title: r.title,
    topic: r.topic,
    repoId: repo,
    prNumber: r.prNumber,
    createdAt: new Date(r.createdAt),
  });
  run.remember(r.id, id, 'conversation');
  return 'detail';
}

/**
 * The author of a restored message here: mapped by email or handle, else someone who keeps their name — a person who
 * left (tied to their account when they have one here, so being invited back makes them themselves again) or a retired
 * agent. Null when the file doesn't say who it was.
 */
async function authorHere(run: RestoreRun, sourceId: string): Promise<string | null> {
  const found = await run.resolve(sourceId);
  if (found) return found;
  const entry = run.directory.get(sourceId);
  if (!entry || run.dry) {
    if (entry) run.unknownAuthors.add(sourceId);
    return entry ? run.standIn(sourceId) : null;
  }
  run.unknownAuthors.add(sourceId);
  const now = run.ctx.now;
  let id: string;
  if (entry.type === 'person') {
    const [account] = await run.tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`lower(${accounts.email}) = ${entry.email.toLowerCase()}`);
    const [taken] = account
      ? await run.tx
          .select({ id: principals.id })
          .from(principals)
          .where(and(eq(principals.burrowId, run.burrow.id), eq(principals.accountId, account.id)))
      : [];
    id = await insertPerson(run.ctx, {
      burrowId: run.burrow.id,
      name: entry.name,
      email: entry.email.toLowerCase(),
      accountId: account && !taken ? account.id : null,
      tone: HUMAN_TONES[2],
      handle: await uniqueHandle(run.tx, run.burrow.id, entry.handle),
      createdAt: now,
    });
  } else if (entry.type === 'agent') {
    // The file's agent is this Whombat's one agent (one-agent.md OA-01).
    const agent = await loadAgentRow(run.tx, run.burrow.id);
    if (!agent) return null;
    id = agent.id;
  } else if (entry.type === 'system') {
    // One of Whombat's own signers this Whombat doesn't have (OA-17): a stand-in that signs nothing new.
    const made = await insertSystemPrincipal(run.ctx, {
      burrowId: run.burrow.id,
      name: entry.name.slice(0, 80),
      system: entry.system,
      handle: entry.handle,
      createdAt: now,
    });
    id = made.id;
  } else return null;
  run.remember(sourceId, id, 'messages');
  return id;
}

async function message(run: RestoreRun, r: BackupMessageRecord): Promise<RecordOutcome> {
  if (run.mapped(r.id)) return 'unchanged';
  if (run.sameBurrow) {
    const [same] = await run.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, r.id), eq(messages.burrowId, run.burrow.id)));
    if (same) {
      run.remember(r.id, same.id, 'message');
      return 'unchanged';
    }
  }
  const conversationId = await run.resolve(r.conversation);
  if (!conversationId) {
    run.note('missing_reference', 'messages');
    return 'skipped';
  }
  const author = await authorHere(run, r.author);
  if (!author) {
    run.note('missing_reference', 'messages');
    return 'skipped';
  }
  if (run.dry) {
    run.remember(r.id, run.standIn(r.id), 'message');
    return 'added';
  }
  if (run.isStandIn(conversationId) || run.isStandIn(author)) return 'skipped';
  const id = newId('message');
  const createdAt = new Date(r.createdAt);
  const threadRoot = r.threadRoot ? run.mapped(r.threadRoot) : null;
  const mentions = (await run.resolveAll(r.mentions)).ids.filter((m) => !run.isStandIn(m));
  let card: JsonObject | null = null;
  if (r.card) {
    const remapped = await run.remapJson(r.card);
    // A card about something that didn't come back (a run, a plan, an approval) is left out; the text stays.
    card = remapped.missing.length === 0 ? remapped.value : null;
  }
  const files: string[] = [];
  for (const a of r.attachments) {
    const path = run.blobPath(a.sha256);
    if (!path) continue;
    const fileId = newId('attachment');
    await storeBlob(run, a.sha256, a.size, path);
    await run.tx.insert(attachments).values({
      id: fileId,
      burrowId: run.burrow.id,
      conversationId,
      name: a.name,
      contentType: a.contentType,
      kind: a.kind,
      size: a.size,
      sha256: a.sha256,
      blobKey: blobKey(a.sha256),
      width: a.width,
      height: a.height,
      state: 'ready',
      url: attachmentUrl(run.burrow.slug, fileId),
      uploadedById: author,
      messageId: id,
      createdAt,
      uploadedAt: createdAt,
      folder: a.folder ?? '',
      ...(a.folder !== null ? { filedAt: createdAt, filedById: author } : {}),
    });
    files.push(fileId);
    run.remember(a.id, fileId, 'file');
  }
  const pinnedBy = r.pinned ? await run.resolve(r.pinned.by) : null;
  const subject = r.subject ? await subjectHere(run, r.subject) : null;
  await run.tx.insert(messages).values({
    id,
    burrowId: run.burrow.id,
    conversationId,
    authorId: author,
    createdAt,
    editedAt: r.editedAt ? new Date(r.editedAt) : null,
    text: r.text,
    mentions,
    card: card as never,
    suggestions: r.suggestions,
    attachmentIds: files,
    threadRootId: threadRoot,
    provenance: r.provenance,
    outsidersRun: r.outsidersRun,
    deletedAt: r.deleted ? createdAt : null,
    pinnedAt: r.pinned && pinnedBy && !run.isStandIn(pinnedBy) ? new Date(r.pinned.at) : null,
    pinnedById: r.pinned && pinnedBy && !run.isStandIn(pinnedBy) ? pinnedBy : null,
    previews: (r.previews as never) ?? null,
    // What the thread is about (BF-19, BF-S13).
    subjectKind: subject?.kind ?? null,
    subjectId: subject?.id ?? null,
    subjectName: subject?.name ?? null,
  });
  for (const reaction of r.reactions) {
    const by = (await run.resolveAll(reaction.by)).ids.filter((p) => !run.isStandIn(p));
    if (by.length)
      await run.tx
        .insert(reactions)
        .values(
          by.map((p) => ({
            messageId: id,
            principalId: p,
            value: reaction.value,
            burrowId: run.burrow.id,
            createdAt,
          })),
        )
        .onConflictDoNothing();
  }
  if (threadRoot) {
    await run.tx
      .update(messages)
      .set({
        replyCount: sql`${messages.replyCount} + 1`,
        lastReplyAt: sql`greatest(${messages.lastReplyAt}, ${createdAt.toISOString()}::timestamptz)`,
        threadParticipantIds: sql`(array(select distinct unnest(array_append(${messages.threadParticipantIds}, ${author}))))[1:3]`,
      })
      .where(eq(messages.id, threadRoot));
  } else
    await run.tx
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${createdAt.toISOString()}::timestamptz)`,
      })
      .where(eq(conversations.id, conversationId));
  run.remember(r.id, id, 'message');
  run.touched.add(conversationId);
  const db = run.services.db;
  run.ctx.after(async () => {
    await indexMessage(db, id);
    if (threadRoot) await indexMessage(db, threadRoot);
  });
  return 'added';
}

/** Puts a blob from the job's scratch into the file store (once: the store keeps one copy per sha256). */
export async function storeBlob(run: RestoreRun, sha256: string, size: number, path: string): Promise<void> {
  const store = run.services.files.store;
  const key = blobKey(sha256);
  await lockBlob(run.tx, key);
  if ((await store.size(key)) !== null) return;
  const staged = await store.stage(createReadStream(path), { maxBytes: Math.max(size, 1) });
  if (staged.sha256 !== sha256) {
    await store.discard(staged);
    throw new Error('a file’s bytes changed in the restore’s scratch');
  }
  await store.commit(staged, key);
}

async function canvas(run: RestoreRun, r: BackupCanvasRecord): Promise<RecordOutcome> {
  const here = await run.resolve(r.id);
  if (here) return 'detail';
  if (run.dry) {
    run.remember(r.id, run.standIn(r.id), 'canvas');
    return 'detail';
  }
  const conversationId = r.conversation ? await run.resolve(r.conversation) : null;
  if (r.conversation && (!conversationId || run.isStandIn(conversationId))) {
    run.note('missing_reference', 'messages');
    return 'detail';
  }
  let slug = r.slug;
  for (let i = 2; ; i++) {
    const [taken] = await run.tx
      .select({ id: canvases.id })
      .from(canvases)
      .where(and(eq(canvases.burrowId, run.burrow.id), eq(canvases.slug, slug)));
    if (!taken) break;
    slug = `${r.slug}-${i}`;
  }
  const remap = async (pid: string | undefined | null) => {
    const t = pid ? await run.resolve(pid) : null;
    return t && !run.isStandIn(t) ? t : null;
  };
  const provenance: CanvasProvenance = {
    ...r.provenance,
    createdById: (await remap(r.provenance.createdById)) ?? run.restorer.id,
    ...(r.provenance.requestedById
      ? { requestedById: (await remap(r.provenance.requestedById)) ?? run.restorer.id }
      : {}),
    editorIds: (await Promise.all((r.provenance.editorIds ?? []).map((e: string) => remap(e)))).filter(
      (e): e is string => !!e,
    ),
  } as CanvasProvenance;
  const statePath = r.ydoc ? run.canvasPath(r.id) : null;
  let ydoc: Buffer | null = null;
  if (statePath)
    try {
      ydoc = readFileSync(statePath);
    } catch {
      ydoc = null;
    }
  const id = newId('canvas');
  await run.tx.insert(canvases).values({
    id,
    burrowId: run.burrow.id,
    slug,
    title: r.title,
    conversationId,
    provenance,
    markdown: r.markdown,
    ydoc,
    ydocUpdatedAt: ydoc ? run.ctx.now : null,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  });
  run.remember(r.id, id, 'canvas');
  const db = run.services.db;
  run.ctx.after(async () => indexCanvas(db, id, r.markdown));
  return 'detail';
}

/**
 * A chat's or a thread's subject here (BF-S13): a server by its id (the hosts service's, the same where the servers came
 * along), a connection or device by the connection it is here; one whose connection didn't come back keeps its name.
 */
async function subjectHere(
  run: RestoreRun,
  s: BackupChatSubject,
): Promise<{ kind: BackupChatSubject['kind']; id: string; name: string | null } | null> {
  if (s.kind === 'server') return { kind: s.kind, id: s.id, name: s.name || null };
  const target = await run.resolve(s.id);
  if (!target || run.isStandIn(target)) return null;
  return { kind: s.kind, id: target, name: s.name || null };
}

/**
 * A Chat thread's choice of what answers (BF-20, BF-S14): kept with its first message once that is back, with a model
 * this Whombat offers (one it doesn't drops to the tool's default); one here already stays.
 */
async function threadRuntime(run: RestoreRun, r: BackupChatThreadRuntimeRecord): Promise<RecordOutcome> {
  if (run.dry) return 'detail';
  const root = run.mapped(r.root);
  const conversationId = await run.resolve(r.conversation);
  if (!root || !conversationId || run.isStandIn(root) || run.isStandIn(conversationId)) return 'detail';
  const [message] = await run.tx
    .select({ conversationId: messages.conversationId, threadRootId: messages.threadRootId })
    .from(messages)
    .where(eq(messages.id, root));
  if (!message || message.conversationId !== conversationId || message.threadRootId) return 'detail';
  const offered = offeredModelRuntime({ services: run.services }, r.runtime);
  const runtime: ChatRuntime = {
    provider: r.runtime.provider,
    ...(offered.provider === r.runtime.provider && offered.model ? { model: offered.model } : {}),
    ...(offered.provider === r.runtime.provider && offered.effort ? { effort: offered.effort } : {}),
    ...(offered.provider === r.runtime.provider && offered.fast !== undefined ? { fast: offered.fast } : {}),
  };
  const setBy = r.setBy ? await run.resolve(r.setBy) : null;
  await run.tx
    .insert(chatThreadRuntimes)
    .values({
      rootId: root,
      burrowId: run.burrow.id,
      conversationId,
      runtime,
      setById: setBy && !run.isStandIn(setBy) ? setBy : run.restorer.id,
      setAt: new Date(r.setAt),
    })
    .onConflictDoNothing();
  return 'detail';
}

/**
 * A side comment on a restored canvas (BF-20, BF-S15): its author mapped like a message's (else kept as a name), its
 * anchor as it was (the canvas's Yjs state came along), a reply after the comment it answers. The restore map makes a
 * second restore add nothing.
 */
async function canvasComment(run: RestoreRun, r: BackupCanvasCommentRecord): Promise<RecordOutcome> {
  if (run.mapped(r.id)) return 'detail';
  const canvasId = run.mapped(r.canvas) ?? (await run.resolve(r.canvas));
  if (!canvasId) {
    run.note('missing_reference', 'messages');
    return 'detail';
  }
  if (run.dry || run.isStandIn(canvasId)) return 'detail';
  // One that is here already (the canvas was here, or this is the burrow it came from) is itself.
  const [same] = await run.tx
    .select({ id: canvasComments.id })
    .from(canvasComments)
    .where(
      and(
        eq(canvasComments.canvasId, canvasId),
        eq(canvasComments.createdAt, new Date(r.createdAt)),
        eq(canvasComments.text, r.text),
      ),
    );
  if (same) {
    run.remember(r.id, same.id, 'canvas_comment');
    return 'detail';
  }
  const parent = r.parent ? run.mapped(r.parent) : null;
  if (r.parent && (!parent || run.isStandIn(parent))) return 'detail';
  const author = await authorHere(run, r.author);
  if (!author || run.isStandIn(author)) return 'detail';
  const id = newId('comment');
  await run.tx.insert(canvasComments).values({
    id,
    canvasId,
    burrowId: run.burrow.id,
    anchor: r.anchor,
    parentId: parent,
    authorId: author,
    text: r.text,
    resolved: r.resolved,
    createdAt: new Date(r.createdAt),
  });
  run.remember(r.id, id, 'canvas_comment');
  return 'detail';
}
