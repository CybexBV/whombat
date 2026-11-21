import { useBootstrap } from '@whombat/client/react';
import { type Bootstrap, type Principal, shortNameOf } from '@whombat/core';
import { useMemo } from 'react';

export interface BurrowViewer {
  bootstrap: Bootstrap | undefined;
  /** The viewer's zone (preference), else the burrow's. */
  timeZone: string;
  /** Signed-in person in this burrow. */
  me: Bootstrap['me'] | null;
  principal: (id: string) => Principal | undefined;
  /** "Waffle", "Mara" — "Someone" for unknown ids. */
  shortName: (id: string) => string;
}

const FALLBACK_ZONE = 'Europe/Amsterdam';

/** Names, the viewer and the display time zone from the cached bootstrap (loaded by the shell). */
export function useBurrowViewer(burrow: string): BurrowViewer {
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  return useMemo(() => {
    const byId = new Map((bootstrap?.principals ?? []).map((p) => [p.id, p]));
    const principal = (id: string) => byId.get(id);
    return {
      bootstrap,
      timeZone: bootstrap?.preferences.timeZone ?? bootstrap?.burrow.timeZone ?? FALLBACK_ZONE,
      me: bootstrap?.me ?? null,
      principal,
      shortName: (id: string) => {
        const p = principal(id);
        return p ? shortNameOf(p) : 'Someone';
      },
    };
  }, [bootstrap]);
}
