/**
 * Overview's Servers on the phone (docs/decisions/overview-one-page.md, the phone form of OVP-11): one card per server
 * from the shared `overviewServerRows` (`@whombat/client/hosts`), which carry the order, the words, the figures and what
 * a screen reader hears. This module keeps only what the phone adds: its words, the groups a live update keeps in
 * place (a server and those that run on it move together), and the servers' facts Search shows.
 * Pure; the cards are `screens/home/ServersCard.tsx`.
 */
import { type OverviewServerRow, serverOsLine, serverRows } from '@whombat/client/hosts';
import { type HostServer, thingId } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import type { ServerFacts } from './places';

export function homeServersCopy(locale?: string) {
  const { t, tp } = mobileTranslator(locale);
  return {
    title: t('data.homeServers.title'),
    /** “Couldn’t refresh your servers.” */
    yours: t('data.homeServers.yours'),
    addServer: t('data.homeServers.addServer'),
    addServerLine: t('data.homeServers.addServerLine'),
    down: t('data.homeServers.down'),
    looking: t('data.homeServers.looking'),
    opens: t('data.homeServers.opens'),
    /** The dashed card after the servers while one ran the install command and waits, in the web's words. */
    waiting: (n: number) => tp('data.homeServers.waiting', n),
    waitingLine: t('data.homeServers.waitingLine'),
    review: t('data.homeServers.review'),
    /** The word Search shows for a server that runs fine. */
    running: t('data.homeServers.running'),
  };
}

export const HOME_SERVERS_COPY = homeServersCopy();

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
export function serverFacts(servers: readonly HostServer[], locale?: string): ServerFacts[] {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const running = homeServersCopy(locale).running;
  return serverRows(servers, locale).map((r) => {
    const s = byId.get(r.id) as HostServer;
    return {
      thingId: thingId('server', r.id),
      mark: r.mark,
      osLine: serverOsLine(s, locale),
      status: r.tone === 'ok' && !r.offline ? running : r.statusLabel,
    };
  });
}
