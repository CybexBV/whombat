/**
 * `vault.setTotp` (docs/decisions/vault-simplify.md VLT-46, CT-1663): a website login's authenticator key set, replaced
 * or removed from its page, as the person. A secret op: the key is sealed (`totp-code.ts`) and never returned.
 */
import { VAULT_TOTP_KIND_TEXT, VaultEntryId, VaultTotpInput } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import { vaultEntries } from '../db/schema/index';
import { notFound } from '../lib/errors';
import {
  emitEntryEvent,
  forgetHeldSecretsAfter,
  publishVaultUpdated,
  requirePerson,
  vaultError,
} from './commands';
import { ownEntry, type VaultEntryRow, vaultTotpAad } from './store';
import { canonicalTotp } from './totp-code';

/**
 * Sets, replaces or removes (null) a website login's authenticator key: sealed in core's one form, signed as a change,
 * and the held forms of values read again. The person's own page and the 1Password sync both come here.
 */
export async function replaceTotp(
  ctx: ApplyContext,
  row: VaultEntryRow,
  totp: string | null,
): Promise<string> {
  if (row.kind !== 'login') throw vaultError('wrong_kind', {}, VAULT_TOTP_KIND_TEXT);
  const sealed = totp === null ? null : ctx.services.custody.seal(vaultTotpAad(row.id), canonicalTotp(totp));
  const [updated] = await ctx.tx
    .update(vaultEntries)
    .set({ totpSealed: sealed, totpSetAt: sealed ? ctx.now : null, updatedAt: ctx.now })
    .where(eq(vaultEntries.id, row.id))
    .returning();
  if (!updated) throw notFound('Vault entry');
  const event = await emitEntryEvent(ctx, 'entry.changed', updated);
  forgetHeldSecretsAfter(ctx);
  publishVaultUpdated(ctx, updated.ownerId, row.id);
  return event.id;
}

export const setVaultTotp = defineCommand({
  name: 'vault.setTotp',
  schema: z.object({ entryId: VaultEntryId, totp: VaultTotpInput.nullable() }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await ownEntry(tx, ctx.burrow.id, ctx.actor.id, input.entryId);
    const eventId = await replaceTotp(ctx, row, input.totp);
    return { entryId: row.id, eventId };
  },
});

export const VAULT_TOTP_COMMANDS = [setVaultTotp];
