/**
 * Pinned widgets (docs/decisions/one-whombat.md ONE-09; one-whombat-assistant.md ONE-DW22…ONE-DW24).
 *
 * Whombat pins a panel on a page of the person's from a chat (`pin_widget`): a declarative source — one read-only tool
 * of a connection with fixed arguments and up to three JSON pointers into its answer, or a server's metrics (read by the
 * hosts stream's registered reader) — and the server refreshes it on a timer without the model, keeping 24 hours of
 * points. The read is the person's own (`runConnectionRead`): only what they may see, only reads, no agent. A pin goes
 * on the page it names, else on the page of what it reads (its connection's or device's, its server's): the Overview
 * page that held the others is gone (servers-connections-places.md). Those pinned there before stay for the box's
 * screen.
 */
import {
  ConversationId,
  catalogEntry,
  jsonPointerGet,
  MCP_TOOLS,
  newId,
  thingId,
  WIDGET_HISTORY_S,
  WIDGET_REFRESH_DEFAULT_S,
  WIDGET_REFRESH_MAX_S,
  WIDGET_REFRESH_MIN_S,
  WIDGETS_MAX,
  type Widget,
  WidgetId,
  type WidgetSeries,
  type WidgetSource,
} from '@whombat/core';
import { and, asc, count, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { runConnectionRead } from '../connections/call';
import { connectionCallAccess } from '../connections/call-access';
import { outputDocument } from '../connections/output';
import type { ConnectionViewer } from '../connections/store';
import type { Db, Tx } from '../db/client';
import { catalogConnections, connectionTools, principals, widgetPoints, widgets } from '../db/schema/index';
import { turnPerson } from '../domain/turn-person';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { loadPrincipalRow, type PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { thingVisible } from '../things/page';
import { publishHomeChanged, publishWidgetUpdated } from './notify';

export type WidgetRow = typeof widgets.$inferSelect;

/** A widget source's reader: the values of one refresh by series key, or throws `WidgetReadError` (plain words). */
export type WidgetReader = (
  services: Services,
  widget: WidgetRow,
  person: PrincipalRow,
) => Promise<Record<string, number | null>>;

/** Why a refresh read nothing, in words the person reads under the widget. */
export class WidgetReadError extends Error {
  override name = 'WidgetReadError';
}

const readers = new Map<string, WidgetReader>();

/** Registers the reader of a source kind (`server_metric`: hosts/widget-reader.ts, by `setUpHosts`). `connection_tool` is read here. */
export function registerWidgetReader(kind: WidgetSource['kind'], reader: WidgetReader): void {
  readers.set(kind, reader);
}

/** Known server metrics in words (others are their names). */
const METRIC_WORDS: Record<string, { label: string; unit?: string }> = {
  cpu_pct: { label: 'CPU', unit: '%' },
  mem_pct: { label: 'Memory', unit: '%' },
  temp_max_c: { label: 'Hottest', unit: '°C' },
  net_mbps: { label: 'Network', unit: 'Mbit/s' },
  load: { label: 'Load' },
};

/** A metric name as a series key (`[a-z][a-z0-9_]{0,31}`). */
export function metricKey(name: string): string {
  const key = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[^a-z]+/, '');
  return (key || 'value').slice(0, 32);
}

/** The series a source draws, coloured in order. */
export function seriesOf(source: WidgetSource): WidgetSeries[] {
  if (source.kind === 'connection_tool')
    return source.values.map((v, i) => ({
      key: v.key,
      label: v.label,
      ...(v.unit ? { unit: v.unit } : {}),
      color: (i + 1) as 1 | 2 | 3,
    }));
  return source.series.map((name, i) => {
    const words = METRIC_WORDS[name];
    return {
      key: metricKey(name),
      label: (words?.label ?? name.replace(/[_.]/g, ' ')).slice(0, 40),
      ...(words?.unit ? { unit: words.unit } : {}),
      color: (i + 1) as 1 | 2 | 3,
    };
  });
}

/** A number from a JSON value: numbers, numeric strings (“21.5”), booleans as 1/0; anything else null. */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim()))
    return Number(value);
  if (typeof value === 'string') {
    const on = value.trim().toLowerCase();
    if (on === 'on' || on === 'true') return 1;
    if (on === 'off' || on === 'false') return 0;
  }
  return null;
}

/** The connection a widget reads, as the person sees it, and the read-only tool. */
async function connectionToolFor(
  db: Db | Tx,
  person: PrincipalRow,
  source: WidgetSource & { kind: 'connection_tool' },
) {
  const [row] = await db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, source.connectionId));
  if (!row || row.burrowId !== person.burrowId) return null;
  const entry = catalogEntry(row.catalogId);
  if (!entry) return null;
  const [tool] = await db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, source.tool)));
  if (!tool) return null;
  return { row, entry, tool };
}

/** Reads a `connection_tool` widget: one read of the tool, the numbers at its pointers. */
const readConnectionTool: WidgetReader = async (services, widget, person) => {
  const source = widget.source as WidgetSource;
  if (source.kind !== 'connection_tool') throw new WidgetReadError('This widget can’t be read here.');
  const found = await connectionToolFor(services.db, person, source);
  if (!found) throw new WidgetReadError('The connection or its tool is gone.');
  if (found.row.status !== 'active')
    throw new WidgetReadError(`${found.row.label} needs you to sign in again.`);
  let out: Awaited<ReturnType<typeof runConnectionRead>>;
  try {
    out = await runConnectionRead(
      services,
      found.row,
      found.entry,
      found.tool,
      source.args as Record<string, unknown>,
    );
  } catch {
    throw new WidgetReadError(`Couldn’t read ${found.row.label} just now.`);
  }
  if (!out) throw new WidgetReadError(`${found.row.label} was busy; trying again soon.`);
  if (out.isError) throw new WidgetReadError(`${found.row.label} answered with an error.`);
  const doc = outputDocument(out);
  const values: Record<string, number | null> = {};
  for (const v of source.values) values[v.key] = numberOf(jsonPointerGet(doc, v.path));
  if (Object.values(values).every((v) => v === null))
    throw new WidgetReadError('The answer had none of the numbers this widget plots.');
  return values;
};
readers.set('connection_tool', readConnectionTool);

/** A widget without its points: what the desk's glance and Settings → Screen show (its value now). */
export type WidgetNow = Omit<Widget, 'points'>;

/** The widget as clients draw it, from its row, the values of its newest point and its points. */
function widgetOf(
  row: WidgetRow,
  last: Record<string, number | null> | undefined,
  points: Widget['points'],
): Widget {
  return {
    id: row.id,
    title: row.title,
    ...(row.subtitle ? { subtitle: row.subtitle } : {}),
    kind: 'line',
    series: row.series,
    latest: row.series.map((s) => ({
      key: s.key,
      value: last?.[s.key] ?? null,
      ...(s.unit ? { unit: s.unit } : {}),
    })),
    points,
    refreshSec: row.refreshSec,
    updatedAt: row.refreshedAt ? row.refreshedAt.toISOString() : null,
    ...(row.fromConversationId ? { fromConversationId: row.fromConversationId } : {}),
    ...(row.lastError ? { problem: row.lastError.slice(0, 200) } : {}),
    ...(row.thingId ? { thingId: row.thingId } : {}),
  };
}

/** Points a widget draws at most: a day of the shortest refresh, twice over. */
const POINTS_MAX = 2880;

/**
 * Each widget's points of the last 24 hours, oldest first, at most `POINTS_MAX` of each (the oldest ones): one read for
 * a whole list instead of one per widget, each widget's points read through the points' key in order.
 */
async function pointsOf(db: Db | Tx, ids: readonly string[], now: Date) {
  const out = new Map<string, Widget['points']>(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const since = new Date(now.getTime() - WIDGET_HISTORY_S * 1000);
  const rows = await db.execute<{
    widget_id: string;
    t: string | Date;
    values: Record<string, number | null>;
  }>(sql`
    select w.id as widget_id, p.t, p.values
      from unnest(array[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[]) with ordinality as w(id, ord)
      cross join lateral (
        select ${widgetPoints.t} as t, ${widgetPoints.values} as values from ${widgetPoints}
         where ${widgetPoints.widgetId} = w.id and ${widgetPoints.t} >= ${since.toISOString()}::timestamptz
         order by ${widgetPoints.t} limit ${POINTS_MAX}
      ) p
     order by w.ord, p.t`);
  for (const p of rows) out.get(p.widget_id)?.push({ t: new Date(p.t).toISOString(), values: p.values });
  return out;
}

/** The widgets as clients draw them, each with its last 24 hours of points. */
async function toWidgets(db: Db | Tx, rows: readonly WidgetRow[], now: Date): Promise<Widget[]> {
  const points = await pointsOf(
    db,
    rows.map((r) => r.id),
    now,
  );
  return rows.map((row) => {
    const mine = points.get(row.id) ?? [];
    return widgetOf(row, mine[mine.length - 1]?.values, mine);
  });
}

/** Where a widget is kept: Home (null) or a thing's page (connection-pages.md CP-14). */
const placeOf = (thingId: string | null | undefined) =>
  thingId ? eq(widgets.thingId, thingId) : isNull(widgets.thingId);

/** The person's widgets in their order (`widgets.list`): Home's, or with `thing` those kept on that thing's page. */
export async function listWidgets(
  db: Db | Tx,
  person: Pick<PrincipalRow, 'id' | 'burrowId'>,
  now: Date,
  thing?: string | null,
) {
  const rows = await db
    .select()
    .from(widgets)
    .where(and(eq(widgets.burrowId, person.burrowId), eq(widgets.ownerId, person.id), placeOf(thing)))
    .orderBy(asc(widgets.position), asc(widgets.createdAt));
  return toWidgets(db, rows, now);
}

/**
 * The person's Home widgets in their order with only their value now, in one read: each widget's newest point of the
 * last 24 hours through the points' key, instead of every point. The desk's glance and Settings → Screen show no more.
 */
export async function homeWidgetsNow(
  db: Db | Tx,
  person: Pick<PrincipalRow, 'id' | 'burrowId'>,
  now: Date,
): Promise<WidgetNow[]> {
  const since = new Date(now.getTime() - WIDGET_HISTORY_S * 1000);
  const newest = db
    .select({ values: widgetPoints.values })
    .from(widgetPoints)
    .where(and(eq(widgetPoints.widgetId, widgets.id), gte(widgetPoints.t, since)))
    .orderBy(desc(widgetPoints.t))
    .limit(1)
    .as('newest_point');
  const rows = await db
    .select({ widget: widgets, values: newest.values })
    .from(widgets)
    .leftJoinLateral(newest, sql`true`)
    .where(and(eq(widgets.burrowId, person.burrowId), eq(widgets.ownerId, person.id), placeOf(null)))
    .orderBy(asc(widgets.position), asc(widgets.createdAt));
  return rows.map((r) => {
    const { points: _points, ...widget } = widgetOf(r.widget, r.values ?? undefined, []);
    return widget;
  });
}

/** Checks a source for the person and their Whombat: a read-only tool of a connection, or a server metric. */
async function checkSource(db: Tx, person: PrincipalRow, source: WidgetSource): Promise<void> {
  if (source.kind === 'server_metric') {
    if (!readers.has('server_metric')) throw conflict('Server metrics can’t be pinned on this Whombat yet.');
    return;
  }
  const keys = source.values.map((v) => v.key);
  if (new Set(keys).size !== keys.length) throw badRequest('Give each value its own key.');
  const found = await connectionToolFor(db, person, source);
  if (!found) throw notFound('Connection or tool');
  if (connectionCallAccess(found.entry, found.tool, source.args as Record<string, unknown>) !== 'read')
    throw forbidden(
      `${found.tool.name} changes things, so it can’t feed a widget. Use a tool that only reads.`,
    );
}

/** The person as a viewer of things (who may see a thing a widget is kept on). */
function viewerFor(person: PrincipalRow): ConnectionViewer {
  return {
    accountId: person.accountId ?? '',
    burrowId: person.burrowId,
    principal: person,
  };
}

/** Where the person's widget is kept (for answering with the list of the same place), or `not_found`. */
export async function widgetPlace(
  db: Db | Tx,
  person: Pick<PrincipalRow, 'id' | 'burrowId'>,
  widgetId: string,
) {
  const [row] = await db
    .select({ thingId: widgets.thingId, ownerId: widgets.ownerId, burrowId: widgets.burrowId })
    .from(widgets)
    .where(eq(widgets.id, widgetId));
  if (!row || row.burrowId !== person.burrowId || row.ownerId !== person.id) throw notFound('Widget');
  return row.thingId;
}

/** `pin_widget` for anyone but the agent (assistant-name.md AN-01: the assistant isn't “Whombat”). */
export const ONLY_ASSISTANTS_PIN_TEXT = 'Only the assistant pins widgets.';

/**
 * The page a pin without one goes on: the page of what it reads, a server's for its metrics, a connection's or else a
 * device's (one connection is one of the two) for its tool; null when the person can see neither.
 */
async function pageOfSource(services: Services, viewer: ConnectionViewer, source: WidgetSource) {
  const pages =
    source.kind === 'server_metric'
      ? [thingId('server', source.serverId)]
      : [thingId('connection', source.connectionId), thingId('device', source.connectionId)];
  for (const page of pages) if (await thingVisible(services, viewer, page)) return page;
  return null;
}

/** `pin_widget` (MCP, the agent): a widget on a page of the person's, read once right after. */
export const pinWidget = defineCommand({
  name: 'pin_widget',
  schema: MCP_TOOLS.pin_widget.input.extend({ conversationId: ConversationId.optional() }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden(ONLY_ASSISTANTS_PIN_TEXT);
    const agent = await loadPrincipalRow(tx, ctx.actor.id);
    if (agent?.kind !== 'agent') throw forbidden(ONLY_ASSISTANTS_PIN_TEXT);
    // On the person's Home; none in an outsiders' turn (one-person.md OP-S40, OP-17).
    const person = await turnPerson(tx, {
      burrowId: ctx.burrow.id,
      agentId: agent.id,
    });
    if (!person) throw notFound('Person');
    // On a thing's page (CP-14): the one it names or the one of what it reads, which the person may see.
    const viewer = viewerFor(person);
    const thingId = input.thingId
      ? (await thingVisible(ctx.services, viewer, input.thingId))
        ? input.thingId
        : null
      : await pageOfSource(ctx.services, viewer, input.source);
    if (!thingId) throw notFound('Thing');
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(widgets)
      .where(and(eq(widgets.burrowId, ctx.burrow.id), eq(widgets.ownerId, person.id), placeOf(thingId)));
    if (n >= WIDGETS_MAX)
      throw conflict(`That page has ${WIDGETS_MAX} widgets already. Ask to remove one first.`);
    await checkSource(tx, person, input.source);
    const id = newId('widget');
    const refreshSec = Math.min(
      Math.max(input.refreshSec ?? WIDGET_REFRESH_DEFAULT_S, WIDGET_REFRESH_MIN_S),
      WIDGET_REFRESH_MAX_S,
    );
    await tx.insert(widgets).values({
      id,
      burrowId: ctx.burrow.id,
      ownerId: person.id,
      agentId: agent.id,
      title: input.title,
      subtitle: input.subtitle?.trim() || null,
      kind: 'line',
      source: input.source,
      series: seriesOf(input.source),
      refreshSec,
      position: n,
      fromConversationId: input.conversationId ?? null,
      createdAt: ctx.now,
      thingId,
    });
    await ctx.emit({
      type: 'widget.pinned',
      kind: 'System',
      text: null,
      where: null,
      payload: {
        widgetId: id,
        ownerId: person.id,
        sourceKind: input.source.kind,
        thingId,
      },
    });
    publishHomeChanged(ctx, [person.id], ['widgets']);
    const services = ctx.services;
    // Its first points at once, after the commit (no model: the server reads it).
    ctx.background('widget first read', () => refreshWidget(services, id).then(() => undefined));
    return { widgetId: id };
  },
});

/** The person unpins a widget. */
export const removeWidget = defineCommand({
  name: 'remove_widget',
  schema: z.object({ widgetId: WidgetId }),
  async apply(tx, ctx, input) {
    const [row] = await tx.select().from(widgets).where(eq(widgets.id, input.widgetId));
    if (!row || row.burrowId !== ctx.burrow.id || row.ownerId !== ctx.actor.id) throw notFound('Widget');
    await tx.delete(widgets).where(eq(widgets.id, row.id));
    await ctx.emit({
      type: 'widget.removed',
      kind: 'System',
      text: null,
      where: null,
      payload: { widgetId: row.id },
    });
    publishHomeChanged(ctx, [row.ownerId], ['widgets']);
    return { widgetId: row.id };
  },
});

/** The person moves a widget to a position (0 = first); the others close up around it. */
export const moveWidget = defineCommand({
  name: 'move_widget',
  schema: z.object({ widgetId: WidgetId, position: z.number().int().min(0).max(100) }),
  async apply(tx, ctx, input) {
    const [row] = await tx.select().from(widgets).where(eq(widgets.id, input.widgetId));
    if (!row || row.burrowId !== ctx.burrow.id || row.ownerId !== ctx.actor.id) throw notFound('Widget');
    // Among the widgets of the same place: Home, or the same thing's page.
    const mine = await tx
      .select({ id: widgets.id })
      .from(widgets)
      .where(and(eq(widgets.burrowId, ctx.burrow.id), eq(widgets.ownerId, row.ownerId), placeOf(row.thingId)))
      .orderBy(asc(widgets.position), asc(widgets.createdAt))
      .for('update');
    const order = mine.map((w) => w.id).filter((id) => id !== row.id);
    order.splice(Math.min(input.position, order.length), 0, row.id);
    for (const [position, id] of order.entries())
      await tx.update(widgets).set({ position }).where(eq(widgets.id, id));
    publishHomeChanged(ctx, [row.ownerId], ['widgets']);
    return { widgetId: row.id };
  },
});

/** One refresh's points, the old ones pruned, the widget's state; signed by nobody (the server's own read). */
export const recordWidgetRead = defineCommand({
  name: 'record_widget_read',
  schema: z.object({
    widgetId: WidgetId,
    values: z.record(z.string(), z.number().nullable()).nullable(),
    problem: z.string().max(200).nullable(),
  }),
  async apply(tx, ctx, input) {
    const [row] = await tx.select().from(widgets).where(eq(widgets.id, input.widgetId));
    if (!row || row.ownerId !== ctx.actor.id) return { recorded: false };
    if (input.values)
      await tx
        .insert(widgetPoints)
        .values({ widgetId: row.id, t: ctx.now, values: input.values })
        .onConflictDoNothing();
    await tx
      .delete(widgetPoints)
      .where(
        and(
          eq(widgetPoints.widgetId, row.id),
          lt(widgetPoints.t, new Date(ctx.now.getTime() - WIDGET_HISTORY_S * 1000)),
        ),
      );
    await tx
      .update(widgets)
      .set({ refreshedAt: ctx.now, lastError: input.problem })
      .where(eq(widgets.id, row.id));
    publishWidgetUpdated(ctx, row.ownerId, row.id);
    return { recorded: true };
  },
});

/** Reads one widget now and records it (as the person). Returns whether it read values. */
export async function refreshWidget(services: Services, widgetId: string): Promise<boolean> {
  const [row] = await services.db.select().from(widgets).where(eq(widgets.id, widgetId));
  if (!row) return false;
  const person = await loadPrincipalRow(services.db, row.ownerId);
  if (!person) return false;
  const reader = readers.get((row.source as WidgetSource).kind);
  let values: Record<string, number | null> | null = null;
  let problem: string | null = null;
  try {
    if (!reader) throw new WidgetReadError('This widget can’t be read here.');
    values = await reader(services, row, person);
  } catch (err) {
    problem = err instanceof WidgetReadError ? err.message : 'Couldn’t read it just now.';
  }
  await services.pipeline.commit(
    recordWidgetRead,
    { widgetId: row.id, values, problem },
    { burrowId: row.burrowId, actorId: row.ownerId },
  );
  return values !== null;
}

/** Every widget whose refresh is due, read one after another (`home.widgets` job). Returns how many it read. */
export async function refreshDueWidgets(services: Services, now = services.clock()): Promise<number> {
  const due = await services.db
    .select({ id: widgets.id })
    .from(widgets)
    .innerJoin(principals, eq(principals.id, widgets.ownerId))
    .where(
      and(
        or(
          isNull(widgets.refreshedAt),
          sql`${widgets.refreshedAt} + make_interval(secs => ${widgets.refreshSec}) <= ${now.toISOString()}::timestamptz`,
        ),
      ),
    )
    .orderBy(asc(widgets.refreshedAt))
    .limit(100);
  let read = 0;
  for (const { id } of due) if (await refreshWidget(services, id).catch(() => false)) read++;
  return read;
}

export const WIDGET_COMMANDS = [pinWidget, removeWidget, moveWidget, recordWidgetRead];
