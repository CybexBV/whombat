/**
 * Where a connection's row goes on the phone (the Servers and Connections lists, Search): its page, or for an account a
 * box gives no page the address it follows. Pure.
 */

import { catalogEntry, type ThingSummary } from '@whombat/core';

/**
 * The address a connection's row follows instead of the thing's page (AP-2814): a connection of a builtin entry — the
 * server makes no page for one (`things.page` answers 404: Google's and Email (IMAP)'s mail, which live in
 * `connectors.status`) — goes where its `href` says, unless that is a thing's page itself. Servers, devices, catalog
 * connections and entries this phone doesn't know (a newer server's) open their page.
 */
export function serviceRowOpens(thing: Pick<ThingSummary, 'kind' | 'catalogId' | 'href'>): string | null {
  if (thing.kind !== 'connection' || !thing.catalogId) return null;
  if (catalogEntry(thing.catalogId)?.transport !== 'builtin') return null;
  return /^\/(?:[^/]+\/)?things\//.test(thing.href) ? null : thing.href;
}
