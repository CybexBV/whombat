/**
 * Writes of catalog connections (docs/decisions/connections-catalog.md CX-22; one-person.md OP-S50): signed burrow
 * events through the commit pipeline — `connection.added`, `connection.changed`, `connection.removed`,
 * `connection.needs_reauth`, `connection.tool_tier_changed` — made by the person (`burrow.manage`, people only).
 *
 * Checks that call the service run before these commands (they need the network), never inside a transaction.
 */
import {
  AI_GATEWAY_COPY,
  CONNECTION_ACCESS_LABELS,
  CONNECTION_TOOL_TIER_LABELS,
  type ConnectionToolTier,
  canonicalJson,
  catalogEntry,
  conversationLabel,
  defaultConnectionLabel,
  handleFor,
  isVaultSyncConnection,
  type JsonValue,
  OnePasswordDisconnectChoice,
  thingId,
  topics,
  UPTIME_ID,
} from '@whombat/core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { publishApproval } from '../approvals/engine';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import {
  approvals,
  burrows,
  catalogConnections,
  connectionFoundHidden,
  connectionTools,
  noticeQuiets,
  noticeStates,
  thingCauses,
  watchOffs,
  watchOns,
} from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { gatewayConnectionOf, gatewayName, isGatewayCatalogId } from '../gateway/store';
import { publishHomeChanged } from '../home/notify';
import { endIncidentQuietly } from '../incidents/store';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { burrowView } from '../read/views';
import { toApproval } from '../read/work';
import type { Services } from '../services';
import {
  linkOnePassword,
  onePasswordConnectionChanged,
  removeSyncedEntries,
} from '../vault/onepassword/commands';
import { ONEPASSWORD_CONNECTION_EXISTS, onePasswordConnectionOf } from '../vault/onepassword/store';
import { connectionError } from './errors';
import { automaticLabel } from './labels';
import { emitConnectionLifecycle } from './lifecycle';
import type { ToolLimits } from './limits';
import { notifyNeedsReauth } from './notify';
import { connectionsSeenWith, requireRoom } from './store';
import type { CatalogConnectionRow } from './types';

export type NewConnection = Omit<typeof catalogConnections.$inferInsert, 'handle'>;
export type ConnectionChanges = Partial<
  Omit<typeof catalogConnections.$inferInsert, 'id' | 'catalogId' | 'burrowId' | 'createdAt'>
>;

const WHERE = 'Settings · Connections';

/* Building blocks ---------------------------------------------------------------------------------- */

/**
 * Inserts a connection with a free handle, inside the caller's transaction (limits checked there too, CX-05). Without a
 * label the person gave, it is named after its service, with its address only when the burrow already has a
 * connection of that service (home-redesign.md HR-07).
 */
export async function insertConnection(
  tx: Tx,
  values: NewConnection,
  labelGiven: string | null,
): Promise<CatalogConnectionRow> {
  await requireRoom(tx, values.burrowId);
  const seen = await connectionsSeenWith(tx, values.burrowId);
  const handle = handleFor(
    values.catalogId,
    seen.map((r) => r.handle),
    labelGiven,
  );
  const entry = catalogEntry(values.catalogId);
  const label =
    labelGiven === null && entry && values.label === defaultConnectionLabel(entry, values.fields ?? {})
      ? automaticLabel(
          entry,
          values.fields ?? {},
          seen.some((r) => r.catalogId === values.catalogId),
        )
      : values.label;
  const [row] = await tx
    .insert(catalogConnections)
    .values({ ...values, label, handle })
    .returning();
  if (!row) throw new Error('connection not inserted');
  return row;
}

async function lockedRow(tx: Tx, burrowId: string, id: string): Promise<CatalogConnectionRow> {
  const [row] = await tx.select().from(catalogConnections).where(eq(catalogConnections.id, id)).for('update');
  if (!row || row.burrowId !== burrowId) throw notFound('Connection');
  return row;
}

/** Connections are set up and changed by the person, never by the agent. */
function requirePerson(ctx: ApplyContext) {
  if (ctx.actor.kind !== 'person') throw forbidden('Only you can change connections.');
}

const manage = (attempt: string) => ({ keyId: 'burrow.manage' as const, attempt, where: WHERE });

const payloadOf = (row: CatalogConnectionRow) => ({
  connectionId: row.id,
  catalogId: row.catalogId,
  handle: row.handle,
});

/**
 * Withdraws the pending asks to call this connection (CX-24): they read as declined by whoever removed it, with a
 * signed `approval.declined` saying why. Nobody is woken.
 */
async function withdrawConnectionApprovals(
  ctx: ApplyContext,
  connectionId: string,
  why: string,
): Promise<number> {
  const rows = await ctx.tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.burrowId, ctx.burrow.id),
        eq(approvals.state, 'pending'),
        sql`${approvals.action}->>'type' = 'connection_call'`,
        sql`${approvals.action}->'params'->>'connectionId' = ${connectionId}`,
      ),
    );
  for (const row of rows) {
    await ctx.tx
      .update(approvals)
      .set({ state: 'declined', decidedById: ctx.actor.id, decidedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(approvals.id, row.id));
    const conversation = await loadConversationRow(ctx.tx, row.conversationId);
    const event = await ctx.emit({
      type: 'approval.declined',
      kind: 'Asks',
      text: `Withdrew request #${row.number}: ${why}`,
      where: conversation ? conversationLabel(conversation) : null,
      aboutId: row.requesterId,
      approvalId: row.id,
      ref: { type: 'approval', number: row.number },
      payload: { approvalId: row.id, decision: 'decline', withdrawn: true, note: null },
    });
    const [fresh] = await ctx.tx.select().from(approvals).where(eq(approvals.id, row.id));
    if (fresh) publishApproval(ctx, toApproval(fresh), event.id);
  }
  return rows.length;
}

/* Connections (signed burrow events) -------------------------------------------------------------- */

const NewConnectionInput = z.custom<NewConnection>((v) => !!v && typeof v === 'object');
const ChangesInput = z.custom<ConnectionChanges>((v) => !!v && typeof v === 'object');

/**
 * The burrow's AI gateway changed with one of its connections (docs/decisions/ai-gateway.md AIG-01, AIG-05): the burrow
 * is published again (`Burrow.aiGateway`), and the pool with it.
 */
async function publishGatewayChange(ctx: ApplyContext, connectionId: string, eventId: string) {
  const [burrow] = await ctx.tx.select().from(burrows).where(eq(burrows.id, ctx.burrow.id));
  if (!burrow) return;
  ctx.burrow = burrow;
  ctx.publish(
    topics.burrow(burrow.id),
    { type: 'burrow.updated', burrow: await burrowView(ctx.tx, burrow) },
    { eventId },
  );
  ctx.publish(topics.burrow(burrow.id), { type: 'usage.gateway_updated', connectionId }, { eventId });
}

export const addConnection = defineCommand({
  name: 'catalog_connection.add',
  schema: z.object({
    values: NewConnectionInput,
    labelGiven: z.string().nullable(),
  }),
  requiredKey: () => manage('add a connection'),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const gateway = isGatewayCatalogId(input.values.catalogId);
    if (gateway) {
      // At most one gateway connection per burrow (AIG-01), checked again here so two at once can't both get in.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai_gateway:${ctx.burrow.id}`}))`);
      const existing = await gatewayConnectionOf(tx, ctx.burrow.id);
      if (existing)
        throw connectionError('gateway_exists', {}, AI_GATEWAY_COPY.exists(gatewayName(existing)));
    }
    const vaultSync = isVaultSyncConnection(input.values.catalogId);
    if (vaultSync) {
      // At most one 1Password connection per burrow, checked again here so two at once can't both get in.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`vault_sync:${ctx.burrow.id}`}))`);
      if (await onePasswordConnectionOf(tx, ctx.burrow.id))
        throw connectionError('limit_reached', { max: 1 }, ONEPASSWORD_CONNECTION_EXISTS);
    }
    const row = await insertConnection(
      tx,
      { ...input.values, burrowId: ctx.burrow.id, connectedById: ctx.actor.id },
      input.labelGiven,
    );
    const event = await ctx.emit({
      type: 'connection.added',
      kind: 'System',
      text: `Connected ${row.label}`,
      where: WHERE,
      payload: { ...payloadOf(row), signIn: row.signIn },
    });
    // Its switches start off (AIG-05): a burrow's stored switches of an earlier gateway connection don't apply.
    if (gateway) await publishGatewayChange(ctx, row.id, event.id);
    if (vaultSync) await linkOnePassword(ctx, row);
    return { row, eventId: event.id };
  },
});

export const changeConnection = defineCommand({
  name: 'catalog_connection.change',
  schema: z.object({
    connectionId: z.string(),
    set: ChangesInput,
    /** What changed, for the event: `label`, `fields`, `access`, `secret`, `reconnected`, `status`. */
    what: z.array(z.string()).min(1),
    /** The signed line when the caller words it (what it runs on, connection-pages.md CP-08). */
    text: z.string().min(1).max(300).optional(),
  }),
  // A state change found by “Check again” is recorded for whoever looked (the person may check, CX-25).
  requiredKey: (input) => (input.what.every((w) => w === 'status') ? null : manage('change a connection')),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const before = await lockedRow(tx, ctx.burrow.id, input.connectionId);
    const set: ConnectionChanges = { ...input.set };
    if (before.catalogId === UPTIME_ID && input.what.includes('fields')) {
      // The previous target's result and confirmation counts say nothing about the saved check.
      set.glance = null;
      set.glanceAt = null;
      const thing = thingId('connection', before.id);
      await tx.delete(noticeStates).where(eq(noticeStates.thingId, thing));
      await tx
        .delete(thingCauses)
        .where(and(eq(thingCauses.ownerId, ctx.burrow.id), eq(thingCauses.thingId, thing)));
      // Nor its outage: a delayed start counting on it mustn't run on the new target's first failures.
      await endIncidentQuietly(ctx, thing);
      publishHomeChanged(ctx, [ctx.actor.id], ['things', 'watch', 'needsYou']);
    }
    const [row] = await tx
      .update(catalogConnections)
      .set({ ...set, updatedAt: ctx.now })
      .where(eq(catalogConnections.id, before.id))
      .returning();
    if (!row) throw notFound('Connection');
    const what = input.what;
    const text = input.text
      ? input.text
      : what.every((w) => w === 'status')
        ? row.status === 'active'
          ? `${row.label} works again`
          : `${row.label} isn’t answering`
        : what.includes('secret')
          ? `Replaced the token of ${row.label}`
          : what.includes('reconnected')
            ? `Connected ${row.label} again`
            : what.includes('access') && before.access !== row.access
              ? before.label !== row.label
                ? `Renamed ${before.label} to ${row.label} and set it to ${CONNECTION_ACCESS_LABELS[row.access]}`
                : `Set ${row.label} to ${CONNECTION_ACCESS_LABELS[row.access]}`
              : before.label !== row.label
                ? `Renamed ${before.label} to ${row.label}`
                : `Changed ${row.label}`;
    const event = await ctx.emit({
      type: 'connection.changed',
      kind: 'System',
      text,
      where: WHERE,
      payload: {
        ...payloadOf(row),
        what: input.what,
        ...(input.what.includes('access') ? { access: row.access } : {}),
      },
    });
    // A gateway's name is in the switches and the pool (AIG-05).
    if (isGatewayCatalogId(row.catalogId) && before.label !== row.label)
      await publishGatewayChange(ctx, row.id, event.id);
    // A 1Password connection's new token or vault: what the sync knew of the old one goes (onepassword-sync.md).
    if (isVaultSyncConnection(row.catalogId)) await onePasswordConnectionChanged(ctx, before, row);
    return { row, eventId: event.id };
  },
});

export const removeConnection = defineCommand({
  name: 'catalog_connection.remove',
  schema: z.object({
    connectionId: z.string(),
    /** A 1Password connection: its entries stay in the Vault (`keep`, absent) or go with it. */
    vaultEntries: OnePasswordDisconnectChoice.optional(),
  }),
  requiredKey: () => manage('remove a connection'),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await lockedRow(tx, ctx.burrow.id, input.connectionId);
    await withdrawConnectionApprovals(ctx, row.id, `${row.label} was removed`);
    // “Remove them too”: the entries kept in step with it go, through the Vault's own removal; 1Password stays as it is.
    if (isVaultSyncConnection(row.catalogId) && input.vaultEntries === 'remove')
      await removeSyncedEntries(ctx, row.id);
    const event = await ctx.emit({
      type: 'connection.removed',
      kind: 'System',
      text: `Removed ${row.label}`,
      where: WHERE,
      payload: payloadOf(row),
    });
    await tx.delete(catalogConnections).where(eq(catalogConnections.id, row.id));
    // What Whombat watched of it goes with it (nothing ties these rows to the connection): a connection added later
    // starts as a new one would.
    await forgetWatched(tx, ctx.burrow.id, [thingId('connection', row.id), thingId('device', row.id)]);
    // Removing the burrow's gateway clears its switches (AIG-05): turns run on their agents' own sign-ins again.
    if (isGatewayCatalogId(row.catalogId)) {
      await tx
        .update(burrows)
        .set({ aiGateway: null })
        .where(and(eq(burrows.id, ctx.burrow.id), sql`${burrows.aiGateway}->>'connectionId' = ${row.id}`));
      await publishGatewayChange(ctx, row.id, event.id);
    }
    return { row, eventId: event.id };
  },
});

async function forgetWatched(tx: Tx, burrowId: string, things: string[]): Promise<void> {
  await tx
    .delete(noticeQuiets)
    .where(and(eq(noticeQuiets.ownerId, burrowId), inArray(noticeQuiets.thingId, things)));
  await tx.delete(watchOffs).where(and(eq(watchOffs.ownerId, burrowId), inArray(watchOffs.thingId, things)));
  await tx.delete(watchOns).where(and(eq(watchOns.ownerId, burrowId), inArray(watchOns.thingId, things)));
  await tx.delete(noticeStates).where(inArray(noticeStates.thingId, things));
}

export const setToolTier = defineCommand({
  name: 'catalog_connection.set_tool_tier',
  schema: z.object({ connectionId: z.string(), tool: z.string(), tier: z.enum(['can', 'ask', 'off']) }),
  requiredKey: () => manage('change what the agent may do with a connection'),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await lockedRow(tx, ctx.burrow.id, input.connectionId);
    const changed = await updateToolTier(tx, row.id, input.tool, input.tier, ctx.now);
    if (!changed.tierChanged) return { row, eventId: null as string | null };
    const event = await ctx.emit({
      type: 'connection.tool_tier_changed',
      kind: 'Keys',
      text: `Set ${input.tool} on ${row.label} to ${CONNECTION_TOOL_TIER_LABELS[input.tier]}`,
      where: WHERE,
      payload: { ...payloadOf(row), tool: input.tool, from: changed.from, to: input.tier },
    });
    return { row, eventId: event.id as string | null };
  },
});

/**
 * The person's limits on a connection's tool (one-whombat-devices.md ONE-DD04, ONE-DD07): a signed `Keys` event, like
 * a tier. Null removes them.
 */
export const setToolLimits = defineCommand({
  name: 'catalog_connection.set_tool_limits',
  schema: z.object({
    connectionId: z.string(),
    tool: z.string(),
    limits: z.custom<ToolLimits | null>((v) => v === null || (!!v && typeof v === 'object')),
    /** How the limits read (“room temperature 16–24 °C”), for the log. */
    summary: z.string().max(300).nullable(),
  }),
  requiredKey: () => manage('change what the agent may do with a connection'),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await lockedRow(tx, ctx.burrow.id, input.connectionId);
    const changed = await updateToolLimits(tx, row.id, input.tool, input.limits, ctx.now);
    if (!changed) return { row, eventId: null as string | null };
    const event = await ctx.emit({
      type: 'connection.tool_limits_changed',
      kind: 'Keys',
      text: input.limits
        ? `Limited ${input.tool} on ${row.label}${input.summary ? `: ${input.summary}` : ''}`
        : `Removed the limits on ${input.tool} on ${row.label}`,
      where: WHERE,
      payload: { ...payloadOf(row), tool: input.tool, limits: input.limits as JsonValue },
    });
    return { row, eventId: event.id as string | null };
  },
});

/** Marks a connection `needs_reauth` with its signed event (no person acted: signed by its connector or the person). */
export const markConnectionNeedsReauth = defineCommand({
  name: 'catalog_connection.mark_reauth',
  schema: z.object({
    connectionId: z.string(),
    reason: z.enum(['token_invalid', 'revoked', 'app_removed', 'expired']),
    refreshTokenEnc: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
  }),
  async apply(tx, ctx, input) {
    const row = await markInTx(tx, input.connectionId, input.reason, ctx.now, input);
    if (!row) return { marked: false, eventId: null as string | null };
    const event = await ctx.emit({
      type: 'connection.needs_reauth',
      kind: 'System',
      text: `${row.label} needs you to sign in again`,
      where: WHERE,
      payload: { ...payloadOf(row), reason: input.reason },
    });
    return { marked: true, eventId: event.id as string | null };
  },
});

/** The most services a burrow keeps hidden; past it the longest-hidden one shows again (CS-53). */
export const FOUND_HIDDEN_MAX = 500;

/**
 * Hides a found service from Found on your network, or shows it again (connections-setup.md CS-53): for the whole
 * burrow, by catalog entry, host and port. Signed only when something changed.
 */
export const setFoundHidden = defineCommand({
  name: 'catalog_connection.hide_found',
  schema: z.object({
    catalogId: z.string(),
    /** The entry's name and the address as found, for the event's text. */
    name: z.string(),
    url: z.string(),
    host: z.string(),
    port: z.number().int(),
    hidden: z.boolean(),
  }),
  requiredKey: (input) =>
    manage(input.hidden ? 'hide a service found on the network' : 'show a hidden found service again'),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const t = connectionFoundHidden;
    const where = (r: { catalogId: string; host: string; port: number }) =>
      and(
        eq(t.burrowId, ctx.burrow.id),
        eq(t.catalogId, r.catalogId),
        eq(t.host, r.host),
        eq(t.port, r.port),
      );
    if (input.hidden) {
      const added = await tx
        .insert(t)
        .values({
          burrowId: ctx.burrow.id,
          catalogId: input.catalogId,
          host: input.host,
          port: input.port,
          hiddenBy: ctx.actor.id,
          hiddenAt: ctx.now,
        })
        .onConflictDoNothing()
        .returning({ host: t.host });
      if (added.length === 0) return { changed: false, eventId: null as string | null };
      const over = await tx
        .select({ catalogId: t.catalogId, host: t.host, port: t.port })
        .from(t)
        .where(eq(t.burrowId, ctx.burrow.id))
        .orderBy(desc(t.hiddenAt))
        .offset(FOUND_HIDDEN_MAX);
      for (const r of over) await tx.delete(t).where(where(r));
    } else {
      const removed = await tx.delete(t).where(where(input)).returning({ host: t.host });
      if (removed.length === 0) return { changed: false, eventId: null as string | null };
    }
    const event = await ctx.emit({
      type: input.hidden ? 'connection.found_hidden' : 'connection.found_shown',
      kind: 'System',
      text: input.hidden
        ? `Hid ${input.name} at ${input.url} from Found on your network`
        : `Showed ${input.name} at ${input.url} in Found on your network again`,
      where: WHERE,
      payload: { catalogId: input.catalogId, host: input.host, port: input.port },
    });
    return { changed: true, eventId: event.id as string | null };
  },
});

/* Helpers ------------------------------------------------------------------------------------------ */

/** Sets one tool's tier and clears its New mark (the tools side reads `tier` on every call). */
export async function updateToolTier(
  tx: Tx,
  connectionId: string,
  tool: string,
  tier: ConnectionToolTier,
  now: Date,
): Promise<{ from: ConnectionToolTier; tierChanged: boolean }> {
  const [current] = await tx
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, connectionId), eq(connectionTools.name, tool)));
  if (!current) throw connectionError('unknown_tool');
  await tx
    .update(connectionTools)
    .set({ tier, isNew: false, updatedAt: now })
    .where(and(eq(connectionTools.connectionId, connectionId), eq(connectionTools.name, tool)));
  return { from: current.tier, tierChanged: current.tier !== tier };
}

/** Sets a tool's limits; false when they were already so. Throws `unknown_tool`. */
export async function updateToolLimits(
  tx: Tx,
  connectionId: string,
  tool: string,
  limits: ToolLimits | null,
  now: Date,
): Promise<boolean> {
  const [current] = await tx
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, connectionId), eq(connectionTools.name, tool)));
  if (!current) throw connectionError('unknown_tool');
  if (canonicalJson(current.limits ?? null) === canonicalJson(limits)) return false;
  await tx
    .update(connectionTools)
    .set({ limits, updatedAt: now })
    .where(and(eq(connectionTools.connectionId, connectionId), eq(connectionTools.name, tool)));
  return true;
}

/** The conditional `needs_reauth` write (IN-22): only an active connection, and only the grant that died. */
async function markInTx(
  tx: Tx,
  id: string,
  reason: 'token_invalid' | 'revoked' | 'app_removed' | 'expired',
  now: Date,
  cond: { refreshTokenEnc?: string | null | undefined; message?: string | null | undefined },
): Promise<CatalogConnectionRow | null> {
  const [row] = await tx
    .update(catalogConnections)
    .set({
      status: 'needs_reauth',
      reauthReason: reason,
      accessTokenEnc: null,
      accessExpiresAt: null,
      checks: [
        {
          id: 'credential',
          state: 'error',
          message: cond.message ?? 'It needs you to sign in again.',
        },
      ],
      checkedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(catalogConnections.id, id),
        eq(catalogConnections.status, 'active'),
        cond.refreshTokenEnc ? eq(catalogConnections.refreshTokenEnc, cond.refreshTokenEnc) : undefined,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Who signs a change no person made (a dead grant, a removed app): the person (one-person.md OP-S40); null while the
 * burrow has none.
 */
export async function signerFor(db: Db | Tx, row: Pick<CatalogConnectionRow, 'burrowId'>) {
  return thePerson(db, row.burrowId);
}

/**
 * Marks a connection `needs_reauth` (CX-15): conditional on it being active (and, from a refresh, on still holding the
 * grant that was refused), signed in its burrow, its pooled client dropped, and the person told (once a day). True when
 * this call marked it.
 */
export async function markNeedsReauth(
  services: Services,
  row: Pick<CatalogConnectionRow, 'id' | 'burrowId'>,
  reason: 'token_invalid' | 'revoked' | 'app_removed' | 'expired',
  cond: { refreshTokenEnc?: string | null; message?: string | null } = {},
): Promise<boolean> {
  let marked = false;
  const signer = await signerFor(services.db, row);
  if (signer) {
    const res = await services.pipeline.commit(
      markConnectionNeedsReauth,
      {
        connectionId: row.id,
        reason,
        refreshTokenEnc: cond.refreshTokenEnc ?? null,
        message: cond.message ?? null,
      },
      { burrowId: row.burrowId, actorId: signer.id },
    );
    marked = res.status === 'ok' && res.result.marked;
  } else {
    const now = services.clock();
    marked =
      (await services.pipeline.transactAccount((tx) => markInTx(tx, row.id, reason, now, cond))) !== null;
  }
  if (marked) {
    services.log.info({ connectionId: row.id, reason }, 'catalog connection needs reauth');
    await emitConnectionLifecycle(services, { type: 'credential', connectionId: row.id });
    services.guides.track('connection repair', () => notifyNeedsReauth(services, row.id));
  }
  return marked;
}

/** Registered with the pipeline (commands/index.ts). */
export const CONNECTION_COMMANDS = [
  addConnection,
  changeConnection,
  removeConnection,
  setToolTier,
  setToolLimits,
  markConnectionNeedsReauth,
  setFoundHidden,
];
