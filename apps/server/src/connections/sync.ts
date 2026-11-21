/**
 * A connection's tools (docs/decisions/connections-catalog.md CX-18, CX-30…CX-34): discovered from its MCP server
 * (`tools/list`, access from `readOnlyHint`, unknown = write), defined by its adapter (`FILES_TOOLS`, `TASKS_TOOLS`), plus
 * the generic `request` tool where the entry has one. Each definition is hashed canonically (an approval binds the hash,
 * CX-21). Refreshed on connect, on “Check again” and at most hourly on use (`ensureTools`).
 *
 * Tiers survive a refresh; a tool whose definition changed is marked New (after the first sync) and keeps its tier only
 * if its access did not widen (read → write resets to Ask). At most 128 tools; tools that went away are removed. When the
 * MCP server can't be listed (other than a missing one), its tools are kept as they were and the check says why.
 */
import {
  type CatalogCheckResult,
  type CatalogEntry,
  CONNECTION_TOOLS_MAX,
  type ConnectionToolAccess,
  type ConnectionToolTier,
  canonicalJson,
  catalogEntry,
  connectionTransport,
  defaultToolTier,
  hasRequestTool,
  hasSocketTool,
  type JsonObject,
  mcpToolHidden,
  mcpToolReads,
  type RemoteVaultTool,
  resolveMcpUrl,
  type SignInKind,
  sha256Hex,
  socketToolDef,
  toolAlwaysAsks,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { catalogConnections, connectionTools } from '../db/schema/index';
import { DEVICE_CATALOG_ID } from '../devices/store';
import type { Services } from '../services';
import { VaultCallError } from '../vault/net';
import { CALLABLE_BUILTINS } from './callable';
import { currentRow } from './http';
import { setUpMcp } from './mcp-setup';
import { connectionsFor } from './pool';
import { requestToolDef } from './request';
import {
  type CatalogConnectionRow,
  ConnectionAuthError,
  type ConnectionToolRow,
  type ToolSyncResult,
} from './types';

/**
 * Where a tool came from; `mcp-destructive`: an MCP tool its server marks destructive (kept for its hash; it doesn't ask
 * by itself since CX-31a).
 */
export type ToolOrigin =
  | 'mcp'
  | 'mcp-destructive'
  | 'adapter'
  | 'request'
  | 'socket'
  | 'device'
  | 'device-sensitive';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject | null;
  access: ConnectionToolAccess;
  origin: ToolOrigin;
}

/** Tools are refreshed on use at most this often. */
export const TOOLS_STALE_MS = 60 * 60_000;
const NAME = /^[A-Za-z0-9_.\-/]{1,200}$/;

/** sha256 hex of a tool's canonical definition (name, description, input schema, access, destructive). */
export function toolHash(def: ToolDefinition): string {
  return sha256Hex(
    canonicalJson({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      access: def.access,
      destructive: def.origin === 'mcp-destructive',
    }),
  );
}

/**
 * A listed MCP tool as a definition, or null when its name can't be used or the entry never serves it
 * (`mcpTools.hidden`: T3 Code's tools that only work inside its own threads, docs/decisions/t3code.md T3-04). A tool the
 * entry names a read (`mcpTools.reads`) is one whatever the server's hints say.
 */
export function mcpDefinition(
  tool: RemoteVaultTool,
  entry: Pick<CatalogEntry, 'mcpTools'> | null = null,
): ToolDefinition | null {
  if (!NAME.test(tool.name)) return null;
  if (entry && mcpToolHidden(entry, tool.name)) return null;
  const hints = (tool.annotations ?? {}) as { readOnlyHint?: unknown; destructiveHint?: unknown };
  const reads = hints.readOnlyHint === true || (entry !== null && mcpToolReads(entry, tool.name));
  const access: ConnectionToolAccess = reads ? 'read' : 'write';
  const text = [tool.title, tool.description].filter((s) => typeof s === 'string' && s.trim()).join(' — ');
  const schema =
    tool.inputSchema && typeof tool.inputSchema === 'object' ? (tool.inputSchema as JsonObject) : null;
  return {
    name: tool.name,
    description: text.slice(0, 1000),
    inputSchema: schema,
    access,
    // Only a write can be destructive (MCP: destructiveHint means nothing when readOnlyHint is true).
    origin: access === 'write' && hints.destructiveHint === true ? 'mcp-destructive' : 'mcp',
  };
}

/** The tools an entry's adapter and `request` give a connection made with `signIn`. */
export function ownDefinitions(
  entry: CatalogEntry,
  row: Pick<CatalogConnectionRow, 'baseUrl' | 'fields'> & { signIn: string },
): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  // The Servers connection serves its typed tools like a REST adapter (one-whombat-servers.md ONE-DH14).
  if (
    connectionTransport(entry, row.signIn as SignInKind) === 'rest' ||
    (entry.transport === 'builtin' && CALLABLE_BUILTINS.has(entry.id))
  )
    for (const t of entry.tools)
      out.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        access: t.access,
        origin: 'adapter',
      });
  if (hasRequestTool(entry, row.signIn as SignInKind))
    out.push({ ...requestToolDef(entry, row), origin: 'request' });
  // A socket entry's one tool, `call` (docs/decisions/connections-more.md CM-14).
  if (hasSocketTool(entry, row.signIn as SignInKind))
    out.push({ ...socketToolDef(entry, row.baseUrl), origin: 'socket' });
  return out;
}

export interface ToolChange {
  upsert: (Omit<ConnectionToolRow, 'connectionId' | 'updatedAt' | 'limits'> & { changed: boolean })[];
  remove: string[];
}

/**
 * How the stored tools change for the definitions found (pure, CX-18): same hash → as it is; changed → New, its tier
 * kept unless read became write (→ Ask); new → its default tier (New only after the first sync, and not for an MCP
 * server's first listing, `firstMcp`, CX-18a). Capped at 128. `quietWording` (Whombat's own built-in tools,
 * server-asks-server.md SA-S04): a tool whose only change is its description keeps its New mark as it was.
 */
export function mergeTools(
  existing: readonly (Pick<ConnectionToolRow, 'name' | 'hash' | 'tier' | 'access' | 'isNew'> & {
    inputSchema?: unknown;
    origin?: string;
  })[],
  found: readonly ToolDefinition[],
  options: { firstSync: boolean; firstMcp?: boolean; quietWording?: boolean },
): ToolChange & { truncated: boolean } {
  const byName = new Map(existing.map((t) => [t.name, t]));
  const seen = new Set<string>();
  const unique = found.filter((d) => !seen.has(d.name) && seen.add(d.name));
  const kept = unique.slice(0, CONNECTION_TOOLS_MAX);
  const upsert: ToolChange['upsert'] = kept.map((def, position) => {
    const hash = toolHash(def);
    const before = byName.get(def.name);
    let tier: ConnectionToolTier;
    let isNew: boolean;
    let changed = false;
    if (!before) {
      tier = defaultToolTier(def.access);
      const fromNewServer =
        options.firstMcp === true && (def.origin === 'mcp' || def.origin === 'mcp-destructive');
      isNew = !options.firstSync && !fromNewServer;
      changed = true;
    } else if (before.hash === hash) {
      tier = before.tier;
      isNew = before.isNew;
    } else {
      const widened = before.access === 'read' && def.access === 'write';
      tier = widened && before.tier !== 'off' ? 'ask' : before.tier;
      const wordingOnly =
        options.quietWording === true &&
        before.inputSchema !== undefined &&
        before.access === def.access &&
        before.origin === def.origin &&
        canonicalJson(before.inputSchema ?? null) === canonicalJson(def.inputSchema ?? null);
      isNew = wordingOnly ? before.isNew : true;
      changed = true;
    }
    return {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      access: def.access,
      tier,
      hash,
      isNew,
      origin: def.origin,
      position,
      changed,
    };
  });
  const names = new Set(kept.map((d) => d.name));
  return {
    upsert,
    remove: existing.filter((t) => !names.has(t.name)).map((t) => t.name),
    truncated: unique.length > kept.length,
  };
}

/**
 * Whether a stored tool always asks (CX-31, the “Always asks” mark): the entry's rules say so, or it is named for
 * deleting. A server's destructive hint alone doesn't (CX-31a).
 */
export function toolRowAlwaysAsks(
  entry: CatalogEntry,
  tool: Pick<ConnectionToolRow, 'name'> & { origin?: string },
): boolean {
  // A device action its profile marks sensitive (one-whombat-devices.md).
  return toolAlwaysAsks(entry, tool.name) || tool.origin === 'device-sensitive';
}

interface McpFound {
  tools: ToolDefinition[] | null;
  checks: CatalogCheckResult[];
}

/** Waits after Whombat added the MCP server before listing it again (Home Assistant loads it right after). */
export const MCP_SETUP_WAITS_MS = [500, 1500, 3000];

/**
 * What the MCP server lists, or why not (null tools: keep what is stored). A missing one the entry can set up is
 * added first (`setUpMcp`, CX-54a) and listed again.
 */
async function listMcp(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
): Promise<McpFound> {
  const url = resolveMcpUrl(entry, row.fields, row.signIn as SignInKind);
  if (!url) return { tools: [], checks: [] };
  const found = await listMcpOnce(services, row, entry, url);
  if (found !== 'missing') return found;
  const missing = (message: string | null): McpFound => ({
    tools: [],
    checks: message ? [{ id: 'mcp', state: 'warning', message }] : [],
  });
  if (!entry.mcpSetup) return missing(entry.mcpMissingHint);
  const setup = await setUpMcp(services, row, entry);
  if (!setup.done) return missing(setup.message);
  for (const ms of MCP_SETUP_WAITS_MS) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const again = await listMcpOnce(services, row, entry, url);
    if (again === 'missing') continue;
    // It works now: the line says “Working” like any other (CX-54b).
    return again;
  }
  return missing(
    `Whombat turned on ${entry.name}’s MCP server, but it doesn’t answer yet. Check again in a minute.`,
  );
}

/** One listing: the tools, why not, or `missing` (404) when the entry says what to do about a missing server. */
async function listMcpOnce(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  url: string,
): Promise<McpFound | 'missing'> {
  try {
    const listed = await connectionsFor(services).pool.listTools(connectionsFor(services).target(row, url));
    const tools = listed.map((t) => mcpDefinition(t, entry)).filter((d): d is ToolDefinition => d !== null);
    return { tools, checks: [{ id: 'mcp', state: 'ok', message: entry.mcpReadyNote }] };
  } catch (err) {
    if (err instanceof ConnectionAuthError)
      return {
        tools: null,
        checks: [
          { id: 'credential', state: 'error', message: 'This connection needs you to sign in again.' },
        ],
      };
    const failure = err instanceof VaultCallError ? err : null;
    if (failure?.status === 404 && (entry.mcpMissingHint || entry.mcpSetup)) return 'missing';
    if (failure?.status === 401 || failure?.status === 403)
      return {
        tools: null,
        checks: [
          {
            id: 'credential',
            state: 'error',
            message: `The MCP server refused the credential (${failure.status}).`,
          },
        ],
      };
    return {
      tools: null,
      checks: [
        {
          id: 'mcp',
          state: 'error',
          message: (failure?.message ?? 'Couldn’t list the MCP server’s tools.').slice(0, 500),
        },
      ],
    };
  }
}

const running = new WeakMap<Services, Map<string, Promise<ToolSyncResult>>>();

/** Refreshes a connection's tools now (single-flight per connection). Throws when there is no such connection. */
export function syncTools(services: Services, connectionId: string): Promise<ToolSyncResult> {
  let inflight = running.get(services);
  if (!inflight) {
    inflight = new Map();
    running.set(services, inflight);
  }
  const existing = inflight.get(connectionId);
  if (existing) return existing;
  const map = inflight;
  const job = doSync(services, connectionId).finally(() => map.delete(connectionId));
  map.set(connectionId, job);
  return job;
}

async function doSync(services: Services, connectionId: string): Promise<ToolSyncResult> {
  const row = await currentRow(services, connectionId);
  if (!row) throw new Error('No such connection.');
  // A device's tools come from its skill when the person switches it on (one-whombat-devices.md), never from a listing.
  if (row.catalogId === DEVICE_CATALOG_ID) return { count: row.toolCount, checks: [] };
  const entry = catalogEntry(row.catalogId);
  if (!entry || (entry.transport === 'builtin' && !CALLABLE_BUILTINS.has(entry.id)))
    throw new Error(`${row.catalogId} has no tools here.`);
  const own = ownDefinitions(entry, row);
  const mcp = await listMcp(services, row, entry);
  const stored = await services.db
    .select()
    .from(connectionTools)
    .where(eq(connectionTools.connectionId, connectionId));
  // The MCP server couldn't be listed: its stored tools stay as they are, but for one the entry hides now.
  const keepMcp =
    mcp.tools === null
      ? stored
          .filter(
            (t) => (t.origin === 'mcp' || t.origin === 'mcp-destructive') && !mcpToolHidden(entry, t.name),
          )
          .map(
            (t): ToolDefinition => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema as JsonObject | null,
              access: t.access,
              origin: t.origin as ToolOrigin,
            }),
          )
      : mcp.tools;
  // Typed tools first, the server's next, `request` (or a socket's `call`) last.
  const found = [
    ...own.filter((d) => d.origin === 'adapter'),
    ...keepMcp,
    ...own.filter((d) => d.origin === 'request' || d.origin === 'socket'),
  ];
  // The first listing of an MCP server (just added, or turned on by Whombat) marks nothing New, as a first sync (CX-18a).
  const firstMcp = !stored.some((t) => t.origin === 'mcp' || t.origin === 'mcp-destructive');
  const change = mergeTools(stored, found, {
    firstSync: row.toolsSyncedAt === null,
    firstMcp,
    // Whombat's own tools reworded with a release are no news to anyone (server-asks-server.md SA-S04).
    quietWording: entry.transport === 'builtin',
  });
  const now = services.clock();
  await services.pipeline.transactAccount(async (tx) => {
    if (change.remove.length)
      await tx
        .delete(connectionTools)
        .where(
          and(eq(connectionTools.connectionId, connectionId), inArray(connectionTools.name, change.remove)),
        );
    for (const t of change.upsert) {
      const { changed, ...values } = t;
      await tx
        .insert(connectionTools)
        .values({ connectionId, ...values, updatedAt: now })
        .onConflictDoUpdate({
          target: [connectionTools.connectionId, connectionTools.name],
          set: changed
            ? {
                description: values.description,
                inputSchema: values.inputSchema,
                access: values.access,
                tier: values.tier,
                hash: values.hash,
                isNew: values.isNew,
                origin: values.origin,
                position: values.position,
                updatedAt: now,
              }
            : { position: values.position },
        });
    }
    await tx
      .update(catalogConnections)
      .set({ toolCount: change.upsert.length, toolsSyncedAt: now })
      .where(eq(catalogConnections.id, connectionId));
  });
  const checks: CatalogCheckResult[] = [...mcp.checks];
  if (change.truncated)
    checks.push({
      id: 'tools',
      state: 'warning',
      message: `It offers more than ${CONNECTION_TOOLS_MAX} tools; agents get the first ${CONNECTION_TOOLS_MAX}.`,
    });
  return { count: change.upsert.length, checks };
}

/**
 * The connection's tools for a call or listing. Bundled definitions refresh immediately after an upgrade;
 * remote definitions refresh at most hourly. A failed refresh keeps the stored tools.
 */
export async function ensureTools(
  services: Services,
  row: CatalogConnectionRow,
): Promise<{ tools: ConnectionToolRow[]; checks: CatalogCheckResult[] }> {
  let checks: CatalogCheckResult[] = [];
  const read = () =>
    services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, row.id))
      .orderBy(connectionTools.position);
  let tools = await read();
  const entry = catalogEntry(row.catalogId);
  const own = entry ? ownDefinitions(entry, row) : [];
  const storedOwn = tools.filter((t) => ['adapter', 'request', 'socket'].includes(t.origin));
  const bundledChanged =
    own.length !== storedOwn.length ||
    own.some((def) => !storedOwn.some((t) => t.name === def.name && t.hash === toolHash(def)));
  const stale =
    row.catalogId !== DEVICE_CATALOG_ID &&
    (bundledChanged ||
      row.toolsSyncedAt === null ||
      services.clock().getTime() - row.toolsSyncedAt.getTime() > TOOLS_STALE_MS);
  if (stale) {
    try {
      checks = (await syncTools(services, row.id)).checks;
      tools = await read();
    } catch (err) {
      services.log.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'could not refresh connection tools',
      );
    }
  }
  return { tools, checks };
}
