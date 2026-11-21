/**
 * The name a person gave a server (“The Titan” for `the-titan`), kept by Whombat, not by the hosts service: every
 * screen and message calls the server by it (`serverLabel`), while links, tools and the hosts service keep the id.
 *
 * - `servers.rename`: the person names a server, or puts its id back (`name: null`), through `hosts.updateServer` with
 *   `name`. Signed `servers.renamed`, recorded for Done recently with an undo (`servers.rename`). Two servers never share
 *   a name, and a name is never another server's id or host name, ignoring case, so an agent told “The Titan” finds one.
 * - The names are read into memory (`noteServerNames`) at every fleet read and after every rename, so words written
 *   without a lookup (questions, notices) use them too.
 */
import { HostServerGivenName, thingHref } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import { serverNames } from '../db/schema/index';
import { type RecordedChange, recordChange, registerUndoer, type UndoResult } from '../home/registry';
import { ApiError, forbidden } from '../lib/errors';
import type { ActorInfo } from '../read/principals';
import { actorManagesServers } from './asks';
import { arr, obj } from './map';
import { loadServerNames, serverNameOf } from './names-store';
import { ONLY_YOU_CHANGE_SERVERS_TEXT } from './person';
import { noteServerNames, serverNameKey } from './self';
import { hostsFor } from './service';

/** The plain words of a rename (signed line and Done recently's title). */
export function renamedText(before: string, after: string): string {
  return `Renamed ${before} to ${after}`;
}

export const NAME_TAKEN_TEXT = 'Another server already goes by that name.';

/**
 * Why a name can't be given to a server, from the fleet the hosts service answered and the names here: another
 * server's id, host name or given name, ignoring case. Null when it can.
 */
export function nameClash(
  fleet: unknown,
  names: ReadonlyMap<string, string>,
  serverId: string,
  name: string,
): string | null {
  const want = name.trim().toLowerCase();
  const self = serverNameKey(serverId);
  for (const raw of arr(obj(fleet).servers)) {
    const card = obj(raw);
    const id = typeof card.id === 'string' ? card.id.toLowerCase() : '';
    if (!id || id === self) continue;
    const hostname = typeof card.hostname === 'string' ? card.hostname.toLowerCase() : '';
    if (want === id || want === hostname) return NAME_TAKEN_TEXT;
  }
  for (const [id, other] of names) if (id !== self && other.toLowerCase() === want) return NAME_TAKEN_TEXT;
  return null;
}

interface RenameUndo {
  serverId: string;
  /** The id as the hosts service spells it, for the words. */
  label: string;
  before: string | null;
  after: string | null;
}

export interface RenameInput {
  serverId: string;
  /** What the server was called before (its name, else its id): for the words. */
  shownBefore: string;
  /** What it goes by without a name (its host name's capitals, else its id). */
  plainName: string;
  name: string | null;
  conversationId?: string | null;
  undoes?: { changeId: string; byId: string } | null;
}

/**
 * Names a server inside a commit, as the context's actor (who must manage servers): the row, the signed
 * `servers.renamed`, Done recently with its undo, the names in memory and realtime's row once committed. Nothing when
 * it is already so.
 */
export async function renameServerIn(
  ctx: ApplyContext,
  input: RenameInput,
): Promise<{ changed: boolean; changeId: string | null }> {
  if (!actorManagesServers(ctx.actor)) throw forbidden(ONLY_YOU_CHANGE_SERVERS_TEXT);
  const key = serverNameKey(input.serverId);
  const before = await serverNameOf(ctx.tx, ctx.burrow.id, key);
  // The server's own id or plain name, as it is spelled, is no name: it goes by that anyway.
  const given =
    input.name && input.name !== input.plainName && input.name !== input.serverId ? input.name : null;
  if (before === given) return { changed: false, changeId: null };
  if (given) {
    const names = await loadServerNames(ctx.tx, ctx.burrow.id);
    for (const [id, other] of names)
      if (id !== key && other.toLowerCase() === given.toLowerCase())
        throw new ApiError('conflict', NAME_TAKEN_TEXT, { fields: { name: [NAME_TAKEN_TEXT] } });
    await ctx.tx
      .insert(serverNames)
      .values({
        burrowId: ctx.burrow.id,
        serverId: key,
        name: given,
        changedById: ctx.actor.id,
        changedAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [serverNames.burrowId, serverNames.serverId],
        set: { name: given, changedById: ctx.actor.id, changedAt: ctx.now },
      });
  } else {
    await ctx.tx
      .delete(serverNames)
      .where(and(eq(serverNames.burrowId, ctx.burrow.id), eq(serverNames.serverId, key)));
  }
  const after = given ?? input.plainName;
  const text = renamedText(input.shownBefore, after);
  await ctx.emit({
    type: 'servers.renamed',
    kind: 'System',
    text,
    where: `Servers · ${after}`,
    payload: {
      serverId: input.serverId,
      name: given,
      before,
      ...(input.undoes ? { undoes: input.undoes.changeId } : {}),
    },
  });
  const undo: RenameUndo = { serverId: input.serverId, label: input.plainName, before, after: given };
  const changeId = await recordChange(ctx, {
    burrowId: ctx.burrow.id,
    actorId: ctx.actor.id,
    personId: ctx.actor.id,
    kind: 'servers.rename',
    title: text,
    subject: { kind: 'server', id: input.serverId, name: after.slice(0, 120) },
    undo: input.undoes ? null : { kind: 'servers.rename', payload: undo },
    link: thingHref('server', input.serverId),
    conversationId: input.conversationId ?? null,
    at: ctx.now,
    undoes: input.undoes ?? null,
  });
  const { services } = ctx;
  const burrowId = ctx.burrow.id;
  ctx.after(async () => {
    noteServerNames(await loadServerNames(services.db, burrowId));
    const hosts = hostsFor(services);
    hosts.forget('fleet');
    hosts.touched(input.serverId);
  });
  return { changed: true, changeId };
}

export const RenameServerInput = z.object({
  serverId: z.string().trim().min(1).max(200),
  shownBefore: z.string().trim().min(1).max(120),
  plainName: z.string().trim().min(1).max(120),
  name: HostServerGivenName.nullable(),
});

/** `servers.rename`: the person names a server or puts its id back (`hosts.updateServer` with `name`). */
export const renameServer = defineCommand({
  name: 'servers.rename',
  schema: RenameServerInput,
  async apply(_tx, ctx, input) {
    return renameServerIn(ctx, input);
  },
});

/** Removing a server removes its name. */
export async function forgetServerName(ctx: ApplyContext, serverId: string): Promise<void> {
  await ctx.tx
    .delete(serverNames)
    .where(and(eq(serverNames.burrowId, ctx.burrow.id), eq(serverNames.serverId, serverNameKey(serverId))));
  const { services } = ctx;
  const burrowId = ctx.burrow.id;
  ctx.after(async () => noteServerNames(await loadServerNames(services.db, burrowId)));
}

/** Undo of a rename: the name before, unless someone renamed it again since. */
async function undoRename(ctx: ApplyContext, change: RecordedChange, actor: ActorInfo): Promise<UndoResult> {
  const p = change.undo.payload as Partial<RenameUndo> | null;
  if (!p?.serverId || !p.label) return { ok: false, reason: 'This one can’t be undone.' };
  if (!actorManagesServers(actor)) return { ok: false, reason: ONLY_YOU_CHANGE_SERVERS_TEXT };
  const now = await serverNameOf(ctx.tx, change.burrowId, p.serverId);
  const after = p.after ?? null;
  if (now !== after)
    return { ok: false, reason: `${now ?? p.label} was renamed again since, so this can’t be undone.` };
  await renameServerIn(ctx, {
    serverId: p.serverId,
    shownBefore: after ?? p.label,
    plainName: p.label,
    name: p.before ?? null,
    conversationId: change.conversationId,
    undoes: { changeId: change.id, byId: actor.id },
  });
  return { ok: true };
}

export function registerRenameUndoer(): void {
  registerUndoer('servers.rename', undoRename);
}
