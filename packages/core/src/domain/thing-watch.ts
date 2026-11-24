import { z } from 'zod';
import { ThingWatchId } from '../ids.js';
import { type DateInput, daysAgo, formatClock, toDate } from '../text/time.js';
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
export function thingWatchStartText(watch: WatchSubject, cause?: { name: string } | null): string {
  if (watch.event === 'back' && cause)
    return `${watch.name} is down while ${inSentence(cause.name)} is down. I’ll tell you when ${inSentence(watch.name)} answers again.`;
  return `I’ll tell you ${watch.event === 'down' ? 'if' : 'when'} ${watch.name} ${watch.event === 'down' ? 'goes down' : 'is back'}.`;
}

export function thingIncidentMinutes(incident: ThingIncidentEvent): number | null {
  if (!incident.endedAt || incident.nature !== 'down') return null;
  return Math.max(0, Math.round((Date.parse(incident.endedAt) - Date.parse(incident.startedAt)) / 60_000));
}

export function thingIncidentDurationWords(minutes: number): string {
  if (!minutes) return 'less than a minute';
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export function thingWatchResultText(watch: WatchSubject, incident?: ThingIncidentEvent): string {
  if (watch.event === 'down') return `${watch.name} is down.`;
  const result = `${watch.name} is back.`;
  const minutes = incident ? thingIncidentMinutes(incident) : null;
  return minutes === null ? result : `${result} It was down for ${thingIncidentDurationWords(minutes)}.`;
}

export function thingWatchExpiredText(watch: WatchSubject): string {
  return `I didn’t see ${watch.name} ${watch.event === 'down' ? 'go down' : 'come back'} before the watch ended.`;
}

export function thingWatchCardLines(watch: ThingWatchView, timeZone: string, now: DateInput = new Date()) {
  if (watch.status === 'watching') {
    const clock = formatClock(watch.endsAt, timeZone);
    const days = daysAgo(now, watch.endsAt, timeZone);
    const day = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    const when =
      days === 0
        ? clock
        : days === 1
          ? `tomorrow at ${clock}`
          : `${day.format(toDate(watch.endsAt))} at ${clock}`;
    return {
      title: `Watching for ${watch.name} to ${watch.event === 'down' ? 'go down' : 'come back'}`,
      detail: `Until ${when}`,
      canCancel: true,
    };
  }
  const title =
    watch.status === 'happened'
      ? `${watch.name} ${watch.event === 'down' ? 'went down' : 'is back'} · ${formatClock(watch.endedAt ?? now, timeZone)}`
      : watch.status === 'expired'
        ? `Watch for ${watch.name} ended`
        : `Stopped watching ${watch.name}`;
  return { title, detail: null, canCancel: false };
}
