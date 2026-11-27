/**
 * Commands of the Vault's SSH keys (docs/decisions/vault.md VT-S02…VT-S07, VT-S11; VT-D42…VT-D52): the entry with its
 * key, the key replaced, its servers added, changed and removed, a server's check and host-key trust recorded, which
 * servers a key covers, and a connection that met a changed host key. The person's only (an agent is refused), through the
 * commit pipeline, signed with VT-51's neutral texts and ids-only payloads like every Vault command.
 *
 * Keys are made or opened by the REST handler before the commit (CPU work, and the pasted text never enters a
 * command); destinations are checked there too (DNS stays outside the burrow lock). Connections close after commit.
 */
import {
  newId,
  VAULT_LIMIT_MESSAGES,
  VAULT_SSH_FIELD_TEXT,
  VAULT_SSH_SERVERS_MAX,
  VaultAuth,
  type VaultCheckOutcome,
  VaultEntryDescription,
  VaultEntryId,
  VaultEntryName,
  VaultKeyServersChoice,
  VaultPort,
  VaultSshCheckResult,
  VaultSshHostKey,
  VaultSshServerId,
  vaultAuditText,
  vaultSshCheckStatus,
  vaultSshCheckSummary,
} from '@whombat/core';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import { vaultEntries, vaultSshServers } from '../db/schema/index';
import { tServer } from '../i18n/catalog';
import { burrowLocale } from '../i18n/locale';
import { forbidden, notFound } from '../lib/errors';
import { shortName } from '../read/principals';
import {
  checkedKeyServers,
  emitEntryEvent,
  forgetCheckServerRows,
  forgetHeldSecretsAfter,
  giveOwnAssistantKey,
  insertEntry,
  keyAgent,
  keyEventFields,
  publishVaultUpdated,
  requirePerson,
  sameServers,
  signVaultUse,
  vaultError,
} from './commands';
import {
  agentKeyFor,
  agentKeyOf,
  entryById,
  ownEntry,
  type VaultEntryRow,
  type VaultSshServerRow,
  vaultPins,
  vaultSecretAad,
} from './store';
import { tellPerson } from './tell';

/** The person's `ssh` entry, or 404 / `wrong_kind`. */
async function ownSshEntry(ctx: ApplyContext, entryId: string): Promise<VaultEntryRow> {
  requirePerson(ctx);
  const row = await ownEntry(ctx.tx, ctx.burrow.id, ctx.actor.id, entryId);
  if (row.kind !== 'ssh') throw vaultError('wrong_kind', {}, 'Only an SSH key has servers and a key pair.');
  return row;
}

async function ownServer(
  ctx: ApplyContext,
  entry: VaultEntryRow,
  serverId: string,
): Promise<VaultSshServerRow> {
  const [row] = await ctx.tx
    .select()
    .from(vaultSshServers)
    .where(and(eq(vaultSshServers.entryId, entry.id), eq(vaultSshServers.id, serverId)));
  if (!row) throw notFound('Server');
  return row;
}

/** The entry changed: its `updatedAt` moves (agents' sessions start fresh, VT-D15) and the neutral line is signed. */
export async function entryChanged(ctx: ApplyContext, entry: VaultEntryRow) {
  const [updated] = await ctx.tx
    .update(vaultEntries)
    .set({ updatedAt: ctx.now })
    .where(eq(vaultEntries.id, entry.id))
    .returning();
  const event = await emitEntryEvent(ctx, 'entry.changed', updated ?? entry);
  publishVaultUpdated(ctx, entry.ownerId, entry.id);
  return event.id;
}

/** What a stored key is: the OpenSSH text to seal and its public half (the entry's `auth`, `ssh_key`). */
const SshKeyInput = z.object({
  privateKey: z.string().min(1).max(20_000),
  auth: VaultAuth.refine((a) => a.type === 'ssh_key', 'An SSH key signs in with its key.'),
});

/* The entry and its key (VT-S02, VT-S03) ------------------------------------------------------------- */

/** “Add to Vault” → SSH key: the key generated or imported by the handler, sealed here. */
export const createVaultSshEntry = defineCommand({
  name: 'vault.create_ssh',
  schema: SshKeyInput.extend({
    entryId: VaultEntryId,
    name: VaultEntryName,
    description: VaultEntryDescription.default(''),
  }),
  async apply(_tx, ctx, input) {
    const row = await insertEntry(
      ctx,
      {
        kind: 'ssh',
        name: input.name,
        description: input.description,
        auth: input.auth,
        secret: input.privateKey,
      } as never,
      { id: input.entryId },
    );
    const event = await emitEntryEvent(ctx, 'entry.added', row);
    // The agent holds it at once (vault-self-serve.md VS-01), also Sign in once's “Servers” key (SI-09).
    await giveOwnAssistantKey(ctx, row);
    publishVaultUpdated(ctx, ctx.actor.id, row.id);
    return { entryId: row.id, eventId: event.id };
  },
});

/**
 * “Generate a new key” / “Replace with my own key” (VT-S03): the key is replaced at once — the old one stops working
 * everywhere (every connection closes); servers and host-key trust stay. Signs “Replaced the secret of a private Vault
 * entry”.
 */
export const replaceVaultSshKey = defineCommand({
  name: 'vault.replace_ssh_key',
  schema: SshKeyInput.extend({ entryId: VaultEntryId }),
  async apply(tx, ctx, input) {
    const row = await ownSshEntry(ctx, input.entryId);
    const [updated] = await tx
      .update(vaultEntries)
      .set({
        sealed: ctx.services.custody.seal(vaultSecretAad(row.id), input.privateKey),
        secretSetAt: ctx.now,
        auth: input.auth,
        updatedAt: ctx.now,
      })
      .where(eq(vaultEntries.id, row.id))
      .returning();
    if (!updated) throw notFound('Vault entry');
    const event = await emitEntryEvent(ctx, 'entry.secret_replaced', updated);
    forgetHeldSecretsAfter(ctx);
    publishVaultUpdated(ctx, row.ownerId, row.id);
    return { entryId: row.id, eventId: event.id };
  },
});

/* Servers (VT-S04) ------------------------------------------------------------------------------------ */

const ServerFields = z.object({
  /** Already canonical (`parseVaultSshHost`) and checked against the destination rule by the handler. */
  name: z.string().min(1).max(40),
  host: z.string().min(1).max(253),
  port: VaultPort,
  username: z.string().min(1).max(32),
  /** Production (one-person.md OP-07): closed to the agent's commands until the person says yes to one. */
  production: z.boolean().optional(),
});

/** Whether the entry has another server of that name, ignoring case (VT-D61): `PVE-01` and `pve-01` are one alias. */
export async function nameTaken(
  ctx: ApplyContext,
  entryId: string,
  name: string,
  except?: string,
): Promise<boolean> {
  const [row] = await ctx.tx
    .select({ id: vaultSshServers.id })
    .from(vaultSshServers)
    .where(
      and(
        eq(vaultSshServers.entryId, entryId),
        sql`lower(${vaultSshServers.name}) = ${name.toLowerCase()}`,
        ...(except ? [ne(vaultSshServers.id, except)] : []),
      ),
    );
  return !!row;
}

const nameTakenError = () => vaultError('server_name_taken', {}, VAULT_SSH_FIELD_TEXT.nameTaken);

/** “Add server”: at most 20, names unique per entry ignoring case; it starts unchecked, without a trusted host key. */
export const addVaultSshServer = defineCommand({
  name: 'vault.addSshServer',
  schema: ServerFields.extend({ entryId: VaultEntryId }),
  async apply(tx, ctx, input) {
    const entry = await ownSshEntry(ctx, input.entryId);
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(vaultSshServers)
      .where(eq(vaultSshServers.entryId, entry.id));
    if ((count?.n ?? 0) >= VAULT_SSH_SERVERS_MAX)
      throw vaultError(
        'limit_reached',
        { limit: 'servers', max: VAULT_SSH_SERVERS_MAX },
        VAULT_LIMIT_MESSAGES.servers,
      );
    if (await nameTaken(ctx, entry.id, input.name)) throw nameTakenError();
    const id = newId('vaultSshServer');
    await tx.insert(vaultSshServers).values({
      id,
      burrowId: ctx.burrow.id,
      entryId: entry.id,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      production: input.production ?? false,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
    const eventId = await entryChanged(ctx, entry);
    return { entryId: entry.id, serverId: id, eventId };
  },
});

/**
 * “Edit” on a server. A new host or port forgets the trusted host key (and the one last seen) and the check; a new
 * username resets the check (it said who it signed in as). Its connections close.
 */
export const updateVaultSshServer = defineCommand({
  name: 'vault.updateSshServer',
  schema: z.object({ entryId: VaultEntryId, serverId: VaultSshServerId, changes: ServerFields.partial() }),
  async apply(tx, ctx, input) {
    const entry = await ownSshEntry(ctx, input.entryId);
    const server = await ownServer(ctx, entry, input.serverId);
    const next = {
      name: input.changes.name ?? server.name,
      host: input.changes.host ?? server.host,
      port: input.changes.port ?? server.port,
      username: input.changes.username ?? server.username,
      production: input.changes.production ?? server.production,
    };
    const moved = next.host !== server.host || next.port !== server.port;
    const renamedUser = next.username !== server.username;
    if (!moved && !renamedUser && next.name === server.name && next.production === server.production)
      return { entryId: entry.id, serverId: server.id, eventId: null };
    if (next.name !== server.name && (await nameTaken(ctx, entry.id, next.name, server.id)))
      throw nameTakenError();
    const resetCheck = {
      checkStatus: 'unchecked' as const,
      checkOutcome: null,
      checkSummary: '',
      checkedAt: null,
    };
    await tx
      .update(vaultSshServers)
      .set({
        ...next,
        ...(moved
          ? {
              hostKeyAlgorithm: null,
              hostKeyFingerprint: null,
              hostKeyTrustedAt: null,
              hostKeyBlob: null,
              seenHostKeyAlgorithm: null,
              seenHostKeyFingerprint: null,
              seenHostKeyAt: null,
              // A kept password was for that server only (vault-simplify.md CT-1664): a new host or port forgets it.
              passwordSealed: null,
              passwordSetAt: null,
            }
          : {}),
        ...(moved || renamedUser ? resetCheck : {}),
        updatedAt: ctx.now,
      })
      .where(eq(vaultSshServers.id, server.id));
    const eventId = await entryChanged(ctx, entry);
    return { entryId: entry.id, serverId: server.id, eventId };
  },
});

/** Removes a server: its connections close; keys that listed it cover the rest (one left with none covers nothing). */
export const removeVaultSshServer = defineCommand({
  name: 'vault.removeSshServer',
  schema: z.object({ entryId: VaultEntryId, serverId: VaultSshServerId }),
  async apply(tx, ctx, input) {
    const entry = await ownSshEntry(ctx, input.entryId);
    const server = await ownServer(ctx, entry, input.serverId);
    await forgetCheckServerRows(tx, [server.id]);
    await tx.delete(vaultSshServers).where(eq(vaultSshServers.id, server.id));
    await tx
      .update(vaultEntries)
      .set({ agentServers: sql`array_remove(${vaultEntries.agentServers}, ${server.id})` })
      .where(and(eq(vaultEntries.id, entry.id), sql`${vaultEntries.agentServers} is not null`));
    const eventId = await entryChanged(ctx, entry);
    return { entryId: entry.id, serverId: server.id, eventId };
  },
});

/* Checks and trust (VT-S05) ---------------------------------------------------------------------------- */

/** Where a check or a trust was made: refused when the server moved since (the key read belongs to the old place). */
const At = z.object({ host: z.string(), port: z.number().int() });

/**
 * Records a server's check (no signed event, VT-D08): the status line and outcome, and the host key it saw when that
 * isn't the trusted one (`host_key_unconfirmed`, `host_key_changed`) — a signed-in check clears it. A server that moved
 * since the check started keeps its own state.
 */
export const recordVaultSshCheck = defineCommand({
  name: 'vault.record_ssh_check',
  schema: z.object({
    entryId: VaultEntryId,
    serverId: VaultSshServerId,
    at: At,
    result: VaultSshCheckResult,
  }),
  async apply(tx, ctx, input) {
    const entry = await ownSshEntry(ctx, input.entryId);
    const server = await ownServer(ctx, entry, input.serverId);
    if (server.host !== input.at.host || server.port !== input.at.port) return { recorded: false };
    const { result } = input;
    const sawUntrusted =
      (result.outcome === 'host_key_unconfirmed' || result.outcome === 'host_key_changed') && result.hostKey;
    await tx
      .update(vaultSshServers)
      .set({
        checkStatus: result.status,
        checkOutcome: result.outcome,
        checkSummary: result.summary,
        checkedAt: new Date(result.checkedAt),
        ...(sawUntrusted && result.hostKey
          ? {
              seenHostKeyAlgorithm: result.hostKey.algorithm,
              seenHostKeyFingerprint: result.hostKey.fingerprint,
              seenHostKeyAt: new Date(result.checkedAt),
            }
          : result.outcome === 'reached'
            ? { seenHostKeyAlgorithm: null, seenHostKeyFingerprint: null, seenHostKeyAt: null }
            : {}),
      })
      .where(eq(vaultSshServers.id, server.id));
    publishVaultUpdated(ctx, entry.ownerId, entry.id);
    return { recorded: true };
  },
});

/**
 * “Trust this server” (VT-S05): the host key the handler read again — equal to the fingerprint the person saw — becomes
 * the pin; the one last seen is cleared; the server's connections close. Signs “Changed a private Vault entry”.
 */
export const trustVaultSshHostKey = defineCommand({
  name: 'vault.trustSshHostKey',
  schema: z.object({
    entryId: VaultEntryId,
    serverId: VaultSshServerId,
    at: At,
    hostKey: VaultSshHostKey,
  }),
  async apply(tx, ctx, input) {
    const entry = await ownSshEntry(ctx, input.entryId);
    const server = await ownServer(ctx, entry, input.serverId);
    if (server.host !== input.at.host || server.port !== input.at.port)
      throw vaultError('host_key_mismatch', {}, 'This server changed while it was checked. Check it again.');
    await tx
      .update(vaultSshServers)
      .set({
        hostKeyAlgorithm: input.hostKey.algorithm,
        hostKeyFingerprint: input.hostKey.fingerprint,
        hostKeyTrustedAt: ctx.now,
        hostKeyBlob: null,
        seenHostKeyAlgorithm: null,
        seenHostKeyFingerprint: null,
        seenHostKeyAt: null,
        updatedAt: ctx.now,
      })
      .where(eq(vaultSshServers.id, server.id));
    const eventId = await entryChanged(ctx, entry);
    return { entryId: entry.id, serverId: server.id, eventId };
  },
});

/**
 * An agent's first contact with a server that has no pin (vault-self-serve.md VS-10): the key it showed becomes the pin,
 * signed “Changed a private Vault entry” by the agent (as Sign in once's trust, SI-04). Under the burrow lock the server
 * must still be where it was met and unpinned, the entry must be switched on for the agent, and no other server of the person's
 * at that address may pin another key (`vaultPins`); otherwise nothing changes, and the answer says what is pinned now
 * and whether that (or another server's pin) is another key than the one met (`changed`). Nothing is closed.
 */
export const trustVaultSshFirstContact = defineCommand({
  name: 'vault.ssh_first_contact',
  schema: z.object({
    entryId: VaultEntryId,
    serverId: VaultSshServerId,
    at: At,
    hostKey: VaultSshHostKey,
  }),
  async apply(
    tx,
    ctx,
    input,
  ): Promise<{ pinned: VaultSshHostKey | null; changed: boolean; eventId: string | null }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents use Vault entries.');
    const none = { pinned: null, changed: false, eventId: null };
    const entry = await entryById(tx, input.entryId);
    if (!entry || entry.burrowId !== ctx.burrow.id) return none;
    if (!(await agentKeyFor(tx, entry, ctx.actor.id))) return none;
    const [server] = await tx
      .select()
      .from(vaultSshServers)
      .where(and(eq(vaultSshServers.entryId, entry.id), eq(vaultSshServers.id, input.serverId)));
    if (!server || server.host !== input.at.host || server.port !== input.at.port) return none;
    if (server.hostKeyAlgorithm && server.hostKeyFingerprint)
      return {
        pinned: { algorithm: server.hostKeyAlgorithm, fingerprint: server.hostKeyFingerprint },
        changed: server.hostKeyFingerprint !== input.hostKey.fingerprint,
        eventId: null,
      };
    const pins = await vaultPins(tx, entry.burrowId, entry.ownerId, server.host, server.port);
    if (pins.length && !pins.some((p) => p.fingerprint === input.hostKey.fingerprint))
      return { ...none, changed: true };
    await tx
      .update(vaultSshServers)
      .set({
        hostKeyAlgorithm: input.hostKey.algorithm,
        hostKeyFingerprint: input.hostKey.fingerprint,
        hostKeyTrustedAt: ctx.now,
        hostKeyBlob: null,
        seenHostKeyAlgorithm: null,
        seenHostKeyFingerprint: null,
        seenHostKeyAt: null,
        updatedAt: ctx.now,
      })
      .where(eq(vaultSshServers.id, server.id));
    const eventId = await entryChanged(ctx, entry);
    return { pinned: input.hostKey, changed: false, eventId };
  },
});

/* Keys that cover servers (VT-S07) ----------------------------------------------------------------------- */

/** Which of the entry's servers the agent may sign in to; covering less closes the agent's connections. */
export const setVaultKeyServers = defineCommand({
  name: 'vault.setKeyServers',
  schema: z.object({ entryId: VaultEntryId, servers: VaultKeyServersChoice }),
  async apply(tx, ctx, input) {
    const entry = await ownSshEntry(ctx, input.entryId);
    const agent = await keyAgent(ctx);
    const key = agentKeyOf(entry);
    if (!key) throw notFound('Key');
    const servers = await checkedKeyServers(ctx, entry, input.servers);
    if (sameServers(key.servers, servers)) return { entryId: entry.id, eventId: null };
    await tx.update(vaultEntries).set({ agentServers: servers }).where(eq(vaultEntries.id, entry.id));
    const event = await ctx.emit({
      type: 'vault.key.changed',
      kind: 'Vault',
      text: vaultAuditText('key.changed', { agentName: shortName(agent) }),
      ...keyEventFields(entry, agent),
    });
    publishVaultUpdated(ctx, entry.ownerId, entry.id);
    return { entryId: entry.id, eventId: event.id };
  },
});

/* A changed host key met by an agent (VT-S05) ------------------------------------------------------------- */

/** What the person is told when the agent's connection met a changed host key (no entry or server name, VT-D24). */
export function sshHostKeyChangedText(locale?: string | null): string {
  return tServer(locale, 'chat.sshHostKeyChanged');
}

/** The same words in English. */
export const SSH_HOST_KEY_CHANGED_DM = sshHostKeyChangedText('en');

/**
 * An agent's connection met another host key than the pinned one (VT-S05): Whombat didn't sign in; the server reads
 * failing with the key it showed (the agent is refused until the person trusts one), the use is recorded `refused`
 * (signed `vault.refused` as the agent), and the person is told in their Chat — once per new key.
 */
export const sshHostKeyChanged = defineCommand({
  name: 'vault.ssh_host_key_changed',
  schema: z.object({
    entryId: VaultEntryId,
    serverId: VaultSshServerId,
    hostKey: VaultSshHostKey,
    dispatchId: z.string(),
    what: z.string().max(2000),
    requesterId: z.string().nullable(),
    where: z.string().max(200).nullable(),
    ms: z.number().int().nonnegative(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents use Vault entries.');
    const entry = await entryById(tx, input.entryId);
    if (!entry || entry.burrowId !== ctx.burrow.id) return { eventId: null };
    const [server] = await tx
      .select()
      .from(vaultSshServers)
      .where(and(eq(vaultSshServers.entryId, entry.id), eq(vaultSshServers.id, input.serverId)));
    const fresh = !!server && server.seenHostKeyFingerprint !== input.hostKey.fingerprint;
    if (server && fresh) {
      const outcome: z.output<typeof VaultCheckOutcome> = 'host_key_changed';
      await tx
        .update(vaultSshServers)
        .set({
          seenHostKeyAlgorithm: input.hostKey.algorithm,
          seenHostKeyFingerprint: input.hostKey.fingerprint,
          seenHostKeyAt: ctx.now,
          checkStatus: vaultSshCheckStatus(outcome),
          checkOutcome: outcome,
          checkSummary: vaultSshCheckSummary(outcome),
          checkedAt: ctx.now,
        })
        .where(eq(vaultSshServers.id, server.id));
    }
    const eventId = await signVaultUse(ctx, entry, {
      dispatchId: input.dispatchId,
      requesterId: input.requesterId,
      where: input.where,
      what: input.what,
      outcome: 'refused',
      status: null,
      server: server?.name ?? null,
      ms: input.ms,
      bytes: null,
    });
    if (fresh) await tellPerson(ctx, sshHostKeyChangedText(await burrowLocale(ctx.services, ctx.burrow.id)));
    publishVaultUpdated(ctx, entry.ownerId, entry.id);
    return { eventId };
  },
});

export const VAULT_SSH_COMMANDS = [
  createVaultSshEntry,
  replaceVaultSshKey,
  addVaultSshServer,
  updateVaultSshServer,
  removeVaultSshServer,
  recordVaultSshCheck,
  trustVaultSshHostKey,
  setVaultKeyServers,
  sshHostKeyChanged,
  trustVaultSshFirstContact,
];
