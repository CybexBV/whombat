/**
 * What a page needs around `mcpToolRead` (`mcp-read.ts`) to read a service through its own MCP server: the read-only
 * tools with the arguments their server describes, a caller bound to one connection, and an answer as JSON whichever
 * way the server sent it. A server may send its JSON twice, as structured content and as the first part of its text;
 * Whombat keeps only 64 KiB of either, so a long answer arrives as text that may be cut.
 */
import { toolRowsOf } from '../../connections/store';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { displayName } from '../part-of';
import { mcpToolRead } from './mcp-read';
import { ReadProblem } from './read';

/** A tool's input schema as its server listed it (JSON Schema), or null when it listed none. */
export type ToolSchema = Record<string, unknown> | null;

/** The connection's tools that only read, each with its input schema. */
export async function readToolSchemas(
  services: Services,
  connectionId: string,
): Promise<Map<string, ToolSchema>> {
  const rows = await toolRowsOf(services.db, connectionId);
  return new Map(rows.filter((t) => t.access === 'read').map((t) => [t.name, t.inputSchema ?? null]));
}

/** One call of a read-only tool, its answer as an object. */
export type ToolCall = (tool: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Calls `tools` (the connection's read-only ones) as the connection. */
export function toolCaller(
  services: Services,
  row: CatalogConnectionRow,
  tools: ReadonlySet<string>,
): ToolCall {
  const name = displayName(row);
  return async (tool, args = {}) => answerJson(await mcpToolRead(services, row, tool, args, tools), name);
}

/**
 * A tool's answer as an object: as it came when it is one, a list as `{ items }`, else the first line of its text that
 * is a JSON object (the servers that also send their JSON as text put it before their words). Anything else, a cut
 * answer too, is a problem in words.
 */
export function answerJson(answer: unknown, name: string): Record<string, unknown> {
  if (Array.isArray(answer)) return { items: answer };
  if (answer && typeof answer === 'object') return answer as Record<string, unknown>;
  if (typeof answer === 'string') {
    for (const part of answer.split('\n')) {
      const text = part.trim();
      if (!text.startsWith('{')) continue;
      try {
        const value: unknown = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value))
          return value as Record<string, unknown>;
      } catch {
        // Words, or JSON cut short: the next line.
      }
    }
    if (/\[output cut at \d+ bytes\]\s*$/.test(answer))
      throw new ReadProblem(`${name} answered with more than Whombat reads.`);
  }
  throw new ReadProblem(`${name} answered with something Whombat can’t read.`);
}

/** A property's name as compared: lower case, letters and digits only (`profile_id`, `profileId` → `profileid`). */
const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The properties a tool's schema names, and those it requires. */
export function schemaProps(schema: ToolSchema): { props: string[]; required: string[] } {
  const props = schema?.properties;
  const required = schema?.required;
  return {
    props: props && typeof props === 'object' && !Array.isArray(props) ? Object.keys(props) : [],
    required: Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [],
  };
}

/** The schema's property that goes by one of `names` (case, `_` and `-` aside), or null. */
export function propNamed(schema: ToolSchema, names: readonly string[]): string | null {
  const wanted = new Set(names.map(plain));
  return schemaProps(schema).props.find((p) => wanted.has(plain(p))) ?? null;
}

/**
 * Arguments for a tool from what its server says it takes: each value goes to the property named one of its names, and
 * only when the schema has it (a schema the server didn't give takes none). Null when the schema requires a property
 * none of the values is for: the tool needs something Whombat doesn't know.
 */
export function argsFor(
  schema: ToolSchema,
  values: readonly { names: readonly string[]; value: unknown }[],
): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  for (const v of values) {
    const prop = propNamed(schema, v.names);
    if (prop && v.value !== undefined) args[prop] = v.value;
  }
  return schemaProps(schema).required.every((r) => r in args) ? args : null;
}
