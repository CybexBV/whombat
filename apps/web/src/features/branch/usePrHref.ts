import { useBootstrapSelect, useRepos } from '@whombat/client/react';
import type { Bootstrap } from '@whombat/core';
import { useCallback } from 'react';
import { numbersRepeat, prHrefFor } from './prLinks';

const NO_ROOMS: Bootstrap['sidebar']['branchRooms'] = [];
const branchRoomsOf = (bootstrap: Bootstrap) => bootstrap.sidebar.branchRooms;

/**
 * Links to a branch room from something that knows the PR's number and its repo's id (a run, an automation step;
 * essentials item 5, AP-497): the room's own link (with `?repo=`) when the number is the sidebar's only one; when two
 * repos share it, the repo's name from `repos.list` (read only then); else the bare number, where the room asks.
 */
export function usePrHref(burrow: string): (number: number, repoId?: string | null) => string {
  const rooms = useBootstrapSelect(burrow, branchRoomsOf) ?? NO_ROOMS;
  const repeat = numbersRepeat(rooms);
  const { data: repos } = useRepos(repeat ? { params: { burrow } } : null, { retry: false });
  return useCallback(
    (number, repoId) => {
      const full = repoId ? repos?.repos.find((r) => r.id === repoId)?.fullName : undefined;
      return prHrefFor(rooms, number, full);
    },
    [rooms, repos],
  );
}
