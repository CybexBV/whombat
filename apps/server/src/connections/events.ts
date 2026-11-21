/**
 * What the burrow's log says about connection tool calls (docs/decisions/connections-catalog.md CX-23):
 * `connection.tool_called` when a call is allowed to run and `connection.tool_finished` when it ran — connection, tool,
 * tier, outcome, milliseconds and output bytes, never the arguments or the output.
 */
import { CHANGE_UNDO_WINDOW_S } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand, type EmitFields } from '../commit/types';
import { catalogConnections } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { recordChange } from '../home/registry';
import { forbidden } from '../lib/errors';
import { CONNECTION_UNDO_KIND, connectionChangeLink, parseUndoCallId } from './changes';

export const CALL_OUTCOMES = ['done', 'error', 'failed', 'timeout', 'busy', 'refused'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

const SAID: Record<CallOutcome, string> = {
  done: 'done',
  error: 'the service reported an error',
  failed: 'failed',
  timeout: 'timed out',
  busy: 'busy',
  refused: 'refused',
};

/** What a call names in the log: the tool and the connection. */
export interface CallNames {
  connectionId: string;
  tool: string;
  handle: string;
  label: string;
}

/** `connection.tool_called` (signed by the agent, in the call's command). */
export function toolCalledFields(
  n: CallNames,
  call: {
    callId: string;
    access: 'read' | 'write';
    tier: 'can' | 'ask';
    deferred: boolean;
    toolHash: string;
  },
  where: string | null,
): EmitFields {
  return {
    type: 'connection.tool_called',
    kind: 'Code',
    text: null,
    where,
    payload: {
      callId: call.callId,
      connectionId: n.connectionId,
      tool: n.tool,
      handle: n.handle,
      toolHash: call.toolHash,
      access: call.access,
      tier: call.tier,
      deferred: call.deferred,
    },
  };
}

export const finishConnectionTool = defineCommand({
  name: 'finish_connection_tool',
  schema: z.object({
    callId: z.string(),
    connectionId: z.string(),
    tool: z.string().max(200),
    handle: z.string().max(40),
    label: z.string().max(80),
    outcome: z.enum(CALL_OUTCOMES),
    ms: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    where: z.string().max(200).nullable(),
    /** A write that worked (ONE-08): its plain title and the call that undoes it, recorded as a change. */
    change: z
      .object({
        title: z.string().min(1).max(200),
        detail: z.string().max(500).optional(),
        undo: z
          .object({
            connectionId: z.string(),
            tool: z.string().max(200),
            args: z.record(z.string(), z.unknown()),
          })
          .optional(),
        conversationId: z.string().nullable(),
      })
      .optional(),
  }),
  async apply(_tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents call connection tools.');
    if (input.change && input.outcome === 'done') await recordConnectionChange(ctx, input, input.change);
    // The last call that worked: Home's “Connected · used today” (home-redesign.md HR-45, CT-404).
    if (input.outcome === 'done')
      await ctx.tx
        .update(catalogConnections)
        .set({ lastWorkedAt: ctx.now })
        .where(eq(catalogConnections.id, input.connectionId));
    await ctx.emit({
      type: 'connection.tool_finished',
      kind: 'Code',
      text: `Used ${input.tool} on ${input.label} · ${SAID[input.outcome]}`.slice(0, 500),
      where: input.where,
      payload: {
        callId: input.callId,
        connectionId: input.connectionId,
        tool: input.tool,
        handle: input.handle,
        outcome: input.outcome,
        ms: input.ms,
        bytes: input.bytes,
      },
    });
    return { ok: true as const };
  },
});

/**
 * Records a connection write as a change (ONE-08, one-whombat-assistant.md ONE-DW18): the Whombat that made it, the
 * person it worked for, the inverse sealed, Undo offered for `CHANGE_UNDO_WINDOW_S`. An Undo's own call marks the
 * change it reverses.
 */
async function recordConnectionChange(
  ctx: ApplyContext,
  call: { callId: string; connectionId: string; label: string },
  change: {
    title: string;
    detail?: string | undefined;
    undo?: { connectionId: string; tool: string; args: Record<string, unknown> } | undefined;
    conversationId: string | null;
  },
): Promise<void> {
  const undoing = parseUndoCallId(call.callId);
  const personId = undoing?.personId ?? (await thePerson(ctx.tx, ctx.burrow.id))?.id ?? null;
  await recordChange(ctx, {
    burrowId: ctx.burrow.id,
    actorId: ctx.actor.id,
    agentId: ctx.actor.id,
    personId,
    kind: 'connection.call',
    title: change.title,
    detail: change.detail ?? null,
    subject: { kind: 'connection', id: call.connectionId, name: call.label },
    undo: change.undo
      ? {
          kind: CONNECTION_UNDO_KIND,
          payload: change.undo,
          until: new Date(ctx.now.getTime() + CHANGE_UNDO_WINDOW_S * 1000),
        }
      : null,
    link: connectionChangeLink(call.connectionId),
    conversationId: change.conversationId,
    at: ctx.now,
    undoes: undoing ? { changeId: undoing.changeId, byId: undoing.personId } : null,
  });
  publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['doneRecently']);
}
