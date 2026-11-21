/**
 * Renaming a server or a connection where it is listed (the sidebar's right-click, the phone's long-press, a page's
 * Rename): which rows can be renamed and what the box starts with. A server's name is Whombat's own (`hosts.updateServer`
 * with `name`; an empty box puts its id back); a connection's is its label (`connections.update`).
 */
import { CONNECTION_LABEL_MAX, HOST_SERVER_NAME_MAX, parseThingId } from '@whombat/core';

/** What a rename changes. */
export interface ThingRenameTarget {
  kind: 'server' | 'connection';
  /** The server's id or the connection's id. */
  id: string;
  /** The name it goes by now, what the box starts with. */
  name: string;
  /** The longest name it takes. */
  max: number;
}

/**
 * The rename a listed thing offers, or null: servers, and connections Whombat keeps (`con_…`); GitHub, the accounts
 * and devices have names of their own.
 */
export function thingRenameTarget(thing: { id: string; name: string }): ThingRenameTarget | null {
  const ref = parseThingId(thing.id);
  if (!ref) return null;
  if (ref.kind === 'server')
    return { kind: 'server', id: ref.id, name: thing.name, max: HOST_SERVER_NAME_MAX };
  if (ref.kind === 'connection' && ref.id.startsWith('con_'))
    return { kind: 'connection', id: ref.id, name: thing.name, max: CONNECTION_LABEL_MAX };
  return null;
}

/** What to send for a name typed in the box: null when nothing changes or (for a connection) nothing was typed. */
export function renameValue(target: ThingRenameTarget, typed: string): { name: string | null } | null {
  const next = typed.trim().replace(/\s+/g, ' ');
  if (next === target.name) return null;
  // An empty box puts a server's id back; a connection always has a name.
  if (!next) return target.kind === 'server' ? { name: null } : null;
  return { name: next.slice(0, target.max) };
}
