/**
 * Keeps one of iOS's own pickers showing what its caller says. SwiftUI moves the picker as soon as it is touched, while
 * a caller may ask first (“Are you sure?”), refuse, or take the pick only once it's saved. A pick is held until the
 * caller's value changes; when it hasn't by `HOLD_MS`, the picker is drawn again from `value` (the returned `key`
 * changes).
 */
import { useEffect, useRef, useState } from 'react';

/** Long enough for a save over the session to come back. */
export const HOLD_MS = 4000;

type Held = { current: ReturnType<typeof setTimeout> | null };

function release(held: Held) {
  if (held.current) clearTimeout(held.current);
  held.current = null;
}

export function useHeldPick<T>(
  value: T,
  onChange: (value: T) => void,
): { key: number; pick: (value: T) => void } {
  const [key, setKey] = useState(0);
  const held = useRef<ReturnType<typeof setTimeout> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `value` is what ends the hold
  useEffect(() => release(held), [value]);
  useEffect(() => () => release(held), []);
  const pick = (next: T) => {
    release(held);
    held.current = setTimeout(() => {
      held.current = null;
      setKey((k) => k + 1);
    }, HOLD_MS);
    onChange(next);
  };
  return { key, pick };
}
