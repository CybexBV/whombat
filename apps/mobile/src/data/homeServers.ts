/**
 * The servers' facts Search shows on the phone: each server's logo, its system and how it is, from the shared
 * `serverRows` (`@whombat/client/hosts`). Pure.
 */
import { serverOsLine, serverRows } from '@whombat/client/hosts';
import { type HostServer, thingId } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import type { ServerFacts } from './places';

/** What Search says of each server: its logo, its system and how it is. */
export function serverFacts(servers: readonly HostServer[], locale?: string): ServerFacts[] {
  const byId = new Map(servers.map((s) => [s.id, s]));
  // The word Search shows for a server that runs fine.
  const running = mobileTranslator(locale).t('data.homeServers.running');
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
