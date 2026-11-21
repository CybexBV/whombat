/**
 * Unsent drafts (docs/decisions/web-messages.md WX-05): one per burrow, conversation and thread, kept in
 * `localStorage` so a reload, a crash or a closed tab doesn't lose them. Written on every change, removed on send and
 * when emptied; `clearDrafts` forgets them all (sign-out, an account or appliance switch, revocation: AP-17). A draft
 * left alone for 30 days is dropped. Where storage refuses (private mode, a sandboxed frame), drafts live for the tab.
 */
import { useCallback, useState } from 'react';

const PREFIX = 'whombat:draft:';
/** A draft nobody came back to in this long is gone. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const memory = new Map<string, string>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Where a draft is kept: `<burrow>:<conversation>`, and `:<thread root>` for a thread's reply box. */
export function draftKey(burrow: string, conversationId: string, threadRootId?: string | null): string {
  return `${burrow}:${conversationId}${threadRootId ? `:${threadRootId}` : ''}`;
}

/** The draft kept for `key`, or `''`. */
export function readDraft(key: string, now = Date.now()): string {
  const store = storage();
  if (store) {
    try {
      const raw = store.getItem(PREFIX + key);
      if (raw === null) return memory.get(key) ?? '';
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { text?: unknown }).text === 'string' &&
        typeof (parsed as { at?: unknown }).at === 'number' &&
        now - (parsed as { at: number }).at <= DRAFT_MAX_AGE_MS
      )
        return (parsed as { text: string }).text;
      store.removeItem(PREFIX + key);
      return '';
    } catch {
      return memory.get(key) ?? '';
    }
  }
  return memory.get(key) ?? '';
}

/** Keeps `text` as the draft for `key`; an empty one is removed. */
export function writeDraft(key: string, text: string, now = Date.now()): void {
  if (text) memory.set(key, text);
  else memory.delete(key);
  const store = storage();
  if (!store) return;
  try {
    if (text) store.setItem(PREFIX + key, JSON.stringify({ text, at: now }));
    else store.removeItem(PREFIX + key);
  } catch {
    // Full or refused: the tab's copy above still holds it.
  }
}

/** Forget every draft (sign-out, account or appliance switch, revocation: AP-17). */
export function clearDrafts(): void {
  memory.clear();
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  } catch {
    // Nothing more to do where storage refuses.
  }
}

/** A draft as state: read once for `key`, written through on every change. */
export function useDraft(key: string): [string, (value: string) => void] {
  const [state, setState] = useState(() => ({ key, text: readDraft(key) }));
  // Another place in the same component (keyed components make this rare): read its draft.
  const current = state.key === key ? state : { key, text: readDraft(key) };
  if (current !== state) setState(current);
  const set = useCallback(
    (value: string) => {
      writeDraft(key, value);
      setState({ key, text: value });
    },
    [key],
  );
  return [current.text, set];
}
