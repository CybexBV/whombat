/** What Whombat watches (`things.watch`): the part a thing's and a server's build the same way from the quiet store. */
import {
  type QuietBy,
  THING_WATCH_CHECKS_MAX,
  THING_WATCH_EXCEPTIONS_MAX,
  type ThingWatch,
  type ThingWatchCheck,
} from '@whombat/core';
import type { ThingQuiet } from '../things/quiet/store';
import { lowerWords, untilWords } from '../things/quiet/words';

/**
 * Adds one thing's quiet rows under their checks: a check stopped as a whole or for one item, a line ignored or snoozed.
 * `at` finds or adds the check a row names (each caller names one it no longer lists its own way); `by` names who did it.
 */
export function addQuietExceptions(
  quiet: Pick<ThingQuiet, 'offs' | 'quiets'>,
  how: {
    at: (check: string, name: string) => ThingWatchCheck;
    by: (id: string | null) => { by?: QuietBy };
    now: Date;
    timeZone: string;
  },
): void {
  const { at, by } = how;
  for (const off of quiet.offs) {
    const c = at(off.checkId, off.subjectName ?? off.checkId);
    if (off.subject === '') {
      c.on = false;
      c.off = { ...by(off.byId), at: off.at.toISOString() };
    } else
      c.exceptions.push({
        subject: { id: off.subject, name: (off.subjectName ?? off.subject).slice(0, 80) },
        state: 'stopped',
        words: 'always',
        ...by(off.byId),
        at: off.at.toISOString(),
      });
  }
  for (const q of quiet.quiets) {
    const c = at(q.checkId, q.title);
    c.exceptions.push({
      ...(q.subject ? { subject: { id: q.subject, name: (q.subjectName ?? q.subject).slice(0, 80) } } : {}),
      state: q.state,
      words:
        q.state === 'snoozed' && q.until ? untilWords(q.until, how.now, how.timeZone) : lowerWords(q.words),
      ...(q.until ? { until: q.until.toISOString() } : {}),
      ...by(q.byId),
      at: q.at.toISOString(),
    });
  }
}

/** The checks within the contract's caps; the caller narrows `mayChange`. */
export function watchList(checks: Map<string, ThingWatchCheck>): ThingWatch {
  return {
    checks: [...checks.values()]
      .slice(0, THING_WATCH_CHECKS_MAX)
      .map((c) => ({ ...c, exceptions: c.exceptions.slice(0, THING_WATCH_EXCEPTIONS_MAX) })),
    mayChange: true,
  };
}
