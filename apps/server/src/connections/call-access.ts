/**
 * Whether one connection call reads or writes (docs/decisions/connections-catalog.md CX-33; connections-more.md CM-14):
 * core's `callAccess` (a `request` by method, path and query, a socket's `call` by its method, a typed tool's own, an
 * MCP tool as listed or by the entry's `mcpTools.reads`), and which tools hold reads and writes in one. Kept apart from `call.ts` so the change records and
 * widgets don't load the call path.
 */
import {
  type CatalogEntry,
  type ConnectionToolAccess,
  callAccess,
  mcpToolReadsByArgs,
  REQUEST_TOOL_NAME,
  SOCKET_TOOL_NAME,
} from '@whombat/core';
import type { ConnectionToolRow } from './types';

/** The access of one call. */
export function connectionCallAccess(
  entry: CatalogEntry,
  tool: Pick<ConnectionToolRow, 'name' | 'access' | 'origin'>,
  args: Readonly<Record<string, unknown>>,
): ConnectionToolAccess {
  // Core decides a socket's `call` by its method (0.97); a tool of that name from anywhere else stays as listed.
  if (tool.name === SOCKET_TOOL_NAME && tool.origin !== 'socket') return tool.access;
  return callAccess(entry, tool.name, args, tool.access);
}

/**
 * Whether a tool holds reads and writes in one (`request`, a socket's `call`, an MCP tool the entry says reads by its
 * arguments: T3 Code's `t3_pending_request` lists and reads questions, and answers them), so its reads run at once.
 */
export function coversReads(entry: CatalogEntry, tool: Pick<ConnectionToolRow, 'name' | 'origin'>): boolean {
  if (tool.name === REQUEST_TOOL_NAME && entry.request) return true;
  if ((tool.origin === 'mcp' || tool.origin === 'mcp-destructive') && mcpToolReadsByArgs(entry, tool.name))
    return true;
  return tool.origin === 'socket' && tool.name === SOCKET_TOOL_NAME && entry.socket !== null;
}
