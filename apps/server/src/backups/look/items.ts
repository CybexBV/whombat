/**
 * What is in an opened backup, by category (backup-look.md): read from the backup's own database and folders, each thing
 * with a plain title, when it last changed and whether it is here already (by its own id, or the id a restore gave it).
 * Chats are the threads of the person's Chat and Feedback rooms and every other chat as a whole. Search: every word in
 * the title, or for chats in their messages.
 */
import { catalogEntry } from '@whombat/core';
import { formatBytes } from '@whombat/core/text';
import type { BackupLookCategory, BackupLookCategoryCount, BackupLookItem } from '@whombat/protocol/session';
import { BACKUP_LOOK_PAGE } from '@whombat/protocol/session';
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { FEEDBACK_ROOM_KEY } from '../../chats/rooms';
import type { Db } from '../../db/client';
import {
  attachments,
  automations,
  backupRestoreMap,
  burrows,
  catalogConnections,
  connections,
  conversations,
  githubConnections,
  messages,
  vaultEntries,
} from '../../db/schema/index';
import { addedAtSql, inFiles } from '../../files/space';
import { iso } from '../../lib/time';
import { peekHomeFiles } from './hermes-pack';
import { dirInside, filesUnder } from './inside';
import { itemIdOf, type PickedItem } from './pick';
import {
  clip,
  likePattern,
  messagesWords,
  repliesWords,
  searchWords,
  threadTitleOf,
  vaultKindWords,
} from './titles';

/** The backup, the running Whombat, and whose they are. */
export interface LookScope {
  /** The backup's database (read-only). */
  peek: Db;
  /** The backup's folders. */
  root: string;
  /** The running Whombat's database. */
  live: Db;
  burrowId: string;
  /** The person (their Vault entries, their Google and Microsoft accounts). */
  personId: string;
  accountId: string | null;
  /** The assistant's name, for its notes, memories and skills. */
  agent: string;
}

/** Most chats a list reads before it pages (newest first). */
const READ_MAX = 5000;

/** The person's Chat and Feedback rooms in the backup. */
async function rooms(s: LookScope): Promise<Map<string, 'chat' | 'feedback'>> {
  const rows = await s.peek
    .select({ id: conversations.id, taskKey: conversations.taskKey })
    .from(conversations)
    .where(
      and(
        eq(conversations.burrowId, s.burrowId),
        eq(conversations.kind, 'dm'),
        or(isNull(conversations.taskKey), eq(conversations.taskKey, FEEDBACK_ROOM_KEY)),
      ),
    );
  return new Map(rows.map((r) => [r.id, r.taskKey === null ? 'chat' : 'feedback']));
}

/** Every word in a thread's messages (its first one or a reply). */
function threadWords(words: readonly string[]): SQL | undefined {
  if (!words.length) return undefined;
  return and(
    ...words.map(
      (w) =>
        sql`(${messages.text} ilike ${likePattern(w)} or ${messages.subjectName} ilike ${likePattern(w)} or exists (select 1 from messages r where r.thread_root_id = ${messages.id} and r.deleted_at is null and r.text ilike ${likePattern(w)}))`,
    ),
  );
}

/** Every word in a chat's title or its messages. */
function chatWords(words: readonly string[]): SQL | undefined {
  if (!words.length) return undefined;
  return and(
    ...words.map(
      (w) =>
        sql`(coalesce(${conversations.chatTitle}, ${conversations.title}) ilike ${likePattern(w)} or exists (select 1 from messages r where r.conversation_id = ${conversations.id} and r.deleted_at is null and r.text ilike ${likePattern(w)}))`,
    ),
  );
}

/** Every word in a column. */
function columnWords(column: SQL | typeof automations.name, words: readonly string[]): SQL | undefined {
  if (!words.length) return undefined;
  return and(...words.map((w) => sql`${column} ilike ${likePattern(w)}`));
}

interface Listed extends BackupLookItem {
  /** Message ids of a chat or thread, to tell whether it is here. */
  messageIds?: string[];
  /** The id `here` is decided by. */
  hereBy?: {
    table: 'attachments' | 'automations' | 'catalog' | 'accounts' | 'vault';
    id: string;
    name?: string;
  };
}

/* Chats -------------------------------------------------------------------------------------------------------------- */

async function threadItems(s: LookScope, words: readonly string[], only?: readonly string[]) {
  const roomOf = await rooms(s);
  if (roomOf.size === 0) return [];
  const rows = await s.peek
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      text: sql<string>`left(${messages.text}, 600)`,
      subject: messages.subjectName,
      at: sql<Date>`coalesce(${messages.lastReplyAt}, ${messages.createdAt})`,
      replies: messages.replyCount,
    })
    .from(messages)
    .where(
      and(
        inArray(messages.conversationId, [...roomOf.keys()]),
        isNull(messages.threadRootId),
        or(isNull(messages.deletedAt), sql`${messages.replyCount} > 0`),
        only ? inArray(messages.id, [...only]) : undefined,
        threadWords(words),
      ),
    )
    .orderBy(desc(sql`coalesce(${messages.lastReplyAt}, ${messages.createdAt})`))
    .limit(READ_MAX);
  return rows.map((r): Listed & { conversation: string } => ({
    id: itemIdOf({ kind: 'thread', id: r.id }),
    category: 'messages',
    title: threadTitleOf(r.text, r.subject),
    at: iso(new Date(r.at)),
    detail:
      `In ${roomOf.get(r.conversationId) === 'feedback' ? 'Feedback' : 'Chat'}` +
      (r.replies > 0 ? ` · ${repliesWords(r.replies)}` : ''),
    here: null,
    conversation: r.conversationId,
  }));
}

async function chatItems(s: LookScope, words: readonly string[], only?: readonly string[]) {
  const rows = await s.peek
    .select({
      id: conversations.id,
      kind: conversations.kind,
      title: sql<string>`coalesce(${conversations.chatTitle}, ${conversations.title})`,
      at: conversations.lastMessageAt,
      count: sql<number>`(select count(*)::int from messages r where r.conversation_id = ${conversations.id} and (r.deleted_at is null or r.reply_count > 0))`,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.burrowId, s.burrowId),
        isNotNull(conversations.lastMessageAt),
        // Every chat but the person's two rooms (their threads are listed one by one).
        or(
          eq(conversations.kind, 'branch'),
          and(isNotNull(conversations.taskKey), ne(conversations.taskKey, FEEDBACK_ROOM_KEY)),
        ),
        only ? inArray(conversations.id, [...only]) : undefined,
        chatWords(words),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(READ_MAX);
  return rows
    .filter((r) => r.count > 0)
    .map(
      (r): Listed => ({
        id: itemIdOf({ kind: 'chat', id: r.id }),
        category: 'messages',
        title: clip(r.title || 'A chat'),
        at: r.at ? iso(r.at) : null,
        detail: `${r.kind === 'branch' ? 'A branch’s chat' : 'A chat'} · ${messagesWords(r.count)}`,
        here: null,
      }),
    );
}

/** The ids of the messages of some threads (their first message and replies) in the backup, by thread. */
async function threadMessageIds(peek: Db, roots: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(roots.map((r) => [r, [r]]));
  if (!roots.length) return out;
  const rows = await peek
    .select({ id: messages.id, root: messages.threadRootId })
    .from(messages)
    .where(and(inArray(messages.threadRootId, [...roots]), isNull(messages.deletedAt)));
  for (const r of rows) if (r.root) out.get(r.root)?.push(r.id);
  return out;
}

/** The ids of the messages of some chats in the backup, by chat. */
async function chatMessageIds(peek: Db, chats: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(chats.map((c) => [c, []]));
  if (!chats.length) return out;
  const rows = await peek
    .select({ id: messages.id, conversation: messages.conversationId })
    .from(messages)
    .where(
      and(
        inArray(messages.conversationId, [...chats]),
        or(isNull(messages.deletedAt), sql`${messages.replyCount} > 0`),
      ),
    );
  for (const r of rows) out.get(r.conversation)?.push(r.id);
  return out;
}

/* Here already --------------------------------------------------------------------------------------------------------- */

const TABLES = {
  messages: messages,
  attachments: attachments,
  catalog: catalogConnections,
  accounts: connections,
  vault: vaultEntries,
} as const;

/**
 * Which of the backup's ids are here: the thing itself, or what a restore made of it (the restore map), as long as that
 * is still here.
 */
export async function presentIds(
  live: Db,
  burrowId: string,
  table: keyof typeof TABLES,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  const t = TABLES[table];
  for (let i = 0; i < ids.length; i += 1000) {
    const part = ids.slice(i, i + 1000);
    const mapped = await live
      .select({ source: backupRestoreMap.sourceId, target: backupRestoreMap.targetId })
      .from(backupRestoreMap)
      .where(and(eq(backupRestoreMap.burrowId, burrowId), inArray(backupRestoreMap.sourceId, part)));
    const targets = new Map<string, string>();
    for (const m of mapped) targets.set(m.target, m.source);
    const look = [...new Set([...part, ...targets.keys()])];
    const rows = await live.select({ id: t.id }).from(t).where(inArray(t.id, look));
    for (const r of rows) {
      if (part.includes(r.id)) out.add(r.id);
      const source = targets.get(r.id);
      if (source) out.add(source);
    }
  }
  return out;
}

/** `here` for listed items, read from the running Whombat. */
async function markHere(s: LookScope, items: Listed[]): Promise<void> {
  const msgIds = items.flatMap((i) => i.messageIds ?? []);
  const msgsHere = await presentIds(s.live, s.burrowId, 'messages', msgIds);
  const by = (table: NonNullable<Listed['hereBy']>['table']) =>
    items.flatMap((i) => (i.hereBy?.table === table ? [i.hereBy.id] : []));
  const files = await presentIds(s.live, s.burrowId, 'attachments', by('attachments'));
  const catalog = await presentIds(s.live, s.burrowId, 'catalog', by('catalog'));
  const accounts = await presentIds(s.live, s.burrowId, 'accounts', by('accounts'));
  const vault = await presentIds(s.live, s.burrowId, 'vault', by('vault'));
  // Automations come back matched by name (backup-file.md): one by that name here is this one.
  const names = items.flatMap((i) =>
    i.hereBy?.table === 'automations' && i.hereBy.name ? [i.hereBy.name] : [],
  );
  const autoNames = names.length
    ? new Set(
        (
          await s.live
            .select({ name: automations.name })
            .from(automations)
            .where(
              and(
                eq(automations.burrowId, s.burrowId),
                isNull(automations.deletedAt),
                inArray(automations.name, names),
              ),
            )
        ).map((r) => r.name),
      )
    : new Set<string>();
  for (const i of items) {
    if (i.messageIds) i.here = i.messageIds.length > 0 && i.messageIds.every((id) => msgsHere.has(id));
    else if (i.hereBy) {
      const { table, id, name } = i.hereBy;
      if (table === 'attachments') i.here = files.has(id);
      else if (table === 'catalog') i.here = catalog.has(id);
      else if (table === 'accounts') i.here = accounts.has(id);
      else if (table === 'vault') i.here = vault.has(id);
      else if (table === 'automations') i.here = name ? autoNames.has(name) : null;
    }
  }
}

/* Each category ---------------------------------------------------------------------------------------------------------- */

async function fileItems(
  s: LookScope,
  words: readonly string[],
  only?: readonly string[],
): Promise<(Listed & { conversation: string | null })[]> {
  const rows = await s.peek
    .select({
      id: attachments.id,
      conversationId: attachments.conversationId,
      name: attachments.name,
      size: attachments.size,
      addedAt: addedAtSql,
    })
    .from(attachments)
    .leftJoin(messages, eq(messages.id, attachments.messageId))
    .where(
      and(
        eq(attachments.burrowId, s.burrowId),
        inFiles(),
        isNotNull(attachments.sha256),
        only ? inArray(attachments.id, [...only]) : undefined,
        columnWords(sql`${attachments.name}`, words),
      ),
    )
    .orderBy(desc(addedAtSql))
    .limit(READ_MAX);
  return rows.map((r) => ({
    id: itemIdOf({ kind: 'file', id: r.id }),
    category: 'files',
    title: clip(r.name || 'A file'),
    at: iso(new Date(r.addedAt)),
    detail: formatBytes(r.size),
    here: null,
    hereBy: { table: 'attachments', id: r.id },
    conversation: r.conversationId,
  }));
}

async function automationItems(
  s: LookScope,
  words: readonly string[],
  only?: readonly string[],
): Promise<Listed[]> {
  const rows = await s.peek
    .select({ id: automations.id, name: automations.name, at: automations.updatedAt })
    .from(automations)
    .where(
      and(
        eq(automations.burrowId, s.burrowId),
        isNull(automations.deletedAt),
        only ? inArray(automations.id, [...only]) : undefined,
        columnWords(automations.name, words),
      ),
    )
    .orderBy(desc(automations.updatedAt))
    .limit(READ_MAX);
  return rows.map((r) => ({
    id: itemIdOf({ kind: 'automation', id: r.id }),
    category: 'automations',
    title: clip(r.name || 'An automation'),
    at: iso(r.at),
    detail: null,
    here: null,
    hereBy: { table: 'automations', id: r.id, name: r.name },
  }));
}

async function connectionItems(
  s: LookScope,
  words: readonly string[],
  only?: readonly PickedItem[],
): Promise<Listed[]> {
  const ids = (kind: 'connection' | 'account') => only?.flatMap((i) => (i.kind === kind ? [i.id] : []));
  const want = (kind: PickedItem['kind']) => !only || only.some((i) => i.kind === kind);
  const out: Listed[] = [];
  if (want('connection')) {
    const rows = await s.peek
      .select({
        id: catalogConnections.id,
        catalogId: catalogConnections.catalogId,
        label: catalogConnections.label,
        at: catalogConnections.updatedAt,
      })
      .from(catalogConnections)
      .where(
        and(
          eq(catalogConnections.burrowId, s.burrowId),
          only ? inArray(catalogConnections.id, ids('connection') ?? []) : undefined,
        ),
      )
      .orderBy(desc(catalogConnections.updatedAt));
    for (const r of rows) {
      const entry = catalogEntry(r.catalogId);
      // A built-in connection (Servers, a device) is part of this Whombat: there is nothing to bring back.
      if (entry?.transport === 'builtin') continue;
      const title = clip(r.label || entry?.name || r.catalogId);
      const service = entry?.name && entry.name !== title ? entry.name : null;
      if (words.length && !words.every((w) => `${title} ${service ?? ''}`.toLowerCase().includes(w)))
        continue;
      out.push({
        id: itemIdOf({ kind: 'connection', id: r.id }),
        category: 'connections',
        title,
        at: iso(r.at),
        detail: service,
        here: null,
        hereBy: { table: 'catalog', id: r.id },
      });
    }
  }
  if (want('account') && s.accountId) {
    const rows = await s.peek
      .select({
        id: connections.id,
        provider: connections.provider,
        email: connections.email,
        at: connections.updatedAt,
      })
      .from(connections)
      .where(
        and(
          eq(connections.accountId, s.accountId),
          only ? inArray(connections.id, ids('account') ?? []) : undefined,
        ),
      );
    for (const r of rows) {
      const provider =
        r.provider === 'google' ? 'Google' : r.provider === 'microsoft' ? 'Microsoft' : r.provider;
      const title = clip(r.email || `${provider} account`);
      if (words.length && !words.every((w) => `${title} ${provider}`.toLowerCase().includes(w))) continue;
      out.push({
        id: itemIdOf({ kind: 'account', id: r.id }),
        category: 'connections',
        title,
        at: iso(r.at),
        detail: `${provider} account`,
        here: null,
        hereBy: { table: 'accounts', id: r.id },
      });
    }
  }
  if (want('github')) {
    const [gh] = await s.peek
      .select({ login: githubConnections.login, at: githubConnections.connectedAt })
      .from(githubConnections)
      .where(eq(githubConnections.burrowId, s.burrowId));
    const title = gh ? clip(gh.login ? `GitHub (${gh.login})` : 'GitHub') : '';
    if (gh && (!words.length || words.every((w) => title.toLowerCase().includes(w)))) {
      const [here] = await s.live
        .select({ login: githubConnections.login })
        .from(githubConnections)
        .where(eq(githubConnections.burrowId, s.burrowId));
      out.push({
        id: itemIdOf({ kind: 'github' }),
        category: 'connections',
        title,
        at: gh.at ? iso(gh.at) : null,
        detail: null,
        here: !!here,
      });
    }
  }
  return out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

async function vaultItems(
  s: LookScope,
  words: readonly string[],
  only?: readonly string[],
): Promise<Listed[]> {
  const rows = await s.peek
    .select({
      id: vaultEntries.id,
      name: vaultEntries.name,
      kind: vaultEntries.kind,
      at: vaultEntries.updatedAt,
    })
    .from(vaultEntries)
    .where(
      and(
        eq(vaultEntries.burrowId, s.burrowId),
        eq(vaultEntries.ownerId, s.personId),
        only ? inArray(vaultEntries.id, [...only]) : undefined,
        columnWords(sql`${vaultEntries.name}`, words),
      ),
    )
    .orderBy(desc(vaultEntries.updatedAt))
    .limit(READ_MAX);
  return rows.map((r) => ({
    id: itemIdOf({ kind: 'vault', id: r.id }),
    category: 'vault',
    title: clip(r.name || 'A Vault entry'),
    at: iso(r.at),
    detail: vaultKindWords(r.kind),
    here: null,
    hereBy: { table: 'vault', id: r.id },
  }));
}

async function memoryItems(s: LookScope, words: readonly string[]): Promise<Listed[]> {
  const out: Listed[] = [];
  const [peekNotes] = await s.peek
    .select({ notes: burrows.agentNotes })
    .from(burrows)
    .where(eq(burrows.id, s.burrowId));
  if (peekNotes?.notes?.text) {
    const [liveNotes] = await s.live
      .select({ notes: burrows.agentNotes })
      .from(burrows)
      .where(eq(burrows.id, s.burrowId));
    out.push({
      id: 'notes',
      category: 'memories',
      title: `${s.agent}’s notes`,
      at: peekNotes.notes.updatedAt ?? null,
      detail: null,
      // Notes here stay as they are (bringing back only adds).
      here: !!liveNotes?.notes?.text,
    });
  }
  for (const home of ['person', 'outside'] as const) {
    const { files } = await peekHomeFiles(s.root, { kind: 'profile', home });
    if (!files.length) continue;
    const newest = Math.max(...files.map((f) => f.mtime));
    out.push({
      id: itemIdOf({ kind: 'home', home }),
      category: 'memories',
      title:
        home === 'person' ? `What ${s.agent} remembers about you` : `What ${s.agent} remembers from Feedback`,
      at: iso(new Date(newest * 1000)),
      detail: 'Only what isn’t here comes back',
      here: null,
    });
  }
  return words.length ? out.filter((i) => words.every((w) => i.title.toLowerCase().includes(w))) : out;
}

async function skillItems(s: LookScope, words: readonly string[]): Promise<Listed[]> {
  const dir = await dirInside(s.root, ['hermes', 'skills']);
  if (!dir) return [];
  const skills = await filesUnder(dir, (rel) => rel === 'SKILL.md' || rel.endsWith('/SKILL.md'));
  if (!skills.length) return [];
  const item: Listed = {
    id: 'skills',
    category: 'skills',
    title: `${s.agent}’s skills`,
    at: iso(new Date(Math.max(...skills.map((f) => f.mtime)) * 1000)),
    detail: `${skills.length === 1 ? '1 skill' : `${skills.length} skills`} · only what isn’t here comes back`,
    here: null,
  };
  return words.length && !words.every((w) => item.title.toLowerCase().includes(w)) ? [] : [item];
}

/** Every item of a category, newest first (bringing a whole category back). */
export async function allLookItems(s: LookScope, category: BackupLookCategory): Promise<BackupLookItem[]> {
  return (await allItems(s, category, [])).map(strip);
}

/** Every item of a category matching the words, newest first (chats: threads and chats together). */
async function allItems(
  s: LookScope,
  category: BackupLookCategory,
  words: readonly string[],
): Promise<Listed[]> {
  switch (category) {
    case 'messages': {
      const [threads, chats] = await Promise.all([threadItems(s, words), chatItems(s, words)]);
      return [...threads, ...chats].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    }
    case 'files':
      return fileItems(s, words);
    case 'automations':
      return automationItems(s, words);
    case 'connections':
      return connectionItems(s, words);
    case 'vault':
      return vaultItems(s, words);
    case 'memories':
      return memoryItems(s, words);
    case 'skills':
      return skillItems(s, words);
  }
}

/** Fills in the message ids `here` is decided by, for the chats and threads of a page. */
async function withMessageIds(s: LookScope, page: Listed[]): Promise<void> {
  const roots = page.filter((i) => i.id.startsWith('thread:')).map((i) => i.id.slice('thread:'.length));
  const chats = page.filter((i) => i.id.startsWith('chat:')).map((i) => i.id.slice('chat:'.length));
  const [byThread, byChat] = await Promise.all([
    threadMessageIds(s.peek, roots),
    chatMessageIds(s.peek, chats),
  ]);
  for (const i of page) {
    if (i.id.startsWith('thread:')) i.messageIds = byThread.get(i.id.slice('thread:'.length)) ?? [];
    if (i.id.startsWith('chat:')) i.messageIds = byChat.get(i.id.slice('chat:'.length)) ?? [];
  }
}

const strip = (i: Listed): BackupLookItem => ({
  id: i.id,
  category: i.category,
  title: i.title,
  at: i.at,
  detail: i.detail,
  here: i.here,
});

/** A page of a category's items (the cursor is how many came before). */
export async function lookItems(
  s: LookScope,
  category: BackupLookCategory,
  query: string | undefined,
  cursor: string | undefined,
  limit = BACKUP_LOOK_PAGE,
): Promise<{ items: BackupLookItem[]; nextCursor: string | null }> {
  const words = searchWords(query);
  const all = await allItems(s, category, words);
  const from = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0);
  const page = all.slice(from, from + limit);
  await withMessageIds(s, page);
  await markHere(s, page);
  return {
    items: page.map(strip),
    nextCursor: from + limit < all.length ? String(from + limit) : null,
  };
}

/** How many things each category has (only categories with something in them). */
export async function lookCategories(s: LookScope): Promise<BackupLookCategoryCount[]> {
  const out: BackupLookCategoryCount[] = [];
  for (const id of [
    'messages',
    'files',
    'automations',
    'connections',
    'vault',
    'memories',
    'skills',
  ] as const) {
    const n = (await allItems(s, id, [])).length;
    if (n > 0) out.push({ id, count: n });
  }
  return out;
}

/**
 * The picked items as they are in the backup, with their titles and (for a thread) the conversation it is in; those the
 * backup doesn't have are left out.
 */
export async function findPicked(
  s: LookScope,
  picked: readonly PickedItem[],
): Promise<{ item: PickedItem; title: string; conversation: string | null; messageIds: string[] }[]> {
  const ofKind = <K extends PickedItem['kind']>(k: K) =>
    picked.flatMap((p) => (p.kind === k ? [(p as Extract<PickedItem, { kind: K; id: string }>).id] : []));
  const found = new Map<string, Listed & { conversation?: string | null }>();
  const add = (list: (Listed & { conversation?: string | null })[]) => {
    for (const i of list) found.set(i.id, i);
  };
  if (ofKind('thread').length) add(await threadItems(s, [], ofKind('thread')));
  if (ofKind('chat').length) add(await chatItems(s, [], ofKind('chat')));
  if (ofKind('file').length) add(await fileItems(s, [], ofKind('file')));
  if (ofKind('automation').length) add(await automationItems(s, [], ofKind('automation')));
  if (picked.some((p) => p.kind === 'connection' || p.kind === 'account' || p.kind === 'github'))
    add(await connectionItems(s, [], picked));
  if (ofKind('vault').length) add(await vaultItems(s, [], ofKind('vault')));
  if (picked.some((p) => p.kind === 'notes' || p.kind === 'home')) add(await memoryItems(s, []));
  if (picked.some((p) => p.kind === 'skills')) add(await skillItems(s, []));
  const list = picked.flatMap((p) => {
    const i = found.get(itemIdOf(p));
    return i ? [{ item: p, listed: i }] : [];
  });
  await withMessageIds(
    s,
    list.map((l) => l.listed),
  );
  return list.map(({ item, listed }) => ({
    item,
    title: listed.title,
    conversation: listed.conversation ?? null,
    messageIds: listed.messageIds ?? [],
  }));
}
