/**
 * The 1Password sync's writes (docs/decisions/onepassword-sync.md OPW-21…OPW-28, OPW-61): one Vault command a pass
 * applies its decisions with, in small batches, run as the person; the state a pass ends with; and the person's answer
 * to the guard. Entries change only through the Vault's own helpers (insert, replace the secret, set the authenticator
 * key, switch on for the assistant, remove), so the held secrets are read again, the events are the Vault's neutral
 * ones and the screens follow, as for the person's own change. Every event a pass signs carries the source
 * `onepassword` in its payload, never a name or a value.
 *
 * A pass reads first and commits after, so an entry may have moved in between: a change to an entry whose `updated_at`
 * isn't what the pass read is skipped, and the next pass takes it.
 */
import { randomBytes } from 'node:crypto';
import {
  ConnectionId,
  CreateVaultEntryBody,
  ONEPASSWORD_ENTRIES_FIELD,
  ONEPASSWORD_SYNC_FIELDS,
  ONEPASSWORD_VAULT_FIELD,
  OnePasswordNotInVault,
  OnePasswordPassOutcome,
  type OnePasswordProjection,
  OnePasswordRemovalAnswer,
  OnePasswordRemovals,
  onePasswordEntryAuth,
  VAULT_ENTRIES_MAX,
  type VaultAuth,
  VaultEntryId,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../../commit/types';
import type { CatalogConnectionRow } from '../../connections/types';
import { vaultEntries, vaultOnePasswordLinks, vaultOnePasswordState } from '../../db/schema/index';
import { publishHomeChanged } from '../../home/notify';
import { ApiError, notFound } from '../../lib/errors';
import {
  emitEntryEvent,
  giveOwnAssistantKey,
  insertEntry,
  publishVaultUpdated,
  removeEntry,
  replaceSecret,
  requirePerson,
} from '../commands';
import { entryCount, type VaultEntryRow, vaultSecretAad, vaultTotpAad } from '../store';
import { replaceTotp } from '../totp';
import { onePasswordDigests } from './digests';
import { entryEligible, type OnePasswordLinkRow, onePasswordConnectionOf } from './store';
import { onePasswordSyncFor } from './sync';

/** What every event a pass signs carries in its payload (OPW-61). */
export const ONEPASSWORD_SOURCE = 'onepassword';

/** The same context, with every signed event's payload carrying the source `onepassword`. */
export function fromOnePassword(ctx: ApplyContext): ApplyContext {
  const sourced = Object.create(ctx) as ApplyContext;
  sourced.emit = (fields) =>
    ctx.emit({ ...fields, payload: { ...(fields.payload ?? {}), source: ONEPASSWORD_SOURCE } });
  return sourced;
}

const Projection = z.object({
  kind: z.enum(['login', 'http']),
  name: z.string().min(1).max(200),
  url: z.string().min(1).max(2048),
  username: z.string().max(400).nullable(),
  secret: z.string().min(1),
  totp: z.string().max(1000).nullable(),
});

/** The item as the pass read or wrote it: what the link keeps of it. */
const ItemMark = z.object({
  itemId: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().min(1).max(64),
});
export type ItemMark = z.infer<typeof ItemMark>;

const Digests = z.object(
  Object.fromEntries(ONEPASSWORD_SYNC_FIELDS.map((f) => [f, z.string().min(1).max(200)])) as Record<
    (typeof ONEPASSWORD_SYNC_FIELDS)[number],
    z.ZodString
  >,
);

const LinkId = z.string().min(1).max(64);
/** The entry's `updated_at` as the pass read it (ISO). */
const ReadAt = z.string().min(1).max(64);
const Problem = z.string().min(1).max(300).nullable();

/**
 * One decision of a pass:
 * - `pull`: 1Password's fields into the entry, all of them (OPW-23), and the link's new base;
 * - `add`: a new entry from an item, switched on for the assistant (OPW-25), with its link;
 * - `relink`: an existing entry without a link paired with an item that names it, with no base (1Password wins next);
 * - `mark`: the link's bookkeeping only (the base renewed, an item's new version, a problem or none);
 * - `creating`: a link written before an item is made for the entry, so a retry finds the item by its marker (OPW-22);
 * - `created`: that link with its item;
 * - `local`: the entry kept only in Whombat from now on (OPW-27 with a problem, the guard's “Keep them here” without);
 * - `remove`: the entry removed, its item gone from the vault (OPW-24);
 * - `drop`: the link goes (its item archived, or nothing left of it).
 */
export const OnePasswordOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('pull'),
    linkId: LinkId,
    entryId: VaultEntryId,
    readAt: ReadAt,
    projection: Projection,
    item: ItemMark,
    nameShortened: z.boolean(),
  }),
  z.object({
    op: z.literal('add'),
    vaultId: z.string().min(1).max(64),
    projection: Projection,
    item: ItemMark,
    nameShortened: z.boolean(),
  }),
  z.object({
    op: z.literal('relink'),
    entryId: VaultEntryId,
    vaultId: z.string().min(1).max(64),
    item: ItemMark,
    nameShortened: z.boolean(),
  }),
  z.object({
    op: z.literal('mark'),
    linkId: LinkId,
    item: ItemMark.nullable(),
    base: Digests.nullable().optional(),
    problem: Problem,
    synced: z.boolean(),
    nameShortened: z.boolean().optional(),
  }),
  z.object({ op: z.literal('creating'), entryId: VaultEntryId, vaultId: z.string().min(1).max(64) }),
  z.object({ op: z.literal('created'), linkId: LinkId, item: ItemMark, base: Digests }),
  z.object({ op: z.literal('local'), linkId: LinkId, readAt: ReadAt.nullable(), problem: Problem }),
  z.object({ op: z.literal('remove'), linkId: LinkId, entryId: VaultEntryId, readAt: ReadAt.nullable() }),
  z.object({ op: z.literal('drop'), linkId: LinkId }),
]);
export type OnePasswordOp = z.infer<typeof OnePasswordOp>;

/** What became of one op: `done`; `moved` (the entry changed since the pass read it); `full` (50 entries); `gone`. */
export type OnePasswordOpResult =
  | { status: 'done'; linkId?: string; entryId?: string }
  | { status: 'moved' | 'full' | 'gone' };

const newLinkId = () => `opl_${randomBytes(9).toString('base64url')}`;

async function lockedEntry(ctx: ApplyContext, entryId: string): Promise<VaultEntryRow | null> {
  const [row] = await ctx.tx
    .select()
    .from(vaultEntries)
    .where(
      and(
        eq(vaultEntries.id, entryId),
        eq(vaultEntries.burrowId, ctx.burrow.id),
        eq(vaultEntries.ownerId, ctx.actor.id),
      ),
    )
    .for('update');
  return row ?? null;
}

async function linkOf(
  ctx: ApplyContext,
  connectionId: string,
  linkId: string,
): Promise<OnePasswordLinkRow | null> {
  const [row] = await ctx.tx
    .select()
    .from(vaultOnePasswordLinks)
    .where(and(eq(vaultOnePasswordLinks.id, linkId), eq(vaultOnePasswordLinks.connectionId, connectionId)))
    .for('update');
  return row ?? null;
}

const moved = (row: VaultEntryRow, readAt: string | null) =>
  readAt !== null && row.updatedAt.toISOString() !== readAt;

/** The entry's sign-in for a projection: a login keeps its own form's selectors, an API token bearer or basic. */
function authFor(row: VaultEntryRow, p: OnePasswordProjection): VaultAuth {
  const auth = row.auth as VaultAuth | null;
  if (p.kind === 'login' && auth?.type === 'form') return { ...auth, username: p.username ?? '' };
  return onePasswordEntryAuth(p);
}

/**
 * 1Password's fields into an entry: its name, address and sign-in in one change, its password or token through
 * `replaceSecret`, its authenticator key through the key's own setter. Only what differs is written.
 */
async function pullInto(
  ctx: ApplyContext,
  row: VaultEntryRow,
  p: OnePasswordProjection,
): Promise<VaultEntryRow> {
  let current = row;
  const auth = authFor(row, p);
  const urlChanged = p.url !== row.url;
  const authChanged = JSON.stringify(auth) !== JSON.stringify(row.auth);
  if (p.name !== row.name || urlChanged || authChanged) {
    const [updated] = await ctx.tx
      .update(vaultEntries)
      .set({
        name: p.name,
        url: p.url,
        auth,
        // A new address or sign-in is checked again, as the person's own change is.
        ...(urlChanged || authChanged
          ? {
              checkStatus: 'unchecked' as const,
              checkOutcome: null,
              checkSummary: '',
              checkHttpStatus: null,
              checkedAt: null,
            }
          : {}),
        updatedAt: ctx.now,
      })
      .where(eq(vaultEntries.id, row.id))
      .returning();
    if (!updated) throw notFound('Vault entry');
    current = updated;
    await emitEntryEvent(ctx, 'entry.changed', current);
    publishVaultUpdated(ctx, current.ownerId, current.id);
  }
  const secret = current.sealed
    ? ctx.services.custody.open(vaultSecretAad(current.id), current.sealed)
    : null;
  if (secret !== p.secret) {
    await replaceSecret(ctx, current, p.secret);
    current = (await lockedEntry(ctx, current.id)) ?? current;
  }
  if (current.kind === 'login') {
    const totp = current.totpSealed
      ? ctx.services.custody.open(vaultTotpAad(current.id), current.totpSealed)
      : null;
    if ((totp ?? null) !== (p.totp ?? null)) {
      await replaceTotp(ctx, current, p.totp);
      current = (await lockedEntry(ctx, current.id)) ?? current;
    }
  }
  return current;
}

async function applyOp(
  ctx: ApplyContext,
  connectionId: string,
  op: OnePasswordOp,
): Promise<OnePasswordOpResult> {
  const tx = ctx.tx;
  const now = ctx.now;
  const custody = ctx.services.custody;
  switch (op.op) {
    case 'pull': {
      const link = await linkOf(ctx, connectionId, op.linkId);
      const row = await lockedEntry(ctx, op.entryId);
      if (!link || !row || link.entryId !== row.id) return { status: 'gone' };
      if (moved(row, op.readAt)) return { status: 'moved' };
      await pullInto(ctx, row, op.projection);
      await tx
        .update(vaultOnePasswordLinks)
        .set({
          state: 'synced',
          itemVersion: op.item.version,
          itemUpdatedAt: op.item.updatedAt,
          base: onePasswordDigests(custody, row.id, op.projection),
          nameShortened: op.nameShortened,
          problem: null,
          syncedAt: now,
          updatedAt: now,
        })
        .where(eq(vaultOnePasswordLinks.id, link.id));
      return { status: 'done', linkId: link.id, entryId: row.id };
    }
    case 'add': {
      if ((await entryCount(tx, ctx.burrow.id, ctx.actor.id)) >= VAULT_ENTRIES_MAX) return { status: 'full' };
      const [taken] = await tx
        .select({ id: vaultOnePasswordLinks.id })
        .from(vaultOnePasswordLinks)
        .where(
          and(
            eq(vaultOnePasswordLinks.connectionId, connectionId),
            eq(vaultOnePasswordLinks.itemId, op.item.itemId),
          ),
        );
      if (taken) return { status: 'gone' };
      const p = op.projection;
      const input = CreateVaultEntryBody.parse({
        kind: p.kind,
        name: p.name,
        url: p.url,
        auth: onePasswordEntryAuth(p),
        secret: p.secret,
        ...(p.kind === 'login' && p.totp ? { totp: p.totp } : {}),
      });
      const row = await insertEntry(ctx, input, { skipLimit: true });
      await emitEntryEvent(ctx, 'entry.added', row);
      // What comes in from 1Password is for the assistant at once, as an entry the person saves is (OPW-25).
      await giveOwnAssistantKey(ctx, row);
      publishVaultUpdated(ctx, row.ownerId, row.id);
      const linkId = newLinkId();
      await tx.insert(vaultOnePasswordLinks).values({
        id: linkId,
        burrowId: ctx.burrow.id,
        connectionId,
        entryId: row.id,
        vaultId: op.vaultId,
        itemId: op.item.itemId,
        state: 'synced',
        itemVersion: op.item.version,
        itemUpdatedAt: op.item.updatedAt,
        base: onePasswordDigests(custody, row.id, p),
        nameShortened: op.nameShortened,
        problem: null,
        syncedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { status: 'done', linkId, entryId: row.id };
    }
    case 'relink': {
      const row = await lockedEntry(ctx, op.entryId);
      if (!row) return { status: 'gone' };
      const [taken] = await tx
        .select({ id: vaultOnePasswordLinks.id })
        .from(vaultOnePasswordLinks)
        .where(eq(vaultOnePasswordLinks.entryId, row.id));
      if (taken) return { status: 'gone' };
      const linkId = newLinkId();
      await tx.insert(vaultOnePasswordLinks).values({
        id: linkId,
        burrowId: ctx.burrow.id,
        connectionId,
        entryId: row.id,
        vaultId: op.vaultId,
        itemId: op.item.itemId,
        state: 'synced',
        // Seen at an older version, so the next pass reads it and decides with no base: 1Password's version wins.
        itemVersion: null,
        itemUpdatedAt: null,
        base: null,
        nameShortened: op.nameShortened,
        problem: null,
        syncedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return { status: 'done', linkId, entryId: row.id };
    }
    case 'mark': {
      const link = await linkOf(ctx, connectionId, op.linkId);
      if (!link) return { status: 'gone' };
      await tx
        .update(vaultOnePasswordLinks)
        .set({
          ...(op.item ? { itemVersion: op.item.version, itemUpdatedAt: op.item.updatedAt } : {}),
          ...(op.base !== undefined ? { base: op.base } : {}),
          ...(op.nameShortened !== undefined ? { nameShortened: op.nameShortened } : {}),
          ...(op.synced ? { syncedAt: now } : {}),
          problem: op.problem,
          updatedAt: now,
        })
        .where(eq(vaultOnePasswordLinks.id, link.id));
      if (link.problem !== op.problem && link.entryId) publishVaultUpdated(ctx, ctx.actor.id, link.entryId);
      return { status: 'done', linkId: link.id };
    }
    case 'creating': {
      const row = await lockedEntry(ctx, op.entryId);
      if (!row) return { status: 'gone' };
      const [taken] = await tx
        .select({ id: vaultOnePasswordLinks.id })
        .from(vaultOnePasswordLinks)
        .where(eq(vaultOnePasswordLinks.entryId, row.id));
      if (taken) return { status: 'gone' };
      const linkId = newLinkId();
      await tx.insert(vaultOnePasswordLinks).values({
        id: linkId,
        burrowId: ctx.burrow.id,
        connectionId,
        entryId: row.id,
        vaultId: op.vaultId,
        itemId: null,
        state: 'creating',
        nameShortened: false,
        createdAt: now,
        updatedAt: now,
      });
      return { status: 'done', linkId, entryId: row.id };
    }
    case 'created': {
      const link = await linkOf(ctx, connectionId, op.linkId);
      if (!link) return { status: 'gone' };
      await tx
        .update(vaultOnePasswordLinks)
        .set({
          state: 'synced',
          itemId: op.item.itemId,
          itemVersion: op.item.version,
          itemUpdatedAt: op.item.updatedAt,
          base: op.base,
          problem: null,
          syncedAt: now,
          updatedAt: now,
        })
        .where(eq(vaultOnePasswordLinks.id, link.id));
      if (link.entryId) publishVaultUpdated(ctx, ctx.actor.id, link.entryId);
      return { status: 'done', linkId: link.id };
    }
    case 'local': {
      const link = await linkOf(ctx, connectionId, op.linkId);
      if (!link) return { status: 'gone' };
      if (link.entryId) {
        const row = await lockedEntry(ctx, link.entryId);
        if (row && moved(row, op.readAt)) return { status: 'moved' };
      }
      await tx
        .update(vaultOnePasswordLinks)
        .set({ state: 'local_only', problem: op.problem, updatedAt: now })
        .where(eq(vaultOnePasswordLinks.id, link.id));
      if (link.entryId) publishVaultUpdated(ctx, ctx.actor.id, link.entryId);
      return { status: 'done', linkId: link.id };
    }
    case 'remove': {
      const link = await linkOf(ctx, connectionId, op.linkId);
      const row = await lockedEntry(ctx, op.entryId);
      if (!link || link.entryId !== op.entryId) return { status: 'gone' };
      if (row && moved(row, op.readAt)) return { status: 'moved' };
      await tx.delete(vaultOnePasswordLinks).where(eq(vaultOnePasswordLinks.id, link.id));
      if (row) await removeEntry(ctx, row);
      return { status: 'done' };
    }
    case 'drop': {
      await tx
        .delete(vaultOnePasswordLinks)
        .where(
          and(eq(vaultOnePasswordLinks.id, op.linkId), eq(vaultOnePasswordLinks.connectionId, connectionId)),
        );
      return { status: 'done' };
    }
  }
}

/** At most this many ops that change an entry in one commit (OPW-21). */
export const ONEPASSWORD_ENTRY_OPS: ReadonlySet<OnePasswordOp['op']> = new Set([
  'pull',
  'add',
  'remove',
  'local',
]);

/**
 * One batch of a pass's decisions, as the person: at most ten that change an entry, any number of the links' own
 * bookkeeping. Each op answers for itself; one that finds its entry moved or gone is skipped, not failed.
 */
export const applyOnePasswordOps = defineCommand({
  name: 'vault.onePasswordApply',
  schema: z.object({
    connectionId: ConnectionId,
    ops: z
      .array(OnePasswordOp)
      .min(1)
      .max(100)
      .refine(
        (ops) => ops.filter((o) => ONEPASSWORD_ENTRY_OPS.has(o.op)).length <= 10,
        'At most ten entries.',
      ),
  }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const connection = await onePasswordConnectionOf(tx, ctx.burrow.id);
    if (!connection || connection.id !== input.connectionId) throw notFound('Connection');
    const sourced = fromOnePassword(ctx);
    const results: OnePasswordOpResult[] = [];
    for (const op of input.ops) results.push(await applyOp(sourced, connection.id, op));
    return { results };
  },
});

/* The pass's state ----------------------------------------------------------------------------------- */

const NotInVaultRow = OnePasswordNotInVault.extend({ updatedAt: z.string().max(64) });

/** What a pass ends with (no signed event: a fact 1Password told, like a connection's check). */
export const recordOnePasswordPass = defineCommand({
  name: 'vault.onePasswordRecord',
  schema: z.object({
    connectionId: ConnectionId,
    state: z.object({
      vaultTitle: z.string().max(200).nullable().optional(),
      contentVersion: z.number().int().nonnegative().nullable().optional(),
      outcome: OnePasswordPassOutcome,
      problem: z.string().max(300).nullable(),
      readOnly: z.boolean().optional(),
      notInVault: z.array(NotInVaultRow).max(200).optional(),
      removals: OnePasswordRemovals.nullable().optional(),
      limitHits: z.number().int().nonnegative(),
      nextTryAt: z.string().nullable(),
    }),
  }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const connection = await onePasswordConnectionOf(tx, ctx.burrow.id);
    if (!connection || connection.id !== input.connectionId) throw notFound('Connection');
    const s = input.state;
    const [before] = await tx
      .select()
      .from(vaultOnePasswordState)
      .where(eq(vaultOnePasswordState.connectionId, connection.id))
      .for('update');
    const set = {
      ...(s.vaultTitle !== undefined ? { vaultTitle: s.vaultTitle } : {}),
      ...(s.contentVersion !== undefined ? { contentVersion: s.contentVersion } : {}),
      ...(s.readOnly !== undefined ? { readOnly: s.readOnly } : {}),
      ...(s.notInVault !== undefined ? { notInVault: s.notInVault } : {}),
      ...(s.removals !== undefined ? { removals: s.removals } : {}),
      checkedAt: ctx.now,
      outcome: s.outcome,
      problem: s.problem,
      limitHits: s.limitHits,
      nextTryAt: s.nextTryAt ? new Date(s.nextTryAt) : null,
      updatedAt: ctx.now,
    };
    if (before)
      await tx
        .update(vaultOnePasswordState)
        .set(set)
        .where(eq(vaultOnePasswordState.connectionId, connection.id));
    else
      await tx
        .insert(vaultOnePasswordState)
        .values({ connectionId: connection.id, burrowId: ctx.burrow.id, ...set });
    // The page and the Vault read it again; Home and its Inbox when how it stands changed.
    publishVaultUpdated(ctx, ctx.actor.id, null);
    const removalsBefore = before?.removals?.token ?? null;
    const removalsAfter = s.removals === undefined ? removalsBefore : (s.removals?.token ?? null);
    if (before?.outcome !== s.outcome || removalsBefore !== removalsAfter || before?.problem !== s.problem)
      publishHomeChanged(ctx, [ctx.actor.id], ['needsYou', 'things', 'watch']);
    return { ok: true as const };
  },
});

/* The guard's answer ------------------------------------------------------------------------------------- */

/**
 * The person's answer to “1Password says 4 items are gone” for the set they saw (`token`): `remove` removes those
 * entries here too, `keep` keeps them only in Whombat, never pushed back. A changed set is refused (`conflict`): the
 * page shows the new one.
 */
export const answerOnePasswordRemovals = defineCommand({
  name: 'vault.onePasswordRemovals',
  schema: z.object({
    connectionId: ConnectionId,
    answer: OnePasswordRemovalAnswer,
    token: z.string().min(1).max(100),
  }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const connection = await onePasswordConnectionOf(tx, ctx.burrow.id);
    if (!connection || connection.id !== input.connectionId) throw notFound('Connection');
    const [state] = await tx
      .select()
      .from(vaultOnePasswordState)
      .where(eq(vaultOnePasswordState.connectionId, connection.id))
      .for('update');
    const held = state?.removals ?? null;
    if (!held || held.token !== input.token)
      throw new ApiError('conflict', 'What 1Password says is gone changed. Look again.');
    const sourced = fromOnePassword(ctx);
    const entryIds = held.entries.map((e) => e.entryId);
    const links = await tx
      .select()
      .from(vaultOnePasswordLinks)
      .where(
        and(
          eq(vaultOnePasswordLinks.connectionId, connection.id),
          inArray(vaultOnePasswordLinks.entryId, entryIds),
        ),
      );
    for (const link of links) {
      if (input.answer === 'keep') {
        // Kept only here: never pushed back, so an item removed on purpose isn't revived.
        await tx
          .update(vaultOnePasswordLinks)
          .set({ state: 'local_only', itemId: null, problem: null, updatedAt: ctx.now })
          .where(eq(vaultOnePasswordLinks.id, link.id));
        if (link.entryId) publishVaultUpdated(ctx, ctx.actor.id, link.entryId);
        continue;
      }
      await tx.delete(vaultOnePasswordLinks).where(eq(vaultOnePasswordLinks.id, link.id));
      const row = link.entryId ? await lockedEntry(ctx, link.entryId) : null;
      if (row) await removeEntry(sourced, row);
    }
    await tx
      .update(vaultOnePasswordState)
      .set({
        removals: null,
        ...(state?.outcome === 'paused' ? { outcome: 'ok' as const } : {}),
        updatedAt: ctx.now,
      })
      .where(eq(vaultOnePasswordState.connectionId, connection.id));
    publishVaultUpdated(ctx, ctx.actor.id, null);
    publishHomeChanged(ctx, [ctx.actor.id], ['needsYou', 'things', 'watch']);
    return { answered: input.answer, count: links.length };
  },
});

/* Linking and disconnecting ------------------------------------------------------------------------------ */

/**
 * A new 1Password connection, in the commit that adds it: its state row, the answer to “Your Vault entries” (OPW-02),
 * and a pass as soon as it is in.
 */
export async function linkOnePassword(
  ctx: ApplyContext,
  connection: Pick<CatalogConnectionRow, 'id' | 'fields'>,
): Promise<void> {
  await ctx.tx
    .insert(vaultOnePasswordState)
    .values({ connectionId: connection.id, burrowId: ctx.burrow.id, updatedAt: ctx.now })
    .onConflictDoNothing();
  const fields = (connection.fields ?? {}) as Record<string, string>;
  const vaultId = fields[ONEPASSWORD_VAULT_FIELD]?.trim();
  if (vaultId && fields[ONEPASSWORD_ENTRIES_FIELD] === 'keep')
    await keepEntriesLocal(ctx, connection.id, vaultId);
  const services = ctx.services;
  ctx.after(async () => onePasswordSyncFor(services).request(0));
}

/**
 * At linking (OPW-02), with “Keep them only in Whombat”: every entry that would sync stays Whombat-only, a link kept
 * only here. With the other answer nothing is written: the first pass puts them in.
 */
export async function keepEntriesLocal(
  ctx: ApplyContext,
  connectionId: string,
  vaultId: string,
): Promise<void> {
  const rows = await ctx.tx
    .select()
    .from(vaultEntries)
    .where(and(eq(vaultEntries.burrowId, ctx.burrow.id), eq(vaultEntries.ownerId, ctx.actor.id)));
  const eligible = rows.filter((r) => entryEligible(r));
  if (!eligible.length) return;
  await ctx.tx.insert(vaultOnePasswordLinks).values(
    eligible.map((r) => ({
      id: newLinkId(),
      burrowId: ctx.burrow.id,
      connectionId,
      entryId: r.id,
      vaultId,
      itemId: null,
      state: 'local_only' as const,
      nameShortened: false,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })),
  );
}

/**
 * Disconnecting with “Remove them too” (OPW-50, OPW-K14): the entries kept in step with it go, through the Vault's own
 * removal; those kept only in Whombat stay. 1Password is never changed by it.
 */
export async function removeSyncedEntries(ctx: ApplyContext, connectionId: string): Promise<number> {
  const links = await ctx.tx
    .select()
    .from(vaultOnePasswordLinks)
    .where(
      and(
        eq(vaultOnePasswordLinks.connectionId, connectionId),
        inArray(vaultOnePasswordLinks.state, ['synced', 'creating']),
      ),
    );
  const sourced = fromOnePassword(ctx);
  let removed = 0;
  for (const link of links) {
    if (!link.entryId) continue;
    const row = await lockedEntry(ctx, link.entryId);
    if (!row) continue;
    await removeEntry(sourced, row);
    removed++;
  }
  return removed;
}
