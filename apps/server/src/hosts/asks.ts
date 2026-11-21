/**
 * “Asks you first” per server (docs/decisions/server-asks.md SA-01…SA-09; server-asks-server.md SA-S01…).
 *
 * - `servers.setAsks`: the person sets a server to `risky` (the sensitive Servers calls ask) or `never` (the default:
 *   they don't, but for `server_power` on the server this Whombat runs on, SA-03). Signed `servers.asks_changed`, recorded
 *   for Done recently with an undo (`servers.asks`). The same change is made by a yes with “Don’t ask again on {server}”
 *   (`approvals.decide` `scope: 'agent'`, SA-07), in the decision's commit.
 * - `callServerOf`: the server a Servers call names and its setting, for `callTier` (SA-06).
 */
import { HostAsksFirst, type HostAsksFirst as HostAsksFirstValue, thingHref } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { serverAsks } from '../db/schema/index';
import { type RecordedChange, recordChange, registerUndoer, type UndoResult } from '../home/registry';
import { forbidden } from '../lib/errors';
import type { ActorInfo } from '../read/principals';
import type { Services } from '../services';
import { asksKey, serverAsksOf } from './asks-store';
import { ONLY_YOU_CHANGE_SERVERS_TEXT } from './person';
import { type KnownServer, knownServer } from './self';
import { hostsFor } from './service';

export const SERVERS_CATALOG = 'whombat_servers';

/** Whether this actor may change a server's “Asks you first” (SA-05: the person, as the server's switches). */
export function actorManagesServers(actor: Pick<ActorInfo, 'kind'>): boolean {
  return actor.kind === 'person';
}

/** The signed line and Done recently's title of a change (plain words, SA-08). */
export function asksChangedText(server: string, asks: HostAsksFirstValue): string {
  return asks === 'never'
    ? `Whombat stopped asking first on ${server}`
    : `Whombat asks before risky actions on ${server} again`;
}

interface AsksUndo {
  serverId: string;
  serverName: string;
  before: HostAsksFirstValue;
  after: HostAsksFirstValue;
}

export interface SetAsksInput {
  serverId: string;
  serverName: string;
  asksFirst: HostAsksFirstValue;
  /** A yes with “Don’t ask again on {server}” made it (SA-07). */
  approvalId?: string | null;
  conversationId?: string | null;
  /** This change undoes an earlier one. */
  undoes?: { changeId: string; byId: string } | null;
}

/**
 * Sets a server's “Asks you first” inside a commit, as the context's actor (who must manage servers): the row, the
 * signed `servers.asks_changed`, Done recently with its undo, and realtime's row once committed. Nothing when it is
 * already so.
 */
export async function setServerAsksIn(
  ctx: ApplyContext,
  input: SetAsksInput,
): Promise<{ changed: boolean; before: HostAsksFirstValue; changeId: string | null }> {
  if (!actorManagesServers(ctx.actor)) throw forbidden(ONLY_YOU_CHANGE_SERVERS_TEXT);
  const key = asksKey(input.serverId);
  const before = await serverAsksOf(ctx.tx, ctx.burrow.id, key);
  if (before === input.asksFirst) return { changed: false, before, changeId: null };
  await ctx.tx
    .insert(serverAsks)
    .values({
      burrowId: ctx.burrow.id,
      serverId: key,
      asksFirst: input.asksFirst,
      changedById: ctx.actor.id,
      changedAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: [serverAsks.burrowId, serverAsks.serverId],
      set: { asksFirst: input.asksFirst, changedById: ctx.actor.id, changedAt: ctx.now },
    });
  const text = asksChangedText(input.serverName, input.asksFirst);
  await ctx.emit({
    type: 'servers.asks_changed',
    kind: 'System',
    text,
    where: `Servers · ${input.serverName}`,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    payload: {
      serverId: input.serverId,
      asksFirst: input.asksFirst,
      before,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      ...(input.undoes ? { undoes: input.undoes.changeId } : {}),
    },
  });
  const undo: AsksUndo = {
    serverId: input.serverId,
    serverName: input.serverName,
    before,
    after: input.asksFirst,
  };
  const changeId = await recordChange(ctx, {
    burrowId: ctx.burrow.id,
    actorId: ctx.actor.id,
    personId: ctx.actor.id,
    kind: 'servers.asks',
    title: text,
    subject: { kind: 'server', id: input.serverId, name: input.serverName },
    // An undo's own change has no Undo (as the other server changes').
    undo: input.undoes ? null : { kind: 'servers.asks', payload: undo },
    link: thingHref('server', input.serverId),
    conversationId: input.conversationId ?? null,
    at: ctx.now,
    undoes: input.undoes ?? null,
  });
  const services = ctx.services;
  ctx.after(async () => hostsFor(services).touched(input.serverId));
  return { changed: true, before, changeId };
}

export const SetServerAsksInput = z.object({
  serverId: z.string().trim().min(1).max(200),
  serverName: z.string().trim().min(1).max(120),
  asksFirst: HostAsksFirst,
});

/** `servers.setAsks` (SA-04): the person sets a server's “Asks you first” (`hosts.updateServer` with `asksFirst`). */
export const setServerAsks = defineCommand({
  name: 'servers.setAsks',
  schema: SetServerAsksInput,
  async apply(_tx, ctx, input) {
    return setServerAsksIn(ctx, input);
  },
});

/** Removing a server removes its row (SA-04). */
export async function forgetServerAsks(ctx: ApplyContext, serverId: string): Promise<void> {
  await ctx.tx
    .delete(serverAsks)
    .where(and(eq(serverAsks.burrowId, ctx.burrow.id), eq(serverAsks.serverId, asksKey(serverId))));
}

/** Undo of a change of “Asks you first”: back to what it was, unless someone changed it again since. */
async function undoAsks(ctx: ApplyContext, change: RecordedChange, actor: ActorInfo): Promise<UndoResult> {
  const p = change.undo.payload as Partial<AsksUndo> | null;
  const before = HostAsksFirst.safeParse(p?.before);
  const after = HostAsksFirst.safeParse(p?.after);
  if (!p?.serverId || !before.success || !after.success)
    return { ok: false, reason: 'This one can’t be undone.' };
  if (!actorManagesServers(actor)) return { ok: false, reason: ONLY_YOU_CHANGE_SERVERS_TEXT };
  const name = p.serverName || p.serverId;
  if ((await serverAsksOf(ctx.tx, change.burrowId, p.serverId)) !== after.data)
    return {
      ok: false,
      reason: `Asks you first on ${name} was changed again since, so this can’t be undone.`,
    };
  await setServerAsksIn(ctx, {
    serverId: p.serverId,
    serverName: name,
    asksFirst: before.data,
    conversationId: change.conversationId,
    undoes: { changeId: change.id, byId: actor.id },
  });
  return { ok: true };
}

export function registerAsksUndoer(): void {
  registerUndoer('servers.asks', undoAsks);
}

/* The server a call names ------------------------------------------------------------------------------------------ */

/** The server a Servers call is about, with its setting (what `callTier` needs, SA-06). */
export interface CallServer extends KnownServer {
  asksFirst: HostAsksFirstValue;
}

/**
 * The server a Servers call names (its `server` argument: id or host name, any case) and its setting, from the last
 * fleet read; the fleet is read once when the server isn't known yet. Null for another connection, a call without a
 * server, or a server nobody knows (it asks as `risky`).
 */
export async function callServerOf(
  db: Db,
  services: Services,
  burrowId: string | null,
  catalogId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<CallServer | null> {
  if (!burrowId || catalogId !== SERVERS_CATALOG || typeof args.server !== 'string' || !args.server.trim())
    return null;
  let server = knownServer(args.server);
  if (!server) {
    const hosts = hostsFor(services);
    if (hosts.present) {
      await hosts.fleetRaw().catch(() => null);
      server = knownServer(args.server);
    }
  }
  if (!server) return null;
  return { ...server, asksFirst: await serverAsksOf(db, burrowId, server.id) };
}
