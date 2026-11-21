/**
 * Which catalog entries' connections agents call through `connection_tools` / `connection_call` (CX-30): every agent
 * entry with its own transport, plus the builtins whose tools Whombat serves itself — a device (its skill's tools,
 * one-whombat.md ONE-16) and the Servers connection (ONE-12). The other builtins (GitHub, Google, Microsoft, Website
 * feedback) keep their own tools.
 */
import { type CatalogEntry, isAgentConnection } from '@whombat/core';

export const CALLABLE_BUILTINS: ReadonlySet<string> = new Set(['device', 'whombat_servers']);

export function isCallableEntry(entry: CatalogEntry): boolean {
  return isAgentConnection(entry) && (entry.transport !== 'builtin' || CALLABLE_BUILTINS.has(entry.id));
}
