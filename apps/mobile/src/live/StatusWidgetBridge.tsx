/**
 * Feeds the phone's home-screen status widget from the open Whombat's `home.overview` query (the same query that
 * drives Servers, Connections and the Inbox tab badge, so it makes no extra requests). Mounted inside `ApplianceRoot` only so
 * demo mode never overwrites the person's widget; explicit switches, sign-out, revocation and box removal clear the
 * departing box's snapshot in `ApplianceRoot`, `ManagedApp`, `CommunityApp`, and here when `applianceId` changes.
 */
import { useQuery } from '@tanstack/react-query';
import { useWhombat } from '@whombat/client/react';
import { api } from '@whombat/core';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { WhombatLive } from '../../modules/whombat-live';
import { useBurrowBase } from '../data/BurrowProvider';
import { useI18n } from '../i18n';
import { useManaged } from '../managed/context';
import { createStatusWidgetSync, statusWidgetPayload, statusWidgetSourceFor } from './statusWidget';

export function StatusWidgetBridge() {
  const { rawLocale } = useI18n();
  const { slug, timeZone, clock, currentBootstrap } = useBurrowBase();
  const managed = useManaged();
  const { queries } = useWhombat();
  const overview = useQuery({
    ...queries.endpoint(api.home.overview, { params: { burrow: slug } }),
    retry: false,
  }).data;

  const sync = useRef<ReturnType<typeof createStatusWidgetSync> | null>(null);
  const getSync = useCallback(() => {
    sync.current ??= createStatusWidgetSync(WhombatLive);
    return sync.current;
  }, []);

  const applianceId = managed?.applianceId ?? null;
  const applianceName = managed?.applianceName ?? null;
  const source = statusWidgetSourceFor(managed?.orgId);
  const burrowName = currentBootstrap().burrow.name;

  const payload = useMemo(() => {
    if (!overview || !applianceId) return null;
    return statusWidgetPayload({
      overview,
      applianceId,
      applianceName,
      burrowName,
      source,
      timeZone,
      locale: rawLocale,
      now: clock(),
    });
  }, [overview, applianceId, applianceName, burrowName, source, timeZone, clock, rawLocale]);

  useEffect(() => {
    const s = getSync();
    return () => {
      s.dispose();
      if (sync.current === s) sync.current = null;
    };
  }, [getSync]);

  const activeApplianceId = useRef<string | null>(applianceId);
  useEffect(() => {
    const previous = activeApplianceId.current;
    activeApplianceId.current = applianceId;
    if (previous && previous !== applianceId) {
      void getSync().clear(previous);
    }
  }, [applianceId, getSync]);

  useEffect(() => {
    if (!payload) return;
    void getSync().push(payload);
  }, [payload, getSync]);

  return null;
}
