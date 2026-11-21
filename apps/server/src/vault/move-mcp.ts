/**
 * The Vault's MCP entries move to Connections (docs/decisions/vault-simplify.md VLT-30): an MCP server is connected as
 * a Custom MCP server (`custom_mcp`), which has the pages, checks and levels. At every read-write start each `mcp` entry
 * becomes one, with its address, its sign-in, its secret sealed again for the connection and its tool switches, and the
 * entry is removed — one commit per entry, signed as the person, so an entry is either still in the Vault or a
 * connection, never both, and a start that stops halfway carries on at the next one.
 *
 * An entry that can't move stays in the Vault and keeps working, and its read says so (`moveToConnections`): the box
 * has its 50 connections already, or it signs in a way a Custom MCP server doesn't offer (basic auth, a query parameter),
 * or it has no secret where its sign-in needs one. Nothing here reaches the network: the connection's health pass and
 * its first tool listing check it like any other, and every call is checked against the home-network list as before
 * (`connections/destination.ts`).
 */
import {
  CONNECTIONS_MAX,
  catalogEntry,
  connectionTransport,
  type JsonObject,
  newId,
  type SignInKind,
  type TokenAuth,
  tokenAuthProblem,
  type VaultAuth,
  VaultEntryId,
} from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { insertConnection } from '../connections/commands';
import { syncAndRecord } from '../connections/connect';
import { sealConnectionSecret } from '../connections/crypto';
import { connectionCount, connectionRow } from '../connections/store';
import { toolHash } from '../connections/sync';
import { connectionTools, vaultEntries } from '../db/schema/index';
import type { Services } from '../services';
import { emitEntryEvent, forgetHeldSecretsAfter, publishVaultUpdated, requirePerson } from './commands';
import { toolRows, type VaultEntryRow, vaultSecretAad } from './store';

const CUSTOM_MCP = 'custom_mcp';
/** What a connection's tool may be named (the connections' own rule, `connections/sync.ts`). */
const TOOL_NAME = /^[A-Za-z0-9_.\-/]{1,200}$/;

/** Why an entry stays in the Vault. */
export type McpMoveBlock = 'limit' | 'sign_in' | 'no_secret' | 'no_address';

/** How an entry signs in as a Custom MCP server: nothing, a bearer token or a header of its own. */
export type McpMovePlan =
  | { ok: true; signIn: Extract<SignInKind, 'none' | 'token'>; auth: TokenAuth | null }
  | { ok: false; block: Exclude<McpMoveBlock, 'limit'> };

/** Whether an `mcp` entry can be a Custom MCP server, and how it signs in there (pure). */
export function mcpMovePlan(entry: Pick<VaultEntryRow, 'url' | 'auth' | 'sealed'>): McpMovePlan {
  if (!entry.url) return { ok: false, block: 'no_address' };
  const auth = entry.auth as VaultAuth | null;
  if (!auth || auth.type === 'none') return { ok: true, signIn: 'none', auth: null };
  if (entry.sealed === null) return { ok: false, block: 'no_secret' };
  if (auth.type === 'bearer') return { ok: true, signIn: 'token', auth: { type: 'bearer' } };
  if (auth.type === 'header') {
    const header: TokenAuth = { type: 'header', name: auth.name, template: '{secret}' };
    const custom = catalogEntry(CUSTOM_MCP);
    if (!custom || tokenAuthProblem(custom, header)) return { ok: false, block: 'sign_in' };
    return { ok: true, signIn: 'token', auth: header };
  }
  return { ok: false, block: 'sign_in' };
}

export type McpMoveResult =
  | { moved: true; connectionId: string }
  | { moved: false; block: McpMoveBlock | null };

/**
 * Moves one `mcp` entry to a Custom MCP server connection, in the person's name: the connection (signed
 * `connection.added`) with its tools as the entry had them — on for the agent where the entry was on and the tool too,
 * off otherwise — then the entry removed (signed `vault.entry.removed`). `block: null`: the entry is gone already.
 */
export const moveMcpEntry = defineCommand({
  name: 'vault.move_to_connection',
  schema: z.object({ entryId: VaultEntryId }),
  async apply(tx, ctx, input): Promise<McpMoveResult> {
    requirePerson(ctx);
    const [row] = await tx
      .select()
      .from(vaultEntries)
      .where(and(eq(vaultEntries.id, input.entryId), eq(vaultEntries.burrowId, ctx.burrow.id)))
      .for('update');
    if (row?.kind !== 'mcp') return { moved: false, block: null };
    const plan = mcpMovePlan(row);
    if (!plan.ok) return { moved: false, block: plan.block };
    if ((await connectionCount(tx, ctx.burrow.id)) >= CONNECTIONS_MAX)
      return { moved: false, block: 'limit' };
    const custom = catalogEntry(CUSTOM_MCP);
    if (!custom) throw new Error('custom_mcp is missing from the catalog');
    const url = row.url as string;
    const id = newId('connection');
    const secret =
      plan.signIn === 'token' && row.sealed
        ? ctx.services.custody.open(vaultSecretAad(row.id), row.sealed)
        : null;
    const tools = (await toolRows(tx, row.id)).filter((t) => TOOL_NAME.test(t.name));
    const conn = await insertConnection(
      tx,
      {
        id,
        catalogId: CUSTOM_MCP,
        burrowId: ctx.burrow.id,
        connectedById: ctx.actor.id,
        label: row.name,
        transport: connectionTransport(custom, plan.signIn),
        signIn: plan.signIn,
        baseUrl: url,
        fields: { url },
        auth: plan.auth,
        secretEnc: secret ? sealConnectionSecret(ctx.services.custody, id, 'secret', secret) : null,
        access: 'manage',
        status: 'active',
        checks: [],
        toolCount: tools.length,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      },
      row.name,
    );
    if (tools.length)
      await tx.insert(connectionTools).values(
        tools.map((t, position) => {
          const inputSchema = (t.inputSchema as JsonObject | null) ?? null;
          return {
            connectionId: conn.id,
            name: t.name,
            description: t.description,
            inputSchema,
            // The Vault didn't keep a tool's hints: a write until the first listing says otherwise.
            access: 'write' as const,
            tier: row.agentOnAt && t.enabled ? ('can' as const) : ('off' as const),
            hash: toolHash({
              name: t.name,
              description: t.description,
              inputSchema,
              access: 'write',
              origin: 'mcp',
            }),
            isNew: false,
            origin: 'mcp',
            position,
            updatedAt: ctx.now,
          };
        }),
      );
    await ctx.emit({
      type: 'connection.added',
      kind: 'System',
      text: `Connected ${conn.label}`,
      where: 'Settings · Connections',
      payload: {
        connectionId: conn.id,
        catalogId: conn.catalogId,
        handle: conn.handle,
        signIn: conn.signIn,
        from: 'vault',
      },
    });
    await emitEntryEvent(ctx, 'entry.removed', row);
    await tx.delete(vaultEntries).where(eq(vaultEntries.id, row.id));
    forgetHeldSecretsAfter(ctx);
    publishVaultUpdated(ctx, row.ownerId, row.id);
    return { moved: true, connectionId: conn.id };
  },
});

/**
 * The start-up step: every `mcp` entry, oldest first, moved or left with why (logged with ids only, never a value or an
 * address). A moved one's tools are listed from the server afterwards, in the background.
 */
export async function moveMcpEntries(
  services: Services,
  /** `readTools: false`: don't list a moved server's tools afterwards (tests without the server). */
  options: { readTools?: boolean } = {},
): Promise<{ moved: number; stayed: number }> {
  const rows = await services.db
    .select({ id: vaultEntries.id, burrowId: vaultEntries.burrowId, ownerId: vaultEntries.ownerId })
    .from(vaultEntries)
    .where(eq(vaultEntries.kind, 'mcp'))
    .orderBy(asc(vaultEntries.createdAt));
  let moved = 0;
  let stayed = 0;
  for (const row of rows) {
    try {
      const res = await services.pipeline.commit(
        moveMcpEntry,
        { entryId: row.id },
        { burrowId: row.burrowId, actorId: row.ownerId },
      );
      if (res.status !== 'ok') throw new Error(`commit answered ${res.status}`);
      const result = res.result;
      if (result.moved) {
        moved++;
        services.log.info(
          { entryId: row.id, connectionId: result.connectionId },
          'vault: an MCP entry moved to Connections',
        );
        const connectionId = result.connectionId;
        if (options.readTools === false) continue;
        void (async () => {
          const conn = await connectionRow(services.db, connectionId);
          if (conn) await syncAndRecord(services, conn, []);
        })().catch((err: unknown) =>
          services.log.warn(
            { connectionId, err: String(err) },
            'vault: a moved MCP entry’s tools weren’t read',
          ),
        );
      } else if (result.block) {
        stayed++;
        services.log.info(
          { entryId: row.id, reason: result.block },
          'vault: an MCP entry stays in the Vault',
        );
      }
    } catch (err) {
      stayed++;
      services.log.warn(
        { entryId: row.id, err: err instanceof Error ? err.name : 'error' },
        'vault: an MCP entry couldn’t move to Connections',
      );
    }
  }
  return { moved, stayed };
}
