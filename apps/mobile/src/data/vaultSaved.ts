/**
 * The lines under a message whose secret Whombat blanked (Whombat vault-self-serve.md VS-07, VS-11; AP-4037…AP-4039):
 * one per `Message.vaultSaved` item in core's words (“Saved to your Vault · Plex”, “Used once to put “Servers” on web-1,
 * not kept”), each opening its entry. The blanked text itself (`VAULT_BLANKED`, ••••••) is plain text in the message. Pure.
 */
import { type MessageVaultSave, vaultSavedLine } from '@whombat/core';

export interface VaultSavedRow {
  key: string;
  entryId: string;
  /** The entry's name, the Vault entry screen's title while it loads. */
  name: string;
  text: string;
  /** What TalkBack says a tap does: “Opens Plex in your Vault”. */
  hint: string;
}

export function vaultSavedRows(saves: readonly MessageVaultSave[] | null | undefined): VaultSavedRow[] {
  return (saves ?? []).map((s, i) => ({
    key: `${s.entryId}:${s.how}:${i}`,
    entryId: s.entryId,
    name: s.name,
    text: vaultSavedLine(s),
    hint: `Opens ${s.name} in your Vault`,
  }));
}
