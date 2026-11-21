/**
 * The words of kept sites (Whombat kept-sites.md), the same on the web and the phone: the list in the assistant's
 * settings, under what it can sign in to, and how long each stays. Pure.
 */
import { daysAgo, formatClock } from '@whombat/core/text';
import { agentWords } from './agentName';

/** The list's words, the assistant by its name. */
export function keptSitesText(agent: string) {
  const { Name: N } = agentWords(agent);
  return {
    title: 'KEPT SIGNED IN',
    note: `Sites ${N} asked to stay signed in to between chats. Stop one and it signs in again next time.`,
    stop: 'Stop',
    stopLabel: (site: string) => `Stop keeping ${site} signed in`,
    stopped: (site: string) => `${N} signs in to ${site} again next time.`,
    failed: 'That didn’t work. Try again in a moment.',
  };
}

/** “until 17:40”, or “until tomorrow 09:10” (a site stays kept a day at most). */
export function keptSiteUntil(expiresAt: string, now: Date | number, timeZone: string): string {
  const days = -daysAgo(expiresAt, now, timeZone);
  const clock = formatClock(expiresAt, timeZone);
  if (days <= 0) return `until ${clock}`;
  if (days === 1) return `until tomorrow ${clock}`;
  return `until ${clock} in ${days} days`;
}
