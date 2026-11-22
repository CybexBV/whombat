/**
 * Undo for server changes (one-whombat.md ONE-08; one-whombat-servers.md ONE-DH12, ONE-DH13). The recipes:
 *
 * - `hosts.guest_power` `{serverId, guestId, guestName, action}`: the inverse action (start ↔ shut down or stop, pause ↔
 *   resume; a restart has none).
 * - `hosts.guest_config` `{serverId, guestId, guestName, set, delete, expect}`: the previous values back, only while the
 *   values are still what the change made them (`expect`); masked secrets are never restored.
 * - `hosts.server_settings` `{serverId, patch}`: the previous group, location, parent and switches.
 * - `hosts.alert_ack` `{alertId, title}`: the acknowledgement or snooze taken back.
 * - `hosts.tool_inverse` `{tool, args, serverId, expect?}`: a Servers tool's change taken back by the same tool with
 *   the inverse arguments (protect ↔ unprotect, the previous notes, firewall on ↔ off, a rule's on ↔ off, a backup job's
 *   pause ↔ resume and add ↔ remove a guest, HA set → removed). Whombat's changes only; `expect` names what must still
 *   hold (a backup's notes as Whombat wrote them).
 *
 * Who runs the inverse: a change Whombat made through the Servers tools is undone by the same Whombat with a new
 * `connection_call` (keys, tiers and approvals apply again; a sensitive inverse asks), scheduled after the Undo commit;
 * the person's change is undone by them when they press Undo (ONE-DH05), on the hosts service at once. Taking back a
 * snooze never needs a tool.
 */
import { catalogEntry, type HostGuestAction, type HostManageResult, thingHref } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { externalEffect } from '../commit/scope';
import type { ApplyContext } from '../commit/types';
import {
  callArgsAad,
  callConnectionTool,
  callTier,
  executeConnectionCall,
  newCallId,
  otherTargetsOf,
} from '../connections/call';
import { callTarget, changedSinceChangeText, undoGoesWhereChangeWent } from '../connections/call-target';
import { keyTierOf } from '../connections/context';
import { currentRow } from '../connections/http';
import { catalogConnections, connectionTools } from '../db/schema/index';
import { assistantCalled } from '../home/assistant-name';
import { type RecordedChange, recordChange, registerUndoer, type UndoResult } from '../home/registry';
import { type ActorInfo, loadGrants, loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { callServerOf } from './asks';
import { HOSTS_API, HostsError, HostsUnavailable, seg } from './client';
import { hostsErrorText, refusedBeforeActing } from './errors';
import { obj, str, toHostGuestConfig } from './map';
import { serverLabel } from './self';
import { actorOf, HOSTS_TEXT, hostsFor } from './service';

/* Recipes (pure) --------------------------------------------------------------------------------------------------- */

/** The action that puts a guest back, or null (a restart, a snapshot, Ctrl+Alt+Del). */
export function powerInverse(action: string, kind: 'vm' | 'container'): HostGuestAction | null {
  switch (action) {
    case 'start':
      return kind === 'vm' ? 'shutdown' : 'stop';
    case 'stop':
    case 'shutdown':
    case 'force_stop':
      return 'start';
    case 'pause':
      return 'resume';
    case 'resume':
      return 'pause';
    default:
      return null;
  }
}

/** “Started web on pve-02”, “Took a snapshot of web on pve-02”. */
export function powerText(action: string, guest: string, serverId: string, snapshot?: string): string {
  const on = `${guest} on ${serverLabel(serverId)}`;
  switch (action) {
    case 'start':
      return `Started ${on}`;
    case 'shutdown':
      return `Shut down ${on}`;
    case 'stop':
    case 'force_stop':
      return `Stopped ${on}`;
    case 'reboot':
    case 'restart':
      return `Restarted ${on}`;
    case 'pause':
      return `Paused ${on}`;
    case 'resume':
      return `Resumed ${on}`;
    case 'ctrl_alt_del':
      return `Sent Ctrl+Alt+Del to ${on}`;
    case 'snapshot_create':
      return `Took a snapshot of ${on}`;
    case 'snapshot_restore':
      return snapshot ? `Put ${on} back to its snapshot ${snapshot}` : `Put ${on} back to a snapshot`;
    case 'snapshot_delete':
      return `Deleted a snapshot of ${on}`;
    default:
      return `Changed ${on}`;
  }
}

export interface ConfigUndo {
  serverId: string;
  guestId: string;
  guestName: string | null;
  set: Record<string, string>;
  delete: string[];
  /** What the change made them: Undo runs only while they still are. */
  expect: Record<string, string | null>;
  /** Where an assistant's change went (`tools-shared.ts` `withDestination`): its inverse goes only there. */
  destination?: string;
}

const masked = (v: string | undefined) => v !== undefined && /^\*{4,}$/.test(v);

/** The recipe that puts a configuration back from a change's `old → new` list, or null when nothing can be. */
export function configUndo(
  serverId: string,
  guestId: string,
  guestName: string | null,
  result: Pick<HostManageResult, 'changes'>,
): ConfigUndo | null {
  const set: Record<string, string> = {};
  const del: string[] = [];
  const expect: Record<string, string | null> = {};
  for (const c of result.changes ?? []) {
    if (masked(c.old) || masked(c.new)) continue;
    if (c.old !== undefined) set[c.key] = c.old;
    else del.push(c.key);
    expect[c.key] = c.new ?? null;
  }
  if (Object.keys(set).length === 0 && del.length === 0) return null;
  return { serverId, guestId, guestName, set, delete: del, expect };
}

/** The keys of a configuration whose values are no longer what the change made them. */
export function configDrift(
  values: Readonly<Record<string, string>>,
  expect: Readonly<Record<string, string | null>>,
): string[] {
  return Object.entries(expect)
    .filter(([k, v]) => (v === null ? values[k] !== undefined : values[k] !== v))
    .map(([k]) => k);
}

export interface SettingsUndo {
  serverId: string;
  patch: {
    group?: string;
    location?: string;
    parent?: string;
    remoteControl?: Record<string, boolean>;
  };
}

/** The previous values of what a settings patch changes (from the settings read before it), or null. */
export function settingsUndo(
  serverId: string,
  patch: {
    group?: string;
    location?: string;
    parent?: string;
    remoteControl?: Partial<Record<string, boolean>>;
  },
  before: unknown,
): SettingsUndo | null {
  const b = obj(before);
  const out: SettingsUndo['patch'] = {};
  if (patch.group !== undefined && str(b.group) !== null && b.group !== patch.group)
    out.group = b.group as string;
  if (patch.location !== undefined && b.location !== patch.location) out.location = str(b.location) ?? '';
  if (patch.parent !== undefined && b.parent !== patch.parent) out.parent = str(b.parent) ?? '';
  if (patch.remoteControl) {
    const rc = obj(b.remote_control);
    const names: Record<string, string> = {
      console: 'console',
      power: 'power',
      hostShell: 'host_shell',
      hostPower: 'host_power',
      manage: 'manage',
      diagnose: 'diagnose',
    };
    const prev: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(patch.remoteControl)) {
      const old = rc[names[k] ?? k];
      if (typeof v === 'boolean' && typeof old === 'boolean' && old !== v) prev[k] = old;
    }
    if (Object.keys(prev).length) out.remoteControl = prev;
  }
  return Object.keys(out).length ? { serverId, patch: out } : null;
}

/* The inverse as the assistant's own call -------------------------------------------------------------------------- */

/** Calls started by an Undo, waiting to record their change with `undoes` (this process only). */
const pendingUndo = new Map<string, { changeId: string; byId: string; at: number }>();

/** The Undo a call answers, once (the Servers tools read it when they record their change). */
export function takePendingUndo(callId: string): { changeId: string; byId: string } | null {
  const hit = pendingUndo.get(callId);
  if (!hit) return null;
  pendingUndo.delete(callId);
  return { changeId: hit.changeId, byId: hit.byId };
}

/** The other connections' destinations a change kept (`otherDestinations`), by id; none when it kept none. */
export function keptDestinations(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && /^[0-9a-f]{64}$/.test(e[1]),
    ),
  );
}

/** The tool vocabulary of a hub power action, or null when the tool can't (a restart, Ctrl+Alt+Del). */
export function toolPowerAction(
  hubAction: string,
): 'start' | 'stop' | 'shutdown' | 'pause' | 'resume' | null {
  if (hubAction === 'start') return 'start';
  if (hubAction === 'shutdown') return 'shutdown';
  if (hubAction === 'stop' || hubAction === 'force_stop') return 'stop';
  if (hubAction === 'pause' || hubAction === 'resume') return hubAction;
  return null;
}

async function serversConnection(services: Services, burrowId: string) {
  const [row] = await services.db
    .select()
    .from(catalogConnections)
    .where(
      and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.catalogId, 'whombat_servers')),
    );
  return row ?? null;
}

/**
 * Decides an inverse call as the change's assistant would (pure part: tier, key) and, when it may run or ask, schedules
 * it after the Undo commit: committed as `call_connection_tool` (Ask → an approval card where the change was made), run
 * at once when allowed.
 */
async function undoAsAssistant(
  ctx: ApplyContext,
  change: RecordedChange,
  actor: ActorInfo,
  tool: string,
  args: Record<string, unknown>,
): Promise<UndoResult> {
  const services = ctx.services;
  const agentId = change.agentId as string;
  // The refusals name the assistant that made the change (assistant-name.md AN-01).
  const who = assistantCalled((await loadPrincipalRow(services.db, agentId))?.name);
  const row = await serversConnection(services, change.burrowId);
  if (row?.status !== 'active') return { ok: false, reason: HOSTS_TEXT.down };
  // Where the change's call went (`destination`, kept when it was made), and each other connection it acted through
  // (`otherDestinations`): the inverse goes only there.
  const payload = change.undo.payload as { destination?: unknown; otherDestinations?: unknown } | null;
  const destination = payload?.destination;
  if (!undoGoesWhereChangeWent(row, destination))
    return { ok: false, reason: changedSinceChangeText(row.label) };
  const keptOthers = keptDestinations(payload?.otherDestinations);
  for (const [id, went] of Object.entries(keptOthers)) {
    const other = await currentRow(services, id);
    if (!other || other.burrowId !== row.burrowId || !undoGoesWhereChangeWent(other, went))
      return { ok: false, reason: changedSinceChangeText(other?.label ?? row.label) };
  }
  const [toolRow] = await services.db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, tool)));
  const entry = catalogEntry(row.catalogId);
  if (!toolRow || !entry) return { ok: false, reason: `${who} can’t do that on your servers any more.` };
  const grants = await loadGrants(services.db, agentId);
  // A server set not to ask runs the inverse at once too (server-asks.md SA-06).
  const server = await callServerOf(services.db, services, row.burrowId, row.catalogId, args);
  const tier = callTier(
    entry,
    toolRow,
    args,
    (keyId) => keyTierOf(agentId, grants, keyId),
    row.access,
    server,
  );
  if (tier.lookOnly || tier.tier === 'off')
    return {
      ok: false,
      reason: `${tool === 'guest_power' ? 'Starting and stopping guests' : tool === 'guest_config_set' ? 'Changing guests' : 'That change'} is turned off for ${who}.`,
    };
  if (tier.keyTier === 'cannot') return { ok: false, reason: `${who} may not change your servers.` };
  const callId = newCallId();
  pendingUndo.set(callId, { changeId: change.id, byId: actor.id, at: Date.now() });
  for (const [k, v] of pendingUndo) if (Date.now() - v.at > 24 * 3600_000) pendingUndo.delete(k);
  const argsEnc = services.custody.seal(callArgsAad(callId), JSON.stringify(args));
  // Where the change went, and as whom: a yes to the inverse is bound to that, as any call's is; another connection the
  // inverse acts through that the change didn't keep, to where it goes now.
  const target = typeof destination === 'string' ? destination : callTarget(row);
  const others = { ...(await otherTargetsOf(services, row, tool, args)), ...keptOthers };
  const burrowId = change.burrowId;
  const conversationId = change.conversationId;
  // What the inverse says, and a task it starts, goes in the thread the change was made in (task-feedback.md TF-S11).
  const threadRootId = change.threadRootId ?? null;
  ctx.after(async () => {
    try {
      const res = await services.pipeline.commit(
        callConnectionTool,
        {
          connectionId: row.id,
          handle: row.handle,
          tool,
          toolHash: toolRow.hash,
          callId,
          argsEnc,
          ...(conversationId ? { conversationId } : {}),
          target,
          others,
        },
        { burrowId, actorId: agentId, onBehalfOf: { principalId: change.personId ?? actor.id } },
      );
      if (res.status !== 'ok' || res.result.deferred) return;
      await executeConnectionCall(services, {
        burrowId,
        agentId,
        connectionId: row.id,
        tool,
        handle: row.handle,
        callId,
        args,
        where: null,
        conversationId,
        threadRootId,
        personId: change.personId ?? actor.id,
        target,
        others,
      });
    } catch (err) {
      pendingUndo.delete(callId);
      services.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'hosts: an undo call failed',
      );
    }
  });
  // A call that asks leaves the change's Undo until the yes runs it (its change marks this one, one-whombat-assistant.md).
  return tier.tier === 'ask' ? { ok: true, state: 'asked' } : { ok: true };
}

/* The inverse as the person who pressed Undo ----------------------------------------------------------------------- */

function ownerCheck(actor: ActorInfo): UndoResult | null {
  return actor.kind === 'person' ? null : { ok: false, reason: 'Only you can change servers.' };
}

/** Runs the inverse on the service as the person (inside the Undo commit) and records it as undoing the change. */
async function undoAsPerson(
  ctx: ApplyContext,
  change: RecordedChange,
  actor: ActorInfo,
  what: {
    op: string;
    serverId: string;
    guestId?: string;
    text: string;
    names: { server?: string; guest?: string };
  },
  run: (hostsActor: ReturnType<typeof actorOf>) => Promise<unknown>,
): Promise<UndoResult> {
  const hosts = hostsFor(ctx.services);
  if (!hosts.present) return { ok: false, reason: HOSTS_TEXT.absent };
  const hostsActor = actorOf(actor, actor.kind === 'person' ? 'admin' : 'operator');
  try {
    await externalEffect(`hosts.undo.${what.op}`, () => run(hostsActor), {
      refused: (err) => refusedBeforeActing(err) || err instanceof HostsUnavailable,
    });
  } catch (err) {
    if (err instanceof HostsError) return { ok: false, reason: hostsErrorText(err, what.names) };
    if (err instanceof HostsUnavailable) return { ok: false, reason: HOSTS_TEXT.down };
    throw err;
  }
  hosts.forget('fleet', 'agents');
  await ctx.emit({
    type: 'hosts.change',
    kind: 'System',
    text: what.text,
    where: `Servers · ${serverLabel(what.serverId)}`,
    payload: {
      op: what.op,
      serverId: what.serverId,
      ...(what.guestId ? { guestId: what.guestId } : {}),
      undoes: change.id,
    },
  });
  await recordChange(ctx, {
    burrowId: change.burrowId,
    actorId: actor.id,
    personId: actor.id,
    kind: `hosts.${what.op}`,
    title: what.text,
    subject: change.subject,
    link: thingHref('server', what.serverId),
    conversationId: change.conversationId,
    at: ctx.now,
    undoes: { changeId: change.id, byId: actor.id },
  });
  return { ok: true };
}

/* Undoers ---------------------------------------------------------------------------------------------------------- */

/** A change whose undo payload says too little (no assistant is meant: Undo is the box's, AN-01). */
const CANT_UNDO_TEXT = 'This one can’t be undone.';

interface PowerPayload {
  serverId: string;
  guestId: string;
  guestName?: string | null;
  action: string;
}

async function undoPower(ctx: ApplyContext, change: RecordedChange, actor: ActorInfo): Promise<UndoResult> {
  const p = change.undo.payload as PowerPayload;
  if (!p?.serverId || !p.guestId || !p.action) return { ok: false, reason: CANT_UNDO_TEXT };
  const name = p.guestName || p.guestId;
  const toolAction = toolPowerAction(p.action);
  if (change.agentId && toolAction)
    return undoAsAssistant(ctx, change, actor, 'guest_power', {
      server: p.serverId,
      guest: p.guestId,
      action: toolAction,
    });
  const refused = ownerCheck(actor);
  if (refused) return refused;
  return undoAsPerson(
    ctx,
    change,
    actor,
    {
      op: 'guest_power',
      serverId: p.serverId,
      guestId: p.guestId,
      text: powerText(p.action, name, p.serverId),
      names: { server: p.serverId, guest: name },
    },
    (hostsActor) =>
      hostsFor(ctx.services).call({
        method: 'POST',
        path: `${HOSTS_API}/servers/${seg(p.serverId)}/guests/${seg(p.guestId)}/actions`,
        body: {
          action: p.action,
          ...(p.action === 'start' || p.action === 'resume' ? {} : { confirm: true }),
        },
        actor: hostsActor,
        timeoutMs: 10_000,
      }),
  );
}

async function undoConfig(ctx: ApplyContext, change: RecordedChange, actor: ActorInfo): Promise<UndoResult> {
  const p = change.undo.payload as ConfigUndo;
  if (!p?.serverId || !p.guestId) return { ok: false, reason: CANT_UNDO_TEXT };
  const hosts = hostsFor(ctx.services);
  if (!hosts.present) return { ok: false, reason: HOSTS_TEXT.absent };
  const name = p.guestName || p.guestId;
  // What it is now: Undo only puts back what nobody changed again since.
  let current: ReturnType<typeof toHostGuestConfig>;
  try {
    current = toHostGuestConfig(
      await hosts.call({
        path: `${HOSTS_API}/servers/${seg(p.serverId)}/guests/${seg(p.guestId)}/config`,
        actor: actorOf(actor, 'operator'),
        timeoutMs: 10_000,
      }),
    );
  } catch (err) {
    if (err instanceof HostsError)
      return { ok: false, reason: hostsErrorText(err, { server: p.serverId, guest: name }) };
    return { ok: false, reason: HOSTS_TEXT.down };
  }
  if (configDrift(current.values, p.expect).length)
    return {
      ok: false,
      reason: `The settings of ${name} were changed again since, so this can’t be undone.`,
    };
  const body = {
    digest: current.digest,
    ...(Object.keys(p.set).length ? { set: p.set } : {}),
    ...(p.delete.length ? { delete: p.delete } : {}),
  };
  if (change.agentId)
    return undoAsAssistant(ctx, change, actor, 'guest_config_set', {
      server: p.serverId,
      guest: p.guestId,
      ...body,
    });
  const refused = ownerCheck(actor);
  if (refused) return refused;
  return undoAsPerson(
    ctx,
    change,
    actor,
    {
      op: 'guest_config',
      serverId: p.serverId,
      guestId: p.guestId,
      text: `Put back the settings of ${name} on ${serverLabel(p.serverId)}`,
      names: { server: p.serverId, guest: name },
    },
    (hostsActor) =>
      hosts.call({
        method: 'PUT',
        path: `${HOSTS_API}/servers/${seg(p.serverId)}/guests/${seg(p.guestId)}/config`,
        body,
        actor: hostsActor,
        timeoutMs: 30_000,
      }),
  );
}

async function undoSettings(
  ctx: ApplyContext,
  change: RecordedChange,
  actor: ActorInfo,
): Promise<UndoResult> {
  const p = change.undo.payload as SettingsUndo;
  if (!p?.serverId || !p.patch) return { ok: false, reason: CANT_UNDO_TEXT };
  const refused = ownerCheck(actor);
  if (refused) return refused;
  const body: Record<string, unknown> = {};
  if (p.patch.group !== undefined) body.group = p.patch.group;
  if (p.patch.location !== undefined) body.location = p.patch.location;
  if (p.patch.parent !== undefined) body.parent = p.patch.parent;
  if (p.patch.remoteControl) {
    const names: Record<string, string> = { hostShell: 'host_shell', hostPower: 'host_power' };
    body.remote_control = Object.fromEntries(
      Object.entries(p.patch.remoteControl).map(([k, v]) => [names[k] ?? k, v]),
    );
  }
  return undoAsPerson(
    ctx,
    change,
    actor,
    {
      op: 'server_settings',
      serverId: p.serverId,
      text: `Put back the settings of ${serverLabel(p.serverId)}`,
      names: { server: p.serverId },
    },
    (hostsActor) =>
      hostsFor(ctx.services).call({
        method: 'PATCH',
        path: `${HOSTS_API}/servers/${seg(p.serverId)}`,
        body,
        actor: hostsActor,
        timeoutMs: 10_000,
      }),
  );
}

async function undoAck(ctx: ApplyContext, change: RecordedChange, actor: ActorInfo): Promise<UndoResult> {
  const p = change.undo.payload as { alertId?: string; title?: string };
  if (!p?.alertId) return { ok: false, reason: CANT_UNDO_TEXT };
  if (actor.kind !== 'person') return { ok: false, reason: 'Only people take a snooze back.' };
  const serverId = change.subject?.kind === 'server' ? change.subject.id : 'whombat';
  return undoAsPerson(
    ctx,
    change,
    actor,
    {
      op: 'alert_unack',
      serverId,
      text: `Took back the snooze of “${(p.title ?? 'an alert').slice(0, 150)}”`,
      names: {},
    },
    (hostsActor) =>
      hostsFor(ctx.services).call({
        method: 'DELETE',
        path: `${HOSTS_API}/alerts/${seg(p.alertId as string)}/ack`,
        actor: { ...hostsActor, role: 'operator' },
        timeoutMs: 10_000,
      }),
  );
}

/** A Servers tool's inverse call (`hosts.tool_inverse`). */
export interface ToolInverse {
  tool: string;
  args: Record<string, unknown>;
  serverId: string;
  /** What must still hold for Undo to run: the notes of a backup as Whombat wrote them. */
  expect?: { backupNotes?: { guestId: string; volume: string; notes: string } } | null;
}

async function undoToolInverse(
  ctx: ApplyContext,
  change: RecordedChange,
  actor: ActorInfo,
): Promise<UndoResult> {
  const p = change.undo.payload as ToolInverse;
  if (!p?.tool || !p.args || !change.agentId) return { ok: false, reason: CANT_UNDO_TEXT };
  const notes = p.expect?.backupNotes;
  if (notes) {
    const hosts = hostsFor(ctx.services);
    if (!hosts.present) return { ok: false, reason: HOSTS_TEXT.absent };
    try {
      const raw = await hosts.call({
        path: `${HOSTS_API}/servers/${seg(p.serverId)}/guests/${seg(notes.guestId)}/backups`,
        actor: actorOf(actor, 'operator'),
        timeoutMs: 15_000,
      });
      const hit = (obj(raw).items as unknown[] | undefined)?.map(obj).find((b) => b.volume === notes.volume);
      if (!hit) return { ok: false, reason: 'That backup isn’t there any more.' };
      if ((str(hit.notes) ?? '') !== notes.notes)
        return {
          ok: false,
          reason: 'The notes of that backup were changed again since, so this can’t be undone.',
        };
    } catch (err) {
      if (err instanceof HostsError)
        return { ok: false, reason: hostsErrorText(err, { server: p.serverId }) };
      return { ok: false, reason: HOSTS_TEXT.down };
    }
  }
  return undoAsAssistant(ctx, change, actor, p.tool, p.args);
}

/** Registers the servers' undoers (idempotent). */
export function registerHostsUndoers(): void {
  registerUndoer('hosts.guest_power', undoPower);
  registerUndoer('hosts.guest_config', undoConfig);
  registerUndoer('hosts.server_settings', undoSettings);
  registerUndoer('hosts.alert_ack', undoAck);
  registerUndoer('hosts.tool_inverse', undoToolInverse);
}
