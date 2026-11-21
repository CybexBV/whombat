import type { KeyId } from '@whombat/core/keys';
import { useEffect, useRef, useState } from 'react';

/**
 * Links to a KEYS row (review S7; AP-250): a pack's “Turn on “Run tools in a scratch workspace”…” scrolls to that
 * row, moves the focus to its switch and highlights it for a moment.
 */
export function useKeyLinks(prefix: string) {
  const [highlighted, setHighlighted] = useState<KeyId | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const rowId = (keyId: KeyId) => `${prefix}-key-${keyId.replace(/[^a-z0-9]/gi, '-')}`;
  const show = (keyId: KeyId) => {
    const row = document.getElementById(rowId(keyId));
    row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    row?.querySelector<HTMLElement>('[role="switch"]')?.focus({ preventScroll: true });
    setHighlighted(null);
    requestAnimationFrame(() => setHighlighted(keyId));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlighted(null), 1800);
  };
  return { rowId, show, highlighted };
}
