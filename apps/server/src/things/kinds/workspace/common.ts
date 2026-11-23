/**
 * What the workspace kinds share (Notion, Airtable, Dropbox): a read of the service's API as the connection with the
 * catalog's own headers (Notion's version), and the tools a page may read through the connection's MCP server with the
 * arguments each one takes. A tool's arguments come from the input schema its server published, so a page only ever
 * sends what the tool says it takes.
 */
import { catalogEntry } from '@whombat/core';
import { externalEffect } from '../../../commit/scope';
import { signedConnectionFetch } from '../../../connections/http';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { list, rec } from '../../words';
import { KIND_DEADLINE_MS, KIND_MAX_BYTES, problemOf, ReadProblem } from '../read';

/** A count from one page of answers: `more` when there were more than it holds. */
export interface Counted {
  n: number;
  more: boolean;
}

/* The API ------------------------------------------------------------------------------------------------------------ */

export interface ApiOptions {
  method?: 'GET' | 'POST';
  /** JSON; `null` is sent as `null` (Dropbox's calls without arguments). */
  body?: unknown;
  query?: Record<string, string>;
}

/**
 * A read as the connection with the catalog entry's own headers (Notion's version): its JSON; a refusal or an error
 * status is a `ReadProblem`. POST only for the calls the service documents as reads (a search, a listing).
 */
export async function apiRead(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
  path: string,
  { method = 'GET', body, query = {} }: ApiOptions = {},
): Promise<unknown> {
  const search = new URLSearchParams(query).toString();
  const url = `${row.baseUrl.replace(/\/+$/, '')}${path}${search ? `?${search}` : ''}`;
  const own = catalogEntry(row.catalogId)?.request?.headers ?? {};
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method,
            url,
            headers: {
              ...own,
              Accept: 'application/json',
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          },
          { maxBytes: KIND_MAX_BYTES, deadlineMs: KIND_DEADLINE_MS },
        ),
      { idempotent: true },
    );
  } catch (err) {
    throw problemOf(err, name);
  }
  if (res.status === 401 || res.status === 403)
    throw new ReadProblem(`${name} refused Whombat’s sign-in.`, res.status === 401, res.status);
  if (res.status === 429) throw new ReadProblem(`${name} asked Whombat to wait a moment.`, false, 429);
  if (res.status >= 400) throw new ReadProblem(`${name} answered with an error.`, false, res.status);
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new ReadProblem(`${name} answered with something Whombat can’t read.`);
  }
}

/* MCP tools ---------------------------------------------------------------------------------------------------------- */

export type { ToolSchema as Schema } from '../mcp-tools';
/** The connection's tools a page may read (those its server marks read-only), each with its input schema. */
export { readToolSchemas as readTools } from '../mcp-tools';

/** The properties an input schema names. */
export function propsOf(schema: unknown): Record<string, Record<string, unknown>> {
  const props = rec(rec(schema).properties);
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, rec(v)]));
}

/** The words a property may take: its `enum`, or the `const`s and `enum`s of its `anyOf`/`oneOf`. */
export function choicesOf(prop: unknown): string[] {
  const p = rec(prop);
  const out: unknown[] = [...list(p.enum), p.const];
  for (const alt of [...list(p.anyOf), ...list(p.oneOf)]) out.push(...list(rec(alt).enum), rec(alt).const);
  return out.filter((v): v is string => typeof v === 'string');
}

/** The first property whose name matches, or null. */
export function propNamed(schema: unknown, re: RegExp): string | null {
  return Object.keys(propsOf(schema)).find((k) => re.test(k)) ?? null;
}

/** The largest number a property takes, or null when the schema doesn't say. */
export function maxOf(prop: unknown): number | null {
  const m = rec(prop).maximum;
  return typeof m === 'number' && Number.isFinite(m) ? m : null;
}

/** Lists in an answer that say something about the answer, never the things asked for. */
const ASIDES = new Set(['notices', 'warnings', 'errors']);

/**
 * A tool's list of things in an answer whose shape isn't published: the first of `keys` that holds a list, else the
 * answer itself when it is one, else the first list among its fields that isn't a notice.
 */
export function listIn(answer: unknown, keys: readonly string[]): Record<string, unknown>[] {
  const a = rec(answer);
  const found =
    keys.map((k) => a[k]).find(Array.isArray) ??
    (Array.isArray(answer)
      ? answer
      : Object.entries(a).find(([k, v]) => !ASIDES.has(k) && Array.isArray(v))?.[1]);
  return list(found)
    .map(rec)
    .filter((o) => Object.keys(o).length > 0);
}
