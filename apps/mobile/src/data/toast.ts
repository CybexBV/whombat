/**
 * The phone's toast with a button (Whombat quiet-notices.md QN-10…QN-14, QN-21; quiet-notices-mobile.md AP-4864): a
 * short line at the bottom, on `btn`, with **Undo** after the words — what Android's own toast (`showNotice`) can't
 * carry. One at a time: a newer one takes the place of the one showing. It goes by itself after 2.6 s (README “Toasts
 * auto-dismiss 2.6s”), 8 s with a button (the web's Undo after Settle), at least as long as Android's accessibility
 * timeout asks for a control, and twice that while a screen reader is on (it has to walk there); with VoiceOver on, one
 * with a button stays until it is dismissed. Pressing the button runs it and the toast goes at once. Pure: the host is
 * `ui/Toast.tsx`, which draws `get()` and calls `press`.
 */
import { durations } from '@whombat/tokens';

/** How long a toast with a button stays (the web's Undo after Settle). */
export const ACTION_TOAST_MS = 8000;
/** While a screen reader is on, toasts stay this many times longer. */
export const SLOW_TOAST_FACTOR = 2;

export interface ToastAction {
  /** “Undo”. */
  label: string;
  onPress: () => void;
}

export interface ToastView {
  id: number;
  text: string;
  action: ToastAction | null;
  /** “Ignored. You’ll hear if it changes. Undo” is read as the words; the button is its own element. */
  spoken: string;
}

export interface ToastStore {
  /** Shows a toast in place of the one showing; returns its id. `ms`: how long it stays, before a screen reader's longer. */
  show(text: string, options?: { action?: ToastAction | null; ms?: number }): number;
  /** Takes the toast away (only that one, when an id is given). */
  dismiss(id?: number): void;
  /** The button was pressed: the toast goes, then its action runs. */
  press(id: number): void;
  /** Whether a screen reader is on (toasts stay longer from the next one). */
  setSlow(slow: boolean): void;
  /** At least this long for a toast with a button (Android's recommended timeout for controls); 0 for none. */
  setActionFloor(ms: number): void;
  /** Whether a toast with a button stays until dismissed (VoiceOver on: it may take a while to get there). */
  setStay(stay: boolean): void;
  stays(): boolean;
  get(): ToastView | null;
  subscribe(listener: () => void): () => void;
}

export function createToastStore(): ToastStore {
  let current: ToastView | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let slow = false;
  let floor = 0;
  let stay = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const dismiss = (id?: number) => {
    if (!current || (id !== undefined && current.id !== id)) return;
    clear();
    current = null;
    emit();
  };
  return {
    show(text, options) {
      clear();
      seq += 1;
      const id = seq;
      const action = options?.action ?? null;
      current = { id, text, action, spoken: text };
      const base = options?.ms ?? (action ? Math.max(ACTION_TOAST_MS, floor) : durations.toast);
      if (!(action && stay)) timer = setTimeout(() => dismiss(id), base * (slow ? SLOW_TOAST_FACTOR : 1));
      emit();
      return id;
    },
    dismiss,
    press(id) {
      if (!current || current.id !== id) return;
      const action = current.action;
      dismiss(id);
      action?.onPress();
    },
    setSlow(next) {
      slow = next;
    },
    setActionFloor(ms) {
      floor = ms;
    },
    setStay(next) {
      stay = next;
    },
    stays: () => stay,
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The app's one toast (drawn by `ToastHost` at the root of the navigation). */
export const toasts = createToastStore();

/**
 * A toast that can carry Undo (QN-10): with `undo`, “Undo” after the words; without, the plain toast. Failures (a
 * refusal in the server's words) come here too, without a button.
 */
export function showToast(text: string, options: { undo?: (() => void) | null; ms?: number } = {}): void {
  if (!text.trim()) return;
  toasts.show(text, {
    action: options.undo ? { label: TOAST_COPY.undo, onPress: options.undo } : null,
    ...(options.ms ? { ms: options.ms } : {}),
  });
}

export const TOAST_COPY = {
  undo: 'Undo',
  /** The toast's close button, while it stays until dismissed. */
  dismiss: 'Dismiss',
  /** The button's hint: what Undo takes back. */
  undoHint: (text: string) => `Takes back: ${text}`,
} as const;
