/**
 * Vault commands (docs/decisions/vault.md): every change to an entry, its tools and its switch for the agent
 * (docs/decisions/vault-simplify.md VLT-10) goes through the commit pipeline, made by the person, with a signed event
 * whose text is neutral (VT-51: “Added a private Vault entry”, “Gave Dusty a key to a private Vault entry”) and whose
 * payload carries ids and a keyed hash of the detail, never a name, tool, path or status. A secret is sealed inside the
 * command (AAD `vault:<entryId>:secret`) and never returned, signed or published (VT-04).
 *
 * The destination rule (VT-13) needs DNS, so the REST handler checks a new address before committing; calls check
 * it again every time (`net.ts`). Checks (VT-44) run outside the transaction and are recorded here.
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  type AuditVaultDetail,
  CreateVaultEntryBody,
  canonicalJson,
  defaultVaultEnvName,
  mergeVaultTools,
  newId,
  topics,
  UpdateVaultEntryBody,
  VAULT_ENTRIES_MAX,
  VAULT_ERROR_MESSAGES,
  VAULT_ERROR_STATUS,
  VAULT_LIMIT_MESSAGES,
  VAULT_TOOLS_MAX,
  type VaultAuth,
  VaultCheckResult,
  VaultEntryId,
  VaultEnvName,
  type VaultErrorCode,
  VaultKeyServersChoice,
  VaultSecretValue,
  type VaultUseOutcome,
  VaultUsername,
  vaultAuditText,
  vaultEntryKey,
  vaultEntryShapeProblems,
  vaultKeyDeliverable,
  vaultSecretProblem,
} from '@whombat/core';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { forgetHeldSecrets } from '../agent-commands/secrets';
import { type ApplyContext, defineCommand } from '../commit/types';
import {
  checkServerClients,
  checkServers,
  vaultEntries,
  vaultSshServers,
  vaultTools,
  vaultUses,
} from '../db/schema/index';
import { ApiError, forbidden, notFound } from '../lib/errors';
import { loadAgentRow, loadPrincipalRow, type PrincipalRow, shortName } from '../read/principals';
import { tellPersonToRotate } from './rotate';
import { forgetPassphrase } from './ssh-keys';
import {
  agentKeyOf,
  entryCount,
  ownEntry,
  toolRows,
  type VaultEntryRow,
  vaultSecretAad,
  vaultTotpAad,
} from './store';
import { canonicalTotp } from './totp-code';

export const VAULT_WHERE = 'Vault';

/* Helpers --------------------------------------------------------------------------------------- */

/** A Vault refusal with its code in `error.details` (contracts `VAULT_ERROR_CODES`). */
export function vaultError(
  code: VaultErrorCode,
  extra: Record<string, unknown> = {},
  message: string = VAULT_ERROR_MESSAGES[code],
): ApiError {
  return new ApiError(VAULT_ERROR_STATUS[code], message, { details: { code, ...extra } as never });
}

/** A field error, like the contract's `validation_failed`. */
export function fieldError(
  fields: Record<string, string[]>,
  message = 'Some fields are not valid.',
): ApiError {
  return new ApiError('validation_failed', message, { fields });
}

/** Only a person manages their Vault; an agent never does (it has no entries and changes no keys). */
export function requirePerson(ctx: ApplyContext) {
  if (ctx.actor.kind !== 'person') throw forbidden('Only people manage Vault entries.');
}

/** The keyed hash of a use's detail (VT-51, VT-D05): proves the detail without letting anyone test a guess. */
export function detailHash(entry: Pick<VaultEntryRow, 'detailSalt'>, detail: AuditVaultDetail): string {
  return createHmac('sha256', Buffer.from(entry.detailSalt, 'base64'))
    .update(canonicalJson(detail))
    .digest('hex');
}

/** `vault.updated` to the person (topic `me`), carrying no entry data. */
export function publishVaultUpdated(
  ctx: Pick<ApplyContext, 'publish'>,
  ownerId: string,
  entryId: string | null,
): void {
  ctx.publish(topics.me(ownerId), { type: 'vault.updated', entryId });
}

type EntryEvent = 'entry.added' | 'entry.changed' | 'entry.secret_replaced' | 'entry.removed' | 'entry.saved';

/** An entry's signed event, neutral (VT-51); `extra` adds ids to the payload (VS-07: the messages a save blanked). */
export async function emitEntryEvent(
  ctx: ApplyContext,
  kind: EntryEvent,
  entry: VaultEntryRow,
  extra: Record<string, string[]> = {},
) {
  const detail: AuditVaultDetail = { entryId: entry.id, entryName: entry.name, what: null, outcome: null };
  return ctx.emit({
    type: `vault.${kind}`,
    kind: 'Vault',
    text: vaultAuditText(kind),
    where: VAULT_WHERE,
    payload: { entryId: entry.id, detail: detailHash(entry, detail), ...extra },
  });
}

/**
 * One use of an entry by the acting agent: the signed neutral line (`vault.used`, or `vault.refused` shown as Blocked)
 * and the row that says which entry it was; returns the line's id. `what` keeps the 300 characters a record
 * shows. The caller publishes `vault.updated` once its own changes are made.
 */
export async function signVaultUse(
  ctx: ApplyContext,
  entry: VaultEntryRow,
  use: {
    dispatchId: string | null;
    requesterId: string | null;
    where: string | null;
    what: string;
    outcome: VaultUseOutcome;
    status: number | null;
    /** An SSH use: the server's name as it was then. */
    server: string | null;
    ms: number;
    bytes: number | null;
  },
): Promise<string> {
  const refused = use.outcome === 'refused';
  const what = use.what.slice(0, 300);
  const useId = newId('vaultUse');
  const event = await ctx.emit({
    type: refused ? 'vault.refused' : 'vault.used',
    kind: refused ? 'Blocked' : 'Vault',
    text: vaultAuditText(refused ? 'refused' : 'used'),
    where: use.where,
    payload: {
      entryId: entry.id,
      useId,
      dispatchId: use.dispatchId,
      detail: detailHash(entry, { entryId: entry.id, entryName: entry.name, what, outcome: use.outcome }),
    },
  });
  await ctx.tx.insert(vaultUses).values({
    id: useId,
    burrowId: ctx.burrow.id,
    entryId: entry.id,
    agentId: ctx.actor.id,
    requesterId: use.requesterId,
    dispatchId: use.dispatchId,
    what,
    outcome: use.outcome,
    status: use.status,
    server: use.server,
    exitCode: null,
    ms: use.ms,
    bytes: use.bytes,
    eventId: event.id,
    at: ctx.now,
  });
  return event.id;
}

/** After commit: the forms of values the agent holds are read again (a key given, taken or switched, AC-32). */
export function forgetHeldSecretsAfter(ctx: Pick<ApplyContext, 'services' | 'after'>, agentId?: string) {
  const services = ctx.services;
  forgetHeldSecrets(services, agentId);
  ctx.after(async () => forgetHeldSecrets(services, agentId));
}

async function accountOfActor(ctx: ApplyContext): Promise<string> {
  const row = await loadPrincipalRow(ctx.tx, ctx.actor.id);
  if (!row?.accountId) throw forbidden('Only people manage Vault entries.');
  return row.accountId;
}

/**
 * Inserts a new entry for the actor (with its sealed secret); returns the row. `owner`: the person, when the actor is
 * the agent saving what they sent it (vault-self-serve.md VS-04): the person's routes never pass it, so they stay
 * `requirePerson`. `savedById`: that agent (VS-07: what it saved is scrubbed from what it writes).
 */
export async function insertEntry(
  ctx: ApplyContext,
  input: z.output<typeof CreateVaultEntryBody>,
  options: {
    skipLimit?: boolean;
    id?: string;
    owner?: { principalId: string; accountId: string };
    savedById?: string;
  } = {},
): Promise<VaultEntryRow> {
  if (!options.owner) requirePerson(ctx);
  const ownerId = options.owner?.principalId ?? ctx.actor.id;
  const accountId = options.owner?.accountId ?? (await accountOfActor(ctx));
  if (!options.skipLimit && (await entryCount(ctx.tx, ctx.burrow.id, ownerId)) >= VAULT_ENTRIES_MAX)
    throw vaultError(
      'limit_reached',
      { limit: 'entries', max: VAULT_ENTRIES_MAX },
      VAULT_LIMIT_MESSAGES.entries,
    );
  // An SSH key's id is made before its key (the key's comment names the entry, VT-D43).
  const id = options.id ?? newId('vaultEntry');
  const secret = input.secret ?? null;
  const [row] = await ctx.tx
    .insert(vaultEntries)
    .values({
      id,
      burrowId: ctx.burrow.id,
      ownerId,
      ownerAccountId: accountId,
      kind: input.kind,
      name: input.name,
      description: input.description,
      url: input.kind === 'secret' || input.kind === 'ssh' ? null : (input.url ?? null),
      auth: input.kind === 'secret' ? null : (input.auth ?? null),
      sealed: secret !== null ? ctx.services.custody.seal(vaultSecretAad(id), secret) : null,
      secretSetAt: secret !== null ? ctx.now : null,
      // A website login's authenticator key (vault-simplify.md VLT-46), sealed in core's one form beside the password.
      ...(input.kind === 'login' && input.totp
        ? {
            totpSealed: ctx.services.custody.seal(vaultTotpAad(id), canonicalTotp(input.totp)),
            totpSetAt: ctx.now,
          }
        : {}),
      toolKey: vaultEntryKey(id),
      detailSalt: randomBytes(16).toString('base64'),
      savedById: options.savedById ?? null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  if (!row) throw new Error('vault entry not inserted');
  return row;
}

/**
 * Every entry the person saves is switched on for the agent from the moment it's saved (vault-self-serve.md VS-01,
 * one-agent.md OA-09): All servers, an API's default variable, in the commit that made the entry, signed
 * `vault.key.given` by whoever made it — used only in the person's own turns (OA-10). Not for a `secret` entry (from
 * before skill-store.md SST-09). Returns the agent, or null when there is none yet.
 */
export async function giveOwnAssistantKey(
  ctx: ApplyContext,
  row: VaultEntryRow,
): Promise<PrincipalRow | null> {
  if (row.kind === 'secret') return null;
  const agent = await loadAgentRow(ctx.tx, row.burrowId);
  if (!agent) return null;
  if (row.agentOnAt) return agent;
  await ctx.tx
    .update(vaultEntries)
    .set(switchedOn(row, undefined, ctx.now))
    .where(eq(vaultEntries.id, row.id));
  // Its value reaches the agent in the person's turns: what the agent posts is scrubbed of it (agent-computer.md AC-32).
  forgetHeldSecretsAfter(ctx, agent.id);
  await ctx.emit({
    type: 'vault.key.given',
    kind: 'Vault',
    text: vaultAuditText('key.given', { agentName: shortName(agent) }),
    ...keyEventFields(row, agent),
  });
  return agent;
}

/* Entries --------------------------------------------------------------------------------------- */

/** “Add to Vault” (VT-70). The destination was checked by the caller (`checkDestination`). */
export const createVaultEntry = defineCommand({
  name: 'vault.create',
  schema: CreateVaultEntryBody,
  async apply(_tx, ctx, input) {
    const row = await insertEntry(ctx, input);
    const event = await emitEntryEvent(ctx, 'entry.added', row);
    await giveOwnAssistantKey(ctx, row);
    publishVaultUpdated(ctx, ctx.actor.id, row.id);
    return { entryId: row.id, eventId: event.id };
  },
});

export const updateVaultEntry = defineCommand({
  name: 'vault.update',
  schema: z.object({ entryId: VaultEntryId, changes: UpdateVaultEntryBody }),
  async apply(tx, ctx, { entryId, changes }) {
    requirePerson(ctx);
    const row = await ownEntry(tx, ctx.burrow.id, ctx.actor.id, entryId);
    if (row.kind === 'secret' && (changes.url !== undefined || changes.auth !== undefined))
      throw vaultError('wrong_kind', {}, 'This secret has no address or sign-in.');
    // An SSH key changes only its name and description here: its key and servers have their own ops (VT-S03, VT-S04).
    if (row.kind === 'ssh' && (changes.url !== undefined || changes.auth !== undefined))
      throw vaultError(
        'wrong_kind',
        {},
        'An SSH key has no address or sign-in of its own: change its key or servers.',
      );
    const url = changes.url ?? row.url;
    const auth = (changes.auth ?? row.auth) as VaultAuth | null;
    const problems = vaultEntryShapeProblems({ kind: row.kind, url, auth }, 'update');
    if (problems.length) throw fieldError(Object.fromEntries(problems.map((p) => [p.field, [p.message]])));
    // A secret that travels in a header can't hold line breaks (a switch from `query` could make it one).
    if (auth && row.sealed && changes.auth !== undefined) {
      const secret = ctx.services.custody.open(vaultSecretAad(row.id), row.sealed);
      const problem = vaultSecretProblem(auth, secret);
      if (problem) throw fieldError({ auth: [`${problem} Replace the secret first.`] });
    }
    const signInChanged = JSON.stringify(auth) !== JSON.stringify(row.auth);
    const urlChanged = url !== row.url;
    const next = {
      name: changes.name ?? row.name,
      description: changes.description ?? row.description,
      url,
      auth,
    };
    const changed =
      next.name !== row.name || next.description !== row.description || urlChanged || signInChanged;
    if (!changed) return { entryId: row.id, eventId: null };
    // Signing in with nothing forgets the secret; a new address or sign-in is checked again (VT-44).
    const forget = auth?.type === 'none' && row.sealed !== null;
    const [updated] = await tx
      .update(vaultEntries)
      .set({
        ...next,
        ...(forget ? { sealed: null, secretSetAt: null } : {}),
        ...(urlChanged || signInChanged
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
    const event = await emitEntryEvent(ctx, 'entry.changed', updated);
    forgetHeldSecretsAfter(ctx);
    publishVaultUpdated(ctx, ctx.actor.id, row.id);
    return { entryId: row.id, eventId: event.id };
  },
});

/** Replaces the secret (the only change a secret gets, VT-04); a login may change its username with it. */
export async function replaceSecret(
  ctx: ApplyContext,
  row: VaultEntryRow,
  value: string,
  username?: string | undefined,
  /** The person's assistant that saved it from their chat (VS-07): its value is scrubbed from what that one writes. */
  savedById?: string,
): Promise<string> {
  const auth = row.auth as VaultAuth | null;
  if (row.kind !== 'secret' && auth?.type === 'none')
    throw fieldError({ secret: ['Nothing to paste: it signs in with nothing.'] });
  if (username !== undefined && auth?.type !== 'basic' && auth?.type !== 'form')
    throw fieldError({ username: ['Only a login has a username.'] });
  // A website login keeps its selectors when its username changes (VT-D28, CT-125).
  const nextAuth: VaultAuth | null =
    username === undefined
      ? auth
      : auth?.type === 'basic'
        ? { type: 'basic', username }
        : auth?.type === 'form'
          ? { ...auth, username }
          : auth;
  const problem = row.kind === 'secret' ? null : vaultSecretProblem(nextAuth, value);
  if (problem) throw fieldError({ secret: [problem] });
  const [updated] = await ctx.tx
    .update(vaultEntries)
    .set({
      sealed: ctx.services.custody.seal(vaultSecretAad(row.id), value),
      secretSetAt: ctx.now,
      auth: nextAuth,
      // A person replacing it themselves leaves who saved it before: that one may still have read the old value.
      ...(savedById ? { savedById } : {}),
      updatedAt: ctx.now,
    })
    .where(eq(vaultEntries.id, row.id))
    .returning();
  if (!updated) throw notFound('Vault entry');
  const event = await emitEntryEvent(ctx, 'entry.secret_replaced', updated);
  forgetHeldSecretsAfter(ctx);
  publishVaultUpdated(ctx, updated.ownerId, row.id);
  return event.id;
}

export const setVaultSecret = defineCommand({
  name: 'vault.setSecret',
  schema: z.object({ entryId: VaultEntryId, value: VaultSecretValue, username: VaultUsername.optional() }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await ownEntry(tx, ctx.burrow.id, ctx.actor.id, input.entryId);
    // An SSH key's key is replaced by an import or a new key (`vault.replaceSshKey`, `vault.generateSshKey`).
    if (row.kind === 'ssh')
      throw vaultError(
        'wrong_kind',
        {},
        'Replace an SSH key with “Generate a new key” or “Replace with my own key”.',
      );
    const eventId = await replaceSecret(ctx, row, input.value, input.username);
    return { entryId: row.id, eventId };
  },
});

/**
 * Rows of the removed check servers that still point at these Vault servers: they would hold the servers' removal
 * back, and nothing uses them any more (docs/decisions/fast-testing.md).
 */
export async function forgetCheckServerRows(
  tx: ApplyContext['tx'],
  serverIds: readonly string[],
): Promise<void> {
  if (!serverIds.length) return;
  await tx.delete(checkServerClients).where(inArray(checkServerClients.serverId, [...serverIds]));
  await tx.delete(checkServers).where(inArray(checkServers.serverId, [...serverIds]));
}

/**
 * Removes one of the person's entries (VT-06): its servers' leftover check rows, a note to rotate what the agent's
 * commands had (AC-34), the signed neutral event, the row with its secret, keys, tools and RECENT USE, and the held
 * forms of its value. The person's own Remove and the 1Password sync's removals both come here.
 */
export async function removeEntry(ctx: ApplyContext, row: VaultEntryRow): Promise<string> {
  const tx = ctx.tx;
  if (row.kind === 'ssh') {
    const servers = await tx
      .select({ id: vaultSshServers.id })
      .from(vaultSshServers)
      .where(eq(vaultSshServers.entryId, row.id));
    await forgetCheckServerRows(
      tx,
      servers.map((s) => s.id),
    );
  }
  // The agent's commands had it and may have kept a copy: the person is told to rotate it (AC-34), before the
  // entry and its servers go.
  const agent = agentKeyOf(row) ? await loadAgentRow(tx, ctx.burrow.id) : undefined;
  if (agent) await tellPersonToRotate(ctx, row, shortName(agent), { removed: true });
  const event = await emitEntryEvent(ctx, 'entry.removed', row);
  await tx.delete(vaultEntries).where(eq(vaultEntries.id, row.id));
  forgetHeldSecretsAfter(ctx);
  ctx.after(async () => forgetPassphrase(row.id));
  publishVaultUpdated(ctx, row.ownerId, row.id);
  return event.id;
}

/** Removes an entry: secret, keys, tools and RECENT USE go with it (VT-06). */
export const removeVaultEntry = defineCommand({
  name: 'vault.remove',
  schema: z.object({ entryId: VaultEntryId }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await ownEntry(tx, ctx.burrow.id, ctx.actor.id, input.entryId);
    const eventId = await removeEntry(ctx, row);
    return { entryId: row.id, eventId };
  },
});

/** A tool as `check` recorded it (listed, scrubbed and bounded by the pool). */
const ListedTool = z.object({
  name: z.string().min(1).max(200),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  annotations: z.unknown().optional(),
});

/**
 * Records a check (VT-44), no signed event: the status line and, for a reached `mcp` entry, its tools — the first
 * check turns every tool on; a new or changed tool is off with “New” (core `mergeVaultTools`).
 */
export const recordVaultCheck = defineCommand({
  name: 'vault.record_check',
  schema: z.object({
    entryId: VaultEntryId,
    result: VaultCheckResult,
    tools: z.array(ListedTool).max(VAULT_TOOLS_MAX).nullable(),
    /** Tools the server listed beyond `VAULT_TOOLS_MAX` (ignored, counted). */
    beyond: z.number().int().nonnegative().default(0),
  }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await ownEntry(tx, ctx.burrow.id, ctx.actor.id, input.entryId);
    let toolCount = row.toolCount;
    let ignored = row.toolsIgnored;
    if (row.kind === 'mcp' && input.tools) {
      const stored = await toolRows(tx, row.id);
      const merged = mergeVaultTools(stored, input.tools, row.toolCount === null);
      const schemas = new Map(input.tools.map((t) => [t.name, t.inputSchema]));
      await tx.delete(vaultTools).where(eq(vaultTools.entryId, row.id));
      if (merged.tools.length)
        await tx.insert(vaultTools).values(
          merged.tools.map((t, position) => ({
            entryId: row.id,
            name: t.name,
            description: t.description,
            inputSchema: (schemas.get(t.name) as Record<string, unknown> | undefined) ?? null,
            hash: t.hash,
            enabled: t.enabled,
            isNew: t.isNew,
            mcpName: `vt_${row.toolKey}__${t.name}`,
            position,
          })),
        );
      ignored = merged.ignored + input.beyond;
      toolCount = merged.tools.length + ignored;
      forgetHeldSecretsAfter(ctx);
    }
    await tx
      .update(vaultEntries)
      .set({
        checkStatus: input.result.status,
        checkOutcome: input.result.outcome,
        checkSummary: input.result.summary,
        checkHttpStatus: input.result.httpStatus,
        checkedAt: new Date(input.result.checkedAt),
        toolCount,
        toolsIgnored: ignored,
      })
      .where(eq(vaultEntries.id, row.id));
    publishVaultUpdated(ctx, ctx.actor.id, row.id);
    return { entryId: row.id };
  },
});

/** One of an `mcp` entry's tools on or off (either clears “New”); a change is `vault.entry.changed`. */
export const setVaultTool = defineCommand({
  name: 'vault.setTool',
  schema: z.object({ entryId: VaultEntryId, tool: z.string().min(1).max(200), enabled: z.boolean() }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await ownEntry(tx, ctx.burrow.id, ctx.actor.id, input.entryId);
    if (row.kind !== 'mcp') throw vaultError('wrong_kind', {}, 'Only an MCP server has tools.');
    const [tool] = await tx
      .select()
      .from(vaultTools)
      .where(and(eq(vaultTools.entryId, row.id), eq(vaultTools.name, input.tool)));
    if (!tool) throw notFound('Tool');
    if (tool.enabled === input.enabled && !tool.isNew) return { entryId: row.id, eventId: null };
    await tx
      .update(vaultTools)
      .set({ enabled: input.enabled, isNew: false })
      .where(and(eq(vaultTools.entryId, row.id), eq(vaultTools.name, input.tool)));
    const [updated] = await tx
      .update(vaultEntries)
      .set({ updatedAt: ctx.now })
      .where(eq(vaultEntries.id, row.id))
      .returning();
    const event =
      tool.enabled === input.enabled ? null : await emitEntryEvent(ctx, 'entry.changed', updated ?? row);
    publishVaultUpdated(ctx, ctx.actor.id, row.id);
    return { entryId: row.id, eventId: event?.id ?? null };
  },
});

/* The agent's switch (VLT-10) ---------------------------------------------------------------------- */

/** The agent an entry is switched on for: the Whombat's one agent (one-agent.md OA-10). */
export async function keyAgent(ctx: ApplyContext) {
  const agent = await loadAgentRow(ctx.tx, ctx.burrow.id);
  if (!agent) throw notFound('Agent');
  return agent;
}

export function keyEventFields(entry: VaultEntryRow, agent: { id: string; handle: string }) {
  return {
    where: VAULT_WHERE,
    aboutId: agent.id,
    ref: { type: 'agent' as const },
    payload: {
      entryId: entry.id,
      agentId: agent.id,
      detail: detailHash(entry, { entryId: entry.id, entryName: entry.name, what: null, outcome: null }),
    },
  };
}

/**
 * `vault.giveKey`: switches the entry on for the agent (`agent_on_at`), or changes an SSH key's servers or an API's
 * variable while it is on. The op keeps its name: older apps send it (VLT-10).
 */
export const giveVaultKey = defineCommand({
  name: 'vault.giveKey',
  schema: z.object({
    entryId: VaultEntryId,
    /** An `ssh` entry (VT-S07): null All servers, a list only those; absent keeps them (All the first time). */
    servers: VaultKeyServersChoice.optional(),
    /** An `http` entry's environment variable for the commands (AC-31): absent keeps the entry's, or the name's default. */
    envName: VaultEnvName.optional(),
  }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await ownEntry(tx, ctx.burrow.id, ctx.actor.id, input.entryId);
    if (row.kind === 'secret') throw vaultError('wrong_kind', {}, 'This secret can’t be given to an agent.');
    if (input.servers !== undefined && input.servers !== null && row.kind !== 'ssh')
      throw vaultError('wrong_kind', {}, 'Only an SSH key’s key covers servers.');
    const servers =
      input.servers === undefined ? undefined : await checkedKeyServers(ctx, row, input.servers);
    const agent = await keyAgent(ctx);
    const name = shortName(agent);
    const on = switchedOn(row, input.envName, row.agentOnAt ?? ctx.now);
    const serversChanged = servers !== undefined && !sameServers(row.agentServers ?? null, servers);
    // Its value reaches the agent in the person's turns: what the agent posts is scrubbed of it (AC-32).
    forgetHeldSecretsAfter(ctx, agent.id);
    const wasOn = row.agentOnAt !== null;
    if (wasOn && !serversChanged && on.envName === row.envName) return { entryId: row.id, eventId: null };
    await tx
      .update(vaultEntries)
      .set({ ...on, ...(serversChanged ? { agentServers: servers } : {}) })
      .where(eq(vaultEntries.id, row.id));
    const event = await ctx.emit({
      type: wasOn ? 'vault.key.changed' : 'vault.key.given',
      kind: 'Vault',
      text: vaultAuditText(wasOn ? 'key.changed' : 'key.given', { agentName: name }),
      ...keyEventFields(row, agent),
    });
    publishVaultUpdated(ctx, ctx.actor.id, row.id);
    return { entryId: row.id, eventId: event.id };
  },
});

/**
 * The switch on (hermes-engine.md HE-43; contracts CT-1240): since when, and an `http` entry's variable for the agent's
 * commands (AC-31) — the one asked for, else the entry's, else the name's default. The other kinds have none
 * (`validation_failed` when one is asked for).
 */
export function switchedOn(
  entry: Pick<VaultEntryRow, 'kind' | 'name' | 'envName'>,
  envName: string | undefined,
  onAt: Date,
): { agentOnAt: Date; envName: string | null } {
  if (entry.kind !== 'http') {
    if (envName !== undefined)
      throw fieldError({
        envName: [
          entry.kind === 'ssh'
            ? 'An SSH key reaches the agent’s commands as a file, not a variable.'
            : 'Only an API’s value is in an environment variable.',
        ],
      });
    return { agentOnAt: onAt, envName: null };
  }
  return { agentOnAt: onAt, envName: envName ?? entry.envName ?? defaultVaultEnvName(entry.name) };
}

/**
 * The environment variable an `http` entry's value is in for the agent's commands (`vault.setKeyEnvName`, AC-31,
 * CT-1240). Only while the entry is on (`404 Key` otherwise); `wrong_kind` for other kinds; signs `vault.key.changed`.
 */
export const setVaultKeyEnvName = defineCommand({
  name: 'vault.setKeyEnvName',
  schema: z.object({ entryId: VaultEntryId, envName: VaultEnvName }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await ownEntry(tx, ctx.burrow.id, ctx.actor.id, input.entryId);
    if (row.kind !== 'http')
      throw vaultError('wrong_kind', {}, 'Only an API’s value is in an environment variable.');
    const agent = await keyAgent(ctx);
    if (!row.agentOnAt) throw notFound('Key');
    if (row.envName === input.envName) return { entryId: row.id, eventId: null };
    await tx.update(vaultEntries).set({ envName: input.envName }).where(eq(vaultEntries.id, row.id));
    forgetHeldSecretsAfter(ctx, agent.id);
    const event = await ctx.emit({
      type: 'vault.key.changed',
      kind: 'Vault',
      text: vaultAuditText('key.changed', { agentName: shortName(agent) }),
      ...keyEventFields(row, agent),
    });
    publishVaultUpdated(ctx, ctx.actor.id, row.id);
    return { entryId: row.id, eventId: event.id };
  },
});

/** Whether two server choices are the same (null: All servers; order doesn't matter). */
export function sameServers(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

/** The servers as chosen, each one of the entry's (else 404 “Server”); null stays All servers (VT-S07). */
export async function checkedKeyServers(
  ctx: ApplyContext,
  row: VaultEntryRow,
  servers: readonly string[] | null,
): Promise<string[] | null> {
  if (servers === null) return null;
  if (row.kind !== 'ssh') throw vaultError('wrong_kind', {}, 'Only an SSH key’s key covers servers.');
  const own = await ctx.tx
    .select({ id: vaultSshServers.id })
    .from(vaultSshServers)
    .where(eq(vaultSshServers.entryId, row.id));
  const ids = new Set(own.map((s) => s.id));
  if (servers.some((id) => !ids.has(id))) throw notFound('Server');
  return [...new Set(servers)];
}

/**
 * `vault.takeKey`: switches the entry off for the agent. Its servers and variable stay for when it is switched on
 * again. Nothing to sign when it was off.
 */
export const takeVaultKey = defineCommand({
  name: 'vault.takeKey',
  schema: z.object({ entryId: VaultEntryId }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await ownEntry(tx, ctx.burrow.id, ctx.actor.id, input.entryId);
    const agent = await keyAgent(ctx);
    const off = await tx
      .update(vaultEntries)
      .set({ agentOnAt: null })
      .where(and(eq(vaultEntries.id, row.id), isNotNull(vaultEntries.agentOnAt)))
      .returning({ id: vaultEntries.id });
    forgetHeldSecretsAfter(ctx, agent.id);
    if (!off.length) return { entryId: row.id, eventId: null };
    // A key the agent's commands had: it may have kept a copy, so the person is told to rotate it (AC-34).
    if (vaultKeyDeliverable(row)) await tellPersonToRotate(ctx, row, shortName(agent));
    const event = await ctx.emit({
      type: 'vault.key.taken',
      kind: 'Vault',
      text: vaultAuditText('key.taken', { agentName: shortName(agent) }),
      ...keyEventFields(row, agent),
    });
    publishVaultUpdated(ctx, ctx.actor.id, row.id);
    return { entryId: row.id, eventId: event.id };
  },
});

export const VAULT_ENTRY_COMMANDS = [
  createVaultEntry,
  updateVaultEntry,
  setVaultSecret,
  removeVaultEntry,
  recordVaultCheck,
  setVaultTool,
  giveVaultKey,
  setVaultKeyEnvName,
  takeVaultKey,
];
