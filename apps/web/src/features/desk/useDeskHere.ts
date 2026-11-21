/**
 * The desk on this Whombat for the web's screens (desk-display-web.md AP-3001, AP-3003): its ops (null in fixture mode
 * without a screen, and until the bootstrap says who the person is) and the person's time zone. The screen is the
 * person's (contracts 3.0 CT-1510; one-person.md AP-5695): there is no viewer to tell apart.
 */
import type { DeskApi } from '@whombat/client/desk';
import { useDeskUnlockRequest } from '@whombat/client/desk/react';
import { useBootstrap } from '@whombat/client/react';
import { useMemo } from 'react';
import { useAppServices } from '../../app/providers';

export interface DeskHere {
  /** Null where there is no desk to ask. */
  api: DeskApi | null;
  timeZone: string;
}

export function useDeskHere(burrow: string): DeskHere {
  const { desk } = useAppServices();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const known = !!bootstrap?.me.id;
  const timeZone = bootstrap?.preferences.timeZone ?? bootstrap?.burrow.timeZone ?? 'UTC';
  return useMemo(() => ({ api: known ? desk : null, timeZone }), [desk, known, timeZone]);
}

/** The screen's unlock request, while there is one (DK-04). */
export function useDeskUnlockHere(burrow: string) {
  const here = useDeskHere(burrow);
  return { here, request: useDeskUnlockRequest(here.api) };
}
