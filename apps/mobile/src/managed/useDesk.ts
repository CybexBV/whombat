/**
 * Which desk the phone talks to (desk-display-android.md AP-3050): the Whombat's `desk.*` ops through its session, or
 * the demo world's screen (`fixtures/desk.ts`). The rest is `@whombat/client/desk` and `desk/react`, as on the web: `useDesk` keeps `desk.get` in
 * the query cache, which a resync of `me` (and `desk.changed`, once contracts 0.100.0 bring it) reads again.
 */
import { useQueryClient } from '@tanstack/react-query';
import { type DeskApi, deskApi } from '@whombat/client/desk';
import { DESK_QUERY_KEY, DESK_SCREENS_CHANGED } from '@whombat/client/desk/react';
import { useEffect, useMemo } from 'react';
import { useBurrowBase } from '../data/BurrowProvider';
import { demoDesk } from '../fixtures/desk';
import { useManaged } from './context';

/** The desk's ops here, or null. */
export function useDeskApi(): DeskApi | null {
  const managed = useManaged();
  const { mode, me } = useBurrowBase();
  const session = managed?.session ?? null;
  const demo = !session && mode === 'fixtures' ? demoDesk({ me }) : null;
  const api = useMemo(() => (session ? deskApi(session) : (demo?.api ?? null)), [session, demo]);
  // The demo screen's own changes (an unlock request, new letters, a screen added) as `desk.changed` would bring them.
  const qc = useQueryClient();
  useEffect(
    () =>
      demo?.onChange(() => {
        void qc.invalidateQueries({ queryKey: DESK_QUERY_KEY });
        for (const queryKey of DESK_SCREENS_CHANGED) void qc.invalidateQueries({ queryKey });
      }),
    [demo, qc],
  );
  return api;
}
