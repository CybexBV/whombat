/**
 * The Whombat's name on the screen's top bar: the box doesn't know it (control's directory does), so the app gives it
 * whenever it knows a different one (`deskNameToGive`). Asked when Settings → Screen or This Whombat opens, from the
 * directory's list (a Rename on the Whombats list shows there), else the name this app opened the Whombat with. Only
 * on a box's session: a fixture world and a self-hosted server have no directory.
 */
import { useQueryClient } from '@tanstack/react-query';
import { DESK_QUERY_KEY, useDesk } from '@whombat/client/desk/react';
import { useEffect, useRef } from 'react';
import { useAppServices } from '../../app/providers';
import { deskNameToGive } from './screenTab';
import { useDeskHere } from './useDeskHere';

export function useDeskNameSync(burrow: string) {
  const { managed } = useAppServices();
  const here = useDeskHere(burrow);
  const desk = useDesk(here.api);
  const qc = useQueryClient();
  const screen = useRef(desk.data);
  screen.current = desk.data;
  // A runtime that knows names answers `whombatName` (null before the first one).
  const knowsNames = desk.data !== undefined && desk.data.whombatName !== undefined;
  const api = here.api;
  useEffect(() => {
    if (!managed || !api || !knowsNames) return;
    let live = true;
    void (async () => {
      const listed = managed.whombats
        ? await managed.whombats.list().then(
            (list) => list.find((a) => a.device === managed.applianceId)?.name ?? null,
            () => null,
          )
        : null;
      const now = screen.current;
      const name = now ? deskNameToGive(listed ?? managed.applianceName, now) : null;
      if (!live || !name) return;
      const answer = await api.setName(name).catch(() => null);
      if (answer) qc.setQueryData(DESK_QUERY_KEY, answer);
    })();
    return () => {
      live = false;
    };
  }, [managed, api, knowsNames, qc]);
}
