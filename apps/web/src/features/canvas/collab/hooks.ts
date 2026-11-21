import { useEffect, useState } from 'react';
import type { CanvasCollabSession } from './types';
import { type Collaborator, collaborators } from './users';

/** Everyone on the canvas (awareness), re-rendering when someone arrives, leaves, moves or starts writing. */
export function useCollaborators(session: CanvasCollabSession | null): Collaborator[] {
  const [list, setList] = useState<Collaborator[]>(() => (session ? collaborators(session.awareness) : []));
  useEffect(() => {
    if (!session) {
      setList([]);
      return;
    }
    // Awareness can change while React renders the editor (it sets our caret): read it after that.
    let queued = false;
    let live = true;
    const read = () => {
      queued = false;
      if (live) setList(collaborators(session.awareness));
    };
    const update = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(read);
    };
    read();
    session.awareness.on('change', update);
    return () => {
      live = false;
      session.awareness.off('change', update);
    };
  }, [session]);
  return list;
}

/** `(min-width: …)` media query state (false where matchMedia is missing, e.g. jsdom). */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mql = typeof window !== 'undefined' ? window.matchMedia?.(query) : undefined;
    if (!mql) return;
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
