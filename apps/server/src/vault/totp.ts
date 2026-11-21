/**
 * `vault.setTotp` (docs/decisions/vault-simplify.md VLT-46, CT-1663): a website login's authenticator key set, replaced
 * or removed from its page, as the person. A secret op: the key is sealed (`totp-code.ts`) and never returned.
 */
import { VAULT_TOTP_KIND_TEXT, VaultEntryId, VaultTotpInput } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { vaultEntries } from '../db/schema/index';
import { notFound } from '../lib/errors';
import {
  emitEntryEvent,
  forgetHeldSecretsAfter,
  publishVaultUpdated,
  requirePerson,
  vaultError,
} from './commands';
import { ownEntry, vaultTotpAad } from './store';
import { canonicalTotp } from './totp-code';

export const setVaultTotp = defineCommand({
  name: 'vault.setTotp',
  schema: z.object({ entryId: VaultEntryId, totp: VaultTotpInput.nullable() }),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await ownEntry(tx, ctx.burrow.id, ctx.actor.id, input.entryId);
    if (row.kind !== 'login') throw vaultError('wrong_kind', {}, VAULT_TOTP_KIND_TEXT);
    const sealed =
      input.totp === null ? null : ctx.services.custody.seal(vaultTotpAad(row.id), canonicalTotp(input.totp));
    const [updated] = await tx
      .update(vaultEntries)
      .set({ totpSealed: sealed, totpSetAt: sealed ? ctx.now : null, updatedAt: ctx.now })
      .where(eq(vaultEntries.id, row.id))
      .returning();
    if (!updated) throw notFound('Vault entry');
    const event = await emitEntryEvent(ctx, 'entry.changed', updated);
    forgetHeldSecretsAfter(ctx);
    publishVaultUpdated(ctx, updated.ownerId, row.id);
    return { entryId: row.id, eventId: event.id };
  },
});

export const VAULT_TOTP_COMMANDS = [setVaultTotp];
