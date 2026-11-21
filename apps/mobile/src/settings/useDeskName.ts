/**
 * The Whombat's name on the screen's top bar (Whombat desk-display.md DK-119; desk-display-android.md AP-5870): the box
 * doesn't know it, the organization's directory does, so the phone gives it whenever Settings → Screen or This Whombat
 * opens and the box keeps another. The directory's name for the Whombat open here (a rename shows there at once), else
 * this phone's record of it; a community box has no directory, so its record. Not in the demo world: there is no
 * Whombat to name.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeskApi, DeskScreen } from '@whombat/client/desk';
import { DESK_QUERY_KEY } from '@whombat/client/desk/react';
import { useEffect, useRef } from 'react';
import { useManaged } from '../managed/context';
import { deskNameToGive } from './deskScreen';

export function useDeskNameSync(api: DeskApi | null, screen: DeskScreen | undefined): void {
  const managed = useManaged();
  const fromDirectory = !!managed && !managed.community;
  const directory = useQuery({
    queryKey: ['desk', 'whombat-name', managed?.cacheScope ?? null],
    queryFn: async () => {
      if (!managed) return null;
      const list = await managed.whombats.list();
      return list.find((a) => a.device === managed.applianceId)?.name ?? null;
    },
    enabled: fromDirectory,
    retry: false,
    staleTime: 5 * 60_000,
  });
  // Wait for the directory where there is one, so a stale record isn't sent first.
  const known = !managed
    ? null
    : fromDirectory
      ? directory.isFetched
        ? (directory.data ?? managed.applianceName)
        : null
      : managed.applianceName;
  const qc = useQueryClient();
  const given = useRef<string | null>(null);
  const kept = screen?.whombatName;
  useEffect(() => {
    const name = deskNameToGive(known, kept === undefined ? undefined : { whombatName: kept });
    if (!api || !name || given.current === name) return;
    given.current = name;
    api.setName(name).then(
      (s) => qc.setQueryData(DESK_QUERY_KEY, s),
      // Not this time (an older runtime, a lost session): the next opening tries again.
      () => {
        given.current = null;
      },
    );
  }, [api, known, kept, qc]);
}
