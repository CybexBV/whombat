/**
 * Overview's Servers on the phone (docs/decisions/overview-one-page.md, the phone form of OVP-11): one card per server
 * from the shared `overviewServerRows` (`@whombat/client/hosts`), which carry the order, the words, the figures and what
 * a screen reader hears. This module keeps only what the phone adds: its words, the groups a live update keeps in
 * place (a server and those that run on it move together), and the servers' facts Search shows.
 * Pure; the cards are `screens/home/ServersCard.tsx`.
 */
import { type OverviewServerRow, serverOsLine, serverRows } from '@whombat/client/hosts';
import { type HostServer, thingId } from '@whombat/core';
import type { ServerFacts } from './places';

export const HOME_SERVERS_COPY = {
  title: 'Servers',
  /** “Couldn’t refresh your servers.” */
  yours: 'your servers',
  addServer: 'Add a server',
  addServerLine: 'Whombat puts a small helper on it.',
  down: 'Servers aren’t reachable right now.',
  looking: 'Looking for your servers…',
  opens: 'Opens the server',
  /** The dashed card after the servers while one ran the install command and waits, in the web's words. */
  waiting: (n: number) =>
    n === 1 ? 'A server is waiting to be added' : `${n} servers are waiting to be added`,
  waitingLine: 'It ran the install command. Add it, or turn it away if you don’t know it.',
  review: 'Review',
  /** The word Search shows for a server that runs fine. */
  running: 'Running',
} as const;

/**
 * The rows in groups: a top-level server followed by every server that runs on it (and on those). A live update keeps
 * the groups' order while the person looks, so a child never leaves its parent.
 */
export function serverGroups(rows: readonly OverviewServerRow[]): OverviewServerRow[][] {
  const groups: OverviewServerRow[][] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (row.child && last) last.push(row);
    else groups.push([row]);
  }
  return groups;
}

/** What Search says of each server: its logo, its system and how it is. */
export function serverFacts(servers: readonly HostServer[]): ServerFacts[] {
  const byId = new Map(servers.map((s) => [s.id, s]));
  return serverRows(servers).map((r) => {
    const s = byId.get(r.id) as HostServer;
    return {
      thingId: thingId('server', r.id),
      mark: r.mark,
      osLine: serverOsLine(s),
      status: r.tone === 'ok' && !r.offline ? HOME_SERVERS_COPY.running : r.statusLabel,
    };
  });
}
