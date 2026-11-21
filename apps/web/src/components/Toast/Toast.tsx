import { durations } from '@whombat/tokens';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './Toast.module.css';

/** Why a toast went away: its time ran out, its action was pressed, it was dismissed, or a newer one pushed it out. */
export type ToastEnd = 'timeout' | 'action' | 'dismissed' | 'replaced';

export interface ToastAction {
  /** “Undo”. */
  label: string;
  /** Pressed: the toast goes at once (its `onEnd` hears `action`). */
  onAction: () => void;
}

export interface ToastOptions {
  /**
   * Auto-dismiss delay in ms. Default 2600 (README "Toasts auto-dismiss 2.6s"), 6000 with an action (time to reach
   * it); `null` keeps it up. The time stops while the pointer is over the toasts or focus is in them.
   */
  duration?: number | null;
  /** A button after the words (docs/decisions/web-messages.md WX-09): “Undo”. */
  action?: ToastAction;
  /** Called once when the toast goes, however it goes. */
  onEnd?: (how: ToastEnd) => void;
}

export interface ToastApi {
  /**
   * Shows a toast and returns its id. Two show at once (WX-09): a third pushes out the oldest, so a quick “Pinned to
   * #billing-v2.” no longer hides the “Undo” of a delete a moment before.
   */
  show: (message: ReactNode, options?: ToastOptions) => number;
  /** Takes a toast away (all of them without an id). */
  dismiss: (id?: number) => void;
}

/** How many toasts show at once. */
export const TOAST_DEPTH = 2;
/** How long a toast with an action stays (WX-09). */
export const ACTION_TOAST_MS = 6000;

const ToastContext = createContext<ToastApi | null>(null);

interface ToastState {
  id: number;
  message: ReactNode;
  action?: ToastAction;
}

interface Timing {
  /** Time left when the clock last stopped, or the whole duration; null: stays up. */
  left: number | null;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  onEnd?: (how: ToastEnd) => void;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const timings = useRef(new Map<number, Timing>());
  const seq = useRef(0);
  const paused = useRef(false);
  /** What each toast showing says, when it is plain text. */
  const texts = useRef(new Map<number, string>());

  const end = useCallback((id: number, how: ToastEnd) => {
    const timing = timings.current.get(id);
    if (!timing) return;
    clearTimeout(timing.timer);
    timings.current.delete(id);
    texts.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
    timing.onEnd?.(how);
  }, []);

  const run = useCallback(
    (id: number) => {
      const timing = timings.current.get(id);
      if (!timing || timing.left === null || paused.current) return;
      timing.startedAt = Date.now();
      timing.timer = setTimeout(() => end(id, 'timeout'), timing.left);
    },
    [end],
  );

  const dismiss = useCallback(
    (id?: number) => {
      const ids = id === undefined ? [...timings.current.keys()] : [id];
      for (const one of ids) end(one, 'dismissed');
    },
    [end],
  );

  const show = useCallback(
    (message: ReactNode, options?: ToastOptions) => {
      seq.current += 1;
      const id = seq.current;
      const duration =
        options?.duration === undefined
          ? options?.action
            ? ACTION_TOAST_MS
            : durations.toast
          : options.duration;
      // The same words again replace the toast saying them (a second refusal, a second copy); then the oldest beyond
      // the depth goes (its `onEnd` hears `replaced`).
      if (typeof message === 'string')
        for (const [old, said] of texts.current) if (said === message) end(old, 'replaced');
      const open = [...timings.current.keys()];
      for (const old of open.slice(0, Math.max(0, open.length - (TOAST_DEPTH - 1)))) end(old, 'replaced');
      if (typeof message === 'string') texts.current.set(id, message);
      timings.current.set(id, {
        left: duration,
        startedAt: Date.now(),
        timer: undefined,
        onEnd: options?.onEnd,
      });
      setToasts((list) => [...list, { id, message, action: options?.action }].slice(-TOAST_DEPTH));
      run(id);
      return id;
    },
    [end, run],
  );

  // The clock stops while someone reads or reaches for a toast's button, and goes on after.
  const pause = useCallback(() => {
    if (paused.current) return;
    paused.current = true;
    const now = Date.now();
    for (const timing of timings.current.values()) {
      clearTimeout(timing.timer);
      if (timing.left !== null) timing.left = Math.max(0, timing.left - (now - timing.startedAt));
    }
  }, []);
  const resume = useCallback(() => {
    if (!paused.current) return;
    paused.current = false;
    for (const id of timings.current.keys()) run(id);
  }, [run]);

  useEffect(() => {
    const map = timings.current;
    return () => {
      for (const timing of map.values()) clearTimeout(timing.timer);
    };
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Hovering or focusing the toasts stops their clock (WCAG 2.2.1). */}
      <div
        role="status"
        aria-live="polite"
        className={styles.region}
        onPointerEnter={pause}
        onPointerLeave={resume}
        onFocus={pause}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume();
        }}
      >
        {toasts.map((toast) => (
          <div key={toast.id} className={styles.toast}>
            {toast.message}
            {toast.action && (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  const action = toast.action;
                  end(toast.id, 'action');
                  paused.current = false;
                  action?.onAction();
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
