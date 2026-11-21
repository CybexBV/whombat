/**
 * The model on the person's network as the server keeps it (docs/decisions/hermes-engine.md HE-08, HE-32, HE-S90…):
 * `burrows.local_model` (base URL, model, name, last test) and `burrows.local_model_key_enc` (its API key, sealed with
 * key custody under `burrow_local_model:<burrow id>:key`, so a value copied onto another burrow doesn't open). What
 * clients read is `LocalModelView` (`hasApiKey`, never the key). Pure apart from the custody it is handed.
 */
import type { LocalModelChange, LocalModelView } from '@whombat/core';
import type { StoredLocalModel } from '../db/schema/index';
import type { KeyCustody } from '../keys/custody';

/** The additional authenticated data the key is sealed with: bound to its burrow. */
export function localModelKeyAad(burrowId: string): string {
  return `burrow_local_model:${burrowId}:key`;
}

export function sealLocalModelKey(custody: KeyCustody, burrowId: string, key: string): string {
  return custody.seal(localModelKeyAad(burrowId), key);
}

export function openLocalModelKey(custody: KeyCustody, burrowId: string, stored: string): string {
  return custody.open(localModelKeyAad(burrowId), stored);
}

/** The key as stored on a burrow row, opened; null without one, or when it doesn't open (another master key). */
export function localModelKeyOf(
  custody: KeyCustody,
  burrow: { id: string; localModelKeyEnc: string | null },
): string | null {
  if (!burrow.localModelKeyEnc) return null;
  try {
    return openLocalModelKey(custody, burrow.id, burrow.localModelKeyEnc);
  } catch {
    return null;
  }
}

/** `Burrow.localModel` of a burrow row (CT-1170): null without one. */
export function localModelView(burrow: {
  localModel: StoredLocalModel | null;
  localModelKeyEnc: string | null;
}): LocalModelView | null {
  const stored = burrow.localModel;
  if (!stored) return null;
  return {
    baseUrl: stored.baseUrl,
    model: stored.model,
    label: stored.label,
    hasApiKey: !!burrow.localModelKeyEnc,
    check: stored.check,
    updatedAt: stored.updatedAt,
  };
}

/** A base URL's origin (scheme, host, port), or null when it isn't a URL. */
export function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * The key a save or a draft test uses (`SetLocalModelBody.apiKey`, CT-1171): a new key; none for null; absent, the saved
 * one — only while the address stays on its origin (scheme, host and port), so a saved key never goes to another server.
 * `refused`: absent while a saved key would cross to another origin.
 */
export function keyFor(
  apiKey: string | null | undefined,
  saved: { baseUrl: string; key: string | null } | null,
  baseUrl: string,
): { key: string | null } | 'refused' {
  if (apiKey !== undefined) return { key: apiKey };
  if (!saved?.key) return { key: null };
  const from = originOf(saved.baseUrl);
  return from !== null && from === originOf(baseUrl) ? { key: saved.key } : 'refused';
}

/** What a save changes, for `burrow.local_model_changed` (`localModelKeysText`): null when nothing does. */
export function localModelChange(
  before: { baseUrl: string; model: string; label: string | null; key: string | null } | null,
  after: { baseUrl: string; model: string; label: string | null; key: string | null },
): LocalModelChange | null {
  if (!before) return 'set';
  const same =
    before.baseUrl === after.baseUrl &&
    before.model === after.model &&
    before.label === after.label &&
    before.key === after.key;
  return same ? null : 'changed';
}

/** The words the person reads when a saved key would go to another server (`validation_failed` on `apiKey`). */
export const KEY_ORIGIN_TEXT =
  'Type the API key again for the new address, or leave it empty if it needs none.';
