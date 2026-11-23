/**
 * A read through a connection's own MCP server, for a page: a service signed in with “Sign in with …” has no API token
 * for its kind's usual reads, but its MCP server answers the same questions. Only tools the server marks read-only may
 * be called, so a page can never change anything; the answer is its structured content, else its text as JSON, else
 * the text itself.
 */
import { catalogEntry, resolveMcpUrl, type SignInKind } from '@whombat/core';
import { externalEffect } from '../../commit/scope';
import { connectionsFor } from '../../connections/pool';
import { toolRowsOf } from '../../connections/store';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { VaultCallError } from '../../vault/net';
import { displayName } from '../part-of';
import { KIND_DEADLINE_MS, problemOf, ReadProblem, withDeadline } from './read';

/** The connection's tools a page may read: those its server marks read-only. */
export async function readOnlyTools(services: Services, connectionId: string): Promise<Set<string>> {
  const rows = await toolRowsOf(services.db, connectionId);
  return new Set(rows.filter((t) => t.access === 'read').map((t) => t.name));
}

/**
 * One call of a read-only tool as the connection. `tools` is `readOnlyTools`' answer when the caller has it already.
 * A failure is a `ReadProblem` in words.
 */
export async function mcpToolRead(
  services: Services,
  row: CatalogConnectionRow,
  tool: string,
  args: Record<string, unknown> = {},
  tools?: ReadonlySet<string>,
): Promise<unknown> {
  const name = displayName(row);
  const allowed = tools ?? (await readOnlyTools(services, row.id));
  if (!allowed.has(tool))
    throw new ReadProblem(`“${tool}” isn’t one of ${name}’s tools that only read, so a page can’t use it.`);
  const entry = catalogEntry(row.catalogId);
  const url = entry ? resolveMcpUrl(entry, row.fields, row.signIn as SignInKind) : null;
  if (!url) throw new ReadProblem(`${name} has no address Whombat can read.`);
  const service = connectionsFor(services);
  let res: Awaited<ReturnType<typeof service.pool.call>>;
  try {
    res = await withDeadline(
      externalEffect('things.read', () => service.pool.call(service.target(row, url), tool, args), {
        idempotent: true,
      }),
      KIND_DEADLINE_MS,
      `${name} took too long to answer.`,
    );
  } catch (err) {
    if (err instanceof ReadProblem) throw err;
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
