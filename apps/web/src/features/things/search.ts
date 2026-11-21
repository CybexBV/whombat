/**
 * A thing page's address (AP-1307): `/things/<thing>` with the open parts as search params, so every tab, the open
 * guest, the console, Add a server and the Ask pane are links. `/things/servers` is the servers list.
 *
 *   ?tab=summary|guests|storage|sensors|backups|system   the server's tab
 *   ?guest=<guest id>&gtab=<guest tab>                    a guest's page over the server's
 *   ?console=host|screen|<guest id>                       a console (the host's shell, a Mac's screen, a guest's
 *                                                         screen or shell)
 *   ?ask=1                                                the Ask pane open (closed by default)
 *   ?chat=<conversation id>|new                           which chat the Ask pane shows
 *   ?add=1                                                Add a server
 *   &address=&user=&control=&name=                        …filled in (the assistant's card, server-signin.md SI-10)
 *   ?repoint=1                                            Point them here (BF-16's Needs you item; backup-file.md
 *                                                         AP-4417)
 *   ?q=&state=                                            the guests list's search and filter
 *   ?range=1h|6h|24h|7d|30d|90d                           the Summary's range (default 24 h; dashboards.md DS-03)
 *   ?chart=<figure key>                                   the figure whose charts are open (connections-page.md
 *                                                         AP-2510, CN-05)
 */
import { useRouterState } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { useSearchUpdate } from '../../app/routing/navigation';

export interface ThingSearch {
  tab?: string;
  guest?: string;
  gtab?: string;
  console?: string;
  ask?: string;
  chat?: string;
  add?: string;
  address?: string;
  user?: string;
  control?: string;
  name?: string;
  repoint?: string;
  q?: string;
  state?: string;
  range?: string;
  chart?: string;
}

const KEYS = [
  'tab',
  'guest',
  'gtab',
  'console',
  'ask',
  'chat',
  'add',
  'address',
  'user',
  'control',
  'name',
  'repoint',
  'q',
  'state',
  'range',
  'chart',
] as const;

/** Keeps the known keys as strings (for a route's `validateSearch`, and for reading them here). */
export function validateThingSearch(raw: Record<string, unknown>): ThingSearch {
  const out: ThingSearch = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v) out[k] = v.slice(0, 200);
    else if (typeof v === 'number') out[k] = String(v);
  }
  return out;
}

/** The page's search and a way to change it (replace for in-page state, push for places). */
export function useThingSearch(): [ThingSearch, (patch: ThingSearch, opts?: { replace?: boolean }) => void] {
  const raw = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const search = useMemo(() => validateThingSearch(raw), [raw]);
  const update = useSearchUpdate();
  const set = useCallback(
    (patch: ThingSearch, opts: { replace?: boolean } = {}) => {
      void update((prev) => {
        const next: Record<string, unknown> = { ...prev };
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === '') delete next[k];
          else next[k] = v;
        }
        return next;
      }, opts);
    },
    [update],
  );
  return [search, set];
}
