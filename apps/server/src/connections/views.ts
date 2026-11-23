/**
 * Catalog connections as clients see them (CX-25, CX-70, CX-72; contracts `ConnectionView`, `ConnectionToolView`,
 * `ConnectionsCatalogStatus`). Secrets, tokens and pending sign-ins never leave the server.
 */
import {
  CATALOG,
  type CatalogEntryStatus,
  CONNECTION_TOOLS_MAX,
  CONNECTIONS_MAX,
  type ConnectionsCatalogStatus,
  type ConnectionToolView,
  type ConnectionView,
  catalogEntry,
  clientIdHint,
  connectionGuide,
  connectionHost,
  isAgentConnection,
  JsonObject,
  OAuthSignInKind,
  type SignInKind,
} from '@whombat/core';
import { inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { connectorApps, principals } from '../db/schema/index';
import { macsOf } from '../hosts/findmy-connection';
import { hostsFor } from '../hosts/service';
import { iso } from '../lib/time';
import type { PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { pollerViews } from '../trackers/views';
import { appRedirectUri, returnAddressProblem } from './redirect';
import { toolRowsOf } from './store';
import { toolRowAlwaysAsks } from './sync';
import type { CatalogConnectionRow, ConnectionToolRow } from './types';

/** The people who connected these connections, by principal id. */
export async function connectorsOf(
  db: Db | Tx,
  rows: readonly CatalogConnectionRow[],
): Promise<Map<string, PrincipalRow>> {
  const ids = [...new Set(rows.map((r) => r.connectedById).filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const found = await db.select().from(principals).where(inArray(principals.id, ids));
  return new Map(found.map((p) => [p.id, p]));
}

/** The row's detail (CX-70): who the service says it is, else the host; null for fixed services without either. */
export function connectionDetail(row: CatalogConnectionRow): string | null {
  if (row.externalName) return row.externalName.slice(0, 300);
  const entry = catalogEntry(row.catalogId);
  return entry ? connectionHost(entry, row.fields) : null;
}

export function toConnectionView(
  row: CatalogConnectionRow,
  connectors: ReadonlyMap<string, PrincipalRow>,
  pollers: ReadonlyMap<string, ConnectionView['poller']> = new Map(),
): ConnectionView {
  const who = row.connectedById ? connectors.get(row.connectedById) : undefined;
  const connectedBy: ConnectionView['connectedBy'] = who
    ? { id: who.id, name: who.name }
    : { id: null, name: 'Someone who left' };
  return {
    id: row.id,
    catalogId: row.catalogId,
    label: row.label,
    handle: row.handle,
    connectedBy,
    detail: connectionDetail(row),
    signIn: row.signIn as SignInKind,
    transport: row.transport,
    fields: row.fields,
    status: row.status,
    reauthReason: row.reauthReason ?? null,
    checks: row.checks,
    checkedAt: row.checkedAt ? iso(row.checkedAt) : null,
    toolCount: row.toolCount,
    access: row.access,
    // What a call needed that the service hasn't allowed yet (step-up): the page offers Allow on {Name}.
    permissionAsked: (row.scopesWanted ?? []).filter((s) => !row.scopes.includes(s)).slice(0, 20),
    // How the poller of an automations-only connection is doing, while an automation listens (TA-03, TA-05).
    poller: pollers.get(row.id) ?? null,
    createdAt: iso(row.createdAt),
    lastUsedAt: row.lastUsedAt ? iso(row.lastUsedAt) : null,
  };
}

/** Views of several rows, loading who connected them. */
export async function connectionViews(
  db: Db | Tx,
  rows: readonly CatalogConnectionRow[],
): Promise<ConnectionView[]> {
  const connectors = await connectorsOf(db, rows);
  const pollers = await pollerViews(
    db,
    rows.filter((r) => !isAgentConnection(r.catalogId)).map((r) => r.id),
  );
  return rows.map((r) => toConnectionView(r, connectors, pollers));
}

export async function connectionView(db: Db | Tx, row: CatalogConnectionRow): Promise<ConnectionView> {
  const [view] = await connectionViews(db, [row]);
  if (!view) throw new Error('no view');
  return view;
}

export function toToolView(row: CatalogConnectionRow, tool: ConnectionToolRow): ConnectionToolView {
  const entry = catalogEntry(row.catalogId);
  const schema = tool.inputSchema ? JsonObject.safeParse(tool.inputSchema) : null;
  return {
    name: tool.name,
    description: tool.description.slice(0, 1000),
    access: tool.access,
    tier: tool.tier,
    sensitive: entry ? toolRowAlwaysAsks(entry, tool) : false,
    isNew: tool.isNew,
    ...(schema?.success ? { inputSchema: schema.data } : {}),
    // The person's limits (one-whombat-devices.md ONE-DD04, CT-341); absent when none.
    ...(tool.limits ? { limits: tool.limits } : {}),
  };
}

/** The connection page's TOOLS (CX-72): the tools with tiers and marks, and the guide agents get. */
export async function connectionToolsResponse(db: Db | Tx, row: CatalogConnectionRow) {
  const tools = await toolRowsOf(db, row.id);
  const entry = catalogEntry(row.catalogId);
  return {
    connection: await connectionView(db, row),
    tools: tools.map((t) => toToolView(row, t)),
    guide: entry ? connectionGuide(entry, row.fields) : '',
    truncated: row.toolCount > CONNECTION_TOOLS_MAX,
  };
}

/** How many Macs Whombat watches: 0 without the hosts service, null when it doesn't answer. */
async function macCount(services: Services): Promise<number | null> {
  const hosts = hostsFor(services);
  if (!hosts.present) return 0;
  try {
    return macsOf(await hosts.fleetRaw()).length;
  } catch {
    return null;
  }
}

/** `connections.catalog` (CX-14, CX-75): every entry, an `app_oauth` one available once the person registered its app. */
export async function catalogStatus(services: Services): Promise<ConnectionsCatalogStatus> {
  const appIds = CATALOG.filter((e) => e.signIn.some((m) => m.kind === 'app_oauth')).map((e) => e.id);
  const apps = appIds.length
    ? await services.db
        .select()
        .from(connectorApps)
        .where(inArray(connectorApps.provider, appIds as never[]))
    : [];
  const byId = new Map(apps.map((a) => [a.provider as string, a]));
  // A box without a secure address can't take a sign-in back (whombat-link.md): an entry that signs in only that way
  // says so before anyone starts it, in the words `startOAuth` would refuse with.
  const noReturn = returnAddressProblem(services.config) !== null;
  // Find My works through one of the person's Macs: offered once the servers have one (unknown while they don't answer).
  const macs = CATALOG.some((e) => e.check?.kind === 'mac') ? await macCount(services) : null;
  const entries: CatalogEntryStatus[] = CATALOG.map((entry) => {
    // A report tracker is offered once a driver is installed (report-trackers.md).
    if (entry.check?.kind === 'driver' && !services.tracker.drivers.list().length)
      return { catalogId: entry.id, available: false, reason: 'no_driver' };
    if (entry.check?.kind === 'mac' && macs === 0)
      return { catalogId: entry.id, available: false, reason: 'needs_mac' };
    const needsReturn =
      entry.signIn.length > 0 && entry.signIn.every((m) => OAuthSignInKind.safeParse(m.kind).success);
    const app = byId.get(entry.id);
    const appStatus = entry.signIn.some((m) => m.kind === 'app_oauth')
      ? {
          app: {
            configured: !!app,
            source: app ? ('settings' as const) : null,
            clientIdHint: app ? clientIdHint(app.clientId) : null,
            secretSet: !!app && app.clientSecretEnc !== '',
            redirectUri: appRedirectUri(services.config, entry.id),
            updatedAt: app ? iso(app.updatedAt) : null,
          },
        }
      : {};
    if (needsReturn && noReturn)
      return { catalogId: entry.id, available: false, reason: 'needs_secure_address', ...appStatus };
    if (!entry.signIn.some((m) => m.kind === 'app_oauth'))
      return { catalogId: entry.id, available: true, reason: null };
    // Another sign-in (a token) keeps an entry available without its app.
    const otherWay = entry.signIn.some((m) => m.kind !== 'app_oauth');
    return {
      catalogId: entry.id,
      available: !!app || otherWay,
      reason: app || otherWay ? null : 'app_not_configured',
      ...appStatus,
    };
  });
  return {
    mode: 'real',
    entries,
    limit: CONNECTIONS_MAX,
  };
}
