/**
 * Global keyboard (README "Keyboard", TODO 4.4):
 * - ⌘K (macOS) / Ctrl K (elsewhere) opens search; both combos work everywhere (DECISIONS B-03).
 * - Esc closes, in order: modal → thread focus mode (back to the split view, ui-improvements.md AP-305) → pane →
 *   search.
 * - Alt+↑ / Alt+↓ moves to the previous / next conversation in the sidebar.
 */
export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface KeyState {
  /** A route-driven modal is open (`?approval=`, `?browse=1`). */
  modalOpen: boolean;
  /** A dialog is on screen that closes itself on Esc (Radix): leave Esc to it. */
  dialogInDom: boolean;
  /** The thread pane or the agent profile pane is open. */
  paneOpen: boolean;
  /** The thread is open full width (`&focus=1`). */
  threadFocus?: boolean;
  /** On the search screen. */
  searchOpen: boolean;
}

export type KeyAction =
  | 'openSearch'
  | 'closeModal'
  | 'collapseThread'
  | 'closePane'
  | 'closeSearch'
  | 'previousConversation'
  | 'nextConversation';

export function resolveKeyAction(e: KeyInput, state: KeyState): KeyAction | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) return 'openSearch';
  if (key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (state.dialogInDom) return null;
    if (state.modalOpen) return 'closeModal';
    if (state.threadFocus) return 'collapseThread';
    if (state.paneOpen) return 'closePane';
    if (state.searchOpen) return 'closeSearch';
    return null;
  }
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    if (key === 'ArrowUp') return 'previousConversation';
    if (key === 'ArrowDown') return 'nextConversation';
  }
  return null;
}

/** The path Alt+↑/↓ goes to from `current`, wrapping around; the first/last one from elsewhere. */
export function stepConversation(paths: readonly string[], current: string, delta: 1 | -1): string | null {
  if (paths.length === 0) return null;
  const index = paths.indexOf(current);
  if (index === -1) return (delta === 1 ? paths[0] : paths[paths.length - 1]) ?? null;
  return paths[(index + delta + paths.length) % paths.length] ?? null;
}
