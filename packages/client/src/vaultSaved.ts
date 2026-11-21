/**
 * The lines under a message whose secret the Vault took (Whombat vault-self-serve.md VS-07, VS-11; contracts CT-783;
 * app vault-self-serve.md AP-4007): one per `Message.vaultSaved` item, in core's words (“Saved to your Vault · Plex”,
 * “Used once to put “Servers” on web-1, not kept”), each opening its entry: the saved login, or the SSH key a server's
 * password put on that server (the password itself isn't kept). Web and phone.
 */
import type { Message } from '@whombat/core';
import { vaultSavedLine } from '@whombat/core/vault';

export interface VaultSavedRow {
  /** Stable within the message: the entry, how, and the server. */
  key: string;
  text: string;
  /** The entry the line opens. */
  entryId: string;
}

export function vaultSavedRows(message: Pick<Message, 'vaultSaved'>): VaultSavedRow[] {
  return (message.vaultSaved ?? []).map((save) => ({
    key: `${save.entryId}/${save.how}/${save.server ?? ''}`,
    text: vaultSavedLine(save),
    entryId: save.entryId,
  }));
}
