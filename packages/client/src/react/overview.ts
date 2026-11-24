/**
 * Arranging the Overview (Whombat docs/decisions/overview-arranged.md): what its tiles and figures show now
 * (`overview.views`, read again every minute), what a tile can show (`overview.figures`, read when its gear opens) and
 * saving the layout (`overview.arrange`), put in `home.overview` at once so every part of the page agrees before the
 * answer. Works in React DOM and React Native.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeskCatalog,
  DeskWidgetSpec,
  DeskWidgetView,
  HomeOverview,
  OverviewLayout,
} from '@whombat/core';
import { DESK_SCREEN_VIEWS_MAX } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useMemo } from 'react';
import { patchEndpoint } from '../query/cache';
import { QUERY_ROOT, queryKeys } from '../query/keys';
import { useWhombat } from './context';

/** How often the tiles read again while the page shows. */
export const OVERVIEW_VIEWS_EVERY_MS = 60_000;

/**
 * The views of the tiles' and figures' widgets, by widget id. More than one answer holds (`DESK_SCREEN_VIEWS_MAX`) are
 * asked in parts. Null: none asked (an older Whombat, or nothing to read).
 */
export function useOverviewViews(burrow: string, specs: readonly DeskWidgetSpec[] | null) {
  const { client } = useWhombat();
  const ids = useMemo(() => (specs ? specs.map((s) => s.id).join(',') : ''), [specs]);
  return useQuery({
    queryKey: [QUERY_ROOT, 'overview.views', { burrow }, { ids }],
    enabled: !!specs?.length,
    placeholderData: keepPreviousData,
    refetchInterval: OVERVIEW_VIEWS_EVERY_MS,
    queryFn: async ({ signal }) => {
      const all = specs ?? [];
      const parts: DeskWidgetSpec[][] = [];
      for (let i = 0; i < all.length; i += DESK_SCREEN_VIEWS_MAX)
        parts.push(all.slice(i, i + DESK_SCREEN_VIEWS_MAX));
      const answers = await Promise.all(
        parts.map(async (widgets) => {
          const result = await client.request(api.overview.views, {
            params: { burrow },
            body: { widgets },
            signal,
          });
          if (result.status !== 'ok') throw new Error(`Unexpected ${result.status} from overview.views`);
          return result.data.views;
        }),
      );
      const byId = new Map<string, DeskWidgetView>();
      for (const v of answers.flat()) byId.set(v.id, v);
      return byId;
    },
  });
}

/** What tiles can show: every thing's figures and panels, or with `thing` that one's (its page read now). */
export function useOverviewFigures(burrow: string, thing: string | null | undefined, enabled = true) {
  const { client } = useWhombat();
  return useQuery<DeskCatalog>({
    queryKey: [QUERY_ROOT, 'overview.figures', { burrow }, { thing: thing ?? '' }],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const result = await client.request(api.overview.figures, {
        params: { burrow },
        query: thing ? { thing: thing as never } : {},
        signal,
      });
      if (result.status !== 'ok') throw new Error(`Unexpected ${result.status} from overview.figures`);
      return result.data;
    },
  });
}

/**
 * Save the whole layout. It shows at once (`home.overview`'s `arranged`); when saving fails the page goes back to what
 * it was and the error says so.
 */
export function useArrangeOverview(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (layout: OverviewLayout) =>
      client.request(api.overview.arrange, { params: { burrow }, body: { layout } }),
    onMutate: async (layout) => {
      const scope = queryKeys.scope('home.overview', { burrow });
      await qc.cancelQueries({ queryKey: scope });
      const before = qc.getQueriesData<HomeOverview>({ queryKey: scope });
      patchEndpoint<HomeOverview>(qc, 'home.overview', (d) => ({ ...d, arranged: layout }), { burrow });
      return { before };
    },
    onError: (_err, _layout, ctx) => {
      for (const [key, data] of ctx?.before ?? []) qc.setQueryData(key, data);
    },
    onSuccess: (result, _layout, ctx) => {
      if (result.status !== 'ok') {
        for (const [key, data] of ctx?.before ?? []) qc.setQueryData(key, data);
        return;
      }
      const arranged = result.data.arranged;
      patchEndpoint<HomeOverview>(qc, 'home.overview', (d) => ({ ...d, arranged }), { burrow });
    },
  });
}
