/**
 * A page recipe's reads (docs/decisions/connection-looks.md): each one an MCP tool of the connection that its server
 * marks read-only, or a GET of the API, made as the connection with the kinds' deadline, size cap and cache. Nothing a
 * recipe names can change anything: a tool that isn't a read is refused before it is called.
 */
import { catalogEntry, type PageRead, resolveMcpUrl, type SignInKind } from '@whombat/core';
import { externalEffect } from '../../commit/scope';
import { connectionsFor } from '../../connections/pool';
import { toolRowsOf } from '../../connections/store';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { VaultCallError } from '../../vault/net';
import { getJson, latestRead, problemOf, ReadProblem } from '../kinds/read';
import { displayName } from '../part-of';

/** How long a read is kept when the recipe says nothing. */
export const READ_EVERY_S = 60;

/** The connection's tools a recipe may read: those its server marks read-only. */
export async function readOnlyTools(services: Services, connectionId: string): Promise<Set<string>> {
  const rows = await toolRowsOf(services.db, connectionId);
  return new Set(rows.filter((t) => t.access === 'read').map((t) => t.name));
}

/** One read's JSON answer as the connection; a failure is a `ReadProblem` in words. */
export async function readOnce(
  services: Services,
  row: CatalogConnectionRow,
  read: PageRead,
  tools: ReadonlySet<string>,
): Promise<unknown> {
  const name = displayName(row);
  if (read.path !== undefined) {
    if (row.catalogId !== 'custom_api')
      throw new ReadProblem(`${name} has no API paths to read; name a tool.`);
    return getJson(services, row, name, read.path, read.query ?? {});
  }
  const tool = read.tool as string;
  if (row.catalogId !== 'custom_mcp') throw new ReadProblem(`${name} has no MCP tools to read; name a path.`);
  if (!tools.has(tool))
    throw new ReadProblem(`“${tool}” isn’t one of ${name}’s tools that only read, so a page can’t use it.`);
  const entry = catalogEntry(row.catalogId);
  const url = entry ? resolveMcpUrl(entry, row.fields, row.signIn as SignInKind) : null;
  if (!url) throw new ReadProblem(`${name} has no address Whombat can read.`);
  const service = connectionsFor(services);
  let res: Awaited<ReturnType<typeof service.pool.call>>;
  try {
    res = await externalEffect(
      'things.read',
      () => service.pool.call(service.target(row, url), tool, read.args ?? {}),
      { idempotent: true },
    );
  } catch (err) {
    if (err instanceof VaultCallError && (err.status === 401 || err.message === 'needs_reauth'))
      throw new ReadProblem(`${name} needs you to sign in again.`, true);
    throw problemOf(err, name);
  }
  if (res.isError)
    throw new ReadProblem(`${name} answered “${tool}” with an error: ${res.text.slice(0, 200)}`);
  if (res.structured) return res.structured;
  try {
    return JSON.parse(res.text);
  } catch {
    // A tool that answers in words is still something to show.
    return res.text;
  }
}

/** A read for the page: the last answer while it is younger than its `everyS`, else a new one (the page waits briefly). */
export function pageRead(
  services: Services,
  row: CatalogConnectionRow,
  read: PageRead,
  tools: ReadonlySet<string>,
  fresh = false,
) {
  return latestRead(
    services,
    `recipe:${row.id}:${read.id}`,
    row,
    () => readOnce(services, row, read, tools),
    {
      ttlMs: fresh ? 0 : (read.everyS ?? READ_EVERY_S) * 1000,
      waitMs: fresh ? 15_000 : undefined,
    },
  );
}
