/**
 * Where a screen reader's focus goes back to: after a sheet closes, the row that opened it; after a row is settled,
 * the next one (the one before it at the end). Rows register their focusable element by id while they are on screen.
 */
import type { RefObject } from 'react';
import { AccessibilityInfo, findNodeHandle, type View } from 'react-native';

const rows = new Map<string, RefObject<View | null>>();

export function registerRowFocus(id: string, ref: RefObject<View | null>): () => void {
  rows.set(id, ref);
  return () => {
    if (rows.get(id) === ref) rows.delete(id);
  };
}

/** The row to focus once `gone` leaves a list of `ids`: the next one, else the one before it. */
export function rowAfter(ids: readonly string[], gone: string): string | null {
  const at = ids.indexOf(gone);
  if (at < 0) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** How long a sheet takes to go down before focus can land under it. */
const SHEET_DOWN_MS = 450;

/** Puts the screen reader's focus on a row, once a sheet over it has gone down; nothing without a screen reader. */
export function focusRowSoon(id: string | null, delay = SHEET_DOWN_MS): void {
  if (!id) return;
  void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
    if (!on) return;
    setTimeout(() => {
      const node = findNodeHandle(rows.get(id)?.current ?? null);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, delay);
  });
}
