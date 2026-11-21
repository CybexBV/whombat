/**
 * What is left of agents using the Vault on the server's side once its relays went (docs/decisions/hermes-engine.md
 * HE-43, HE-S147…): a key reaches the agent's commands in the person's turns (`agent-commands/keys.ts`), a website
 * login signs in in the browser (until Hermes's browser takes it, HE-42), and the agent adds servers to the person's
 * SSH keys (`add-server.ts`).
 *
 * The rule is one (one-person.md OP-S60, HE-21): only in the person's turn, with the entry switched on for the agent
 * (docs/decisions/vault-simplify.md VLT-10). Nobody is asked about a Vault entry. A use is decided by the `vault.use`
 * command signed as the agent (`blocked` signs a neutral `vault.refused`), and its outcome recorded by
 * `vault.record_use`: one signed neutral `vault.used` line and the `vault_uses` row that says which entry.
 */
import {
  conversationLabel,
  DispatchId,
  type VaultAuth,
  VaultEntryId,
  type VaultToolRefusal,
  VaultUseOutcome,
  vaultAuditText,
  vaultKeyCoversServer,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { dispatches, vaultEntries } from '../db/schema/index';
import { personOfAccountIn } from '../domain/turn-person';
import { forbidden } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import type { DispatchRow } from '../runtime/context';
import { outsidersTurn } from '../runtime/person';
import type { Services } from '../services';
import { publishVaultUpdated, signVaultUse } from './commands';
import type { VaultFailure } from './net';
import type { SecretForms } from './scrub';
import { type AgentKey, agentKeyFor, entryById, type VaultEntryRow, vaultSecretAad } from './store';

/** What an agent hears when it can't use an entry now (neutral: no entry name, VT-23, VT-31). */
const VAULT_USE_MESSAGES = {
  no_key: 'You don’t hold a key to that Vault entry.',
  search: 'The Vault isn’t available while answering a search.',
  wrong_kind: 'That Vault entry can’t be used that way.',
} as const;

/** What a sign-in with an entry that isn't a website login hears. */
const NOT_A_LOGIN = 'That Vault entry isn’t a website login.';

/** Where a use happened, as the log says it (a DM is “A DM”). */
export async function whereOf(tx: Tx | Services['db'], conversationId: string): Promise<string | null> {
  const c = await loadConversationRow(tx, conversationId);
  if (!c) return null;
  return c.kind === 'dm' ? 'A DM' : conversationLabel(c);
}

/** The person when the turn is theirs (the requester in the Vault's record), else null (an outsiders' turn). */
export async function personOfAccount(db: Db | Tx, burrowId: string, accountId: string | null) {
  return personOfAccountIn(db, burrowId, accountId);
}

/**
 * Whether the agent may use the entry in this dispatch now (HE-43): the person's turn (never an outsiders', OP-17) and
 * the entry switched on for it (`agentKeyOf`), covering `serverId` when one is named (VT-S07). Never in a search answer.
 */
export function keyTurns(
  key: Pick<AgentKey, 'servers'> | null | undefined,
  dispatch: Pick<DispatchRow, 'onBehalfOfAccountId' | 'search' | 'mode'>,
  serverId?: string,
): boolean {
  if (!key) return false;
  if (dispatch.search !== null || dispatch.mode === 'answer') return false;
  if (outsidersTurn(dispatch)) return false;
  return serverId === undefined || vaultKeyCoversServer(key, serverId);
}

/* Deciding (VT-22) ---------------------------------------------------------------------------------- */

export type VaultUseAnswer =
  | { kind: 'run'; entryId: string; requesterId: string | null }
  | { kind: 'blocked'; eventId: string; message: string }
  /** The call can't be made as asked (not a login, no secret yet); nothing was signed. */
  | { kind: 'invalid'; message: string };

async function refuse(
  ctx: ApplyContext,
  args: {
    entry: VaultEntryRow | null;
    dispatch: DispatchRow;
    requesterId: string | null;
    what: string;
    reason: keyof typeof VAULT_USE_MESSAGES;
    where: string | null;
  },
): Promise<VaultUseAnswer> {
  const message = VAULT_USE_MESSAGES[args.reason];
  const entry = args.entry;
  if (!entry) {
    const event = await ctx.emit({
      type: 'vault.refused',
      kind: 'Blocked',
      text: vaultAuditText('refused'),
      where: args.where,
      payload: { dispatchId: args.dispatch.id },
    });
    return { kind: 'blocked', eventId: event.id, message };
  }
  // Recent use shows who tried; the signed line doesn't say which entry it was.
  const eventId = await signVaultUse(ctx, entry, {
    dispatchId: args.dispatch.id,
    requesterId: args.requesterId,
    where: args.where,
    what: args.what,
    outcome: 'refused',
    status: null,
    server: null,
    ms: 0,
    bytes: null,
  });
  publishVaultUpdated(ctx, entry.ownerId, entry.id);
  return { kind: 'blocked', eventId, message };
}

/** Decides one sign-in with a website login by the acting agent in its dispatch (`keyTurns`). */
export const decideVaultUseCommand = defineCommand({
  name: 'vault.use',
  schema: z.object({
    dispatchId: DispatchId,
    entryId: VaultEntryId,
    /** `sign_in`: `browser_sign_in` with a `login` entry (docs/decisions/vault.md VT-D30, browser.md BT-06). */
    kind: z.enum(['sign_in']),
    /** What the record says was attempted. */
    what: z.string().max(2000),
  }),
  async apply(tx, ctx, input): Promise<VaultUseAnswer> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents use Vault entries.');
    const [dispatch] = await tx
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.id, input.dispatchId), eq(dispatches.agentId, ctx.actor.id)));
    if (!dispatch || dispatch.burrowId !== ctx.burrow.id) throw forbidden('This dispatch is gone.');
    const what = input.what.slice(0, 300);
    const [entry] = await tx
      .select()
      .from(vaultEntries)
      .where(and(eq(vaultEntries.id, input.entryId), eq(vaultEntries.burrowId, ctx.burrow.id)));
    const requester = await personOfAccount(tx, ctx.burrow.id, dispatch.onBehalfOfAccountId);
    const where = await whereOf(tx, dispatch.conversationId);
    const base = { dispatch, requesterId: requester?.id ?? null, what, where };
    // A turn that isn't the person's (an outsiders', OP-17) is as if the agent held no key.
    if (!entry || !requester) return refuse(ctx, { ...base, entry: null, reason: 'no_key' });
    if (dispatch.search !== null || dispatch.mode === 'answer')
      return refuse(ctx, { ...base, entry, reason: 'search' });
    if (!keyTurns(await agentKeyFor(tx, entry, ctx.actor.id), dispatch))
      return refuse(ctx, { ...base, entry, reason: 'no_key' });
    if (entry.kind !== 'login') return { kind: 'invalid', message: NOT_A_LOGIN };
    const auth = entry.auth as VaultAuth | null;
    if (auth?.type !== 'none' && entry.sealed === null)
      return { kind: 'invalid', message: 'That Vault entry has no secret yet.' };
    return { kind: 'run', entryId: entry.id, requesterId: requester?.id ?? null };
  },
});

/* Recording (VT-50…VT-52) ----------------------------------------------------------------------- */

/** One use's outcome: the signed neutral line and the row that says which entry. */
export const recordVaultUse = defineCommand({
  name: 'vault.record_use',
  schema: z.object({
    entryId: VaultEntryId,
    dispatchId: DispatchId.nullable(),
    what: z.string().max(2000),
    outcome: VaultUseOutcome,
    status: z.number().int().min(100).max(599).nullable(),
    ms: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative().nullable(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents use Vault entries.');
    const entry = await entryById(tx, input.entryId);
    // Removed meanwhile: its detail went with it; the use itself is still in the log as neutral text.
    if (!entry || entry.burrowId !== ctx.burrow.id) return { eventId: null };
    const [dispatch] = input.dispatchId
      ? await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId))
      : [];
    const requester = await personOfAccount(tx, ctx.burrow.id, dispatch?.onBehalfOfAccountId ?? null);
    const where = dispatch ? await whereOf(tx, dispatch.conversationId) : null;
    const eventId = await signVaultUse(ctx, entry, {
      dispatchId: input.dispatchId,
      requesterId: requester?.id ?? null,
      where,
      what: input.what,
      outcome: input.outcome,
      status: input.status,
      server: null,
      ms: input.ms,
      bytes: input.bytes,
    });
    if (input.outcome !== 'refused')
      await tx.update(vaultEntries).set({ lastUsedAt: ctx.now }).where(eq(vaultEntries.id, entry.id));
    publishVaultUpdated(ctx, entry.ownerId, entry.id);
    return { eventId };
  },
});

export async function recordUse(
  services: Services,
  ctx: { agentId: string; burrowId: string; onBehalfOf: { text?: string; principalId?: string } },
  input: z.input<typeof recordVaultUse.schema>,
): Promise<void> {
  await services.pipeline
    .commit(recordVaultUse, input, {
      burrowId: ctx.burrowId,
      actorId: ctx.agentId,
      onBehalfOf: ctx.onBehalfOf,
    })
    .catch((err: unknown) =>
      // No detail: the error is ours (a database failure), never the call's.
      services.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'could not record a Vault use'),
    );
}

export function failed(
  reason: VaultFailure,
  message: string,
): Extract<VaultToolRefusal, { status: 'failed' }> {
  return { status: 'failed', reason, message };
}

/** The unsealed secret and its forms for one use (null for an entry that signs in with nothing). */
export function unseal(
  services: Services,
  entry: VaultEntryRow,
): { secret: string | null; forms: SecretForms[] } {
  if (entry.sealed === null) return { secret: null, forms: [] };
  const secret = services.custody.open(vaultSecretAad(entry.id), entry.sealed);
  const auth = entry.auth as VaultAuth | null;
  const username = auth?.type === 'basic' || auth?.type === 'form' ? auth.username : undefined;
  return { secret, forms: [{ secret, username }] };
}
