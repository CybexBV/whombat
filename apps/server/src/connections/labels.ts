/**
 * What a connection is called (docs/decisions/home-redesign.md HR-02, HR-07).
 *
 * - **A new connection's name** (`automaticLabel`): the service's name (“Home Assistant”) when the person gives none;
 *   the address is added (“Home Assistant · 10.100.0.6:8123”, the catalog's `defaultConnectionLabel`, CT-408) only when
 *   another connection of the same service is already there for the same people, and always for a custom API or MCP
 *   server.
 * - **In a change's words** (`nameWithoutAddress`): an automatic “<service> · <address>” label without its address, so
 *   Done recently says “Changed something in Home Assistant”; a name a person gave stays as it is.
 *
 * Pure.
 */
import { type CatalogEntry, connectionHost, defaultConnectionLabel } from '@whombat/core';

/** A new connection's label when the person gave none: the service's name, with its address only beside a namesake. */
export function automaticLabel(
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
  sameServiceExists: boolean,
): string {
  // A custom API or MCP server is told apart by its address (“API · erp.lan”).
  return defaultConnectionLabel(entry, fields, {
    onlyOne: !sameServiceExists && entry.category !== 'custom',
  });
}

/** A label without the “ · <address>” Whombat added to it (the connection's own address); any other label as it is. */
export function nameWithoutAddress(
  label: string,
  entry: CatalogEntry | null,
  fields: Readonly<Record<string, string>>,
): string {
  const host = entry ? connectionHost(entry, fields) : null;
  const tail = host ? ` · ${host}` : null;
  if (tail && label.toLowerCase().endsWith(tail.toLowerCase()) && label.length > tail.length)
    return label.slice(0, label.length - tail.length).trimEnd();
  return label;
}
