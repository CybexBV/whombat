/**
 * Work outside connections is recorded too (docs/decisions/home-redesign.md HR-03; contracts CT-402).
 *
 * - **`report_change`** (every agent, no key): the agent records a change it made any other way (its commands, a
 *   command on a server) as a change of kind `agent.report`, in the chat of the turn. `thing` names what
 *   changed — a thing id (`server:pve-02`, `connection:con_…`, `device:con_…`), a connection's handle or a server's name
 *   — and is resolved as the turn may see it. Its private `undo` (how to put it back) is sealed with the change and
 *   gives Done recently an Undo for 24 hours. At most `REPORTS_PER_HOUR` an hour per agent.
 * - **Undo** (a direct undoer of `agent.report`): the person's “Please undo this: …” is posted in that chat and the agent
 *   is woken there for them (trigger `undo_requested`, its own turn), its note in `DispatchContext.undoRequest`; Undo
 *   answers `requested`. A second press within `UNDO_ASK_WINDOW_MS` is refused (“I’m already undoing this.”); only the
 *   person the agent can be woken for in that chat can ask. The agent puts it back and reports that with `undoes`, which
 *   marks the original undone (same burrow, same agent).
 */
import { createHash } from 'node:crypto';
import {
  CHANGE_UNDO_WINDOW_S,
  type DispatchContext,
  type Message,
  parseThingId,
  type ReportChangeOutput,
  thingHref,
} from '@whombat/core';
import { and, count, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { threadedRoom } from '../chats/rooms';
import { defineCommand } from '../commit/types';
import { type ConnectionDispatch, visibleConnections } from '../connections/context';
import { nameWithoutAddress } from '../connections/labels';
import type { Db } from '../db/client';
import { changes, messages } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { wakeQuietly } from '../domain/wake';
import { arr, obj } from '../hosts/map';
import { hostsFor } from '../hosts/service';
import { conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow, shortName } from '../read/principals';
import type { Services } from '../services';
import { homeAudience, publishHomeChanged } from './notify';
import {
  type ChangeRow,
  type DirectUndoer,
  openChange,
  recordChange,
  registerDirectUndoer,
} from './registry';
import type { ChangeSubject } from './types';

/** The kind (and undoer) of a change an agent reported. */
export const REPORT_KIND = 'agent.report';

/** A second Undo within this long of the first asks nobody again (“I’m already undoing this.”). */
export const UNDO_ASK_WINDOW_MS = 10 * 60_000;

/** At most this many reports an hour per agent (`capped`). */
export const REPORTS_PER_HOUR = 30;

/** What a second Undo press says. */
export const ALREADY_UNDOING_TEXT = 'I’m already undoing this.';

/** The person's message an Undo posts in the chat. */
export function undoRequestText(title: string): string {
  return `Please undo this: ${title}`;
}

const CLIENT_PREFIX = 'undo:';

/** The Undo message's client id: the change and a short hash of the moment (≤ 64, the contracts' limit). */
export function undoRequestClientId(changeId: string, at: Date): string {
  const hash = createHash('sha256').update(`${changeId}:${at.toISOString()}`).digest('hex').slice(0, 8);
  return `${CLIENT_PREFIX}${changeId}:${hash}`;
}

/** The change an Undo message names, from its client id; null for any other message. */
export function undoRequestOrigin(clientId: string | null | undefined): string | null {
  return /^undo:(chg_[A-Za-z0-9_-]{1,40}):[0-9a-f]{8}$/.exec(clientId ?? '')?.[1] ?? null;
}

/** The undo note a report keeps (sealed with the change). */
interface ReportUndo {
  note: string;
}

/** What `thing` resolved to: the change's subject. */
interface ResolvedThing {
  subject: ChangeSubject;
}

/** Turn and actor facts the report needs. */
interface ReportTurn {
  services: Services;
  burrowId: string;
  agentId: string;
  dispatch: ConnectionDispatch & { conversationId: string };
  /** The person the turn is for. */
  personId: string | null;
}

async function serverNamed(services: Services, burrowId: string, raw: string): Promise<ChangeSubject | null> {
  const hosts = hostsFor(services);
  if (!hosts.present || !(await hosts.serves(burrowId).catch(() => false))) return null;
  const fleet = await hosts.fleetRaw().catch(() => null);
  if (!fleet) return null;
  const want = raw.trim().toLowerCase();
  const cards = arr(fleet.servers).map(obj);
  const card =
    cards.find((c) => String(c.id).toLowerCase() === want) ??
    cards.find((c) => String(c.hostname ?? '').toLowerCase() === want);
  if (!card) return null;
  const id = String(card.id);
  return { kind: 'server', id, name: id };
}

/** `thing` as this turn may see it (a thing id, a connection's handle, a server's name), or null. */
export async function resolveReportThing(turn: ReportTurn, thing: string): Promise<ResolvedThing | null> {
  const { services } = turn;
  const visible = await visibleConnections(services.db, turn.agentId, turn.dispatch);
  const asConnection = (c: (typeof visible)[number], kind: 'connection' | 'device'): ResolvedThing => ({
    subject: {
      kind,
      id: c.row.id,
      name: nameWithoutAddress(c.row.label, c.entry, c.row.fields).slice(0, 120),
    },
  });
  const parsed = parseThingId(thing.trim());
  if (parsed) {
    if (parsed.kind === 'server') {
      const server = await serverNamed(services, turn.burrowId, parsed.id);
      return server ? { subject: server } : null;
    }
    const found = visible.find((c) => c.row.id === parsed.id);
    return found ? asConnection(found, parsed.kind) : null;
  }
  const byHandle = visible.find((c) => c.handle === thing.trim().toLowerCase());
  if (byHandle) return asConnection(byHandle, byHandle.row.catalogId === 'device' ? 'device' : 'connection');
  const server = await serverNamed(services, turn.burrowId, thing);
  return server ? { subject: server } : null;
}

const refused = (code: 'unknown_thing' | 'unknown_change' | 'already_undone' | 'capped', reason: string) => ({
  status: 'refused' as const,
  code,
  reason,
});

/** Records an agent's report (signed by the agent), in the turn's chat. */
export const reportChangeCommand = defineCommand({
  name: 'report_change',
  schema: z.object({
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(1000).optional(),
    subject: z.object({ kind: z.string(), id: z.string(), name: z.string().optional() }).nullable(),
    undo: z.string().trim().min(1).max(1000).optional(),
    undoes: z.string().max(64).optional(),
    conversationId: z.string().max(64),
    personId: z.string().max(64).nullable(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents report changes.');
    const [made] = await tx
      .select({ n: count() })
      .from(changes)
      .where(
        and(
          eq(changes.agentId, ctx.actor.id),
          eq(changes.kind, REPORT_KIND),
          gte(changes.createdAt, new Date(ctx.now.getTime() - 60 * 60_000)),
        ),
      );
    if ((made?.n ?? 0) >= REPORTS_PER_HOUR)
      return refused(
        'capped',
        'You reported many changes in the last hour; report only the ones a person cares about.',
      );
    let earlier: ChangeRow | null = null;
    if (input.undoes) {
      const [row] = await tx.select().from(changes).where(eq(changes.id, input.undoes)).for('update');
      // Only a change of this burrow this agent made (reported or through a tool).
      if (!row || row.burrowId !== ctx.burrow.id || row.agentId !== ctx.actor.id)
        return refused('unknown_change', `There is no change ${input.undoes} of yours to put back.`);
      if (row.undoneAt) return refused('already_undone', 'That change was put back already.');
      earlier = row;
    }
    const changeId = await recordChange(ctx, {
      burrowId: ctx.burrow.id,
      actorId: ctx.actor.id,
      agentId: ctx.actor.id,
      personId: input.personId,
      kind: REPORT_KIND,
      title: input.title,
      detail: input.detail ?? null,
      subject: input.subject,
      // A change that puts another back has no Undo of its own (as the other undoes').
      undo:
        input.undo && !earlier
          ? {
              kind: REPORT_KIND,
              payload: { note: input.undo } satisfies ReportUndo,
              until: new Date(ctx.now.getTime() + CHANGE_UNDO_WINDOW_S * 1000),
            }
          : null,
      link:
        input.subject && ['server', 'connection', 'device'].includes(input.subject.kind)
          ? thingHref(input.subject.kind as 'server' | 'connection' | 'device', input.subject.id)
          : null,
      conversationId: input.conversationId,
      at: ctx.now,
      undoes: earlier ? { changeId: earlier.id, byId: earlier.undoAskedById ?? ctx.actor.id } : null,
    });
    await ctx.emit({
      type: 'change.reported',
      kind: 'System',
      text: input.title,
      where: null,
      payload: { changeId, ...(earlier ? { undoes: earlier.id } : {}) },
    });
    publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['doneRecently']);
    return { status: 'ok' as const, changeId };
  },
});

/** The `report_change` tool: resolves `thing` for this turn, then records the report. */
export async function reportChange(
  turn: ReportTurn,
  input: { title: string; detail?: string; thing?: string; undo?: string; undoes?: string },
): Promise<ReportChangeOutput> {
  const thing = input.thing ? await resolveReportThing(turn, input.thing) : null;
  if (input.thing && !thing)
    return refused(
      'unknown_thing',
      `There is no “${input.thing}” you can see here. Name a server (server:pve-02) or a connection’s handle.`,
    );
  const res = await turn.services.pipeline.commit(
    reportChangeCommand,
    {
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      subject: thing?.subject ?? null,
      ...(input.undo ? { undo: input.undo } : {}),
      ...(input.undoes ? { undoes: input.undoes } : {}),
      conversationId: turn.dispatch.conversationId,
      personId: turn.personId,
    },
    { burrowId: turn.burrowId, actorId: turn.agentId },
  );
  if (res.status === 'ok') return res.result;
  if (res.status === 'pending_approval')
    return {
      status: 'pending_approval',
      approvalId: res.approvalId,
      approvalNumber: res.approvalNumber,
      eventId: res.eventId,
      message: res.message,
    };
  return { status: 'blocked', keyNeeded: res.keyNeeded, eventId: res.eventId, message: res.message };
}

/** The person asks the agent to put a reported change back: their message in its chat, and the agent woken there. */
export const askToUndoCommand = defineCommand({
  name: 'ask_to_undo_change',
  schema: z.object({ changeId: z.string().max(64) }),
  // A new turn: a lapsed appliance refuses it up front (LC-10).
  licence: 'agentTurn',
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only people undo changes.');
    const [row] = await tx.select().from(changes).where(eq(changes.id, input.changeId)).for('update');
    if (!row || row.burrowId !== ctx.burrow.id || row.kind !== REPORT_KIND || !row.agentId)
      throw notFound('Change');
    if (row.undoneAt) throw conflict('This was undone already.');
    if (row.undoAskedAt && ctx.now.getTime() - row.undoAskedAt.getTime() < UNDO_ASK_WINDOW_MS)
      throw conflict(ALREADY_UNDOING_TEXT);
    const agent = await loadPrincipalRow(tx, row.agentId);
    const person = await loadPrincipalRow(tx, ctx.actor.id);
    const conversation = row.conversationId ? await loadConversationRow(tx, row.conversationId) : null;
    const nobody = conflict(
      `Only the person ${agent ? shortName(agent) : 'the assistant'} made this for can ask to undo it.`,
    );
    if (!agent || !person?.accountId || !conversation) throw nobody;
    // In Chat (chat-channel.md CHT-02, CHT-08) the ask goes into the thread the change was made in, while it is there,
    // else it starts its own; the assistant answers in that thread.
    const threaded = threadedRoom(conversation);
    const [root] =
      threaded && row.threadRootId
        ? await tx
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.id, row.threadRootId), eq(messages.conversationId, conversation.id)))
        : [];
    let posted: { id: string };
    try {
      posted = await postMessage(ctx, {
        conversation,
        text: undoRequestText(row.title),
        threadRootId: root?.id ?? null,
        clientId: undoRequestClientId(row.id, ctx.now),
        dispatch: false,
      });
    } catch {
      throw nobody;
    }
    const woken = await wakeQuietly(ctx, {
      agentId: agent.id,
      conversationId: conversation.id,
      threadRootId: threaded ? (root?.id ?? posted.id) : null,
      person: person.accountId,
      trigger: 'undo_requested',
      coalesce: false,
      own: true,
      messageId: posted.id,
    });
    // Nobody to put it back for this person here: nothing is posted (the commit rolls back).
    if (!woken) throw nobody;
    await tx
      .update(changes)
      .set({ undoAskedAt: ctx.now, undoAskedById: ctx.actor.id })
      .where(eq(changes.id, row.id));
    return { conversationId: conversation.id, messageId: posted.id };
  },
});

/** Undo of a reported change: ask the agent that made it (HR-03). */
const askAgentToUndo: DirectUndoer = async (ctx, change) => {
  const res = await ctx.services.pipeline.commit(
    askToUndoCommand,
    { changeId: change.id },
    { burrowId: ctx.burrowId, actorId: ctx.person.id },
  );
  if (res.status !== 'ok') return { ok: false, reason: res.message };
  return { ok: true, state: 'requested', conversationId: res.result.conversationId };
};

registerDirectUndoer(REPORT_KIND, askAgentToUndo);

/**
 * `DispatchContext.undoRequest` of an `undo_requested` turn: the change its trigger message asks to undo, with the
 * agent's own note, when the change is this agent's and that person asked; null for any other turn.
 */
export async function undoRequestOf(
  db: Db,
  services: Pick<Services, 'custody'>,
  row: { trigger: string; agentId: string; burrowId: string },
  trigger: Pick<Message, 'clientId' | 'authorId'> | null,
): Promise<NonNullable<DispatchContext['undoRequest']> | null> {
  if (row.trigger !== 'undo_requested' || !trigger) return null;
  const changeId = undoRequestOrigin(trigger.clientId);
  if (!changeId) return null;
  const [change] = await db.select().from(changes).where(eq(changes.id, changeId));
  if (
    !change ||
    change.burrowId !== row.burrowId ||
    change.agentId !== row.agentId ||
    change.undoAskedById !== trigger.authorId ||
    change.undoneAt
  )
    return null;
  const opened = openChange(services.custody, change);
  const note = (opened?.undo.payload as Partial<ReportUndo> | null)?.note;
  return {
    changeId: change.id,
    title: change.title.slice(0, 200),
    undo: typeof note === 'string' ? note.slice(0, 1000) : '',
  };
}

export const REPORT_COMMANDS = [reportChangeCommand, askToUndoCommand];
