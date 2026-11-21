/**
 * A widget the assistant made for Home as a screen's widget (docs/decisions/desk-display.md DK-139): its latest values
 * as figures and its first series as a small line. Home refreshes the widget itself at its own pace; the screen reads
 * what Home has every minute (DK-148). One read from a connection's tool shows what that connection's kind shows, so
 * it is private on a locked screen (DK-138) when the kind's widgets are, or when what it reads is (a Home Assistant
 * person or lock; `kindHints`); a server's metric never is.
 */
import { DESK_VIEW_POINTS_MAX, type DeskViewFigure, type DeskWidgetView, type Widget } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { catalogConnections, widgets } from '../../db/schema/index';
import { listWidgets } from '../../home/widgets';
import { screenText } from '../glance';
import { downsample } from '../server-page';
import { kindHints } from './thing-kinds';
import type { Resolved } from './types';

/** A Home widget as screens read it: with whether it shows what a locked screen leaves out. */
export type ScreenHomeWidget = Widget & { private?: boolean };

/** The person's Home widgets for screens (*Add a widget* and resolving), each marked private where its kind is. */
export async function screenHomeWidgets(
  db: Db,
  person: { id: string; burrowId: string },
  now: Date,
): Promise<ScreenHomeWidget[]> {
  const [list, secret] = await Promise.all([listWidgets(db, person, now), privateHomeWidgets(db, person)]);
  return list.map((w) => (secret.has(w.id) ? { ...w, private: true } : w));
}

/** Those of the person's Home widgets whose source is a connection of a kind whose widgets are private. */
async function privateHomeWidgets(db: Db, person: { id: string; burrowId: string }): Promise<Set<string>> {
  const rows = await db
    .select({ id: widgets.id, source: widgets.source })
    .from(widgets)
    .where(and(eq(widgets.burrowId, person.burrowId), eq(widgets.ownerId, person.id)));
  const connections = [
    ...new Set(rows.flatMap((r) => (r.source.kind === 'connection_tool' ? [r.source.connectionId] : []))),
  ];
  if (connections.length === 0) return new Set();
  const kinds = await db
    .select({ id: catalogConnections.id, catalogId: catalogConnections.catalogId })
    .from(catalogConnections)
    .where(inArray(catalogConnections.id, connections));
  const kindOf = new Map(kinds.map((k) => [k.id, k.catalogId]));
  return new Set(
    rows.flatMap((r) =>
      r.source.kind === 'connection_tool' &&
      homeWidgetPrivate(kindOf.get(r.source.connectionId), r.source.args)
        ? [r.id]
        : [],
    ),
  );
}

/** Whether a widget reading a connection's tool is private: its kind's widgets all are, or what it reads is. */
export function homeWidgetPrivate(catalogId: string | undefined, args: Record<string, unknown>): boolean {
  if (catalogId === undefined) return false;
  const hints = kindHints(catalogId);
  return !!hints.private || !!hints.privateSource?.(args);
}

/** Home's widgets are read again for the screen every minute (DK-148). */
export const HOME_WIDGET_REFRESH_S = 60;

export const HOME_WIDGET_WORDS = {
  gone: 'This widget isn’t on Home any more.',
  noValue: 'Nothing measured yet.',
} as const;

/** A number as a figure: whole from 100 on, one decimal below. */
function figure(value: number): string {
  return String(Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10);
}

/** A Home widget's view: up to four figures, its first series over its points; a widget gone says so. */
export function homeWidgetView(id: string, widget: ScreenHomeWidget | undefined): Resolved {
  if (!widget) {
    const view: DeskWidgetView = {
      kind: 'text',
      id,
      title: 'Widget',
      tone: 'off',
      body: HOME_WIDGET_WORDS.gone,
      problem: { text: HOME_WIDGET_WORDS.gone },
    };
    return { view, private: false, refreshS: HOME_WIDGET_REFRESH_S };
  }
  const title = screenText(widget.title, 60) || 'Widget';
  const items: DeskViewFigure[] = widget.latest.slice(0, 4).flatMap((l) => {
    const series = widget.series.find((s) => s.key === l.key);
    const label = screenText(series?.label ?? l.key, 40);
    const unit = screenText(l.unit ?? series?.unit, 12);
    if (!label) return [];
    return [
      {
        value: l.value === null ? '—' : screenText(figure(l.value), 24) || '—',
        ...(unit ? { unit } : {}),
        label,
      },
    ];
  });
  const first = widget.series[0]?.key;
  const values = first ? widget.points.map((p) => p.values[first] ?? null) : [];
  const spark = downsample(values, DESK_VIEW_POINTS_MAX).points.filter(
    (p): p is number => p !== null && Number.isFinite(p),
  );
  const subtitle = screenText(widget.subtitle, 120);
  const problem = screenText(widget.problem, 120);
  const view: DeskWidgetView = {
    kind: 'figures',
    id,
    title,
    items: items.length > 0 ? items : [{ value: '—', label: HOME_WIDGET_WORDS.noValue }],
    ...(subtitle ? { line: subtitle } : {}),
    ...(spark.length > 1 ? { spark } : {}),
    ...(problem ? { problem: { text: problem }, tone: 'bad' as const } : {}),
    ...(widget.updatedAt ? { at: widget.updatedAt } : {}),
  };
  return { view, private: widget.private === true, refreshS: HOME_WIDGET_REFRESH_S };
}
