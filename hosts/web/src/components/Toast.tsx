// Transient notifications (session limit, copy confirmations, action results
// outside the console). One stack for the app, rendered by <Toaster/> in the
// shell; errors use role="alert", the rest a polite status region.

import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { t } from '../lib/i18n';
import { Icon } from './Icon';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
  /** One button beside the text ("Show progress"); choosing it dismisses the toast. */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  onSelect: () => void;
}

let toasts: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => {
  for (const s of subs) s();
};

export function toast(text: string, tone: Toast['tone'] = 'info', ms = 6000, action?: ToastAction): number {
  const id = ++seq;
  toasts = [...toasts.filter((t) => t.text !== text), { id, text, tone, ...(action ? { action } : {}) }].slice(-4);
  emit();
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

function useToasts(): Toast[] {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => toasts,
    () => toasts,
  );
}

export function Toaster() {
  const list = useToasts();
  // The toaster is a manual popover so it sits in the browser's top layer:
  // above modal <dialog>s (which are there too). Re-showing it on every new
  // toast puts it back on top of a dialog opened in the meantime.
  const ref = useRef<HTMLDivElement>(null);
  const newest = list[list.length - 1]?.id ?? 0;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== 'function') return;
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      if (list.length) el.showPopover();
    } catch {
      // not connected yet, or popovers unsupported: the stack still shows in place
    }
  }, [newest, list.length]);
  const errors = list.filter((t) => t.tone === 'error');
  const others = list.filter((t) => t.tone !== 'error');
  const item = (x: Toast) => (
    <div key={x.id} className={`toast is-${x.tone}`}>
      {x.tone === 'error' ? (
        <span style={{ color: 'var(--critical-text)', display: 'inline-flex' }}>
          <Icon name="critical" size={18} />
        </span>
      ) : x.tone === 'success' ? (
        <span style={{ color: 'var(--good)', display: 'inline-flex' }}>
          <Icon name="check" size={18} />
        </span>
      ) : null}
      <span className="toast-text">{x.text}</span>
      {x.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            dismissToast(x.id);
            x.action?.onSelect();
          }}
        >
          {x.action.label}
        </button>
      )}
      <button type="button" className="toast-x" aria-label={t('Dismiss')} onClick={() => dismissToast(x.id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
  return (
    <div ref={ref} className="toaster" popover="manual">
      <div role="alert" aria-live="assertive" className="toast-stack">
        {errors.map(item)}
      </div>
      <div role="status" aria-live="polite" className="toast-stack">
        {others.map(item)}
      </div>
    </div>
  );
}
