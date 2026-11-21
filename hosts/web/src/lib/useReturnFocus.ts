// Focus return for dialogs that are mounted only while open (the shared
// Modal returns focus itself only when it stays mounted with open=false).
// The parent calls this with the dialog's open state. The opener is read
// during the render that opens the dialog (before any effect of the Modal
// moves focus into it); focus goes back in a layout effect once the dialog
// has left the DOM (so the opener is no longer inert).

import { useLayoutEffect, useRef } from 'react';

export function useReturnFocus(open: boolean): void {
  const opener = useRef<Element | null>(null);
  if (open && !opener.current && typeof document !== 'undefined') opener.current = document.activeElement;
  useLayoutEffect(() => {
    if (open) return;
    const el = opener.current;
    opener.current = null;
    if (el instanceof HTMLElement && el.isConnected && el !== document.body) el.focus({ preventScroll: true });
  }, [open]);
}
