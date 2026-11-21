/**
 * Web search as the server keeps it (Whombat web-search.md): `burrows.web_search` (provider, last check, when it was set)
 * and `burrows.web_search_key_enc` (the Brave Search key, sealed with key custody under `burrow_web_search:<burrow
 * id>:key`, so a value copied onto another burrow doesn't open). What clients read is `WebSearchView`, never the key.
 * Pure apart from the custody it is handed.
 */
import type { WebSearchDispatchContext, WebSearchView } from '@whombat/core';
import type { StoredWebSearch } from '../db/schema/index';
import type { KeyCustody } from '../keys/custody';

/** The additional authenticated data the key is sealed with: bound to its burrow. */
export function webSearchKeyAad(burrowId: string): string {
  return `burrow_web_search:${burrowId}:key`;
}

export function sealWebSearchKey(custody: KeyCustody, burrowId: string, key: string): string {
  return custody.seal(webSearchKeyAad(burrowId), key);
}

export function openWebSearchKey(custody: KeyCustody, burrowId: string, stored: string): string {
  return custody.open(webSearchKeyAad(burrowId), stored);
}

/** The key as stored on a burrow row, opened; null without one, or when it doesn't open (another master key). */
export function webSearchKeyOf(
  custody: KeyCustody,
  burrow: { id: string; webSearchKeyEnc: string | null },
): string | null {
  if (!burrow.webSearchKeyEnc) return null;
  try {
    return openWebSearchKey(custody, burrow.id, burrow.webSearchKeyEnc);
  } catch {
    return null;
  }
}

/** `Burrow.webSearch` of a burrow row: null while web search is off. */
export function webSearchView(burrow: { webSearch: StoredWebSearch | null }): WebSearchView | null {
  const stored = burrow.webSearch;
  if (!stored) return null;
  return { provider: stored.provider, check: stored.check, updatedAt: stored.updatedAt };
}

/**
 * `DispatchContext.webSearch` of a turn: the person's key for their own turns. Null for a turn that isn't theirs (an
 * assessment, an outsiders' turn), while web search is off, and when the key doesn't open.
 */
export function webSearchDispatch(
  custody: KeyCustody,
  burrow: { id: string; webSearch: StoredWebSearch | null; webSearchKeyEnc: string | null },
  personsTurn: boolean,
): WebSearchDispatchContext | null {
  if (!personsTurn || !burrow.webSearch) return null;
  const apiKey = webSearchKeyOf(custody, burrow);
  return apiKey ? { v: 1, provider: burrow.webSearch.provider, apiKey } : null;
}
