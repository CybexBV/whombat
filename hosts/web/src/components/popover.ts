// Open state of a popover anchored to a trigger button (server menu, account
// menu, phone menu). It closes on a click outside, when focus leaves it and
// on navigation; Escape is handled by each popover.

import { type FocusEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';

export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<T>(null);
  const { pathname, search } = useLocation();

  useEffect(() => setOpen(false), [pathname, search]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /** Close and give focus back to the trigger. */
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  /** For the root's onBlur: focus moved somewhere outside the popover. */
  const onBlur = useCallback((e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && !root.current?.contains(next)) setOpen(false);
  }, []);

  return { open, setOpen, close, root, trigger, onBlur };
}

/** `value`, updated only after it stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
