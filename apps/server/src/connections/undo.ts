/**
 * Undo of a connection change (docs/decisions/one-whombat.md ONE-08; one-whombat-assistant.md ONE-DW19): the inverse
 * is a new `call_connection_tool` by the Whombat that made the change, for the person who pressed Undo — the keys, the
 * tool's tier and approvals decide it again. A call that runs now answers `undone` (its own recorded change marks the
 * original undone through its call id); one that asks answers `asked` with the approval's number; a refusal says why in
 * plain words.
 */
import { and, eq } from 'drizzle-orm';
import { catalogConnections, connectionTools } from '../db/schema/index';
import type { DirectUndoCtx, DirectUndoResult, RecordedChange } from '../home/registry';
import { ApiError } from '../lib/errors';
import { callArgsAad, callConnectionTool, executeConnectionCall } from './call';
import { callTarget, changedSinceChangeText, undoGoesWhereChangeWent } from './call-target';
import { type ConnectionUndo, undoCallId } from './changes';

function isConnectionUndo(value: unknown): value is ConnectionUndo {
  const v = value as ConnectionUndo | null;
  return (
    !!v &&
    typeof v.connectionId === 'string' &&
    typeof v.tool === 'string' &&
    !!v.args &&
    typeof v.args === 'object' &&
    !Array.isArray(v.args)
  );
}

export async function undoConnectionChange(
  ctx: DirectUndoCtx,
  change: RecordedChange,
): Promise<DirectUndoResult> {
  const undo = change.undo.payload;
  if (!isConnectionUndo(undo) || !change.agentId)
    return { ok: false, reason: 'This can’t be undone any more.' };
  const { services, burrowId, person } = ctx;
  const [row] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, undo.connectionId));
  if (!row) return { ok: false, reason: 'That connection is gone, so this can’t be undone.' };
  // Repointed at another service or account since: the inverse would land there, not where the change went.
  if (!undoGoesWhereChangeWent(row, undo.destination))
    return { ok: false, reason: changedSinceChangeText(row.label) };
  const [tool] = await services.db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, undo.tool)));
  if (!tool) return { ok: false, reason: `${row.label} can’t do that any more, so this can’t be undone.` };
  const callId = undoCallId(change.id, person.id);
  const argsEnc = services.custody.seal(callArgsAad(callId), JSON.stringify(undo.args));
  // The inverse is bound to where the change went: a connection repointed while it starts sends nothing.
  const target = typeof undo.destination === 'string' ? undo.destination : callTarget(row);
  let res: Awaited<ReturnType<typeof services.pipeline.commit<typeof callConnectionTool.schema, unknown>>>;
  try {
    res = await services.pipeline.commit(
      callConnectionTool,
      {
        connectionId: row.id,
        handle: row.handle,
        tool: tool.name,
        toolHash: tool.hash,
        callId,
        argsEnc,
        ...(change.conversationId ? { conversationId: change.conversationId } : {}),
        target,
      },
      { burrowId, actorId: change.agentId, onBehalfOf: { principalId: person.id, text: person.shortName } },
    );
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, reason: err.message };
    throw err;
  }
  if (res.status === 'blocked') return { ok: false, reason: res.message };
  if (res.status === 'pending_approval')
    return { ok: true, state: 'asked', approvalNumber: res.approvalNumber };
  const result = await executeConnectionCall(services, {
    burrowId,
    agentId: change.agentId,
    connectionId: row.id,
    tool: tool.name,
    handle: row.handle,
    callId,
    args: undo.args,
    where: null,
    conversationId: change.conversationId,
    target,
  });
  if (result.kind === 'failed') return { ok: false, reason: `It didn’t work: ${result.message}` };
  if (result.output.isError)
    return { ok: false, reason: `${row.label} didn’t accept it, so nothing changed.` };
  return { ok: true, state: 'undone' };
}
