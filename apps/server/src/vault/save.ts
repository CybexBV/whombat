/**
 * `vault_save` (docs/decisions/vault-self-serve.md VS-04…VS-08; contracts 0.112.0 CT-780): the agent saves a login, an
 * API token or a username and password for an API it was sent, into the person's Vault.
 *
 * Checked before anything is saved: the turn is the person's (`blocked` otherwise, VS-04); the secret is, exactly, in a
 * message the person wrote here in the last 7 days (VS-05; `made: true` skips that for a password the agent made itself,
 * which only ever makes a new entry); a new entry's address passes the Vault's destination rule as the person's own save
 * does (VT-11…VT-13, outside the transaction); an `entry` is one of the person's of the same kind and keeps its address
 * (VS-06).
 *
 * Then one commit signed by the assistant (`vault.save`): the entry owned by the person with `saved_by_id`, its key for
 * the assistant (VS-01) and `vault.entry.saved` — or the new secret with `vault.entry.secret_replaced` — and the
 * blanking of the messages that held it (VS-07). The secret is sealed by the handler before the commit (under the entry's
 * own AAD), so the command's input never carries it in the clear and the pipeline's scrubbing can't touch it.
 */
import {
  type MessageVaultSave,
  newId,
  VAULT_ENTRIES_MAX,
  VAULT_LIMIT_MESSAGES,
  type VaultAuth,
  VaultEntryDescription,
  VaultEntryId,
  VaultEntryName,
  type VaultSaveInput,
  type VaultSaveOutput,
  VaultUrl,
  VaultUsername,
  vaultEntryShapeProblems,
  vaultSecretProblem,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { dispatches, vaultEntries } from '../db/schema/index';
import { ApiError, forbidden } from '../lib/errors';
import { iso } from '../lib/time';
import type { ToolContext } from '../mcp/tools';
import {
  emitEntryEvent,
  forgetHeldSecretsAfter,
  giveOwnAssistantKey,
  insertEntry,
  publishVaultUpdated,
  replaceSecret,
} from './commands';
import { destinationProblem } from './net';
import { blankSecret, blocked, ownTurn, personWrote, SELF_SERVE_TEXT } from './self-serve';
import { entryCount, type VaultEntryRow, vaultSecretAad } from './store';
import { failed } from './uses';

type SaveInput = z.output<typeof VaultSaveInput>;

/** What each kind is stored as (CT-780): a login on its sign-in page, an API with a bearer token or basic auth. */
export function shapeOf(input: Pick<SaveInput, 'kind' | 'username'>): {
  kind: 'login' | 'http';
  auth: VaultAuth;
} {
  if (input.kind === 'login')
    return { kind: 'login', auth: { type: 'form', username: input.username ?? '' } };
  if (input.kind === 'basic')
    return { kind: 'http', auth: { type: 'basic', username: input.username ?? '' } };
  return { kind: 'http', auth: { type: 'bearer' } };
}

/** Whether a saved entry is of the kind `vault_save` was asked to give a new secret. */
export function sameKind(row: Pick<VaultEntryRow, 'kind' | 'auth'>, kind: SaveInput['kind']): boolean {
  const auth = row.auth as VaultAuth | null;
  if (kind === 'login') return row.kind === 'login';
  if (kind === 'basic') return row.kind === 'http' && auth?.type === 'basic';
  return row.kind === 'http' && auth?.type === 'bearer';
}

const KIND_WORDS: Record<SaveInput['kind'], string> = {
  login: 'website logins',
  token: 'API tokens',
  basic: 'API logins',
};

/** One of the person's own entries by its id or 8-letter key, or null. */
export async function personsEntry(
  db: Db | Tx,
  burrowId: string,
  ownerId: string,
  ref: string,
): Promise<VaultEntryRow | null> {
  const [row] = await db
    .select()
    .from(vaultEntries)
    .where(
      and(
        eq(vaultEntries.burrowId, burrowId),
        eq(vaultEntries.ownerId, ownerId),
        /^[a-z]{8}$/.test(ref) ? eq(vaultEntries.toolKey, ref) : eq(vaultEntries.id, ref),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The commit of a save (VS-04…VS-07), signed by the assistant; the secret comes sealed under the entry's AAD. */
export const saveToVault = defineCommand({
  name: 'vault.save',
  schema: z.object({
    dispatchId: z.string(),
    entryId: VaultEntryId,
    /** A new entry's fields (checked by the handler); absent: `entryId` is the person's entry that gets the secret. */
    create: z
      .object({
        kind: z.enum(['login', 'http']),
        name: VaultEntryName,
        description: VaultEntryDescription,
        url: VaultUrl,
        auth: z.union([
          z.object({ type: z.literal('form'), username: VaultUsername }),
          z.object({ type: z.literal('basic'), username: VaultUsername }),
          z.object({ type: z.literal('bearer') }),
        ]),
      })
      .optional(),
    saveKind: z.enum(['login', 'token', 'basic']),
    username: VaultUsername.optional(),
    sealed: z.string().min(1).max(20_000),
    made: z.boolean(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only a person’s own assistant saves to their Vault.');
    const [dispatch] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    if (!dispatch || dispatch.agentId !== ctx.actor.id) throw forbidden('This dispatch is gone.');
    // Again under the lock: the assistant, the person, the room (VS-04).
    const turn = await ownTurn(tx, { agentId: ctx.actor.id, burrowId: ctx.burrow.id, dispatch });
    if (!turn) throw forbidden(SELF_SERVE_TEXT.notOwn);
    const { person, agent } = turn;
    const secret = ctx.services.custody.open(vaultSecretAad(input.entryId), input.sealed);
    let row: VaultEntryRow;
    let created: boolean;
    if (input.create) {
      if (!person.accountId) throw forbidden(SELF_SERVE_TEXT.notOwn);
      row = await insertEntry(ctx, { ...input.create, secret } as never, {
        id: input.entryId,
        owner: { principalId: person.id, accountId: person.accountId },
        savedById: agent.id,
      });
      created = true;
    } else {
      const [existing] = await tx
        .select()
        .from(vaultEntries)
        .where(and(eq(vaultEntries.id, input.entryId), eq(vaultEntries.ownerId, person.id)));
      if (!existing || !sameKind(existing, input.saveKind)) throw forbidden(SELF_SERVE_TEXT.notOwn);
      await replaceSecret(ctx, existing, secret, input.username, agent.id);
      row = existing;
      created = false;
    }
    const save: MessageVaultSave = {
      entryId: row.id,
      name: row.name,
      kind: row.kind,
      how: 'saved',
      server: null,
      at: iso(ctx.now),
    };
    // VS-07: the secret leaves the room's messages, the person's and the assistant's own (a password it made itself
    // was never sent by the person: nothing to blank).
    const blankedIds = input.made
      ? []
      : await blankSecret(ctx, {
          conversationId: dispatch.conversationId,
          authorIds: [person.id, agent.id],
          secret,
          save,
        });
    if (created) {
      await emitEntryEvent(ctx, 'entry.saved', row, { messageIds: blankedIds });
      await giveOwnAssistantKey(ctx, row);
    }
    // From now on the value is scrubbed from what the assistant writes (VS-07).
    forgetHeldSecretsAfter(ctx, agent.id);
    publishVaultUpdated(ctx, person.id, row.id);
    return { entryId: row.id, name: row.name, created, blanked: blankedIds.length };
  },
});

/** `vault_save` (VS-04…VS-08). */
export async function vaultSaveTool(ctx: ToolContext, input: SaveInput): Promise<VaultSaveOutput> {
  const { services } = ctx;
  const turn = await ownTurn(services.db, ctx);
  if (!turn) return blocked(ctx, 'vault_save', SELF_SERVE_TEXT.notOwn);
  const { person } = turn;
  if (
    !input.made &&
    !(await personWrote(services.db, ctx.dispatch.conversationId, person.id, input.secret, services.clock()))
  )
    return failed('invalid_request', SELF_SERVE_TEXT.notWritten(turn.name));

  let entryId: string;
  let create: z.input<typeof saveToVault.schema>['create'];
  if (input.entry === undefined) {
    const { kind, auth } = shapeOf(input);
    const url = input.address ?? '';
    const shape = vaultEntryShapeProblems({ kind, url, auth, secret: input.secret }, 'create');
    const first = shape[0];
    if (first) return failed('invalid_request', first.message);
    if ((await entryCount(services.db, ctx.burrowId, person.id)) >= VAULT_ENTRIES_MAX)
      return failed('invalid_request', VAULT_LIMIT_MESSAGES.entries);
    // The address is checked as the person's own save is (VT-13), outside the burrow's lock.
    const problem = await destinationProblem(services, url, 'save');
    if (problem) return failed('not_allowed', problem.message);
    entryId = newId('vaultEntry');
    create = {
      kind,
      name: input.name ?? '',
      description: input.description ?? '',
      url,
      auth: auth as never,
    };
  } else {
    const row = await personsEntry(services.db, ctx.burrowId, person.id, input.entry);
    if (!row || !sameKind(row, input.kind))
      return failed('invalid_request', `That isn’t one of ${turn.name}’s ${KIND_WORDS[input.kind]}.`);
    const auth = row.auth as VaultAuth | null;
    const next: VaultAuth | null =
      input.username && (auth?.type === 'basic' || auth?.type === 'form')
        ? { ...auth, username: input.username }
        : auth;
    const problem = vaultSecretProblem(next, input.secret);
    if (problem) return failed('invalid_request', problem);
    entryId = row.id;
    create = undefined;
  }

  try {
    const res = await services.pipeline.commit(
      saveToVault,
      {
        dispatchId: ctx.dispatch.id,
        entryId,
        ...(create ? { create } : {}),
        saveKind: input.kind,
        ...(input.username !== undefined && input.entry !== undefined ? { username: input.username } : {}),
        sealed: services.custody.seal(vaultSecretAad(entryId), input.secret),
        made: input.made,
      },
      { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
    );
    if (res.status !== 'ok') return failed('invalid_request', 'That can’t be saved now.');
    const { result } = res;
    return {
      status: 'ok',
      entryId: result.entryId,
      name: result.name,
      created: result.created,
      blanked: result.blanked,
    };
  } catch (err) {
    // A field the Vault refuses (a secret with a line break in a header, a full Vault): its words, never the value.
    if (err instanceof ApiError) {
      const fields = err.extra.fields ? Object.values(err.extra.fields).flat() : [];
      return failed('invalid_request', fields[0] ?? err.message);
    }
    throw err;
  }
}
