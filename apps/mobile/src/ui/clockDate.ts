/**
 * An `HH:MM` clock as the date iOS's time picker holds, and back: 1 January 2000 at that time in UTC, the picker told
 * to read it in UTC, so no time zone or summer time moves the hour. Pure.
 */
import { parseClock } from '../data/notify';

/** The picker's date for `clock`; a clock that isn't one (“”, “25:00”) is midnight. */
export function clockDate(clock: string): Date {
  const [h = 0, m = 0] = (parseClock(clock) ?? '00:00').split(':').map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m));
}

/** The `HH:MM` the picker shows for `date`. */
export function dateClock(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}
