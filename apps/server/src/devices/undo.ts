/**
 * Undo for a device action (docs/decisions/one-whombat.md ONE-08; one-whombat-devices.md ONE-DD09): the recipe holds the
 * value before and the value set. Undo checks the skill is still the one that made the change, then — after the
 * `undo_change` commit — reads the device: if the value is still the one Whombat set, the old value goes back as a new
 * call by the same Whombat through the pipeline (keys, tiers, the person's limits and approvals apply again, and that
 * call records its own change, marking this one undone); if someone changed it since, Whombat says so in the chat and
 * leaves it.
 */
import { catalogEntry, conversationLabel, lookOnlyText, toolOffText } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { sendMessage } from '../commands/messages';
import {
  callArgsAad,
  callConnectionTool,
  callTier,
  executeConnectionCall,
  newCallId,
} from '../connections/call';
import { callTarget, changedSinceChangeText, undoGoesWhereChangeWent } from '../connections/call-target';
import { keyTierOf } from '../connections/context';
import { limitsProblem } from '../connections/limits';
import { catalogConnections, connectionTools } from '../db/schema/index';
import { type RecordedChange, registerUndoer } from '../home/registry';
import { loadConversationRow } from '../read/conversations';
import { loadGrants } from '../read/principals';
import type { Services } from '../services';
import { readActionValue } from './driver';
import { deviceNoun } from './profile';
import { DEVICE_UNDO_KIND, type DeviceUndo, linkUndo } from './run';
import { actionOfTool, addressOf, limitWordsFor, skillOfConnection, slugOf } from './store';

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return a === b;
}

async function say(services: Services, change: RecordedChange, text: string): Promise<void> {
  if (!change.agentId || !change.conversationId) return;
  await services.pipeline
    .commit(
      sendMessage,
      { conversationId: change.conversationId, text },
      { burrowId: change.burrowId, actorId: change.agentId },
    )
    .catch((err: unknown) =>
      services.log.warn({ err: err instanceof Error ? err.message : 'error' }, 'devices: could not say why'),
    );
}

/** The inverse call, as the assistant that made the change, for the person who pressed Undo. */
export async function undoDeviceChange(
  services: Services,
  change: RecordedChange,
  byId: string,
): Promise<void> {
  const undo = change.undo.payload as DeviceUndo;
  const agentId = change.agentId;
  if (!agentId) return;
  const [row] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, undo.connectionId));
  const skill = row ? await skillOfConnection(services.db, row.id) : null;
  const action = row && skill ? actionOfTool(skill.profile, slugOf(row), undo.tool) : null;
  const entry = row ? catalogEntry(row.catalogId) : null;
  if (!row || !skill || !action || !entry || skill.profileHash !== undo.profileHash) {
    await say(services, change, 'That device’s skill changed since, so I can’t undo this.');
    return;
  }
  // Given another address or another device's skill since: the old value would go elsewhere.
  if (!undoGoesWhereChangeWent(row, undo.destination)) {
    await say(services, change, changedSinceChangeText(row.label));
    return;
  }
  const now = await readActionValue(services, skill.profile, addressOf(skill), action).catch(() => null);
  if (now === null) {
    await say(services, change, `I couldn’t read ${deviceNoun(skill.name)} just now, so I didn’t undo it.`);
    return;
  }
  if (!sameValue(now, undo.setTo)) {
    await say(
      services,
      change,
      `${capital(deviceNoun(skill.name))}’s ${action.label.toLowerCase()} was changed again since, so I left it as it is.`,
    );
    return;
  }
  const [tool] = await services.db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, undo.tool)));
  if (!tool) return;
  const args = { value: undo.value };
  const grants = await loadGrants(services.db, agentId);
  const decided = callTier(entry, tool, args, (keyId) => keyTierOf(agentId, grants, keyId), row.access);
  const refused = decided.lookOnly
    ? lookOnlyText(row.label)
    : decided.toolTier === 'off'
      ? toolOffText(tool.name, row.label)
      : limitsProblem(tool.limits, args, await limitWordsFor(services.db, row, tool));
  if (refused) {
    await say(services, change, `I couldn’t undo that: ${refused}`);
    return;
  }
  const callId = newCallId();
  linkUndo(callId, change.id, byId);
  // Bound to where the change went: a device repointed while it starts gets nothing.
  const target = undo.destination ?? callTarget(row);
  const res = await services.pipeline.commit(
    callConnectionTool,
    {
      connectionId: row.id,
      handle: row.handle,
      tool: tool.name,
      toolHash: tool.hash,
      callId,
      argsEnc: services.custody.seal(callArgsAad(callId), JSON.stringify(args)),
      ...(change.conversationId ? { conversationId: change.conversationId } : {}),
      target,
    },
    { burrowId: change.burrowId, actorId: agentId, onBehalfOf: { principalId: byId } },
  );
  if (res.status === 'blocked') {
    await say(services, change, `I couldn’t undo that: ${res.message}`);
    return;
  }
  // Asking first: the approval card says so, and the yes runs it (and marks this change undone).
  if (res.status !== 'ok') return;
  const conversation = change.conversationId
    ? await loadConversationRow(services.db, change.conversationId)
    : null;
  const result = await executeConnectionCall(services, {
    burrowId: change.burrowId,
    agentId,
    connectionId: row.id,
    tool: tool.name,
    handle: row.handle,
    callId,
    args,
    where: conversation ? (conversation.kind === 'dm' ? 'A DM' : conversationLabel(conversation)) : null,
    conversationId: change.conversationId,
    personId: byId,
    target,
  });
  if (result.kind === 'failed') await say(services, change, `I couldn’t undo that: ${result.message}`);
  else if (result.output.isError)
    await say(services, change, `I couldn’t undo that: ${result.output.content}`);
}

/** Registered once: `device.set` (ONE-DW06: the inverse runs after the `undo_change` commit, as a new call). */
export function registerDeviceUndo(): void {
  registerUndoer(DEVICE_UNDO_KIND, async (ctx, change, actor) => {
    const undo = change.undo.payload as Partial<DeviceUndo> | null;
    if (!undo?.connectionId || !undo.tool || undo.value === undefined || !change.agentId)
      return { ok: false, reason: 'This change can’t be undone.' };
    const skill = await skillOfConnection(ctx.tx, undo.connectionId);
    if (!skill) return { ok: false, reason: 'That device isn’t switched on any more.' };
    if (skill.profileHash !== undo.profileHash)
      return { ok: false, reason: 'That device’s skill changed since, so this can’t be undone.' };
    const [row] = await ctx.tx
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, undo.connectionId));
    if (row && !undoGoesWhereChangeWent(row, undo.destination))
      return { ok: false, reason: changedSinceChangeText(row.label) };
    const services = ctx.services;
    // Not waited for: Undo answers at once, the device is read and set after (ONE-DD09).
    ctx.background('device undo', () => undoDeviceChange(services, change, actor.id));
    return { ok: true };
  });
}
