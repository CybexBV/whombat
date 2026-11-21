/**
 * Feeds the phone's home-screen status widget from the open Whombat's `home.overview` query (the same query that
 * drives Overview and the Inbox tab badge, so it makes no extra requests). Mounted inside `ApplianceRoot` only so
 * demo mode never overwrites the person's widget; sign-out, revocation and box removal clear it in `ApplianceRoot`,
 * `ManagedApp` and `CommunityApp`.
 */
import { useQuery } from '@tanstack/react-query';
import { useWhombat } from '@whombat/client/react';
import { api } from '@whombat/core';
import { useEffect, useMemo, useRef } from 'react';
import { WhombatLive } from '../../modules/whombat-live';
import { useBurrowBase } from '../data/BurrowProvider';
import { useManaged } from '../managed/context';
import { createStatusWidgetSync, statusWidgetPayload } from './statusWidget';

export function StatusWidgetBridge() {
  const { slug, timeZone, clock, currentBootstrap } = useBurrowBase();
  const managed = useManaged();
  const { queries } = useWhombat();
  const overview = useQuery({
    ...queries.endpoint(api.home.overview, { params: { burrow: slug } }),
    retry: false,
  }).data;

  const sync = useRef<ReturnType<typeof createStatusWidgetSync> | null>(null);
  sync.current ??= createStatusWidgetSync(WhombatLive);

  const applianceId = managed?.applianceId ?? null;
  const applianceName = managed?.applianceName ?? null;
  const burrowName = currentBootstrap().burrow.name;

  const payload = useMemo(() => {
    if (!overview || !applianceId) return null;
    return statusWidgetPayload({
      overview,
      applianceId,
      applianceName,
      burrowName,
      timeZone,
      now: clock(),
    });
  }, [overview, applianceId, applianceName, burrowName, timeZone, clock]);

  useEffect(() => {
    if (!payload) return;
    void sync.current?.push(payload);
  }, [payload]);

  useEffect(() => () => sync.current?.reset(), []);

  return null;
}
