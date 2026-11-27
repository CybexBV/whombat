/**
 * A Find My timeline in React (docs/implementation/macos/findmy-timeline.md §1), the same on the web and the phone: a
 * day or the last seven, read again every minute while today is shown; whose days are kept and deleting them; whether
 * the assistant can read it (the `findmy_timeline` tool's tier on the connection's tools); and one person's day on a map
 * the Mac draws at the card's size. The timeline and the map can be larger than one session message, so the session
 * reads them through an export stream by itself.
 */
import { keepPreviousData, type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@whombat/core/contracts';
import {
  FIND_MY_TIMELINE_TOOL,
  type FindMyTimeline,
  type FindMyTimelineChanged,
  type FindMyTimelineMap,
} from '@whombat/core/domain';
import { useCallback, useEffect, useRef } from 'react';
import type { CommitResult } from '../http/types';
import { useI18n } from '../i18n/react';
import { queryKeys } from '../query/keys';
import { useWhombat } from '../react/context';
import { useConnectionWrite } from '../react/mutations';
import { queryHook } from '../react/queries';
import { commitOutcomeText, hostErrorInfo } from './errors';

/** `connections.findMyTimeline`, an export read. `useFindMyTimeline` asks it for the tab. */
export const useFindMyTimelineRead = queryHook(api.connections.findMyTimeline);
/** `connections.findMyTimelineMap`, an export read. `useFindMyTimelineMap` keeps the last one on screen. */
export const useFindMyTimelineMapRead = queryHook(api.connections.findMyTimelineMap);

/** How often today's timeline is read again while it's shown: the box reads every few minutes. */
export const FIND_MY_TIMELINE_LIVE_MS = 60_000;

/**
 * The timeline of `days` days ending on `date` in the zone `tz`; read again every minute while `live` (today is in it).
 * A new day keeps the last one on screen while it is read (`isPlaceholderData`).
 */
export function useFindMyTimeline({
  burrow,
  connectionId,
  date,
  days,
  tz,
  live,
}: {
  burrow: string;
  connectionId: string;
  date: string;
  days: number;
  tz: string;
  live: boolean;
}) {
  return useFindMyTimelineRead(
    { params: { burrow, connectionId }, query: { date, tz, days } },
    {
      retry: false,
      placeholderData: keepPreviousData,
      staleTime: 30_000,
      refetchInterval: live ? FIND_MY_TIMELINE_LIVE_MS : false,
    },
  );
}

/** Every cached timeline and map of the connection asked again (a change, a new read). */
function refreshTimeline(qc: QueryClient, connectionId: string) {
  void qc.invalidateQueries({ queryKey: queryKeys.scope(api.connections.findMyTimeline, { connectionId }) });
  void qc.invalidateQueries({
    queryKey: queryKeys.scope(api.connections.findMyTimelineMap, { connectionId }),
  });
}

/** Every cached timeline of the connection changed in place at once, before it is asked again. */
function patchTimelines(qc: QueryClient, connectionId: string, patch: (t: FindMyTimeline) => FindMyTimeline) {
  qc.setQueriesData<FindMyTimeline>(
    { queryKey: queryKeys.scope(api.connections.findMyTimeline, { connectionId }) },
    (t) => (t ? patch(t) : t),
  );
}

export type FindMyTimelineChange = { kind: 'set'; people: string[] } | { kind: 'delete' };

/**
 * Whose days to keep (`connections.findMyTimelineSet`; nobody stops it and deletes everything) and deleting every day
 * kept so far (`connections.findMyTimelineDelete`). The answer's people go into every cached timeline at once; the
 * days are read again. Resolves to why it didn't go through, or null.
 */
export function useFindMyTimelineChange(burrow: string, connectionId: string) {
  const { client } = useWhombat();
  const { rawLocale: locale } = useI18n();
  const qc = useQueryClient();
  const m = useMutation<CommitResult<FindMyTimelineChanged>, Error, FindMyTimelineChange>({
    mutationFn: (c) => {
      const params = { burrow, connectionId };
      return c.kind === 'set'
        ? client.request(api.connections.findMyTimelineSet, { params, body: { people: c.people } })
        : client.request(api.connections.findMyTimelineDelete, { params, body: {} });
    },
    onSuccess: (result) => {
      if (result.status !== 'ok') return;
      const people = result.data.people;
      patchTimelines(qc, connectionId, (t) => ({ ...t, people }));
      refreshTimeline(qc, connectionId);
    },
  });
  const mutate = useRef(m.mutateAsync);
  mutate.current = m.mutateAsync;
  const change = useCallback(
    async (c: FindMyTimelineChange): Promise<string | null> => {
      try {
        return commitOutcomeText(await mutate.current(c), locale);
      } catch (error) {
        return hostErrorInfo(error, locale).message;
      }
    },
    [locale],
  );
  return { change, pending: m.isPending, asked: m.isPending ? m.variables : undefined };
}

/**
 * Whether the assistant can read the timeline: the `findmy_timeline` tool's tier on the connection (Allowed = on, Off =
 * off), set through `connections.setTool` as the connection's Tools section does. Every cached timeline says so at
 * once. Resolves to why it didn't go through, or null; `asked` is the value on its way.
 */
export function useFindMyTimelineAssistant(burrow: string, connectionId: string) {
  const qc = useQueryClient();
  const { rawLocale: locale } = useI18n();
  const setTool = useConnectionWrite(api.connections.setTool, burrow);
  const mutate = useRef(setTool.mutateAsync);
  mutate.current = setTool.mutateAsync;
  const set = useCallback(
    async (on: boolean): Promise<string | null> => {
      try {
        const result = await mutate.current({
          params: { burrow, connectionId, tool: FIND_MY_TIMELINE_TOOL.name },
          body: { tier: on ? 'can' : 'off' },
        });
        if (result.status !== 'ok') return commitOutcomeText(result, locale);
        patchTimelines(qc, connectionId, (t) => ({ ...t, assistantReads: on }));
        void qc.invalidateQueries({
          queryKey: queryKeys.scope(api.connections.findMyTimeline, { connectionId }),
        });
        return null;
      } catch (error) {
        return hostErrorInfo(error, locale).message;
      }
    },
    [burrow, connectionId, qc, locale],
  );
  const asked = setTool.isPending ? setTool.variables?.body.tier === 'can' : undefined;
  return { set, pending: setTool.isPending, asked };
}

/** A new read of the Mac (`readAt` moved) draws today's map again: its stops may have changed. */
export function useFindMyTimelineFresh(connectionId: string, readAt: string | null | undefined) {
  const qc = useQueryClient();
  const last = useRef(readAt);
  useEffect(() => {
    if (readAt === last.current) return;
    const had = last.current;
    last.current = readAt;
    if (had === undefined) return;
    void qc.invalidateQueries({
      queryKey: queryKeys.scope(api.connections.findMyTimelineMap, { connectionId }),
    });
  }, [readAt, qc, connectionId]);
}

export interface FindMyTimelineMapState {
  /** The picture on screen with the size it was asked at (its points are in that size). */
  shown: { map: FindMyTimelineMap; ask: { w: number; h: number } } | null;
  /** A new picture is being drawn (the last one of the same day stays meanwhile). */
  drawing: boolean;
  /** The day has no spot to draw (`find_my_no_places`). */
  noSpots: boolean;
  error: Error | null;
}

/**
 * One person's day on a map the Mac draws at `ask` points in the app's theme. While a new one is drawn (a theme, a wider
 * card, a new read) the last picture of the same person and day stays on screen; another person or day starts blank.
 */
export function useFindMyTimelineMap({
  burrow,
  connectionId,
  person,
  date,
  tz,
  ask,
  dark,
  enabled,
}: {
  burrow: string;
  connectionId: string;
  person: string;
  date: string;
  tz: string;
  ask: { w: number; h: number } | null;
  dark: boolean;
  enabled: boolean;
}): FindMyTimelineMapState {
  const q = useFindMyTimelineMapRead(
    enabled && ask
      ? {
          params: { burrow, connectionId },
          query: {
            person,
            date,
            tz,
            w: ask.w,
            h: ask.h,
            dark: dark ? ('true' as const) : ('false' as const),
          },
        }
      : null,
    // The Mac keeps a drawn map for a minute.
    { retry: false, staleTime: 60_000 },
  );
  const key = `${person}|${date}`;
  const last = useRef<{ key: string; shown: FindMyTimelineMapState['shown'] }>({ key, shown: null });
  if (last.current.key !== key || !enabled) last.current = { key, shown: null };
  if (q.data && ask && q.data.person === person && q.data.date === date && last.current.shown?.map !== q.data)
    last.current = { key, shown: { map: q.data, ask } };
  const noSpots = !!q.error && hostErrorInfo(q.error).code === 'find_my_no_places';
  return {
    shown: last.current.shown,
    drawing: q.isFetching,
    noSpots,
    error: noSpots ? null : q.error,
  };
}
