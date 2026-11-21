/**
 * Tests only: a thing's page from a kind's view as `things/page.ts` lays it out (figures, charts, Worth a look, the
 * kind's panels and tabs), and `createThingWidgets` over pages given in memory, so the widgets' tests run the runtime's
 * own path (grouping, mapping, pacing, the contract's check) without a database or a service.
 */
import type {
  DeskCatalogGroup,
  DeskWidgetRef,
  DeskWidgetSpec,
  DeskWidgetView,
  ThingPage,
  ThingPagePanel,
} from '@whombat/core';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import type { KindView } from '../../things/kinds/types';
import { layout, SUMMARY_TAB } from '../../things/panels';
import { createThingWidgets, type ThingEntry, type ThingWidgetsDeps } from './things';
import type { Resolved, WidgetCtx } from './types';

export const NOW = new Date('2026-10-21T19:50:00Z');
export const TZ = 'Europe/Amsterdam';

/** A page of `catalogId` from a kind's view, as the page lays it out. */
export function pageOf(
  view: Partial<KindView>,
  meta: { id?: string; catalogId: string; name: string } & Partial<ThingPage>,
): ThingPage {
  const { id, catalogId, name, ...rest } = meta;
  const summary: ThingPagePanel[] = [];
  if (view.kpis?.length)
    summary.push({ kind: 'kpis', id: 'figures', place: 'top', items: view.kpis.slice(0, 6) });
  summary.push(...(view.charts ?? []));
  summary.push({
    kind: 'notices',
    id: 'notices',
    place: 'side',
    title: 'Worth a look',
    items: (view.notices ?? []).map(({ id: nid, tone, icon, title, detail }) => ({
      id: nid,
      tone,
      icon,
      title,
      ...(detail ? { detail } : {}),
    })),
    empty: 'Nothing needs a look.',
  });
  summary.push(...(view.panels ?? []));
  summary.push({ kind: 'widgets', id: 'widgets', place: 'bottom', title: 'Show more here', suggestions: [] });
  return {
    id: id ?? `connection:con_${catalogId}`,
    kind: 'connection',
    connectionId: `con_${catalogId}`,
    catalogId,
    name,
    icon: catalogId,
    status: 'ok',
    badge: 'Running fine',
    facts: [],
    runsOn: null,
    settings: true,
    tabs: [
      {
        ...SUMMARY_TAB,
        panels: layout(
          summary,
          (view.tabs ?? []).map((t) => t.key),
        ),
      },
      ...(view.tabs ?? []),
    ],
    actions: [],
    readAt: NOW.toISOString(),
    range: '24h',
    ...(view.refreshS ? { refreshS: view.refreshS } : { refreshS: 60 }),
    ...rest,
  };
}

export const viewer = {
  accountId: 'acc_1',
  burrowId: 'bur_1',
  principal: { id: 'prn_1', kind: 'person', burrowId: 'bur_1' } as unknown as PrincipalRow,
};

export function ctxAt(now = NOW): WidgetCtx {
  return { services: {} as Services, viewer, now, timeZone: TZ, assistant: 'Dusty' };
}

/** A clock tests move by hand. */
export function handClock(start = NOW.getTime()) {
  let t = start;
  return {
    now: () => t,
    add(ms: number) {
      t += ms;
    },
  };
}

/** `createThingWidgets` over pages in memory (a page that is an `Error` throws it; `pending` never answers). */
export function widgetsOver(
  pages: Map<string, ThingPage | Error | 'pending'>,
  more: Partial<ThingWidgetsDeps> & { things?: ThingEntry[]; down?: Record<string, boolean> } = {},
) {
  const reads: string[] = [];
  const clock = handClock();
  const deps: ThingWidgetsDeps = {
    things: async () =>
      more.things ??
      [...pages.entries()].map(([ref, p]) => ({
        ref: ref as DeskWidgetRef,
        name: p instanceof Error || p === 'pending' ? ref : p.name,
        catalogId: p instanceof Error || p === 'pending' ? null : (p.catalogId ?? null),
      })),
    page: async (_ctx, thing, range) => {
      reads.push(`${thing}|${range}`);
      const p = pages.get(thing);
      if (p === 'pending') return new Promise<ThingPage>(() => undefined);
      if (!p || p instanceof Error) throw p ?? new Error('no page');
      return p;
    },
    serverDown: async () => (id) => more.down?.[id] ?? null,
    clock: clock.now,
    ...more,
  };
  return { widgets: createThingWidgets({} as Services, deps), reads, clock };
}

/** The views of `specs` on `page`. */
export async function viewsOn(
  page: ThingPage,
  specs: Omit<DeskWidgetSpec, 'ref'>[],
): Promise<Map<string, Resolved>> {
  const { widgets } = widgetsOver(new Map([[page.id, page]]));
  return widgets.resolve(
    ctxAt(),
    specs.map((s) => ({ ...s, ref: page.id as DeskWidgetRef })),
  );
}

/** One panel widget's view. */
export async function panelOn(page: ThingPage, panel: string, item?: string): Promise<Resolved> {
  const got = await viewsOn(page, [
    { id: 'w_panel', type: 'panel', opts: { panel, ...(item ? { item } : {}) } },
  ]);
  return got.get('w_panel') as Resolved;
}

/** The view of a kind, narrowed. */
export function as<K extends DeskWidgetView['kind']>(
  r: Resolved | undefined,
  kind: K,
): Extract<DeskWidgetView, { kind: K }> {
  if (r?.view.kind !== kind) throw new Error(`expected a ${kind} view, got ${JSON.stringify(r?.view)}`);
  return r.view as Extract<DeskWidgetView, { kind: K }>;
}

/** *Add a widget*'s group of one page. */
export async function groupOn(page: ThingPage): Promise<DeskCatalogGroup> {
  const { widgets } = widgetsOver(new Map([[page.id, page]]));
  const [group] = await widgets.groups(ctxAt());
  if (!group) throw new Error('no group');
  return group;
}

/** A picture ref of the right form (the real ones are signed, `things/images.ts`). */
export function pictureRef(name: string, snapshot = false): string {
  const body = Buffer.from(
    JSON.stringify({ c: 'con_x', s: 'c', p: `/${name}`, ...(snapshot ? { w: 0 } : {}), e: 1 }),
  );
  return `${body.toString('base64url')}.c2lnbmF0dXJlLXNpZ24`;
}
