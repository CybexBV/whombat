/**
 * The words of kept sites (Whombat kept-sites.md), the same on the web and the phone: the list in the assistant's
 * settings, under what it can sign in to, and how long each stays. Pure.
 */
import { interpolate } from '@whombat/core/i18n';
import { daysAgo, formatClock } from '@whombat/core/text';
import { agentWords } from './agentName';
import { clientTree } from './i18n/catalog';
import { SETTINGS_AREA_WORDS } from './i18n/messages/chatWork/settings';

const words = (locale?: string | null) => clientTree(locale, SETTINGS_AREA_WORDS).kept;

/** The list's words, the assistant by its name, in a locale (English when none). */
export function keptSitesText(agent: string, locale?: string | null) {
  const { Name: name } = agentWords(agent);
  const w = words(locale);
  return {
    title: w.title,
    note: interpolate(w.note, { name }),
    stop: w.stop,
    stopLabel: (site: string) => interpolate(w.stopLabel, { site }),
    stopped: (site: string) => interpolate(w.stopped, { name, site }),
    failed: w.failed,
  };
}

/** “until 17:40”, or “until tomorrow 09:10” (a site stays kept a day at most). */
export function keptSiteUntil(
  expiresAt: string,
  now: Date | number,
  timeZone: string,
  locale?: string | null,
): string {
  const w = words(locale);
  const days = -daysAgo(expiresAt, now, timeZone);
  const clock = formatClock(expiresAt, timeZone);
  if (days <= 0) return interpolate(w.until, { clock });
  if (days === 1) return interpolate(w.untilTomorrow, { clock });
  return interpolate(w.untilDays, { clock, days });
}
