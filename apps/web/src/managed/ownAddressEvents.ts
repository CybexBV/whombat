/**
 * The box's address changed on this page (a rename in Settings): the parts that show it read it again (Settings →
 * ADDRESS, the banner at the old address, the passkeys section). One page, so a plain event is enough.
 */
import { useEffect, useState } from 'react';

const CHANGED = 'whombat:own-address-changed';

export function announceOwnAddress(): void {
  window.dispatchEvent(new Event(CHANGED));
}

/** A number that goes up each time the address changed here: a dependency that asks again. */
export function useOwnAddressChanges(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((x) => x + 1);
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, []);
  return n;
}
