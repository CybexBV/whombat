/**
 * Reading tracker things from the database for automations (docs/decisions/report-trackers.md): a mirrored report as a
 * run's item, the connection labels a viewer's sentences name, and the connections a live automation listens to.
 */
import type { AutomationDefinition, TrackerTrigger } from '@whombat/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import {
  automations,
  automationVersions,
  catalogConnections,
  connections,
  trackerItems,
} from '../db/schema/index';
import { addressHost, itemKindOf, type TrackerRunItem } from './items';

/** A mirrored report as a run's item (TA-08), with its connection's label and handle; null when it is gone. */
export async function mirroredItem(db: Db | Tx, rowId: string): Promise<TrackerRunItem | null> {
  const [found] = await db
    .select({
      r: trackerItems,
      label: catalogConnections.label,
      handle: catalogConnections.handle,
      baseUrl: catalogConnections.baseUrl,
    })
    .from(trackerItems)
    .innerJoin(catalogConnections, eq(catalogConnections.id, trackerItems.connectionId))
    .where(eq(trackerItems.id, rowId));
  if (!found) return null;
  const r = found.r;
  return {
    connectionId: r.connectionId,
    connection: found.label,
    handle: found.handle,
    host: addressHost(found.baseUrl),
    product: r.product,
    reportId: r.externalId,
    number: r.number,
    type: itemKindOf(r.kind),
    title: r.title,
    organization: r.organization,
    environment: r.environment,
    version: r.version,
    page: r.page,
    browser: r.browser,
    // As the poller last saw it (TA-31): a customer's answer runs against the report as it is now.
    status: r.seenStatus ?? r.status,
    priority: r.priority,
    description: r.description,
    expected: r.expected,
    hasScreenshot: r.hasScreenshot,
    hasDiagnostics: r.hasDiagnostics,
  };
}

/** The number Whombat mirrored for a tracker report of a connection (null: never mirrored). */
export async function mirroredNumber(
  db: Db | Tx,
  connectionId: string,
  reportId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ number: trackerItems.number })
    .from(trackerItems)
    .where(and(eq(trackerItems.connectionId, connectionId), eq(trackerItems.externalId, reportId)));
  return row?.number ?? null;
}

/** The tracker triggers of a definition. */
export function trackerTriggers(definition: AutomationDefinition | null | undefined): TrackerTrigger[] {
  return (definition?.triggers ?? []).filter((t): t is TrackerTrigger => t.kind === 'tracker');
}

/**
 * The connection ids a definition names: its tracker and mail triggers' and its `tracker_update`, `tracker_reply` and
 * `tracker_decision` steps'.
 */
export function definitionConnections(definition: AutomationDefinition | null | undefined): string[] {
  if (!definition) return [];
  return [
    ...new Set([
      ...trackerTriggers(definition).map((t) => t.connectionId),
      ...definition.triggers.flatMap((t) => (t.kind === 'mail' ? [t.connectionId] : [])),
      ...definition.steps.flatMap((s) =>
        s.kind === 'tracker_update' || s.kind === 'tracker_reply' || s.kind === 'tracker_decision'
          ? [s.connectionId]
          : [],
      ),
    ]),
  ];
}

/** Labels of these connections, by id (“Acme Desk dev” for trackers, the mailbox address for mail accounts). */
export async function connectionLabels(db: Db | Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const unique = [...new Set(ids)];
  const [catalogRows, mailRows] = await Promise.all([
    db
      .select({ id: catalogConnections.id, label: catalogConnections.label })
      .from(catalogConnections)
      .where(inArray(catalogConnections.id, unique)),
    db
      .select({ id: connections.id, email: connections.email })
      .from(connections)
      .where(inArray(connections.id, unique)),
  ]);
  const map = new Map(catalogRows.map((r) => [r.id, r.label]));
  for (const r of mailRows) if (!map.has(r.id)) map.set(r.id, r.email);
  return map;
}

/**
 * The tracker connections a live automation listens to (TA-05): named by a `tracker` trigger of the current version of
 * an automation that is published and not deleted. With each, the report kinds any of them wants.
 */
export async function listenedConnections(db: Db): Promise<Map<string, { burrowId: string }>> {
  const rows = await db
    .select({ burrowId: automations.burrowId, definition: automationVersions.definition })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(
      and(
        eq(automations.status, 'published'),
        isNull(automations.deletedAt),
        sql`exists (select 1 from jsonb_array_elements(${automationVersions.definition} -> 'triggers') as t
          where t ->> 'kind' = 'tracker')`,
      ),
    );
  const out = new Map<string, { burrowId: string }>();
  for (const { burrowId, definition } of rows)
    for (const t of trackerTriggers(definition)) out.set(t.connectionId, { burrowId });
  return out;
}
