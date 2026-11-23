/**
 * A page recipe's reads (docs/decisions/connection-looks.md): each one an MCP tool of the connection that its server
 * marks read-only, or a GET of the API, made as the connection with the kinds' deadline, size cap and cache. Nothing a
 * recipe names can change anything: a tool that isn't a read is refused before it is called.
 */
import type { PageRead } from '@whombat/core';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { mcpToolRead } from '../kinds/mcp-read';
import { getJson, latestRead, ReadProblem } from '../kinds/read';
import { displayName } from '../part-of';

export { readOnlyTools } from '../kinds/mcp-read';

/** How long a read is kept when the recipe says nothing. */
export const READ_EVERY_S = 60;

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
  if (row.catalogId !== 'custom_mcp') throw new ReadProblem(`${name} has no MCP tools to read; name a path.`);
  return mcpToolRead(services, row, read.tool as string, read.args ?? {}, tools);
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
