import { z } from 'zod';
import { isEnglishLocale, tCore, tpCore } from '../i18n/catalog.js';
import { ThingWatchId } from '../ids.js';
import {
  type DateInput,
  daysAgo,
  formatClock,
  formatDate,
  formatShortWeekday,
  toDate,
} from '../text/time.js';
import { Timestamp } from './common.js';
import { THING_BACK, THING_DOWN, type ThingIncidentEvent, ThingIncidentTarget } from './incidents.js';

export const ThingWatchEvent = z.enum(['down', 'back']);
export type ThingWatchEvent = z.infer<typeof ThingWatchEvent>;
export const ThingWatchStatus = z.enum(['watching', 'happened', 'expired', 'cancelled']);
export type ThingWatchStatus = z.infer<typeof ThingWatchStatus>;

export const THING_WATCH_DEFAULT_MINUTES = 24 * 60;
export const THING_WATCH_MAX_MINUTES = 7 * 24 * 60;
export const ThingWatchMinutes = z.number().int().min(1).max(THING_WATCH_MAX_MINUTES);

export const ThingWatchView = z.object({
  id: ThingWatchId,
  thing: ThingIncidentTarget,
  name: z.string().min(1).max(120),
  event: ThingWatchEvent,
  status: ThingWatchStatus,
  startedAt: Timestamp,
  endsAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type ThingWatchView = z.infer<typeof ThingWatchView>;

export const StoredThingWatchCard = z.object({ kind: z.literal('thing_watch'), watchId: ThingWatchId });
export const ThingWatchCard = StoredThingWatchCard.extend({ watch: ThingWatchView.nullable() });
export type ThingWatchCard = z.infer<typeof ThingWatchCard>;

export function thingWatchMatches(
  watch: Pick<ThingWatchView, 'thing' | 'event'>,
  type: string,
  incident: ThingIncidentEvent,
): boolean {
  return (
    !incident.cause &&
    watch.thing === incident.thing &&
    type === (watch.event === 'down' ? THING_DOWN : THING_BACK)
  );
}

type WatchSubject = Pick<ThingWatchView, 'name' | 'event'>;

/** “The NAS” inside a sentence: “the NAS”; “Plex” stays. */
function inSentence(name: string): string {
  return /^The [A-Z]/.test(name) ? `t${name.slice(1)}` : name;
}

/**
 * The watch's first words. Waiting for a thing that is down because of something else (`cause`, what it runs on), it
 * says so: “Plex is down while pve-02 is down. I’ll tell you when Plex answers again.”
 */
export function thingWatchStartText(
  watch: WatchSubject,
  cause?: { name: string } | null,
  locale?: string | null,
): string {
  if (watch.event === 'back' && cause)
    return tCore(locale, 'thingWatch.start.cause', {
      name: watch.name,
      cause: inSentence(cause.name),
      again: inSentence(watch.name),
    });
  return tCore(locale, watch.event === 'down' ? 'thingWatch.start.down' : 'thingWatch.start.back', {
    name: watch.name,
  });
}

export function thingIncidentMinutes(incident: ThingIncidentEvent): number | null {
  if (!incident.endedAt || incident.nature !== 'down') return null;
  return Math.max(0, Math.round((Date.parse(incident.endedAt) - Date.parse(incident.startedAt)) / 60_000));
}

export function thingIncidentDurationWords(minutes: number, locale?: string | null): string {
  if (!minutes) return tCore(locale, 'thingWatch.lessThanMinute');
  return tpCore(locale, 'thingWatch.minutes', minutes);
}

export function thingWatchResultText(
  watch: WatchSubject,
  incident?: ThingIncidentEvent,
  locale?: string | null,
): string {
  const { name } = watch;
  if (watch.event === 'down') return tCore(locale, 'thingWatch.result.down', { name });
  const minutes = incident ? thingIncidentMinutes(incident) : null;
  return minutes === null
    ? tCore(locale, 'thingWatch.result.back', { name })
    : tCore(locale, 'thingWatch.result.backFor', {
        name,
        duration: thingIncidentDurationWords(minutes, locale),
      });
}

/** What a watch says when its thing was removed while it waited. */
export function thingWatchRemovedText(watch: Pick<WatchSubject, 'name'>, locale?: string | null): string {
  return tCore(locale, 'thingWatch.removed', { name: watch.name });
}

export function thingWatchExpiredText(watch: WatchSubject, locale?: string | null): string {
  return tCore(locale, watch.event === 'down' ? 'thingWatch.expired.down' : 'thingWatch.expired.back', {
    name: watch.name,
  });
}

/** “Sat 4 Oct” for the card's end day: English keeps Intl's en-GB form, other languages the core's own names. */
function cardDay(at: DateInput, timeZone: string, locale?: string | null): string {
  if (isEnglishLocale(locale))
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(toDate(at));
  return `${formatShortWeekday(at, timeZone, locale)} ${formatDate(at, timeZone, { year: 'never' }, locale)}`;
}

export function thingWatchCardLines(
  watch: ThingWatchView,
  timeZone: string,
  now: DateInput = new Date(),
  locale?: string | null,
) {
  const { name } = watch;
  if (watch.status === 'watching') {
    const clock = formatClock(watch.endsAt, timeZone);
    const days = daysAgo(now, watch.endsAt, timeZone);
    const when =
      days === 0
        ? clock
        : days === 1
          ? tCore(locale, 'thingWatch.card.tomorrow', { time: clock })
          : tCore(locale, 'thingWatch.card.dayAt', {
              day: cardDay(watch.endsAt, timeZone, locale),
              time: clock,
            });
    return {
      title: tCore(
        locale,
        watch.event === 'down' ? 'thingWatch.card.watchingDown' : 'thingWatch.card.watchingBack',
        { name },
      ),
      detail: tCore(locale, 'thingWatch.card.until', { when }),
      canCancel: true,
    };
  }
  const time = formatClock(watch.endedAt ?? now, timeZone);
  const title =
    watch.status === 'happened'
      ? tCore(locale, watch.event === 'down' ? 'thingWatch.card.wentDown' : 'thingWatch.card.isBack', {
          name,
          time,
        })
      : watch.status === 'expired'
        ? tCore(locale, 'thingWatch.card.expired', { name })
        : tCore(locale, 'thingWatch.card.cancelled', { name });
  return { title, detail: null, canCancel: false };
}
