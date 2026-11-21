/**
 * Done recently and Undo (docs/decisions/one-whombat.md ONE-08; one-whombat-assistant.md ONE-DW18…ONE-DW20).
 *
 * - `listChanges`: the burrow's changes, newest first, as `ChangeEntry` with Undo's state (`undoStateOf`). Home's Done recently and “Everything I
 *   did” list only what an agent changed, never an everyday switch (`thing.control.*`: a light, pausing downloads,
 *   service-dashboards.md SD-08); a thing's page lists every change made there, the person's own too (HR-05).
 * - A change's `link` (HR-08): the chat it was made in when that is the viewer's own chat with their assistant (a DM
 *   for them), else the place it was recorded with (the thing's page).
 * - `undoChange`: the person presses Undo. A **direct** undoer (`registerDirectUndoer`: the connection undo) runs outside
 *   any transaction and makes its own pipeline calls, so it can say whether the inverse ran or waits for a yes; an
 *   **in-commit** undoer (`registerUndoer`, SH and SD) runs inside the `undo_change` command and the change is marked
 *   undone in that commit. Either way keys and approvals apply again.
 */
import {
  type ChangeEntry,
  ChangeId,
  type ChatRoom,
  chatHref,
  chatRoomHref,
  chatThreadHref,
  thingId,
} from '@whombat/core';
import { and, desc, eq, inArray, isNotNull, isNull, lt, notLike, or } from 'drizzle-orm';
import { z } from 'zod';
import { roomByKey } from '../chats/rooms';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { changes, conversations, principals } from '../db/schema/index';
import { conflict, forbidden, notFound } from '../lib/errors';
import { loadPrincipalRow, type PrincipalRow, toActor } from '../read/principals';
import type { Services } from '../services';
import { homeAudience, publishHomeChanged } from './notify';
import { type ChangeRow, directUndoerFor, openChange, undoerFor, undoStateOf } from './registry';

/** What a refused Undo says when nobody knows a better reason. */
export const UNDO_GONE_TEXT = 'This can’t be undone any more.';

/** Whether `viewer` sees the change: the person, in their burrow (one-person.md OP-S52). */
export function changeVisibleTo(row: Pick<ChangeRow, 'burrowId'>, viewer: PrincipalRow) {
  return row.burrowId === viewer.burrowId && viewer.kind === 'person';
}

const visibleWhere = (viewer: PrincipalRow) => eq(changes.burrowId, viewer.burrowId);

/**
 * `ChangeEntry` of a row, with its actor's name; `chat`: the viewer's own chat it was made in (HR-08) — `true` for a
 * task chat, or the room it is (Chat, Feedback), whose link is the thread it was made in (chat-channel.md CHT-08).
 */
export function toChangeEntry(
  row: ChangeRow,
  actorName: string | null,
  actorKind: 'whombat' | 'person',
  now: Date,
  chat: boolean | ChatRoom = false,
): ChangeEntry {
  const link =
    chat && row.conversationId
      ? chat === true
        ? chatHref(row.conversationId)
        : row.threadRootId
          ? chatThreadHref(chat, row.threadRootId)
          : chatRoomHref(chat)
      : row.link;
  return {
    id: row.id,
    title: row.title,
    ...(row.detail ? { detail: row.detail } : {}),
    at: row.createdAt.toISOString(),
    // The assistant that made it by its own name (assistant-name.md AN-01); “Your assistant” when it can't be found.
    actor: { kind: actorKind, id: row.actorId, name: (actorName ?? 'Your assistant').slice(0, 80) },
    undo: undoStateOf(row, now),
    ...(link ? { link } : {}),
    ...(row.subjectKind && row.subjectId && ['server', 'connection', 'device'].includes(row.subjectKind)
      ? { thingId: thingId(row.subjectKind as 'server' | 'connection' | 'device', row.subjectId) }
      : {}),
  };
}

/**
 * The conversations among `ids` that are the viewer's own chats with an assistant (a DM for them): each with its room
 * when it is their Chat or Feedback room with their own assistant (CHT-08), else `true` (a task chat, another DM).
 */
export async function viewersChats(
  db: Db | Tx,
  viewerId: string,
  ids: string[],
): Promise<Map<string, true | ChatRoom>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: conversations.id,
      kind: conversations.kind,
      taskKey: conversations.taskKey,
      agentKind: principals.kind,
    })
    .from(conversations)
    .innerJoin(principals, eq(principals.id, conversations.dmAgentId))
    .where(
      and(
        inArray(conversations.id, ids),
        eq(conversations.kind, 'dm'),
        isNotNull(conversations.dmAgentId),
        eq(conversations.dmPersonId, viewerId),
      ),
    );
  return new Map(rows.map((r) => [r.id, (r.agentKind === 'agent' ? roomByKey(r) : null) ?? true] as const));
}

async function entries(
  db: Db | Tx,
  viewer: Pick<PrincipalRow, 'id'>,
  rows: ChangeRow[],
  now: Date,
): Promise<ChangeEntry[]> {
  const ids = [...new Set(rows.map((r) => r.actorId))];
  const chatIds = [...new Set(rows.flatMap((r) => (r.conversationId ? [r.conversationId] : [])))];
  const [actors, chats] = await Promise.all([
    ids.length
      ? db
          .select({ id: principals.id, name: principals.name, kind: principals.kind })
          .from(principals)
          .where(inArray(principals.id, ids))
      : [],
    viewersChats(db, viewer.id, chatIds),
  ]);
  const byId = new Map(actors.map((a) => [a.id, a]));
  return rows.map((r) => {
    const a = byId.get(r.actorId);
    const chat = r.conversationId ? (chats.get(r.conversationId) ?? false) : false;
    return toChangeEntry(r, a?.name ?? null, a?.kind === 'person' ? 'person' : 'whombat', now, chat);
  });
}

/** A `changes.list` cursor: the last row's time and id. */
function cursorOf(row: ChangeRow): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

function parseCursor(cursor: string): { at: Date; id: string } | null {
  const [at, id] = cursor.split('|');
  const when = at ? new Date(at) : null;
  return when && !Number.isNaN(when.getTime()) && id ? { at: when, id } : null;
}

/** Everyday switches' changes (SD-08): only the thing's own list shows them. */
export const EVERYDAY_CHANGE_PREFIX = 'thing.control.';

/**
 * The viewer's changes, newest first (`changes.list`, Done recently). `thing`: a `thingId` (one thing's changes, the
 * person's own and everyday switches too); without it only what an agent changed (HR-05), everyday switches left out
 * (SD-08).
 */
export async function listChanges(
  db: Db,
  viewer: PrincipalRow,
  options: { before?: string | undefined; limit?: number; thing?: string | undefined; now: Date },
): Promise<{ changes: ChangeEntry[]; before: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const before = options.before ? parseCursor(options.before) : null;
  const thing = options.thing?.includes(':')
    ? {
        kind: options.thing.slice(0, options.thing.indexOf(':')),
        id: options.thing.slice(options.thing.indexOf(':') + 1),
      }
    : null;
  const rows = await db
    .select()
    .from(changes)
    .where(
      and(
        visibleWhere(viewer),
        before
          ? or(
              lt(changes.createdAt, before.at),
              and(eq(changes.createdAt, before.at), lt(changes.id, before.id)),
            )
          : undefined,
        thing
          ? and(eq(changes.subjectKind, thing.kind), eq(changes.subjectId, thing.id))
          : and(isNotNull(changes.agentId), notLike(changes.kind, `${EVERYDAY_CHANGE_PREFIX}%`)),
      ),
    )
    .orderBy(desc(changes.createdAt), desc(changes.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    changes: await entries(db, viewer, page, options.now),
    before: rows.length > limit && last ? cursorOf(last) : null,
  };
}

/** One change as the viewer sees it, or `not_found`. */
export async function loadChangeFor(db: Db | Tx, viewer: PrincipalRow, changeId: string): Promise<ChangeRow> {
  const [row] = await db.select().from(changes).where(eq(changes.id, changeId));
  if (!row || !changeVisibleTo(row, viewer)) throw notFound('Change');
  return row;
}

export async function changeEntryFor(
  db: Db | Tx,
  viewer: Pick<PrincipalRow, 'id'>,
  row: ChangeRow,
  now: Date,
): Promise<ChangeEntry> {
  const [entry] = await entries(db, viewer, [row], now);
  if (!entry) throw notFound('Change');
  return entry;
}

/** Why Undo can't be offered for this row now, or null when it can. */
function undoProblem(row: ChangeRow, now: Date): string | null {
  if (row.undoneAt) return 'This was undone already.';
  const state = undoStateOf(row, now);
  if (state.state !== 'available') return UNDO_GONE_TEXT;
  return null;
}

/** An in-commit undo (`registerUndoer`): the undoer and the mark in one commit, as the person who pressed Undo. */
export const undoChangeCommand = defineCommand({
  name: 'undo_change',
  schema: z.object({ changeId: ChangeId }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only people undo changes.');
    const viewer = await loadPrincipalRow(tx, ctx.actor.id);
    if (!viewer) throw notFound('Person');
    const [row] = await tx.select().from(changes).where(eq(changes.id, input.changeId)).for('update');
    if (!row || !changeVisibleTo(row, viewer)) throw notFound('Change');
    const problem = undoProblem(row, ctx.now);
    if (problem) throw conflict(problem);
    const opened = openChange(ctx.services.custody, row);
    const undoer = row.undoKind ? undoerFor(row.undoKind) : null;
    if (!opened || !undoer) throw conflict(UNDO_GONE_TEXT);
    const result = await undoer(ctx, opened, ctx.actor);
    if (!result.ok) throw conflict(result.reason);
    // The inverse waits for a yes: the change keeps its Undo until the inverse runs (its own change marks this one).
    if (result.state === 'asked')
      return {
        changeId: row.id,
        state: 'asked' as const,
        ...(result.approvalNumber ? { approvalNumber: result.approvalNumber } : {}),
      };
    await tx
      .update(changes)
      .set({ undoneAt: ctx.now, undoneById: ctx.actor.id })
      .where(and(eq(changes.id, row.id), isNull(changes.undoneAt)));
    await ctx.emit({
      type: 'change.undone',
      kind: 'System',
      text: `Undid “${row.title}”`.slice(0, 300),
      where: null,
      payload: { changeId: row.id, kind: row.kind },
    });
    publishHomeChanged(ctx, await homeAudience(ctx, row.burrowId), ['doneRecently']);
    return { changeId: row.id, state: 'undone' as const };
  },
});

/** Marks a change undone after a direct undoer's inverse ran without recording a change of its own. */
export const markChangeUndone = defineCommand({
  name: 'mark_change_undone',
  schema: z.object({ changeId: ChangeId }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only people undo changes.');
    const [row] = await tx.select().from(changes).where(eq(changes.id, input.changeId)).for('update');
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Change');
    if (!row.undoneAt)
      await tx
        .update(changes)
        .set({ undoneAt: ctx.now, undoneById: ctx.actor.id })
        .where(eq(changes.id, row.id));
    publishHomeChanged(ctx, await homeAudience(ctx, row.burrowId), ['doneRecently']);
    return { changeId: row.id };
  },
});

/** `changes.undo`: runs the change's undoer and answers the change as it is now. */
export async function undoChange(
  services: Services,
  viewer: PrincipalRow,
  changeId: string,
): Promise<{
  change: ChangeEntry;
  state: 'undone' | 'asked' | 'requested';
  approvalNumber?: number;
  conversationId?: string;
}> {
  if (viewer.kind !== 'person') throw forbidden('Only people undo changes.');
  const now = services.clock();
  const row = await loadChangeFor(services.db, viewer, changeId);
  const problem = undoProblem(row, now);
  if (problem) throw conflict(problem);
  const direct = row.undoKind ? directUndoerFor(row.undoKind) : null;
  if (!direct) {
    const res = await services.pipeline.commit(
      undoChangeCommand,
      { changeId },
      { burrowId: viewer.burrowId, actorId: viewer.id },
    );
    if (res.status !== 'ok') throw conflict(res.status === 'blocked' ? res.message : UNDO_GONE_TEXT);
    const fresh = await loadChangeFor(services.db, viewer, changeId);
    const result = res.result as { state: 'undone' | 'asked'; approvalNumber?: number };
    return {
      change: await changeEntryFor(services.db, viewer, fresh, services.clock()),
      state: result.state,
      ...(result.approvalNumber ? { approvalNumber: result.approvalNumber } : {}),
    };
  }
  const opened = openChange(services.custody, row);
  if (!opened) throw conflict(UNDO_GONE_TEXT);
  const result = await direct({ services, burrowId: viewer.burrowId, person: toActor(viewer), now }, opened);
  if (!result.ok) throw conflict(result.reason);
  let fresh = await loadChangeFor(services.db, viewer, changeId);
  // The agent was asked to put it back in its chat (HR-03): its own report marks the change undone.
  if (result.state === 'requested')
    return {
      change: await changeEntryFor(services.db, viewer, fresh, services.clock()),
      state: 'requested',
      conversationId: result.conversationId,
    };
  // The inverse ran but recorded no change of its own (it changed nothing the service reported): marked here.
  if (result.state === 'undone' && !fresh.undoneAt) {
    await services.pipeline.commit(
      markChangeUndone,
      { changeId },
      { burrowId: viewer.burrowId, actorId: viewer.id },
    );
    fresh = await loadChangeFor(services.db, viewer, changeId);
  }
  return {
    change: await changeEntryFor(services.db, viewer, fresh, services.clock()),
    state: result.state,
    ...(result.approvalNumber ? { approvalNumber: result.approvalNumber } : {}),
  };
}

/** Done recently on Home: the viewer's newest `limit` changes. */
export async function doneRecently(
  db: Db,
  viewer: PrincipalRow,
  now: Date,
  limit: number,
): Promise<ChangeEntry[]> {
  return (await listChanges(db, viewer, { limit, now })).changes;
}

export const CHANGE_COMMANDS = [undoChangeCommand, markChangeUndone];
