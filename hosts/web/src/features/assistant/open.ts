// Opening the assistant from anywhere: the investigation panel lives in the
// URL (`?investigation=<id>` on any page, rendered by the shell), and the
// "Ask the assistant" dialog is one per app (host header, command palette).

import { useCallback, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router';

export const INVESTIGATION_PARAM = 'investigation';

/** The current page's search with the investigation set (null: removed). */
export function withInvestigation(search: string, id: string | null): string {
  const p = new URLSearchParams(search);
  if (id) p.set(INVESTIGATION_PARAM, id);
  else p.delete(INVESTIGATION_PARAM);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** A link ("/servers/basalt?tab=storage#x") that keeps the investigation open on the page it leads to. */
export function keepOpen(href: string, id: string): string {
  const hash = href.indexOf('#');
  const frag = hash >= 0 ? href.slice(hash) : '';
  const rest = hash >= 0 ? href.slice(0, hash) : href;
  const q = rest.indexOf('?');
  return (q >= 0 ? rest.slice(0, q) : rest) + withInvestigation(q >= 0 ? rest.slice(q) : '', id) + frag;
}

/** Opens (or with null closes) the investigation panel on the current page. */
export function useOpenInvestigation(): (id: string | null) => void {
  const [, setParams] = useSearchParams();
  return useCallback(
    (id: string | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set(INVESTIGATION_PARAM, id);
          else next.delete(INVESTIGATION_PARAM);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
}

// ---------------------------------------------------------------- the ask dialog

/** What the dialog asks about: a host, or the whole fleet (server null). */
export interface AskTarget {
  server: string | null;
}

let target: AskTarget | null = null;
const subs = new Set<() => void>();

export function askAssistant(next: AskTarget | null): void {
  target = next;
  for (const s of subs) s();
}

export function useAskTarget(): AskTarget | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => target,
    () => target,
  );
}
